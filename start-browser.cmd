@echo off
setlocal EnableDelayedExpansion

:: ============================================
:: IntentLens - Browser (development) Launcher
:: ============================================
:: Runs the Node backend from THIS folder and opens the UI in your browser.
:: Development path, not the desktop app. For the desktop app use start.cmd.
::
::   start-browser.cmd            cloud AI disabled (default)
::   start-browser.cmd --online   enables allowlisted provider hosts
:: ============================================
cd /d "%~dp0"

set "ONLINE=0"
if /I "%~1"=="--online" set "ONLINE=1"
if /I "%~1"=="--cloud" set "ONLINE=1"
if "%ONLINE%"=="1" (
    set "ALLOW_OUTBOUND_NETWORK=true"
) else (
    set "ALLOW_OUTBOUND_NETWORK=false"
)

if "%PORT%"=="" set "PORT=8000"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js 22.5 or newer is required. Install it from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: A leftover server on this port would serve an OLD version of the app.
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo ERROR: port %PORT% is already in use.
    echo An old start-browser.cmd window, "node server/index.js", or the
    echo IntentLens desktop app is still running. Close it and try again.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   IntentLens - Browser Launcher
echo ========================================
set "REV="
for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set "REV=%%i"
if defined REV echo   Source version: !REV!
echo   Running from: %~dp0
if "%ONLINE%"=="1" (
    echo   Cloud AI: enabled for allowlisted provider hosts.
) else (
    echo   Cloud AI: disabled. Use start-browser.cmd --online to enable it.
)
echo   URL: http://localhost:%PORT%  ^(camera works on localhost^)
echo   Press CTRL+C to stop the server.
echo ========================================
echo.

:: Open the browser after the server has had time to start.
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%PORT%"

node server/index.js

endlocal
pause
