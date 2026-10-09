// [HF-HOST-KYC-1 2026-10-09] Hello Fraands — real host verification BACKEND (onboarding spec Phase 2).
// Rulebook: Specs/RULEBOOK-HELLO-FRAANDS.md §13 (HF-KYC-1..5, HF-PRIV-6, HF-LGBT-3). Runbook: Specs/HF-HOST-KYC-1-RUNBOOK.md.
//
//   POST /api/hosts/kyc/aadhaar/otp     { aadhaar, consent:true, role }   -> { ok }
//   POST /api/hosts/kyc/aadhaar/verify  { otp }                           -> { ok, gender, ageOk, last4, firstName }
//   POST /api/hosts/kyc/selfie/code                                       -> { code, expires_in_s }
//   POST /api/hosts/kyc/selfie          raw video body + x-selfie-code    -> { ok, status:"pending" }
//   POST /api/hosts/payout/verify       { upi, account, ifsc }            -> { ok, nameAtBank, match, accountLast4, upiVerified }
//   GET  /api/hosts/kyc/status                                            -> { aadhaar, selfie, payout }
//   GET  /api/admin/hf/kyc?status=pending                                 -> pending selfies + short-lived signed media URLs   (ADMIN_UIDS)
//   GET  /api/admin/hf/kyc/media?t=<signed token>                         -> streams selfie video / Aadhaar photo               (signed, 5 min)
//   POST /api/admin/hf/kyc/:uid/selfie  { decision:"approve"|"reject", reason, selfieId? }                                      (ADMIN_UIDS)
//
// Everything is dark behind the `hostKycEnabled` flag (404 not_enabled). All user routes need a signed-in user.
//
// PRIVACY INVARIANTS (HF-KYC-2): the full Aadhaar number lives only in the request body of /aadhaar/otp, is passed to
// Sandbox and dropped — never written to D1/KV/R2, never in a log line, never in a PostHog property, never in an error.
// KV holds only the vendor reference id + last4. Name/DOB/address/guardian are AES-GCM encrypted (lib/pii_crypto.ts).
// The Aadhaar photo and selfie videos sit in the PRIVATE VERIFICATION bucket and are only ever streamed through the worker
// to an admin, and every admin read is written to admin_audit (DB_WALLET) — "access logged".
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { isAdminUid } from "../lib/preview";
import { readConfig } from "./config";
import { encryptPii, tryDecryptPii, piiKeyConfigured, piiKeyBytes } from "../lib/pii_crypto";
import { sandboxConfigured, aadhaarOtpGenerate, aadhaarOtpVerify, bankVerify, upiVerify, type SandboxFail } from "../lib/sandbox_client";
import { cleanAadhaar, mapGender, isAdult, namesMatch, firstNameOf, UPI_RE, IFSC_RE, ACCOUNT_RE } from "../lib/hf_kyc_util";

const APP = BRAND.slug;
export const HF_KYC_CONSENT_VERSION = "hf-kyc-2026-10-09";
const REF_TTL_S = 600;
const CODE_TTL_S = 600;
const MAX_SELFIE_BYTES = 12 * 1024 * 1024;
const MIN_SELFIE_BYTES = 20 * 1024;
const MEDIA_URL_TTL_MS = 5 * 60_000;
const SELFIE_TYPES: Record<string, string> = { "video/webm": "webm", "video/mp4": "mp4", "video/quicktime": "mov" };

const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const refKey = (uid: string) => `hfkyc:ref:${uid}`;
const codeKey = (uid: string) => `hfkyc:selfie:${uid}`;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

/** Rate-limit helper: returns an error Response (with our shape) or null. */
async function limited(env: Env, key: string, max: number, windowSec: number, message: string): Promise<Response | null> {
  const r = await rateLimit(env, key, max, windowSec);
  if (!r) return null;
  const retry = Number(r.headers.get("retry-after") || 60);
  return err(429, "too_many", { message, retry_after_s: retry });
}

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_kyc_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { uid: adminUid, route: "/api/admin/hf/kyc", handled: true, app_name: APP, extra: { area: "hf_kyc", step: "admin_audit", action } });
  }
}

