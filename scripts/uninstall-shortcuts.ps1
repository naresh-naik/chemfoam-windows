# Removes the ChemFoam keyboard shortcuts (ChemFoam itself is not touched).
. "$PSScriptRoot\common.ps1"

$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChemFoam Hotkeys.lnk'
Remove-Item $lnkPath -ErrorAction SilentlyContinue

$procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine.Contains("$Root\scripts\hotkeys.ps1") -and $p.ProcessId -ne $PID) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Write-Host 'ChemFoam keyboard shortcuts removed.' -ForegroundColor Green
