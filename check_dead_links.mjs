#!/usr/bin/env node
/**
 * 死链检查（通用）。**不含任何项目路径**——扫哪个目录由调用方传入。
 *
 * 判什么：Markdown 里 `[文字](相对路径)` 的目标文件在不在。
 * 不判什么：不查外链（http/https）、不查锚点（`#小节名`）、不判"这段引用说得对不对"。
 *
 * **"目标不存在"不一定是缺陷**：很多链接指向**本机才有、按 `.gitignore` 不入库**的文件
 * （生成的报告、甲方给的 docx/pdf）。这类在你自己机器上点得开，换一份干净检出
 * （CI、别人新克隆）必然缺——那是**环境必然**，不是文档写错。判据是问 git
 * "这个路径是不是被忽略"。
 *
 * **⚠️ 一个踩过的坑，本文件已修（2026-10-18 在 CI 上撞出来）**：
 * `git check-ignore` 输出中文/非 ASCII 路径时默认**C 转义并加双引号**
 * （`"04_\347\224\237..."`），拿它建出来的集合与原始中文路径**永远匹配不上**，
 * 这条豁免会**静默失效**——本机看不出来（文件都在盘上），一进 CI 就报几十处假死链。
 * 故必须带 `-c core.quotePath=false`。`-z` 不能替代（它只配 `--stdin` 才有意义）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

/** 递归收集目录下的 .md（跳过依赖/产物目录）。读不到的子项跳过，不让单点失败拖垮整轮。 */
export function walkMarkdown(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkMarkdown(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/** 问 git：这些相对路径里哪些被 `.gitignore` 忽略。问不到返回 null（调用方按"全算真死链"处理）。 */
export function ignoredPathsAmong(root, relPaths) {
  if (relPaths.length === 0) return new Set();
  if (!existsSync(join(root, '.git'))) return null;
  const res = spawnSync(
    'git',
    ['-c', 'core.quotePath=false', 'check-ignore', '--no-index', ...relPaths],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // 一个都没被忽略时退出码是 1，那不是错误
  if (res.error || (res.status !== 0 && res.status !== 1)) return null;
  return new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * @param {{root: string, dirs: string[], ignore?: string[]}} opts
 * @returns {{checked:number, files:number, real:Array, ignored:Array, presentIgnored:Array, gitAvailable:boolean}}
 */
export function scanDeadLinks({ root, dirs, ignore = [] }) {
  const docs = [];
  for (const d of dirs) docs.push(...walkMarkdown(resolve(root, d)));

  const checked = [];
  const missing = [];
  const present = [];
  for (const doc of docs) {
    const relDoc = relative(root, doc);
    if (ignore.some((pat) => relDoc.includes(pat))) continue;
    let text;
    try {
      text = readFileSync(doc, 'utf8');
    } catch {
      continue;
    }
    // 行内代码里的 `](...)` 是**引用示例**、不是真链接，先屏蔽（等长空格，保持偏移不变）
    const scan = text.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
    const linkRe = /\[[^\]\n]*\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;
    let m;
    while ((m = linkRe.exec(scan))) {
      let target = m[1].trim();
      if (/^https?:\/\//.test(target) || target.startsWith('mailto:')) continue;
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

  const ignored = ignoredPathsAmong(root, [...new Set(missing.map((x) => x.rel))]);
  const real = ignored === null ? missing : missing.filter((x) => !ignored.has(x.rel));
  const ignoredList = ignored === null ? [] : missing.filter((x) => ignored.has(x.rel));

  // "本机可点、干净检出必缺"：存在、但被忽略。只报告，不算缺陷（换环境必然缺）。
  const pIgnored = ignoredPathsAmong(root, [...new Set(present.map((x) => x.rel))]);
  const presentIgnored = pIgnored === null ? [] : present.filter((x) => pIgnored.has(x.rel));

  return {
    checked: checked.length,
    real,
    ignored: ignoredList,
    presentIgnored,
    gitAvailable: ignored !== null,
    files: docs.length,
  };
}
