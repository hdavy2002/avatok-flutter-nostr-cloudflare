// AvaID — Phase 1 (§10.4). Selfie-video liveness via AWS Rekognition.
//   POST /api/id/session  → start a liveness session (returns SessionId for the
//                           native Amplify Face Liveness UI; rate-limited 3/24h)
//   POST /api/id/result   → fetch Rekognition result; ≥90% confidence auto-verifies
//                           (sets tier='verified', KV cache, brain hook); else reject
//   GET  /api/id/status   → caller's current verification status
//
// Dual auth on all (NIP-98 + Clerk). Rekognition is flag-gated (src/aws/rekognition
// .ts): unset AWS creds → 503 "verification unavailable", everything else still works.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone } from "../util";
import { setVerifiedCache } from "../auth";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { createLivenessSession, getLivenessResults, rekognitionConfigured } from "../aws/rekognition";
import { stripeKycSession, stripeIdentityConfigured } from "./kyc";
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";

const MIN_CONFIDENCE = 90;        // §10.4 auto-approve threshold
const MAX_ATTEMPTS_24H = 3;       // §10.4 retry cap
const DAY = 86_400_000;

async function attemptsLast24h(env: Env, uid: string): Promise<number> {
  const row = await metaSession(env)
    .prepare("SELECT COUNT(*) AS n FROM verification_attempts WHERE uid=?1 AND created_at > ?2")
    .bind(uid, Date.now() - DAY).first<{ n: number }>();
  return row?.n ?? 0;
}

// POST /api/id/session  — {provider?: 'rekognition'|'stripe'} (default rekognition).
// Phase 3: Stripe Identity (document + matching selfie) is a SECOND provider
// behind this same gateway; both share the 3-attempts/24h budget.
export async function idSession(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const body = (await req.clone().json().catch(() => ({}))) as any;
  const provider = String(body.provider || "rekognition");

  if (await attemptsLast24h(env, ctx.uid) >= MAX_ATTEMPTS_24H) {
    return json({ error: "too many attempts", retry_after_hours: 24 }, 429);
  }

  if (provider === "stripe") return stripeKycSession(ctx, env);

  if (!rekognitionConfigured(env)) return json({ error: "verification unavailable", reason: "aws_unconfigured" }, 503);

  let session: { SessionId: string };
  try {
    session = await createLivenessSession(env, { auditImagesLimit: 2 });
  } catch (e: any) {
    metric(env, "avaid_session_error", [1]);
    return json({ error: "liveness session failed", detail: String(e?.message ?? e) }, 502);
  }

  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `INSERT INTO verification_status (uid, status, method, session_id, updated_at)
       VALUES (?1,'pending','rekognition_liveness',?2,?3)
       ON CONFLICT(uid) DO UPDATE SET status='pending', session_id=?2, updated_at=?3`,
    ).bind(ctx.uid, session.SessionId, now),
    metaDb(env).prepare(
      "INSERT INTO verification_attempts (uid, session_id, result, provider, created_at) VALUES (?1,?2,'pending','rekognition',?3)",
    ).bind(ctx.uid, session.SessionId, now),
  ]);

  track(env, ctx.uid, "id_session_started", "avaid", { session_id: session.SessionId });
  metric(env, "avaid_session", [1]);
  return json({ session_id: session.SessionId });
}

