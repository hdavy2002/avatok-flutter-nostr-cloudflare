// [HF-HOST-KYC-1 2026-10-09] Typed client for Sandbox.co.in (https://developer.sandbox.co.in) — the India
// KYC vendor chosen in rulebook HF-KYC-1. Used ONLY by routes/hf_host_kyc.ts.
//
// Docs (read 2026-10-09):
//   Authenticate  https://developer.sandbox.co.in/reference/authenticate-api
//   Aadhaar OTP   https://developer.sandbox.co.in/api-reference/kyc/aadhaar/endpoints/generate_otp.md
//   Aadhaar verify https://developer.sandbox.co.in/api-reference/kyc/aadhaar/endpoints/verify_otp.md
//   Penny-less    https://developer.sandbox.co.in/api-reference/kyc/bank/endpoints/penny_less.md
//   Penny drop    https://developer.sandbox.co.in/api-reference/kyc/bank/endpoints/penny_drop.md (NOT used: it deposits ₹1)
//
// Base URL: prod https://api.sandbox.co.in, test https://test-api.sandbox.co.in (env SANDBOX_BASE_URL overrides).
//
// AUTH  POST {base}/authenticate
//   headers: x-api-key, x-api-secret, x-api-version: 1.0
//   200 -> { code, timestamp, transaction_id, data: { access_token } }   (token valid 24 h)
//   The token is sent as the RAW `Authorization: <token>` header — NO "Bearer" prefix (per docs).
//   Cached in KV TOKENS for ~23 h; on a 401/403 from an endpoint we drop the cache and re-auth once.
//
// AADHAAR OTP  POST {base}/kyc/aadhaar/okyc/otp
//   headers: Authorization, x-api-key, x-api-version: 1.0.0, Content-Type: application/json
//   body: { "@entity": "in.co.sandbox.kyc.aadhaar.okyc.otp.request", aadhaar_number: "<12 digits>", consent: "y", reason: "<text>" }
//   200 -> { code, timestamp, transaction_id, data: { "@entity": "...otp.response", reference_id: <int>, message } }
//   200 + data.message "Invalid Aadhaar Card" = bad number; 422 "Invalid Aadhaar number pattern"; 503 "Source Unavailable".
//
// AADHAAR VERIFY  POST {base}/kyc/aadhaar/okyc/otp/verify
//   body: { "@entity": "in.co.sandbox.kyc.aadhaar.okyc.request", reference_id: "<string>", otp: "<6 digits>" }
//   200 + data.status "VALID" -> data: { name, gender "M"|"F"|..., date_of_birth "DD-MM-YYYY", year_of_birth, care_of "S/O: ...",
//        address{house,street,landmark,post_office,subdistrict,district,vtc,state,country,pincode}, full_address,
//        photo "data:image/jpeg;base64,...", email_hash, mobile_hash, share_code }
//   200 + data.message "Invalid OTP" | "OTP Expired" | "Request under process, please try after 30 seconds" (no status);
//   422 "OTP missing in request"; 503 "Source Unavailable".
//
// *** UNCONFIRMED / RISK *** Both Aadhaar pages carry "This Aadhaar verification endpoint has been deprecated by UIDAI.
// We recommend migrating to the DigiLocker-based verification flow" (while the OpenAPI says deprecated:false). It may
// stop working without notice — see HF-HOST-KYC-1-RUNBOOK. TODO(owner): ask Sandbox support whether OKYC is still live
// for our account, and plan a DigiLocker adapter (https://developer.sandbox.co.in/api-reference/kyc/digilocker/overview.md)
// behind the same aadhaarOtpGenerate/aadhaarOtpVerify surface.
//
// BANK (penniless)  GET {base}/bank/{ifsc}/accounts/{account_number}/penniless-verify
//   headers: Authorization, x-api-key, x-api-version: 1.0.0 ; no body ; (optional ?name=&mobile= — we do NOT send them,
//   the docs do not say whether they change the outcome)
//   200 -> data: { "@entity": "@in.co.sandbox.bank.account.penny_less_verification_response", account_exists, name_at_bank }
//   200 with no name_at_bank + data.message: "Invalid account number or ifsc provided" | "Beneficiary bank offline" | "Account is blocked".
//   Penny-less only works with SUPPORTED banks (docs); an unsupported bank's exact response is not documented ->
//   TODO(confirm in staging) — we map any 200 without name_at_bank to reason "unverifiable".
//   The paid fallback (penny-drop: GET .../accounts/{n}/verify, deposits ₹1) is deliberately NOT called: HF-KYC-4 says
//   "no-deposit check". Add it only on an owner decision.
//
// UPI VPA  *** Sandbox has NO UPI/VPA verification endpoint (docs index checked 2026-10-09). ***
//   upiVerify() therefore returns { ok:false, reason:"unsupported" } and the route stores the UPI id as UNVERIFIED.
//   TODO(owner): pick a VPA vendor (e.g. Cashfree/Razorpay validate-VPA) and implement it here; nothing else changes.
//
// Secrets: SANDBOX_API_KEY, SANDBOX_API_SECRET. Values are never logged, never in error messages.
import type { Env } from "../types";

