// [HF-AUTH-WA-ONLY-1 2026-10-24] Email code for the website's "Create account" page.
//
// Owner decision: sign-in is WhatsApp-only; sign-up asks name + email + WhatsApp and
// BOTH the email and the WhatsApp number must be proven before the account exists.
// This file is the EMAIL half. It is UNAUTHENTICATED (no account exists yet), so it
// is an email-sending faucet and every limit below is load-bearing:
//   * 6-digit code, only its HASH is stored (KV, env.TOKENS), 10-minute life,
//   * 60 s resend cooldown per email, 5 sends / hour per email, 10 sends / hour per IP
//     (IP is hashed before it touches KV),
//   * 5 wrong tries per code, then the code is dead.
// Same pattern as routes/id.ts (idEmailStart/Verify, the signed-in email OTP), minus the
// uid. Chosen over Clerk's own email_code because the account is created server-side
// by the WhatsApp verify step (routes/whatsapp_auth.ts) in ONE atomic move, with the
// email already proven; Clerk's sign-up resource would make the account (and a live
// session) after the email alone, before WhatsApp is proven.
//
//   POST /api/auth/signup/email/send   {email}        -> {ok, expires_in_s, resend_after_s}
//   POST /api/auth/signup/email/verify {email, code}  -> {ok, proof}
//
// `proof` is a single-use token (hash in KV, 30 min) that whatsapp/verify redeems when
// it creates the account (consumeEmailProof). The email address is bound inside it.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { BRAND } from "../lib/brand";
import { track, metric } from "../hooks";

const APP = "avatok";
const CLERK_API = "https://api.clerk.com/v1";

