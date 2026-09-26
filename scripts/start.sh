#!/usr/bin/env bash
# cc-remote 快速启动（Git Bash / Linux / macOS）：bash scripts/start.sh
# 首次运行自动：装依赖 → 构建 → 配置向导；之后直接启动。Ctrl+C 停止。
cd "$(dirname "$0")/.." || exit 1

if curl -s --max-time 3 http://127.0.0.1:8787/api/healthz >/dev/null 2>&1; then
  echo "✔ 服务已在运行，无需重复启动"
  echo "  本机:   http://127.0.0.1:8787"
  echo "  远程:   见 deploy/DEPLOY.md（你的隧道域名）"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node 22+：https://nodejs.org"
  exit 1
fi

if [ ! -d server/node_modules ]; then
  echo "首次运行：安装服务端依赖（含内置 Claude Code 运行时，约 200MB）..."
  (cd server && npm install --no-audit --no-fund) || exit 1
fi
if [ ! -f server/dist/index.js ]; then
  echo "构建服务端 ..."
  (cd server && npx tsc) || exit 1
fi
if [ ! -f web/dist/index.html ]; then
  echo "首次运行：安装并构建前端 ..."
  (cd web && npm install --no-audit --no-fund && npm run build) || exit 1
fi
if [ ! -f server/config.json ]; then
  echo "首次运行：进入配置向导（密码 / 工作目录 / 模型网关）..."
  (cd server && npm run setup) || exit 1
fi

echo "启动 cc-remote 服务端（Ctrl+C 停止）..."
echo "  本机:   http://127.0.0.1:8787"
echo "  远程:   见 deploy/DEPLOY.md（你的隧道域名）"
cd server && exec node dist/index.js
