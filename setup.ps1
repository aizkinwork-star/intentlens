# IntentLens Setup Installer (PowerShell)
# Acts as setup.exe alternative — can be distributed standalone

<#
.SYNOPSIS
    Installs IntentLens locally on Windows.
.DESCRIPTION
    Copies files, creates desktop shortcut, asks for permissions,
    and sets up the local backend server.
.NOTES
    Run with: powershell -ExecutionPolicy Bypass -File setup.ps1
#>

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:USERPROFILE\IntentLens",
    [switch]$NoShortcut,
    [switch]$NoLaunch
)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   IntentLens - Setup Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "IntentLens runs entirely on YOUR computer." -ForegroundColor Gray
Write-Host "Camera frames are processed locally and only sent to your" -ForegroundColor Gray
Write-Host "chosen AI provider when you press 'Find It'." -ForegroundColor Gray
Write-Host ""

# Permission prompt
$confirm = Read-Host "Proceed with installation? (Y/n)"
if ($confirm -eq "n" -or $confirm -eq "N") {
    Write-Host "Installation cancelled." -ForegroundColor Yellow
    exit 0
}

# Check Node.js
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
    Write-Host "ERROR: Node.js is not installed." -ForegroundColor Red
    Write-Host "Please install from https://nodejs.org/ first." -ForegroundColor Gray
    exit 1
}
Write-Host "[OK] Node.js found: $($nodePath.Source)" -ForegroundColor Green

# Create install directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
Write-Host "Installing to: $InstallDir" -ForegroundColor Cyan

# Copy files
$source = Split-Path $MyInvocation.MyCommand.Definition
Get-ChildItem -Path $source -Exclude "setup.ps1", "setup.bat", "install.iss" -Recurse | ForEach-Object {
    $dest = Join-Path $InstallDir $_.FullName.Substring($source.Length)
    if ($_ -is [System.IO.DirectoryInfo]) {
        if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
    } else {
        Copy-Item -Path $_.FullName -Destination $dest -Force
    }
}
Write-Host "[OK] Files copied." -ForegroundColor Green

# Create desktop shortcut
if (-not $NoShortcut) {
    $createShortcut = Read-Host "Create desktop shortcut? (Y/n)"
    if ($createShortcut -ne "n" -and $createShortcut -ne "N") {
        $WshShell = New-Object -comObject WScript.Shell
        $shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\IntentLens.lnk")
        $shortcut.TargetPath = "$InstallDir\start.cmd"
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.Description = "IntentLens - Local Visual Assistant"
        $shortcut.Save()
        Write-Host "[OK] Desktop shortcut created." -ForegroundColor Green
    }
}

# Create uninstaller
$uninstallScript = @"
@echo off
echo Uninstalling IntentLens...
rd /s /q "$InstallDir"
del "%USERPROFILE%\Desktop\IntentLens.lnk" 2>nul
echo IntentLens removed.
pause
"@
$uninstallScript | Out-File -FilePath "$InstallDir\uninstall.bat" -Encoding ASCII

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Installation Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Installed to: $InstallDir" -ForegroundColor Gray
Write-Host "Run: Double-click 'IntentLens' on your desktop" -ForegroundColor Gray
Write-Host "     OR run: $InstallDir\start.cmd" -ForegroundColor Gray
Write-Host "Uninstall: Run $InstallDir\uninstall.bat" -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Gray
Write-Host "  1. Launch IntentLens" -ForegroundColor Gray
Write-Host "  2. Add an AI provider key (Ollama Cloud, Gemini, etc.)" -ForegroundColor Gray
Write-Host "  3. Start camera and press 'Find It'" -ForegroundColor Gray
Write-Host ""

if (-not $NoLaunch) {
    $launch = Read-Host "Launch IntentLens now? (Y/n)"
    if ($launch -ne "n" -and $launch -ne "N") {
        Start-Process "cmd.exe" -ArgumentList "/c `"$InstallDir\start.cmd`""
    }
}
