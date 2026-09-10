// [WEB-PHONE-OTP-1 2026-09-10] Phone verification by SMS OTP for web sign-up.
//
// OWNER DECISION 2026-09-10: every new web account verifies an Indian mobile
// number by OTP, on the same screen as the email code, before the account is
// opened. Provider is 2Factor.in (https://2factor.in/api-docs). +91 only.
//
// This REINTRODUCES phone OTP, which was removed app-wide on 2026-07-10 (the old
// Twilio path in routes/id.ts). That removal still stands for the app; this is a
// new, web-sign-up-only path with its own provider, and it writes the same
// `contact_verification.phone_verified` column the legacy reader in id.ts reads.
//
// WHY THE ROUTES REQUIRE A SESSION
// The phone step only unlocks after the email code is confirmed, and confirming
// the email is what mints the Clerk session. So every SMS we pay for is behind a
// verified email + Clerk's bot CAPTCHA. An unauthenticated "send SMS" endpoint is
// an SMS-pumping faucet; this one is not.
//
// LIMITS (the phone_otp table is the ledger):
//   * 30 s between sends per account, 5 sends / hour per account,
//   * 5 sends / hour per phone number across all accounts,
//   * a global breaker of 300 sends / hour so an attack cannot drain the balance,
//   * 5 guesses per code, code valid 10 minutes.
//
// ONE VERIFIED NUMBER PER ACCOUNT: a number already verified on another live
// account is refused (phone_taken). An account with a pending/processed deletion
// request releases its number, so deleting a test account frees the phone.
//
//   POST /api/account/phone/send    { phone }  -> { ok, phone, expires_in_s, resend_after_s }
//   POST /api/account/phone/verify  { code }   -> { ok, verified, phone }
//   GET  /api/account/phone/status             -> { verified, phone, has_account, needs_phone }
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { track } from "../hooks";

const APP = "avatok";
const TF_BASE = "https://2factor.in/API/V1";

const OTP_TTL_MS = 10 * 60_000;
const RESEND_GAP_MS = 30_000;
const HOUR_MS = 3_600_000;
const MAX_SENDS_PER_UID_HOUR = 5;
const MAX_SENDS_PER_PHONE_HOUR = 5;
const MAX_SENDS_GLOBAL_HOUR = 300;
const MAX_VERIFY_ATTEMPTS = 5;

/**
 * Web accounts created at or after this moment must have a verified phone.
 * Everyone before it (every app user, every earlier web buyer) is grandfathered,
 * so turning this on never locks an existing person out.
 */
export const PHONE_OTP_REQUIRED_SINCE = Date.UTC(2026, 8, 10, 12, 0, 0);

/** Accepts "98765 43210", "+91 98765 43210", "09876543210". Returns +91XXXXXXXXXX or null. */
export function indianMobileE164(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return "+91" + d;
}

function mask(e164: string): string {
  return e164.slice(0, 3) + "•••••" + e164.slice(-3);
}

type TfResponse = { Status?: string; Details?: string };

