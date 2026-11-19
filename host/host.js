// ChemFoam host for Windows.
//
//   screen ──► ffmpeg (ddagrab + hardware H.264) ──FLV──► this process ──WebSocket──► ChemFoam server ──► viewers
//   viewers ──► server ──► this process ──► input-helper.ps1 (Win32 SendInput)
//
// Capture runs only while a viewer is connected. The fastest H.264 encoder available on this PC is
// detected automatically: NVIDIA NVENC → Intel QuickSync → AMD AMF → Windows Media Foundation →
// software x264.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlvH264Demuxer } from './flv.js';
import { resolveKey, isModifierCode } from './keymap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', 'server', 'package.json'));
const WebSocket = require('ws');

const IS_WINDOWS = process.platform === 'win32';
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.CHEMFOAM_TOKEN || '';
const FFMPEG = process.env.CHEMFOAM_FFMPEG || 'ffmpeg';
const FPS = Math.max(15, Math.min(120, parseInt(process.env.CHEMFOAM_FPS || '60', 10)));
const MAX_WIDTH = parseInt(process.env.CHEMFOAM_MAX_WIDTH || '1920', 10);   // software encoders only
const META_AS = (process.env.CHEMFOAM_META_AS || 'ctrl').toLowerCase();  // Mac ⌘ → 'ctrl' or 'win'
const FORCED_ENCODER = process.env.CHEMFOAM_ENCODER || '';                  // e.g. nvenc, qsv, amf, mf, x264
const TEST_INPUT = process.env.CHEMFOAM_TEST_INPUT || '';                   // testing on non-Windows: ffmpeg input args
const STATE_DIR = process.env.CHEMFOAM_STATE_DIR || path.join(os.tmpdir(), 'chemfoam');
fs.mkdirSync(STATE_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

console.log(`
-----------------------------------------------------------
     ChemFoam — Windows Host
-----------------------------------------------------------`);

// ---------------------------------------------------------------------------
// Connection to the ChemFoam server
// ---------------------------------------------------------------------------
let ws = null;
let connected = false;

function send(obj) {
  if (connected && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const url = `ws://127.0.0.1:${PORT}/?k=${encodeURIComponent(TOKEN)}`;
  ws = new WebSocket(url, { perMessageDeflate: false });
  ws.on('open', () => {
    connected = true;
    ws._socket.setNoDelay(true);
    log('🟢 [Signaling] Connected to server');
    send({ type: 'register_host' });
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    handleServerMessage(msg);
  });
  ws.on('close', () => {
    if (connected) log('🔴 [Signaling] Disconnected. Reconnecting in 2s...');
    connected = false;
    setVideoDemand(false);
    setTimeout(connect, 2000);
  });
  ws.on('error', () => {});
}

let lastBitrateTarget = 6_000_000;

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'streams':
      setVideoDemand(!!(msg.h264 || msg.jpeg));
      break;
    case 'bitrate':
      if (typeof msg.bps === 'number') onBitrate(msg.bps);
      break;
    case 'keyframe':
      // ffmpeg can't be asked for a keyframe at runtime; a 1-second keyframe interval keeps
      // new / recovering viewers waiting at most ~1 s.
      break;
    case 'clock_ping':
      send({ ...msg, type: 'clock_pong', h: Date.now() });
      break;
    case 'remote_input':
      if (msg.input) handleInput(msg.input);
      break;
  }
}

// ---------------------------------------------------------------------------
// Video: ffmpeg capture + encode
// ---------------------------------------------------------------------------
let wantVideo = false;
let idleTimer = null;
let ffmpeg = null;
let ffmpegStartedAt = 0;
let ffmpegFailures = 0;
let currentBitrate = 6_000_000;
let encoder = null;            // chosen candidate
let screenSize = { w: 1920, h: 1080 };
let framesSent = 0;
let bytesSent = 0;
let dropUntilKeyframe = false;

function scaleFilter() {
  return screenSize.w > MAX_WIDTH ? `,scale=${MAX_WIDTH}:-2` : '';
}

