param([Parameter(Mandatory=$true)][string]$NodeExecutable)
$ErrorActionPreference = 'Stop'
$mediaProjectRoot = Split-Path -Parent $PSScriptRoot
$mediaLogDirectory = Join-Path $mediaProjectRoot 'var/media-node'
New-Item -ItemType Directory -Path $mediaLogDirectory -Force | Out-Null
$mediaStopFile = Join-Path $mediaLogDirectory 'stop'
Set-Location -LiteralPath $mediaProjectRoot
# A stop marker deliberately survives a reboot. Remove it before starting again.
while (-not (Test-Path -LiteralPath $mediaStopFile)) {
    try {
        & $NodeExecutable (Join-Path $PSScriptRoot 'media-node.mjs') 2>&1 |
            Out-File -LiteralPath (Join-Path $mediaLogDirectory 'service.log') -Append -Encoding utf8
    } catch {
        'Media node exited; restarting in 15 seconds.' |
            Out-File -LiteralPath (Join-Path $mediaLogDirectory 'service.log') -Append -Encoding utf8
    }
    Start-Sleep -Seconds 15
}
