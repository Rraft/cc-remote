@echo off
rem cc-remote quick start (double-click). Close this window to stop the server.
title cc-remote server
cd /d "%~dp0server"

curl -s --max-time 3 http://127.0.0.1:8787/api/healthz >nul 2>&1
if not errorlevel 1 (
  echo [OK] Server is already running.
  echo   Local:  http://127.0.0.1:8787
  echo   Remote: see deploy\DEPLOY.md (your tunnel URL)
  pause
  exit /b 0
)

if not exist dist\index.js (
  echo First run: building dist ...
  call npx tsc
  if errorlevel 1 pause & exit /b 1
)

echo Starting cc-remote server...
echo   Local:  http://127.0.0.1:8787
echo   Remote: see deploy\DEPLOY.md (your tunnel URL)
echo Close this window to stop.
node dist\index.js
pause