function encoderCandidates() {
  const G = String(FPS);                            // keyframe every second
  const fps = String(FPS);
  const dda = (suffix) => ['-filter_complex', `ddagrab=output_idx=0:framerate=${fps}:draw_mouse=0${suffix}`];
  const rate = (bps) => {
    const b = String(Math.round(bps));
    return ['-b:v', b, '-maxrate', b, '-bufsize', String(Math.round(bps / 2))];
  };
  const x264 = (bps) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    ...rate(bps), '-g', G, '-bf', '0', '-x264-params', 'repeat-headers=1'];

  if (!IS_WINDOWS || TEST_INPUT) {
    // Testing mode (e.g. on a Mac): synthetic input from CHEMFOAM_TEST_INPUT, software encoder
    const input = (TEST_INPUT || `-re -f lavfi -i testsrc2=size=1280x720:rate=${fps}`).split(/\s+/).filter(Boolean);
    return [{ name: 'x264-test', args: (bps) => [...input, ...x264(bps)] }];
  }

  return [
    { name: 'nvenc', args: (bps) => [...dda(''), '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1',
      '-delay', '0', '-rc', 'cbr', ...rate(bps), '-g', G, '-bf', '0', '-forced-idr', '1', '-profile:v', 'high'] },
    { name: 'qsv', args: (bps) => [...dda(',hwmap=derive_device=qsv,format=qsv'), '-c:v', 'h264_qsv', '-preset', 'veryfast',
      '-async_depth', '1', ...rate(bps), '-g', G, '-bf', '0', '-profile:v', 'high'] },
    { name: 'amf', args: (bps) => [...dda(''), '-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed',
      '-rc', 'cbr', ...rate(bps), '-g', G, '-bf', '0'] },
    { name: 'mf', args: (bps) => [...dda(`,hwdownload,format=bgra${scaleFilter()},format=nv12`), '-c:v', 'h264_mf',
      '-hw_encoding', '1', '-scenario', 'display_remoting', '-rate_control', 'cbr', ...rate(bps), '-g', G, '-bf', '0'] },
    { name: 'x264', args: (bps) => [...dda(`,hwdownload,format=bgra${scaleFilter()}`), ...x264(bps)] },
    // Last resort for very old ffmpeg builds without ddagrab, or Remote Desktop sessions
    { name: 'x264-gdigrab', args: (bps) => ['-f', 'gdigrab', '-framerate', fps, '-draw_mouse', '0', '-i', 'desktop',
      ...(scaleFilter() ? ['-vf', scaleFilter().slice(1)] : []), ...x264(bps)] }
  ];
}

const COMMON_OUT = ['-an', '-flush_packets', '1', '-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1'];

function runProbe(candidate) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...candidate.args(4_000_000), '-frames:v', '5', '-f', 'null', '-'];
    let stderr = '';
    let done = false;
    const p = spawn(FFMPEG, args, { windowsHide: true });
    const timer = setTimeout(() => { if (!done) { done = true; p.kill(); resolve({ ok: false, error: 'timed out' }); } }, 10000);
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); } });
    p.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, error: stderr.trim().split('\n').slice(-2).join(' | ') });
    });
  });
}

const ENCODER_CACHE = path.join(STATE_DIR, 'encoder.txt');
let probing = null;

async function chooseEncoder(force = false) {
  if (encoder && !force) return encoder;
  if (probing) return probing;
  probing = (async () => {
    let candidates = encoderCandidates();
    if (FORCED_ENCODER) candidates = candidates.filter((c) => c.name === FORCED_ENCODER);
    let cached = '';
    try { cached = fs.readFileSync(ENCODER_CACHE, 'utf8').trim(); } catch (_) {}
    if (!force && cached) candidates.sort((a, b) => (b.name === cached) - (a.name === cached));
    for (const c of candidates) {
      const result = await runProbe(c);
      if (result.ok) {
        log(`🎞️  [Encoder] Using ${c.name}`);
        try { fs.writeFileSync(ENCODER_CACHE, c.name); } catch (_) {}
        encoder = c;
        probing = null;
        return c;
      }
      log(`   [Encoder] ${c.name} not available (${result.error || 'failed'})`);
    }
    probing = null;
    throw new Error('No working H.264 encoder / screen capture found. Is ffmpeg installed (winget install Gyan.FFmpeg)?');
  })();
  return probing;
}

async function startVideo() {
  if (ffmpeg || !wantVideo) return;
  let chosen;
  try {
    chosen = await chooseEncoder();
  } catch (e) {
    log(`❌ [Capture] ${e.message}`);
    return;
  }
  if (ffmpeg || !wantVideo) return;

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...chosen.args(currentBitrate), ...COMMON_OUT];
  const demux = new FlvH264Demuxer(onFrame);
  ffmpegStartedAt = Date.now();
  dropUntilKeyframe = false;
  const proc = ffmpeg = spawn(FFMPEG, args, { windowsHide: true });
  log(`[Capture] Screen capture started (${chosen.name}, ${(currentBitrate / 1e6).toFixed(1)} Mbps, ${FPS} fps)`);

  proc.stdout.on('data', (chunk) => {
    try { demux.push(chunk); } catch (e) { log(`[Capture] Stream error: ${e.message}`); proc.kill(); }
  });
  let errTail = '';
  proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-600); });
  proc.on('error', (e) => log(`❌ [Capture] Could not run ffmpeg: ${e.message}`));
  proc.on('exit', (code) => {
    if (ffmpeg === proc) ffmpeg = null;
    if (!wantVideo || proc._intentional) return;
    const ranFor = Date.now() - ffmpegStartedAt;
    ffmpegFailures = ranFor < 3000 ? ffmpegFailures + 1 : 0;
    log(`[Capture] ffmpeg stopped (code ${code})${errTail ? ': ' + errTail.trim().split('\n').pop() : ''}`);
    if (ffmpegFailures >= 3) {
      // The cached encoder no longer works (driver change, unplugged GPU, …): detect again
      log('[Capture] Re-detecting encoder...');
      encoder = null;
      try { fs.unlinkSync(ENCODER_CACHE); } catch (_) {}
      ffmpegFailures = 0;
    }
    // e.g. the desktop switched (UAC prompt, lock screen): try again shortly
    setTimeout(startVideo, Math.min(5000, 1000 * Math.max(1, ffmpegFailures)));
  });
}

