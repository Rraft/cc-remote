#!/usr/bin/env bash
# CC Remote 重启服务（Linux / macOS / Git Bash）
# systemd 优先；否则按端口停止后重新后台拉起；最后健康检查。
cd "$(dirname "$0")/.." || exit 1
port=$(node -p "require('./server/config.json').port" 2>/dev/null || echo 8787)
echo "==> 重启 CC Remote (端口 $port)"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^cc-remote\.service'; then
  sudo systemctl restart cc-remote
else
  # 停止监听端口的实例
  if command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -ti tcp:"$port" 2>/dev/null)
    if [ -n "$pid" ]; then
      kill $pid 2>/dev/null && echo "    已停止旧实例 (PID $pid)"
      sleep 1
    fi
  else
    echo "    (未找到 lsof，若旧实例仍在请手动停止)"
  fi
  # Windows(Git Bash)：有 Startup vbs 就用它静默拉起；Unix：nohup 后台启动
  vbs="${APPDATA:-}/Microsoft/Windows/Start Menu/Programs/Startup/cc-remote-server.vbs"
  if [ -f "$vbs" ] && command -v cscript >/dev/null 2>&1; then
    cscript //nologo "$(cygpath -w "$vbs" 2>/dev/null || echo "$vbs")"
  else
    (cd server && mkdir -p data && nohup node dist/index.js >> data/server.log 2>&1 &)
  fi
fi

# 健康检查（最多等 10 秒）
ok=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s --max-time 2 "http://127.0.0.1:$port/api/healthz" >/dev/null 2>&1; then ok=1; break; fi
done
if [ -n "$ok" ]; then
  echo "==> 重启成功: http://127.0.0.1:$port"
else
  echo "==> 重启后健康检查未通过，请查看日志: server/data/server.log"
  exit 1
fi
