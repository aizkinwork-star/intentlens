@echo off
setlocal EnableDelayedExpansion

:: ============================================
:: IntentLens - Desktop App Launcher
:: ============================================
:: Launches the Electron desktop app.
::
::   start.cmd            cloud AI stays disabled (default)
::   start.cmd --online   enables allowlisted provider hosts for this run
::
:: The browser development UI moved to start-browser.cmd.
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

echo.
echo ========================================
echo   IntentLens - Desktop App
echo ========================================
echo.

:: Already running? The app has a single-instance lock, so launching the
:: executable again just focuses the existing window.
tasklist /FI "IMAGENAME eq IntentLens.exe" 2>nul | findstr /I "IntentLens.exe" >nul
if not errorlevel 1 (
    echo IntentLens is already running. Focusing the existing window...
    if "%ONLINE%"=="1" (
        echo.
        echo NOTE: the running instance keeps its original network setting.
        echo Close IntentLens and run start.cmd --online again to enable cloud AI.
    )
    goto :launch
)

:: Port 8000 must be free. A leftover `node server/index.js` would keep the
:: app's own backend from binding, and the window would show that old server.
netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul
if not errorlevel 1 (
    echo ERROR: port 8000 is already in use.
    echo.
    echo Something else - probably an old "start-browser.cmd" or
    echo "node server/index.js" window - is still running.
    echo Close that window, then run start.cmd again.
    echo.
    pause
    exit /b 1
)

:launch

set "APP="
if exist "%LOCALAPPDATA%\Programs\IntentLens\IntentLens.exe" (
    set "APP=%LOCALAPPDATA%\Programs\IntentLens\IntentLens.exe"
) else if exist "%ProgramFiles%\IntentLens\IntentLens.exe" (
    set "APP=%ProgramFiles%\IntentLens\IntentLens.exe"
) else if exist "%~dp0electron\release\win-unpacked\IntentLens.exe" (
    set "APP=%~dp0electron\release\win-unpacked\IntentLens.exe"
)

if defined APP (
    echo Launching: !APP!
    if "%ONLINE%"=="1" (
        echo Cloud AI: enabled for allowlisted provider hosts.
    ) else (
        echo Cloud AI: disabled. Run start.cmd --online to enable it.
    )
    echo.
    start "" "!APP!"
    exit /b 0
)

:: Fall back to Electron from source when no build exists.
if exist "%~dp0electron\node_modules\.bin\electron.cmd" (
    echo No packaged build found. Running Electron from source...
    if "%ONLINE%"=="1" (
        echo Cloud AI: enabled for allowlisted provider hosts.
    ) else (
        echo Cloud AI: disabled. Run start.cmd --online to enable it.
    )
    echo.
    pushd "%~dp0electron"
    start "" "node_modules\.bin\electron.cmd" .
    popd
    exit /b 0
)

echo ERROR: no IntentLens desktop build found.
echo.
echo Build it with:
echo     cd electron
echo     npm.cmd install
echo     npm.cmd run build
echo.
echo Or install from:
echo     electron\release\IntentLens Setup 0.4.0.exe
echo.
echo For the browser development UI, run start-browser.cmd instead.
echo.
pause
exit /b 1
