# ChemFoam for Windows

**See and control your Windows PC from any phone, tablet or computer — on any network — right in the web browser.**

This is the Windows edition of ChemFoam. It streams your PC's screen in real time using your graphics card's hardware H.264 encoder and lets you click, type, scroll and drag on it remotely. Nothing needs to be installed on the device you connect *from*: just open a link in Chrome, Safari, Edge or Firefox.

| | |
|---|---|
| 🖥️ **Host** | Your Windows 10 / 11 PC (the computer being controlled) |
| 📱 **Viewer** | Any device with a modern browser — iPhone, Android, iPad, Mac, another PC |
| 🌍 **Networks** | Same Wi-Fi, or anywhere on the internet (mobile data, another Wi-Fi, another city) |
| 🔐 **Security** | Every link includes a private access key — without it, connections are refused |

> Looking for the Mac version? That's a separate project: **ChemFoam for macOS**.

---

## Table of contents

1. [What you need](#1-what-you-need)
2. [Install the tools (one time)](#2-install-the-tools-one-time)
3. [Download ChemFoam](#3-download-chemfoam)
4. [Start ChemFoam](#4-start-chemfoam)
5. [Allow it through Windows Firewall (one time)](#5-allow-it-through-windows-firewall-one-time)
6. [Connect from another device](#6-connect-from-another-device)
7. [Using it: touch, mouse & keyboard](#7-using-it-touch-mouse--keyboard)
8. [Everyday commands](#8-everyday-commands)
9. [Optional: keyboard shortcuts (Ctrl+Alt+Shift+R / S / L)](#9-optional-keyboard-shortcuts-ctrlaltshiftr--s--l)
10. [Security — please read](#10-security--please-read)
11. [Troubleshooting](#11-troubleshooting)
12. [Advanced options](#12-advanced-options)
13. [How it works](#13-how-it-works)
14. [Uninstall](#14-uninstall)

---

## 1. What you need

**On the PC you want to control (the host):**

- **Windows 10 (version 1809 or newer) or Windows 11**, 64-bit
- A normal desktop session (you're signed in and the screen is on)
- Any graphics: **NVIDIA, Intel or AMD** GPUs are used for hardware encoding automatically; without one it falls back to the CPU

**On the device you connect from (the viewer):**

- Any recent browser: **Chrome, Edge, Safari (iOS 16.4+ / macOS), or Firefox**
- Nothing to install

---

## 2. Install the tools (one time)

Open **Terminal** or **PowerShell** (press `Win`, type **Terminal**, press Enter) and run:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
winget install Cloudflare.cloudflared
winget install Git.Git
```

| Tool | Why |
|---|---|
| **Node.js** | Runs the ChemFoam server — required |
| **FFmpeg** | Captures the screen and encodes video with your GPU — required |
| **cloudflared** | Gives you a link that works **from any network** — optional (without it: same Wi-Fi only) |
| **Git** | Downloads ChemFoam and enables the extra-fast secure Wi-Fi link — optional |

Accept any prompts. When it's done, **close the terminal and open a new one** (so Windows picks up the new tools), then check:

```powershell
node --version
ffmpeg -version
cloudflared --version
```

Each should print a version.

> No `winget`? Update **App Installer** from the Microsoft Store, or download the installers from nodejs.org, gyan.dev/ffmpeg and Cloudflare.

---

## 3. Download ChemFoam

> This repository is **private**: you need to be signed in to a GitHub account that has access (the first `git clone` opens a browser sign-in), or download the ZIP while signed in on github.com.

**Option A — with Git (recommended):**

```powershell
cd $HOME\Downloads
git clone https://github.com/naresh-naik/chemfoam-windows.git
cd chemfoam-windows
```

**Option B — as a ZIP:** download the ZIP from GitHub, then **right-click the ZIP → Properties → tick "Unblock" → OK** *before* extracting it (otherwise Windows may block the scripts). Extract it to e.g. `Downloads\chemfoam-windows`.

---

## 4. Start ChemFoam

**Double-click `start-chemfoam.cmd`** in the ChemFoam folder — or run it from a terminal inside the folder:

```powershell
.\start-chemfoam.cmd
```

The first start takes about a minute (it installs the server's dependencies and detects your best video encoder). When it's ready you'll see:

```
=============================================================
  ChemFoam is now running in the background
=============================================================
Same Wi-Fi:           http://192.168.1.20:3000/?k=3f9a...
Same Wi-Fi (lowest):  https://192.168.1.20:3443/?k=3f9a...
This PC:              http://localhost:3000/?k=3f9a...
Any network:          https://random-words.trycloudflare.com/?k=3f9a...
Keep these links private - anyone with one can control this PC.
```

You can close the window — ChemFoam keeps running in the background.

> Windows needs **no** special screen-recording permission (unlike macOS).
> The *Same Wi-Fi (lowest)* link appears only if Git (which includes OpenSSL) is installed.

---

## 5. Allow it through Windows Firewall (one time)

The first time ChemFoam starts, Windows asks whether **Node.js** may communicate on networks.

- Tick **Private networks** (home / work Wi-Fi) and click **Allow access**.
- Without this, devices on your Wi-Fi can't connect (the 🌍 *Any network* link still works).

Missed it? Open **Windows Security → Firewall & network protection → Allow an app through firewall → Change settings**, and tick **Private** for **Node.js JavaScript Runtime**.

---

## 6. Connect from another device

Copy one of the links (run `status-chemfoam.cmd` any time to see them again) and open it in a browser on the other device. **Always copy the whole link, including the `?k=…` part** — that's the access key.

| Where is the other device? | Use this link | Notes |
|---|---|---|
| **Same Wi-Fi** | `http://<pc-ip>:3000/?k=…` | Works immediately. Hardware video over WebRTC. |
| **Same Wi-Fi, lowest delay** | `https://<pc-ip>:3443/?k=…` | The first time, the browser warns *"connection is not private"* — the certificate was made by your own PC. Tap **Advanced → Proceed** (once per device). |
| **Any other network** (mobile data, a friend's Wi-Fi, anywhere) | `https://….trycloudflare.com/?k=…` | Needs cloudflared. ⏳ A **new** link takes **1–2 minutes** to work worldwide — if you see *Error 1033* or *"can't be reached"*, wait a minute and reload. |
| **This PC** (testing) | `http://localhost:3000/?k=…` | Shows your screen inside itself — that's normal. |

**Tips**

- 📲 On a phone, use **Share → Add to Home Screen** for a full-screen, app-like experience.
- 🔁 The 🌍 link **changes every time ChemFoam restarts** — run `status-chemfoam.cmd` (or press **Ctrl+Alt+Shift+L**) to get the current one.
- 😴 Keep the PC **awake**: *Settings → System → Power → Screen and sleep → "Never"* while plugged in.

---

## 7. Using it: touch, mouse & keyboard

| Action | On a phone / tablet | On a computer |
|---|---|---|
| Move the pointer | Touch and move | Move the mouse |
| Click / double-click | Tap / double-tap | Click / double-click |
| Right-click | — | Right-click |
| Drag / select text | Touch, hold and move | Click and drag |
| Scroll | Two-finger swipe | Mouse wheel / trackpad |
| Type | Tap the screen — the keyboard appears | Just type |

**Viewing from a Mac?** The **⌘ Command** key acts as **Ctrl** on Windows, so ⌘C / ⌘V / ⌘Z copy, paste and undo just like on your Mac. (To make ⌘ act as the Windows key instead, see [Advanced options](#12-advanced-options).)

**See live performance:** add `&stats=1` to the end of any link.

ChemFoam only captures the screen while a viewer is connected, and stops a few seconds after everyone leaves.

---

## 8. Everyday commands

Double-click these files in the ChemFoam folder (or run them from a terminal with `.\name.cmd`):

| What you want | File |
|---|---|
| Start ChemFoam (runs in the background) | `start-chemfoam.cmd` |
| Stop ChemFoam | `stop-chemfoam.cmd` |
| Is it running? Show my links | `status-chemfoam.cmd` |
| Run with a live log (close / Ctrl+C to stop) | `run-chemfoam.cmd` |

---

## 9. Optional: keyboard shortcuts (Ctrl+Alt+Shift+R / S / L)

Control ChemFoam from anywhere on your PC. Install once by double-clicking **`install-shortcuts.cmd`**. The shortcuts start automatically when you sign in.

| Shortcut | What it does |
|---|---|
| **Ctrl + Alt + Shift + R** | **Start** ChemFoam. When the link is live it's **copied to your clipboard** and a notification appears. If ChemFoam is already running, it just copies the current link (the link doesn't change). |
| **Ctrl + Alt + Shift + S** | **Stop** ChemFoam |
| **Ctrl + Alt + Shift + L** | **Copy** the current link to the clipboard |

To remove them: double-click **`uninstall-shortcuts.cmd`**.

---

## 10. Security — please read

- 🔑 **The access key is the only thing protecting your PC.** Anyone with a full link can see and control your screen. Share links only with people you trust, through private channels.
- ♻️ **Change the key** at any time (all old links stop working): delete the file **`.chemfoam-token`** in the ChemFoam folder, then run `start-chemfoam.cmd`.
- 🗂️ `.chemfoam-token` and `.chemfoam-tls\` are private and excluded from git by `.gitignore`. **Never commit or share them.**
- 🛑 **Stop ChemFoam when you don't need it** (`stop-chemfoam.cmd` or Ctrl+Alt+Shift+S).
- 🛡️ Programs running **as Administrator** (and the UAC prompt itself) can't be controlled by a normal app — that's a Windows security rule. If you need that, right-click `start-chemfoam.cmd` → **Run as administrator**.

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| **"Missing required tools"** | Install what it lists (section 2), then **open a new terminal** and try again. |
| **Windows protected your PC / scripts blocked** | You extracted a ZIP without unblocking it. Delete the folder, right-click the ZIP → **Properties → Unblock**, extract again — or use `git clone`. |
| **"Access key required"** | The `?k=…` part is missing. Copy the full link again from `status-chemfoam.cmd`. |
| **Cloudflare "Error 1033"** / **"site can't be reached"** | The link is **brand new** (wait 1–2 minutes) or **old** (ChemFoam restarted, so the 🌍 link changed — get the current one with `status-chemfoam.cmd` or Ctrl+Alt+Shift+L). |
| **Other devices on my Wi-Fi can't connect** | Allow Node.js through Windows Firewall (section 5). Make sure the network is set to **Private** (*Settings → Network & internet → Wi-Fi → your network*). |
| **Black screen / "The computer is offline"** | Check `%TEMP%\chemfoam\host.log`. If it says no encoder works, update your graphics driver, and make sure FFmpeg came from `winget install Gyan.FFmpeg` (it includes the needed `ddagrab` capture). |
| **Can't click on some windows** | They're running as Administrator — see Security above. |
| **Laggy or blurry** | Add `&stats=1` to the link. On the same Wi-Fi, use the `https://…:3443` link. Quality adapts automatically on slow networks. |
| **Something else** | Logs are in `%TEMP%\chemfoam\` (`server.log`, `host.log`, `tunnel.log`). Paste `%TEMP%\chemfoam` into File Explorer's address bar to open the folder. |

---

## 12. Advanced options

**Link options** — add to the end of any link:

| Option | Effect |
|---|---|
| `&stats=1` | Show the live performance overlay |
| `&transport=webrtc` / `&transport=ws` | Force peer-to-peer UDP / WebSocket streaming |
| `&simulate=remote` | Test on the same Wi-Fi as if you were on a different network |

**Environment variables** — set before starting, e.g. in PowerShell: `$env:CHEMFOAM_FPS = 30; .\start-chemfoam.cmd`

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HTTPS_PORT` | `3000` / `3443` | Ports used |
| `CHEMFOAM_ENCODER` | auto | Force an encoder: `nvenc`, `qsv`, `amf`, `mf`, `x264`, `x264-gdigrab` |
| `CHEMFOAM_FPS` | `60` | Frames per second |
| `CHEMFOAM_MAX_WIDTH` | `1920` | Downscale wider screens (CPU / Media Foundation encoders) |
| `CHEMFOAM_META_AS` | `ctrl` | What a Mac viewer's ⌘ key becomes: `ctrl` or `win` |
| `CHEMFOAM_TUNNEL` | `1` | `0` disables the internet (Cloudflare) link |
| `CHEMFOAM_STUN` | Google + Cloudflare | STUN servers for peer-to-peer (comma-separated) |

The detected encoder is remembered in `%TEMP%\chemfoam\encoder.txt` — delete it to detect again (e.g. after changing graphics cards).

---

## 13. How it works

```
Screen ─► FFmpeg (ddagrab + GPU H.264) ─FLV─► host.js ─► ChemFoam server ─┬─► WebSocket ─► browser (WebCodecs)
                                                                         └─► WebRTC / UDP ─► browser (<video>)
Keyboard & mouse ◄── SendInput (input-helper.ps1) ◄── host.js ◄────────────── viewer's taps, clicks & keys
```

1. **Capture** — FFmpeg's `ddagrab` uses the Windows Desktop Duplication API (GPU, no yellow border), only while a viewer is connected.
2. **Encode** — the fastest available H.264 encoder is chosen automatically: **NVIDIA NVENC → Intel QuickSync → AMD AMF → Windows Media Foundation → x264 (CPU)**, all in low-latency mode with no B-frames and a keyframe every second.
3. **Frame** — FFmpeg writes FLV, where every packet is exactly one frame, so `host.js` forwards each frame the instant it's encoded.
4. **Deliver** — the same server as the Mac edition: WebSocket + WebCodecs on the LAN, WebRTC over UDP across the internet, automatic fallback, adaptive bitrate.
5. **Cursor** — drawn instantly by the viewer; the PC's real cursor position is streamed 120 times per second.
6. **Input** — `input-helper.ps1` (a small C# class compiled by the PowerShell built into Windows) injects mouse and keyboard events with `SendInput`; text is sent as Unicode, so any language and emoji work.

**Project layout**

```
chemfoam-windows/
├── start-chemfoam.cmd / stop-chemfoam.cmd / status-chemfoam.cmd / run-chemfoam.cmd
├── install-shortcuts.cmd / uninstall-shortcuts.cmd
├── scripts/            ← PowerShell scripts behind the .cmd files
├── host/
│   ├── host.js         ← capture, encoder detection, input translation
│   ├── flv.js          ← FFmpeg FLV → H.264 frames
│   ├── keymap.js       ← browser keys → Windows virtual keys
│   └── input-helper.ps1← SendInput mouse / keyboard injection
└── server/src/         ← relay server, browser viewer page, WebRTC
```

---

## 14. Uninstall

1. Double-click `stop-chemfoam.cmd`, and `uninstall-shortcuts.cmd` if you installed the shortcuts.
2. Delete the ChemFoam folder.
3. Optionally: `winget uninstall Gyan.FFmpeg Cloudflare.cloudflared OpenJS.NodeJS.LTS`, and remove Node.js from *Allow an app through firewall*.
