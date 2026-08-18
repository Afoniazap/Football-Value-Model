@echo off
title FVM v0.4
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not available in PATH.
  echo Install Node.js 18 or newer, then run start.bat again.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo Cannot detect Node.js version.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 18 (
  echo Node.js 18 or newer is required.
  echo Current version:
  node --version
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm is not installed or is not available in PATH.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist .env (
  if not exist ".env.example" (
    echo .env file does not exist, and .env.example was not found.
    echo Cannot create configuration file automatically.
    pause
    exit /b 1
  )
  copy ".env.example" ".env" >nul
  if errorlevel 1 (
    echo Failed to create .env from .env.example.
    pause
    exit /b 1
  )
  echo.
  echo Created .env. Add your API keys, save, then run start.bat again.
  start "" notepad "%~dp0.env"
  pause
  exit /b 0
)

call npm.cmd start
if errorlevel 1 (
  echo.
  echo FVM stopped with an error.
)
pause
