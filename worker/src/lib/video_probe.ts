// [HF-MOD-1 2026-10-29] Read the REAL length of an uploaded video from inside the file, so the 10-20 s intro rule
// does not depend on the number the phone reports (x-duration-ms). Pure, no I/O, never throws.
//   MP4 / MOV : moov > mvhd  (timescale + duration, version 0 or 1)
//   WebM      : Segment > Info  (TimecodeScale + Duration float). Browser MediaRecorder WebM often has NO Duration;
//               then this returns null and the caller decides.

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Duration in ms from an MP4/MOV's moov/mvhd, or null when it cannot be read. */
export function mp4DurationMs(b: Uint8Array): number | null {
  try {
    let p = 0;
    const end = b.length;
    for (let guard = 0; p + 8 <= end && guard < 10_000; guard++) {
      let size = u32(b, p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) return null;
        const hi = u32(b, p + 8), lo = u32(b, p + 12);
        if (hi > 0x1fffff) return null;
        size = hi * 4294967296 + lo; hdr = 16;
      } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return null;
      if (type === "moov") return mvhdIn(b, p + hdr, p + size);
      p += size;
    }
    return null;
  } catch { return null; }
}

function mvhdIn(b: Uint8Array, from: number, to: number): number | null {
  let p = from;
  for (let guard = 0; p + 8 <= to && guard < 10_000; guard++) {
    const size = u32(b, p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (size < 8 || p + size > to) return null;
    if (type === "mvhd") {
      const v = b[p + 8];
      let timescale: number, duration: number;
      if (v === 1) {
        if (p + 8 + 4 + 16 + 4 + 8 > p + size) return null;
        timescale = u32(b, p + 8 + 4 + 16);
        const hi = u32(b, p + 8 + 4 + 16 + 4), lo = u32(b, p + 8 + 4 + 16 + 8);
        duration = hi * 4294967296 + lo;
      } else {
        if (p + 8 + 4 + 8 + 4 + 4 > p + size) return null;
        timescale = u32(b, p + 8 + 4 + 8);
        duration = u32(b, p + 8 + 4 + 8 + 4);
      }
      if (!timescale || !Number.isFinite(duration) || duration === 0 || duration === 0xffffffff) return null;
      const ms = Math.round((duration * 1000) / timescale);
      return ms > 0 && ms < 24 * 3600_000 ? ms : null;
    }
    p += size;
  }
  return null;
}

/** EBML variable-length integer. mask=true strips the length marker (sizes); false keeps it (IDs). */
function vint(b: Uint8Array, o: number, mask: boolean): { v: number; len: number; unknown: boolean } | null {
  if (o >= b.length) return null;
  const first = b[o];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || o + len > b.length) return null;
  let v = mask ? first & (0xff >> len) : first;
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 0xff) allOnes = false; }
  return { v, len, unknown: mask && allOnes };
}

/** Duration in ms from a WebM's Segment/Info, or null when absent or unreadable. */
export function webmDurationMs(b: Uint8Array): number | null {
  try {
    let p = 0;
    // EBML header, then Segment
    for (let guard = 0; p < b.length && guard < 64; guard++) {
      const id = vint(b, p, false); if (!id) return null;
      const sz = vint(b, p + id.len, true); if (!sz) return null;
      const body = p + id.len + sz.len;
      if (id.v === 0x18538067) return infoIn(b, body, sz.unknown ? b.length : Math.min(b.length, body + sz.v));
      if (sz.unknown) return null;
      p = body + sz.v;
    }
    return null;
  } catch { return null; }
}

function infoIn(b: Uint8Array, from: number, to: number): number | null {
  let p = from;
  for (let guard = 0; p < to && guard < 256; guard++) {
    const id = vint(b, p, false); if (!id) return null;
    const sz = vint(b, p + id.len, true); if (!sz || sz.unknown) return null;
    const body = p + id.len + sz.len;
    if (id.v === 0x1549a966) {
      let scale = 1_000_000, dur: number | null = null;
      let q = body; const end = Math.min(to, body + sz.v);
      for (let g = 0; q < end && g < 64; g++) {
        const cid = vint(b, q, false); if (!cid) return null;
        const csz = vint(b, q + cid.len, true); if (!csz || csz.unknown) return null;
        const cb = q + cid.len + csz.len;
        if (cb + csz.v > b.length) return null;
        if (cid.v === 0x2ad7b1) { let s = 0; for (let i = 0; i < csz.v; i++) s = s * 256 + b[cb + i]; if (s > 0) scale = s; }
        if (cid.v === 0x4489) {
          const dv = new DataView(b.buffer, b.byteOffset + cb, csz.v);
          dur = csz.v === 8 ? dv.getFloat64(0) : csz.v === 4 ? dv.getFloat32(0) : null;
        }
        q = cb + csz.v;
      }
      if (dur === null || !Number.isFinite(dur) || dur <= 0) return null;
      const ms = Math.round((dur * scale) / 1_000_000);
      return ms > 0 && ms < 24 * 3600_000 ? ms : null;
    }
    if (id.v === 0x1f43b675) return null; // reached the first Cluster without Info
    p = body + sz.v;
  }
  return null;
}

/** Real duration of a sniffed video, or null when the file does not say. */
export function probeVideoDurationMs(b: Uint8Array, mime: string): number | null {
  if (mime === "video/mp4") return mp4DurationMs(b);
  if (mime === "video/webm") return webmDurationMs(b);
  return null;
}
