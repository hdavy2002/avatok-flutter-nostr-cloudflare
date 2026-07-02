// AvaReferral — "invite a friend, earn coins" (2026-06-18).
//
// Product rules (owner decisions):
//   • The INVITER earns REWARD_COINS when a person they invited JOINS and
//     qualifies. The joiner gets nothing (one-sided).
//   • Qualified join = the invitee finishes a VERIFIED login on a NEW account
//     (a real Clerk uid, not a `guest:` handle-only account) within
//     CLAIM_WINDOW_MS of account creation.
//   • Anti-fraud: self-referral blocked; one reward per invitee ever
//     (op_id `referral:<invitee>` + PK on referred_uid); device/IP de-dup so one
//     phone can't farm rewards via many Google accounts; per-inviter CAP.
//   • Reversible: the reward is paid into the wallet's 7-day HOLD (DO `earn`), so
//     a flagged-fraud invitee can be clawed back via `reverseReferral` while held.
//
// SERVER-AUTHORITATIVE: the client never sends an amount. It only calls
// /api/referral/claim with the inviter's code (handle) it captured from the
// invite link; the server decides everything (who, whether, how much).
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { walletOp } from "./wallet";
import { track, metric } from "../hooks";
import { notifyUser } from "../notify";

// Economics (CANONICAL site-wide): 1 USD = 100 coins (1 coin = $0.01).
// REWARD_COINS=10 ⇒ $0.10.
const REWARD_COINS = 10;
const REFERRER_CAP = 20;                       // max rewarded invites per inviter
const CLAIM_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // joiner must claim within 14d of signup
const APP = "avareferral";

async function ensureTable(env: Env): Promise<void> {
  await metaDb(env).exec(
    "CREATE TABLE IF NOT EXISTS referral_attributions (" +
      "referred_uid TEXT PRIMARY KEY, referrer_uid TEXT NOT NULL, source TEXT, " +
      "device_hash TEXT, ip_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', " +
      "reward_coins INTEGER NOT NULL DEFAULT 0, bound_at INTEGER NOT NULL, credited_at INTEGER)",
  );
}

function clientIp(req: Request): string | null {
  return req.headers.get("CF-Connecting-IP") || req.headers.get("x-real-ip") || null;
}

/** Resolve an invite code (a handle, optionally `@`-prefixed, or a raw uid) to a uid. */
async function resolveReferrer(env: Env, code: string): Promise<string | null> {
  const c = code.trim().replace(/^@/, "");
  if (!c) return null;
  const row = await metaDb(env)
    .prepare("SELECT uid FROM users WHERE handle = ?1 OR uid = ?1 LIMIT 1")
    .bind(c)
    .first<{ uid: string }>();
  return row?.uid ?? null;
}