// POST /api/id/result  { session_id }
export async function idResult(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!rekognitionConfigured(env)) return json({ error: "verification unavailable", reason: "aws_unconfigured" }, 503);

  const b = (await req.json().catch(() => ({}))) as any;
  const sessionId = String(b.session_id || "");
  if (!sessionId) return json({ error: "session_id required" }, 400);

  // The session must belong to this caller (anti-replay: bind to the row we wrote).
  const owned = await metaSession(env)
    .prepare("SELECT 1 AS ok FROM verification_status WHERE uid=?1 AND session_id=?2")
    .bind(ctx.uid, sessionId).first<{ ok: number }>();
  if (!owned) return json({ error: "session not found for this account" }, 404);

  let result: { Status: string; Confidence?: number };
  try {
    result = await getLivenessResults(env, sessionId);
  } catch (e: any) {
    return json({ error: "liveness result failed", detail: String(e?.message ?? e) }, 502);
  }

  const confidence = Number(result.Confidence ?? 0);
  const passed = result.Status === "SUCCEEDED" && confidence >= MIN_CONFIDENCE;
  const now = Date.now();

  await env.DB_META.prepare(
    "UPDATE verification_attempts SET result=?1, confidence=?2 WHERE uid=?3 AND session_id=?4",
  ).bind(passed ? "pass" : "fail", confidence, ctx.uid, sessionId).run();

  if (!passed) {
    await metaDb(env).prepare(
      "UPDATE verification_status SET status='rejected', confidence=?2, updated_at=?3 WHERE uid=?1",
    ).bind(ctx.uid, confidence, now).run();
    track(env, ctx.uid, "id_verification_failed", "avaid", { confidence, status: result.Status });
    const remaining = Math.max(0, MAX_ATTEMPTS_24H - (await attemptsLast24h(env, ctx.uid)));
    return json({ verified: false, confidence, status: result.Status, attempts_remaining: remaining });
  }

  // PASS → verified. Flip status + tier, cache in KV, learn it, notify.
  await metaDb(env).batch([
    metaDb(env).prepare(
      "UPDATE verification_status SET status='verified', confidence=?2, verified_at=?3, updated_at=?3 WHERE uid=?1",
    ).bind(ctx.uid, confidence, now),
    metaDb(env).prepare(
      `INSERT INTO kyc_status (uid, status, provider, verified_at, updated_at)
       VALUES (?1, 'verified', 'rekognition_liveness', ?2, ?2)
       ON CONFLICT(uid) DO UPDATE SET status='verified', verified_at=?2, updated_at=?2`,
    ).bind(ctx.uid, now),
  ]);
  await setVerifiedCache(env, ctx.uid, true);

  brainFact(env, ctx.uid, "identity_verified", "avaid", { method: "rekognition_liveness", confidence, at: now });
  track(env, ctx.uid, "id_verified", "avaid", { confidence });
  metric(env, "avaid_verified", [1, confidence]);
  try { await notifyUser(env, ctx.uid, { type: "system", title: "You're verified ✓", body: "Tier-2 apps are now unlocked.", data: { deeplink: "/profile" } }); } catch { /* best-effort */ }

  return json({ verified: true, confidence, tier: "verified" });
}

