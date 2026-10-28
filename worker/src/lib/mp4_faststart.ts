// [HF-INTRO-P] Pure TypeScript "qt-faststart": move the MP4 'moov' atom in front of 'mdat' so a partial (Range)
// download can start playing. Phone encoders write moov at the END. Anything unparseable, already faststart, or
// not an MP4 is returned UNCHANGED (same Uint8Array instance).

interface Box { type: string; start: number; size: number; hdr: number }

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function setU32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
}
function type4(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Parse the boxes of b between [from,to). Returns null when the layout is malformed. */
function parseBoxes(b: Uint8Array, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let p = from;
  while (p < to) {
    if (p + 8 > to) return null;
    let size = u32(b, p);
    const type = type4(b, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > to) return null;
      const hi = u32(b, p + 8), lo = u32(b, p + 12);
      if (hi > 0x1fffff) return null;
      size = hi * 4294967296 + lo;
      hdr = 16;
    } else if (size === 0) {
      size = to - p; // box extends to end of file
    }
    if (size < hdr || p + size > to) return null;
    out.push({ type, start: p, size, hdr });
    p += size;
  }
  return out;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);

/** Add `delta` to every chunk offset below `box` (in place). Returns false if an offset would overflow. */
function shiftOffsets(b: Uint8Array, from: number, to: number, delta: number): boolean {
  const boxes = parseBoxes(b, from, to);
  if (!boxes) return false;
  for (const bx of boxes) {
    const body = bx.start + bx.hdr;
    const end = bx.start + bx.size;
    if (CONTAINERS.has(bx.type)) {
      if (!shiftOffsets(b, body, end, delta)) return false;
    } else if (bx.type === "stco") {
      if (body + 8 > end) return false;
      const n = u32(b, body + 4);
      if (body + 8 + n * 4 > end) return false;
      for (let i = 0; i < n; i++) {
        const o = body + 8 + i * 4;
        const v = u32(b, o) + delta;
        if (v > 0xffffffff) return false;
        setU32(b, o, v);
      }
    } else if (bx.type === "co64") {
      if (body + 8 > end) return false;
      const n = u32(b, body + 4);
      if (body + 8 + n * 8 > end) return false;
      for (let i = 0; i < n; i++) {
        const o = body + 8 + i * 8;
        let hi = u32(b, o);
        let lo = u32(b, o + 4) + delta;
        if (lo > 0xffffffff) { hi += Math.floor(lo / 4294967296); lo = lo >>> 0; }
        if (hi > 0xffffffff) return false;
        setU32(b, o, hi); setU32(b, o + 4, lo);
      }
    }
  }
  return true;
}

/** Returns a faststart copy of an MP4, or the input itself when nothing needs (or can safely) change. */
export function faststartMp4(input: Uint8Array): Uint8Array {
  try {
    if (input.byteLength < 16 || type4(input, 4) !== "ftyp") return input; // not an MP4 (e.g. WebM)
    const top = parseBoxes(input, 0, input.byteLength);
    if (!top) return input;
    const moovI = top.findIndex((x) => x.type === "moov");
    const mdatI = top.findIndex((x) => x.type === "mdat");
    if (moovI < 0 || mdatI < 0 || moovI < mdatI) return input; // missing parts or already faststart
    const moov = top[moovI];
    if (moov.hdr !== 8) return input; // 64-bit moov header: leave alone
    // Insert moov right after ftyp (and any other boxes that precede mdat stay in order).
    const mdat = top[mdatI];
    const moovBytes = input.slice(moov.start, moov.start + moov.size); // copy; mutated below
    if (!shiftOffsets(moovBytes, 8, moovBytes.byteLength, moov.size)) {
      console.warn("mp4_faststart: chunk offset overflow or malformed stbl; leaving file unchanged");
      return input;
    }
    const out = new Uint8Array(input.byteLength);
    let w = 0;
    out.set(input.subarray(0, mdat.start), w); w += mdat.start; // everything before mdat (ftyp, free, ...)
    out.set(moovBytes, w); w += moovBytes.byteLength;
    for (let i = mdatI; i < top.length; i++) {
      if (i === moovI) continue;
      const bx = top[i];
      out.set(input.subarray(bx.start, bx.start + bx.size), w); w += bx.size;
    }
    return w === input.byteLength ? out : input;
  } catch {
    return input;
  }
}
