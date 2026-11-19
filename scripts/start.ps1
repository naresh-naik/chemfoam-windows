# Start ChemFoam in the background (server + Windows host + internet tunnel).
. "$PSScriptRoot\common.ps1"

Stop-ChemFoam
Start-Sleep -Milliseconds 500
Initialize-ChemFoam

# Settings passed to the server and host
$env:PORT = "$Port"
$env:CHEMFOAM_TOKEN = $Token
$env:CHEMFOAM_FFMPEG = $Ffmpeg
$env:CHEMFOAM_STATE_DIR = $StateDir
if (Test-HttpsAvailable) {
    $env:CHEMFOAM_TLS_CERT = Join-Path $TlsDir 'cert.pem'
    $env:CHEMFOAM_TLS_KEY = Join-Path $TlsDir 'key.pem'
    $env:HTTPS_PORT = "$HttpsPort"
}

Start-Process -FilePath $Node -ArgumentList @("`"$Root\server\src\server.js`"") -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $StateDir 'server.log') -RedirectStandardError (Join-Path $StateDir 'server.err.log') | Out-Null
Start-Sleep -Seconds 1
Start-Process -FilePath $Node -ArgumentList @("`"$Root\host\host.js`"") -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $StateDir 'host.log') -RedirectStandardError (Join-Path $StateDir 'host.err.log') | Out-Null
Start-Tunnel

for ($i = 0; $i -lt 10 -and -not (Test-ServerRunning); $i++) { Start-Sleep -Milliseconds 300 }
if (-not (Test-ServerRunning)) {
    Write-Host 'ChemFoam failed to start. See the logs in:' -ForegroundColor Red
    Write-Host "   $StateDir"
    exit 1
}

Write-Host ''
Write-Host '============================================================='
Write-Host '  ChemFoam is now running in the background' -ForegroundColor Green
Write-Host '============================================================='
Show-Links
Write-Host '-------------------------------------------------------------'
Write-Host 'You can close this window. Stop: stop-chemfoam.cmd   Links: status-chemfoam.cmd'
Write-Host '============================================================='
Write-Host ''
