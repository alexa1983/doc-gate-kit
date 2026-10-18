#!/usr/bin/env node
/**
 * 文档层闸门（通用版）：一条命令跑完与业务无关的判据，并**与基线比**。
 *
 * 设计前提三条（缺一条就会退化成"看起来有、其实没有"）：
 *
 * 1. **基线显式**——判据是"**比基线更差才失败**"，不是"红不红"。任何有历史的项目
 *    文档里都躺着已接受的旧账；若"有红就失败"，闸门第一天就红，然后所有人无视它。
 * 2. **"跑过了"能自证**——本文件会打印扫了多少文件、多少条链接。如果扫到 0 份还报
 *    "通过"，那是空跑：**"没东西可查"不等于"没问题"**，故「扫描目录」为空**直接退出 2**。
 * 3. **fail-open 只在钩子里**——闸门自己坏了（配置缺、目录空、脚本异常）一律退出 **2**，
 *    **绝不返回 0**。CI 里 2 应当判红（"闸门坏了"要有人管）；放进 pre-commit 时由钩子
 *    自己决定是否放行——守卫坏了不能挡住别人干活，但也不能假装查过了。
 *
 * 退出码：0 不比基线差／1 比基线差／**2 闸门自己跑不成**（不是"通过"）。
 *
 * 用法（脚本可以不在项目里，B 档"中央套件 + 薄调用"就是这样）：
 *   node run_docs_gate.mjs                      # 以当前目录为项目根
 *   node run_docs_gate.mjs --root=/path/to/proj # 显式指定项目根
 *   node run_docs_gate.mjs --update-baseline    # 把当前读数写为基线
 *   node run_docs_gate.mjs --self-test          # 自检：塞坏链接看它红不红（不动你的文件）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { scanDeadLinks } from './check_dead_links.mjs';
import { scanEncoding } from './encoding_guard.mjs';

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
  const tmp = mkdtempSync(join(tmpdir(), 'docs-gate-selftest-'));
  try {
    writeFileSync(join(tmp, 'a.md'), '# 正常\n\n- [存在](b.md)\n', 'utf8');
    writeFileSync(join(tmp, 'b.md'), '# b\n', 'utf8');
    const ok = scanDeadLinks({ root: tmp, dirs: ['.'] });
    // 塞一条真死链
    writeFileSync(join(tmp, 'a.md'), '# 正常\n\n- [存在](b.md)\n- [不存在](nope.md)\n', 'utf8');
    const bad = scanDeadLinks({ root: tmp, dirs: ['.'] });
    // 塞非法 UTF-8
    writeFileSync(join(tmp, 'bad.md'), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));
    const enc = scanEncoding({ root: tmp, dirs: ['.'] });

    const t1 = ok.real.length === 0;
    const t2 = bad.real.length === 1 && bad.real[0].target === 'nope.md';
    const t3 = enc.bad.some((x) => x.doc === 'bad.md');
    console.log(`自检 ① 干净样本判 0 处：${t1 ? '通过' : `失败（${ok.real.length} 处）`}`);
    console.log(`自检 ② 塞坏链接能报出：${t2 ? '通过' : '失败'}`);
    console.log(`自检 ③ 非法 UTF-8 能报出：${t3 ? '通过' : '失败'}`);
    const all = t1 && t2 && t3;
    console.log(all
      ? '结论：这把尺子**确实在判它该判的东西**（不是恒过的空壳）。'
      : '结论：自检未通过——这把尺子不可信，别拿它当闸门。');
    process.exit(all ? 0 : 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const cfg = loadBaseline();
const dirs = cfg['扫描目录'] ?? [];
const ignore = cfg['忽略'] ?? [];
if (dirs.length === 0) {
  die('「扫描目录」是空的。**扫 0 份文件却报通过，是最坏的一种绿**——请先登记要扫哪几个目录。');
}

// ---------------------------------------------------------------- 跑判据
let dead, enc;
try {
  dead = scanDeadLinks({ root: ROOT, dirs, ignore });
  enc = scanEncoding({ root: ROOT, dirs, ignore });
} catch (e) {
  die(`判据执行时抛异常：${e.message}`);
}

const results = [
  { key: '死链', metric: '硬死链数', now: dead.real.length },
  { key: '编码', metric: '编码异常数', now: enc.bad.length },
];

// ---------------------------------------------------------------- 写基线
if (has('update-baseline')) {
  const next = {
    说明: cfg['说明'] ?? '文档层闸门基线：已登记、已接受的现状；只有比基线更差才退出 1。',
    扫描目录: dirs,
    忽略: ignore,
    报告路径: cfg['报告路径'] ?? '',
    条目: {},
  };
  for (const r of results) {
    const old = cfg['条目']?.[r.key] ?? {};
    next['条目'][r.key] = {
      指标: { [r.metric]: r.now },
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
lines.push('> 判据是"**比基线更差**"，不是"红不红"。');
lines.push('');
lines.push('| 判据 | 指标 | 基线 | 现在 | 增减 | 判定 |');
lines.push('|---|---|---|---|---|---|');
for (const r of results) {
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
lines.push(`- 目标被 \`.gitignore\` 忽略、按环境必然不计入：**${dead.ignored.length}** 条`);
lines.push(`- 目标存在但被忽略（本机可点、干净检出必缺）：**${dead.presentIgnored.length}** 条`);
lines.push(`- 编码检查覆盖的文本文件：**${enc.files}** 份`);
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
    console.log('\n编码异常明细：');
    for (const x of enc.bad) console.log(`  - ${x.doc}：${x.why}`);
  }
}

process.exit(regress.length ? 1 : 0);
