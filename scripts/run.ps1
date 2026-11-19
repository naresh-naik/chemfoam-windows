# Run ChemFoam in the foreground and show the host log. Press Ctrl+C to stop everything.
. "$PSScriptRoot\common.ps1"

& "$PSScriptRoot\start.ps1"
if (-not (Test-ServerRunning)) { exit 1 }

Write-Host 'Showing live log. Press Ctrl+C to stop ChemFoam.' -ForegroundColor Cyan
try {
    Get-Content -Path (Join-Path $StateDir 'host.log') -Wait -Tail 20
} finally {
    Stop-ChemFoam
    Write-Host 'ChemFoam has been stopped.' -ForegroundColor Green
}
