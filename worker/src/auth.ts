// Auth: Clerk JWT (RS256) verified against cached JWKS proves the account. Nostr
// NIP-98 request signing was removed 2026-07-02 — Clerk is the sole authority.
import type { Env } from "./types";
import { metaSession } from "./db/shard";

function b64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(norm);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---- Clerk JWT (RS256) verified against cached JWKS ----
async function getJwks(env: Env): Promise<any[] | null> {
  if (!env.CLERK_JWKS_URL) return null;
  const cached = await env.TOKENS.get("jwks:clerk");
  if (cached) return JSON.parse(cached);
  const res = await fetch(env.CLERK_JWKS_URL);
  if (!res.ok) return null;
  const body = (await res.json()) as any;
  const keys = body.keys || [];
  await env.TOKENS.put("jwks:clerk", JSON.stringify(keys), { expirationTtl: 3600 });
  return keys;
}

type ClerkResult = { clerkUserId: string } | { error: string } | { skipped: true };
export async function verifyClerk(env: Env, bearer: string | null): Promise<ClerkResult> {
  if (!env.CLERK_JWKS_URL) return { skipped: true };
  if (!bearer) return { error: "missing bearer" };
  const jwt = bearer.replace(/^Bearer\s+/i, "");
  const parts = jwt.split(".");
  if (parts.length !== 3) return { error: "bad jwt" };
  let header: any, payload: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch { return { error: "bad jwt segments" }; }
  const keys = await getJwks(env);
  if (!keys) return { error: "jwks unavailable" };
  const jwk = keys.find((k: any) => k.kid === header.kid);
  if (!jwk) return { error: "unknown kid" };
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!ok) return { error: "bad signature" };
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > Number(payload.exp)) return { error: "expired" };
  if (env.CLERK_ISSUER && payload.iss && payload.iss !== env.CLERK_ISSUER) return { error: "bad issuer" };
  return { clerkUserId: String(payload.sub) };
}

// ---- Tier-2 gate, KV-cached (spec §4 / §10.4: verified:{npub}, 1h TTL) ----
// requireVerifiedKV is the canonical Tier-2 check for new routes. It reads the KV
// cache first (one fast lookup), falling back to the source of truth in D1
// (clerk_nostr_link.tier) and back-filling the cache. Returns true iff verified.
const VERIFIED_TTL = 3600; // 1 hour

export async function setVerifiedCache(env: Env, npub: string, verified: boolean): Promise<void> {
  try {
    if (verified) await env.TOKENS.put(`verified:${npub}`, "1", { expirationTtl: VERIFIED_TTL });
    else await env.TOKENS.delete(`verified:${npub}`);
  } catch { /* best-effort cache */ }
}

export async function requireVerifiedKV(env: Env, npub: string): Promise<boolean> {
  try {
    const cached = await env.TOKENS.get(`verified:${npub}`);
    if (cached === "1") return true;
  } catch { /* fall through to D1 */ }
  const row = await metaSession(env)
    .prepare("SELECT tier FROM clerk_nostr_link WHERE npub=?1")
    .bind(npub).first<{ tier: string }>();
  const verified = row?.tier === "verified";
  if (verified) await setVerifiedCache(env, npub, true);
  return verified;
}
