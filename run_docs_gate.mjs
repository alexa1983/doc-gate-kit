#!/usr/bin/env node
/**
 * 文档层闸门（通用版）：一条命令跑完与业务无关的判据，并**与基线比**。
 *
 * 设计前提三条（缺一条就会退化成"看起来有、其实没有"）：
 *
 * 1. **基线显式**——判据是"**比基线更差才失败**"，不是"红不红"。任何有历史的项目
 *    文档里都躺着已接受的旧账；若"有红就失败"，闸门第一天就红，然后所有人无视它。
 * 2. **"跑过了"能自证**——本文件会打印扫了多少文件、多少条链接。如果扫到 0 份还报
 *    "通过"，那是空跑：**"没东西可查"不等于"没问题"**。故「扫描目录」为空、目录不存在、
 *    一份 Markdown 都没读到，**一律退出 2**（2026-10-18 补齐后两种：此前只挡了空数组，
 *    写错目录名会静默全绿）。
 * 3. **fail-open 只在钩子里**——闸门自己坏了（配置缺、目录空、脚本异常）一律退出 **2**，
 *    **绝不返回 0**。CI 里 2 应当判红（"闸门坏了"要有人管）；放进 pre-commit 时由钩子
 *    自己决定是否放行——守卫坏了不能挡住别人干活，但也不能假装查过了。
 *
 * 退出码：0 不比基线差／1 比基线差／**2 闸门自己跑不成**（不是"通过"）。
 *
 * 两种模式（2026-10-18 新增 `--staged`）：
 *   · 全量（默认）：死链看工作区、编码看工作区。**CI 用这个**，它回答"仓库现在什么样"。
 *   · `--staged`：死链仍看工作区，编码看**暂存区**。**pre-commit 用这个**，它回答
 *     "这次提交到底会进什么"。两者不能互换——工作区干净不代表索引干净。
 *
 * 用法（脚本可以不在项目里，B 档"中央套件 + 薄调用"就是这样）：
 *   node run_docs_gate.mjs                      # 以当前目录为项目根
 *   node run_docs_gate.mjs --root=/path/to/proj # 显式指定项目根
 *   node run_docs_gate.mjs --update-baseline    # 把当前读数写为基线
 *   node run_docs_gate.mjs --staged             # 只把暂存区当"这次要提交的内容"来判编码
 *   node run_docs_gate.mjs --self-test          # 自检：塞坏样本看它红不红（不动你的文件）
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync,
} from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanDeadLinks } from './check_dead_links.mjs';
import { scanEncoding, scanEncodingStaged } from './encoding_guard.mjs';

const SELF = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
};
const has = (name) => argv.some((a) => a === `--${name}`);

const ROOT = resolve(flag('root') || process.env.DOC_GATE_ROOT || process.cwd());
const BASELINE = resolve(flag('baseline') || join(ROOT, '03_项目工具', '闸门基线.json'));
const STAGED = has('staged');

function die(msg) {
  console.error(`【闸门跑不成】${msg}`);
  console.error('**"跑不成"不等于"通过"**——CI 里这应当判红，钩子里由钩子决定放行。');
  process.exit(2);
}

function loadBaseline() {
  if (!existsSync(BASELINE)) {
    die(`基线不存在：${relative(ROOT, BASELINE) || BASELINE}\n`
      + '没有基线就分不出"新增的红"和"本来就红"。请先跑 install.sh，或手工建一份。');
  }
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    die(`基线解析失败：${e.message}`);
  }
}

// ---------------------------------------------------------------- 自检（不改项目里的任何文件）
if (has('self-test')) {
  let pass = 0;
  let fail = 0;
  const say = (ok, name, detail = '') => {
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? '通过' : '失败'}  ${name}${detail ? `（${detail}）` : ''}`);
  };
  const tmpRepo = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'self-test@local'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'self-test'], { cwd: dir });
    return dir;
  };
  const put = (dir, rel, content) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const putBase = (dir, obj) => {
    const p = join(dir, '03_项目工具', '闸门基线.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };
  const baseOf = (dirs, extra = {}) => ({
    说明: '自检用', 扫描目录: dirs, 忽略: [], 报告路径: '',
    条目: { 死链: { 指标: { 硬死链数: 0 } }, 编码: { 指标: { 编码异常数: 0 } }, ...extra },
  });
  const runGate = (args, cwd) => spawnSync(process.execPath, [SELF, ...args], { cwd, encoding: 'utf8' });

  const tempDirs = [];
  try {
    // ① 干净样本：一条合法链接，应判 0
    {
      const d = mkdtempSync(join(tmpdir(), 'docs-gate-ok-'));
      tempDirs.push(d);
      put(d, 'a.md', '# 正常\n\n- [存在](b.md)\n');
      put(d, 'b.md', '# b\n');
      // 同时给目录和该目录下的文件：必须去重（否则同一份文档会被判两遍）
      const r = scanDeadLinks({ root: d, dirs: ['.', 'a.md'] });
      say(r.real.length === 0 && r.files === 2, '① 干净样本判 0 处（含重复登记去重）', `读到 ${r.files} 份、死链 ${r.real.length}`);
    }

    // ② 死链：应报出，且点名到目标
    {
      const d = mkdtempSync(join(tmpdir(), 'docs-gate-bad-'));
      tempDirs.push(d);
      put(d, 'a.md', '# 正常\n\n- [存在](b.md)\n- [不存在](nope.md)\n');
      put(d, 'b.md', '# b\n');
      const r = scanDeadLinks({ root: d, dirs: ['.'] });
      say(r.real.length === 1 && r.real[0].target === 'nope.md', '② 坏链接能报出', `报 ${r.real.length} 处`);
    }

    // ③ 编码：非法 UTF-8 应报出
    {
      const d = mkdtempSync(join(tmpdir(), 'docs-gate-enc-'));
      tempDirs.push(d);
      writeFileSync(join(d, 'bad.md'), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));
      const r = scanEncoding({ root: d, dirs: ['.'] });
      say(r.bad.some((x) => x.doc === 'bad.md'), '③ 非法 UTF-8 能报出', `报 ${r.bad.length} 份`);
    }

    // ④ 围栏代码块里的示例链接**不能**当死链（2026-10-18 补：此前只屏蔽行内代码）
    {
      const d = mkdtempSync(join(tmpdir(), 'docs-gate-fence-'));
      tempDirs.push(d);
      put(d, 'a.md', '# 正常\n\n```md\n[示例](不存在.md)\n```\n\n- [真链接](b.md)\n');
      put(d, 'b.md', '# b\n');
      const r = scanDeadLinks({ root: d, dirs: ['.'] });
      say(r.real.length === 0 && r.checked === 1, '④ 代码块里的示例不当死链', `核对 ${r.checked} 条、误报 ${r.real.length} 条`);
    }

    // ⑤ 越界路径不毒化豁免（2026-10-18 补：此前一条 `../` 让整批 git 查询报废）
    {
      const d = tmpRepo('docs-gate-escape-');
      tempDirs.push(d);
      put(d, '.gitignore', '素材/\n');
      put(d, 'docs/a.md', '# a\n\n[本机素材](../素材/本机素材.pdf)\n');
      put(d, 'docs/b.md', '# b\n\n[越界](../../外面.md)\n');
      const r = scanDeadLinks({ root: d, dirs: ['.'] });
      const escaped = r.real.filter((x) => x.rel.startsWith('..'));
      const exempt = r.ignored.filter((x) => x.rel === '素材/本机素材.pdf');
      say(
        r.gitAvailable && escaped.length === 1 && exempt.length === 1 && r.real.length === 1,
        '⑤ 越界链接不毒化 .gitignore 豁免',
        `硬死链 ${r.real.length}（应为 1）、豁免 ${r.ignored.length}（应为 1）、gitAvailable=${r.gitAvailable}`,
      );
    }

    // ⑥ 扫描目录不存在：必须退 2，不许全绿（2026-10-18 补）
    {
      const d = mkdtempSync(join(tmpdir(), 'docs-gate-nodir-'));
      tempDirs.push(d);
      putBase(d, baseOf(['不存在的目录']));
      const r = runGate(['--root', d], d);
      say(r.status === 2, '⑥ 扫描目录不存在 → 退 2', `实际退 ${r.status}`);
    }

    // ⑦ --update-baseline 不许抹掉它不认识的条目（2026-10-18 补）
    {
      const d = mkdtempSync(join(tmpdir(), 'docs-gate-base-'));
      tempDirs.push(d);
      put(d, 'docs/a.md', '# a\n');
      const base = baseOf(['docs'], {
        主控一致性: { 指标: { 硬性缺陷数: 7 }, 登记: '别的判据，别删我' },
      });
      const p = putBase(d, base);
      runGate(['--root', d, '--update-baseline'], d);
      const after = JSON.parse(readFileSync(p, 'utf8'));
      const kept = after['条目']?.['主控一致性']?.['指标']?.['硬性缺陷数'] === 7;
      say(kept && after['条目']['死链'] !== undefined, '⑦ 更新基线不抹掉未知条目', kept ? '' : '未知条目被删了');
    }

    // ⑧ 暂存区里有坏字节、工作区干净：--staged 必须拦住（2026-10-18 补）
    {
      const d = tmpRepo('docs-gate-staged-');
      tempDirs.push(d);
      put(d, 'docs/ok.md', '# ok\n');
      putBase(d, baseOf(['docs']));
      writeFileSync(join(d, 'docs/bad.md'), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));
      spawnSync('git', ['add', '-A'], { cwd: d });
      // 把工作区改回干净：索引里仍留着坏字节
      writeFileSync(join(d, 'docs/bad.md'), '# 好\n');
      const r = runGate(['--root', d, '--staged'], d);
      say(r.status === 1, '⑧ 暂存区坏字节 → 退 1（工作区干净也拦）', `实际退 ${r.status}`);
    }
  } finally {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  }

  console.log('');
  console.log(fail === 0
    ? `结论：${pass} 项全过——这把尺子**确实在判它该判的东西**（不是恒过的空壳）。`
    : `结论：${fail} 项未过——这把尺子不可信，别拿它当闸门。`);
  process.exit(fail === 0 ? 0 : 1);
}

const cfg = loadBaseline();
const dirs = cfg['扫描目录'] ?? [];
const ignore = cfg['忽略'] ?? [];
if (dirs.length === 0) {
  die('「扫描目录」是空的。**扫 0 份文件却报通过，是最坏的一种绿**——请先登记要扫哪几个目录。');
}
const absent = dirs.filter((d) => !existsSync(resolve(ROOT, d)));
if (absent.length) {
  die(`「扫描目录」里有不存在的路径：${absent.join('、')}\n`
    + '**目录名写错也会"全绿"**（一份文件没读到，自然没有缺陷），故这里直接判跑不成。');
}
if (STAGED && has('update-baseline')) {
  die('--staged 与 --update-baseline 不能一起用：暂存区读数只代表"这次提交"，不是项目基线。');
}

// ---------------------------------------------------------------- 跑判据
let dead;
let enc;
try {
  dead = scanDeadLinks({ root: ROOT, dirs, ignore });
  if (STAGED) {
    enc = scanEncodingStaged({ root: ROOT, dirs, ignore });
    if (enc === null) die('拿不到暂存区文件清单（不在 git 仓库里，或 git 不可用）。');
  } else {
    enc = scanEncoding({ root: ROOT, dirs, ignore });
  }
} catch (e) {
  die(`判据执行时抛异常：${e.message}`);
}

if (dead.files === 0) {
  die(`扫描目录（${dirs.join('、')}）里**一份 Markdown 都没读到**。\n`
    + '死链判据这一轮什么都没查——这不是"没问题"，是"没查"。请确认目录写对了。');
}

const results = [
  { key: '死链', metric: '硬死链数', now: dead.real.length },
  STAGED
    // 暂存区是"本次提交"，没有可比的历史基线：判据直接取绝对 0
    ? { key: '编码', metric: '暂存区编码异常数', now: enc.bad.length, absolute: 0 }
    : { key: '编码', metric: '编码异常数', now: enc.bad.length },
];

// ---------------------------------------------------------------- 写基线
if (has('update-baseline')) {
  // 只更新本套件认识的判据读数；其余条目、其余指标、登记与备注**原样保留**。
  // （2026-10-18 修：此前重建整个「条目」，会把别的判据连同"谁接受了什么"一起抹掉。）
  const next = { ...cfg };
  next['说明'] = cfg['说明'] ?? '文档层闸门基线：已登记、已接受的现状；只有比基线更差才退出 1。';
  next['扫描目录'] = dirs;
  next['忽略'] = ignore;
  next['报告路径'] = cfg['报告路径'] ?? '';
  next['条目'] = { ...(cfg['条目'] ?? {}) };
  for (const r of results) {
    const old = cfg['条目']?.[r.key] ?? {};
    next['条目'][r.key] = {
      ...old,
      指标: { ...(old['指标'] ?? {}), [r.metric]: r.now },
      登记: old['登记'] ?? `（请补：谁、什么时候、接受了这个读数＝${r.now}）`,
      备注: old['备注'] ?? '',
    };
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`已把当前读数写为基线：${relative(ROOT, BASELINE)}`);
  console.log('⚠️ 基线是"已登记、已接受的红"，不是"及格线"。把历史旧账一次性拍平写进来，等于把它们埋了。');
  process.exit(0);
}

// ---------------------------------------------------------------- 比基线
const lines = [];
const regress = [];
const better = [];
lines.push('# 文档层闸门摘要');
lines.push('');
lines.push(`> 判据是"**比基线更差**"，不是"红不红"。模式：${STAGED ? '**暂存区**（pre-commit）' : '**全量**（工作区／CI）'}。`);
lines.push('');
lines.push('| 判据 | 指标 | 基线 | 现在 | 增减 | 判定 |');
lines.push('|---|---|---|---|---|---|');
for (const r of results) {
  if (r.absolute !== undefined) {
    if (r.now > r.absolute) {
      lines.push(`| ${r.key} | ${r.metric} | ≤ ${r.absolute} | ${r.now} | — | ❌ 本次提交里有 |`);
      regress.push(`${r.key}／${r.metric}：${r.now} 处（要求 ≤ ${r.absolute}）`);
    } else {
      lines.push(`| ${r.key} | ${r.metric} | ≤ ${r.absolute} | ${r.now} | — | ✅ 本次提交干净 |`);
    }
    continue;
  }
  const base = cfg['条目']?.[r.key]?.['指标']?.[r.metric];
  if (base === undefined) {
    lines.push(`| ${r.key} | ${r.metric} | — | ${r.now} | — | ❌ 基线里没有这一项 |`);
    regress.push(`${r.key}／${r.metric}：基线里没有这一项（先登记再落基线）`);
    continue;
  }
  const delta = r.now - base;
  if (delta > 0) {
    lines.push(`| ${r.key} | ${r.metric} | ${base} | ${r.now} | +${delta} | ❌ 比基线差 |`);
    regress.push(`${r.key}／${r.metric}：基线 ${base} → 现在 ${r.now}`);
  } else if (delta < 0) {
    lines.push(`| ${r.key} | ${r.metric} | ${base} | ${r.now} | ${delta} | ✅ 比基线好（可 --update-baseline 下调） |`);
    better.push(`${r.key}／${r.metric}`);
  } else {
    lines.push(`| ${r.key} | ${r.metric} | ${base} | ${r.now} | 0 | ＝ 与基线持平 |`);
  }
}
lines.push('');
lines.push('## 这一轮到底查了什么（自证）');
lines.push('');
lines.push(`- 项目根：\`${ROOT}\``);
lines.push(`- 扫描目录：${dirs.map((d) => `\`${d}\``).join('、')}`);
lines.push(`- 读到的 Markdown：**${dead.files}** 份；核对的相对链接：**${dead.checked}** 条`);
lines.push(`- 站点绝对路径（\`/...\`、\`//...\`，不属仓库内路径）：**${dead.skipped}** 条（不判）`);
lines.push(`- 目标被 \`.gitignore\` 忽略、按环境必然不计入：**${dead.ignored.length}** 条`);
lines.push(`- 目标存在但被忽略（本机可点、干净检出必缺）：**${dead.presentIgnored.length}** 条`);
lines.push(STAGED
  ? `- 编码检查覆盖的**暂存区**文本文件：**${enc.files}** 份`
  : `- 编码检查覆盖的文本文件：**${enc.files}** 份`);
if (STAGED) lines.push('- 死链仍按**工作区**判（链接目标是否在盘上）；编码按**暂存区**判（这次真正要提交的字节）。');
if (!dead.gitAvailable) lines.push('- ⚠️ 没能问到 git（不在仓库里或 git 不可用）：所有缺失一律按硬死链计。');
lines.push('');
if (regress.length) {
  lines.push('## 比基线差');
  lines.push('');
  for (const x of regress) lines.push(`- ${x}`);
  lines.push('');
}
if (better.length) {
  lines.push('## 比基线好');
  lines.push('');
  for (const x of better) lines.push(`- ${x}`);
  lines.push('');
}

const report = lines.join('\n');
console.log(report);

if (cfg['报告路径']) {
  const out = join(ROOT, cfg['报告路径']);
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report + '\n', 'utf8');
    console.log(`（摘要已写入 ${cfg['报告路径']}）`);
  } catch (e) {
    // 报告写不出去不算闸门失败：判据已经跑完并打印过了
    console.log(`（摘要写不进 ${cfg['报告路径']}：${e.code ?? e.message}——不影响判定）`);
  }
}

if (regress.length) {
  if (dead.real.length) {
    console.log('\n硬死链明细：');
    for (const x of dead.real) console.log(`  - ${x.doc} → ${x.target}（解析为 ${x.rel}）`);
  }
  if (enc.bad.length) {
    console.log(`\n编码异常明细${STAGED ? '（暂存区）' : ''}：`);
    for (const x of enc.bad) console.log(`  - ${x.doc}：${x.why}`);
  }
}

process.exit(regress.length ? 1 : 0);