/** PostHog event carrying uid + email (telemetry rules). NEVER pass Aadhaar/bank numbers or names in `props`. */
function makeEmit(env: Env, ctx: ExecutionContext | undefined, uid: string) {
  return (event: string, props: Record<string, unknown> = {}): void => {
    const p = (async () => {
      const email = await emailFor(env, uid).catch(() => null);
      await trackUser(env, uid, email, event, APP, { area: "hf_kyc", ...props });
    })().catch(() => { /* telemetry is best-effort */ });
    if (ctx) ctx.waitUntil(p);
  };
}

function failHttp(f: SandboxFail): { status: number; error: string; message: string; infra: boolean } {
  switch (f.reason) {
    case "invalid_aadhaar": return { status: 422, error: "invalid_aadhaar", message: "That Aadhaar number isn’t valid. Check it and try again.", infra: false };
    case "invalid_otp": return { status: 422, error: "invalid_otp", message: "That code isn’t right. Check the SMS from UIDAI and try again.", infra: false };
    case "otp_expired": return { status: 410, error: "otp_expired", message: "That code has expired. Request a new one.", infra: false };
    case "retry_later": return { status: 429, error: "retry_later", message: "Still checking — try again in 30 seconds.", infra: false };
    case "account_not_found": return { status: 422, error: "account_not_found", message: "We couldn’t find that bank account. Check the account number and IFSC.", infra: false };
    case "account_blocked": return { status: 422, error: "account_blocked", message: "That bank account is blocked. Please use another account.", infra: false };
    case "unverifiable": return { status: 422, error: "bank_unsupported", message: "We couldn’t verify this account automatically. Try another account or contact support.", infra: false };
    case "invalid_input": return { status: 400, error: "invalid_input", message: "Please check the details and try again.", infra: false };
    case "bank_offline": return { status: 503, error: "bank_offline", message: "That bank isn’t responding right now. Please try again later.", infra: false };
    default: return { status: f.reason === "not_configured" ? 503 : 502, error: "kyc_unavailable", message: "Verification isn’t available right now. Please try again shortly.", infra: true };
  }
}

async function fail(env: Env, emit: ReturnType<typeof makeEmit>, uid: string, step: string, f: SandboxFail): Promise<Response> {
  const h = failHttp(f);
  emit("hf_kyc_failed", { step, reason: f.reason, http: h.status, vendor_status: f.status, txn: f.txn });
  if (h.infra) {
    await trackException(env, new Error(`sandbox ${step}: ${f.reason}${f.status ? " " + f.status : ""}`), {
      uid, route: `/api/hosts/${step}`, handled: true, app_name: APP, extra: { area: "hf_kyc", step, reason: f.reason, txn: f.txn },
    });
  }
  return err(h.status, h.error, { message: h.message });
}

interface KycRow {
  uid: string; role: string; aadhaar_last4: string | null; provider_ref: string | null; name_enc: string | null; gender: string | null;
  age_ok: number; photo_r2_key: string | null; verified_at: number | null;
}
const kycRow = (env: Env, uid: string) =>
  env.DB_META.prepare("SELECT uid, role, aadhaar_last4, provider_ref, name_enc, gender, age_ok, photo_r2_key, verified_at FROM hf_kyc WHERE uid=?1")
    .bind(uid).first<KycRow>();

