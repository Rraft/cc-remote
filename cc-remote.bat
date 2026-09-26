@echo off
chcp 65001 >nul
title CC Remote
cd /d "%~dp0"
:menu
cls
echo  ==========================================
echo           CC Remote  管理脚本
echo  ==========================================
echo    [1] 首次安装   (依赖 + 构建 + 配置向导)
echo    [2] 启动运行   (已在运行时会提示)
echo    [3] 重置配置   (备份并重跑配置向导)
echo    [4] 卸载       (停服务/删自启/关隧道转发)
echo    [5] 更新升级   (git pull + 重建 + 重启)
echo    [6] 重启服务   (改配置/更新后立即生效)
echo    [0] 退出
echo  ==========================================
set "choice="
set /p choice=  请选择 (0-6):
if "%choice%"=="1" goto install
if "%choice%"=="2" goto run
if "%choice%"=="3" goto reset
if "%choice%"=="4" goto uninstall
if "%choice%"=="5" goto update
if "%choice%"=="6" goto restart
if "%choice%"=="0" exit /b 0
goto menu
:install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
goto after
:run
call scripts\start.bat
goto menu
:reset
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reset.ps1
goto after
:uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
goto after
:update
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1
goto after
:restart
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart.ps1
goto after
:after
echo.
pause
goto menu
