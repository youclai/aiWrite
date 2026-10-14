# sdkmanager 调用器（PowerShell 下 .bat 包装在当前沙箱内无法执行，这里直接调 java 主类）
# 用法： .\sdk.ps1 --list   |   .\sdk.ps1 --licenses   |   .\sdk.ps1 "platform-tools" "platforms;android-35"

param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Sdka)

$ErrorActionPreference = 'Stop'
$Workspace = Split-Path -Parent $PSScriptRoot
$SdkRoot   = Join-Path $Workspace 'tools\android-sdk'
$Cmdline   = Join-Path $SdkRoot 'cmdline-tools\latest'
$FakeHome  = Join-Path $Workspace 'tools\home'

if (-not (Test-Path $Cmdline)) { throw "未找到 cmdline-tools：$Cmdline" }

& java `
  "-Duser.home=$FakeHome" `
  "-Dcom.android.sdklib.toolsdir=$Cmdline" `
  -cp (Join-Path $Cmdline 'lib\sdkmanager-classpath.jar') `
  com.android.sdklib.tool.sdkmanager.SdkManagerCli `
  "--sdk_root=$SdkRoot" @Sdka

exit $LASTEXITCODE
