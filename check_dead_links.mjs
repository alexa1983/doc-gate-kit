#!/usr/bin/env node
/**
 * 死链检查（通用）。**不含任何项目路径**——扫哪个目录由调用方传入。
 *
 * 判什么：Markdown 里 `[文字](相对路径)` 的目标文件在不在。
 * 不判什么：不查外链（http/https）、不查锚点（`#小节名`）、不判"这段引用说得对不对"、
 * 不查引用式链接（`[x][id]`）、不查 `.vue`／`.py` 里的路径。
 *
 * **"目标不存在"不一定是缺陷**：很多链接指向**本机才有、按 `.gitignore` 不入库**的文件
 * （生成的报告、甲方给的 docx/pdf）。这类在你自己机器上点得开，换一份干净检出
 * （CI、别人新克隆）必然缺——那是**环境必然**，不是文档写错。判据是问 git
 * "这个路径是不是被忽略"。
 *
 * **⚠️ 两个踩过的坑，本文件都已修**：
 *
 * ①（2026-10-18，CI 上撞出来）`git check-ignore` 输出中文/非 ASCII 路径时默认
 *    **C 转义并加双引号**（`"04_\347\224\237..."`），拿它建出来的集合与原始中文路径
 *    **永远匹配不上**，豁免会**静默失效**。故改用 `-z --stdin`：输入输出都是 NUL 分隔、
 *    原样字节，转义问题从根上没有了（同时也不再受命令行长度上限约束）。
 *
 * ②（2026-10-18 复查发现）**一条越界路径会毒化整批查询**。链接往仓库根之上爬
 *    （解析成 `../xxx`）时，`git check-ignore` 直接 `fatal: ... is outside repository`
 *    并以 **128** 退出——旧代码把这当成"git 不可用"，于是**全部缺失一律按硬死链计**，
 *    整个豁免归零。本项目在真实仓库上实测：报 2892 处，真死链约 90 处。
 *    修法两层：**先剔除越界路径**（仓库外的东西按定义不可能被 `.gitignore` 忽略），
 *    **再分块查询＋二分降级**（单块里万一还有坏路径，只影响那一条，不再拖垮全局）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);
/** 单批交给 git 的路径数。分块是为了把"一条坏路径"的影响面压到一块之内。 */
const CHUNK = 400;

/**
 * 递归收集 .md（跳过依赖/产物目录）。
 * **target 可以是目录，也可以是单个文件**——`扫描目录` 里允许写 `README.md` 这种具体文件，
 * 否则根目录的总入口永远进不了射程（装的时候只探测到 `docs/` 就把它漏了）。
 */
