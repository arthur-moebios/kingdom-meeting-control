; Inno Setup script for Kingdom Meeting Control (Windows).
; Builds a per-user installer (no admin needed) from the assembled "pkg" folder
; — the same payload as the portable zip (launcher exe + node + server.mjs +
; public + Python + cloudflared + WebView2 DLLs + native Zoom/JW helpers).
;
; Per-user install so the app folder stays writable: the server keeps its data
; (settings db, Zoom login profile, logs) under the install dir, and those
; runtime files are preserved across updates (Inno only overwrites what it ships)
; and removed on uninstall.
;
; Build:  ISCC.exe /DSrcDir="<abs path to pkg>" /DOutDir="<abs output dir>" installer.iss

#ifndef SrcDir
  #define SrcDir "pkg"
#endif
#ifndef OutDir
  #define OutDir "."
#endif
#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#define AppName "Kingdom Meeting Control"
#define AppExe "KingdomMeetingControl.exe"
#define AppPublisher "Salão do Reino"

[Setup]
AppId={{8F3A1C2E-5B7D-4E9A-9C1F-2D6E8A0B4C33}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\KingdomMeetingControl
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=KingdomMeetingControl-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#AppName}
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "pt_BR"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; GroupDescription: "Atalhos adicionais:"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autoprograms}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Abrir o {#AppName} agora"; Flags: nowait postinstall skipifsilent
