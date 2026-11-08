[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'read', 'send')][string]$Command,
  [long]$Handle = 0,
  [string]$Text = '',
  [switch]$Submit,
  [string]$Expect = '',
  [string]$Allow = 'codex|ChatGPT|claude|WindowsTerminal|wt|DSH Desktop|DeepSeek',
  [ValidateRange(1, 100000)][int]$MaxText = 8000,
  [ValidateRange(1, 200000)][int]$MaxRead = 20000,
  [ValidateRange(1024, 1048576)][int]$MaxOutput = 65536,
  [ValidateRange(1000, 60000)][int]$TimeoutMs = 12000
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Stdout = [Console]::OpenStandardOutput()
$script:Deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$allowed = @($Allow.Split('|') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })

function Write-Json($value) {
  $json = ConvertTo-Json -InputObject $value -Compress -Depth 8
  if ([string]::IsNullOrEmpty($json)) { $json = 'null' }
  $bytes = $script:Utf8.GetBytes($json + "`n")
  if ($bytes.Length -gt $MaxOutput) {
    $json = '{"ok":false,"error":{"code":"output_too_large","message":"窗口桥输出超过限制"}}'
    $bytes = $script:Utf8.GetBytes($json + "`n")
  }
  $script:Stdout.Write($bytes, 0, $bytes.Length)
  $script:Stdout.Flush()
}

function Exit-Failure([string]$code, [string]$message) {
  Write-Json ([pscustomobject]@{ ok = $false; error = [pscustomobject]@{ code = $code; message = $message } })
  exit 1
}

function Assert-Budget {
  if ([DateTime]::UtcNow -gt $script:Deadline) {
    Exit-Failure 'timeout' '窗口桥操作超时'
  }
}

function Clean-Text([string]$value, [int]$max) {
  if ([string]::IsNullOrEmpty($value)) { return '' }
  $clean = [regex]::Replace($value, '[\x00-\x1f\x7f-\x9f]', ' ')
  $clean = [regex]::Replace($clean, '\s+', ' ').Trim()
  if ($clean.Length -gt $max) { $clean = $clean.Substring(0, $max) }
  return $clean
}

function Invoke-List {
  $rows = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($candidate in @(Get-Process -ErrorAction SilentlyContinue)) {
      Assert-Budget
      try {
        $windowHandle = $candidate.MainWindowHandle.ToInt64()
        if ($windowHandle -le 0) { continue }
        $title = [string]$candidate.MainWindowTitle
        if ([string]::IsNullOrWhiteSpace($title)) { continue }
        if ($title.StartsWith('Default IME')) { continue }
        $name = Clean-Text ([string]$candidate.ProcessName) 80
        if ([string]::IsNullOrEmpty($name)) { continue }
        if ($allowed -notcontains $name.ToLowerInvariant()) { continue }
        $rows.Add([pscustomobject]@{
          pid = [int]$candidate.Id
          process = $name
          title = Clean-Text $title 200
          handle = $windowHandle
        })
        if ($rows.Count -ge 100) { break }
      } catch { }
    }
  } catch { }
  $sorted = @($rows | Sort-Object process, pid | Select-Object -First 100)
  Write-Json ([object[]]$sorted)
}

function Get-AllowedProcess([long]$windowHandle) {
  if ($windowHandle -le 0) { Exit-Failure 'invalid_handle' '窗口句柄无效' }
  Assert-Budget
  $process = $null
  foreach ($candidate in @(Get-Process -ErrorAction SilentlyContinue)) {
    try {
      if ($candidate.MainWindowHandle -ne 0 -and $candidate.MainWindowHandle.ToInt64() -eq $windowHandle) {
        $process = $candidate
        break
      }
    } catch { }
  }
  if ($null -eq $process) { Exit-Failure 'window_not_found' '窗口不存在或不可访问' }
  $name = [string]$process.ProcessName
  if ($allowed.Count -eq 0 -or $allowed -notcontains $name.ToLowerInvariant()) {
    Exit-Failure 'process_not_allowed' '窗口进程不在允许列表内'
  }
  $expected = Clean-Text $Expect 80
  if (-not [string]::IsNullOrEmpty($expected) -and $expected.ToLowerInvariant() -ne $name.ToLowerInvariant()) {
    Exit-Failure 'process_mismatch' '窗口进程与预期不符'
  }
  return $process
}

