# ChemFoam input helper (Windows).
# Injects mouse / keyboard input with Win32 SendInput and reports the cursor position.
# Started by host.js; talks over stdin/stdout with a tiny line protocol:
#   in : M <nx> <ny>              move to normalized position (0..1)
#        B <btn> <1|0> [nx ny]    mouse button down/up (0 left, 1 middle, 2 right)
#        W <dy> <dx>              wheel (120 = one notch; +dy = scroll up)
#        K <vk> <1|0> <ext>       virtual key down/up, ext = extended-key flag
#        T <base64-utf8>          type text (any language / emoji)
#   out: READY <w> <h> | C <nx> <ny> | E <message>
# Written in C# 5 so the PowerShell 5.1 built into Windows can compile it.

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ChemFoamInput
{
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint code, uint mapType);

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    static readonly object writeLock = new object();
    static readonly CultureInfo inv = CultureInfo.InvariantCulture;
    static int screenW = 1920;
    static int screenH = 1080;

    static void Write(string line)
    {
        lock (writeLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    public static void Run()
    {
        // Physical pixels everywhere (matches what the screen capture sees)
        SetProcessDPIAware();
        screenW = GetSystemMetrics(0);
        screenH = GetSystemMetrics(1);
        Write("READY " + screenW + " " + screenH);

        Thread cursorThread = new Thread(CursorLoop);
        cursorThread.IsBackground = true;
        cursorThread.Start();

        TextReader reader = Console.In;
        string line;
        while ((line = reader.ReadLine()) != null)
        {
            try
            {
                Handle(line);
            }
            catch (Exception e)
            {
                Write("E " + e.Message.Replace('\r', ' ').Replace('\n', ' '));
            }
        }
    }

    static void Handle(string line)
    {
        string[] p = line.Split(' ');
        if (p.Length == 0) return;
        switch (p[0])
        {
            case "M":
                MoveAbs(double.Parse(p[1], inv), double.Parse(p[2], inv));
                break;
            case "B":
            {
                int button = int.Parse(p[1], inv);
                bool down = p[2] == "1";
                if (p.Length >= 5) MoveAbs(double.Parse(p[3], inv), double.Parse(p[4], inv));
                Button(button, down);
                break;
            }
            case "W":
                Wheel(int.Parse(p[1], inv), int.Parse(p[2], inv));
                break;
            case "K":
                Key((ushort)int.Parse(p[1], inv), p[2] == "1", p[3] == "1");
                break;
            case "T":
                TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(p[1])));
                break;
        }
    }

    static void Send(INPUT input)
    {
        INPUT[] inputs = new INPUT[] { input };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void MoveAbs(double nx, double ny)
    {
        nx = Math.Max(0.0, Math.Min(1.0, nx));
        ny = Math.Max(0.0, Math.Min(1.0, ny));
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = (int)Math.Round(nx * 65535.0);
        i.u.mi.dy = (int)Math.Round(ny * 65535.0);
        i.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        Send(i);
    }

    static void Button(int button, bool down)
    {
        uint flags;
        if (button == 2) flags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        else if (button == 1) flags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else flags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dwFlags = flags;
        Send(i);
    }

    static void Wheel(int dy, int dx)
    {
        if (dy != 0)
        {
            INPUT i = new INPUT();
            i.type = INPUT_MOUSE;
            i.u.mi.mouseData = unchecked((uint)dy);
            i.u.mi.dwFlags = MOUSEEVENTF_WHEEL;
            Send(i);
        }
        if (dx != 0)
        {
            INPUT i = new INPUT();
            i.type = INPUT_MOUSE;
            i.u.mi.mouseData = unchecked((uint)dx);
            i.u.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            Send(i);
        }
    }

    static void Key(ushort vk, bool down, bool extended)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        uint flags = 0;
        if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
        if (!down) flags |= KEYEVENTF_KEYUP;
        i.u.ki.dwFlags = flags;
        Send(i);
    }

    static void TypeText(string text)
    {
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (c == '\n')
            {
                Key(0x0D, true, false);
                Key(0x0D, false, false);
                continue;
            }
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.u.ki.wScan = c;
            down.u.ki.dwFlags = KEYEVENTF_UNICODE;
            Send(down);
            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.u.ki.wScan = c;
            up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            Send(up);
        }
    }

    static void CursorLoop()
    {
        int lastX = int.MinValue;
        int lastY = int.MinValue;
        int tick = 0;
        while (true)
        {
            Thread.Sleep(8);
            if (++tick % 250 == 0)
            {
                // Pick up resolution changes every ~2 s
                screenW = GetSystemMetrics(0);
                screenH = GetSystemMetrics(1);
            }
            POINT pt;
            if (!GetCursorPos(out pt)) continue;
            if (pt.X == lastX && pt.Y == lastY) continue;
            lastX = pt.X;
            lastY = pt.Y;
            double nx = screenW > 0 ? (double)pt.X / screenW : 0;
            double ny = screenH > 0 ? (double)pt.Y / screenH : 0;
            Write("C " + nx.ToString("0.0000", inv) + " " + ny.ToString("0.0000", inv));
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[ChemFoamInput]::Run()