function stopVideo() {
  if (!ffmpeg) return;
  ffmpeg._intentional = true;
  ffmpeg.kill();
  ffmpeg = null;
  log('[Capture] Screen capture stopped');
}

function restartVideo() {
  if (!ffmpeg) return;
  stopVideo();
  setTimeout(startVideo, 100);
}

function setVideoDemand(needed) {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (needed === wantVideo) {
    if (needed) startVideo();
    return;
  }
  if (needed) {
    wantVideo = true;
    log('[Signaling] Viewer connected — starting capture');
    startVideo();
  } else {
    // Short grace period so a quick page reload doesn't restart the encoder
    idleTimer = setTimeout(() => {
      wantVideo = false;
      stopVideo();
      releaseAllInput();
    }, 5000);
  }
}

let lastBitrateRestart = 0;
function onBitrate(bps) {
  lastBitrateTarget = bps;
  if (!ffmpeg) {
    currentBitrate = bps;
    return;
  }
  // ffmpeg can't change bitrate live; restart only for big changes, at most every 10 s
  const change = Math.abs(bps - currentBitrate) / currentBitrate;
  if (change > 0.35 && Date.now() - lastBitrateRestart > 10000) {
    lastBitrateRestart = Date.now();
    currentBitrate = bps;
    log(`📶 [Capture] Bitrate → ${(bps / 1e6).toFixed(1)} Mbps`);
    restartVideo();
  }
}

function onFrame(annexB, isKey) {
  if (!connected || ws.readyState !== WebSocket.OPEN) return;
  // Local loopback should never back up, but never let a queue build latency
  if (ws.bufferedAmount > 8 * 1024 * 1024) dropUntilKeyframe = true;
  if (dropUntilKeyframe) {
    if (!isKey) return;
    dropUntilKeyframe = false;
  }
  const msg = Buffer.allocUnsafe(9 + annexB.length);
  msg[0] = isKey ? 1 : 2;
  msg.writeBigUInt64BE(BigInt(Date.now()) * 1000n, 1);
  annexB.copy(msg, 9);
  ws.send(msg, { binary: true });
  framesSent++;
  bytesSent += msg.length;
  if (framesSent % 600 === 0) {
    log(`📡 [Host] Streamed ${framesSent} frames (avg ${Math.round(bytesSent / 600 / 1024)} KB/frame)`);
    bytesSent = 0;
  }
}

// ---------------------------------------------------------------------------
// Input: input-helper.ps1 (Win32 SendInput)
// ---------------------------------------------------------------------------
let helper = null;
let helperBuffer = '';

function startHelper() {
  if (!IS_WINDOWS) {
    // Testing on a non-Windows machine: log what would be injected
    helper = { stdin: { write: (line) => process.env.CHEMFOAM_LOG_INPUT && log('[Input]', line.trim()) }, stub: true };
    return;
  }
  const script = path.join(HERE, 'input-helper.ps1');
  const p = helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (chunk) => {
    helperBuffer += chunk;
    let i;
    while ((i = helperBuffer.indexOf('\n')) >= 0) {
      const line = helperBuffer.slice(0, i).trim();
      helperBuffer = helperBuffer.slice(i + 1);
      onHelperLine(line);
    }
  });
  p.stderr.on('data', (d) => log('[Input] helper error:', d.toString().trim().slice(0, 300)));
  p.on('exit', (code) => {
    if (helper === p) helper = null;
    log(`[Input] helper exited (code ${code}); restarting in 2s`);
    setTimeout(startHelper, 2000);
  });
  p.on('error', (e) => log('[Input] could not start helper:', e.message));
}

