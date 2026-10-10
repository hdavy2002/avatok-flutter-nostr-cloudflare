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
//   POST /api/auth/whatsapp/verify {phone, code, client?, age_confirmed?}
//                                               -> {ok, status:"signed_in", ticket}
//                                                | {ok, status:"needs_email", proof, phone_masked}
//
// [HF-AUTH-WA-1] With the server-only flag hfPhoneOnlySignupEnabled ON, an unknown
// number does NOT get needs_email: the Worker creates the Clerk user itself
// (external_id + generated username, no email, no SMS) and the app users row, and
// answers {status:"signed_in", ticket, isNew:true, needs18Plus} (also isNew/needs18Plus
// on every signed_in answer while the flag is on). Flag off = exactly the behaviour
// described below. `client` ("web"|"android"|...) is a telemetry hint only.
// Contract for native clients: Specs/HF-NATIVE-AUTH.md.
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
import { ensureHandle } from "../lib/handles";
import { readConfig } from "./config";
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
const CLERK_API = "https://api.clerk.com/v1";
/** [HF-AUTH-WA-1] How long a phone-only sign-up may hold its claim before another verify may take it over. */
export const SIGNUP_LEASE_MS = 60_000;
/** [HF-AUTH-WA-1] A racing verify waits for the winner this long (POLL_MS x POLL_TRIES) before giving up with 409. */
export const SIGNUP_POLL_MS = 400;
export const SIGNUP_POLL_TRIES = 12;
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
  const b = (await req.json().catch(() => ({}))) as { phone?: unknown; code?: unknown; client?: unknown; age_confirmed?: unknown };
  const e164 = normalizeE164(b?.phone);
  if (!e164) return json({ error: "invalid_phone", message: INVALID_PHONE_MESSAGE, field: "phone" }, 400);
  const client = clientHint(b?.client);
  const ageConfirmed = b?.age_confirmed === true;
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

  // [HF-AUTH-WA-1] Server-only opt-in flag; read once, after the code is proven.
  const phoneOnly = (await readConfig(env).catch(() => null))?.hfPhoneOnlySignupEnabled === true;

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
      outcome: "signed_in", attempts: row.attempts + 1, phone_masked: mask(row.e164), client,
    });
    void track(env, existingUid, "auth_whatsapp_signup", APP, { is_new: false, client });
    if (!phoneOnly) return json({ ok: true, status: "signed_in", ticket: mint.ticket });
    if (ageConfirmed) await storeAgeConfirm(db, existingUid, now, client);
    return json({ ok: true, status: "signed_in", ticket: mint.ticket, isNew: false, needs18Plus: await needs18PlusFor(db, existingUid) });
  }

  if (phoneOnly) return await phoneOnlySignup(env, { e164: row.e164, hash, client, ageConfirmed, attempts: row.attempts + 1, now, otpRowId: row.id });

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
    outcome: "needs_email", attempts: row.attempts + 1, phone_masked: mask(row.e164), client,
  });
  return json({ ok: true, status: "needs_email", proof, phone_masked: mask(row.e164) });
}