async function twoFactor(env: Env, path: string): Promise<TfResponse | null> {
  try {
    const r = await fetch(`${TF_BASE}/${encodeURIComponent(env.TWOFACTOR_API_KEY ?? "")}/${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return (await r.json().catch(() => null)) as TfResponse | null;
  } catch {
    return null;
  }
}

/** Is this number verified on a different, live account? */
async function phoneTakenByOther(env: Env, hash: string, uid: string): Promise<boolean> {
  const row = await env.DB_META.prepare(
    `SELECT cv.uid FROM contact_verification cv
       LEFT JOIN deletion_requests d ON d.uid = cv.uid
      WHERE cv.phone_hash = ?1 AND cv.phone_verified = 1 AND cv.uid <> ?2
        AND (d.uid IS NULL OR d.status = 'cancelled')
      LIMIT 1`,
  ).bind(hash, uid).first<{ uid: string }>().catch(() => null);
  return !!row;
}

export async function phoneOtpSend(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  if (!env.TWOFACTOR_API_KEY) {
    return json({ error: "otp_unavailable", message: "Phone verification isn’t available right now. Please try again shortly." }, 503);
  }

  const b = (await req.json().catch(() => ({}))) as { phone?: unknown };
  const e164 = indianMobileE164(b?.phone);
  if (!e164) {
    return json({ error: "invalid_phone", message: "Enter a 10-digit Indian mobile number.", field: "phone" }, 400);
  }

  const db = env.DB_META;
  const now = Date.now();
  const hash = await sha256Hex(e164);

  const mine = await db.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1")
    .bind(ctx.uid).first<{ phone_verified: number; phone_hash: string | null }>().catch(() => null);
  if (mine && Number(mine.phone_verified) === 1 && mine.phone_hash === hash) {
    return json({ ok: true, already_verified: true, verified: true, phone: e164 });
  }

  if (await phoneTakenByOther(env, hash, ctx.uid)) {
    void track(env, ctx.uid, "phone_otp_send", APP, { outcome: "phone_taken", phone_masked: mask(e164) });
    return json({
      error: "phone_taken",
      message: "This number is already linked to another avaTOK account. Log in to that account, or use a different number.",
      field: "phone",
    }, 409);
  }

  const since = now - HOUR_MS;
  const lim = await db.prepare(
    `SELECT
       (SELECT COUNT(*)        FROM phone_otp WHERE uid=?1 AND created_at>?2)        AS by_uid,
       (SELECT MAX(created_at) FROM phone_otp WHERE uid=?1)                          AS last_uid,
       (SELECT COUNT(*)        FROM phone_otp WHERE phone_hash=?3 AND created_at>?2) AS by_phone,
       (SELECT COUNT(*)        FROM phone_otp WHERE created_at>?2)                   AS global`,
  ).bind(ctx.uid, since, hash).first<{ by_uid: number; last_uid: number | null; by_phone: number; global: number }>();

  if (lim?.last_uid && now - lim.last_uid < RESEND_GAP_MS) {
    const wait = Math.ceil((RESEND_GAP_MS - (now - lim.last_uid)) / 1000);
    return json({ error: "too_soon", message: `Please wait ${wait}s before asking for another code.`, retry_after_s: wait, field: "phone" }, 429);
  }
  if ((lim?.by_uid ?? 0) >= MAX_SENDS_PER_UID_HOUR || (lim?.by_phone ?? 0) >= MAX_SENDS_PER_PHONE_HOUR) {
    void track(env, ctx.uid, "phone_otp_send", APP, { outcome: "rate_limited", by_uid: lim?.by_uid, by_phone: lim?.by_phone, phone_masked: mask(e164) });
    return json({ error: "too_many", message: "Too many codes requested. Please try again in an hour.", field: "phone" }, 429);
  }
  if ((lim?.global ?? 0) >= MAX_SENDS_GLOBAL_HOUR) {
    void track(env, ctx.uid, "phone_otp_send", APP, { outcome: "global_breaker", global: lim?.global });
    return json({ error: "busy", message: "We’re getting a lot of sign-ups right now. Please try again in a few minutes.", field: "phone" }, 429);
  }

  const tpl = (env.TWOFACTOR_OTP_TEMPLATE ?? "").trim();
  const res = await twoFactor(env, `SMS/${e164.slice(1)}/AUTOGEN${tpl ? "/" + encodeURIComponent(tpl) : ""}`);
  const ok = res?.Status === "Success" && !!res.Details;

  // Failed sends are recorded too, so they count against the limits.
  await db.prepare(
    "INSERT INTO phone_otp (uid, phone_hash, e164, session_id, status, attempts, created_at) VALUES (?1,?2,?3,?4,?5,0,?6)",
  ).bind(ctx.uid, hash, e164, ok ? res!.Details! : null, ok ? "sent" : "failed", now).run();

  void track(env, ctx.uid, "phone_otp_send", APP, {
    outcome: ok ? "sent" : "provider_error",
    provider: "2factor",
    provider_detail: ok ? undefined : String(res?.Details ?? "no_response").slice(0, 120),
    phone_masked: mask(e164),
  });

  if (!ok) {
    return json({ error: "send_failed", message: "We couldn’t send the SMS. Check the number and try again.", field: "phone" }, 502);
  }
  return json({ ok: true, phone: e164, expires_in_s: OTP_TTL_MS / 1000, resend_after_s: RESEND_GAP_MS / 1000 });
}

export async function phoneOtpVerify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.TWOFACTOR_API_KEY) {
    return json({ error: "otp_unavailable", message: "Phone verification isn’t available right now. Please try again shortly." }, 503);
  }

  const b = (await req.json().catch(() => ({}))) as { code?: unknown };
  const code = String(b?.code ?? "").replace(/\D/g, "");
  if (!/^\d{4,6}$/.test(code)) {
    return json({ error: "invalid_code", message: "Enter the code from the SMS.", field: "phoneCode" }, 400);
  }

  const db = env.DB_META;
  const now = Date.now();
  const row = await db.prepare(
    "SELECT id, e164, phone_hash, session_id, attempts, created_at FROM phone_otp WHERE uid=?1 AND status='sent' ORDER BY created_at DESC LIMIT 1",
  ).bind(ctx.uid).first<{ id: number; e164: string; phone_hash: string; session_id: string; attempts: number; created_at: number }>();

  if (!row) {
    return json({ error: "no_code", message: "Send a code to your phone first.", field: "phoneCode" }, 400);
  }
  if (now - row.created_at > OTP_TTL_MS) {
    await db.prepare("UPDATE phone_otp SET status='expired' WHERE id=?1").bind(row.id).run();
    return json({ error: "code_expired", message: "That code has expired. Tap resend for a new one.", field: "phoneCode" }, 410);
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    return json({ error: "too_many_attempts", message: "Too many wrong tries. Tap resend for a new code.", field: "phoneCode" }, 429);
  }

  await db.prepare("UPDATE phone_otp SET attempts=attempts+1 WHERE id=?1").bind(row.id).run();

  const res = await twoFactor(env, `SMS/VERIFY/${encodeURIComponent(row.session_id)}/${code}`);
  if (!res) {
    void track(env, ctx.uid, "phone_otp_verify", APP, { outcome: "provider_unreachable", phone_masked: mask(row.e164) });
    return json({ error: "verify_failed", message: "We couldn’t check the code just now. Please try again.", field: "phoneCode" }, 502);
  }
  const matched = res.Status === "Success" && /match/i.test(String(res.Details ?? ""));
  if (!matched) {
    const expired = /expire/i.test(String(res.Details ?? ""));
    const left = Math.max(0, MAX_VERIFY_ATTEMPTS - (row.attempts + 1));
    void track(env, ctx.uid, "phone_otp_verify", APP, {
      outcome: expired ? "expired" : "mismatch", attempts_left: left,
      provider_detail: String(res.Details ?? "").slice(0, 120), phone_masked: mask(row.e164),
    });
    if (expired) {
      await db.prepare("UPDATE phone_otp SET status='expired' WHERE id=?1").bind(row.id).run();
      return json({ error: "code_expired", message: "That code has expired. Tap resend for a new one.", field: "phoneCode" }, 410);
    }
    return json({
      error: "wrong_code",
      message: left > 0 ? `That code isn’t right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code isn’t right. Tap resend for a new one.",
      attempts_left: left, field: "phoneCode",
    }, 400);
  }

  // A race: someone else verified the same number between send and verify.
  if (await phoneTakenByOther(env, row.phone_hash, ctx.uid)) {
    return json({ error: "phone_taken", message: "This number is already linked to another avaTOK account.", field: "phone" }, 409);
  }

  await db.batch([
    db.prepare("UPDATE phone_otp SET status='verified', verified_at=?2 WHERE id=?1").bind(row.id, now),
    db.prepare(
      `INSERT INTO contact_verification (uid, phone_verified, phone_hash, phone_verified_at, updated_at)
       VALUES (?1, 1, ?2, ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET phone_verified=1, phone_hash=excluded.phone_hash,
         phone_verified_at=excluded.phone_verified_at, updated_at=excluded.updated_at`,
    ).bind(ctx.uid, row.phone_hash, now),
  ]);

  void track(env, ctx.uid, "phone_otp_verify", APP, {
    outcome: "verified", provider: "2factor", attempts: row.attempts + 1,
    ms_since_send: now - row.created_at, phone: row.e164,
  });
  return json({ ok: true, verified: true, phone: row.e164 });
}

