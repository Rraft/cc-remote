#!/usr/bin/env bash
# CC Remote 更新（Linux / macOS / Git Bash）：git pull → 装依赖 → 重新构建 → 询问重启
set -e
cd "$(dirname "$0")/.."
root="$(pwd)"
echo "==> 更新 CC Remote"

if [ -d .git ]; then
  echo "--> 拉取最新代码 (git pull --ff-only)"
  git pull --ff-only
else
  echo "    非 git 仓库，跳过代码拉取（请手动覆盖新版文件后重跑本脚本完成构建）"
fi

echo "--> 服务端：安装依赖 + 构建"
(cd server && npm install --no-audit --no-fund && npx tsc)

echo "--> 前端：安装依赖 + 构建"
(cd web && npm install --no-audit --no-fund && npm run build)

read -rp "==> 更新完成。现在重启服务生效? (Y/n) " a
if [[ ! "$a" =~ ^[nN] ]]; then
  bash "$(dirname "$0")/restart.sh"
fi
