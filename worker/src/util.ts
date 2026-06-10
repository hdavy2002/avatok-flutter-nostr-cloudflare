// Shared helpers: HTTP/CORS, hashing, hex, phone normalization, NIP-19 bech32.

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-nostr-auth,x-content-type,idempotency-key",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

// Robust text extraction across Workers AI chat shapes: `{response}` (Llama/Gemma3)
// or `{choices:[{message:{content,reasoning}}]}` (Gemma 4 OpenAI-style; `reasoning`
// is the thinking chain, `content` the final answer). Prefer content.
export function aiText(out: any): string {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  const m = out.choices?.[0]?.message;
  if (m) return (m.content ?? m.reasoning ?? "") as string;
  return (out.description ?? "") as string;
}

// D1 caps bound parameters at 100 per query. Split arrays into safe batches.
export function chunk<T>(arr: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Bytes(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return hex(await sha256Bytes(data));
}

// Best-effort E.164 normalization. Client should send +CC numbers; we strip the rest.
export function normalizePhone(raw: string): string {
  const t = raw.trim().replace(/[^\d+]/g, "");
  return t.startsWith("+") ? t : "+" + t;
}

// ---- bech32 (BIP173) — minimal, for NIP-19 npub <-> 32-byte hex ----
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

function bech32Decode(str: string): { hrp: string; data: number[] } | null {
  const lower = str.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (let i = pos + 1; i < lower.length; i++) {
    const d = CHARSET.indexOf(lower[i]);
    if (d === -1) return null;
    data.push(d);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) return null;
  return { hrp, data: data.slice(0, data.length - 6) };
}

function bech32Encode(hrp: string, data: number[]): string {
  const values = hrpExpand(hrp).concat(data);
  const mod = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 1;
  const chk: number[] = [];
  for (let i = 0; i < 6; i++) chk.push((mod >> (5 * (5 - i))) & 31);
  let ret = hrp + "1";
  for (const d of data.concat(chk)) ret += CHARSET[d];
  return ret;
}

export function npubToHex(npub: string): string | null {
  const dec = bech32Decode(npub);
  if (!dec || dec.hrp !== "npub") return null;
  const bytes = convertBits(dec.data, 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return hex(Uint8Array.from(bytes));
}

export function hexToNpub(h: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(h)) return null;
  const bytes = h.toLowerCase().match(/.{2}/g)!.map((x) => parseInt(x, 16));
  const five = convertBits(bytes, 8, 5, true);
  if (!five) return null;
  return bech32Encode("npub", five);
}
