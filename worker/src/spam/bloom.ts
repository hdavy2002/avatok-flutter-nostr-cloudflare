// [AVA-SPAM-3] Deterministic bloom filter for the on-device spam fast-path — Phase 2a.
//
// Spec §4.4 item 4: the app ships a compact bloom filter of the worst numbers,
// refreshed daily. Screening is LOCAL-FIRST — a bloom MISS = definitely-not-a-known-
// spammer → paint blue/green with ZERO network. A HIT is confirmed with one call to
// the edge-cached D1 lookup (§4.4 item 3). Target ~1% false-positive rate.
//
// Keying: the bloom is built over the E.164-HASH (sha256 hex of the normalized
// number) so no raw PII lives in the distributed filter. The device computes the
// same sha256(normalizePhone(number)) and checks membership with the identical
// params (m, k) carried in the manifest.
//
// Hashing: k indices are derived from ONE SHA-256 of the key via double hashing
// (Kirsch–Mitzenmacher): idx_i = (h1 + i*h2) mod m, where h1/h2 are the first two
// 32-bit little-endian words of the digest. Deterministic and dependency-free.
//
// Serialization (little-endian): a fixed header then the packed bit array.
//   magic   : 5 bytes  = "AVSB1"
//   version : uint8    = FORMAT_VERSION
//   k       : uint16
//   m       : uint32   (bit count)
//   count   : uint32   (items inserted)
//   bits    : ceil(m/8) bytes
// The client parses the header, then tests membership against `bits`.

export const BLOOM_MAGIC = "AVSB1";
export const FORMAT_VERSION = 1;
export const DEFAULT_TARGET_FPR = 0.01;

export interface BloomParams {
  m: number; // number of bits
  k: number; // number of hash functions
}

export interface BloomFilter extends BloomParams {
  bits: Uint8Array; // packed, ceil(m/8) bytes
  count: number; // items inserted
}

/**
 * Optimal (m, k) for n items at a target false-positive rate.
 *   m = ceil( -n * ln(p) / (ln2)^2 ),  k = round( (m/n) * ln2 )
 * Guards tiny/empty inputs so m and k are always >= 1.
 */
export function optimalParams(n: number, targetFpr = DEFAULT_TARGET_FPR): BloomParams {
  const items = Math.max(1, Math.floor(n));
  const p = Math.min(Math.max(targetFpr, 1e-6), 0.5);
  const ln2 = Math.LN2;
  const m = Math.max(8, Math.ceil((-items * Math.log(p)) / (ln2 * ln2)));
  const k = Math.max(1, Math.round((m / items) * ln2));
  return { m, k };
}

async function digest(key: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}

// Two 32-bit words (little-endian) from the digest → double hashing base pair.
function h1h2(d: Uint8Array): [number, number] {
  const h1 = (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
  const h2 = (d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] << 24)) >>> 0;
  // h2 must be odd/non-zero so the probe sequence covers distinct slots.
  return [h1, (h2 | 1) >>> 0];
}

function indices(d: Uint8Array, k: number, m: number): number[] {
  const [h1, h2] = h1h2(d);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    // (h1 + i*h2) mod m, computed in float to avoid 32-bit overflow for large m.
    const combined = (h1 + i * h2) % m;
    out.push(combined < 0 ? combined + m : combined);
  }
  return out;
}

function setBit(bits: Uint8Array, idx: number): void {
  bits[idx >> 3] |= 1 << (idx & 7);
}
function getBit(bits: Uint8Array, idx: number): boolean {
  return (bits[idx >> 3] & (1 << (idx & 7))) !== 0;
}

/**
 * Build a bloom filter from a list of keys (e164 hashes). Deterministic given the
 * same key set + params. Duplicate keys are harmless (idempotent set bits).
 */
export async function buildBloom(
  keys: string[],
  targetFpr = DEFAULT_TARGET_FPR,
): Promise<BloomFilter> {
  const unique = Array.from(new Set(keys));
  const { m, k } = optimalParams(unique.length, targetFpr);
  const bits = new Uint8Array(Math.ceil(m / 8));
  for (const key of unique) {
    const d = await digest(key);
    for (const idx of indices(d, k, m)) setBit(bits, idx);
  }
  return { m, k, bits, count: unique.length };
}

/** Membership test with the SAME params used to build. Async (hashes the key). */
export async function bloomMightContain(f: BloomFilter, key: string): Promise<boolean> {
  const d = await digest(key);
  for (const idx of indices(d, f.k, f.m)) {
    if (!getBit(f.bits, idx)) return false;
  }
  return true;
}

/** Pack a filter into the wire format described in the file header. */
export function serializeBloom(f: BloomFilter): Uint8Array {
  const headerLen = 5 + 1 + 2 + 4 + 4;
  const out = new Uint8Array(headerLen + f.bits.length);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) out[i] = BLOOM_MAGIC.charCodeAt(i);
  let o = 5;
  dv.setUint8(o, FORMAT_VERSION); o += 1;
  dv.setUint16(o, f.k, true); o += 2;
  dv.setUint32(o, f.m, true); o += 4;
  dv.setUint32(o, f.count, true); o += 4;
  out.set(f.bits, o);
  return out;
}
