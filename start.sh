#!/usr/bin/env bash
# cc-remote 快速启动（Git Bash）：bash start.sh
# 前台运行看日志，Ctrl+C 停止；已在运行则直接退出。
cd "$(dirname "$0")/server" || exit 1

if curl -s --max-time 3 http://127.0.0.1:8787/api/healthz >/dev/null 2>&1; then
  echo "✔ 服务已在运行，无需重复启动"
  echo "  本机:   http://127.0.0.1:8787"
  echo "  远程:   见 deploy/DEPLOY.md（你的隧道域名）"
  exit 0
fi

if [ ! -f dist/index.js ]; then
  echo "首次运行：构建 dist ..."
  npx tsc || exit 1
fi

echo "启动 cc-remote 服务端（Ctrl+C 停止）..."
echo "  本机:   http://127.0.0.1:8787"
echo "  远程:   见 deploy/DEPLOY.md（你的隧道域名）"
exec node dist/index.js
