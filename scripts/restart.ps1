# CC Remote 重启服务（Windows）
# 停止监听端口的实例 → 重新静默拉起（优先走 Startup vbs）→ 健康检查
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root "server"
$cfg = Join-Path $serverDir "config.json"
$port = 8787
if (Test-Path $cfg) { try { $port = (Get-Content $cfg -Raw | ConvertFrom-Json).port } catch {} }

Write-Host "==> 重启 CC Remote (端口 $port)" -ForegroundColor Cyan

# 1. 停止现有实例
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host "    已停止旧实例 (PID $($conn.OwningProcess))"
  Start-Sleep 1
} else {
  Write-Host "    服务未在运行，直接启动"
}

# 2. 启动：优先 Startup vbs（与开机自启同一机制，静默+日志落盘）；否则隐藏窗口直启
$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "cc-remote-server.vbs"
if (Test-Path $vbs) {
  wscript $vbs
} else {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run start >> data\server.log 2>&1" -WorkingDirectory $serverDir -WindowStyle Hidden
}

# 3. 健康检查（最多等 10 秒）
$ok = $false
foreach ($i in 1..10) {
  Start-Sleep 1
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/healthz" -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}
if ($ok) {
  Write-Host "==> 重启成功: http://127.0.0.1:$port" -ForegroundColor Green
} else {
  Write-Host "==> 重启后健康检查未通过，请查看日志: server\data\server.log" -ForegroundColor Red
  exit 1
}
