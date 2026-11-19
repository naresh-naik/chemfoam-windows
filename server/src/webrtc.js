// WebRTC (UDP) transport for viewers on remote / lossy networks.
//
// The Mac host still sends H.264 to this server over the local WebSocket. For each WebRTC viewer
// the server packetizes those frames into RTP (RFC 6184) and sends them peer-to-peer over UDP:
// lost packets are retransmitted individually (NACK) instead of stalling the whole stream like TCP.
// A data channel carries input and cursor updates over the same peer-to-peer path.
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, H264Packetizer } from 'werift';

// Public STUN lets both sides discover their public address for NAT traversal (no media goes through it).
// Override with CHEMFOAM_STUN (comma-separated), or set it to an empty string to disable.
export const STUN_SERVERS = (process.env.CHEMFOAM_STUN ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
  .split(',').map((s) => s.trim()).filter(Boolean);

const H264_FEEDBACK = [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }];

function h264Codec(profileLevelId) {
  return new RTCRtpCodecParameters({
    mimeType: 'video/H264',
    clockRate: 90000,
    rtcpFeedback: H264_FEEDBACK,
    parameters: `profile-level-id=${profileLevelId};packetization-mode=1;level-asymmetry-allowed=1`
  });
}

// One packetizer shared by all sessions: each frame is packetized once, then every RTP sender
// rewrites SSRC / sequence numbers for its own peer.
const packetizer = new H264Packetizer({ payloadType: 96, inputFormat: 'annexb' });

export function packetizeFrame(annexB, timestampMicros) {
  const rtpTimestamp = Number((BigInt(timestampMicros) * 9n / 100n) % 4294967296n); // 90 kHz clock
  return packetizer.packetize(annexB, rtpTimestamp);
}

export class RtcSession {
  constructor({ sendSignal, onKeyframeRequest, onCongestion, onInput, log }) {
    this.sendSignal = sendSignal;
    this.onKeyframeRequest = onKeyframeRequest;
    this.onCongestion = onCongestion;
    this.onInput = onInput;
    this.log = log;
    this.connected = false;
    this.closed = false;
    this.waitingForKeyframe = true;
    this.channel = null;
    this.nackPackets = 0;
    this.nackTimer = null;
  }

  async start() {
    const pc = this.pc = new RTCPeerConnection({
      // Constrained High first (what the Mac encoder produces), Constrained Baseline as a fallback
      codecs: { video: [h264Codec('640c1f'), h264Codec('42e01f')] },
      iceServers: STUN_SERVERS.map((urls) => ({ urls }))
    });

    this.track = new MediaStreamTrack({ kind: 'video' });
    const transceiver = pc.addTransceiver(this.track, { direction: 'sendonly' });
    const sender = transceiver.sender;

    // Viewer lost a frame it can't recover → send a fresh keyframe
    sender.onKeyFrameRequest.subscribe(() => {
      this.waitingForKeyframe = true;
      this.onKeyframeRequest();
    });

    // Packet loss signals congestion → lower the bitrate
    sender.onGenericNack.subscribe((nack) => {
      this.nackPackets += (nack.lost && nack.lost.length) || 1;
    });
    this.nackTimer = setInterval(() => {
      if (this.nackPackets > 20) this.onCongestion();
      this.nackPackets = 0;
    }, 1000);

    // Low-latency channel for input (viewer → Mac) and cursor (Mac → viewer)
    this.channel = pc.createDataChannel('control', { ordered: true });
    this.channel.onMessage.subscribe((data) => {
      try { this.onInput(JSON.parse(data.toString())); } catch (_) {}
    });

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate && !this.closed) {
        this.sendSignal({ type: 'rtc_candidate', candidate: candidate.toJSON ? candidate.toJSON() : candidate });
      }
    });

    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        if (!this.connected) this.log(`🛰️  [WebRTC] Peer-to-peer UDP connected`);
        this.connected = true;
        this.waitingForKeyframe = true;
        this.onKeyframeRequest();
      } else if (state === 'failed' || state === 'closed') {
        this.connected = false;
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal({ type: 'rtc_offer', sdp: pc.localDescription.sdp, iceServers: STUN_SERVERS });
  }

  async setAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  async addCandidate(candidate) {
    if (!candidate || !candidate.candidate) return;
    try { await this.pc.addIceCandidate(candidate); } catch (_) {}
  }

  sendPackets(packets, isKey) {
    if (!this.connected || this.closed) return;
    if (this.waitingForKeyframe) {
      if (!isKey) return;
      this.waitingForKeyframe = false;
    }
    for (const packet of packets) {
      try { this.track.writeRtp(packet); } catch (_) {}
    }
  }

  sendControl(text) {
    if (this.channel && this.channel.readyState === 'open') {
      try { this.channel.send(text); return true; } catch (_) {}
    }
    return false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    clearInterval(this.nackTimer);
    try { this.pc.close(); } catch (_) {}
  }
}