// GET /api/id/status
export async function idStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await metaSession(env)
    .prepare("SELECT status, method, confidence, failure_reason, verified_at FROM verification_status WHERE uid=?1")
    .bind(ctx.uid).first<{ status: string; method: string | null; confidence: number | null; failure_reason: string | null; verified_at: number | null }>();
  const kyc = await metaSession(env)
    .prepare("SELECT status, provider, verified_at FROM kyc_status WHERE uid=?1")
    .bind(ctx.uid).first<{ status: string; provider: string | null; verified_at: number | null }>();
  // Phone verification (account-keyed) — lets a reinstall / new device skip the
  // OTP entirely once the account's phone is already confirmed (no wasted SMS).
  const cv = await metaSession(env)
    .prepare("SELECT phone_verified FROM contact_verification WHERE uid=?1")
    .bind(ctx.uid).first<{ phone_verified: number }>().catch(() => null);
  return json({
    uid: ctx.uid,
    phone_verified: Number(cv?.phone_verified ?? 0) === 1,
    status: row?.status ?? "unverified",
    method: row?.method ?? null,
    confidence: row?.confidence ?? null,
    failure_reason: row?.failure_reason ?? null,
    verified_at: row?.verified_at ?? null,
    tier: (row?.status === "verified" ? "verified" : "basic"),
    kyc: { status: kyc?.status ?? "unverified", provider: kyc?.provider ?? null, verified_at: kyc?.verified_at ?? null },
    rekognition_configured: rekognitionConfigured(env),
    stripe_configured: stripeIdentityConfigured(env),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding contact verification: phone (Firebase OTP) + email (server OTP).
// Phone OTP itself is done client-side by Firebase; /phone/confirm records that
// the authenticated uid confirmed a number. Email OTP is fully server-issued:
// /email/start mints a 6-digit code, stores only its hash in KV (10-min TTL),
// and emails it via Q_EMAIL → Brevo; /email/verify checks it. All dual-auth.
// ─────────────────────────────────────────────────────────────────────────────

const OTP_TTL_S = 600;            // 10 minutes
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const OTP_MAX_SENDS_PER_HOUR = 5;

function sixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

function emailOtpHtml(code: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:440px;margin:0 auto;padding:24px">
    <h2 style="color:#0F1115;margin:0 0 8px">Verify your email</h2>
    <p style="color:#737A86;font-size:14px;line-height:1.5;margin:0 0 20px">Enter this code in AvaTOK to finish setting up your account. It expires in 10 minutes.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#08C4C4;text-align:center;padding:16px;background:#E2FCFC;border-radius:12px">${code}</div>
    <p style="color:#9AA1AC;font-size:12px;margin:20px 0 0">If you didn't request this, you can safely ignore this email.</p>
  </div>`;
}

// POST /api/id/email/start  { email }
export async function idEmailStart(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as { email?: string };
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "valid email required" }, 400);

  // Rate-limit sends per identity (defends against spamming an inbox).
  const sendKey = `otp:email:sends:${ctx.uid}`;
  const sends = Number((await env.TOKENS.get(sendKey)) || "0");
  if (sends >= OTP_MAX_SENDS_PER_HOUR) {
    track(env, ctx.uid, "email_verification_failed", "avaid", { reason: "rate_limited" });
    return json({ error: "too many requests — please wait a bit and try again" }, 429);
  }

  const code = sixDigitCode();
  const exp = Date.now() + OTP_TTL_S * 1000;
  const hash = await sha256Hex(`${ctx.uid}:${email}:${code}`); // never store the code itself
  await env.TOKENS.put(
    `otp:email:${ctx.uid}`,
    JSON.stringify({ hash, email, exp, attempts: 0 }),
    { expirationTtl: OTP_TTL_S },
  );
  await env.TOKENS.put(sendKey, String(sends + 1), { expirationTtl: 3600 });

  try {
    await env.Q_EMAIL.send({
      to: email,
      subject: "Your AvaTOK verification code",
      html: emailOtpHtml(code),
      from: "AvaTOK <noreply@avatok.ai>",
    });
  } catch {
    metric(env, "email_otp_enqueue_error", [1]);
    return json({ error: "could not send the email — please try again" }, 502);
  }

  track(env, ctx.uid, "email_verification_sent", "avaid", {});
  metric(env, "email_otp_sent", [1]);
  return json({ ok: true });
}

// POST /api/id/email/verify  { email, code }
export async function idEmailVerify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as { email?: string; code?: string };
  const email = String(b.email || "").trim().toLowerCase();
  const code = String(b.code || "").trim();
  if (!email || !code) return json({ error: "email and code required" }, 400);

  const key = `otp:email:${ctx.uid}`;
  const raw = await env.TOKENS.get(key);
  if (!raw) return json({ error: "code expired — request a new one" }, 400);

  let rec: { hash: string; email: string; exp: number; attempts: number };
  try {
    rec = JSON.parse(raw);
  } catch {
    await env.TOKENS.delete(key);
    return json({ error: "code expired — request a new one" }, 400);
  }
  if (Date.now() > rec.exp) {
    await env.TOKENS.delete(key);
    return json({ error: "code expired — request a new one" }, 400);
  }
  if (rec.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
    await env.TOKENS.delete(key);
    return json({ error: "too many attempts — request a new code" }, 429);
  }

  const given = await sha256Hex(`${ctx.uid}:${email}:${code}`);
  if (given !== rec.hash || email !== rec.email) {
    const ttl = Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000));
    await env.TOKENS.put(key, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), { expirationTtl: ttl });
    track(env, ctx.uid, "email_verification_failed", "avaid", { reason: "invalid_code", attempt: rec.attempts + 1 });
    return json({ error: "incorrect or expired code" }, 400);
  }

  const now = Date.now();
  const emailHash = await sha256Hex(email);
  await metaDb(env).prepare(
    `INSERT INTO contact_verification (uid, email_verified, email_hash, email_verified_at, updated_at)
     VALUES (?1, 1, ?2, ?3, ?3)
     ON CONFLICT(uid) DO UPDATE SET email_verified=1, email_hash=?2, email_verified_at=?3, updated_at=?3`,
  ).bind(ctx.uid, emailHash, now).run();
  // Link the verified email to the directory profile too (same hashing as profileUpsert).
  try {
    await metaDb(env).prepare("UPDATE users SET email_hash=?2, updated_at=?3 WHERE uid=?1")
      .bind(ctx.uid, emailHash, now).run();
  } catch { /* profile row may not exist yet; contact_verification is the source of truth */ }
  // Trust Ladder ledger (AvaIdentity hub green tick).
  try {
    await metaDb(env).prepare(
      `INSERT INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
       VALUES (?1,'email','verified','clerk',?2,?2)
       ON CONFLICT(uid, proof) DO UPDATE SET status='verified', verified_at=?2, updated_at=?2`,
    ).bind(ctx.uid, now).run();
  } catch { /* table may predate migration */ }
  await env.TOKENS.delete(key);

  track(env, ctx.uid, "email_verified", "avaid", {});
  metric(env, "email_otp_verified", [1]);
  return json({ ok: true, verified: true });
}

// ── SIM-only phone enforcement (PROPOSAL-PROGRESSIVE-IDENTITY.md §7b) ────────
// Web temp-OTP services hand out VoIP/virtual numbers; we only accept real
// mobile SIMs. Three layers: (1) carrier line-type lookup via Twilio Lookup v2
// when TWILIO_* creds are set — accept type 'mobile' only; (2) a KV denylist
// of known temp-number prefixes (`phone_denylist`: JSON array of E.164
// prefixes, updatable without deploy); (3) one phone → one account.
// Flag-gated by platform_config.simOnlyPhoneEnabled.

async function simOnlyEnabled(env: Env): Promise<boolean> {
  try {
    const cfg = (await env.TOKENS.get("platform_config", "json")) as any;
    if (cfg && "simOnlyPhoneEnabled" in cfg) return cfg.simOnlyPhoneEnabled !== false;
  } catch { /* default on */ }
  return true;
}

async function phoneDenylisted(env: Env, phone: string): Promise<boolean> {
  try {
    const list = (await env.TOKENS.get("phone_denylist", "json")) as string[] | null;
    if (Array.isArray(list)) return list.some((p) => p && phone.startsWith(p));
  } catch { /* no list */ }
  return false;
}

/** 'mobile' | 'voip' | 'landline' | … | null when lookup unavailable. */
async function lineType(env: Env, phone: string): Promise<string | null> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  try {
    const r = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`,
      { headers: { authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) } },
    );
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.line_type_intelligence?.type ?? null;
  } catch {
    return null; // lookup outage must not lock users out — denylist still applies
  }
}

