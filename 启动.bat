@echo off
chcp 65001 >nul
title 造像台 · 本地服务
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [启动失败] 没有找到 Node.js。
  echo 请先安装 Node.js（https://nodejs.org/ 下载 LTS 版），装完再双击本文件。
  echo.
  pause
  exit /b 1
)

echo 造像台启动中……
echo 服务就绪后会自动打开浏览器；关掉这个窗口就是停止造像台。
echo.

rem 启动参数 --open：等服务真正开始监听后再打开浏览器，不会抢跑成“无法访问此网站”
node server.mjs --open

if errorlevel 1 (
  echo.
  echo [启动失败] 造像台没有正常启动，具体原因见上面的报错。
  echo 看不懂的话，把上面这段文字截图发给 AI。
  echo.
  pause
  exit /b 1
)

echo.
echo 造像台服务已结束，窗口即将关闭。
ping -n 3 127.0.0.1 >nul 2>nul
