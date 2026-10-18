#!/bin/sh
# 把文档层闸门装进一个新项目。
#
# **在项目根目录运行**：`sh <套件路径>/install.sh [扫描目录...]`
#   例：`cd ~/work/新项目 && sh ~/tools/doc-gate-kit/install.sh docs 方案`
#
# 它会做五件事，**一件都不覆盖你已有的文件**：
#   ① 写 `03_项目工具/闸门基线.json`（只登记扫描目录，读数留空待定性）
#   ② 写 `.github/workflows/docs.yml`（5 行，调用中央套件）
#   ③ 装一个**薄** pre-commit 钩子：调中央套件，本机提交时也能拦
#   ④ 跑尺子自检：塞坏链接看它红不红——**不红就报失败，不落基线**
#   ⑤ 空跑一次，把你项目现有的死链/编码问题逐条列出来（**不替你定性**）
#
# 设计上刻意"不自动落基线"：历史旧账必须由人看过、逐条定性后再落。
# 自动拍平 = 把旧账埋了，以后"变红"和"本来就红"再也分不出来。
#
# 退出码：0 装好且自检通过；1 自检失败（别信这套东西）；2 环境不对（不是 git 根等）。
set -u

KIT_DIR=$(cd "$(dirname "$0")" && pwd)

say() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 2; }

# ---------------------------------------------------------------- ① 环境检查
[ -d .git ] || fail "当前目录不是 git 仓库根（找不到 .git）。请 cd 到项目根再运行。"
[ -f "$KIT_DIR/run_docs_gate.mjs" ] || fail "在 $KIT_DIR 找不到 run_docs_gate.mjs——install.sh 必须和套件放在一起。"
command -v node >/dev/null 2>&1 || fail "找不到 node。这套东西只需要 node 与 git，但 node 必须在。"

ROOT=$(pwd)
say "项目根：$ROOT"
say "套件位置：$KIT_DIR"
say ""

# ---------------------------------------------------------------- ② 扫描目录
if [ "$#" -gt 0 ]; then
  DIRS="$*"
else
  # 自动探测：优先 docs，其次 文档，都没有就用当前目录
  DIRS=""
  for c in docs 文档 方案 文档中心; do
    [ -d "$c" ] && DIRS="$DIRS $c"
  done
  if [ -z "$DIRS" ]; then
    warn "没找到常见的文档目录（docs/文档/方案…），将扫描**整个项目**（自动跳过 node_modules/.git/dist 等）。"
    DIRS="."
  else
    DIRS=$(printf '%s' "$DIRS" | sed 's/^ *//')
    say "自动探测到文档目录：$DIRS"
    if [ -t 0 ]; then
      printf '按回车接受，或直接输入要扫的目录（空格分隔）：'
      read -r ANSWER || ANSWER=""
      [ -n "$ANSWER" ] && DIRS="$ANSWER"
    fi
  fi
fi
say "扫描目录：$DIRS"
say ""

# ---------------------------------------------------------------- ③ 基线（不覆盖）
BASE_DIR="$ROOT/03_项目工具"
BASE="$BASE_DIR/闸门基线.json"
if [ -e "$BASE" ]; then
  warn "$BASE 已存在，**不覆盖**。如果你确实要重建，请先自己删掉它。"
else
  mkdir -p "$BASE_DIR"
  # 用 node 写，避免 JSON 手工拼接出错
  DIRS="$DIRS" BASE="$BASE" node -e '
    const {writeFileSync}=require("node:fs");
    const dirs=process.env.DIRS.split(/\s+/).filter(Boolean);
    const cfg={
      说明:"文档层闸门基线：已登记、已接受的现状；只有比基线更差才退出 1。",
      扫描目录:dirs,
      忽略:[],
      报告路径:"03_项目工具/生成物/文档闸门摘要.md",
      条目:{
        死链:{指标:{硬死链数:0},登记:"（待定性：先看清有哪些，再决定接受几处）",备注:"目标被 .gitignore 忽略的链接不计入：换任何干净检出都必然缺。"},
        编码:{指标:{编码异常数:0},登记:"（待定性）",备注:"只判非法 UTF-8、U+FFFD、异常控制字符。"}
      }
    };
    writeFileSync(process.env.BASE, JSON.stringify(cfg,null,2)+"\n","utf8");
  ' || fail "写基线失败。"
  say "已写：03_项目工具/闸门基线.json"
fi

