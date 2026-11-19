import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RtcSession, packetizeFrame } from './webrtc.js';

const PORT = process.env.PORT || 3000;
// HTTPS port for LAN viewers: browsers only allow hardware video decoding (WebCodecs) on secure pages
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const TLS_CERT = process.env.CHEMFOAM_TLS_CERT;
const TLS_KEY = process.env.CHEMFOAM_TLS_KEY;
// Access key. Anyone with it can control this Mac, so every page load and WebSocket must present it.
const TOKEN = process.env.CHEMFOAM_TOKEN || '';

// ---------------------------------------------------------------------------
// Web client
// ---------------------------------------------------------------------------
const CLIENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>ChemFoam</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    #rtc {
      position: absolute;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      height: 100dvh;
      object-fit: contain;
      background: #000;
      display: none;
      z-index: 0;
      pointer-events: none;
    }
    #screen {
      z-index: 1;
      position: absolute;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      height: 100dvh;
      object-fit: contain;
      cursor: none;
    }
    #cursor {
      position: absolute;
      left: 0;
      top: 0;
      width: 20px;
      height: 28px;
      pointer-events: none;
      display: none;
      will-change: transform;
      z-index: 2;
      filter: drop-shadow(0 1px 1px rgba(0,0,0,.5));
    }
    #status {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: #aaa;
      font: 15px -apple-system, BlinkMacSystemFont, sans-serif;
      pointer-events: none;
      text-align: center;
      padding: 0 16px;
    }
    #stats {
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 3;
      background: rgba(0,0,0,.7);
      color: #4f4;
      font: 12px/1.4 ui-monospace, Menlo, monospace;
      padding: 6px 8px;
      border-radius: 6px;
      pointer-events: none;
      white-space: pre;
      display: none;
    }
    #mobile-input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      top: -100px;
      left: -100px;
    }
  </style>
