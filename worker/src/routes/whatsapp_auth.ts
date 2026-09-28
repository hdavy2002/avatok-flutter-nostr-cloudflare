// [WA-LOGIN-1 2026-09-28] WhatsApp login — the third sign-in method alongside
// email code and Google, per the owner's 2026-09-28 decision that every website
// user must have a verified WhatsApp number (international numbers allowed, not
// just +91). Reuses routes/phone_otp.ts's ledger (the phone_otp table, its rate
// limits, contact_verification) and lib/otp_sender.ts (WhatsApp via WasenderAPI,
// [WA-OTP-1]) rather than building a second code-send/check path.
//
// UNAUTHENTICATED, so this is a WhatsApp-sending faucet and a ban risk for the
// linked WasenderAPI number (see the warning at the top of lib/otp_sender.ts) —
// treat every limit below as load-bearing, not decorative:
//   * 30 s resend gap per phone (same RESEND_GAP_MS as phone_otp.ts),
//   * 5 sends / hour per phone, 10 sends / hour per IP (only its HASH is stored —
//     never the raw IP),
//   * the SAME 300/hour global breaker phone_otp.ts uses (one shared ledger,
//     one shared cap across every phone-OTP surface),
//   * checkOnWhatsapp() runs BEFORE sending, so a number that plainly isn't on
//     WhatsApp never costs a real send attempt,
//   * 5 verify attempts per code, 10-minute code lifetime (phone_otp.ts's
//     MAX_VERIFY_ATTEMPTS / OTP_TTL_MS).
//
// The send/verify responses never reveal whether a phone number has an account —
// same generic shapes either way.
//
//   POST /api/auth/whatsapp/send   {phone}      -> {ok, phone_masked, expires_in_s, resend_after_s}
//   POST /api/auth/whatsapp/verify {phone, code} -> {ok, status:"signed_in", ticket}
//                                                 | {ok, status:"needs_email", proof, phone_masked}
//
// A number with no live account gets a single-use PROOF (not a session) instead
// of a ticket: the browser still has to complete a real sign-up (email code or
// Google) before that phone can attach to an account. Redeemed by:
//
//   POST /api/account/phone/claim {proof} (signed in) -> {ok, verified:true, phone}
//
// The proof is stored HASHED in KV (env.TOKENS — "ephemeral tokens ONLY", the
// binding's own doc comment in types.ts) rather than D1, since it is exactly the
// kind of short-lived, single-use secret that binding exists for; a JSON
// `expires_at` field alongside a longer KV backstop TTL lets claim tell "never
// existed" (proof_invalid) apart from "expired" (proof_expired) instead of KV's
// TTL silently erasing that distinction.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackUser, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { e164Country } from "../lib/e164_country";
import { mintClerkSignInTicket } from "../lib/clerk_ticket";
import { normalizeE164, INVALID_PHONE_MESSAGE } from "../lib/phone_e164";
import { otpProvider, sendOtp, checkOtp, sendFailMessage, checkOnWhatsapp } from "../lib/otp_sender";
import {
  phoneTakenByOther, verifiedAccountForPhone,
  OTP_TTL_MS, RESEND_GAP_MS, HOUR_MS, MAX_SENDS_GLOBAL_HOUR, MAX_VERIFY_ATTEMPTS,
} from "./phone_otp";

const APP = "avatok";

const WA_LOGIN_MAX_SENDS_PER_PHONE_HOUR = 5;
const WA_LOGIN_MAX_SENDS_PER_IP_HOUR = 10;
const PROOF_TTL_MS = 30 * 60_000;
const PROOF_KV_BACKSTOP_S = 3_600; // generous backstop; expires_at (30 min) is the real enforcement

