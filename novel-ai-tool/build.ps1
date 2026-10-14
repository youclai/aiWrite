# Build entrypoint. NOTE: keep this file ASCII-only -- Windows PowerShell 5.1 reads
# .ps1 without BOM as the local ANSI codepage, and multi-byte Chinese in string literals
# breaks its tokenizer. Chinese comments are fine in .md/.js, not here.
# Usage:  .\build.ps1              # sync www then assembleDebug
#         .\build.ps1 -Task assembleRelease
#         .\build.ps1 -SkipSync    # rebuild only
param(
    [string]$Task = 'assembleDebug',
    [switch]$SkipSync
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')

$Android = Join-Path $PSScriptRoot 'android'
if (-not (Test-Path $Android)) { throw "android project not found: $Android" }

if (-not $SkipSync) {
    Write-Output '--- cap sync (copy www into assets/public) ---'
    Push-Location $PSScriptRoot
    try { npx cap sync android } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "cap sync failed (exit $LASTEXITCODE)" }
}

Write-Output "--- gradle $Task ---"
Push-Location $Android
try {
    $cp = Join-Path 'gradle' (Join-Path 'wrapper' 'gradle-wrapper.jar')
    & java '-Dfile.encoding=UTF-8' -cp $cp org.gradle.wrapper.GradleWrapperMain $Task '--no-daemon' '--console=plain'
    if ($LASTEXITCODE -ne 0) { throw "gradle $Task failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

# Verify artifact: size + package + sdk levels + missing icon (aapt2 ships with build-tools)
$Apk = Join-Path $Android 'app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $Apk) {
    $fi = Get-Item $Apk
    Write-Output ('APK: ' + $fi.FullName)
    Write-Output ('APK: ' + [math]::Round($fi.Length / 1MB, 2) + ' MB  built ' + $fi.LastWriteTime)
    $Aapt = Get-ChildItem (Join-Path $env:ANDROID_HOME 'build-tools') -Recurse -Filter 'aapt2.exe' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($Aapt) {
        # no temp file: the sandbox only allows writes inside the workspace
        & $Aapt.FullName dump badging $Apk 2>&1 |
            Where-Object { $_ -match '^package:|^application: label|launchable-activity:|^sdkVersion|^targetSdkVersion' } |
            ForEach-Object { Write-Output ('  ' + $_) }
    } else {
        Write-Output 'aapt2 not found under ANDROID_HOME\build-tools'
    }
} else {
    Write-Output 'app-debug.apk not found (check artifact path if you ran another task)'
}
