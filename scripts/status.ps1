# Show whether ChemFoam is running, and its links.
. "$PSScriptRoot\common.ps1"

if (Test-ServerRunning) {
    Write-Host 'ChemFoam is ACTIVE and running in the background.' -ForegroundColor Green
    Show-Links
} else {
    Write-Host 'ChemFoam is NOT running.' -ForegroundColor Red
    Write-Host 'Start it with: start-chemfoam.cmd'
}