export async function phoneOtpStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const db = env.DB_META;
  const cv = await db.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1")
    .bind(ctx.uid).first<{ phone_verified: number; phone_hash: string | null }>().catch(() => null);
  const verified = !!cv && Number(cv.phone_verified) === 1;

  let phone: string | null = null;
  if (verified && cv?.phone_hash) {
    const r = await db.prepare("SELECT e164 FROM phone_otp WHERE uid=?1 AND phone_hash=?2 AND status='verified' ORDER BY verified_at DESC LIMIT 1")
      .bind(ctx.uid, cv.phone_hash).first<{ e164: string }>().catch(() => null);
    phone = r?.e164 ?? null;
  }

  const u = await db.prepare("SELECT created_via, created_at FROM users WHERE uid=?1")
    .bind(ctx.uid).first<{ created_via: string | null; created_at: number | null }>().catch(() => null);

  // No row yet = a brand-new web account (email-code or Google) that has not been
  // opened. A web-born row created since launch also owes the phone. Everyone
  // else — app users, earlier web buyers — is grandfathered.
  const needsPhone = !verified && (
    !u || (u.created_via === "web" && Number(u.created_at ?? 0) >= PHONE_OTP_REQUIRED_SINCE)
  );

  return json({ verified, phone, has_account: !!u, needs_phone: needsPhone });
}

/** For /api/account/bootstrap: is this exact number the account's verified phone? */
export async function isVerifiedPhoneFor(env: Env, uid: string, e164: string): Promise<boolean> {
  const hash = await sha256Hex(e164);
  const cv = await env.DB_META.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1")
    .bind(uid).first<{ phone_verified: number; phone_hash: string | null }>().catch(() => null);
  return !!cv && Number(cv.phone_verified) === 1 && cv.phone_hash === hash;
}
