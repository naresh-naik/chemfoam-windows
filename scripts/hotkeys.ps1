# ChemFoam global keyboard shortcuts (runs hidden in the background, started at login).
#   Ctrl+Alt+Shift+R   start ChemFoam (or copy the link if it's already running)
#   Ctrl+Alt+Shift+S   stop ChemFoam
#   Ctrl+Alt+Shift+L   copy the current link
$ErrorActionPreference = 'Stop'

# Only one copy at a time
$mutex = New-Object System.Threading.Mutex($false, 'Local\ChemFoamHotkeys')
if (-not $mutex.WaitOne(0)) { exit 0 }

$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ChemFoamHotkeys
{
    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG msg, IntPtr hWnd, uint filterMin, uint filterMax);

    const uint MOD_ALT = 0x0001;
    const uint MOD_CONTROL = 0x0002;
    const uint MOD_SHIFT = 0x0004;
    const uint MOD_NOREPEAT = 0x4000;
    const uint WM_HOTKEY = 0x0312;

    public static void Run(string actionScript)
    {
        string[] actions = new string[] { "start", "stop", "copy" };
        uint[] keys = new uint[] { 0x52, 0x53, 0x4C };   // R, S, L
        uint mods = MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT;
        for (int i = 0; i < actions.Length; i++)
        {
            if (RegisterHotKey(IntPtr.Zero, i + 1, mods, keys[i]))
                Console.WriteLine("Registered Ctrl+Alt+Shift+" + (char)keys[i] + " (" + actions[i] + ")");
            else
                Console.WriteLine("Could not register Ctrl+Alt+Shift+" + (char)keys[i] + " - another app may be using it");
        }

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.message != WM_HOTKEY) continue;
            int id = msg.wParam.ToInt32();
            if (id < 1 || id > actions.Length) continue;
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + actionScript + "\" " + actions[id - 1]);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[ChemFoamHotkeys]::Run((Join-Path $PSScriptRoot 'hotkey-action.ps1'))
