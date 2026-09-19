@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 中山文旅 · 数字档案

if not exist ".env" (
  echo [提示] 未找到 .env，正在从 .env.example 生成...
  copy ".env.example" ".env" >nul
  echo [提示] 请填写 .env 中的 ADP_API_KEY 后重新运行。
  pause
  exit /b 1
)

echo.
echo   正在启动本地服务...
echo.
node server.js

echo.
echo   服务已停止。
pause