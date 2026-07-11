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

// ---- [ACCT-RELINK-1] Clerk uid alias resolution ----
// An account is keyed by its ORIGINAL Clerk uid (users.uid). If that Clerk user is
// destroyed and the same person re-authenticates, Clerk mints a NEW id that no
// longer matches. /api/me creates an alias (new id -> original uid) on an
// email-verified relink; this helper makes EVERY authenticated request resolve the
// new id back to the original uid, so all uid-keyed data (InboxDO messages, wallet,
// media) stays reachable. We alias, never re-key — DO storage is bound to the
// original uid and can't be moved.
//
// Fail-open + defensive: the alias table may not exist yet (migration lags deploy),
// so a missing table / DB error simply returns the id unchanged (today's behaviour).
const ALIAS_PREFIX = "alias:";        // KV: alias:{clerkId} -> canonical uid ("-" = none)
const ALIAS_TTL = 6 * 60 * 60;        // 6h for a positive alias
const ALIAS_MISS_TTL = 120;           // 2min for a negative (bounds staleness after a relink)

export async function resolveCanonicalUid(env: Env, clerkId: string): Promise<string> {
  if (!clerkId) return clerkId;
  try {
    const cached = await env.TOKENS.get(ALIAS_PREFIX + clerkId);
    if (cached === "-") return clerkId;
    if (cached) return cached;
  } catch { /* fall through to D1 */ }
  try {
    const row = await metaSession(env)
      .prepare("SELECT canonical_uid FROM clerk_uid_alias WHERE alias_clerk_id=?1")
      .bind(clerkId).first<{ canonical_uid: string }>();
    const canon = row?.canonical_uid ? String(row.canonical_uid) : null;
    try {
      await env.TOKENS.put(ALIAS_PREFIX + clerkId, canon ?? "-",
        { expirationTtl: canon ? ALIAS_TTL : ALIAS_MISS_TTL });
    } catch { /* best-effort cache */ }
    return canon ?? clerkId;
  } catch {
    return clerkId; // table missing / DB error → behave exactly as before aliasing
  }
}

// Record new-Clerk-id -> original-account-uid. Idempotent. Best-effort: if the
// table isn't there yet the relink just won't persist (caller still returns the
// restored profile for this request).
export async function linkClerkAlias(
  env: Env, aliasClerkId: string, canonicalUid: string, reason = "email_relink",
): Promise<void> {
  if (!aliasClerkId || !canonicalUid || aliasClerkId === canonicalUid) return;
  try {
    await env.DB_META.prepare(
      "INSERT INTO clerk_uid_alias (alias_clerk_id, canonical_uid, reason, created_at) " +
      "VALUES (?1,?2,?3,?4) ON CONFLICT(alias_clerk_id) DO UPDATE SET canonical_uid=?2, reason=?3, created_at=?4",
    ).bind(aliasClerkId, canonicalUid, reason, Date.now()).run();
    try { await env.TOKENS.put(ALIAS_PREFIX + aliasClerkId, canonicalUid, { expirationTtl: ALIAS_TTL }); } catch { /* best-effort */ }
  } catch { /* table may not exist yet — non-fatal */ }
}

// ---- Tier-2 gate, KV-cached (spec §4 / §10.4: verified:{uid}, 1h TTL) ----
// requireVerifiedKV is the canonical Tier-2 check for new routes. It reads the KV
// cache first (one fast lookup), falling back to the source of truth in D1
// (clerk_account_link.tier) and back-filling the cache. Returns true iff verified.
const VERIFIED_TTL = 3600; // 1 hour

export async function setVerifiedCache(env: Env, uid: string, verified: boolean): Promise<void> {
  try {
    if (verified) await env.TOKENS.put(`verified:${uid}`, "1", { expirationTtl: VERIFIED_TTL });
    else await env.TOKENS.delete(`verified:${uid}`);
  } catch { /* best-effort cache */ }
}

export async function requireVerifiedKV(env: Env, uid: string): Promise<boolean> {
  try {
    const cached = await env.TOKENS.get(`verified:${uid}`);
    if (cached === "1") return true;
  } catch { /* fall through to D1 */ }
  const row = await metaSession(env)
    .prepare("SELECT tier FROM clerk_account_link WHERE uid=?1")
    .bind(uid).first<{ tier: string }>();
  const verified = row?.tier === "verified";
  if (verified) await setVerifiedCache(env, uid, true);
  return verified;
}
