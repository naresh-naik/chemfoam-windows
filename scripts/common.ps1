# Shared settings and helpers for the ChemFoam (Windows) scripts. Dot-source this file.
# Compatible with Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7.

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Port = 3000
if ($env:PORT) { $Port = [int]$env:PORT }
$HttpsPort = 3443
if ($env:HTTPS_PORT) { $HttpsPort = [int]$env:HTTPS_PORT }

$StateDir = Join-Path $env:TEMP 'chemfoam'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$TunnelLog = Join-Path $StateDir 'tunnel.log'
$TunnelUrlFile = Join-Path $StateDir 'tunnel-url.txt'
$TokenFile = Join-Path $Root '.chemfoam-token'
$TlsDir = Join-Path $Root '.chemfoam-tls'

# ---------------------------------------------------------------------------
# Access key: anyone holding it can control this PC. Generated once, kept private.
# ---------------------------------------------------------------------------
function Get-ChemFoamToken {
    if (-not (Test-Path $TokenFile) -or (Get-Item $TokenFile).Length -eq 0) {
        $bytes = New-Object byte[] 16
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        Set-Content -Path $TokenFile -Value $hex -NoNewline -Encoding Ascii
    }
    return (Get-Content -Path $TokenFile -Raw).Trim()
}
$Token = Get-ChemFoamToken

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
function Get-LanIp {
    try {
        $cfg = Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } |
            Select-Object -First 1
        if ($cfg) {
            $addr = $cfg.IPv4Address | Select-Object -First 1
            if ($addr) { return $addr.IPAddress }
        }
    } catch { }
    $ip = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
        Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.ToString().StartsWith('127.') -and -not $_.ToString().StartsWith('169.254.') } |
        Select-Object -First 1
    if ($ip) { return $ip.ToString() }
    return '127.0.0.1'
}
$LanIp = Get-LanIp

