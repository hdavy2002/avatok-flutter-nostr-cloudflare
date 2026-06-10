// Cloudflare-native auth (Nostr deprecated). Identity = Clerk user id (uid).
// Replaces the NIP-98 signature gate for all NEW (messaging) routes. The Clerk
// JWT is verified at the edge (reusing verifyClerk from auth.ts); the uid comes
// from the verified token `sub`, never from the request body.
import type { Env } from "./types";
import { verifyClerk } from "./auth";

export interface UserCtx { uid: string; }
export interface AuthFail { error: string; status: number; }
export function isFail(x: UserCtx | AuthFail): x is AuthFail {
  return (x as AuthFail).error !== undefined;
}

// Accept the Clerk JWT from the Authorization header OR a ?token= query param
// (WebSocket clients that can't set headers). Returns the uid or a failure.
export async function requireUser(req: Request, env: Env): Promise<UserCtx | AuthFail> {
  let bearer = req.headers.get("authorization");
  if (!bearer) {
    const t = new URL(req.url).searchParams.get("token");
    if (t) bearer = "Bearer " + t;
  }
  const clerk = await verifyClerk(env, bearer);
  if ("skipped" in clerk) return { error: "auth not configured", status: 500 };
  if ("error" in clerk) return { error: "auth: " + clerk.error, status: 401 };
  const uid = clerk.clerkUserId;

  // Account-status ban gate (account_status is already keyed by clerk_user_id).
  const st = await env.DB_META
    .prepare("SELECT status, blocked_until FROM account_status WHERE clerk_user_id = ?1")
    .bind(uid).first<{ status: string; blocked_until: number | null }>();
  if (st) {
    if (st.status === "perm_banned") return { error: "account banned", status: 403 };
    if (st.status === "temp_blocked" && (!st.blocked_until || Date.now() < st.blocked_until)) {
      return { error: "account temporarily blocked", status: 403 };
    }
  }
  return { uid };
}

// KYC gate — sending / posting / transacting require a verified Stripe Identity.
export async function kycVerified(env: Env, uid: string): Promise<boolean> {
  const r = await env.DB_META
    .prepare("SELECT status FROM kyc_status WHERE uid = ?1")
    .bind(uid).first<{ status: string }>();
  return r?.status === "verified";
}

// Phase 3 — hard KYC gate for routes (payout setup/request now; consult- and
// live-listing creation in Phase 6). One gate, two providers: kyc_status is
// written by BOTH the Rekognition liveness path and the Stripe Identity path.
// Returns null when verified, or an AuthFail the route should surface as-is.
export async function requireKyc(env: Env, uid: string): Promise<AuthFail | null> {
  if (await kycVerified(env, uid)) return null;
  return { error: "identity verification required", status: 403 };
}

// Hard block — does `owner` block `other`? (recipient blocks sender → no delivery)
// Consolidated on the `blocks` table (uid renamed; blocked_npub holds a uid value),
// which social.ts manages — so the messaging gate honours the same block list.
export async function blocks(env: Env, owner: string, other: string): Promise<boolean> {
  const r = await env.DB_META
    .prepare("SELECT 1 FROM blocks WHERE uid = ?1 AND blocked_npub = ?2")
    .bind(owner, other).first();
  return !!r;
}

// Deterministic 1:1 conversation id (both sides resolve the same id).
export function dmConvId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `dm_${lo}__${hi}`;
}
