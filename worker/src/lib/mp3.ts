// Pure-JS MP3 trimmer for the ringtone pipeline. Cloudflare Workers have no
// ffmpeg, but an MP3 is just a stream of self-describing frames, so trimming to
// N seconds is a frame-boundary cut — NO re-encoding, no native deps. We keep
// any leading ID3v2 tag + the first frame (which may hold the Xing/Info VBR
// header) and drop every frame past the time budget.
//
// Used by routes/ringtone.ts to cap a MiniMax Music 2.6 song at ~30s (the caller
// ring window). Best-effort: if the bytes don't parse as MPEG audio we return
// them unchanged so generation never fails over a trim.

// Bitrate tables (kbps) for Layer III.
const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // MPEG1
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];     // MPEG2 / 2.5
const SR_V1 = [44100, 48000, 32000, 0];
const SR_V2 = [22050, 24000, 16000, 0];
const SR_V25 = [11025, 12000, 8000, 0];

function id3v2Length(buf: Uint8Array): number {
  // "ID3" + version(2) + flags(1) + size(4 syncsafe). Returns total tag bytes
  // (header included) or 0 if absent.
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size;
}

/**
 * Trim an MP3 buffer to at most [maxSeconds] of audio. Returns a new Uint8Array
 * (a view-slice of the input). Falls back to the original bytes on any parse
 * problem so the caller can store something playable regardless.
 */
export function trimMp3ToSeconds(input: ArrayBuffer | Uint8Array, maxSeconds: number): Uint8Array {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    const tagLen = id3v2Length(buf);
    let i = tagLen;
    let seconds = 0;
    let framesSeen = 0;

    while (i + 4 <= buf.length) {
      // Frame sync: 11 set bits (0xFF, then top 3 bits of the next byte).
      if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
      const verBits = (buf[i + 1] >> 3) & 0x3;   // 00=2.5 10=2 11=1 (01 reserved)
      const layerBits = (buf[i + 1] >> 1) & 0x3; // 01 = Layer III
      if (verBits === 1 || layerBits !== 1) { i++; continue; }
      const brIndex = (buf[i + 2] >> 4) & 0xf;
      const srIndex = (buf[i + 2] >> 2) & 0x3;
      const padding = (buf[i + 2] >> 1) & 0x1;
      if (brIndex === 0 || brIndex === 15 || srIndex === 3) { i++; continue; }

      const mpeg1 = verBits === 3;
      const bitrate = (mpeg1 ? BR_V1 : BR_V2)[brIndex] * 1000;
      const sampleRate = (verBits === 3 ? SR_V1 : verBits === 2 ? SR_V2 : SR_V25)[srIndex];
      const samplesPerFrame = mpeg1 ? 1152 : 576;
      const frameLen = Math.floor((samplesPerFrame / 8 * bitrate) / sampleRate) + padding;
      if (frameLen <= 0) { i++; continue; }

      seconds += samplesPerFrame / sampleRate;
      framesSeen++;
      i += frameLen;
      if (seconds >= maxSeconds) break;
    }

    // No recognizable frames, or already under budget → keep the original.
    if (framesSeen === 0 || i >= buf.length) return buf;
    return buf.slice(0, i);
  } catch {
    return buf;
  }
}
