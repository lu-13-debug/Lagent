; Lagent Windows 安装器
; 用法：
;   makensis /INPUTCHARSET UTF8 /DVERSION=1.2.0 \
;     /DSOURCE_DIR=D:\lagent\release\win-unpacked \
;     /DOUT_FILE=D:\lagent\release\Lagent-Setup-1.2.0-x64.exe \
;     scripts\build-installer.nsi

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "1.2.0"
!endif
!ifndef SOURCE_DIR
  !error "需要 /DSOURCE_DIR=<win-unpacked 目录>"
!endif
!ifndef OUT_FILE
  !error "需要 /DOUT_FILE=<输出安装包路径>"
!endif

Name "Lagent"
Caption "Lagent ${VERSION} 安装程序"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Lagent"
InstallDirRegKey HKCU "Software\Lagent" "InstallDir"
RequestExecutionLevel user
SetCompressor zlib
ShowInstDetails show
ShowUninstDetails show

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Lagent"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Lagent.exe"
!define MUI_FINISHPAGE_RUN_TEXT "运行 Lagent"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; 安装前退出旧版本：交互模式提示用户，静默模式直接结束进程，避免覆盖文件失败。
  ${If} ${Silent}
    nsExec::Exec 'taskkill /IM Lagent.exe /F'
  ${Else}
    nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq Lagent.exe" /NH /FO CSV'
    Pop $0
    Pop $1
    StrCpy $2 $1 12
    ${If} $2 == '"Lagent.exe"'
      MessageBox MB_OK|MB_ICONEXCLAMATION "Lagent 正在运行，请先退出 Lagent 后重新安装。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Lagent" SecMain
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall Lagent.exe"

  CreateShortcut "$DESKTOP\Lagent.lnk" "$INSTDIR\Lagent.exe" "" "$INSTDIR\Lagent.exe" 0
  CreateDirectory "$SMPROGRAMS\Lagent"
  CreateShortcut "$SMPROGRAMS\Lagent\Lagent.lnk" "$INSTDIR\Lagent.exe" "" "$INSTDIR\Lagent.exe" 0
  CreateShortcut "$SMPROGRAMS\Lagent\卸载 Lagent.lnk" "$INSTDIR\Uninstall Lagent.exe"

  WriteRegStr HKCU "Software\Lagent" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Lagent" "Version" "${VERSION}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Lagent"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Lagent"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Lagent.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall Lagent.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Lagent.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM Lagent.exe /F'

  Delete "$DESKTOP\Lagent.lnk"
  Delete "$SMPROGRAMS\Lagent\Lagent.lnk"
  Delete "$SMPROGRAMS\Lagent\卸载 Lagent.lnk"
  RMDir "$SMPROGRAMS\Lagent"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Lagent"

  RMDir /r "$INSTDIR"
SectionEnd
