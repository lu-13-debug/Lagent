param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Lagent'),
  [string]$ServerUrl = 'http://127.0.0.1:3001'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $InstallDir 'Lagent.exe'
if (-not (Test-Path $exe)) {
  throw "未找到 $exe。请先运行 npm run desktop:build 并安装，或用 -InstallDir 指定安装目录。"
}
if ($ServerUrl -notmatch '^http://(127\.0\.0\.1|localhost):\d+$') {
  throw '本机快捷方式只支持 http://127.0.0.1:<端口> 或 http://localhost:<端口>。'
}
$ServerUrl = $ServerUrl.TrimEnd('/')

$template = @'
Set sh = CreateObject("WScript.Shell")
Function ServerUp()
  ServerUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "__SERVER_URL__/api/health", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then ServerUp = True
  On Error GoTo 0
End Function
If Not ServerUp() Then
  sh.Environment("PROCESS")("LAGENT_WORK_ENABLED") = "1"
  sh.Run "node ""__REPO__\server\index.js""", 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If ServerUp() Then Exit For
  Next
End If
sh.Run """__INSTALL_DIR__\Lagent.exe""", 1, False
'@

$vbsPath = Join-Path $InstallDir 'Lagent Launcher.vbs'
$script = $template.Replace('__SERVER_URL__', $ServerUrl).Replace('__REPO__', $repo).Replace('__INSTALL_DIR__', $InstallDir)
[System.IO.File]::WriteAllText($vbsPath, $script, [System.Text.Encoding]::ASCII)

$appData = Join-Path $env:APPDATA 'Lagent'
New-Item -ItemType Directory -Force -Path $appData | Out-Null
$connection = Join-Path $appData 'connection.json'
[System.IO.File]::WriteAllText($connection, ('{"serverUrl":"' + $ServerUrl + '"}'), (New-Object System.Text.UTF8Encoding($false)))

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $shell.CreateShortcut((Join-Path $folder 'Lagent.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + $vbsPath + '"'
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = $exe + ',0'
  $lnk.Description = 'Lagent · Agent 工作台（自动启动本机服务）'
  $lnk.Save()
}

Write-Output "快捷方式已创建：$(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lagent.lnk')"
Write-Output "启动器：$vbsPath"
Write-Output "连接地址：$ServerUrl"
