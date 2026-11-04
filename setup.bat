@echo off
setlocal EnableDelayedExpansion

:: ============================================
:: IntentLens Setup Installer
:: ============================================
title IntentLens Setup
echo.
echo ========================================
echo   IntentLens - Setup Installer
echo ========================================
echo.
echo IntentLens runs entirely on YOUR computer.
echo Camera frames are processed locally and only sent to your
echo chosen AI provider when you press "Find It".
echo.
echo No data is uploaded to GitHub or any external service
echo except your chosen AI provider API.
echo.

:: Check admin rights (not strictly needed, but good to know)
net session >nul 2>&1
if %errorLevel%==0 (
    echo [INFO] Running with administrator privileges.
) else (
    echo [INFO] Running as standard user (sufficient for local install).
)

:: Ask for permission to install
set /p INSTALL_CONFIRM="Proceed with installation? (Y/n): "
if /I "!INSTALL_CONFIRM!"=="n" (
    echo Installation cancelled.
    pause
    exit /b 0
)

:: Choose install location
set "DEFAULT_INSTALL=%USERPROFILE%\IntentLens"
set /p INSTALL_DIR="Install location [%DEFAULT_INSTALL%]: "
if "!INSTALL_DIR!"=="" set "INSTALL_DIR=%DEFAULT_INSTALL%"

echo.
echo Installing to: !INSTALL_DIR!

:: Create install directory
if not exist "!INSTALL_DIR!" mkdir "!INSTALL_DIR!"
if errorlevel 1 (
    echo ERROR: Cannot create directory !INSTALL_DIR!
    pause
    exit /b 1
)

:: Copy all files
echo Copying files...
xcopy /E /H /K /Y "%~dp0*" "!INSTALL_DIR!\*" >nul 2>&1
if errorlevel 1 (
    echo WARNING: Some files may not have copied (possibly in use).
)

:: Create desktop shortcut
set /p CREATE_SHORTCUT="Create desktop shortcut? (Y/n): "
if /I "!CREATE_SHORTCUT!"=="n" (
    echo Skipping desktop shortcut.
) else (
    echo Creating desktop shortcut...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$WshShell = New-Object -comObject WScript.Shell; " ^
    "$Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\IntentLens.lnk'); " ^
    "$Shortcut.TargetPath = '!INSTALL_DIR!\start.cmd'; " ^
    "$Shortcut.WorkingDirectory = '!INSTALL_DIR!'; " ^
    "$Shortcut.Description = 'IntentLens - Local Visual Assistant'; " ^
    "$Shortcut.Save()" ^
    && echo Desktop shortcut created successfully.
)

:: Create uninstaller entry (simple)
echo Creating uninstall information...
set "UNINSTALL_INFO=!INSTALL_DIR!\uninstall.bat"
echo @echo off > "!UNINSTALL_INFO!"
echo echo Uninstalling IntentLens... >> "!UNINSTALL_INFO!"
echo rd /s /q "!INSTALL_DIR!" >> "!UNINSTALL_INFO!"
echo del "%USERPROFILE%\Desktop\IntentLens.lnk" >> "!UNINSTALL_INFO!"
echo echo IntentLens removed. >> "!UNINSTALL_INFO!"
echo pause >> "!UNINSTALL_INFO!"

echo.
echo ========================================
echo   Installation Complete!
echo ========================================
echo.
echo Installed to: !INSTALL_DIR!
echo Run: Double-click "IntentLens" on your desktop
echo      OR run: !INSTALL_DIR!\start.cmd
echo Uninstall: Run !INSTALL_DIR!\uninstall.bat
echo.
echo Next steps:
echo   1. Launch IntentLens
echo   2. Add an AI provider key (Ollama Cloud, Gemini, etc.)
echo   3. Start camera and press "Find It"
echo.
pause
endlocal