function mask(e164: string): string {
  return e164.length > 6 ? `${e164.slice(0, 3)}•••••${e164.slice(-3)}` : "•••";
}

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// POST /api/auth/whatsapp/send (unauthenticated)
// ---------------------------------------------------------------------------
export async function whatsappAuthSend(req: Request, env: Env): Promise<Response> {
  if (!otpProvider(env)) {
    return json({ error: "otp_unavailable", message: "WhatsApp sign-in isn’t available right now. Please try again shortly." }, 503);
  }
  const b = (await req.json().catch(() => ({}))) as { phone?: unknown };
  const e164 = normalizeE164(b?.phone);
  if (!e164) return json({ error: "invalid_phone", message: INVALID_PHONE_MESSAGE, field: "phone" }, 400);

  const db = env.DB_META;
  const now = Date.now();
  const hash = await sha256Hex(e164);
  // Only the hash of the IP is ever stored — as a phone_otp.uid placeholder, so
  // the per-IP limit reuses the exact same table/query shape as every other
  // limit here instead of a second ledger.
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ipHash = await sha256Hex(`wa-login-ip|${ip}`);
  const anonUid = `anon:${ipHash.slice(0, 40)}`;

  const lim = await db.prepare(
    `SELECT
       (SELECT MAX(created_at) FROM phone_otp WHERE phone_hash=?1)                AS last_phone,
       (SELECT COUNT(*)        FROM phone_otp WHERE phone_hash=?1 AND created_at>?2) AS by_phone,
       (SELECT COUNT(*)        FROM phone_otp WHERE uid=?3        AND created_at>?2) AS by_ip,
       (SELECT COUNT(*)        FROM phone_otp WHERE created_at>?2)                AS global`,
  ).bind(hash, now - HOUR_MS, anonUid)
    .first<{ last_phone: number | null; by_phone: number; by_ip: number; global: number }>();

  if (lim?.last_phone && now - lim.last_phone < RESEND_GAP_MS) {
    const wait = Math.ceil((RESEND_GAP_MS - (now - lim.last_phone)) / 1000);
    return json({ error: "rate_limited", message: `Please wait ${wait}s before asking for another code.`, retry_after_s: wait }, 429);
  }
  if ((lim?.by_phone ?? 0) >= WA_LOGIN_MAX_SENDS_PER_PHONE_HOUR) {
    void track(env, anonUid, "auth_whatsapp_send", APP, { outcome: "rate_limited_phone", country_code: e164Country(e164) });
    return json({ error: "rate_limited", message: "Too many codes requested for this number. Please try again in an hour." }, 429);
  }
  if ((lim?.by_ip ?? 0) >= WA_LOGIN_MAX_SENDS_PER_IP_HOUR) {
    void track(env, anonUid, "auth_whatsapp_send", APP, { outcome: "rate_limited_ip", country_code: e164Country(e164) });
    return json({ error: "rate_limited", message: "Too many codes requested from this connection. Please try again in an hour." }, 429);
  }
  if ((lim?.global ?? 0) >= MAX_SENDS_GLOBAL_HOUR) {
    void track(env, anonUid, "auth_whatsapp_send", APP, { outcome: "global_breaker" });
    return json({ error: "rate_limited", message: "We’re getting a lot of sign-ins right now. Please try again in a few minutes." }, 429);
  }

  // Fail fast on a number that plainly isn't on WhatsApp, before spending a real
  // send (see the file header). null (couldn't check / not on wasender) falls
  // through to sendOtp, which does the same check as ITS fallback on failure.
  const onWa = await checkOnWhatsapp(env, e164);
  if (onWa === false) {
    void track(env, anonUid, "auth_whatsapp_send", APP, { outcome: "not_on_whatsapp", country_code: e164Country(e164) });
    return json({ error: "not_on_whatsapp", message: "This number isn’t on WhatsApp. Use a mobile number that has WhatsApp." }, 400);
  }

  const sent = await sendOtp(env, e164, OTP_TTL_MS / 60_000);
  // Failed sends are recorded too, so they count against the limits above.
  await db.prepare(
    "INSERT INTO phone_otp (uid, phone_hash, e164, session_id, status, attempts, created_at) VALUES (?1,?2,?3,?4,?5,0,?6)",
  ).bind(anonUid, hash, e164, sent.ok ? sent.sessionId : null, sent.ok ? "sent" : "failed", now).run();

  void track(env, anonUid, "auth_whatsapp_send", APP, {
    outcome: sent.ok ? "sent" : sent.reason, provider: sent.provider, country_code: e164Country(e164),
    phone_masked: mask(e164), ...(sent.ok ? {} : { provider_detail: sent.detail }),
  });

  if (!sent.ok) {
    if (sent.reason === "provider_error") {
      void trackException(env, new Error(`whatsapp_auth_send: ${sent.detail}`), {
        route: "/api/auth/whatsapp/send", method: "POST", handled: true, app_name: APP,
      });
    }
    const status = sent.reason === "not_on_whatsapp" ? 400 : sent.reason === "rate_limited" ? 429 : 502;
    return json({ error: sent.reason, message: sendFailMessage(env, sent.reason) }, status);
  }
  return json({ ok: true, phone_masked: mask(e164), expires_in_s: OTP_TTL_MS / 1000, resend_after_s: RESEND_GAP_MS / 1000 });
}

