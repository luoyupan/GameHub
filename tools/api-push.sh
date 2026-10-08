#!/usr/bin/env bash
# api-push.sh —— 收集本地 git 数据，交给 api-push-node.js 走 GitHub API 推送。
#
# 为什么拆成两段：本机 node 里 spawnSync('git') 会被沙箱挡成 EBUSY，
# 但 node 的 fetch 能直连 api.github.com。于是：
#   bash 段 = 用 git 把「提交元数据 + 变化文件内容」摊到 .tmp-push/ 目录
#   node 段 = 只读文件 + 发 HTTP，全程不 spawn 任何进程
#
# 用法： bash tools/api-push.sh <baseSha> <commit...> [--tag vX.Y.Z] [--notes <文件>]
set -euo pipefail

BASE="$1"; shift
COMMITS=()
TAG=""
NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)   TAG="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    *)       COMMITS+=("$1"); shift ;;
  esac
done

# 中文路径不能让 git 转义成 "docs/\346\212\200..." 这种八进制，否则后面 ls-tree / show 全查不到
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=core.quotePath
export GIT_CONFIG_VALUE_0=false

rm -rf .tmp-push
mkdir -p .tmp-push
git rev-parse "$BASE" > .tmp-push/base.txt
if [ -n "$TAG" ]; then printf '%s' "$TAG" > .tmp-push/tag.txt; fi
if [ -n "$NOTES" ]; then cp "$NOTES" .tmp-push/notes.md; fi

parent="$BASE"
i=0
for c in "${COMMITS[@]}"; do
  i=$((i + 1))
  d=".tmp-push/c${i}"
  mkdir -p "$d/blobs"
  # 提交元数据：%H 提交 %T 树 %an/%ae/%aI 作者 %cn/%ce/%cI 提交者，Tab 分隔
  git show -s --format='%H%x09%T%x09%an%x09%ae%x09%aI%x09%cn%x09%ce%x09%cI' "$c" > "$d/head.txt"
  # 提交说明必须取**对象里的原始字节**：`--format=%B` 会额外补一个 \n，
  # 而 GitHub 是原样存的（多一个字节 ⇒ SHA 就不一样），这点踩过一次。
  git cat-file commit "$c" | node -e '
    const fs = require("fs"); let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const i = s.indexOf("\n\n");
      fs.writeFileSync(process.argv[1], s.slice(i + 2));
    });' "$d/msg.txt"
  : > "$d/files.txt"
  n=0
  while IFS=$'\t' read -r st path; do
    [ -z "${path:-}" ] && continue
    n=$((n + 1))
    if [ "$st" = "D" ]; then
      printf '%s\t%s\t%s\t%s\n' "$st" "-" "$path" "-" >> "$d/files.txt"
    else
      mode="$(git ls-tree "$c" -- "$path" | awk '{print $1}')"
      git show "$c:$path" > "$d/blobs/${n}"
      printf '%s\t%s\t%s\t%s\n' "$st" "$mode" "$path" "$n" >> "$d/files.txt"
    fi
  done < <(git diff --name-status --no-renames "$parent" "$c")
  echo "已收集 $c：$n 个变化文件"
  parent="$c"
done

echo "收集完成，交给 node 推送…"
if [ -z "${GH_TOKEN:-}" ]; then
  echo "✗ 缺 GH_TOKEN：export GH_TOKEN=ghp_xxx 再跑（要有 repo 权限）" >&2
  exit 1
fi
export GH_TOKEN
node tools/api-push-node.js
