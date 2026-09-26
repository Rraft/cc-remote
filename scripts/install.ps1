# CC Remote one-shot installer (Windows)
# 用法: 根目录 cc-remote.bat 选 [1]，或 powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> CC Remote 安装向导" -ForegroundColor Cyan

# 1. Node.js >= 22
try { $nodeVer = (node --version) } catch { $nodeVer = $null }
if (-not $nodeVer) {
  Write-Host "未找到 Node.js，请先安装 Node 22+：https://nodejs.org" -ForegroundColor Red
  exit 1
}
$major = [int]($nodeVer -replace '^v(\d+).*', '$1')
if ($major -lt 22) {
  Write-Host "需要 Node.js >= 22（当前 $nodeVer）" -ForegroundColor Red
  exit 1
}
Write-Host "    Node $nodeVer OK"

# 2. 服务端依赖 + 构建（Agent SDK 自带 Claude Code 运行时，首次会下载 ~200MB 平台包）
Set-Location (Join-Path $root "server")
Write-Host "==> 安装服务端依赖（含内置 Claude Code 运行时，首次下载约 200MB，请耐心等待）..."
npm install --no-audit --no-fund
if (-not $?) { exit 1 }
npx tsc
if (-not $?) { exit 1 }

# 3. 前端依赖 + 构建
Set-Location (Join-Path $root "web")
Write-Host "==> 安装前端依赖并构建..."
npm install --no-audit --no-fund
if (-not $?) { exit 1 }
npm run build
if (-not $?) { exit 1 }

# 4. 配置向导（密码/目录/端口/中转站/模型网关）
Set-Location (Join-Path $root "server")
Write-Host "==> 进入配置向导"
npm run setup
if (-not $?) { exit 1 }

# 5. 开机自启（可选）
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $startup "cc-remote-server.vbs"
$answer = Read-Host "是否设置开机自启（登录 Windows 后静默运行）? (y/N)"
if ($answer -match '^[yY]') {
  $tpl = Get-Content (Join-Path $root "deploy\cc-remote-server.vbs.template") -Raw
  $tpl = $tpl.Replace("__SERVER_DIR__", (Join-Path $root "server"))
  Set-Content -Path $vbs -Value $tpl -Encoding Default
  Write-Host "    已写入: $vbs"
}

# 6. 立即启动（可选）
$answer = Read-Host "现在启动服务? (Y/n)"
if ($answer -notmatch '^[nN]') {
  if (Test-Path $vbs) {
    wscript $vbs
    Start-Sleep 3
    Write-Host "    已在后台启动（日志: server\data\server.log）"
  } else {
    Write-Host "（前台启动，Ctrl+C 停止）"
    npm run start
  }
}

# 7. 远程访问：检测到 Tailscale 时主动提出配置 serve 转发
Write-Host ""
Write-Host "==> 安装完成!" -ForegroundColor Green
$cfgPort = 8787
try { $cfgPort = (Get-Content (Join-Path $root "server\config.json") -Raw | ConvertFrom-Json).port } catch {}
Write-Host "  本机访问: http://127.0.0.1:$cfgPort"
$tsExe = $null
if (Get-Command tailscale -ErrorAction SilentlyContinue) { $tsExe = "tailscale" }
elseif (Test-Path "C:\Program Files\Tailscale\tailscale.exe") { $tsExe = "C:\Program Files\Tailscale\tailscale.exe" }
if ($tsExe) {
  $st = (& $tsExe status 2>&1 | Out-String)
  if ($st -match 'Logged out|stopped') {
    Write-Host "  Tailscale 未登录：先运行 tailscale up（手机装 Tailscale App 登录同一账号）"
  } else {
    $answer = Read-Host "  检测到 Tailscale 已登录。现在配置 serve 转发（手机即可通过 HTTPS 访问）? (Y/n)"
    if ($answer -notmatch '^[nN]') {
      $job = Start-Job -ScriptBlock { param($ts, $p) & $ts serve --bg $p 2>&1 } -ArgumentList $tsExe, $cfgPort
      if (Wait-Job $job -Timeout 60) { Receive-Job $job | Out-String | Write-Host }
      else {
        Stop-Job $job
        Write-Host "  serve 配置超时：若从未开启过 tailnet HTTPS 证书，请先到" -ForegroundColor Yellow
        Write-Host "  https://login.tailscale.com/admin/dns 开启 HTTPS Certificates，然后手动执行:" -ForegroundColor Yellow
        Write-Host "      tailscale serve --bg $cfgPort"
      }
      Remove-Job $job -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host "  手机浏览器访问: https://<机器名>.<tailnet>.ts.net（tailscale status 可查机器名）"
} else {
  Write-Host "  远程访问: 安装 Tailscale（推荐）或其他隧道，见 deploy\DEPLOY.md"
}
