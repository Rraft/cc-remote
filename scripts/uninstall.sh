#!/usr/bin/env bash
# CC Remote 卸载（Linux / macOS / Git Bash）
# 停止服务、移除开机自启、关闭 tailscale serve 转发；可选删除配置与数据。
# 不删除项目文件本身，最后打印手动删除指引。
cd "$(dirname "$0")/.." || exit 1
root="$(pwd)"

echo "==> 卸载 CC Remote"

port=$(node -p "require('./server/config.json').port" 2>/dev/null || echo 8787)

# 1. systemd 服务（Linux，若安装过）
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^cc-remote\.service'; then
  sudo systemctl disable --now cc-remote 2>/dev/null
  sudo rm -f /etc/systemd/system/cc-remote.service
  sudo systemctl daemon-reload
  echo "    已移除 systemd 服务"
fi

# 2. 停止监听进程
if command -v lsof >/dev/null 2>&1; then
  pid=$(lsof -ti tcp:"$port" 2>/dev/null)
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null && echo "    已停止服务 (PID $pid)"; fi
else
  echo "    (未找到 lsof，如服务仍在运行请手动停止)"
fi

# 3. tailscale serve 转发（不影响 Tailscale 本身）
if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --https=443 off >/dev/null 2>&1 && echo "    已关闭 tailscale serve 443 转发（若之前配置过）"
fi

# 4. 可选：删除配置与数据
read -rp "是否删除配置与运行数据（server/config.json、server/data/，含密码哈希/会话记录/审计日志）? (y/N) " a
if [[ "$a" =~ ^[yY] ]]; then
  rm -rf server/config.json server/data
  echo "    配置与数据已删除"
fi

echo ""
echo "==> 卸载完成"
echo "  如需彻底移除，请手动删除项目目录: $root"
echo "  Tailscale 本身未卸载；如不再需要请参考其官方文档卸载"
echo "  模型网关配置（~/.claude/settings.json）属于 Claude Code，未做改动"
