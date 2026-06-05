// Perceptual hash (pHash) for image dedupe / blocklist matching.
// Decodes the image with Photon (WASM, Workers-compatible — no native deps),
// resizes to 32×32 grayscale, runs a 2-D DCT, and keeps the low-frequency 8×8
// block (minus DC) thresholded at its median → a 64-bit hash (16 hex chars).
// Two near-identical images yield a small Hamming distance even after re-encode,
// crop-free recolor, or resize — which sha256 cannot catch.
import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";

const N = 32; // working resolution
const K = 8;  // low-frequency block kept

// Precomputed DCT-II cosine basis for an N-length signal.
const COS: number[][] = (() => {
  const m: number[][] = [];
  for (let u = 0; u < N; u++) {
    m[u] = [];
    for (let x = 0; x < N; x++) m[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  }
  return m;
})();

/** Returns a 16-hex-char perceptual hash, or null if the image can't be decoded. */
export function perceptualHash(bytes: Uint8Array): string | null {
  let img: PhotonImage | null = null;
  let small: PhotonImage | null = null;
  try {
    img = PhotonImage.new_from_byteslice(bytes);
    small = resize(img, N, N, SamplingFilter.Nearest);
    const rgba = small.get_raw_pixels(); // length N*N*4

    // → grayscale matrix (luma)
    const g: number[][] = [];
    for (let y = 0; y < N; y++) {
      g[y] = [];
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        g[y][x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      }
    }

    // 2-D DCT (rows then columns), keep only the K×K low-frequency block.
    const rows: number[][] = [];
    for (let y = 0; y < N; y++) {
      rows[y] = [];
      for (let u = 0; u < K; u++) {
        let s = 0;
        for (let x = 0; x < N; x++) s += g[y][x] * COS[u][x];
        rows[y][u] = s;
      }
    }
    const block: number[] = [];
    for (let v = 0; v < K; v++) {
      for (let u = 0; u < K; u++) {
        let s = 0;
        for (let y = 0; y < N; y++) s += rows[y][u] * COS[v][y];
        block.push(s);
      }
    }

    // Median of the 63 AC coefficients (drop DC at index 0).
    const ac = block.slice(1).sort((a, b) => a - b);
    const median = ac[Math.floor(ac.length / 2)];

    // 64 bits: coeff > median. Bit 0 (DC) folded in deterministically as 0.
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      let nib = 0;
      for (let b = 0; b < 4; b++) {
        const idx = i + b;
        const bit = idx === 0 ? 0 : block[idx] > median ? 1 : 0;
        nib = (nib << 1) | bit;
      }
      hex += nib.toString(16);
    }
    return hex;
  } catch {
    return null; // undecodable (e.g. ciphertext / unsupported) → caller skips pHash
  } finally {
    try { small?.free(); } catch { /* noop */ }
    try { img?.free(); } catch { /* noop */ }
  }
}

/** Split a 16-hex (64-bit) pHash into 4 bands of 4 hex chars (16 bits) for LSH. */
export function bands(phash: string): string[] {
  return [phash.slice(0, 4), phash.slice(4, 8), phash.slice(8, 12), phash.slice(12, 16)];
}

/** Hamming distance between two equal-length hex hashes (lower = more similar). */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
