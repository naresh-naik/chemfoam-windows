# Installs the ChemFoam keyboard shortcuts and starts them automatically at login.
. "$PSScriptRoot\common.ps1"

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'ChemFoam Hotkeys.lnk'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launchArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\scripts\hotkeys.ps1`""

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $psExe
$shortcut.Arguments = $launchArgs
$shortcut.WorkingDirectory = $Root
$shortcut.WindowStyle = 7
$shortcut.Description = 'ChemFoam keyboard shortcuts'
$shortcut.Save()

# Start it now (a second copy exits on its own if one is already running)
Start-Process -FilePath $psExe -ArgumentList $launchArgs -WindowStyle Hidden | Out-Null

Write-Host ''
Write-Host 'ChemFoam keyboard shortcuts installed (they also start automatically at login):' -ForegroundColor Green
Write-Host '   Ctrl+Alt+Shift+R   Start ChemFoam -> any-network link copied to clipboard'
Write-Host '   Ctrl+Alt+Shift+S   Stop ChemFoam'
Write-Host '   Ctrl+Alt+Shift+L   Copy the current link'
Write-Host ''
Write-Host 'Remove with: uninstall-shortcuts.cmd'
