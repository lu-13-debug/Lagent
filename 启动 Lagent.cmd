@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Lagent - Agent 工作台
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更高版本。
  pause
  exit /b 1
)
if not exist "node_modules\vite\package.json" (
  echo 正在安装项目依赖...
  call npm.cmd install --no-fund --no-audit
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo 正在准备 Lagent...
call npm.cmd run build
if errorlevel 1 (
  pause
  exit /b 1
)
rem 默认打开 Agent 指挥台；需要接入本机 CLI Agent 时，再额外设置 LAGENT_ALLOW_EXTERNAL_EXECUTORS=1。
set LAGENT_WORK_ENABLED=1
echo.
echo 启动后请打开 http://127.0.0.1:3001
echo 按 Ctrl+C 停止服务。
echo.
call npm.cmd start
if errorlevel 1 pause
