// Progressive Identity — the Trust Ladder (Specs/proposals/PROPOSAL-PROGRESSIVE-IDENTITY.md).
//   L0 visitor  — handle-only guest (server-reserved, read-only)
//   L1 member   — Clerk email+password account
//   L2 verified — liveness proof (Workers AI / Rekognition) → creator features + AvaBook/AvaGram/AvaTweet
//   L3 kyc      — Stripe Identity document KYC → payouts
//
// Routes:
//   POST /api/identity/guest    {handle, device_id?}   → reserve handle, mint guest token (no auth)
//   GET  /api/identity/guest/check?handle=             → availability (no auth)
//   POST /api/identity/upgrade  {guest_token}          → merge guest row into the Clerk account (Clerk auth)
//   GET  /api/identity/level                           → {level, proofs} (Clerk auth)
//
// Guest tokens: `g1.<uid>.<exp>.<hmac>` — HMAC-SHA256 keyed by GUEST_TOKEN_SECRET
// (falls back to JOIN_LINK_SECRET). Guests NEVER pass requireUser, so every
// authenticated write route is closed to them by construction; public reads
// (marketplace browsing, profiles) were already unauthenticated.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { metaDb, metaSession } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { track, metric } from "../hooks";

const GUEST_TTL_MS = 90 * 86_400_000;     // 90-day inactivity expiry
const GUEST_TOKEN_TTL_MS = 180 * 86_400_000;
const MAX_GUESTS_PER_IP_DAY = 3;
const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