function Get-WindowRoot([long]$windowHandle) {
  $root = $null
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$windowHandle) } catch { }
  if ($null -eq $root) { Exit-Failure 'window_not_found' '窗口不存在或不可访问' }
  return $root
}

function Invoke-Read {
  $process = Get-AllowedProcess $Handle
  $root = Get-WindowRoot $Handle
  $texts = New-Object System.Collections.Generic.List[string]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $total = 0
  $typeProperty = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
  $condition = New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition($typeProperty, [System.Windows.Automation.ControlType]::Document)),
    (New-Object System.Windows.Automation.PropertyCondition($typeProperty, [System.Windows.Automation.ControlType]::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition($typeProperty, [System.Windows.Automation.ControlType]::Text))
  )
  $nodes = $null
  try {
    $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  } catch {
    Exit-Failure 'read_failed' '窗口文本读取失败'
  }
  foreach ($node in $nodes) {
    Assert-Budget
    $remaining = $MaxRead - $total
    if ($remaining -le 0) { break }
    $value = $null
    try {
      $pattern = $node.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      if ($pattern) { $value = $pattern.DocumentRange.GetText([Math]::Min($remaining, 4000)) }
    } catch { }
    if ([string]::IsNullOrWhiteSpace($value)) {
      try {
        $pattern = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($pattern) { $value = [string]$pattern.Current.Value }
      } catch { }
    }
    if ([string]::IsNullOrWhiteSpace($value)) { continue }
    $trimmed = ([string]$value).Trim()
    if ($trimmed.Length -gt $remaining) { $trimmed = $trimmed.Substring(0, $remaining) }
    if ($seen.Add($trimmed)) {
      $texts.Add($trimmed)
      $total += $trimmed.Length + 1
    }
  }
  $text = ($texts -join "`n")
  if ($text.Length -gt $MaxRead) { $text = $text.Substring($text.Length - $MaxRead) }
  Write-Json ([pscustomobject]@{ text = $text; process = [string]$process.ProcessName })
}