// ── POST /api/hosts/kyc/aadhaar/otp ──────────────────────────────────────────
async function aadhaarOtp(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const emit = makeEmit(env, ctx, uid);
  if (!sandboxConfigured(env) || !piiKeyConfigured(env)) {
    // Fail closed BEFORE spending ₹1 on an OTP we could not store the result of.
    await trackException(env, new Error("hf_kyc not configured (SANDBOX_* or HF_PII_KEY)"), { uid, route: "/api/hosts/kyc/aadhaar/otp", handled: true, app_name: APP, extra: { area: "hf_kyc" } });
    return err(503, "kyc_unavailable", { message: "Verification isn’t available right now. Please try again shortly." });
  }
  const b = await readJson(req);
  if (b.consent !== true) return err(400, "consent_required", { message: "Please agree to the Aadhaar verification notice to continue.", field: "consent" });
  const role = b.role === "lane_caller" ? "lane_caller" : "host";
  const aadhaar = cleanAadhaar(b.aadhaar);
  if (!aadhaar) return err(400, "invalid_aadhaar", { message: "Enter your 12-digit Aadhaar number.", field: "aadhaar" });
  const last4 = aadhaar.slice(-4);

  const done = await kycRow(env, uid).catch(() => null);
  if (done?.verified_at) {
    if (role === "host" && done.role !== "host") {
      await env.DB_META.prepare("UPDATE hf_kyc SET role='host', updated_at=?2 WHERE uid=?1").bind(uid, Date.now()).run();
    }
    return json({ ok: true, already_verified: true, gender: done.gender, last4: done.aadhaar_last4 });
  }

  const lim = (await limited(env, `hfkyc_otp_h:${uid}`, 3, 3600, "Too many Aadhaar codes requested. Please try again in an hour."))
    ?? (await limited(env, `hfkyc_otp_d:${uid}`, 10, 86400, "You’ve reached today’s limit for Aadhaar codes. Please try again tomorrow."))
    ?? (await limited(env, "hfkyc_otp_global", 300, 3600, "We’re getting a lot of verifications right now. Please try again in a few minutes."));
  if (lim) { emit("hf_kyc_failed", { step: "aadhaar_otp", reason: "rate_limited" }); return lim; }

  const now = Date.now();
  const r = await aadhaarOtpGenerate(env, aadhaar, `Hello Fraands ${role === "host" ? "host" : "protected-lane"} identity verification`);
  await env.DB_META.prepare("INSERT INTO hf_kyc_otp (uid, role, provider_ref, status, reason, consent_version, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
    .bind(uid, role, r.ok ? r.data.refId : null, r.ok ? "sent" : "failed", r.ok ? null : r.reason, HF_KYC_CONSENT_VERSION, now).run()
    .catch((e) => trackException(env, e, { uid, route: "/api/hosts/kyc/aadhaar/otp", handled: true, app_name: APP, extra: { area: "hf_kyc", step: "ledger" } }));
  if (!r.ok) return fail(env, emit, uid, "kyc/aadhaar/otp", r);

  await env.TOKENS.put(refKey(uid), JSON.stringify({ refId: r.data.refId, role, last4, consentAt: now, consentVersion: HF_KYC_CONSENT_VERSION }), { expirationTtl: REF_TTL_S });
  emit("hf_kyc_aadhaar_otp_sent", { ok: true, role });
  return json({ ok: true, expires_in_s: REF_TTL_S });
}

// ── POST /api/hosts/kyc/aadhaar/verify ───────────────────────────────────────
async function aadhaarVerify(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const emit = makeEmit(env, ctx, uid);
  if (!sandboxConfigured(env) || !piiKeyConfigured(env)) return err(503, "kyc_unavailable", { message: "Verification isn’t available right now. Please try again shortly." });

  const b = await readJson(req);
  const otp = String(b.otp ?? "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(otp)) return err(400, "invalid_otp", { message: "Enter the 6-digit code.", field: "otp" });

  let pending: { refId: string; role: string; last4: string; consentAt: number; consentVersion: string } | null = null;
  try { pending = JSON.parse((await env.TOKENS.get(refKey(uid))) || "null"); } catch { pending = null; }
  if (!pending?.refId) return err(400, "no_otp", { message: "Request an Aadhaar code first (it may have expired).", field: "otp" });

  const lim = await limited(env, `hfkyc_verify:${uid}`, 6, 600, "Too many wrong codes. Request a new code.");
  if (lim) return lim;

  const r = await aadhaarOtpVerify(env, pending.refId, otp);
  if (!r.ok) {
    if (r.reason === "otp_expired") await env.TOKENS.delete(refKey(uid)).catch(() => {});
    return fail(env, emit, uid, "kyc/aadhaar/verify", r);
  }
  await env.TOKENS.delete(refKey(uid)).catch(() => {});
  const k = r.data;
  const now = Date.now();
  const ledger = (status: string, reason: string | null) =>
    env.DB_META.prepare("INSERT INTO hf_kyc_otp (uid, role, provider_ref, status, reason, consent_version, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
      .bind(uid, pending!.role, k.refId, status, reason, pending!.consentVersion, now).run().catch(() => {});

  // 18+ (HF-HOST rules). Under-18 → store NOTHING from the e-KYC record.
  const adult = isAdult(k.dobIso, k.yearOfBirth);
  if (adult === false) {
    await ledger("declined", "under_18");
    emit("hf_kyc_declined", { reason: "under_18" });
    return err(403, "under_18", { message: "You must be 18 or older to continue." });
  }
  if (adult === null) {
    await ledger("rejected", "age_unverifiable");
    emit("hf_kyc_declined", { reason: "age_unverifiable" });
    return err(422, "age_unverifiable", { message: "We couldn’t confirm your age from this record. Please contact support." });
  }
  const gender = mapGender(k.gender);
  if (!gender) {
    await ledger("rejected", "gender_unreadable");
    emit("hf_kyc_declined", { reason: "gender_unreadable" });
    return err(422, "gender_unreadable", { message: "We couldn’t read the gender on this record. Please contact support." });
  }

  let photoKey: string | null = null;
  try {
    const [nameEnc, dobEnc, addrEnc, guardEnc] = await Promise.all([
      encryptPii(env, k.name),
      encryptPii(env, k.dobIso ?? String(k.yearOfBirth ?? "")),
      encryptPii(env, k.address),
      k.careOf ? encryptPii(env, k.careOf) : Promise.resolve(null),
    ]);
    if (k.photo && k.photo.byteLength > 0) {
      photoKey = `hf/kyc/${uid}/aadhaar-photo.jpg`;
      await env.VERIFICATION.put(photoKey, k.photo, { httpMetadata: { contentType: "image/jpeg" } });
    }
    await env.DB_META.prepare(
      `INSERT INTO hf_kyc (uid, role, aadhaar_last4, provider, provider_ref, name_enc, dob_enc, address_enc, guardian_name_enc, gender, age_ok,
                           photo_r2_key, consent_version, consent_at, verified_at, updated_at)
       VALUES (?1,?2,?3,'sandbox',?4,?5,?6,?7,?8,?9,1,?10,?11,?12,?13,?13)
       ON CONFLICT(uid) DO UPDATE SET role=excluded.role, aadhaar_last4=excluded.aadhaar_last4, provider_ref=excluded.provider_ref,
         name_enc=excluded.name_enc, dob_enc=excluded.dob_enc, address_enc=excluded.address_enc, guardian_name_enc=excluded.guardian_name_enc,
         gender=excluded.gender, age_ok=1, photo_r2_key=excluded.photo_r2_key, consent_version=excluded.consent_version,
         consent_at=excluded.consent_at, verified_at=excluded.verified_at, updated_at=excluded.updated_at`,
    ).bind(uid, pending.role, pending.last4, k.refId, nameEnc, dobEnc, addrEnc, guardEnc, gender, photoKey,
      pending.consentVersion, pending.consentAt, now).run();
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hosts/kyc/aadhaar/verify", handled: true, app_name: APP, extra: { area: "hf_kyc", step: "store" } });
    emit("hf_kyc_failed", { step: "kyc/aadhaar/store", reason: "store_failed" });
    return err(500, "store_failed", { message: "We couldn’t save your verification. Please try again." });
  }
  await ledger("verified", null);
  emit("hf_kyc_aadhaar_verified", { gender, age_ok: true, role: pending.role, has_photo: !!photoKey });
  return json({ ok: true, gender, ageOk: true, last4: pending.last4, firstName: firstNameOf(k.name) });
}

// ── selfie ───────────────────────────────────────────────────────────────────
async function selfieCode(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const lim = await limited(env, `hfkyc_code:${u.uid}`, 10, 3600, "Too many attempts. Please try again later.");
  if (lim) return lim;
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  const code = String(n).padStart(4, "0");
  await env.TOKENS.put(codeKey(u.uid), code, { expirationTtl: CODE_TTL_S });
  void ctx;
  return json({ code, expires_in_s: CODE_TTL_S });
}

async function selfieUpload(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const emit = makeEmit(env, ctx, uid);

  const sent = (req.headers.get("x-selfie-code") || "").trim();
  const want = await env.TOKENS.get(codeKey(uid)).catch(() => null);
  if (!want) return err(400, "code_expired", { message: "That code has expired. Get a new code and record again.", field: "code" });
  if (sent !== want) { emit("hf_kyc_failed", { step: "selfie", reason: "code_mismatch" }); return err(400, "code_mismatch", { message: "The code doesn’t match. Record again.", field: "code" }); }

  const lim = await limited(env, `hfkyc_selfie:${uid}`, 8, 3600, "Too many uploads. Please try again later.");
  if (lim) return lim;

  const mime = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = SELFIE_TYPES[mime];
  if (!ext) return err(415, "unsupported_type", { message: "Please record a short video (webm, mp4 or mov).", accepted: Object.keys(SELFIE_TYPES) });
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_SELFIE_BYTES) return err(413, "too_large", { message: "That video is too large. Keep it to about 10 seconds.", max_bytes: MAX_SELFIE_BYTES });

  const buf = await req.arrayBuffer().catch(() => null);
  if (!buf) return err(400, "bad_body");
  if (buf.byteLength > MAX_SELFIE_BYTES) return err(413, "too_large", { message: "That video is too large. Keep it to about 10 seconds.", max_bytes: MAX_SELFIE_BYTES });
  if (buf.byteLength < MIN_SELFIE_BYTES) return err(400, "too_small", { message: "That video looks empty. Record again." });

  const ts = Date.now();
  const key = `hf/selfie/${uid}/${ts}.${ext}`;
  const id = crypto.randomUUID();
  try {
    await env.VERIFICATION.put(key, buf, { httpMetadata: { contentType: mime } });
    try {
      await env.DB_META.prepare("INSERT INTO hf_selfie (id, uid, code, r2_key, mime, bytes, created_at, review_status) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending')")
        .bind(id, uid, sent, key, mime, buf.byteLength, ts).run();
    } catch (e) {
      await env.VERIFICATION.delete(key).catch(() => {});
      throw e;
    }
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hosts/kyc/selfie", handled: true, app_name: APP, extra: { area: "hf_kyc", step: "selfie_store" } });
    emit("hf_kyc_failed", { step: "selfie", reason: "store_failed" });
    return err(500, "store_failed", { message: "We couldn’t save your video. Please try again." });
  }
  await env.TOKENS.delete(codeKey(uid)).catch(() => {});
  emit("hf_kyc_selfie_uploaded", { ok: true, bytes: buf.byteLength, mime });
  return json({ ok: true, status: "pending" });
}

// ── payout ───────────────────────────────────────────────────────────────────
const maskName = (s: string): string => s.split(/\s+/).filter(Boolean).map((t) => t.charAt(0) + "*".repeat(Math.max(0, t.length - 1))).join(" ");

async function payoutVerify(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const emit = makeEmit(env, ctx, uid);
  if (!sandboxConfigured(env) || !piiKeyConfigured(env)) return err(503, "kyc_unavailable", { message: "Verification isn’t available right now. Please try again shortly." });

  const b = await readJson(req);
  const upi = String(b.upi ?? "").trim().toLowerCase();
  const account = String(b.account ?? "").replace(/\s/g, "");
  const ifsc = String(b.ifsc ?? "").trim().toUpperCase();
  if (!UPI_RE.test(upi)) return err(400, "invalid_upi", { message: "Enter a valid UPI ID, like name@bank.", field: "upi" });
  if (!ACCOUNT_RE.test(account)) return err(400, "invalid_account", { message: "Enter your bank account number (9–18 digits).", field: "account" });
  if (!IFSC_RE.test(ifsc)) return err(400, "invalid_ifsc", { message: "Enter a valid IFSC code, like HDFC0001234.", field: "ifsc" });

  const kyc = await kycRow(env, uid).catch(() => null);
  if (!kyc?.verified_at) return err(409, "aadhaar_required", { message: "Verify your Aadhaar first." });
  const aadhaarName = await tryDecryptPii(env, kyc.name_enc);
  if (!aadhaarName) {
    await trackException(env, new Error("hf_kyc name undecryptable"), { uid, route: "/api/hosts/payout/verify", handled: true, app_name: APP, extra: { area: "hf_kyc", step: "decrypt" } });
    return err(500, "kyc_unreadable", { message: "We couldn’t read your verification. Please contact support." });
  }

  // Every call is a paid vendor lookup AND would let someone probe other people's account holder names: keep it tight.
  const lim = (await limited(env, `hfkyc_payout_h:${uid}`, 5, 3600, "Too many bank checks. Please try again in an hour."))
    ?? (await limited(env, `hfkyc_payout_d:${uid}`, 12, 86400, "You’ve reached today’s limit for bank checks. Please try again tomorrow."));
  if (lim) { emit("hf_kyc_failed", { step: "payout", reason: "rate_limited" }); return lim; }

  const bank = await bankVerify(env, account, ifsc);
  if (!bank.ok) return fail(env, emit, uid, "payout/verify", bank);
  const vpa = await upiVerify(env, upi); // Sandbox has none → "unsupported" → stored unverified
  const upiVerified = vpa.ok && namesMatch(aadhaarName, vpa.data.nameAtBank);

  const match = namesMatch(aadhaarName, bank.data.nameAtBank);
  const now = Date.now();
  const last4 = account.slice(-4);
  try {
    const [upiEnc, accEnc, nameEnc] = await Promise.all([encryptPii(env, upi), encryptPii(env, account), encryptPii(env, bank.data.nameAtBank)]);
    await env.DB_META.prepare(
      `INSERT INTO hf_payout (uid, upi_enc, upi_verified, account_enc, account_last4, ifsc, name_at_bank_enc, name_match, verified_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
       ON CONFLICT(uid) DO UPDATE SET upi_enc=excluded.upi_enc, upi_verified=excluded.upi_verified, account_enc=excluded.account_enc,
         account_last4=excluded.account_last4, ifsc=excluded.ifsc, name_at_bank_enc=excluded.name_at_bank_enc, name_match=excluded.name_match,
         verified_at=excluded.verified_at, updated_at=excluded.updated_at`,
    ).bind(uid, upiEnc, upiVerified ? 1 : 0, accEnc, last4, ifsc, nameEnc, match ? 1 : 0, match ? now : null, now).run();
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hosts/payout/verify", handled: true, app_name: APP, extra: { area: "hf_kyc", step: "payout_store" } });
    emit("hf_kyc_failed", { step: "payout", reason: "store_failed" });
    return err(500, "store_failed", { message: "We couldn’t save your payout details. Please try again." });
  }
  emit("hf_payout_verified", { match, upi_verified: upiVerified, upi_check: vpa.ok ? "done" : "unsupported" });
  // Only reveal the bank's full name when it matches HOLDER's own Aadhaar name; otherwise masked (no name-lookup oracle).
  return json({ ok: true, nameAtBank: match ? bank.data.nameAtBank : maskName(bank.data.nameAtBank), match, accountLast4: last4, upiVerified });
}

// ── status ───────────────────────────────────────────────────────────────────
async function status(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const [kyc, selfie, payout] = await Promise.all([
    kycRow(env, u.uid).catch(() => null),
    env.DB_META.prepare("SELECT review_status, review_reason FROM hf_selfie WHERE uid=?1 ORDER BY created_at DESC LIMIT 1").bind(u.uid)
      .first<{ review_status: string; review_reason: string | null }>().catch(() => null),
    env.DB_META.prepare("SELECT name_match, account_last4, upi_verified FROM hf_payout WHERE uid=?1").bind(u.uid)
      .first<{ name_match: number; account_last4: string | null; upi_verified: number }>().catch(() => null),
  ]);
  return json({
    aadhaar: { done: !!kyc?.verified_at, gender: kyc?.gender ?? null, last4: kyc?.aadhaar_last4 ?? null, role: kyc?.role ?? null },
    selfie: { status: selfie?.review_status ?? "none", reason: selfie?.review_status === "rejected" ? selfie.review_reason : null },
    payout: { done: !!payout && payout.name_match === 1, match: payout ? payout.name_match === 1 : false, accountLast4: payout?.account_last4 ?? null, upiVerified: payout ? payout.upi_verified === 1 : false },
  });
}

// ── admin ────────────────────────────────────────────────────────────────────
const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (const x of a) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o;
};
async function hmacKey(env: Env): Promise<CryptoKey> {
  // Domain-separated from the AES key: HMAC key = SHA-256("hf-media-v1" || HF_PII_KEY bytes).
  const raw = piiKeyBytes(env);
  const seed = new Uint8Array(11 + raw.length);
  seed.set(new TextEncoder().encode("hf-media-v1")); seed.set(raw, 11);
  const k = await crypto.subtle.digest("SHA-256", seed);
  return crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signMedia(env: Env, adminUid: string, kind: "selfie" | "photo", id: string): Promise<string> {
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ e: Date.now() + MEDIA_URL_TTL_MS, a: adminUid, k: kind, i: id })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(payload));
  return `/api/admin/hf/kyc/media?t=${payload}.${b64u(sig)}`;
}

