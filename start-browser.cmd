@echo off
setlocal EnableDelayedExpansion

:: ============================================
:: IntentLens - Browser (development) Launcher
:: ============================================
:: Runs the Node backend and opens the UI in a browser.
:: This is the development path, not the desktop app.
:: For the desktop app, use start.cmd instead.
:: ============================================
cd /d "%~dp0"

:: Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js is not installed.
    echo Please install Node.js from https://nodejs.org/ first.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   IntentLens - Browser Launcher
echo ========================================
echo.
echo Starting backend server on http://localhost:8000
echo Opening your browser to: http://localhost:8000
echo Camera works on localhost - no HTTPS needed
echo.
echo This is the development UI. Use start.cmd for the desktop app.
echo Press CTRL+C to stop the server.
echo ========================================
echo.

:: Set default port if not provided
if "%PORT%"=="" set PORT=8000

:: Open browser automatically
start "" "http://localhost:8000"

:: Start the backend server
node server/index.js

endlocal
pause