</head>
<body>
  <video id="rtc" autoplay playsinline muted disablepictureinpicture></video>
  <canvas id="screen"></canvas>
  <svg id="cursor" viewBox="0 0 20 28" xmlns="http://www.w3.org/2000/svg">
    <path d="M1.5 1.5 L1.5 22.5 L6.5 17.8 L10 26 L13.6 24.4 L10.2 16.5 L17 16.5 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>
  <div id="status">Connecting…</div>
  <div id="stats"></div>
  <input type="text" id="mobile-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />

  <script>
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const cursorEl = document.getElementById('cursor');
    const statusEl = document.getElementById('status');
    const mobileInput = document.getElementById('mobile-input');
    const accessKey = new URLSearchParams(location.search).get('k') || '';
    let ws = null;
    let gotFirstFrame = false;

    // ------------------------------------------------------------------
    // Video: H.264 via WebCodecs (hardware decode), JPEG fallback
    // ------------------------------------------------------------------
    let useH264 = false;
    let decoder = null;
    let decoderCodec = null;
    let waitingForKeyframe = true;
    let pendingFrame = null;     // latest decoded VideoFrame / ImageBitmap, drawn on next animation frame
    let drawScheduled = false;
    let jpegDecoding = false;
    let lastKeyframeRequest = 0;
    // Lightweight stats (inspect window.chemFoamStats in DevTools)
    const stats = window.chemFoamStats = { codec: null, framesDrawn: 0, decoderErrors: 0, keyframeRequests: 0, cursorUpdates: 0,
      latencyMs: null, decodeMs: null, rttMs: null, fps: 0, mbps: 0 };
    let clockOffset = null;          // host wall clock − local wall clock (ms)
    let bestRtt = Infinity;
    let latencySamples = [];
    let decodeSamples = [];
    const decodeStart = new Map();   // chunk timestamp → performance.now() at decode()
    let lastJpegTimestamp = 0;
    let bytesWindow = 0, framesWindow = 0;

    async function detectH264() {
      if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) return false;
      try {
        const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.640028', optimizeForLatency: true });
        return !!r.supported;
      } catch (_) { return false; }
    }

    function requestKeyframe() {
      const now = performance.now();
      if (now - lastKeyframeRequest < 300) return;
      lastKeyframeRequest = now;
      stats.keyframeRequests++;
      sendRaw({ type: 'request_keyframe' });
    }

    function hex2(n) { return n.toString(16).padStart(2, '0'); }

    // Build the 'avc1.PPCCLL' codec string from the SPS inside an Annex B keyframe
    function codecFromAnnexB(u8) {
      for (let i = 0; i + 4 < u8.length; i++) {
        if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
          if ((u8[i + 3] & 0x1f) === 7) {
            return 'avc1.' + hex2(u8[i + 4]) + hex2(u8[i + 5]) + hex2(u8[i + 6]);
          }
          i += 2;
        }
      }
      return null;
    }

    // Draw as soon as a frame is decoded (low-latency 'desynchronized' canvas, no extra vsync wait)
    function scheduleDraw(frame) {
      if (pendingFrame) pendingFrame.close();
      pendingFrame = frame;
      draw();
    }

    function draw() {
      drawScheduled = false;
      const frame = pendingFrame;
      pendingFrame = null;
      if (!frame) return;
      const w = frame.displayWidth || frame.width;
      const h = frame.displayHeight || frame.height;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        updateCursorElement();
      }
      ctx.drawImage(frame, 0, 0);
      const ts = frame.timestamp !== undefined ? frame.timestamp : lastJpegTimestamp;
      if (frame.timestamp !== undefined && decodeStart.has(ts)) {
        decodeSamples.push(performance.now() - decodeStart.get(ts));
        decodeStart.delete(ts);
      }
      frame.close();
      stats.framesDrawn++;
      framesWindow++;
      if (clockOffset !== null && ts) {
        // capture on the Mac → drawn here, using the synced clock
        latencySamples.push(Date.now() + clockOffset - ts / 1000);
      }
      if (!gotFirstFrame) {
        gotFirstFrame = true;
        statusEl.style.display = 'none';
      }
    }

    function createDecoder(codec) {
      if (decoder && decoder.state !== 'closed') {
        try { decoder.close(); } catch (_) {}
      }
      decoderCodec = codec;
      decoder = new VideoDecoder({
        output: scheduleDraw,
        error: (e) => {
          console.warn('Decoder error', e);
          stats.decoderErrors++;
          decoder = null;
          waitingForKeyframe = true;
          requestKeyframe();
        }
      });
      decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    }

    function handleH264(buf, isKey) {
      const data = new Uint8Array(buf, 9);
      const timestamp = Number(new DataView(buf).getBigUint64(1));

      if (isKey) {
        const codec = codecFromAnnexB(data) || 'avc1.640028';
        if (!decoder || decoder.state === 'closed' || codec !== decoderCodec) {
          try {
            createDecoder(codec);
          } catch (e) {
            console.warn('H.264 not usable, falling back to JPEG', e);
            useH264 = false;
            sendHello();
            return;
          }
        }
      }
      if (!decoder || decoder.state !== 'configured') return;

      if (waitingForKeyframe) {
        if (!isKey) { requestKeyframe(); return; }
        waitingForKeyframe = false;
      }

      // If the decoder falls behind, skip ahead to the next keyframe instead of building up lag
      if (!isKey && decoder.decodeQueueSize > 4) {
        waitingForKeyframe = true;
        requestKeyframe();
        return;
      }

      try {
        decodeStart.set(timestamp, performance.now());
        if (decodeStart.size > 60) decodeStart.delete(decodeStart.keys().next().value);
        decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data }));
      } catch (e) {
        waitingForKeyframe = true;
        requestKeyframe();
      }
    }

    function handleJpeg(buf) {
      if (jpegDecoding) return;  // still decoding the previous one: drop this frame
      jpegDecoding = true;
      lastJpegTimestamp = Number(new DataView(buf).getBigUint64(1));
      const blob = new Blob([new Uint8Array(buf, 9)], { type: 'image/jpeg' });
      createImageBitmap(blob)
        .then((bitmap) => { scheduleDraw(bitmap); })
        .catch(() => {})
        .finally(() => { jpegDecoding = false; });
    }

    // ------------------------------------------------------------------
    // Connection
    // ------------------------------------------------------------------
    function sendRaw(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    function sendHello() {
      stats.codec = useH264 ? 'h264' : 'jpeg';
      sendRaw({ type: 'hello', codecs: useH264 ? ['h264', 'jpeg'] : ['jpeg'] });
    }

    // ------------------------------------------------------------------
    // WebRTC (UDP, peer-to-peer) transport — used for remote / lossy networks, and for
    // browsers that can't hardware-decode over WebSocket (plain-http pages). Falls back to
    // the WebSocket stream automatically if no UDP path can be established.
    // ?transport=ws | webrtc | auto (default)
    // ------------------------------------------------------------------
    const rtcVideo = document.getElementById('rtc');
    const transportPref = (new URLSearchParams(location.search).get('transport') || 'auto').toLowerCase();
    const isLanHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|[^.]+\.local$)/.test(location.hostname);
    let rtc = null;
    let rtcChannel = null;
    let rtcActive = false;
    let rtcTried = false;
    let rtcTimer = null;
    let rtcRoute = null;
    let rtcFrames = 0;
    // Testing aid: ?simulate=remote forbids direct LAN (host) ICE candidates, so a viewer on the
    // same Wi-Fi must connect exactly like one on a different network would.
    const simulateRemote = new URLSearchParams(location.search).get('simulate') === 'remote';
    const stripHost = (sdp) => sdp.split('\\r\\n').filter((l) => !(l.startsWith('a=candidate') && / typ host/.test(l))).join('\\r\\n');

    function shouldUseWebRTC() {
      if (!('RTCPeerConnection' in window)) return false;
      if (transportPref === 'ws') return false;
      if (transportPref === 'webrtc') return true;
      // On the LAN, the WebSocket + WebCodecs path is the lowest latency. Over the internet (tunnel)
      // or when WebCodecs isn't available, UDP is smoother and faster.
      return !isLanHost || !useH264;
    }

    function stopRtc() {
      clearTimeout(rtcTimer);
      if (rtc) { try { rtc.close(); } catch (_) {} }
      rtc = null;
      rtcChannel = null;
      rtcActive = false;
      rtcVideo.srcObject = null;
      rtcVideo.style.display = 'none';
      canvas.style.opacity = '';
    }

    function rtcFailed(reason) {
      const wasTrying = !!rtc;
      stopRtc();
      stats.transport = 'WebSocket';
      if (wasTrying) {
        sendRaw({ type: 'rtc_failed', reason });
        waitingForKeyframe = true;
        requestKeyframe();
      }
    }

    function onRtcFrame() {
      rtcFrames++;
      framesWindow++;
      if (!rtcActive) {
        rtcActive = true;
        clearTimeout(rtcTimer);
        rtcVideo.style.display = 'block';
        canvas.style.opacity = '0';           // canvas stays on top only to receive input
        stats.transport = 'WebRTC (UDP)';
        stats.codec = 'h264';
        updateRtcRoute().then(() => sendRaw({ type: 'rtc_active', route: rtcRoute }));
        if (!gotFirstFrame) {
          gotFirstFrame = true;
          statusEl.style.display = 'none';
        }
        updateCursorElement();
      }
      if (rtcVideo.requestVideoFrameCallback && rtc) rtcVideo.requestVideoFrameCallback(onRtcFrame);
    }

    async function updateRtcRoute() {
      if (!rtc) return;
      try {
        const report = await rtc.getStats();
        let pair = null;
        report.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pair = report.get(r.selectedCandidatePairId);
        });
        if (!pair) report.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
        if (!pair) return;
        const local = report.get(pair.localCandidateId);
        const remote = report.get(pair.remoteCandidateId);
        const types = [local && local.candidateType, remote && remote.candidateType];
        rtcRoute = types.includes('relay') ? 'relayed' : types.every((t) => t === 'host') ? 'direct LAN' : 'direct peer-to-peer (internet)';
        if (pair.currentRoundTripTime !== undefined) stats.rttMs = Math.round(pair.currentRoundTripTime * 1000);
        report.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            if (r.jitterBufferEmittedCount) stats.jitterMs = Math.round(1000 * r.jitterBufferDelay / r.jitterBufferEmittedCount);
            if (r.framesDecoded) stats.decodeMs = +(1000 * r.totalDecodeTime / r.framesDecoded).toFixed(1);
            stats.packetsLost = r.packetsLost;
            if (stats._lastBytes !== undefined) stats.mbps = +(((r.bytesReceived - stats._lastBytes) * 8) / 0.5 / 1e6).toFixed(2);
            stats._lastBytes = r.bytesReceived;
          }
        });
      } catch (_) {}
    }

    async function onRtcOffer(msg) {
      stopRtc();
      const iceServers = (msg.iceServers || []).map((urls) => ({ urls }));
      const pc = rtc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

      pc.ontrack = (e) => {
        // Ask the browser to play frames immediately instead of buffering for smoothness
        try { e.receiver.jitterBufferTarget = 0; } catch (_) {}
        try { e.receiver.playoutDelayHint = 0; } catch (_) {}
        rtcVideo.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]);
        rtcVideo.play().catch(() => {});
        if (rtcVideo.requestVideoFrameCallback) rtcVideo.requestVideoFrameCallback(onRtcFrame);
        else rtcVideo.addEventListener('playing', onRtcFrame, { once: true });
      };
      pc.ondatachannel = (e) => {
        rtcChannel = e.channel;
        rtcChannel.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m.type === 'cursor') onRemoteCursor(m.x, m.y);
          } catch (_) {}
        };
      };
      pc.onicecandidate = (e) => {
        if (e.candidate && !(simulateRemote && / typ host/.test(e.candidate.candidate))) sendRaw({ type: 'rtc_candidate', candidate: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (pc !== rtc) return;
        if (pc.connectionState === 'failed') rtcFailed('connection failed');
        if (pc.connectionState === 'disconnected') {
          setTimeout(() => { if (pc === rtc && pc.connectionState === 'disconnected') rtcFailed('connection lost'); }, 3000);
        }
      };

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: simulateRemote ? stripHost(msg.sdp) : msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendRaw({ type: 'rtc_answer', sdp: pc.localDescription.sdp });
      } catch (e) {
        console.warn('WebRTC negotiation failed', e);
        rtcFailed('negotiation failed');
        return;
      }
      // If no UDP path is found quickly, keep using the WebSocket stream
      rtcTimer = setTimeout(() => { if (!rtcActive) rtcFailed('timeout'); }, 8000);
    }

    function maybeStartRtc() {
      if (rtcTried || !shouldUseWebRTC()) return;
      rtcTried = true;
      stats.transport = 'connecting WebRTC…';
      sendRaw({ type: 'rtc_start' });
    }

    async function connect() {
      useH264 = await detectH264();
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/?k=' + encodeURIComponent(accessKey));
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        waitingForKeyframe = true;
        bestRtt = Infinity;
        sendHello();
        stats.transport = 'WebSocket';
        rtcTried = false;
        stopRtc();
        maybeStartRtc();
        if (!gotFirstFrame) statusEl.textContent = 'Waiting for the computer…';
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          bytesWindow += event.data.byteLength;
          const kind = new Uint8Array(event.data, 0, 1)[0];
          if (kind === 1 || kind === 2) {
            if (useH264) handleH264(event.data, kind === 1);
          } else if (kind === 3) {
            handleJpeg(event.data);
          }
          return;
        }
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'cursor') {
          onRemoteCursor(msg.x, msg.y);
        } else if (msg.type === 'rtc_offer') {
          onRtcOffer(msg);
        } else if (msg.type === 'rtc_candidate') {
          if (rtc && msg.candidate && !(simulateRemote && / typ host/.test(msg.candidate.candidate || ''))) rtc.addIceCandidate(msg.candidate).catch(() => {});
        } else if (msg.type === 'rtc_unavailable') {
          rtcFailed('server unavailable');
        } else if (msg.type === 'clock_pong') {
          const now = Date.now();
          const rtt = now - msg.t;
          if (!rtcActive) stats.rttMs = rtt;
          // Keep the sample with the lowest round-trip (most accurate offset), slowly forgetting old ones
          bestRtt = Math.min(bestRtt * 1.05, 1e9);
          if (rtt <= bestRtt) {
            bestRtt = rtt;
            clockOffset = msg.h - (msg.t + rtt / 2);
          }
        } else if (msg.type === 'host_status') {
          if (!msg.online) {
            statusEl.style.display = '';
            statusEl.textContent = 'The computer is offline — waiting for it to reconnect…';
            gotFirstFrame = false;
          }
        }
      };

      ws.onclose = (event) => {
        if (event.code === 1008 || event.code === 4001) {
          statusEl.style.display = '';
          statusEl.textContent = 'Access denied — open the full link including the access key.';
          return;
        }
        if (!gotFirstFrame) statusEl.textContent = 'Reconnecting…';
        setTimeout(connect, 1000);
      };
    }

    connect();

    setInterval(() => sendRaw({ type: 'clock_ping', t: Date.now() }), 1000);

    const showStats = new URLSearchParams(location.search).get('stats') === '1';
    const statsEl = document.getElementById('stats');
    if (showStats) statsEl.style.display = 'block';
    function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
    setInterval(() => {
      stats.fps = framesWindow * 2;
      if (rtcActive) updateRtcRoute();
      else stats.mbps = +(bytesWindow * 8 * 2 / 1e6).toFixed(2);
      const lat = avg(latencySamples);
      const dec = avg(decodeSamples);
      stats.latencyMs = lat === null ? null : Math.round(lat);
      if (!rtcActive) stats.decodeMs = dec === null ? null : +dec.toFixed(1);
      framesWindow = 0; bytesWindow = 0; latencySamples = []; decodeSamples = [];
      if (showStats) {
        statsEl.textContent =
          'transport ' + (stats.transport || '—') + (rtcActive && rtcRoute ? ' · ' + rtcRoute : '') + '\\n' +
          'codec    ' + (stats.codec === 'h264' ? 'H.264 (hardware)' : 'JPEG (fallback)') + '\\n' +
          (rtcActive
            ? 'buffer   ' + (stats.jitterMs === undefined ? '—' : stats.jitterMs + ' ms jitter buffer') + ' · lost ' + (stats.packetsLost || 0) + '\\n'
            : 'latency  ' + (stats.latencyMs === null ? '—' : stats.latencyMs + ' ms (host → screen)') + '\\n') +
          'decode   ' + (stats.decodeMs === null ? '—' : stats.decodeMs + ' ms') + '\\n' +
          'network  ' + (stats.rttMs === null ? '—' : stats.rttMs + ' ms round trip') + '\\n' +
          'fps      ' + stats.fps + '\\n' +
          'bitrate  ' + stats.mbps + ' Mbps';
      }
    }, 500);

    // ------------------------------------------------------------------
    // Coordinates
    // ------------------------------------------------------------------
    function renderRect() {
      const rect = canvas.getBoundingClientRect();
      const mw = rtcActive && rtcVideo.videoWidth ? rtcVideo.videoWidth : canvas.width;
      const mh = rtcActive && rtcVideo.videoHeight ? rtcVideo.videoHeight : canvas.height;
      const videoAspect = (mw || 16) / (mh || 10);
      const containerAspect = rect.width / rect.height;
      let w = rect.width, h = rect.height, ox = 0, oy = 0;
      if (containerAspect > videoAspect) {
        w = rect.height * videoAspect;
        ox = (rect.width - w) / 2;
      } else {
        h = rect.width / videoAspect;
        oy = (rect.height - h) / 2;
      }
      return { left: rect.left + ox, top: rect.top + oy, width: w, height: h };
    }

    function getNormalizedCoords(clientX, clientY) {
      const r = renderRect();
      return {
        x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (clientY - r.top) / r.height))
      };
    }

    // ------------------------------------------------------------------
    // Cursor overlay: drawn locally so it never waits for video
    // ------------------------------------------------------------------
    let cursorPos = null;            // normalized
    let lastLocalPointer = -1e9;     // time of last local pointer activity

    function updateCursorElement() {
      if (!cursorPos) return;
      const r = renderRect();
      const x = r.left + cursorPos.x * r.width;
      const y = r.top + cursorPos.y * r.height;
      cursorEl.style.transform = 'translate(' + (x - 1.5) + 'px,' + (y - 1.5) + 'px)';
      cursorEl.style.display = 'block';
    }

    function setLocalCursor(norm) {
      lastLocalPointer = performance.now();
      cursorPos = norm;
      updateCursorElement();
    }

    // Position reported by the Mac (e.g. someone moving the mouse physically there).
    // Ignored briefly after local input so our own echoed movement never makes the cursor jitter.
    function onRemoteCursor(x, y) {
      if (performance.now() - lastLocalPointer < 350) return;
      cursorPos = { x, y };
      stats.cursorUpdates++;
      updateCursorElement();
    }

    window.addEventListener('resize', updateCursorElement);

    // ------------------------------------------------------------------
    // Input — coalesced to one message per animation frame for moves / scrolls
    // ------------------------------------------------------------------
    function send(type, data) {
      const msg = { type: 'remote_input', input: { type, ...data } };
      if (rtcActive && rtcChannel && rtcChannel.readyState === 'open') {
        rtcChannel.send(JSON.stringify(msg));   // peer-to-peer UDP path
      } else {
        sendRaw(msg);
      }
    }

    let pendingMove = null;
    let pendingWheel = null;
    let inputFlushScheduled = false;

    function scheduleInputFlush() {
      if (!inputFlushScheduled) {
        inputFlushScheduled = true;
        requestAnimationFrame(flushInput);
      }
    }

    function flushInput() {
      inputFlushScheduled = false;
      if (pendingMove) {
        send('mouse_move', pendingMove);
        pendingMove = null;
      }
      if (pendingWheel) {
        send('wheel', pendingWheel);
        pendingWheel = null;
      }
    }

    // Input is sent immediately — browsers already deliver pointer events at display rate,
    // so batching would only add up to one extra frame of delay.
    function queueMove(coords) {
      send('mouse_move', coords);
    }

    function queueWheel(dx, dy) {
      send('wheel', { deltaX: dx, deltaY: dy });
    }

    // Mouse (desktop / laptop viewers)
    canvas.addEventListener('mousemove', (e) => {
      const c = getNormalizedCoords(e.clientX, e.clientY);
      setLocalCursor(c);
      queueMove(c);
    });

    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mobileInput.focus({ preventScroll: true });
      const c = getNormalizedCoords(e.clientX, e.clientY);
      setLocalCursor(c);
      pendingMove = null;
      send('mouse_down', { button: e.button, ...c });
    });

    canvas.addEventListener('mouseup', (e) => {
      e.preventDefault();
      const c = getNormalizedCoords(e.clientX, e.clientY);
      pendingMove = null;
      send('mouse_up', { button: e.button, ...c });
    });

    canvas.addEventListener('mouseleave', () => {
      flushInput();
    });

    // Right-click is sent via mousedown/mouseup (button 2); just suppress the browser menu
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      queueWheel(e.deltaX * scale, e.deltaY * scale);
    }, { passive: false });

    // Touch (phones / tablets)
    let lastTouch = { x: 0, y: 0 };
    let isTouching = false;

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        lastTouch = { x: t.clientX, y: t.clientY };
        isTouching = true;
        mobileInput.focus({ preventScroll: true });
        const c = getNormalizedCoords(t.clientX, t.clientY);
        setLocalCursor(c);
        pendingMove = null;
        send('mouse_move', c);
        send('mouse_down', { button: 0, ...c });
      } else if (e.touches.length === 2) {
        // Second finger: release the drag started by the first finger and switch to scrolling
        if (isTouching) {
          isTouching = false;
          pendingMove = null;
          send('mouse_up', { button: 0 });
        }
        lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && isTouching) {
        const t = e.touches[0];
        const c = getNormalizedCoords(t.clientX, t.clientY);
        setLocalCursor(c);
        queueMove(c);
      } else if (e.touches.length === 2) {
        // Natural scrolling: dragging fingers up scrolls content down
        const t = e.touches[0];
        queueWheel((lastTouch.x - t.clientX) * 2, (lastTouch.y - t.clientY) * 2);
        lastTouch = { x: t.clientX, y: t.clientY };
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (isTouching) {
        isTouching = false;
        flushInput();
        send('mouse_up', { button: 0 });
      }
      mobileInput.focus({ preventScroll: true });
    }, { passive: false });

    // Keyboard. A key that reports a real value is sent from keydown; the hidden input's
    // beforeinput only covers IME / virtual keyboards reporting 'Unidentified' / 'Process'
    // (keyCode 229), so each keystroke is sent exactly once.
    let keyHandledByKeydown = false;

    function isRealKey(e) {
      return !e.isComposing && e.key !== 'Unidentified' && e.key !== 'Process' && e.keyCode !== 229;
    }

    window.addEventListener('keydown', (e) => {
      keyHandledByKeydown = isRealKey(e);
      if (!keyHandledByKeydown) return;
      if (['Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
      send('key_down', {
        key: e.key,
        code: e.code,
        modifiers: { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }
      });
    });

    window.addEventListener('keyup', (e) => {
      if (!isRealKey(e)) return;
      send('key_up', {
        key: e.key,
        code: e.code,
        modifiers: { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }
      });
    });

    mobileInput.addEventListener('beforeinput', (e) => {
      const alreadySent = keyHandledByKeydown;
      keyHandledByKeydown = false;
      // Keep the hidden input empty; the remote computer is the source of truth
      if (!e.isComposing) e.preventDefault();
      if (alreadySent) return;
      if (e.inputType === 'deleteContentBackward') {
        send('key_down', { key: 'Backspace', code: 'Backspace', modifiers: {} });
        send('key_up', { key: 'Backspace', code: 'Backspace', modifiers: {} });
      } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        send('key_down', { key: 'Enter', code: 'Enter', modifiers: {} });
        send('key_up', { key: 'Enter', code: 'Enter', modifiers: {} });
      } else if (e.data && !e.isComposing) {
        send('text_input', { text: e.data });
      }
    });

    // Composed text (CJK IME, some Android keyboards) arrives once composition ends
    mobileInput.addEventListener('compositionend', (e) => {
      if (e.data) send('text_input', { text: e.data });
      mobileInput.value = '';
    });
  </script>
</body>
</html>`;

const DENIED_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChemFoam</title></head><body style="background:#000;color:#aaa;font:16px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:0 16px;text-align:center">
Access key required. Open the full link printed by <code style="color:#fff">status-chemfoam.cmd</code> on the host computer.</body></html>`;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function isAuthorized(reqUrl) {
  if (!TOKEN) return true;
  let key = '';
  try { key = new URL(reqUrl, 'http://localhost').searchParams.get('k') || ''; } catch (_) {}
  const a = Buffer.from(key);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Streaming state
// ---------------------------------------------------------------------------
const FRAME_H264_KEY = 1;
const FRAME_H264_DELTA = 2;
const FRAME_JPEG = 3;

// Per-viewer send-buffer thresholds. Keeping the queue short keeps latency low:
// a congested viewer skips frames until the next keyframe instead of falling behind.
const HIGH_WATER = 512 * 1024;
const LOW_WATER = 96 * 1024;

// Adaptive bitrate (shared encoder → adapts to the slowest viewer)
const MIN_BITRATE = 1_000_000;
const MAX_BITRATE = 10_000_000;
let bitrate = 6_000_000;
let lastCongestionAt = 0;
let lastBitrateChangeAt = 0;

let hostSocket = null;
const viewers = new Map(); // ws -> { codec: 'h264' | 'jpeg' | null, waitingForKeyframe: bool }
let framesForwarded = 0;
let lastJpegFrame = null;
let lastKeyframeRequestAt = 0;
let lastCursorMsg = null; // so new viewers see the cursor immediately

function sendToHost(obj) {
  if (hostSocket && hostSocket.readyState === hostSocket.OPEN) {
    hostSocket.send(JSON.stringify(obj));
  }
}

function requestKeyframe() {
  const now = Date.now();
  if (now - lastKeyframeRequestAt < 250) return;
  lastKeyframeRequestAt = now;
  sendToHost({ type: 'keyframe' });
}

function updateHostStreams() {
  let h264 = false, jpeg = false;
  for (const v of viewers.values()) {
    if (v.codec === 'h264' || v.rtc) h264 = true;
    if (v.codec === 'jpeg' && !v.rtcActive) jpeg = true;
  }
  sendToHost({ type: 'streams', h264, jpeg });
}

function setBitrate(bps, reason) {
  bps = Math.round(Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, bps)));
  if (Math.abs(bps - bitrate) < 50_000) return;
  bitrate = bps;
  lastBitrateChangeAt = Date.now();
  sendToHost({ type: 'bitrate', bps: bitrate });
  console.log(`📶 [Server] Bitrate → ${(bitrate / 1e6).toFixed(1)} Mbps (${reason})`);
}