async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  return { uid: u.uid };
}

async function adminList(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  if (!piiKeyConfigured(env)) return err(503, "kyc_unavailable");
  const st = new URL(req.url).searchParams.get("status") || "pending";
  if (!["pending", "approved", "rejected"].includes(st)) return err(400, "bad_status");
  const rows = (await env.DB_META.prepare(
    `SELECT s.id, s.uid, s.code, s.mime, s.bytes, s.created_at, s.review_status, s.review_reason, k.name_enc, k.gender, k.aadhaar_last4, k.role, k.photo_r2_key
       FROM hf_selfie s LEFT JOIN hf_kyc k ON k.uid = s.uid
      WHERE s.review_status = ?1 ORDER BY s.created_at ASC LIMIT 50`,
  ).bind(st).all<{ id: string; uid: string; code: string; mime: string; bytes: number; created_at: number; review_status: string; review_reason: string | null;
    name_enc: string | null; gender: string | null; aadhaar_last4: string | null; role: string | null; photo_r2_key: string | null }>()).results ?? [];
  const items = await Promise.all(rows.map(async (r) => ({
    selfieId: r.id, uid: r.uid, email: await emailFor(env, r.uid).catch(() => null), code: r.code, createdAt: r.created_at, bytes: r.bytes, mime: r.mime,
    status: r.review_status, reason: r.review_reason,
    aadhaar: r.gender ? { name: await tryDecryptPii(env, r.name_enc), gender: r.gender, last4: r.aadhaar_last4, role: r.role } : null,
    selfieUrl: await signMedia(env, a.uid, "selfie", r.id),
    photoUrl: r.photo_r2_key ? await signMedia(env, a.uid, "photo", r.uid) : null,
    urlExpiresInS: MEDIA_URL_TTL_MS / 1000,
  })));
  await audit(env, a.uid, "list", st, { count: items.length });
  return json({ ok: true, items });
}

