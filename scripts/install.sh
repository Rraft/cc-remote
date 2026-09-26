#!/usr/bin/env bash
# CC Remote one-shot installer (Linux / macOS)
# 用法: 根目录 bash cc-remote.sh 选 [1]，或 bash scripts/install.sh
set -e
cd "$(dirname "$0")/.."
root="$(pwd)"

echo "==> CC Remote 安装向导"

# 1. Node.js >= 22
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node 22+：https://nodejs.org"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "需要 Node.js >= 22（当前 $(node --version)）"
  exit 1
fi
echo "    Node $(node --version) OK"

# 2. 服务端依赖 + 构建（Agent SDK 自带 Claude Code 运行时，首次下载 ~200MB 平台包）
echo "==> 安装服务端依赖（含内置 Claude Code 运行时）..."
(cd server && npm install --no-audit --no-fund && npx tsc)

# 3. 前端
echo "==> 安装前端依赖并构建..."
(cd web && npm install --no-audit --no-fund && npm run build)

# 4. 配置向导
echo "==> 进入配置向导"
(cd server && npm run setup)

# 5. 开机自启（Linux systemd，可选）
started=""
if [ "$(uname)" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  read -rp "是否安装 systemd 服务（开机自启，需要 sudo）? (y/N) " a
  if [[ "$a" =~ ^[yY] ]]; then
    sed -e "s|__SERVER_DIR__|$root/server|g" \
        -e "s|__NODE__|$(command -v node)|g" \
        -e "s|__USER__|$USER|g" \
        deploy/cc-remote.service | sudo tee /etc/systemd/system/cc-remote.service >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable --now cc-remote
    echo "    systemd 服务已安装并启动（journalctl -u cc-remote -f 看日志）"
    started=1
  fi
else
  echo "开机自启: macOS 请参考 deploy/DEPLOY.md 的 launchd 说明"
fi

# 6. 立即启动（若尚未通过 systemd 启动）
if [ -z "$started" ]; then
  read -rp "现在前台启动服务? (y/N) " a
  if [[ "$a" =~ ^[yY] ]]; then
    (cd server && npm run start)
  fi
fi

echo ""
echo "==> 完成!"
echo "  本机访问: http://127.0.0.1:8787"
if command -v tailscale >/dev/null 2>&1; then
  echo "  检测到 Tailscale: tailscale up && tailscale serve --bg 8787 后手机访问 https://<机器名>.<tailnet>.ts.net"
else
  echo "  远程访问: 安装 Tailscale（推荐）或其他隧道，见 deploy/DEPLOY.md"
fi