let lastCursorSent = 0;
function onHelperLine(line) {
  const parts = line.split(' ');
  if (parts[0] === 'READY') {
    screenSize = { w: parseInt(parts[1], 10) || 1920, h: parseInt(parts[2], 10) || 1080 };
    log(`[Input] Ready — screen ${screenSize.w}x${screenSize.h}`);
  } else if (parts[0] === 'C') {
    if (!wantVideo) return;
    send({ type: 'cursor', x: parseFloat(parts[1]), y: parseFloat(parts[2]) });
    lastCursorSent = Date.now();
  } else if (parts[0] === 'E') {
    log('[Input] helper:', line.slice(2));
  }
}

function toHelper(line) {
  if (helper && helper.stdin && !helper.stdin.destroyed) helper.stdin.write(line + '\n');
}

const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)).toFixed(5) : null);
const pressedKeys = new Map();      // code → { vk, extended }
const pressedButtons = new Set();
let wheelY = 0;
let wheelX = 0;

function handleInput(input) {
  switch (input.type) {
    case 'mouse_move': {
      const x = num(input.x), y = num(input.y);
      if (x !== null && y !== null) toHelper(`M ${x} ${y}`);
      break;
    }
    case 'mouse_down':
    case 'mouse_up': {
      const down = input.type === 'mouse_down';
      const button = [0, 1, 2].includes(input.button) ? input.button : 0;
      const x = num(input.x), y = num(input.y);
      toHelper(`B ${button} ${down ? 1 : 0}${x !== null && y !== null ? ` ${x} ${y}` : ''}`);
      if (down) pressedButtons.add(button); else pressedButtons.delete(button);
      break;
    }
    case 'mouse_click': {
      const button = [0, 1, 2].includes(input.button) ? input.button : 0;
      const x = num(input.x), y = num(input.y);
      const pos = x !== null && y !== null ? ` ${x} ${y}` : '';
      toHelper(`B ${button} 1${pos}`);
      toHelper(`B ${button} 0${pos}`);
      break;
    }
    case 'wheel': {
      // Browser pixels → Windows wheel units (120 per notch ≈ 100 px); keep the remainder
      wheelY += -(Number(input.deltaY) || 0) * 1.2;
      wheelX += (Number(input.deltaX) || 0) * 1.2;
      const dy = Math.trunc(wheelY), dx = Math.trunc(wheelX);
      wheelY -= dy;
      wheelX -= dx;
      if (dy || dx) toHelper(`W ${dy} ${dx}`);
      break;
    }
    case 'key_down':
    case 'key_up':
      handleKey(input, input.type === 'key_down');
      break;
    case 'text_input':
      if (typeof input.text === 'string' && input.text) {
        toHelper(`T ${Buffer.from(input.text, 'utf8').toString('base64')}`);
      }
      break;
  }
}

function handleKey(input, down) {
  const { code = '', key = '' } = input;
  const mods = input.modifiers || {};

  if (!down) {
    const pressed = pressedKeys.get(code || key);
    if (pressed) {
      toHelper(`K ${pressed.vk} 0 ${pressed.extended ? 1 : 0}`);
      pressedKeys.delete(code || key);
    }
    return;
  }

  // Plain printable characters are typed as Unicode: correct for any keyboard layout or language.
  // Shortcuts (Ctrl / ⌘ / Alt held) are sent as real keys so Ctrl+C, Alt+Tab, … work.
  const printable = [...key].length === 1 && code !== 'Space';
  if (printable &&!mods.ctrl && !mods.meta && !mods.alt && !isModifierCode(code)) {
    toHelper(`T ${Buffer.from(key, 'utf8').toString('base64')}`);
    return;
  }

  const resolved = resolveKey(code, key, META_AS);
  if (!resolved) {
    if ([...key].length === 1) toHelper(`T ${Buffer.from(key, 'utf8').toString('base64')}`);
    return;
  }
  toHelper(`K ${resolved.vk} 1 ${resolved.extended ? 1 : 0}`);
  pressedKeys.set(code || key, resolved);
}

// Never leave keys or buttons stuck down when the viewer goes away
function releaseAllInput() {
  for (const [, k] of pressedKeys) toHelper(`K ${k.vk} 0 ${k.extended ? 1 : 0}`);
  pressedKeys.clear();
  for (const b of pressedButtons) toHelper(`B ${b} 0`);
  pressedButtons.clear();
}

// ---------------------------------------------------------------------------
startHelper();
connect();
// Detect the encoder in the background so the first viewer gets a picture quickly
setTimeout(() => chooseEncoder().catch((e) => log(`❌ [Encoder] ${e.message}`)), 1500);

process.on('SIGINT', () => { stopVideo(); process.exit(0); });
process.on('SIGTERM', () => { stopVideo(); process.exit(0); });