async function adminMedia(req: Request, env: Env): Promise<Response> {
  const t = new URL(req.url).searchParams.get("t") || "";
  const [payload, sig] = t.split(".");
  if (!payload || !sig || !piiKeyConfigured(env)) return err(403, "bad_token");
  let claims: { e: number; a: string; k: string; i: string };
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64u(sig), new TextEncoder().encode(payload));
    if (!ok) return err(403, "bad_token");
    claims = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
  } catch { return err(403, "bad_token"); }
  if (!(claims.e > Date.now())) return err(403, "token_expired");
  if (!isAdminUid(env, claims.a)) return err(403, "forbidden");

  let key: string | null = null, mime = "image/jpeg", target = claims.i;
  if (claims.k === "selfie") {
    const r = await env.DB_META.prepare("SELECT r2_key, mime, uid FROM hf_selfie WHERE id=?1").bind(claims.i).first<{ r2_key: string; mime: string; uid: string }>();
    if (r) { key = r.r2_key; mime = r.mime || "video/webm"; target = r.uid; }
  } else if (claims.k === "photo") {
    const r = await env.DB_META.prepare("SELECT photo_r2_key FROM hf_kyc WHERE uid=?1").bind(claims.i).first<{ photo_r2_key: string | null }>();
    key = r?.photo_r2_key ?? null;
  }
  if (!key) return err(404, "not_found");

  const range = req.headers.get("range");
  const obj = await env.VERIFICATION.get(key, range ? { range: req.headers } : undefined);
  if (!obj) return err(404, "not_found");
  await audit(env, claims.a, `view_${claims.k}`, target, { key });

  const headers = new Headers({
    "content-type": mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes",
  });
  const rg = (obj as unknown as { range?: { offset?: number; length?: number } }).range;
  if (range && rg && rg.offset != null && rg.length != null) {
    headers.set("content-range", `bytes ${rg.offset}-${rg.offset + rg.length - 1}/${obj.size}`);
    headers.set("content-length", String(rg.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

async function adminDecide(req: Request, env: Env, ctx: ExecutionContext | undefined, targetUid: string): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const b = await readJson(req);
  const decision = b.decision === "approve" ? "approved" : b.decision === "reject" ? "rejected" : null;
  if (!decision) return err(400, "bad_decision", { message: "decision must be approve or reject" });
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  if (decision === "rejected" && !reason) return err(400, "reason_required", { message: "Give a reason when rejecting." });
  const selfieId = typeof b.selfieId === "string" ? b.selfieId.slice(0, 64) : "";

  const row = selfieId
    ? await env.DB_META.prepare("SELECT id, review_status FROM hf_selfie WHERE id=?1 AND uid=?2").bind(selfieId, targetUid).first<{ id: string; review_status: string }>()
    : await env.DB_META.prepare("SELECT id, review_status FROM hf_selfie WHERE uid=?1 AND review_status='pending' ORDER BY created_at DESC LIMIT 1").bind(targetUid).first<{ id: string; review_status: string }>();
  if (!row) return err(404, "no_pending_selfie");
  if (row.review_status !== "pending") return err(409, "already_reviewed", { status: row.review_status });

  const res = await env.DB_META.prepare(
    "UPDATE hf_selfie SET review_status=?2, review_reason=?3, reviewed_by=?4, reviewed_at=?5 WHERE id=?1 AND review_status='pending'",
  ).bind(row.id, decision, reason || null, a.uid, Date.now()).run();
  if (!res.meta?.changes) return err(409, "already_reviewed");
  await audit(env, a.uid, `selfie_${decision}`, targetUid, { selfieId: row.id, reason });
  makeEmit(env, ctx, targetUid)("hf_kyc_selfie_reviewed", { ok: true, decision, admin_uid: a.uid });
  return json({ ok: true, status: decision });
}

// ── router ───────────────────────────────────────────────────────────────────
/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfHostKycRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = req.method;
  const adminDecideMatch = p.match(/^\/api\/admin\/hf\/kyc\/([A-Za-z0-9._:-]{1,128})\/selfie$/);
  const ours =
    p.startsWith("/api/hosts/kyc/") || p.startsWith("/api/hosts/payout/") || p === "/api/admin/hf/kyc" || p === "/api/admin/hf/kyc/media" || !!adminDecideMatch;
  if (!ours) return null;
  try {
    if ((await readConfig(env)).hostKycEnabled !== true) return err(404, "not_enabled");
    if (p === "/api/hosts/kyc/aadhaar/otp" && m === "POST") return await aadhaarOtp(req, env, ctx);
    if (p === "/api/hosts/kyc/aadhaar/verify" && m === "POST") return await aadhaarVerify(req, env, ctx);
    if (p === "/api/hosts/kyc/selfie/code" && m === "POST") return await selfieCode(req, env, ctx);
    if (p === "/api/hosts/kyc/selfie" && m === "POST") return await selfieUpload(req, env, ctx);
    if (p === "/api/hosts/payout/verify" && m === "POST") return await payoutVerify(req, env, ctx);
    if (p === "/api/hosts/kyc/status" && m === "GET") return await status(req, env);
    if (p === "/api/admin/hf/kyc" && m === "GET") return await adminList(req, env);
    if (p === "/api/admin/hf/kyc/media" && m === "GET") return await adminMedia(req, env);
    if (adminDecideMatch && m === "POST") return await adminDecide(req, env, ctx, adminDecideMatch[1]);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_kyc" } });
    return err(500, "internal_error");
  }
}