export function walkMarkdown(target, acc = []) {
  if (!existsSync(target)) return acc;
  let st;
  try {
    st = statSync(target);
  } catch {
    return acc;
  }
  if (st.isFile()) {
    if (target.endsWith('.md')) acc.push(target);
    return acc;
  }
  if (!st.isDirectory()) return acc;
  let names;
  try {
    names = readdirSync(target);
  } catch {
    return acc;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(target, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walkMarkdown(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/**
 * 把代码整段替换成等长空格（保持偏移与行号不变）：
 * **围栏代码块**（``` / ~~~）与**行内代码**里的 `[x](y.md)` 是示例，不是链接。
 * 只屏蔽行内代码会漏掉围栏块里的示例，把文档示例判成死链——2026-10-18 实测复现。
 */
export function maskCode(text) {
  const lines = text.split('\n');
  const out = [];
  let fence = null; // 当前围栏的标记字符（` 或 ~）
  for (const line of lines) {
    if (fence === null) {
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (open) {
        fence = open[1][0];
        out.push(' '.repeat(line.length));
        continue;
      }
      out.push(line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length)));
      continue;
    }
    // 收尾围栏须同字符，且整行只有围栏标记
    const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === fence) fence = null;
    out.push(' '.repeat(line.length));
  }
  return out.join('\n');
}

/**
 * 查一批相对路径里哪些被 `.gitignore` 忽略。失败时**二分降级**：
 * 一半继续查、一半再分，直到单条——单条仍查不成的，按"没被忽略"处理（宁可多报）。
 * 返回 false 仅当 git 根本跑不起来（ENOENT 等），由调用方退回"全按真死链计"。
 */
function readIgnored(root, batch, out, depth = 0) {
  const res = spawnSync(
    'git',
    ['-c', 'core.quotePath=false', 'check-ignore', '--no-index', '-z', '--stdin'],
    { cwd: root, input: batch.join('\0') + '\0', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (!res.error && (res.status === 0 || res.status === 1)) {
    for (const s of res.stdout.split('\0')) if (s) out.add(s);
    return true;
  }
  if (res.error) return false; // git 不可用
  if (batch.length === 1 || depth >= 12) return true; // 单条也查不成：按"没被忽略"算
  const mid = batch.length >> 1;
  return readIgnored(root, batch.slice(0, mid), out, depth + 1)
    && readIgnored(root, batch.slice(mid), out, depth + 1);
}

/**
 * 问 git：这些相对路径里哪些被 `.gitignore` 忽略。
 * 问不到（不在仓库里 / git 不可用）返回 null——调用方按"全算真死链"处理（宁可多报）。
 *
 * **越界路径（`..` 开头、绝对路径）在这之前就被剔除**：它们按定义不在仓库里，
 * 不可能被 `.gitignore` 忽略，留着只会让 git 整批报错（见文件头坑 ②）。
 */
export function ignoredPathsAmong(root, relPaths) {
  if (relPaths.length === 0) return new Set();
  if (!existsSync(join(root, '.git'))) return null;
  const querable = [...new Set(relPaths)].filter((p) => !p.startsWith('..') && !isAbsolute(p));
  const out = new Set();
  for (let i = 0; i < querable.length; i += CHUNK) {
    if (!readIgnored(root, querable.slice(i, i + CHUNK), out)) return null;
  }
  return out;
}

/**
 * @param {{root: string, dirs: string[], ignore?: string[]}} opts
 * @returns {{checked:number, skipped:number, files:number, real:Array, ignored:Array,
 *            presentIgnored:Array, gitAvailable:boolean}}
 */
export function scanDeadLinks({ root, dirs, ignore = [] }) {
  const docs = [];
  // 去重：扫描清单里既写了目录、又单独写了该目录下的某份文件时，别把它判两遍
  for (const d of dirs) docs.push(...walkMarkdown(resolve(root, d)));
  const uniqueDocs = [...new Set(docs)];

  const checked = [];
  const missing = [];
  const present = [];
  let skipped = 0;
  for (const doc of uniqueDocs) {
    const relDoc = relative(root, doc);
    if (ignore.some((pat) => relDoc.includes(pat))) continue;
    let text;
    try {
      text = readFileSync(doc, 'utf8');
    } catch {
      continue;
    }
    // 代码里的 `](...)` 是**引用示例**、不是链接，先整段屏蔽（等长空格，保持偏移不变）
    const scan = maskCode(text);
    const linkRe = /\[[^\]\n]*\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;
    let m;
    while ((m = linkRe.exec(scan))) {
      let target = m[1].trim();
      if (!target) continue;
      if (/^(?:https?|mailto|tel|data):/i.test(target)) continue;
      // 站点绝对路径（`/docs/x.md`）与协议相对路径（`//cdn/x`）不是仓库内路径，不判
      if (target.startsWith('/')) {
        skipped++;
        continue;
      }
      target = target.replace(/^<|>$/g, '');
      const [pathPart] = target.split('#');
      if (!pathPart) continue; // 纯锚点，跳过
      let decoded = pathPart;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        /* 编码坏了就按原文解析 */
      }
      // 以「文档自己所在目录」为基准——文档在子目录里时不能拿根目录当基准
      const abs = resolve(root, dirname(relDoc), decoded);
      const item = { doc: relDoc, target, rel: relative(root, abs) };
      checked.push(item);
      if (existsSync(abs)) present.push(item);
      else missing.push(item);
    }
  }

  const ignored = ignoredPathsAmong(root, missing.map((x) => x.rel));
  const real = ignored === null ? missing : missing.filter((x) => !ignored.has(x.rel));
  const ignoredList = ignored === null ? [] : missing.filter((x) => ignored.has(x.rel));

  // "本机可点、干净检出必缺"：存在、但被忽略。只报告，不算缺陷（换环境必然缺）。
  const pIgnored = ignoredPathsAmong(root, present.map((x) => x.rel));
  const presentIgnored = pIgnored === null ? [] : present.filter((x) => pIgnored.has(x.rel));

  return {
    checked: checked.length,
    skipped,
    real,
    ignored: ignoredList,
    presentIgnored,
    gitAvailable: ignored !== null,
    files: uniqueDocs.length,
  };
}
