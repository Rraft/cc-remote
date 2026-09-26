@echo off
rem cc-remote quick start (double-click or via cc-remote.bat menu).
rem Close this window to stop the server.
rem First run: installs dependencies, builds, and launches the setup wizard automatically.
title cc-remote server
cd /d "%~dp0.."

curl -s --max-time 3 http://127.0.0.1:8787/api/healthz >nul 2>&1
if not errorlevel 1 (
  echo [OK] Server is already running.
  echo   Local:  http://127.0.0.1:8787
  echo   Remote: see deploy\DEPLOY.md (your tunnel URL)
  pause
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node 22+ from https://nodejs.org first.
  pause
  exit /b 1
)

if not exist server\node_modules (
  echo First run: installing server dependencies ^(includes bundled Claude Code runtime, ~200MB^) ...
  pushd server
  call npm install --no-audit --no-fund
  popd
  if errorlevel 1 pause & exit /b 1
)
if not exist server\dist\index.js (
  echo Building server ...
  pushd server
  call npx tsc
  popd
  if errorlevel 1 pause & exit /b 1
)
if not exist web\dist\index.html (
  echo First run: installing web dependencies and building ...
  pushd web
  call npm install --no-audit --no-fund
  call npm run build
  popd
  if errorlevel 1 pause & exit /b 1
)
if not exist server\config.json (
  echo First run: starting setup wizard ^(password, directories, model gateway^) ...
  pushd server
  call npm run setup
  popd
  if errorlevel 1 pause & exit /b 1
)

echo Starting cc-remote server...
echo   Local:  http://127.0.0.1:8787
echo   Remote: see deploy\DEPLOY.md (your tunnel URL)
echo Close this window to stop.
cd server
node dist\index.js
pause
