// [HF-HOST-KYC-1 2026-10-09] Field-level encryption for Hello Fraands KYC data (HF-KYC-2, HF-PRIV-6).
//
// AES-256-GCM through WebCrypto. Key = secret HF_PII_KEY (base64 of 32 random bytes).
// Output format:  v1:<iv base64>:<ciphertext+tag base64>   (fresh random 12-byte IV per value).
// The "v1" prefix lets a future key rotation add v2 without breaking old rows.
//
// Never log plaintext or the key. If HF_PII_KEY is missing/invalid the functions THROW
// (PiiKeyError) — callers must fail closed rather than store plaintext.
import type { Env } from "../types";

export class PiiKeyError extends Error {
  constructor(msg: string) { super(msg); this.name = "PiiKeyError"; }
}

const cache = new Map<string, Promise<CryptoKey>>();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** True when HF_PII_KEY is set to a base64 string that decodes to exactly 32 bytes. */
export function piiKeyConfigured(env: Pick<Env, "HF_PII_KEY">): boolean {
  try { return !!env.HF_PII_KEY && b64ToBytes(env.HF_PII_KEY.trim()).length === 32; } catch { return false; }
}

function importKey(env: Pick<Env, "HF_PII_KEY">): Promise<CryptoKey> {
  const raw = (env.HF_PII_KEY ?? "").trim();
  let p = cache.get(raw);
  if (!p) {
    p = (async () => {
      let bytes: Uint8Array;
      try { bytes = b64ToBytes(raw); } catch { throw new PiiKeyError("HF_PII_KEY is not valid base64"); }
      if (bytes.length !== 32) throw new PiiKeyError("HF_PII_KEY must decode to 32 bytes");
      return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
    p.catch(() => cache.delete(raw));
    cache.set(raw, p);
  }
  return p;
}

/** Raw 32 key bytes, for deriving the media-URL HMAC key (lib callers only). */
export function piiKeyBytes(env: Pick<Env, "HF_PII_KEY">): Uint8Array {
  if (!piiKeyConfigured(env)) throw new PiiKeyError("HF_PII_KEY missing or invalid");
  return b64ToBytes(env.HF_PII_KEY!.trim());
}

export async function encryptPii(env: Pick<Env, "HF_PII_KEY">, plaintext: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return `v1:${bytesToB64(iv)}:${bytesToB64(ct)}`;
}

/** Decrypts `v1:<iv>:<ct>`. Throws on a wrong key, tampered data or an unknown version. */
export async function decryptPii(env: Pick<Env, "HF_PII_KEY">, packed: string): Promise<string> {
  const parts = String(packed ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("pii: unsupported ciphertext format");
  const key = await importKey(env);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(parts[1]) }, key, b64ToBytes(parts[2]));
  return new TextDecoder().decode(pt);
}

/** decryptPii that returns null instead of throwing (display paths). */
export async function tryDecryptPii(env: Pick<Env, "HF_PII_KEY">, packed: string | null | undefined): Promise<string | null> {
  if (!packed) return null;
  try { return await decryptPii(env, packed); } catch { return null; }
}
