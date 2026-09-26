#!/usr/bin/env bash
# CC Remote 重置配置（Linux / macOS / Git Bash）
# 备份并删除 server/config.json（可选连同 data/），随后可立即重跑配置向导。
cd "$(dirname "$0")/.." || exit 1
root="$(pwd)"
cfg="server/config.json"

echo "==> 重置 CC Remote 配置"

if [ ! -f "$cfg" ]; then
  echo "config.json 不存在，无需重置。可直接运行配置向导: cd server && npm run setup"
  exit 0
fi

read -rp "将备份并删除 config.json（密码/白名单/端口等），继续? (y/N) " a
[[ "$a" =~ ^[yY] ]] || { echo "已取消"; exit 0; }

# 停止运行中的服务（端口取自当前配置）
port=$(node -p "require('./server/config.json').port" 2>/dev/null || echo 8787)
if command -v lsof >/dev/null 2>&1; then
  pid=$(lsof -ti tcp:"$port" 2>/dev/null)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "    已停止运行中的服务 (PID $pid)"
fi

bak="$cfg.bak-$(date +%Y%m%d-%H%M%S)"
mv "$cfg" "$bak"
echo "    原配置已备份: $bak"

read -rp "是否同时清空运行数据（server/data/：会话记录/审计日志/命令缓存）? (y/N) " a
if [[ "$a" =~ ^[yY] ]]; then
  rm -rf server/data
  echo "    data/ 已清空"
fi

read -rp "现在重新进入配置向导? (Y/n) " a
if [[ ! "$a" =~ ^[nN] ]]; then
  (cd server && npm run setup)
fi
echo ""
echo "==> 重置完成。启动服务: bash cc-remote.sh 选 [2]，或 bash scripts/start.sh"