function ConvertTo-SendKeys([string]$value) {
  $safe = [regex]::Replace($value, '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '')
  $safe = $safe.Replace('{', '{{}').Replace('}', '{}}')
  $safe = $safe.Replace('+', '{+}').Replace('^', '{^}').Replace('%', '{%}')
  $safe = $safe.Replace('~', '{~}').Replace('(', '{(}').Replace(')', '{)}')
  $safe = $safe.Replace('[', '{[}').Replace(']', '{]}')
  $safe = $safe.Replace("`r`n", '{ENTER}').Replace("`n", '{ENTER}').Replace("`r", '{ENTER}')
  $safe = $safe.Replace("`t", '{TAB}')
  return $safe
}

function Invoke-Send {
  if ([string]::IsNullOrWhiteSpace($Text)) { Exit-Failure 'text_empty' '发送文本不能为空' }
  if ($Text.Length -gt $MaxText) { Exit-Failure 'text_too_long' '发送文本过长' }
  $process = Get-AllowedProcess $Handle
  $root = Get-WindowRoot $Handle
  Assert-Budget
  try {
    [void][WindowBridgeNative]::ShowWindow([IntPtr]$Handle, 9)
    $activated = [WindowBridgeNative]::SetForegroundWindow([IntPtr]$Handle)
  } catch {
    $activated = $false
  }
  if (-not $activated) {
    try { [void][Microsoft.VisualBasic.Interaction]::AppActivate($process.Id) } catch { }
  }
  Start-Sleep -Milliseconds 120
  Assert-Budget

  $typeProperty = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
  $editorCondition = New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition($typeProperty, [System.Windows.Automation.ControlType]::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition($typeProperty, [System.Windows.Automation.ControlType]::Document))
  )
  $editors = $null
  try {
    $editors = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editorCondition)
  } catch {
    Exit-Failure 'send_failed' '窗口文本发送失败'
  }

  $set = $false
  $target = $null
  $composerPattern = '发消息|发送消息|发送|消息|输入|询问|回复|聊天|message|prompt|ask|reply|chat'
  $searchPattern = '搜索|查找|筛选|过滤|search|filter'
  $named = $null
  $unnamed = $null
  $any = $null
  $bestNamed = [double]::NegativeInfinity
  $bestUnnamed = [double]::NegativeInfinity
  $bestAny = [double]::NegativeInfinity
  # 聊天输入框通常在窗口底部。先按占位文案识别，并排除搜索/筛选框，避免把指令打进搜索栏。
  foreach ($editor in $editors) {
    Assert-Budget
    try {
      $readonly = $true
      try {
        $valuePattern = $editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($valuePattern) { $readonly = [bool]$valuePattern.Current.IsReadOnly }
      } catch { }
      if ($readonly) { continue }
      $rect = $editor.Current.BoundingRectangle
      if ([double]::IsInfinity($rect.Top) -or [double]::IsInfinity($rect.Height)) { continue }
      if ($rect.Width -lt 40 -or $rect.Height -lt 10) { continue }
      $bottom = $rect.Top + $rect.Height
      $name = Clean-Text ([string]$editor.Current.Name) 200
      if (-not [string]::IsNullOrEmpty($name) -and $name -match $searchPattern) { continue }
      if ($bottom -gt $bestAny) { $bestAny = $bottom; $any = $editor }
      if ([string]::IsNullOrEmpty($name)) {
        if ($bottom -gt $bestUnnamed) { $bestUnnamed = $bottom; $unnamed = $editor }
        continue
      }
      if ($name -match $composerPattern -and $bottom -gt $bestNamed) { $bestNamed = $bottom; $named = $editor }
    } catch { }
  }
  if ($null -ne $named) { $target = $named }
  elseif ($null -ne $unnamed) { $target = $unnamed }
  elseif ($null -ne $any) { $target = $any }
  if ($null -eq $target -and $editors.Count -eq 0) { $target = $root }
  if ($null -eq $target) {
    Exit-Failure 'window_not_ready' '未找到消息输入框，请先把该窗口切到会话页面'
  }

  try {
    $pattern = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($pattern -and -not $pattern.Current.IsReadOnly) {
      $draft = [string]$pattern.Current.Value
      if (-not [string]::IsNullOrWhiteSpace($draft) -and $draft -ne $Text) {
        Exit-Failure 'window_busy' '目标窗口输入框已有未发送内容，请先发送或清空后再试'
      }
      $pattern.SetValue($Text)
      $set = ([string]$pattern.Current.Value) -eq $Text
    }
  } catch { $set = $false }

  if (-not $set) {
    try { $target.SetFocus() } catch { try { $root.SetFocus() } catch { } }
    Start-Sleep -Milliseconds 60
    $pasted = $false
    try {
      Set-Clipboard -Value $Text
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      $pasted = $true
    } catch { }
    if (-not $pasted) {
      $escaped = ConvertTo-SendKeys $Text
      try {
        [System.Windows.Forms.SendKeys]::SendWait($escaped)
      } catch {
        Exit-Failure 'send_failed' '窗口文本发送失败'
      }
    }
  }

  if ($Submit) {
    try { $target.SetFocus() } catch { }
    Start-Sleep -Milliseconds 120
    try {
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    } catch {
      Exit-Failure 'send_failed' '窗口文本发送失败'
    }
    Start-Sleep -Milliseconds 250
    try {
      $verify = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($verify -and [string]$verify.Current.Value -eq $Text) {
        Start-Sleep -Milliseconds 120
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      }
    } catch { }
  }
  Write-Json ([pscustomobject]@{ ok = $true; process = [string]$process.ProcessName; submitted = [bool]$Submit })
}

if ($Command -eq 'list') {
  try { Invoke-List } catch { Exit-Failure 'operation_failed' '窗口操作失败' }
  exit 0
}

try {
  [void](Add-Type -AssemblyName UIAutomationClient)
  [void](Add-Type -AssemblyName UIAutomationTypes)
  [void](Add-Type -AssemblyName System.Windows.Forms)
  [void](Add-Type -AssemblyName Microsoft.VisualBasic)
  if (-not ('WindowBridgeNative' -as [type])) {
    $nativeSource = 'using System; using System.Runtime.InteropServices; public static class WindowBridgeNative { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }'
    [void](Add-Type -TypeDefinition $nativeSource)
  }
} catch {
  Exit-Failure 'operation_failed' '无法加载窗口辅助功能组件'
}

if ($Command -eq 'read') {
  try { Invoke-Read } catch { Exit-Failure 'read_failed' '窗口文本读取失败' }
  exit 0
}

if ($Command -eq 'send') {
  try { Invoke-Send } catch { Exit-Failure 'send_failed' '窗口文本发送失败' }
  exit 0
}

Exit-Failure 'operation_failed' '窗口操作失败'