// POST /api/referral/claim  { code, device_id? }
// Called ONCE by a newly-joined, verified user. Credits the inviter, not the caller.
export async function referralClaim(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTable(env);

  const referred = ctx.uid;
  // Must be a verified, non-guest account (the anti-fraud "qualified join" gate).
  if (referred.startsWith("guest:")) {
    return json({ ok: false, reason: "verify_required", error: "finish sign-in before claiming a referral" }, 403);
  }

  const b = (await req.json().catch(() => ({}))) as { code?: string; device_id?: string };
  const referrer = await resolveReferrer(env, String(b.code || ""));
  if (!referrer) return json({ ok: false, reason: "unknown_code" }, 404);
  if (referrer === referred) return json({ ok: false, reason: "self_referral" }, 400);

  const db = metaDb(env);

  // Already bound? One attribution per invitee, ever.
  const existing = await db.prepare("SELECT status FROM referral_attributions WHERE referred_uid=?1")
    .bind(referred).first<{ status: string }>();
  if (existing) return json({ ok: existing.status === "credited", reason: "already_claimed", status: existing.status });

  // Joiner must be a NEW account (blocks old accounts retro-claiming).
  const me = await db.prepare("SELECT created_at FROM users WHERE uid=?1").bind(referred).first<{ created_at: number }>();
  if (!me) return json({ ok: false, reason: "account_not_found" }, 404);
  if (me.created_at && Date.now() - Number(me.created_at) > CLAIM_WINDOW_MS) {
    return json({ ok: false, reason: "claim_window_closed" }, 400);
  }

  const deviceHash = b.device_id ? await sha256Hex(String(b.device_id)) : null;
  const ip = clientIp(req);
  const ipHash = ip ? (await sha256Hex(ip)).slice(0, 24) : null;

  // Device/IP de-dup: a device or IP that already earned a CREDITED referral
  // can't mint another (one phone making many Google accounts).
  if (deviceHash) {
    const dupDev = await db.prepare("SELECT 1 AS x FROM referral_attributions WHERE device_hash=?1 AND status='credited' LIMIT 1")
      .bind(deviceHash).first<{ x: number }>();
    if (dupDev) {
      await recordRejected(env, referred, referrer, "device_dup", deviceHash, ipHash);
      return json({ ok: false, reason: "device_already_rewarded" }, 409);
    }
  }

  // Per-inviter cap.
  const credited = await db.prepare("SELECT COUNT(*) AS n FROM referral_attributions WHERE referrer_uid=?1 AND status='credited'")
    .bind(referrer).first<{ n: number }>();
  if (Number(credited?.n ?? 0) >= REFERRER_CAP) {
    await recordRejected(env, referred, referrer, "referrer_cap", deviceHash, ipHash);
    return json({ ok: false, reason: "referrer_cap_reached" }, 200);
  }

  const now = Date.now();
  // Record the binding first (pending), so a mid-flight retry can't double-bind.
  try {
    await db.prepare(
      "INSERT INTO referral_attributions (referred_uid, referrer_uid, source, device_hash, ip_hash, status, reward_coins, bound_at) " +
        "VALUES (?1,?2,'invite',?3,?4,'pending',0,?5)",
    ).bind(referred, referrer, deviceHash, ipHash, now).run();
  } catch {
    return json({ ok: false, reason: "already_claimed" }, 200); // PK race → someone bound first
  }

  // Credit the INVITER into the 7-day hold (reversible). Idempotent by op_id.
  const credit = await walletOp(env, referrer, {
    op: "earn", uid: referrer, amount: REWARD_COINS, commission: 0,
    app_name: APP, counterparty_uid: referred, ref: `referral:${referred}`,
    op_id: `referral:${referred}`,
    ledger: { credit: `user:${referrer}`, type: "referral", ref: `referral:${referred}`,
      meta: JSON.stringify({ title: `Referral reward (+${REWARD_COINS} coins)` }) },
  });
  if (credit.status !== 200) {
    await db.prepare("UPDATE referral_attributions SET status='rejected' WHERE referred_uid=?1").bind(referred).run();
    return json({ ok: false, reason: "credit_failed", detail: credit.body }, 502);
  }

  await db.prepare("UPDATE referral_attributions SET status='credited', reward_coins=?2, credited_at=?3 WHERE referred_uid=?1")
    .bind(referred, REWARD_COINS, now).run();

  track(env, referrer, "referral_rewarded", APP, { reward: REWARD_COINS });
  metric(env, "referral_rewarded", [REWARD_COINS]);
  try {
    await notifyUser(env, referrer, {
      type: "wallet", title: `+${REWARD_COINS} coins — your invite joined!`,
      body: "Available after a short hold.", data: { deeplink: "/wallet", amount: REWARD_COINS },
    });
  } catch { /* best-effort */ }

  return json({ ok: true, credited: true, reward_coins: REWARD_COINS, referrer });
}

async function recordRejected(env: Env, referred: string, referrer: string, reason: string, dev: string | null, ip: string | null): Promise<void> {
  try {
    await metaDb(env).prepare(
      "INSERT INTO referral_attributions (referred_uid, referrer_uid, source, device_hash, ip_hash, status, reward_coins, bound_at) " +
        "VALUES (?1,?2,?3,?4,?5,'rejected',0,?6) ON CONFLICT(referred_uid) DO NOTHING",
    ).bind(referred, referrer, reason, dev, ip, Date.now()).run();
  } catch { /* best-effort */ }
}

// GET /api/referral/summary — stats for the inviter's Invite screen.
export async function referralSummary(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTable(env);
  const db = metaDb(env);
  const row = await db.prepare(
    "SELECT COUNT(*) FILTER (WHERE status='credited') AS rewarded, " +
      "COALESCE(SUM(reward_coins),0) AS coins_earned, " +
      "COUNT(*) AS total FROM referral_attributions WHERE referrer_uid=?1",
  ).bind(ctx.uid).first<{ rewarded: number; coins_earned: number; total: number }>();
  const rewarded = Number(row?.rewarded ?? 0);
  return json({
    reward_coins: REWARD_COINS,
    rewarded_invites: rewarded,
    coins_earned: Number(row?.coins_earned ?? 0),
    cap: REFERRER_CAP,
    cap_remaining: Math.max(0, REFERRER_CAP - rewarded),
  });
}

// Admin/fraud: claw back a still-held referral reward and mark it reversed.
export async function reverseReferral(env: Env, referredUid: string, reason: string): Promise<boolean> {
  await ensureTable(env);
  const db = metaDb(env);
  const a = await db.prepare("SELECT referrer_uid, reward_coins, status FROM referral_attributions WHERE referred_uid=?1")
    .bind(referredUid).first<{ referrer_uid: string; reward_coins: number; status: string }>();
  if (!a || a.status !== "credited") return false;
  await walletOp(env, a.referrer_uid, {
    op: "debit_hold", uid: a.referrer_uid, amount: a.reward_coins, app_name: APP,
    ref: `referral_reversal:${referredUid}`, op_id: `referral_reversal:${referredUid}`,
  });
  await db.prepare("UPDATE referral_attributions SET status='reversed' WHERE referred_uid=?1").bind(referredUid).run();
  track(env, a.referrer_uid, "referral_reversed", APP, { reason, coins: a.reward_coins });
  return true;
}
