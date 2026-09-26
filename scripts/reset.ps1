# CC Remote config reset (Windows)
# 备份并删除 server\config.json（可选连同 data\），随后可立即重跑配置向导。
# 会先停止正在运行的服务，避免旧进程持有已删除的配置。
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root "server"
$cfg = Join-Path $serverDir "config.json"
Write-Host "==> 重置 CC Remote 配置" -ForegroundColor Cyan

if (-not (Test-Path $cfg)) {
  Write-Host "config.json 不存在，无需重置。可直接运行配置向导:"
  Write-Host "    cd server; npm run setup"
  exit 0
}

$ans = Read-Host "将备份并删除 config.json（密码/白名单/端口等），继续? (y/N)"
if ($ans -notmatch '^[yY]') { Write-Host "已取消"; exit 0 }

# 停止运行中的服务（端口取自当前配置）
$port = 8787
try { $port = (Get-Content $cfg -Raw | ConvertFrom-Json).port } catch {}
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host "    已停止运行中的服务 (PID $($conn.OwningProcess))"
}

$bak = "$cfg.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
Move-Item $cfg $bak
Write-Host "    原配置已备份: $bak"

$ans = Read-Host "是否同时清空运行数据（server\data\：会话记录/审计日志/命令缓存）? (y/N)"
if ($ans -match '^[yY]') {
  Remove-Item (Join-Path $serverDir "data") -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "    data\ 已清空"
}

$ans = Read-Host "现在重新进入配置向导? (Y/n)"
if ($ans -notmatch '^[nN]') {
  Set-Location $serverDir
  npm run setup
}
Write-Host ""
Write-Host "==> 重置完成。启动服务: 双击根目录 cc-remote.bat 选 [2]，或 scripts\start.bat"
