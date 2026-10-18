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
 *   ② 出现替换字符 `U+FFFD`（"�"——原文已经坏了的痕迹）；
 *   ③ 出现不该有的控制字符（保留 `\n` `\t` `\r`）。
 *
 * **不判什么**：不判"中文写得对"、不判风格、不判长短。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);
const TEXT_EXT = ['.md', '.txt', '.json', '.yml', '.yaml', '.mjs', '.js', '.ts', '.vue', '.py', '.css', '.html', '.svg'];

export function walkText(dir, acc = []) {
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
    if (st.isDirectory()) walkText(full, acc);
    else if (TEXT_EXT.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/** @returns {{files:number, bad:Array<{doc:string, why:string}>}} */
export function scanEncoding({ root, dirs, ignore = [] }) {
  const files = [];
  for (const d of dirs) files.push(...walkText(resolve(root, d)));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const bad = [];
  let scanned = 0;
  for (const file of files) {
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
    // 去掉 UTF-8 BOM 再解码（BOM 本身不是错误，但会让首字符变成 \uFEFF）
    const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
    let text;
    try {
      text = decoder.decode(body);
    } catch {
      bad.push({ doc: rel, why: '不是合法 UTF-8（含非法字节序列）' });
      continue;
    }
    if (text.includes('\uFFFD')) {
      bad.push({ doc: rel, why: '含替换字符 U+FFFD（"�"——原文可能已被截断或错码）' });
      continue;
    }
    const ctrl = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    if (ctrl) {
      bad.push({ doc: rel, why: `含控制字符 U+${ctrl[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` });
    }
  }
  return { files: scanned, bad };
}
