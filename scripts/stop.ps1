# Stop ChemFoam (server, host, screen capture, input helper and tunnel).
. "$PSScriptRoot\common.ps1"

Write-Host 'Stopping ChemFoam...'
Stop-ChemFoam
Write-Host 'ChemFoam has been stopped.' -ForegroundColor Green
