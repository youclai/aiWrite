# 构建环境变量（按会话临时设置，不写全局、不写注册表）
# 用法： . .\env.ps1   然后 .\sdk.ps1 <sdkmanager 参数>
# 所有路径基于本脚本位置推导，仓库可整体迁移。

$ErrorActionPreference = 'Stop'

$RepoRoot   = $PSScriptRoot                                   # novel-ai-tool/
$Workspace  = Split-Path -Parent $RepoRoot                    # 工作区根
$SdkRoot    = Join-Path $Workspace 'tools\android-sdk'
$Cmdline    = Join-Path $SdkRoot 'cmdline-tools\latest'
$FakeHome   = Join-Path $Workspace 'tools\home'
$GradleHome = Join-Path $Workspace 'tools\gradle-home'
$NpmCache   = Join-Path $Workspace 'tools\npm-cache'

foreach ($d in @($SdkRoot, $FakeHome, $GradleHome, $NpmCache)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

$env:ANDROID_HOME      = $SdkRoot
$env:ANDROID_SDK_ROOT  = $SdkRoot
$env:GRADLE_USER_HOME  = $GradleHome
$env:npm_config_cache  = $NpmCache

Write-Output "ANDROID_HOME=$env:ANDROID_HOME"
Write-Output "GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
Write-Output "SDK components dir: $Cmdline"
