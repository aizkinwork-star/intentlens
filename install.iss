; IntentLens Inno Setup Script
; Compile with: ISCC.exe install.iss
; Download Inno Setup: https://jrsoftware.org/is.php

#define MyAppName "IntentLens"
#define MyAppVersion "0.4.0"
#define MyAppPublisher "IntentLens"
#define MyAppURL "https://github.com/your-org/intentlens"
#define MyAppExeName "start.cmd"

[Setup]
AppId={{{{E234F5A1-6B7C-4D9E-8F2A-1B3C5D7E9F0A}}}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=LICENSE
InfoBeforeFile=SETUP_GUIDE.md
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\*"; DestDir: "{app}"; Excludes: "setup.bat, setup.ps1, install.iss"; Recurse: yes; FollowLinks: no

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesanddirs; Dir: "{app}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := MsgBox('IntentLens runs entirely on YOUR computer.' + #13#10 +
                   'Camera frames are processed locally and only sent to ' + #13#10 +
                   'your chosen AI provider when you press "Find It".' + #13#10 +
                   'No data is uploaded to GitHub or external services ' + #13#10 +
                   'except your chosen AI provider API.' + #13#10 +
                   #13#10 +
                   'Proceed with installation?', mbConfirmation, MB_YESNO) = IDYES;
end;
