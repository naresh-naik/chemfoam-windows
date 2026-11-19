// Streaming FLV demuxer for H.264 (what ffmpeg writes with `-f flv`).
//
// FLV is used as a framing format because every FLV tag holds exactly one encoded frame and a
// keyframe flag — so frames can be forwarded the instant they arrive, with no guessing about
// where one frame ends (which a raw H.264 byte stream would need, costing a frame of latency).
//
// Each video frame is converted to Annex B (start codes) and keyframes are prefixed with
// SPS/PPS, which is exactly what the ChemFoam server and browser viewers expect.

const START_CODE = Buffer.from([0, 0, 0, 1]);

export class FlvH264Demuxer {
  constructor(onFrame) {
    this.onFrame = onFrame;          // (annexB: Buffer, isKeyframe: boolean) => void
    this.buffer = Buffer.alloc(0);
    this.headerDone = false;
    this.nalLengthSize = 4;
    this.parameterSets = null;       // Buffer: SPS+PPS in Annex B
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    if (!this.headerDone) {
      // "FLV" signature, version, flags, 4-byte header size, then PreviousTagSize0 (4 bytes)
      if (this.buffer.length < 9) return;
      if (this.buffer.toString('latin1', 0, 3) !== 'FLV') {
        throw new Error('ffmpeg output is not FLV');
      }
      const headerSize = this.buffer.readUInt32BE(5);
      if (this.buffer.length < headerSize + 4) return;
      this.buffer = this.buffer.subarray(headerSize + 4);
      this.headerDone = true;
    }

    // Tag: type(1) dataSize(3) timestamp(3) timestampExt(1) streamId(3) | data | PreviousTagSize(4)
    while (this.buffer.length >= 11) {
      const type = this.buffer[0] & 0x1f;
      const dataSize = this.buffer.readUIntBE(1, 3);
      const total = 11 + dataSize + 4;
      if (this.buffer.length < total) return;
      const data = this.buffer.subarray(11, 11 + dataSize);
      this.buffer = this.buffer.subarray(total);
      if (type === 9) this.handleVideo(data);
    }
  }

  handleVideo(data) {
    if (data.length < 5) return;
    const frameType = data[0] >> 4;        // 1 = keyframe
    const codecId = data[0] & 0x0f;        // 7 = AVC (H.264)
    if (codecId !== 7) return;
    const packetType = data[1];            // 0 = sequence header, 1 = NAL units, 2 = end of sequence

    if (packetType === 0) {
      this.parseDecoderConfig(data.subarray(5));
      return;
    }
    if (packetType !== 1) return;

    const nals = [];
    let hasIdr = false;
    let hasParamSets = false;
    let off = 5;
    const n = this.nalLengthSize;
    while (off + n <= data.length) {
      const len = data.readUIntBE(off, n);
      off += n;
      if (len <= 0 || off + len > data.length) break;
      const nal = data.subarray(off, off + len);
      const nalType = nal[0] & 0x1f;
      if (nalType === 5) hasIdr = true;
      if (nalType === 7 || nalType === 8) hasParamSets = true;
      if (nalType !== 9) nals.push(nal);  // drop access-unit delimiters
      off += len;
    }
    if (!nals.length) return;

    const isKey = frameType === 1 || hasIdr;
    const parts = [];
    if (isKey && !hasParamSets && this.parameterSets) parts.push(this.parameterSets);
    for (const nal of nals) parts.push(START_CODE, nal);
    this.onFrame(Buffer.concat(parts), isKey);
  }

  // AVCDecoderConfigurationRecord (ISO/IEC 14496-15)
  parseDecoderConfig(rec) {
    if (rec.length < 7) return;
    this.nalLengthSize = (rec[4] & 0x03) + 1;
    const parts = [];
    let off = 5;
    const numSps = rec[off++] & 0x1f;
    for (let i = 0; i < numSps && off + 2 <= rec.length; i++) {
      const len = rec.readUInt16BE(off); off += 2;
      parts.push(START_CODE, rec.subarray(off, off + len)); off += len;
    }
    if (off < rec.length) {
      const numPps = rec[off++];
      for (let i = 0; i < numPps && off + 2 <= rec.length; i++) {
        const len = rec.readUInt16BE(off); off += 2;
        parts.push(START_CODE, rec.subarray(off, off + len)); off += len;
      }
    }
    this.parameterSets = Buffer.concat(parts);
  }
}