const DEFAULT_BASE = "https://api.sandbox.co.in";
const TIMEOUT_MS = 15_000;
const TOKEN_KV = "sandbox:token:v1";
const TOKEN_TTL_S = 23 * 3600; // docs: valid 24 h

export type SandboxFail = {
  ok: false;
  reason:
    | "not_configured" | "auth_failed" | "timeout" | "unavailable"   // infra: ours or theirs
    | "invalid_aadhaar" | "invalid_input"                            // caller error
    | "invalid_otp" | "otp_expired" | "retry_later"                  // OTP step
    | "account_not_found" | "account_blocked" | "bank_offline" | "unverifiable" // bank step
    | "unsupported" | "bad_response";
  message?: string; // vendor message (safe: contains no secrets or the Aadhaar number)
  status?: number;
  txn?: string;
};
export type SandboxOk<T> = { ok: true; data: T; txn?: string };
export type SandboxResult<T> = SandboxOk<T> | SandboxFail;

export interface AadhaarKyc {
  refId: string;
  name: string;
  /** "M" | "F" | raw vendor value (route maps to F/M/T). */
  gender: string;
  /** ISO yyyy-mm-dd, or null when the vendor sent only the year. */
  dobIso: string | null;
  yearOfBirth: number | null;
  careOf: string | null;
  address: string;
  /** Raw JPEG bytes decoded from the data-URI, when returned. */
  photo: Uint8Array | null;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function base(env: Env): string {
  return (env.SANDBOX_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}
export function sandboxConfigured(env: Env): boolean {
  return Boolean(env.SANDBOX_API_KEY && env.SANDBOX_API_SECRET);
}

async function http(url: string, init: RequestInit): Promise<{ status: number; body: Json } | "timeout" | "network"> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, cf: { cacheTtl: 0, cacheEverything: false } } as RequestInit);
    const body = (await r.json().catch(() => ({}))) as Json;
    return { status: r.status, body };
  } catch (e) {
    return (e as { name?: string })?.name === "AbortError" ? "timeout" : "network";
  } finally {
    clearTimeout(t);
  }
}

/** Fresh token (cached in KV ~23 h). `force` skips the cache after a 401/403. */
export async function sandboxToken(env: Env, force = false): Promise<SandboxResult<string>> {
  if (!sandboxConfigured(env)) return { ok: false, reason: "not_configured" };
  if (!force) {
    try { const c = await env.TOKENS.get(TOKEN_KV); if (c) return { ok: true, data: c }; } catch { /* fall through */ }
  }
  const r = await http(`${base(env)}/authenticate`, {
    method: "POST",
    headers: { "x-api-key": env.SANDBOX_API_KEY!, "x-api-secret": env.SANDBOX_API_SECRET!, "x-api-version": "1.0", accept: "application/json" },
  });
  if (r === "timeout") return { ok: false, reason: "timeout" };
  if (r === "network") return { ok: false, reason: "unavailable" };
  const token = str((r.body.data as Json | undefined)?.access_token);
  if (r.status !== 200 || !token) return { ok: false, reason: "auth_failed", status: r.status, message: str(r.body.message).slice(0, 200) };
  try { await env.TOKENS.put(TOKEN_KV, token, { expirationTtl: TOKEN_TTL_S }); } catch { /* best-effort */ }
  return { ok: true, data: token };
}