export const EMAIL_OTP_TTL_S = 600;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;
export const EMAIL_OTP_RESEND_GAP_S = 60;
export const EMAIL_OTP_MAX_SENDS_PER_EMAIL_HOUR = 5;
export const EMAIL_OTP_MAX_SENDS_PER_IP_HOUR = 10;
export const EMAIL_PROOF_TTL_S = 30 * 60;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmail(v: unknown): string | null {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

function sixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function emailOtpHtml(code: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:440px;margin:0 auto;padding:24px">
    <h2 style="color:#0F1115;margin:0 0 8px">Verify your email</h2>
    <p style="color:#737A86;font-size:14px;line-height:1.5;margin:0 0 20px">Enter this code on ${BRAND.name} to finish creating your account. It expires in 10 minutes.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#0F1115;text-align:center;padding:16px;background:#F3F4F6;border-radius:12px">${code}</div>
    <p style="color:#9AA1AC;font-size:12px;margin:20px 0 0">If you didn't ask for this, you can safely ignore this email.</p>
  </div>`;
}

/** True when a Clerk user already owns this email. Unknown (Clerk down / unconfigured) counts as "no", so a Clerk blip never blocks sign-up; creation re-checks. */
export async function clerkEmailInUse(env: Env, email: string): Promise<boolean> {
  if (!env.CLERK_SECRET_KEY) return false;
  try {
    const res = await fetch(`${CLERK_API}/users?email_address[]=${encodeURIComponent(email)}&limit=1`, {
      headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const rows = (await res.json().catch(() => [])) as unknown;
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

async function bumpHourly(env: Env, key: string): Promise<number> {
  const n = Number((await env.TOKENS.get(key)) || "0") + 1;
  await env.TOKENS.put(key, String(n), { expirationTtl: 3600 });
  return n;
}

// ---------------------------------------------------------------------------
// POST /api/auth/signup/email/send (unauthenticated)
// ---------------------------------------------------------------------------
export async function signupEmailSend(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { email?: unknown };
  const email = normalizeEmail(b?.email);
  if (!email) return json({ error: "invalid_email", message: "Enter a valid email address.", field: "email" }, 400);

  const emailHash = await sha256Hex(`su-email|${email}`);
  const ipHash = await sha256Hex(`su-email-ip|${req.headers.get("cf-connecting-ip") ?? ""}`);
  const now = Date.now();

  // Resend cooldown first: cheap, and it is what a double-click hits.
  const otpKey = `su_email_otp:${emailHash}`;
  const prevRaw = await env.TOKENS.get(otpKey);
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw) as { sent_at?: number };
      const waitS = Math.ceil(((prev.sent_at ?? 0) + EMAIL_OTP_RESEND_GAP_S * 1000 - now) / 1000);
      if (waitS > 0) {
        return json({ error: "too_soon", message: `Please wait ${waitS} seconds before asking for another code.`, resend_after_s: waitS }, 429);
      }
    } catch { /* corrupt row: replaced below */ }
  }

  const perEmail = Number((await env.TOKENS.get(`su_email_sends:${emailHash}`)) || "0");
  const perIp = Number((await env.TOKENS.get(`su_email_ip:${ipHash}`)) || "0");
  if (perEmail >= EMAIL_OTP_MAX_SENDS_PER_EMAIL_HOUR || perIp >= EMAIL_OTP_MAX_SENDS_PER_IP_HOUR) {
    void track(env, "anon_su_email", "email_otp_failed", APP, { reason: "rate_limited", stage: "send" });
    return json({ error: "rate_limited", message: "Too many codes asked for. Please try again in an hour." }, 429);
  }

  if (await clerkEmailInUse(env, email)) {
    void track(env, "anon_su_email", "email_otp_failed", APP, { reason: "email_taken", stage: "send" });
    return json({
      error: "email_taken", field: "email",
      message: "This email already has an account. Sign in with your WhatsApp number instead.",
    }, 409);
  }

  const code = sixDigitCode();
  const hash = await sha256Hex(`su-email|${email}|${code}`); // never store the code itself
  await env.TOKENS.put(otpKey, JSON.stringify({ hash, exp: now + EMAIL_OTP_TTL_S * 1000, attempts: 0, sent_at: now }), { expirationTtl: EMAIL_OTP_TTL_S });
  await bumpHourly(env, `su_email_sends:${emailHash}`);
  await bumpHourly(env, `su_email_ip:${ipHash}`);

  try {
    await env.Q_EMAIL.send({
      to: email,
      subject: `Your ${BRAND.name} verification code`,
      html: emailOtpHtml(code),
      from: `${BRAND.name} Support <${BRAND.emails.noreply}>`,
    });
  } catch {
    await env.TOKENS.delete(otpKey).catch(() => {});
    metric(env, "email_otp_enqueue_error", [1]);
    void track(env, "anon_su_email", "email_otp_failed", APP, { reason: "send_failed", stage: "send" });
    return json({ error: "send_failed", message: "We couldn’t send the email just now. Please try again." }, 502);
  }

  void track(env, "anon_su_email", "email_otp_sent", APP, { surface: "sign_up" });
  metric(env, "email_otp_sent", [1]);
  return json({ ok: true, expires_in_s: EMAIL_OTP_TTL_S, resend_after_s: EMAIL_OTP_RESEND_GAP_S });
}

// ---------------------------------------------------------------------------
// POST /api/auth/signup/email/verify (unauthenticated)
// ---------------------------------------------------------------------------
export async function signupEmailVerify(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; code?: unknown };
  const email = normalizeEmail(b?.email);
  if (!email) return json({ error: "invalid_email", message: "Enter a valid email address.", field: "email" }, 400);
  const code = String(b?.code ?? "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(code)) return json({ error: "invalid_code", message: "Enter the 6-digit code we emailed you.", field: "code" }, 400);

  const emailHash = await sha256Hex(`su-email|${email}`);
  const otpKey = `su_email_otp:${emailHash}`;
  const raw = await env.TOKENS.get(otpKey);
  const expired = () => json({ error: "code_expired", message: "That code has expired. Ask for a new one.", field: "code" }, 410);
  if (!raw) return expired();

  let rec: { hash: string; exp: number; attempts: number };
  try {
    rec = JSON.parse(raw);
    if (!rec || typeof rec.hash !== "string" || !Number.isFinite(rec.exp) || !Number.isInteger(rec.attempts)) throw new Error("bad");
  } catch {
    await env.TOKENS.delete(otpKey).catch(() => {});
    return expired();
  }
  if (Date.now() > rec.exp) {
    await env.TOKENS.delete(otpKey).catch(() => {});
    return expired();
  }
  if (rec.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
    await env.TOKENS.delete(otpKey).catch(() => {});
    void track(env, "anon_su_email", "email_otp_failed", APP, { reason: "too_many_attempts", stage: "verify" });
    return json({ error: "too_many_attempts", message: "Too many wrong tries. Ask for a new code.", field: "code" }, 429);
  }

  const given = await sha256Hex(`su-email|${email}|${code}`);
  if (given !== rec.hash) {
    const left = Math.max(0, EMAIL_OTP_MAX_ATTEMPTS - (rec.attempts + 1));
    const ttl = Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000));
    await env.TOKENS.put(otpKey, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), { expirationTtl: ttl });
    void track(env, "anon_su_email", "email_otp_failed", APP, { reason: "wrong_code", stage: "verify", attempt: rec.attempts + 1 });
    return json({
      error: "wrong_code", field: "code", attempts_left: left,
      message: left > 0 ? `That code isn’t right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code isn’t right. Ask for a new one.",
    }, 400);
  }

  await env.TOKENS.delete(otpKey).catch(() => {});
  const proof = randomToken();
  await env.TOKENS.put(
    `su_email_proof:${await sha256Hex(proof)}`,
    JSON.stringify({ email, expires_at: Date.now() + EMAIL_PROOF_TTL_S * 1000 }),
    { expirationTtl: EMAIL_PROOF_TTL_S + 60 },
  );
  void track(env, "anon_su_email", "email_otp_verified", APP, { surface: "sign_up" });
  metric(env, "email_otp_verified", [1]);
  return json({ ok: true, proof });
}

// ---------------------------------------------------------------------------
// Used by routes/whatsapp_auth.ts when it creates the account.
// ---------------------------------------------------------------------------
/** Reads (does not burn) an email proof. Null = unknown, expired or malformed. Burn it with burnEmailProof once the account exists. */
export async function readEmailProof(env: Env, proof: unknown): Promise<string | null> {
  if (typeof proof !== "string" || proof.length < 16 || proof.length > 200) return null;
  const raw = await env.TOKENS.get(`su_email_proof:${await sha256Hex(proof)}`);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { email?: unknown; expires_at?: unknown };
    if (typeof p.email !== "string" || typeof p.expires_at !== "number" || Date.now() > p.expires_at) return null;
    return p.email;
  } catch { return null; }
}

export async function burnEmailProof(env: Env, proof: string): Promise<void> {
  await env.TOKENS.delete(`su_email_proof:${await sha256Hex(proof)}`).catch(() => {});
}