function Test-ServerRunning {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(700) -and $client.Connected
        $client.Close()
        return [bool]$ok
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# Tools (also found right after `winget install`, before PATH refreshes)
# ---------------------------------------------------------------------------
function Find-Exe([string]$name, [string[]]$extra) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($p in $extra) {
        $hit = Get-Item -Path $p -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$WinGetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
$WinGetPkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'

$Node = Find-Exe 'node.exe' @("$env:ProgramFiles\nodejs\node.exe")
$Ffmpeg = Find-Exe 'ffmpeg.exe' @("$WinGetLinks\ffmpeg.exe", "$WinGetPkgs\Gyan.FFmpeg*\*\bin\ffmpeg.exe", "C:\ffmpeg\bin\ffmpeg.exe")
$Cloudflared = Find-Exe 'cloudflared.exe' @("$WinGetLinks\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe")
$OpenSsl = Find-Exe 'openssl.exe' @("$env:ProgramFiles\Git\usr\bin\openssl.exe", "$env:ProgramFiles\Git\mingw64\bin\openssl.exe")

function Assert-Tools {
    $missing = @()
    if (-not $Node) { $missing += 'Node.js   ->  winget install OpenJS.NodeJS.LTS' }
    if (-not $Ffmpeg) { $missing += 'FFmpeg    ->  winget install Gyan.FFmpeg' }
    if ($missing.Count -gt 0) {
        Write-Host ''
        Write-Host 'Missing required tools. Install them, then open a NEW terminal and try again:' -ForegroundColor Red
        foreach ($m in $missing) { Write-Host "   $m" }
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Setup: server dependencies + optional HTTPS certificate for the fast LAN link
# ---------------------------------------------------------------------------
function Initialize-ChemFoam {
    Assert-Tools
    $modules = Join-Path $Root 'server\node_modules'
    if (-not (Test-Path $modules)) {
        Write-Host 'Installing server dependencies (one time)...'
        $npm = Join-Path (Split-Path $Node) 'npm.cmd'
        if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }
        Push-Location (Join-Path $Root 'server')
        # Windows PowerShell 5.1 turns a native tool's stderr into a terminating error when
        # $ErrorActionPreference is 'Stop' and stderr is redirected, so relax it for this call.
        $ErrorActionPreference = 'Continue'
        $out = & $npm install --no-audit --no-fund 2>&1
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        Pop-Location
        if ($code -ne 0) {
            Write-Host 'npm install failed:' -ForegroundColor Red
            $out | Select-Object -Last 15 | ForEach-Object { Write-Host "   $_" }
            Remove-Item -Recurse -Force $modules -ErrorAction SilentlyContinue
            exit 1
        }
    }
    Initialize-Certificate
}

function Initialize-Certificate {
    if (-not $OpenSsl) { return }      # optional: without it the https LAN link is simply not offered
    New-Item -ItemType Directory -Force -Path $TlsDir | Out-Null
    $cert = Join-Path $TlsDir 'cert.pem'
    $key = Join-Path $TlsDir 'key.pem'
    $ipFile = Join-Path $TlsDir 'ip'
    if ((Test-Path $cert) -and (Test-Path $ipFile) -and ((Get-Content $ipFile -Raw).Trim() -eq $LanIp)) { return }
    $cnf = Join-Path $TlsDir 'openssl.cnf'
    @"
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ChemFoam
[v3]
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:$LanIp
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
"@ | Set-Content -Path $cnf -Encoding Ascii
    # openssl prints its key-generation progress to stderr; under 'Stop' Windows PowerShell 5.1
    # would treat that as a fatal NativeCommandError, so relax it for this call.
    $ErrorActionPreference = 'Continue'
    & $OpenSsl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout $key -out $cert -config $cnf 2>&1 | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -eq 0) {
        Set-Content -Path $ipFile -Value $LanIp -NoNewline -Encoding Ascii
    } else {
        Remove-Item $cert, $key -ErrorAction SilentlyContinue   # https link is optional; just skip it
    }
}

function Test-HttpsAvailable {
    return (Test-Path (Join-Path $TlsDir 'cert.pem')) -and (Test-Path (Join-Path $TlsDir 'key.pem'))
}

# ---------------------------------------------------------------------------
# Stop everything ChemFoam started (and nothing else)
# ---------------------------------------------------------------------------
function Stop-ChemFoam {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ffmpeg.exe' OR Name='cloudflared.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        $cl = $p.CommandLine
        if (-not $cl -or $p.ProcessId -eq $PID) { continue }
        $isOurs = $false
        if ($p.Name -eq 'node.exe' -and ($cl.Contains("$Root\server\src\server.js") -or $cl.Contains("$Root\host\host.js"))) { $isOurs = $true }
        if ($p.Name -eq 'cloudflared.exe' -and $cl.Contains("--url http://localhost:$Port")) { $isOurs = $true }
        if (($p.Name -eq 'powershell.exe' -or $p.Name -eq 'pwsh.exe') -and $cl.Contains("$Root\host\input-helper.ps1")) { $isOurs = $true }
        if ($p.Name -eq 'ffmpeg.exe' -and $cl.Contains('-f flv') -and $cl.Contains('pipe:1')) { $isOurs = $true }
        if ($isOurs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item $TunnelUrlFile -ErrorAction SilentlyContinue
}

function Test-HostRunning {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine.Contains("$Root\host\host.js")) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Internet link (Cloudflare quick tunnel)
# ---------------------------------------------------------------------------
function Get-TunnelUrl {
    if (Test-Path $TunnelUrlFile) { return (Get-Content $TunnelUrlFile -Raw).Trim() }
    if (Test-Path $TunnelLog) {
        try {
            $text = [System.IO.File]::ReadAllText($TunnelLog)
        } catch {
            $fs = New-Object System.IO.FileStream($TunnelLog, 'Open', 'Read', 'ReadWrite')
            $sr = New-Object System.IO.StreamReader($fs)
            $text = $sr.ReadToEnd()
            $sr.Close()
        }
        $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($m.Success) {
            Set-Content -Path $TunnelUrlFile -Value $m.Value -NoNewline -Encoding Ascii
            return $m.Value
        }
    }
    return $null
}

function Start-Tunnel {
    if ($env:CHEMFOAM_TUNNEL -eq '0') { return }
    if (-not $Cloudflared) {
        Write-Host 'Internet link disabled: cloudflared is not installed (winget install Cloudflare.cloudflared).' -ForegroundColor Yellow
        return
    }
    Remove-Item $TunnelLog, $TunnelUrlFile -ErrorAction SilentlyContinue
    Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$Port") `
        -WindowStyle Hidden -RedirectStandardError $TunnelLog -RedirectStandardOutput (Join-Path $StateDir 'tunnel.out.log') | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-TunnelUrl) { return }
    }
    Write-Host 'The internet link is still starting - run status-chemfoam.cmd in a few seconds.' -ForegroundColor Yellow
}

function Show-Links {
    Write-Host "Same Wi-Fi:           http://${LanIp}:${Port}/?k=$Token"
    if (Test-HttpsAvailable) {
        Write-Host "Same Wi-Fi (lowest):  https://${LanIp}:${HttpsPort}/?k=$Token"
        Write-Host "   (first visit: 'Advanced' -> 'Proceed' - it's this PC's own certificate)"
    }
    Write-Host "This PC:              http://localhost:${Port}/?k=$Token"
    $url = Get-TunnelUrl
    if ($url) { Write-Host "Any network:          $url/?k=$Token" -ForegroundColor Green }
    Write-Host 'Keep these links private - anyone with one can control this PC.' -ForegroundColor Yellow
}
