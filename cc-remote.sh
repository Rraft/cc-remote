#!/usr/bin/env bash
# CC Remote 统一管理入口（Linux / macOS / Git Bash）：bash cc-remote.sh
cd "$(dirname "$0")" || exit 1
while true; do
  clear
  echo "=========================================="
  echo "         CC Remote  管理脚本"
  echo "=========================================="
  echo "  [1] 首次安装   (依赖 + 构建 + 配置向导)"
  echo "  [2] 启动运行   (已在运行时会提示)"
  echo "  [3] 重置配置   (备份并重跑配置向导)"
  echo "  [4] 卸载       (停服务/删自启/关隧道转发)"
  echo "  [5] 更新升级   (git pull + 重建 + 重启)"
  echo "  [6] 重启服务   (改配置/更新后立即生效)"
  echo "  [0] 退出"
  echo "=========================================="
  read -rp "请选择 (0-6): " c
  case "$c" in
    1) bash scripts/install.sh ;;
    2) bash scripts/start.sh ;;
    3) bash scripts/reset.sh ;;
    4) bash scripts/uninstall.sh ;;
    5) bash scripts/update.sh ;;
    6) bash scripts/restart.sh ;;
    0) exit 0 ;;
    *) echo "无效选择" ;;
  esac
  if [ "$c" != "2" ] && [ "$c" != "0" ]; then
    read -rp "按回车返回菜单..." _
  fi
done
