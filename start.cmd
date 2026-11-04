@echo off
setlocal EnableDelayedExpansion

:: ============================================
:: IntentLens - Desktop App Launcher
:: ============================================
:: Runs the desktop app FROM THIS FOLDER'S SOURCE, so it is always the same
:: version as the code next to this file. (Older launchers started a previously
:: installed IntentLens.exe, which is a frozen copy of an old build.)
::
::   start.cmd              source build, cloud AI disabled (default)
::   start.cmd --online     enables allowlisted provider hosts for this run
::   start.cmd --packaged   use an installed/built IntentLens.exe instead
::
:: For a browser dev UI, run: node server/index.js
:: ============================================
cd /d "%~dp0"

set "ONLINE=0"
set "PACKAGED=0"
:parse
if "%~1"=="" goto :parsed
if /I "%~1"=="--online" set "ONLINE=1"
if /I "%~1"=="--cloud" set "ONLINE=1"
if /I "%~1"=="--packaged" set "PACKAGED=1"
shift
goto :parse
:parsed

if "%ONLINE%"=="1" (
    set "ALLOW_OUTBOUND_NETWORK=true"
) else (
    set "ALLOW_OUTBOUND_NETWORK=false"
)

echo.
echo ========================================
echo   IntentLens - Desktop App
echo ========================================
set "REV="
for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set "REV=%%i"
if defined REV echo   Source version: !REV!
echo.

if "%PACKAGED%"=="1" goto :packaged

:: ---- Source mode (default) -------------------------------------------------
:: An installed IntentLens.exe holds the single-instance lock and the app's
:: data folder. Launching again would just focus that OLD window.
tasklist /FI "IMAGENAME eq IntentLens.exe" 2>nul | findstr /I "IntentLens.exe" >nul
if not errorlevel 1 (
    echo ERROR: an installed IntentLens.exe is already running.
    echo That is an older frozen build, and it would hide this version.
    echo Close it ^(check the system tray too^), then run start.cmd again.
    echo.
    pause
    exit /b 1
)

:: Port 8000 must be free, or the window would show a stale server.
netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul
if not errorlevel 1 (
    echo ERROR: port 8000 is already in use.
    echo Probably an old "node server/index.js" window.
    echo Close it, then run start.cmd again.
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js 22.5 or newer is required. Install it from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0electron\node_modules\.bin\electron.cmd" (
    echo First run: installing Electron ^(one time, needs internet^)...
    pushd "%~dp0electron"
    call npm.cmd install
    popd
)
if not exist "%~dp0electron\node_modules\.bin\electron.cmd" (
    echo ERROR: Electron did not install. Run this manually and read the error:
    echo     cd electron
    echo     npm.cmd install
    echo.
    pause
    exit /b 1
)

echo Running from source: %~dp0
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

:: ---- Packaged mode (--packaged) --------------------------------------------
:packaged
set "APP="
if exist "%LOCALAPPDATA%\Programs\IntentLens\IntentLens.exe" (
    set "APP=%LOCALAPPDATA%\Programs\IntentLens\IntentLens.exe"
) else if exist "%ProgramFiles%\IntentLens\IntentLens.exe" (
    set "APP=%ProgramFiles%\IntentLens\IntentLens.exe"
) else if exist "%~dp0electron\release\win-unpacked\IntentLens.exe" (
    set "APP=%~dp0electron\release\win-unpacked\IntentLens.exe"
)
if not defined APP (
    echo ERROR: no packaged IntentLens.exe found. Build one with:
    echo     cd electron ^& npm.cmd install ^& npm.cmd run build
    echo or run start.cmd without --packaged.
    echo.
    pause
    exit /b 1
)
echo WARNING: packaged builds are a frozen snapshot. Rebuild after every update.
echo Launching: !APP!
echo.
start "" "!APP!"
exit /b 0