function onCongestion() {
  const now = Date.now();
  if (now - lastCongestionAt > 1000) {
    setBitrate(bitrate * 0.7, 'viewer network congested');
  }
  lastCongestionAt = now;
}

// Slowly probe back up when no viewer has been congested for a while
setInterval(() => {
  const now = Date.now();
  if (now - lastCongestionAt > 5000 && now - lastBitrateChangeAt > 3000 && bitrate < MAX_BITRATE) {
    let anyH264 = false;
    for (const v of viewers.values()) if (v.codec === 'h264' || v.rtc) anyH264 = true;
    if (anyH264) setBitrate(bitrate * 1.15, 'network healthy');
  }
}, 1000);

function forwardH264(msg, isKey) {
  // WebRTC viewers: packetize once into RTP, send to every connected peer over UDP
  let packets = null;
  for (const v of viewers.values()) {
    if (v.rtc && v.rtc.connected) {
      if (!packets) packets = packetizeFrame(msg.subarray(9), msg.readBigUInt64BE(1));
      v.rtc.sendPackets(packets, isKey);
    }
  }

  for (const [ws, v] of viewers) {
    if (v.codec !== 'h264' || v.rtcActive || ws.readyState !== ws.OPEN) continue;
    const buffered = ws.bufferedAmount;

    if (v.waitingForKeyframe) {
      if (isKey && buffered < LOW_WATER) {
        v.waitingForKeyframe = false;
        ws.send(msg, { binary: true });
      } else if (buffered < LOW_WATER) {
        requestKeyframe();
      }
      continue;
    }

    if (buffered > HIGH_WATER) {
      // Viewer can't keep up: drop until it drains, then resync on a fresh keyframe
      v.waitingForKeyframe = true;
      onCongestion();
      continue;
    }
    ws.send(msg, { binary: true });
  }
}

