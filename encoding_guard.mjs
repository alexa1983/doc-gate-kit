#!/usr/bin/env node
/**
 * 编码检查（通用，与业务完全无关，**一行不用改就能搬到任何项目**）。
 *
 * **为什么需要它**：文件"写成功了"不等于"写对了"。有过一次真实事故——整份 SVG 的
 * 中文被静默截断，文件仍然通过 `git`、`cat`、`file` 的常规检查，肉眼也看不出，
 * 直到浏览器打开才炸。这类损坏**不可逆**（原文已经没了），唯一的机会是**提交那一刻拦住**。
 *
 * **判三条**：
 *   ① 严格 UTF-8 解码失败（非法字节序列）；
 *   ② 出现替换字符 U+FFFD（显示为问号方块——原文已经坏了的痕迹）；
 *   ③ 出现不该有的控制字符（保留 `\n` `\t` `\r`）。
 *
 * **不判什么**：不判"中文写得对"、不判风格、不判长短。
 *
 * **⚠️ 两种扫法，别混用（2026-10-18 复查补）**：
 *   · `scanEncoding`        —— 扫**工作区**磁盘文件。用于 CI／全量巡检，看"仓库现在什么样"。
 *   · `scanEncodingStaged`  —— 扫**暂存区**内容。用于 pre-commit，看"这次到底提交什么"。
 *   两者不是同一件事：`git add -p`、或"改完忘了重新 add"，都会让工作区干净而索引里留着
 *   坏字节——实测那条路能带着非法 UTF-8 提交成功。**提交那一刻必须看索引**，否则守卫是纸的。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);
const TEXT_EXT = ['.md', '.txt', '.json', '.yml', '.yaml', '.mjs', '.js', '.ts', '.vue', '.py', '.css', '.html', '.svg'];
const decoder = new TextDecoder('utf-8', { fatal: true });

/** 递归收集文本文件。**target 可以是目录，也可以是单个文件**（与 walkMarkdown 同口径）。 */
export function walkText(target, acc = []) {
  if (!existsSync(target)) return acc;
  let st;
  try {
    st = statSync(target);
  } catch {
    return acc;
  }
  if (st.isFile()) {
    if (TEXT_EXT.some((e) => target.endsWith(e))) acc.push(target);
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
    if (s.isDirectory()) walkText(full, acc);
    else if (TEXT_EXT.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/** 判一份字节内容；没问题返回 null，有问题返回原因。工作区与暂存区共用这一份判据。 */
function inspect(buf) {
  // 去掉 UTF-8 BOM 再解码（BOM 本身不是错误，但会让首字符变成 \uFEFF）
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  let text;
  try {
    text = decoder.decode(body);
  } catch {
    return '不是合法 UTF-8（含非法字节序列）';
  }
  if (text.includes('\uFFFD')) {
    return '含替换字符 U+FFFD（显示为问号方块，原文可能已被截断或错码）';
  }
  const ctrl = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  if (ctrl) {
    return `含控制字符 U+${ctrl[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return null;
}

/** 路径是否落在 `扫描目录` 里（目录前缀，或与被单独列出的文件完全相等）。 */
function inScope(rel, dirs) {
  if (dirs.length === 0) return true;
  return dirs.some((d) => {
    const clean = d.replace(/\/+$/, '') || '.';
    return clean === '.' || rel === d || rel.startsWith(`${clean}/`);
  });
}

/** @returns {{files:number, bad:Array<{doc:string, why:string}>}} */
export function scanEncoding({ root, dirs, ignore = [] }) {
  const files = [];
  for (const d of dirs) files.push(...walkText(resolve(root, d)));
  const uniqueFiles = [...new Set(files)]; // 同上：目录与文件同时登记时别扫两遍
  const bad = [];
  let scanned = 0;
  for (const file of uniqueFiles) {
    const rel = relative(root, file);
    if (ignore.some((pat) => rel.includes(pat))) continue;
    scanned++;
    let buf;
    try {
      buf = readFileSync(file);
    } catch (e) {
      bad.push({ doc: rel, why: `读不出来：${e.code ?? e.message}` });
      continue;
    }
    const why = inspect(buf);
    if (why) bad.push({ doc: rel, why });
  }
  return { files: scanned, bad, staged: false };
}

/** 本次提交涉及的文件（暂存区 vs HEAD 的差异；初始提交时即全部暂存文件）。 */
export function stagedNames(root) {
  const res = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error || res.status !== 0) return null;
  return res.stdout.split('\0').filter(Boolean);
}

/**
 * 扫**暂存区**：只看这次提交真正会进仓库的那些文本文件，判据与全量扫描完全一致。
 * 返回 null 表示拿不到暂存区清单（不在 git 仓库里／git 不可用），调用方按"闸门跑不成"处理。
 *
 * 为什么不在钩子里全量扫工作区：① 慢；② **不精确**——工作区干净不代表索引干净。
 * 钩子只该管"这次提交"，存量坏文件由 CI 的全量扫描管。
 */
export function scanEncodingStaged({ root, dirs = [], ignore = [] }) {
  const names = stagedNames(root);
  if (names === null) return null;
  const bad = [];
  let scanned = 0;
  for (const rel of names) {
    if (!TEXT_EXT.some((e) => rel.endsWith(e))) continue;
    if (!inScope(rel, dirs)) continue;
    if (ignore.some((pat) => rel.includes(pat))) continue;
    scanned++;
    const res = spawnSync('git', ['cat-file', 'blob', `:${rel}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) {
      bad.push({ doc: rel, why: '读不出暂存区内容（git cat-file 失败）' });
      continue;
    }
    const why = inspect(res.stdout);
    if (why) bad.push({ doc: rel, why });
  }
  return { files: scanned, bad, staged: true };
}
