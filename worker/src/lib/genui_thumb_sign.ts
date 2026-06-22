// genui_thumb_sign.ts — short-lived HMAC signing for GenUI preview thumbnails.
//
// Private connector thumbnails (e.g. Google Drive's thumbnailLink) are
// auth-gated: the app can't load them directly. Instead the worker mints a
// signed, expiring URL into our /api/ava/genui/thumb proxy. The client loads it
// as a plain cached image (no auth header to thread through the renderer), and
// the proxy validates the signature before fetching the bytes with the user's
// stored OAuth token. The exp is bucketed to the hour so the URL is STABLE
// within its window → friendly to the on-device + edge image caches.

import type { Env } from "../types";

function secretOf(env: Env): string {
  // Reuse an existing HMAC secret; never falls back to empty (would forge-allow).
  return env.JOIN_LINK_SECRET || env.GUEST_TOKEN_SECRET || "avatok-genui-thumb";
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Mint a relative, signed thumbnail proxy URL for one file. */
export async function signThumbUrl(env: Env, uid: string, fileId: string, ttlSec = 7200): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Floor to the hour, then add TTL → identical URL for everyone within the hour
  // (cache-friendly) while still expiring.
  const exp = Math.floor(now / 3600) * 3600 + ttlSec;
  const sig = await hmacHex(secretOf(env), `${fileId}.${uid}.${exp}`);
  const q = new URLSearchParams({ i: fileId, u: uid, e: String(exp), s: sig });
  return `/api/ava/genui/thumb?${q.toString()}`;
}

/** Validate a signed thumbnail request (constant-time compare, not expired). */
export async function verifyThumb(env: Env, i: string, u: string, e: string, s: string): Promise<boolean> {
  const exp = Number(e);
  if (!i || !u || !exp || exp < Math.floor(Date.now() / 1000)) return false;
  const want = await hmacHex(secretOf(env), `${i}.${u}.${exp}`);
  if (want.length !== s.length) return false;
  let diff = 0;
  for (let k = 0; k < want.length; k++) diff |= want.charCodeAt(k) ^ s.charCodeAt(k);
  return diff === 0;
}