function forwardJpeg(msg) {
  lastJpegFrame = msg;
  for (const [ws, v] of viewers) {
    if (v.codec === 'jpeg' && !v.rtcActive && ws.readyState === ws.OPEN && ws.bufferedAmount < HIGH_WATER) {
      ws.send(msg, { binary: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------
function handleHttp(req, res) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (!isAuthorized(req.url)) {
    res.writeHead(401, headers);
    res.end(DENIED_HTML);
    return;
  }
  res.writeHead(200, headers);
  res.end(CLIENT_HTML);
}

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024 * 1024,
  perMessageDeflate: false
});

function handleUpgrade(req, socket, head) {
  if (!isAuthorized(req.url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

const server = http.createServer(handleHttp);
server.on('upgrade', handleUpgrade);

let httpsServer = null;
if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  httpsServer = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handleHttp);
  httpsServer.on('upgrade', handleUpgrade);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`🔒 HTTPS (hardware H.264 for LAN viewers) on port ${HTTPS_PORT}`);
  });
}

let nextViewerId = 1;

wss.on('connection', (ws, req) => {
  let isHost = false;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Lowest latency: no Nagle batching
  if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);

  ws.on('message', (msg, isBinary) => {
    // 1. Binary video frames — only accepted from the registered host
    if (isBinary) {
      if (!isHost || msg.length < 10) return;
      framesForwarded++;
      if (framesForwarded % 600 === 0) {
        console.log(`📡 [Server] Forwarded ${framesForwarded} frames to ${viewers.size} viewer(s), bitrate ${(bitrate / 1e6).toFixed(1)} Mbps`);
      }
      const kind = msg[0];
      if (kind === FRAME_H264_KEY || kind === FRAME_H264_DELTA) {
        forwardH264(msg, kind === FRAME_H264_KEY);
      } else if (kind === FRAME_JPEG) {
        forwardJpeg(msg);
      }
      return;
    }

    // 2. Control messages
    let data;
    try { data = JSON.parse(msg.toString()); } catch (_) { return; }

    if (data.type === 'register_host') {
      if (hostSocket && hostSocket !== ws) {
        try { hostSocket.close(); } catch (_) {}
      }
      isHost = true;
      hostSocket = ws;
      viewers.delete(ws);
      lastJpegFrame = null;
      console.log(`🟢 [ChemFoam] Windows host registered and streaming live! (${viewers.size} viewer(s))`);
      sendToHost({ type: 'bitrate', bps: bitrate });
      updateHostStreams();
      for (const v of viewers.values()) v.waitingForKeyframe = true;
      requestKeyframe();
      for (const viewerWs of viewers.keys()) {
        if (viewerWs.readyState === viewerWs.OPEN) viewerWs.send(JSON.stringify({ type: 'host_status', online: true }));
      }
      return;
    }

    if (isHost && data.type === 'clock_pong') {
      // Route the host's clock reply back to the viewer that asked
      for (const [viewerWs, v] of viewers) {
        if (v.id === data.vid && viewerWs.readyState === viewerWs.OPEN) {
          viewerWs.send(JSON.stringify({ type: 'clock_pong', t: data.t, h: data.h }));
        }
      }
      return;
    }

    if (isHost) {
      // Host → viewers: cursor position (small, latency-critical, sent to everyone)
      if (data.type === 'cursor') {
        const text = JSON.stringify({ type: 'cursor', x: data.x, y: data.y });
        lastCursorMsg = text;
        for (const [viewerWs, v] of viewers) {
          if (v.rtcActive && v.rtc && v.rtc.sendControl(text)) continue;  // peer-to-peer path
          if (viewerWs.readyState === viewerWs.OPEN && viewerWs.bufferedAmount < HIGH_WATER) viewerWs.send(text);
        }
      }
      return;
    }

    const viewer = viewers.get(ws);
    if (!viewer) return;

    if (data.type === 'hello') {
      const codecs = Array.isArray(data.codecs) ? data.codecs : [];
      viewer.codec = codecs.includes('h264') ? 'h264' : 'jpeg';
      viewer.waitingForKeyframe = true;
      console.log(`📱 [ChemFoam] Viewer using ${viewer.codec === 'h264' ? 'H.264 (hardware)' : 'JPEG (fallback)'}`);
      updateHostStreams();
      if (viewer.codec === 'h264') requestKeyframe();
      else if (lastJpegFrame) ws.send(lastJpegFrame, { binary: true });
      if (!hostSocket) ws.send(JSON.stringify({ type: 'host_status', online: false }));
      else if (lastCursorMsg) ws.send(lastCursorMsg);
      return;
    }

    if (data.type === 'rtc_start') {
      if (viewer.rtc) viewer.rtc.close();
      const sendSignal = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
      viewer.rtc = new RtcSession({
        sendSignal,
        onKeyframeRequest: requestKeyframe,
        onCongestion,
        onInput: (msgData) => {
          if (msgData && msgData.type === 'remote_input' && msgData.input) sendToHost({ type: 'remote_input', input: msgData.input });
        },
        log: (line) => console.log(line)
      });
      updateHostStreams();
      viewer.rtc.start().catch((e) => {
        console.log(`⚠️  [WebRTC] Could not start: ${e.message}`);
        sendSignal({ type: 'rtc_unavailable' });
      });
      return;
    }

    if (data.type === 'rtc_answer' && viewer.rtc) {
      viewer.rtc.setAnswer(data.sdp).catch((e) => {
        console.log(`⚠️  [WebRTC] Bad answer: ${e.message}`);
        ws.send(JSON.stringify({ type: 'rtc_unavailable' }));
      });
      return;
    }

    if (data.type === 'rtc_candidate' && viewer.rtc) {
      viewer.rtc.addCandidate(data.candidate);
      return;
    }

    if (data.type === 'rtc_active' && viewer.rtc) {
      viewer.rtcActive = true;
      console.log(`🛰️  [WebRTC] Viewer #${viewer.id} now streaming over peer-to-peer UDP (${data.route || 'unknown route'})`);
      updateHostStreams();
      return;
    }

    if (data.type === 'rtc_failed') {
      if (viewer.rtc) viewer.rtc.close();
      viewer.rtc = null;
      viewer.rtcActive = false;
      viewer.waitingForKeyframe = true;
      console.log(`↩️  [WebRTC] Viewer #${viewer.id} fell back to WebSocket (${data.reason || 'no UDP path'})`);
      updateHostStreams();
      requestKeyframe();
      return;
    }

    if (data.type === 'clock_ping') {
      sendToHost({ type: 'clock_ping', vid: viewer.id, t: data.t });
      return;
    }

    if (data.type === 'request_keyframe') {
      if (viewer.codec === 'h264') {
        viewer.waitingForKeyframe = true;
        requestKeyframe();
      }
      return;
    }

    if (data.type === 'remote_input' && data.input) {
      sendToHost({ type: 'remote_input', input: data.input });
    }
  });

  // Track as a viewer until it identifies as the host
  viewers.set(ws, { id: nextViewerId++, codec: null, waitingForKeyframe: true, rtc: null, rtcActive: false });
  const addr = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  console.log(`📱 [ChemFoam] Client connected from ${addr} (${viewers.size} active)`);

  ws.on('error', () => {});

  ws.on('close', () => {
    if (isHost) {
      if (hostSocket === ws) {
        hostSocket = null;
        console.log('🔴 [ChemFoam] Windows host disconnected');
        for (const viewerWs of viewers.keys()) {
          if (viewerWs.readyState === viewerWs.OPEN) viewerWs.send(JSON.stringify({ type: 'host_status', online: false }));
        }
      }
    } else {
      const v = viewers.get(ws);
      if (v && v.rtc) v.rtc.close();
      viewers.delete(ws);
      console.log(`📱 [ChemFoam] Client disconnected (${viewers.size} active)`);
      updateHostStreams();
    }
  });
});

// Keepalive: detect dead connections and keep tunnels / NATs from idling out the socket
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 ChemFoam Server Running on port ${PORT}`);
  console.log(`🔐 Access key ${TOKEN ? 'REQUIRED' : 'NOT SET (anyone on the network can connect!)'}`);
  console.log(`======================================================\n`);
});