// POST /api/id/phone/confirm  { phone }
// Records that this uid completed Firebase phone OTP. (Hardening option: also
// accept a Firebase ID token here and verify it server-side before trusting it.)
export async function idPhoneConfirm(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as { phone?: string };
  const phone = normalizePhone(String(b.phone || ""));
  if (phone.replace(/\D/g, "").length < 8) return json({ error: "valid phone required" }, 400);

  if (await simOnlyEnabled(env)) {
    if (await phoneDenylisted(env, phone)) {
      track(env, ctx.uid, "phone_verification_failed", "avaid", { reason: "denylisted" });
      return json({ error: "this number can't be used — please use a real mobile number", reason: "phone_type_blocked" }, 400);
    }
    const t = await lineType(env, phone);
    if (t !== null && t !== "mobile") {
      track(env, ctx.uid, "phone_verification_failed", "avaid", { reason: "line_type", line_type: t });
      metric(env, "phone_blocked_linetype", [1]);
      return json({ error: "temporary/VoIP numbers aren't accepted — please use a real mobile number", reason: "phone_type_blocked" }, 400);
    }
  }

  // One phone → one account.
  const phoneHashPre = await sha256Hex(phone);
  const existing = await env.DB_META
    .prepare("SELECT uid FROM contact_phone_index WHERE phone_hash=?1")
    .bind(phoneHashPre).first<{ uid: string }>();
  if (existing && existing.uid !== ctx.uid) {
    track(env, ctx.uid, "phone_verification_failed", "avaid", { reason: "in_use" });
    return json({ error: "this number is already linked to another account", reason: "phone_in_use" }, 409);
  }

  const now = Date.now();
  const phoneHash = phoneHashPre; // store hash only — never the raw number
  await metaDb(env).batch([
    metaDb(env).prepare(
      `INSERT INTO contact_verification (uid, phone_verified, phone_hash, phone_verified_at, updated_at)
       VALUES (?1, 1, ?2, ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET phone_verified=1, phone_hash=?2, phone_verified_at=?3, updated_at=?3`,
    ).bind(ctx.uid, phoneHash, now),
    // Claim the number in the directory index (enforces one phone → one account).
    metaDb(env).prepare(
      "INSERT OR REPLACE INTO contact_phone_index (phone_hash, uid, updated_at) VALUES (?1,?2,?3)",
    ).bind(phoneHash, ctx.uid, now),
    metaDb(env).prepare(
      `INSERT INTO identity_proofs (uid, proof, status, provider, verified_at, updated_at)
       VALUES (?1,'phone','verified','firebase',?2,?2)
       ON CONFLICT(uid, proof) DO UPDATE SET status='verified', verified_at=?2, updated_at=?2`,
    ).bind(ctx.uid, now),
  ]);

  track(env, ctx.uid, "phone_verification_completed", "avaid", {});
  metric(env, "phone_confirmed", [1]);
  return json({ ok: true, verified: true });
}
