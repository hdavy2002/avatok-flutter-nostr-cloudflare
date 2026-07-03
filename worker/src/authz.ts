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

// STREAM H (AI Messenger Batch) — [LIVE-GATE-5] onboarding liveness gate.
// Bypass-proof server enforcement of the "human check" hard gate (client gate is
// NOT the gate). When platform_config.livenessOnboardingGate is ON, any account
// WITHOUT a verified liveness/KYC proof is `liveness_required` and spam-capable
// routes (message send, group create/join, forwarding, listing publish) reject
// with 403 { error:'liveness_required' }. Default OFF (ships dark; flip in KV).
//
// Reusable helper — Stream I (forwarding) and the message-send path consume this:
//   requireLiveness(env, uid): Promise<AuthFail | null>
//     → null    when the gate is OFF, or the uid has a verified liveness proof
//     → { error:'liveness_required', status:403 }  otherwise (surface as-is)
export async function livenessOnboardingGateOn(env: Env): Promise<boolean> {
  try {
    const cfg = ((await env.TOKENS.get("platform_config", "json")) ?? {}) as Record<string, unknown>;
    // Fail-safe DARK: only ON when the key is explicitly true (absent → OFF).
    return cfg.livenessOnboardingGate === true;
  } catch {
    return false; // config read failed → do not lock users out
  }
}

export async function requireLiveness(env: Env, uid: string, route?: string): Promise<AuthFail | null> {
  if (!(await livenessOnboardingGateOn(env))) return null; // kill switch / dark
  if (await kycVerified(env, uid)) return null;             // liveness OR stripe both write kyc_status
  // STREAM H [LIVE-GATE-6]: telemetry for a blocked spam-capable action (uid-stamped).
  if (route) {
    try {
      env.Q_ANALYTICS?.send({
        event: "liveness_gate_blocked_action", uid, ts: Date.now(),
        props: { route, worker: true, account_id: uid, app_name: "avaid" },
      });
    } catch { /* best-effort */ }
  }
  return { error: "liveness_required", status: 403 };
}

// Trust Ladder L3 — payouts specifically need DOCUMENT KYC (Stripe Identity),
// not just liveness. Liveness (any provider) keeps satisfying requireKyc for
// creator actions; money leaving the platform requires the stripe provider.
// (PROPOSAL-PROGRESSIVE-IDENTITY.md §6)
export async function requireStripeKyc(env: Env, uid: string): Promise<AuthFail | null> {
  const r = await env.DB_META
    .prepare("SELECT status, provider FROM kyc_status WHERE uid = ?1")
    .bind(uid).first<{ status: string; provider: string | null }>();
  if (r?.status === "verified" && (r.provider ?? "").startsWith("stripe")) return null;
  return { error: "document verification (Stripe Identity) required for payouts", status: 403 };
}

// Hard block — does `owner` block `other`? (recipient blocks sender → no delivery)
// Consolidated on the `blocks` table (uid renamed; blocked_uid holds a uid value),
// which social.ts manages — so the messaging gate honours the same block list.
export async function blocks(env: Env, owner: string, other: string): Promise<boolean> {
  const r = await env.DB_META
    .prepare("SELECT 1 FROM blocks WHERE uid = ?1 AND blocked_uid = ?2")
    .bind(owner, other).first();
  return !!r;
}

// Deterministic 1:1 conversation id (both sides resolve the same id).
export function dmConvId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `dm_${lo}__${hi}`;
}