function guestSecret(env: Env): string | null {
  return env.GUEST_TOKEN_SECRET || env.JOIN_LINK_SECRET || null;
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintGuestToken(env: Env, uid: string): Promise<string | null> {
  const secret = guestSecret(env);
  if (!secret) return null;
  const exp = Date.now() + GUEST_TOKEN_TTL_MS;
  return `g1.${uid}.${exp}.${await hmacHex(secret, `${uid}.${exp}`)}`;
}

export async function verifyGuestToken(env: Env, token: string): Promise<string | null> {
  const secret = guestSecret(env);
  if (!secret) return null;
  const m = /^g1\.(guest:[0-9a-f-]+)\.(\d+)\.([0-9a-f]{64})$/.exec(token || "");
  if (!m) return null;
  const [, uid, expStr, sig] = m;
  if (Date.now() > Number(expStr)) return null;
  const want = await hmacHex(secret, `${uid}.${expStr}`);
  return sig === want ? uid : null;
}

async function ladderEnabled(env: Env, flag: "identityLadderEnabled" | "guestTierEnabled"): Promise<boolean> {
  try {
    const cfg = ((await env.TOKENS.get("platform_config", "json")) ?? {}) as Record<string, unknown>;
    if (flag in cfg) return cfg[flag] !== false;
  } catch { /* default on */ }
  return true;
}

// ── L0: guest reserve ────────────────────────────────────────────────────────

// GET /api/identity/guest/check?handle=
export async function guestHandleCheck(req: Request, env: Env): Promise<Response> {
  const handle = (new URL(req.url).searchParams.get("handle") || "").toLowerCase().trim().replace(/^@/, "");
  if (!HANDLE_RE.test(handle)) return json({ ok: false, reason: "invalid", message: "3–30 chars: a-z, 0-9, _" });
  const taken = await metaSession(env)
    .prepare("SELECT 1 AS t FROM users WHERE handle=?1").bind(handle).first<{ t: number }>();
  return json({ ok: !taken, reason: taken ? "taken" : null });
}

// POST /api/identity/guest  {handle, device_id?}
export async function guestCreate(req: Request, env: Env): Promise<Response> {
  if (!(await ladderEnabled(env, "guestTierEnabled"))) return json({ error: "guest tier disabled" }, 503);
  if (!guestSecret(env)) return json({ error: "guest tier unavailable", reason: "secret_unconfigured" }, 503);

  const b = (await req.json().catch(() => ({}))) as { handle?: string; device_id?: string };
  const handle = String(b.handle || "").toLowerCase().trim().replace(/^@/, "");
  if (!HANDLE_RE.test(handle)) return json({ error: "invalid handle", message: "3–30 chars: a-z, 0-9, _" }, 400);

  // Per-IP rate limit (handle-squatting bots).
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const rlKey = `guest:rl:${await sha256Hex(ip)}`;
  const n = Number((await env.TOKENS.get(rlKey)) || "0");
  if (n >= MAX_GUESTS_PER_IP_DAY) return json({ error: "too many guest accounts today" }, 429);

  const now = Date.now();
  const db = metaDb(env);

  // Opportunistic sweep: recycle handles from guests idle > 90 days.
  try {
    const stale = await db.prepare(
      "SELECT uid FROM guest_accounts WHERE upgraded_uid IS NULL AND last_seen_at < ?1 LIMIT 20",
    ).bind(now - GUEST_TTL_MS).all<{ uid: string }>();
    for (const r of stale.results ?? []) {
      await db.batch([
        db.prepare("DELETE FROM users WHERE uid=?1").bind(r.uid),
        db.prepare("DELETE FROM identity_proofs WHERE uid=?1").bind(r.uid),
        db.prepare("DELETE FROM guest_accounts WHERE uid=?1").bind(r.uid),
      ]);
    }
  } catch { /* best-effort */ }

  const taken = await db.prepare("SELECT uid FROM users WHERE handle=?1").bind(handle).first<{ uid: string }>();
  if (taken) return json({ error: "handle taken" }, 409);

  const uid = `guest:${crypto.randomUUID()}`;
  const deviceHash = b.device_id ? await sha256Hex(String(b.device_id)) : null;
  try {
    await db.batch([
      db.prepare("INSERT INTO users (uid, handle, created_at, updated_at) VALUES (?1,?2,?3,?3)").bind(uid, handle, now),
      db.prepare(
        "INSERT INTO guest_accounts (uid, handle, device_hash, created_at, last_seen_at) VALUES (?1,?2,?3,?4,?4)",
      ).bind(uid, handle, deviceHash, now),
      db.prepare(
        `INSERT INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
         VALUES (?1,'handle','verified','system',?2,?2)`,
      ).bind(uid, now),
    ]);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/UNIQUE|constraint/i.test(msg) && /handle/i.test(msg)) return json({ error: "handle taken" }, 409);
    metric(env, "guest_create_error", [1]);
    return json({ error: "could not reserve handle", detail: msg.slice(0, 200) }, 500);
  }
  await env.TOKENS.put(rlKey, String(n + 1), { expirationTtl: 86_400 });

  const token = await mintGuestToken(env, uid);
  track(env, uid, "guest_created", "identity", { handle });
  metric(env, "guest_created", [1]);
  return json({ uid, handle, guest_token: token, level: 0 });
}

// POST /api/identity/upgrade  {guest_token}  — Clerk-authenticated merge.
export async function guestUpgrade(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as { guest_token?: string };
  const guestUid = await verifyGuestToken(env, String(b.guest_token || ""));
  if (!guestUid) return json({ error: "invalid guest token" }, 400);

  const db = metaDb(env);
  const g = await db.prepare("SELECT handle, upgraded_uid FROM guest_accounts WHERE uid=?1")
    .bind(guestUid).first<{ handle: string; upgraded_uid: string | null }>();
  if (!g) return json({ error: "guest not found (expired?)" }, 404);
  if (g.upgraded_uid && g.upgraded_uid !== ctx.uid) return json({ error: "already upgraded by another account" }, 409);
  if (g.upgraded_uid === ctx.uid) return json({ ok: true, handle: g.handle, already: true });

  const now = Date.now();
  // Atomic, idempotent re-key: hand the reserved handle to the Clerk uid.
  await db.batch([
    db.prepare("DELETE FROM users WHERE uid=?1").bind(guestUid),
    db.prepare(
      `INSERT INTO users (uid, handle, created_at, updated_at) VALUES (?1,?2,?3,?3)
       ON CONFLICT(uid) DO UPDATE SET handle=COALESCE(users.handle, ?2), updated_at=?3`,
    ).bind(ctx.uid, g.handle, now),
    db.prepare("UPDATE guest_accounts SET upgraded_uid=?2, last_seen_at=?3 WHERE uid=?1")
      .bind(guestUid, ctx.uid, now),
    db.prepare("DELETE FROM identity_proofs WHERE uid=?1").bind(guestUid),
    db.prepare(
      `INSERT INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
       VALUES (?1,'handle','verified','system',?2,?2)
       ON CONFLICT(uid, proof) DO UPDATE SET status='verified', updated_at=?2`,
    ).bind(ctx.uid, now),
  ]);

  track(env, ctx.uid, "guest_upgraded", "identity", { handle: g.handle });
  metric(env, "guest_upgraded", [1]);
  return json({ ok: true, handle: g.handle });
}

