# Runs one keyboard-shortcut action: start | stop | copy
param([Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'copy')][string]$Action)

. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Notifications don't block: the tray icons are cleaned up once the action finishes
$script:NoteIcons = New-Object System.Collections.ArrayList
function Show-Note([string]$title, [string]$text, [string]$kind = 'Info') {
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.Visible = $true
    $icon.ShowBalloonTip(5000, $title, $text, $kind)
    [void]$script:NoteIcons.Add($icon)
}
function Clear-Notes {
    if ($script:NoteIcons.Count -gt 0) { Start-Sleep -Seconds 5 }
    foreach ($icon in $script:NoteIcons) { $icon.Dispose() }
}

# One action at a time
$mutex = New-Object System.Threading.Mutex($false, 'Local\ChemFoamHotkeyAction')
if (-not $mutex.WaitOne(0)) {
    Show-Note 'ChemFoam' 'Busy - please wait a moment.' 'Warning'
    Clear-Notes
    exit 0
}

function Get-BestLink {
    $url = Get-TunnelUrl
    if ($url) { return "$url/?k=$Token" }
    return "http://${LanIp}:${Port}/?k=$Token"
}

function Test-LinkLive([string]$url) {
    # A live link answers (401 without the key is fine: it means our server replied)
    try {
        $req = [System.Net.WebRequest]::Create($url)
        $req.Timeout = 6000
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [System.Net.WebException] {
        return ($_.Exception.Response -ne $null)
    } catch {
        return $false
    }
}

function Test-TunnelAlive {
    $p = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains("--url http://localhost:$Port") }
    return [bool]$p
}

try {
    switch ($Action) {
        'start' {
            $healthy = (Test-ServerRunning) -and (Test-HostRunning) -and ((-not $Cloudflared) -or (Test-TunnelAlive))
            if ($healthy) {
                Set-Clipboard -Value (Get-BestLink)
                Show-Note 'ChemFoam is already running' 'Link copied to clipboard (unchanged).'
                break
            }
            Show-Note 'ChemFoam' 'Starting...'
            & "$PSScriptRoot\start.ps1" | Out-Null
            if (-not (Test-ServerRunning)) {
                Show-Note 'ChemFoam' 'Failed to start - run start-chemfoam.cmd to see why.' 'Error'
                break
            }
            $link = Get-BestLink
            Set-Clipboard -Value $link
            $url = Get-TunnelUrl
            if ($url) {
                Show-Note 'ChemFoam' 'Running - new link copied. Waiting for it to go live...'
                $live = $false
                for ($i = 0; $i -lt 25 -and -not $live; $i++) {
                    $live = Test-LinkLive $url
                    if (-not $live) { Start-Sleep -Seconds 3 }
                }
                if ($live) { Show-Note 'ChemFoam is ready' 'Any-network link copied to clipboard. Paste it on your other device.' }
                else { Show-Note 'ChemFoam' 'Running, link copied - it may take another minute to work from other networks.' 'Warning' }
            } else {
                Show-Note 'ChemFoam is ready' 'Same-Wi-Fi link copied (internet link unavailable).'
            }
        }
        'stop' {
            Stop-ChemFoam
            Show-Note 'ChemFoam stopped' 'Remote access is off.'
        }
        'copy' {
            if (-not (Test-ServerRunning)) {
                Show-Note 'ChemFoam' 'Not running - press Ctrl+Alt+Shift+R to start.' 'Warning'
                break
            }
            Set-Clipboard -Value (Get-BestLink)
            Show-Note 'ChemFoam' 'Link copied to clipboard.'
        }
    }
} finally {
    $mutex.ReleaseMutex()
    Clear-Notes
}
