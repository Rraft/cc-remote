# CC Remote 更新（Windows）：git pull → 装依赖 → 重新构建 → 询问重启
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "==> 更新 CC Remote" -ForegroundColor Cyan

if (Test-Path (Join-Path $root ".git")) {
  Write-Host "--> 拉取最新代码 (git pull --ff-only)"
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Host "git pull 失败（本地有未提交改动或网络问题），已中止；后续构建未执行" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "    非 git 仓库，跳过代码拉取（请手动覆盖新版文件后重跑本脚本完成构建）"
}

Write-Host "--> 服务端：安装依赖 + 构建"
Set-Location (Join-Path $root "server")
npm install --no-audit --no-fund
if (-not $?) { exit 1 }
npx tsc
if (-not $?) { exit 1 }

Write-Host "--> 前端：安装依赖 + 构建"
Set-Location (Join-Path $root "web")
npm install --no-audit --no-fund
if (-not $?) { exit 1 }
npm run build
if (-not $?) { exit 1 }

Set-Location $root
$ans = Read-Host "==> 更新完成。现在重启服务生效? (Y/n)"
if ($ans -notmatch '^[nN]') {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "restart.ps1")
}