// ---------------------------------------------------------------------------
// [HF-AUTH-WA-1] Phone-only sign-up helpers (used only while hfPhoneOnlySignupEnabled is on)
// ---------------------------------------------------------------------------
/** Telemetry hint only ("web", "android", ...). Anything odd is dropped to "unknown". */
function clientHint(v: unknown): string {
  const c = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[a-z0-9_-]{1,16}$/.test(c) ? c : "unknown";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function storeAgeConfirm(db: Env["DB_META"], uid: string, now: number, source: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO hf_age_confirm (uid, confirmed_at, source) VALUES (?1,?2,?3)")
    .bind(uid, now, source).run().catch(() => {});
}

/** True only for an account THIS flow created that has not yet confirmed 18+. Never throws (table may predate the migration). */
async function needs18PlusFor(db: Env["DB_META"], uid: string): Promise<boolean> {
  try {
    const r = await db.prepare(
      "SELECT 1 AS x FROM hf_phone_signup s WHERE s.uid=?1 AND NOT EXISTS (SELECT 1 FROM hf_age_confirm a WHERE a.uid=?1)",
    ).bind(uid).first<{ x: number }>();
    return !!r;
  } catch { return false; }
}

type Claim = { owner: true; extId: string; uid: string | null } | { owner: false; uid: string | null };

/**
 * The lock. hf_phone_signup.phone_hash is the PRIMARY KEY, so of N racing verifies exactly one INSERT wins and
 * becomes the owner; the rest wait for it (bounded) and reuse its uid. A claim whose lease is stale (the owner
 * died, or released it after a failure) is taken over with a compare-and-swap on lease_at.
 */
async function claimPhoneSignup(db: Env["DB_META"], hash: string): Promise<Claim> {
  const extId = `hfwa_${randomToken().slice(0, 24)}`;
  const t0 = Date.now();
  const ins = await db.prepare(
    "INSERT OR IGNORE INTO hf_phone_signup (phone_hash, ext_id, uid, state, lease_at, created_at) VALUES (?1,?2,NULL,'creating',?3,?3)",
  ).bind(hash, extId, t0).run();
  if ((ins.meta?.changes ?? 0) === 1) return { owner: true, extId, uid: null };

  for (let i = 0; i < SIGNUP_POLL_TRIES; i++) {
    const r = await db.prepare("SELECT ext_id, uid, state, lease_at FROM hf_phone_signup WHERE phone_hash=?1")
      .bind(hash).first<{ ext_id: string; uid: string | null; state: string; lease_at: number }>();
    if (!r) return claimPhoneSignup(db, hash);
    const now = Date.now();
    if (r.state === "done" && r.uid) {
      // Still a live account for this number? (verifiedAccountForPhone already said no for a number in deletion, and a
      // purged account has no contact_verification row any more.) If not, this claim is a leftover: restart it fresh.
      const live = await db.prepare("SELECT 1 AS x FROM contact_verification WHERE uid=?1 AND phone_hash=?2 AND phone_verified=1")
        .bind(r.uid, hash).first<{ x: number }>();
      if (live) return { owner: false, uid: r.uid };
      const reset = await db.prepare(
        "UPDATE hf_phone_signup SET ext_id=?2, uid=NULL, state='creating', lease_at=?3 WHERE phone_hash=?1 AND uid=?4 AND state='done'",
      ).bind(hash, extId, now, r.uid).run();
      if ((reset.meta?.changes ?? 0) === 1) return { owner: true, extId, uid: null };
      continue;
    }
    if (now - r.lease_at > SIGNUP_LEASE_MS) {
      const cas = await db.prepare("UPDATE hf_phone_signup SET lease_at=?2 WHERE phone_hash=?1 AND lease_at=?3")
        .bind(hash, now, r.lease_at).run();
      if ((cas.meta?.changes ?? 0) === 1) return { owner: true, extId: r.ext_id, uid: r.uid };
    }
    await sleep(SIGNUP_POLL_MS);
  }
  return { owner: false, uid: null };
}

/** Releases a failed claim so the next attempt can take it over immediately. */
async function releaseClaim(db: Env["DB_META"], hash: string): Promise<void> {
  await db.prepare("UPDATE hf_phone_signup SET lease_at=0 WHERE phone_hash=?1 AND state!='done'").bind(hash).run().catch(() => {});
}

/**
 * Creates the Clerk user for a phone-only account. Identifier = a generated username (the instance already has
 * usernames on — google_auth.ts relies on it); external_id = the unguessable ext_id, which makes a retry after a
 * crash find the SAME Clerk user. No email, no phone_number (SMS stays off in Clerk), no password.
 */
async function createClerkPhoneUser(env: Env, extId: string): Promise<{ ok: true; uid: string } | { ok: false; detail: string }> {
  if (!env.CLERK_SECRET_KEY) return { ok: false, detail: "unconfigured" };
  const headers = { authorization: `Bearer ${env.CLERK_SECRET_KEY}`, "content-type": "application/json" };
  const res = await fetch(`${CLERK_API}/users`, {
    method: "POST", headers,
    body: JSON.stringify({
      external_id: extId,
      username: `hf${extId.slice(5, 29)}`,
      first_name: "New", last_name: "User", // the instance requires names (2026-06-23 config); the person edits them later
      skip_password_checks: true, skip_password_requirement: true,
      public_metadata: { signup: "whatsapp_only" },
    }),
  });
  if (res.ok) {
    const uid = ((await res.json().catch(() => ({}))) as { id?: string }).id;
    if (uid) return { ok: true, uid };
    return { ok: false, detail: "no_id" };
  }
  const detail = (await res.text().catch(() => "")).slice(0, 200);
  // A retry after a crash: the user for this external_id already exists.
  const look = await fetch(`${CLERK_API}/users?external_id=${encodeURIComponent(extId)}`, { headers });
  if (look.ok) {
    const users = (await look.json().catch(() => [])) as Array<{ id?: string }>;
    if (Array.isArray(users) && users[0]?.id) return { ok: true, uid: users[0].id };
  }
  return { ok: false, detail: `${res.status} ${detail}` };
}

async function phoneOnlySignup(
  env: Env,
  a: { e164: string; hash: string; client: string; ageConfirmed: boolean; attempts: number; now: number; otpRowId: number },
): Promise<Response> {
  const db = env.DB_META;
  const fail = async (step: string, detail: string, status = 502) => {
    await releaseClaim(db, a.hash);
    // Give the person their code back (attempts still count, 10-minute life unchanged) so a retry needs no new WhatsApp send.
    await db.prepare("UPDATE phone_otp SET status='sent', verified_at=NULL WHERE id=?1").bind(a.otpRowId).run().catch(() => {});
    void trackException(env, new Error(`whatsapp_auth_signup: ${step} ${detail}`.slice(0, 300)), {
      route: "/api/auth/whatsapp/verify", method: "POST", handled: true, app_name: APP,
    });
    return json({ error: "signup_failed", message: "We couldn’t create your account just now. Please try again." }, status);
  };

  const claim = await claimPhoneSignup(db, a.hash);
  let uid = claim.uid;
  if (!claim.owner) {
    // Lost the race: the winner finished (uid set) or we waited too long.
    if (!uid) return json({ error: "signup_in_progress", message: "Your account is being created. Please try again in a moment.", retry_after_s: 3 }, 409);
  } else {
    if (!uid) {
      const made = await createClerkPhoneUser(env, claim.extId);
      if (!made.ok) return await fail("clerk_create", made.detail);
      uid = made.uid;
      await db.prepare("UPDATE hf_phone_signup SET uid=?2 WHERE phone_hash=?1").bind(a.hash, uid).run();
    }
    try {
      // Mirrors webAccountBootstrap + accountPhoneClaim, idempotently (safe to re-run after a crash).
      await db.batch([
        db.prepare("INSERT INTO users (uid, created_at, updated_at, created_via) VALUES (?1,?2,?2,'web') ON CONFLICT(uid) DO NOTHING").bind(uid, a.now),
        db.prepare("UPDATE users SET phone_hash=?2, private_number=?3, show_private_number=0, updated_at=?4 WHERE uid=?1").bind(uid, a.hash, a.e164, a.now),
        db.prepare(
          `INSERT INTO phone_otp (uid, phone_hash, e164, session_id, status, attempts, created_at, verified_at)
           SELECT ?1,?2,?3,NULL,'verified',0,?4,?4 WHERE NOT EXISTS (SELECT 1 FROM phone_otp WHERE uid=?1 AND status='verified')`,
        ).bind(uid, a.hash, a.e164, a.now),
        db.prepare(
          `INSERT INTO contact_verification (uid, phone_verified, phone_hash, phone_verified_at, updated_at)
           VALUES (?1, 1, ?2, ?3, ?3)
           ON CONFLICT(uid) DO UPDATE SET phone_verified=1, phone_hash=excluded.phone_hash,
             phone_verified_at=excluded.phone_verified_at, updated_at=excluded.updated_at`,
        ).bind(uid, a.hash, a.now),
        ...(a.ageConfirmed ? [db.prepare("INSERT OR IGNORE INTO hf_age_confirm (uid, confirmed_at, source) VALUES (?1,?2,?3)").bind(uid, a.now, a.client)] : []),
        db.prepare("UPDATE hf_phone_signup SET uid=?2, state='done' WHERE phone_hash=?1").bind(a.hash, uid),
      ]);
    } catch (err) {
      return await fail("bootstrap", String(err), 503);
    }
    // Never blocks sign-up; ensureHandle swallows its own failures.
    try { await ensureHandle(env, uid); } catch { /* */ }
  }

  const mint = await mintClerkSignInTicket(env, uid!);
  if (!mint.ok) return await fail(`ticket_${mint.reason}`, "", 502);
  if (a.ageConfirmed) await storeAgeConfirm(db, uid!, a.now, a.client);
  const needs18Plus = await needs18PlusFor(db, uid!);
  void trackUser(env, uid!, null, "auth_whatsapp_verify", APP, {
    outcome: "signed_in", attempts: a.attempts, phone_masked: mask(a.e164), client: a.client, created_here: claim.owner,
  });
  // The winner created the account; a racing loser just signed into it, so only the owner reports is_new.
  void track(env, uid!, "auth_whatsapp_signup", APP, { is_new: claim.owner, client: a.client });
  return json({ ok: true, status: "signed_in", ticket: mint.ticket, isNew: true, needs18Plus, phone_masked: mask(a.e164) });
}

// ---------------------------------------------------------------------------
// POST /api/hf/account/age-confirm {confirmed:true, client?} (signed in) — [HF-AUTH-WA-1]
// Stores the "I am 18 or over" confirmation (first one wins). Clears needs18Plus.
// ---------------------------------------------------------------------------
export async function hfAgeConfirm(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as { confirmed?: unknown; client?: unknown };
  if (b?.confirmed !== true) return json({ error: "confirmation_required", message: "Please confirm that you are 18 or over." }, 400);
  const client = clientHint(b?.client);
  const now = Date.now();
  try {
    await env.DB_META.prepare("INSERT OR IGNORE INTO hf_age_confirm (uid, confirmed_at, source) VALUES (?1,?2,?3)").bind(auth.uid, now, client).run();
  } catch (err) {
    void trackException(env, err, { uid: auth.uid, route: "/api/hf/account/age-confirm", method: "POST", handled: true, app_name: APP });
    return json({ error: "confirm_failed", message: "We couldn’t save that just now. Please try again." }, 503);
  }
  const r = await env.DB_META.prepare("SELECT confirmed_at FROM hf_age_confirm WHERE uid=?1").bind(auth.uid).first<{ confirmed_at: number }>();
  void track(env, auth.uid, "hf_age_confirm", APP, { client, first_time: r?.confirmed_at === now });
  return json({ ok: true, confirmed_at: r?.confirmed_at ?? now });
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