// ---------------------------------------------------------------------------
// POST /api/auth/whatsapp/verify (unauthenticated)
// ---------------------------------------------------------------------------
export async function whatsappAuthVerify(req: Request, env: Env): Promise<Response> {
  if (!otpProvider(env)) {
    return json({ error: "otp_unavailable", message: "WhatsApp sign-in isn’t available right now. Please try again shortly." }, 503);
  }
  const b = (await req.json().catch(() => ({}))) as { phone?: unknown; code?: unknown };
  const e164 = normalizeE164(b?.phone);
  if (!e164) return json({ error: "invalid_phone", message: INVALID_PHONE_MESSAGE, field: "phone" }, 400);
  const code = String(b?.code ?? "").replace(/\D/g, "");
  if (!/^\d{4,6}$/.test(code)) return json({ error: "invalid_code", message: "Enter the 6-digit code we sent you.", field: "code" }, 400);

  const db = env.DB_META;
  const now = Date.now();
  const hash = await sha256Hex(e164);

  // Latest 'sent' row for this NUMBER — there's no uid to key on yet (the caller
  // isn't authenticated). A dashboard phone-change (routes/me_dashboard.ts
  // mePhoneStart) to the SAME number at the same moment could in principle
  // collide here; the code actually delivered to the number is still what gets
  // checked, so this is a UX edge case (two flows racing), never a security one.
  const row = await db.prepare(
    "SELECT id, e164, phone_hash, session_id, attempts, created_at FROM phone_otp WHERE phone_hash=?1 AND status='sent' ORDER BY created_at DESC LIMIT 1",
  ).bind(hash).first<{ id: number; e164: string; phone_hash: string; session_id: string; attempts: number; created_at: number }>();

  if (!row) return json({ error: "no_code", message: "Send a code to this number first.", field: "code" }, 400);
  if (now - row.created_at > OTP_TTL_MS) {
    await db.prepare("UPDATE phone_otp SET status='expired' WHERE id=?1").bind(row.id).run();
    return json({ error: "code_expired", message: "That code has expired. Ask for a new one.", field: "code" }, 410);
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    return json({ error: "too_many_attempts", message: "Too many wrong tries. Ask for a new code.", field: "code" }, 429);
  }
  await db.prepare("UPDATE phone_otp SET attempts=attempts+1 WHERE id=?1").bind(row.id).run();

  const res = await checkOtp(env, row.session_id, row.e164, code);
  if (res === "unreachable") {
    void trackException(env, new Error("whatsapp_auth_verify: provider_unreachable"), {
      route: "/api/auth/whatsapp/verify", method: "POST", handled: true, app_name: APP,
    });
    return json({ error: "verify_failed", message: "We couldn’t check the code just now. Please try again.", field: "code" }, 502);
  }
  if (res !== "match") {
    const expired = res === "expired";
    const left = Math.max(0, MAX_VERIFY_ATTEMPTS - (row.attempts + 1));
    void track(env, "anon_wa_login", "auth_whatsapp_verify", APP, {
      outcome: expired ? "expired" : "wrong_code", attempts: row.attempts + 1, phone_masked: mask(row.e164),
    });
    if (expired) {
      await db.prepare("UPDATE phone_otp SET status='expired' WHERE id=?1").bind(row.id).run();
      return json({ error: "code_expired", message: "That code has expired. Ask for a new one.", field: "code" }, 410);
    }
    return json({
      error: "wrong_code",
      message: left > 0 ? `That code isn’t right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code isn’t right. Ask for a new one.",
      attempts_left: left, field: "code",
    }, 400);
  }

  await db.prepare("UPDATE phone_otp SET status='verified', verified_at=?2 WHERE id=?1").bind(row.id, now).run();

  // A live account already has this exact number verified -> sign the browser
  // straight in with a Clerk ticket, same mechanism join_link.ts/google_auth.ts use.
  const existingUid = await verifiedAccountForPhone(env, hash);
  if (existingUid) {
    const mint = await mintClerkSignInTicket(env, existingUid);
    if (!mint.ok) {
      void trackException(env, new Error(`whatsapp_auth_verify: ticket_${mint.reason}`), {
        uid: existingUid, route: "/api/auth/whatsapp/verify", method: "POST", handled: true, app_name: APP,
      });
      return json({ error: "signin_failed", message: "We couldn’t sign you in just now. Please try again." }, 502);
    }
    const email = await emailFor(env, existingUid).catch(() => null);
    void trackUser(env, existingUid, email, "auth_whatsapp_verify", APP, {
      outcome: "signed_in", attempts: row.attempts + 1, phone_masked: mask(row.e164),
    });
    return json({ ok: true, status: "signed_in", ticket: mint.ticket });
  }

  // No account has this number yet — a single-use PROOF the browser redeems at
  // /api/account/phone/claim once it completes a real sign-up (email/Google).
  const proof = randomToken();
  const proofHash = await sha256Hex(proof);
  const expiresAt = now + PROOF_TTL_MS;
  await env.TOKENS.put(
    `wa_proof:${proofHash}`,
    JSON.stringify({ e164: row.e164, phone_hash: hash, expires_at: expiresAt }),
    { expirationTtl: PROOF_KV_BACKSTOP_S },
  );

  void track(env, "anon_wa_login", "auth_whatsapp_verify", APP, {
    outcome: "needs_email", attempts: row.attempts + 1, phone_masked: mask(row.e164),
  });
  return json({ ok: true, status: "needs_email", proof, phone_masked: mask(row.e164) });
}

// ---------------------------------------------------------------------------
// POST /api/account/phone/claim {proof} (signed in)
// ---------------------------------------------------------------------------
export async function accountPhoneClaim(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const { uid } = auth;

  const b = (await req.json().catch(() => ({}))) as { proof?: unknown };
  const proof = typeof b?.proof === "string" ? b.proof.trim() : "";
  const invalid = () => {
    void track(env, uid, "phone_claim", APP, { outcome: "proof_invalid" });
    return json({ error: "proof_invalid", message: "That verification has expired. Verify your WhatsApp number again." }, 400);
  };
  if (!proof) return invalid();

  const key = `wa_proof:${await sha256Hex(proof)}`;
  const raw = await env.TOKENS.get(key);
  if (!raw) return invalid();

  let parsed: { e164: string; phone_hash: string; expires_at: number } | null = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed.e164 !== "string" || typeof parsed.phone_hash !== "string") {
    await env.TOKENS.delete(key).catch(() => {});
    return invalid();
  }

  const now = Date.now();
  if (now > parsed.expires_at) {
    await env.TOKENS.delete(key).catch(() => {});
    void track(env, uid, "phone_claim", APP, { outcome: "proof_expired" });
    return json({ error: "proof_expired", message: "That verification has expired. Verify your WhatsApp number again." }, 410);
  }

  if (await phoneTakenByOther(env, parsed.phone_hash, uid)) {
    void track(env, uid, "phone_claim", APP, { outcome: "phone_taken" });
    return json({ error: "phone_taken", message: "This number is already linked to another account. Use a different number.", field: "phone" }, 409);
  }

  const db = env.DB_META;
  try {
    await db.batch([
      // Its own phone_otp row (there's no existing 'sent' row for THIS uid to
      // flip to 'verified' — the code was verified anonymously) so
      // status/profile reads keep finding an e164 the same way phoneOtpVerify's
      // callers already do.
      db.prepare(
        "INSERT INTO phone_otp (uid, phone_hash, e164, session_id, status, attempts, created_at, verified_at) VALUES (?1,?2,?3,NULL,'verified',0,?4,?4)",
      ).bind(uid, parsed.phone_hash, parsed.e164, now),
      db.prepare(
        `INSERT INTO contact_verification (uid, phone_verified, phone_hash, phone_verified_at, updated_at)
         VALUES (?1, 1, ?2, ?3, ?3)
         ON CONFLICT(uid) DO UPDATE SET phone_verified=1, phone_hash=excluded.phone_hash,
           phone_verified_at=excluded.phone_verified_at, updated_at=excluded.updated_at`,
      ).bind(uid, parsed.phone_hash, now),
      // Mirrors lib/me_dashboard_data.ts's phoneSwapStatements: users.phone_hash
      // only moves for a row that already had one (web_account.ts bootstrap sets it).
      db.prepare(
        `UPDATE users SET phone_hash=?2, private_number=CASE WHEN private_number IS NULL THEN NULL ELSE ?3 END, updated_at=?4
          WHERE uid=?1 AND phone_hash IS NOT NULL`,
      ).bind(uid, parsed.phone_hash, parsed.e164, now),
    ]);
  } catch (err) {
    void trackException(env, err, { uid, route: "/api/account/phone/claim", method: "POST", handled: true, app_name: APP });
    return json({ error: "claim_failed", message: "We couldn’t verify that just now. Please try again." }, 503);
  }
  await env.TOKENS.delete(key).catch(() => {});

  const email = await emailFor(env, uid).catch(() => null);
  void trackUser(env, uid, email, "phone_claim", APP, { outcome: "claimed", phone_masked: mask(parsed.e164) });
  return json({ ok: true, verified: true, phone: parsed.e164 });
}