/** Authenticated call with one transparent re-auth on 401/403. */
async function call(env: Env, method: "GET" | "POST", path: string, body?: Json): Promise<SandboxResult<{ status: number; body: Json }>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await sandboxToken(env, attempt > 0);
    if (!tok.ok) return tok;
    const r = await http(`${base(env)}${path}`, {
      method,
      headers: {
        Authorization: tok.data, // raw token, no "Bearer" (docs)
        "x-api-key": env.SANDBOX_API_KEY!,
        "x-api-version": "1.0.0",
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r === "timeout") return { ok: false, reason: "timeout" };
    if (r === "network") return { ok: false, reason: "unavailable" };
    if ((r.status === 401 || r.status === 403) && attempt === 0) continue;
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "auth_failed", status: r.status };
    if (r.status >= 500) return { ok: false, reason: "unavailable", status: r.status, message: str(r.body.message).slice(0, 200), txn: str(r.body.transaction_id) || undefined };
    return { ok: true, data: { status: r.status, body: r.body }, txn: str(r.body.transaction_id) || undefined };
  }
  return { ok: false, reason: "auth_failed" };
}

const dataOf = (b: Json): Json => ((b.data && typeof b.data === "object" ? b.data : {}) as Json);

/** Step 1: send the OTP to the mobile linked to the Aadhaar. Returns the vendor reference id. */
export async function aadhaarOtpGenerate(env: Env, aadhaar12: string, consentReason: string): Promise<SandboxResult<{ refId: string }>> {
  if (!/^\d{12}$/.test(aadhaar12)) return { ok: false, reason: "invalid_aadhaar" };
  const r = await call(env, "POST", "/kyc/aadhaar/okyc/otp", {
    "@entity": "in.co.sandbox.kyc.aadhaar.okyc.otp.request",
    aadhaar_number: aadhaar12,
    consent: "y",
    reason: consentReason.slice(0, 120),
  });
  if (!r.ok) return r;
  const { status, body } = r.data;
  const d = dataOf(body);
  if (status === 422) return { ok: false, reason: "invalid_aadhaar", status, message: str(body.message).slice(0, 200), txn: r.txn };
  const ref = d.reference_id;
  if (status === 200 && ref != null && ref !== "") return { ok: true, data: { refId: String(ref) }, txn: r.txn };
  if (/invalid aadhaar/i.test(str(d.message))) return { ok: false, reason: "invalid_aadhaar", status, message: str(d.message).slice(0, 200), txn: r.txn };
  return { ok: false, reason: "bad_response", status, message: str(d.message || body.message).slice(0, 200), txn: r.txn };
}