# ---------------------------------------------------------------- ④ workflow（不覆盖）
WF_DIR="$ROOT/.github/workflows"
WF="$WF_DIR/docs.yml"
# 从套件仓库的 git remote 推断 owner/repo；推断不出就留占位符
KIT_REMOTE=$(git -C "$KIT_DIR" config --get remote.origin.url 2>/dev/null || true)
KIT_SLUG=$(printf '%s' "$KIT_REMOTE" | sed -n 's#.*[:/]\([^/]*\)/\([^/]*\)\.git$#\1/\2#p')
[ -z "$KIT_SLUG" ] && KIT_SLUG=$(printf '%s' "$KIT_REMOTE" | sed -n 's#.*[:/]\([^/]*\)/\([^/]*\)$#\1/\2#p')
[ -z "$KIT_SLUG" ] && KIT_SLUG="<owner>/doc-gate-kit"

if [ -e "$WF" ]; then
  warn "$WF 已存在，**不覆盖**。请手工确认里面有调用 $KIT_SLUG 的那一段。"
else
  mkdir -p "$WF_DIR"
  cat > "$WF" <<EOF
# 文档层闸门（调用中央套件；判据与升级都在那边，这里只有 4 行）。
name: 文档层闸门

on:
  push:
  pull_request:

jobs:
  docs-gate:
    uses: $KIT_SLUG/.github/workflows/docs-gate.yml@main
EOF
  say "已写：.github/workflows/docs.yml（调用 ${KIT_SLUG}）"
fi

# ---------------------------------------------------------------- ⑤ 薄钩子
HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null || true)
if [ -n "$HOOKS_PATH" ]; then
  warn "本项目已设 core.hooksPath=${HOOKS_PATH}，**不动你的钩子**。"
  warn "若希望本机提交时也拦，请在这个钩子目录里加一段：sh \"$KIT_DIR/install.sh\" --hook-only 说明见 README。"
else
  HOOK="$ROOT/.git/hooks/pre-commit"
  if [ -e "$HOOK" ]; then
    warn "$HOOK 已存在，**不覆盖**。要接入请手工把它改成 chmod 并调用套件。"
  else
    mkdir -p "$(dirname "$HOOK")"
    cat > "$HOOK" <<EOF
#!/bin/sh
# 由 doc-gate-kit 安装（${KIT_DIR}）。判据在中央套件里，本文件是"薄"的：
# 只负责把项目根传过去，并按 fail-open 规则处理"闸门自己坏了"。
#
# fail-open 的落点：退出码 2 = 闸门跑不成（配置缺/目录空/脚本异常）。
# 守卫坏了不能挡住别人干活 —— 但也**不假装查过了**（CI 那边会把 2 判红）。
ROOT=\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
KIT="$KIT_DIR"
[ -f "\$KIT/run_docs_gate.mjs" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
node "\$KIT/run_docs_gate.mjs" --root "\$ROOT"
code=\$?
[ "\$code" = "2" ] && exit 0
exit \$code
EOF
    chmod +x "$HOOK"
    say "已装钩子：.git/hooks/pre-commit（指向 ${KIT_DIR}）"
  fi
fi
say ""

# ---------------------------------------------------------------- ⑥ 自检（最关键）
say "=== 先验证这把尺子真的会红（不动你项目里的任何文件）==="
if node "$KIT_DIR/run_docs_gate.mjs" --self-test; then
  say ""
else
  fail "尺子自检未通过。**不要**把这个结果当成"装好了"——请先查套件本身。"
fi

# ---------------------------------------------------------------- ⑦ 空跑
say "=== 空跑一次，看看你项目现在有什么（**只是报告，没有落基线**）==="
say ""
node "$KIT_DIR/run_docs_gate.mjs" --root "$ROOT" --baseline "$BASE" || true
say ""
say "──────────────────────────────────────────────"
say "装完了。但**基线还没落**，这一步必须你来定："
say ""
say "  · 上面列出的死链／编码问题，逐条问：真该修，还是"本机才有、不入库的素材"？"
say "  · 该修的修掉；确实该接受的（比如旧文档里指向甲方 docx 的链接，"
say "    且那个路径已被 .gitignore 覆盖）本来就不会计入。"
say "  · 定性完之后再落基线："
say ""
say "      node $KIT_DIR/run_docs_gate.mjs --root \"$ROOT\" --update-baseline"
say ""
say "  · 落基线前把 03_项目工具/闸门基线.json 里每条「登记」改成"
say "    "谁、什么时候、接受了什么"，以后才不会有人以为那是零缺陷。"
say "──────────────────────────────────────────────"
exit 0
