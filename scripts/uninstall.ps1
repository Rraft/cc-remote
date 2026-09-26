# CC Remote uninstaller (Windows)
# 停止服务、移除开机自启、关闭 tailscale serve 转发；可选删除配置与数据。
# 不删除项目文件本身（脚本位于项目内，自删不可靠），最后打印手动删除指引。
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Write-Host "==> 卸载 CC Remote" -ForegroundColor Cyan

# 1. 停止服务（端口从 config.json 读，默认 8787）
$port = 8787
$cfg = Join-Path $root "server\config.json"
if (Test-Path $cfg) {
  try { $port = (Get-Content $cfg -Raw | ConvertFrom-Json).port } catch {}
}
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host "    已停止服务 (PID $($conn.OwningProcess))"
} else {
  Write-Host "    服务未在运行"
}

# 2. 移除开机自启（Startup vbs + 计划任务两种形式）
$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "cc-remote-server.vbs"
if (Test-Path $vbs) {
  Remove-Item $vbs -Force
  Write-Host "    已移除 Startup 自启: $vbs"
}
cmd /c "schtasks /query /tn cc-remote-server >nul 2>&1"
if ($LASTEXITCODE -eq 0) {
  cmd /c "schtasks /delete /tn cc-remote-server /f >nul 2>&1"
  Write-Host "    已删除计划任务 cc-remote-server"
}

# 3. 关闭 tailscale serve 转发（若存在；不影响 Tailscale 本身）
$ts = $null
if (Get-Command tailscale -ErrorAction SilentlyContinue) { $ts = "tailscale" }
elseif (Test-Path "C:\Program Files\Tailscale\tailscale.exe") { $ts = "C:\Program Files\Tailscale\tailscale.exe" }
if ($ts) {
  & $ts serve --https=443 off 2>&1 | Out-Null
  Write-Host "    已关闭 tailscale serve 443 转发（若之前配置过）"
}

# 4. 可选：删除配置与运行数据
$ans = Read-Host "是否删除配置与运行数据（server\config.json、server\data\，含密码哈希/会话记录/审计日志）? (y/N)"
if ($ans -match '^[yY]') {
  Remove-Item $cfg -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $root "server\data") -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "    配置与数据已删除"
}

Write-Host ""
Write-Host "==> 卸载完成" -ForegroundColor Green
Write-Host "  如需彻底移除，请手动删除项目目录: $root"
Write-Host "  Tailscale 本身未卸载；如不再需要: winget uninstall Tailscale.Tailscale"
Write-Host "  模型网关配置（~\.claude\settings.json）属于 Claude Code，未做改动"