/** DD-MM-YYYY (vendor) -> yyyy-mm-dd; null if unparseable. */
export function parseVendorDob(s: string): string | null {
  const m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const mo = Number(mm), da = Number(dd);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function addressOf(d: Json): string {
  const full = str(d.full_address).trim();
  if (full) return full;
  const a = (d.address && typeof d.address === "object" ? d.address : {}) as Json;
  return ["house", "street", "landmark", "post_office", "subdistrict", "district", "vtc", "state", "country", "pincode"]
    .map((k) => str(a[k]).trim()).filter(Boolean).join(", ");
}

function decodeDataUri(uri: string): Uint8Array | null {
  const raw = uri.includes(",") ? uri.slice(uri.indexOf(",") + 1) : uri;
  if (!raw) return null;
  try {
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/** Step 2: verify the OTP and receive the offline e-KYC record. */
export async function aadhaarOtpVerify(env: Env, refId: string, otp: string): Promise<SandboxResult<AadhaarKyc>> {
  if (!/^\d{6}$/.test(otp) || !refId) return { ok: false, reason: "invalid_input" };
  const r = await call(env, "POST", "/kyc/aadhaar/okyc/otp/verify", {
    "@entity": "in.co.sandbox.kyc.aadhaar.okyc.request",
    reference_id: refId,
    otp,
  });
  if (!r.ok) return r;
  const { status, body } = r.data;
  const d = dataOf(body);
  const msg = str(d.message || body.message);
  if (status === 200 && str(d.status).toUpperCase() === "VALID") {
    const name = str(d.name).trim();
    if (!name) return { ok: false, reason: "bad_response", status, txn: r.txn, message: "no name in e-KYC" };
    const yob = Number(str(d.year_of_birth));
    return {
      ok: true,
      txn: r.txn,
      data: {
        refId,
        name,
        gender: str(d.gender).trim().toUpperCase(),
        dobIso: parseVendorDob(str(d.date_of_birth)),
        yearOfBirth: Number.isFinite(yob) && yob > 1900 ? yob : null,
        careOf: str(d.care_of).trim() || null,
        address: addressOf(d),
        photo: d.photo ? decodeDataUri(str(d.photo)) : null,
      },
    };
  }
  if (/invalid otp/i.test(msg)) return { ok: false, reason: "invalid_otp", status, message: msg.slice(0, 200), txn: r.txn };
  if (/expired/i.test(msg)) return { ok: false, reason: "otp_expired", status, message: msg.slice(0, 200), txn: r.txn };
  if (/under process|try after/i.test(msg)) return { ok: false, reason: "retry_later", status, message: msg.slice(0, 200), txn: r.txn };
  if (status === 422) return { ok: false, reason: "invalid_otp", status, message: msg.slice(0, 200), txn: r.txn };
  return { ok: false, reason: "bad_response", status, message: msg.slice(0, 200), txn: r.txn };
}

/** Penny-less (no deposit) bank check -> account holder name at the bank. */
export async function bankVerify(env: Env, account: string, ifsc: string): Promise<SandboxResult<{ nameAtBank: string }>> {
  if (!/^\d{6,40}$/.test(account) || !/^[A-Za-z]{4}[A-Za-z0-9]{7}$/.test(ifsc)) return { ok: false, reason: "invalid_input" };
  const r = await call(env, "GET", `/bank/${encodeURIComponent(ifsc.toUpperCase())}/accounts/${encodeURIComponent(account)}/penniless-verify`);
  if (!r.ok) return r;
  const { status, body } = r.data;
  const d = dataOf(body);
  const msg = str(d.message || body.message);
  if (status === 422) return { ok: false, reason: "invalid_input", status, message: msg.slice(0, 200), txn: r.txn };
  const name = str(d.name_at_bank).trim();
  if (status === 200 && d.account_exists === true && name) return { ok: true, data: { nameAtBank: name }, txn: r.txn };
  if (/blocked/i.test(msg)) return { ok: false, reason: "account_blocked", status, message: msg.slice(0, 200), txn: r.txn };
  if (/offline/i.test(msg)) return { ok: false, reason: "bank_offline", status, message: msg.slice(0, 200), txn: r.txn };
  if (d.account_exists === false || /invalid account/i.test(msg)) return { ok: false, reason: "account_not_found", status, message: msg.slice(0, 200), txn: r.txn };
  return { ok: false, reason: "unverifiable", status, message: msg.slice(0, 200), txn: r.txn };
}

/**
 * UPI VPA check. Sandbox.co.in does not offer one (see header) — this is the seam for another vendor.
 * Returns reason "unsupported" so callers store the VPA as unverified instead of guessing.
 */
export async function upiVerify(_env: Env, _vpa: string): Promise<SandboxResult<{ nameAtBank: string }>> {
  return { ok: false, reason: "unsupported", message: "no UPI verification vendor configured" };
}