// ── Level computation + gate ─────────────────────────────────────────────────

export interface LadderState {
  level: 0 | 1 | 2 | 3;
  proofs: Record<string, { status: string; provider: string | null; verified_at: number | null }>;
}

export async function computeLevel(env: Env, uid: string): Promise<LadderState> {
  if (uid.startsWith("guest:")) return { level: 0, proofs: {} };

  // KV cache (60 s) — every gated route calls this.
  const ck = `idlevel:${uid}`;
  try {
    const cached = await env.TOKENS.get(ck, "json") as LadderState | null;
    if (cached && typeof cached.level === "number") return cached;
  } catch { /* recompute */ }

  const proofs: LadderState["proofs"] = {};
  try {
    const rows = await metaSession(env)
      .prepare("SELECT proof, status, provider, verified_at FROM identity_proofs WHERE uid=?1")
      .bind(uid).all<{ proof: string; status: string; provider: string | null; verified_at: number | null }>();
    for (const r of rows.results ?? []) proofs[r.proof] = { status: r.status, provider: r.provider, verified_at: r.verified_at };
  } catch { /* table may predate migration */ }

  // kyc_status remains the authoritative L2/L3 source (both writers update it).
  const kyc = await metaSession(env)
    .prepare("SELECT status, provider FROM kyc_status WHERE uid=?1")
    .bind(uid).first<{ status: string; provider: string | null }>();

  let level: 0 | 1 | 2 | 3 = 1; // a Clerk uid is L1 by definition (email+password held by Clerk)
  const liveOk = kyc?.status === "verified" || proofs["liveness"]?.status === "verified";
  if (liveOk) level = 2;
  const stripeOk = (kyc?.status === "verified" && (kyc.provider ?? "").startsWith("stripe"))
    || proofs["stripe_kyc"]?.status === "verified";
  if (stripeOk) level = 3;

  const state: LadderState = { level, proofs };
  try { await env.TOKENS.put(ck, JSON.stringify(state), { expirationTtl: 60 }); } catch { /* best-effort */ }
  return state;
}

/** Shared gate. Returns null when the uid meets `min`, else the AuthFail to surface. */
export async function requireLevel(env: Env, uid: string, min: 1 | 2 | 3):
  Promise<{ error: string; status: number; reason: string; required: number } | null> {
  if (!(await ladderEnabled(env, "identityLadderEnabled"))) return null; // kill switch
  const { level } = await computeLevel(env, uid);
  if (level >= min) return null;
  return { error: "identity level too low", status: 403, reason: "identity_level", required: min };
}

export async function invalidateLevelCache(env: Env, uid: string): Promise<void> {
  try { await env.TOKENS.delete(`idlevel:${uid}`); } catch { /* best-effort */ }
}

// GET /api/identity/level
export async function getIdentityLevel(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const state = await computeLevel(env, ctx.uid);
  return json({ uid: ctx.uid, ...state });
}
