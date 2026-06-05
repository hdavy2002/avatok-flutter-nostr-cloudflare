// Auth per spec §3.3: NIP-98 proves content authorship (npub), Clerk JWT proves
// the account. Both checked on mutations; tier + account_status gate access.
// Clerk verification is env-gated: until CLERK_JWKS_URL is set, NIP-98 alone
// gates (the app can already sign NIP-98). A console.warn flags the gap.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import type { Env } from "./types";
import { hex, hexToNpub } from "./util";
import { metaSession } from "./db/shard";

export interface AuthCtx {
  npub: string;
  pubkeyHex: string;
  clerkUserId: string | null;
  tier: "basic" | "verified" | "suspended" | "unknown";
  clerkVerified: boolean;
}
export interface AuthErr { error: string; status: number; }
export function isErr(x: AuthCtx | AuthErr): x is AuthErr {
  return (x as AuthErr).error !== undefined;
}

function b64ToStr(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}
function b64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(norm);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---- NIP-98 (kind 27235) ----
function serializeId(e: NostrEventLike): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
}
function tagVal(e: NostrEventLike, name: string): string | undefined {
  return (e.tags || []).find((t) => t[0] === name)?.[1];
}
interface NostrEventLike {
  id: string; pubkey: string; created_at: number; kind: number;
  tags: string[][]; content: string; sig: string;
}

export function verifyNip98(req: Request, headerVal: string | null): { pubkeyHex: string } | { error: string } {
  if (!headerVal) return { error: "missing X-Nostr-Auth" };
  let e: NostrEventLike;
  try { e = JSON.parse(b64ToStr(headerVal)); } catch { return { error: "bad nip98 encoding" }; }
  if (!e || e.kind !== 27235 || !e.id || !e.sig || !/^[0-9a-f]{64}$/.test(e.pubkey)) {
    return { error: "bad nip98 event" };
  }
  if (hex(sha256(serializeId(e))) !== e.id) return { error: "nip98 id mismatch" };
  try { if (!schnorr.verify(e.sig, e.id, e.pubkey)) return { error: "nip98 bad sig" }; }
  catch { return { error: "nip98 verify failed" }; }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(e.created_at)) > 60) return { error: "nip98 stale" };
  const method = (tagVal(e, "method") || "").toUpperCase();
  if (method && method !== req.method.toUpperCase()) return { error: "nip98 method mismatch" };
  const u = tagVal(e, "u");
  if (u) {
    try {
      const a = new URL(u), b = new URL(req.url);
      if (a.origin + a.pathname !== b.origin + b.pathname) return { error: "nip98 url mismatch" };
    } catch { /* tolerate malformed u tag */ }
  }
  return { pubkeyHex: e.pubkey };
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

// ---- Combined gate ----
export async function authenticate(req: Request, env: Env): Promise<AuthCtx | AuthErr> {
  const nip = verifyNip98(req, req.headers.get("x-nostr-auth"));
  if ("error" in nip) return { error: nip.error, status: 401 };
  const npub = hexToNpub(nip.pubkeyHex);
  if (!npub) return { error: "bad pubkey", status: 401 };

  const clerk = await verifyClerk(env, req.headers.get("authorization"));
  let clerkUserId: string | null = null;
  let clerkVerified = false;
  if ("error" in clerk) return { error: "clerk: " + clerk.error, status: 401 };
  if ("clerkUserId" in clerk) { clerkUserId = clerk.clerkUserId; clerkVerified = true; }
  else console.warn("CLERK_JWKS_URL unset — NIP-98 only; account auth not enforced");

  const db = metaSession(env); // replica reads (one session for both lookups)
  let tier: AuthCtx["tier"] = "unknown";
  const link = await db
    .prepare("SELECT tier FROM clerk_nostr_link WHERE npub = ?1")
    .bind(npub).first<{ tier: string }>();
  if (link) tier = link.tier as AuthCtx["tier"];

  const st = await db
    .prepare("SELECT status, blocked_until FROM account_status WHERE npub = ?1")
    .bind(npub).first<{ status: string; blocked_until: number | null }>();
  if (st) {
    if (st.status === "perm_banned") return { error: "account banned", status: 403 };
    if (st.status === "temp_blocked" && (!st.blocked_until || Date.now() < st.blocked_until)) {
      return { error: "account temporarily blocked", status: 403 };
    }
  }
  return { npub, pubkeyHex: nip.pubkeyHex, clerkUserId, tier, clerkVerified };
}

export function requireVerified(ctx: AuthCtx): boolean {
  return ctx.tier === "verified";
}
