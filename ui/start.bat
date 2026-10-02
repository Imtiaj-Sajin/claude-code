@echo off
rem Double-click to open fin-code (chat + add-ons) in your browser.
title fin-code
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\@anthropic-ai\claude-agent-sdk" (
  echo First run: downloading what the chat needs. This takes a minute.
  call npm install
  if errorlevel 1 (
    echo Download failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

node server.js --open
if errorlevel 1 pause
