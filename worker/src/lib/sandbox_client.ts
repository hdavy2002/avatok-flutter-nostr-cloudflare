// [HF-HOST-KYC-1 2026-10-09] Typed client for Sandbox.co.in (https://developer.sandbox.co.in) — the India
// KYC vendor chosen in rulebook HF-KYC-1. Used ONLY by routes/hf_host_kyc.ts.
//
// Docs (read 2026-10-09):
//   Authenticate  https://developer.sandbox.co.in/reference/authenticate-api
//   DigiLocker    https://developer.sandbox.co.in/api-reference/kyc/digilocker/overview.md
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
// AADHAAR (DigiLocker) — the old OKYC OTP endpoints (/kyc/aadhaar/okyc/otp[/verify]) were REMOVED: UIDAI deprecated
// them and we no longer receive (or ask for) the 12-digit number. Docs: developer.sandbox.co.in/api-reference/kyc/digilocker
//   INIT     POST {base}/kyc/digilocker/sessions/init
//            body { "@entity": "in.co.sandbox.kyc.digilocker.session.request", flow:"signin", doc_types:["aadhaar"], redirect_url:"https://..." }
//            200 -> data { authorization_url, session_id }; 400 invalid redirect_url; 500 failed.
//   STATUS   GET  {base}/kyc/digilocker/sessions/{id}/status -> data { status: created|succeeded|expired|failed, documents_consented[] }
//            errors 429, 500, 503 (DigiLocker unavailable), 521 (session not found).
//   DOCUMENT GET  {base}/kyc/digilocker/sessions/{id}/documents/aadhaar -> data.files[] { url (presigned S3, 1 h), size, metadata }
//            The url is downloaded with a plain fetch (NO auth headers). It is UIDAI e-Aadhaar XML, parsed by parseEAadhaarXml().
//   PROFILE  GET  {base}/kyc/digilocker/sessions/{id}/user/profile -> data { name, date_of_birth (int), gender, mobile, eaadhaar }
//            523 = session incomplete / token expired. Fallback only: no photo, no address, no last4.
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
    | "invalid_input"                                                // caller error
    | "retry_later" | "session_not_found" | "session_incomplete"     // DigiLocker session
    | "account_not_found" | "account_blocked" | "bank_offline" | "unverifiable" // bank step
    | "unsupported" | "bad_response";
  message?: string; // vendor message (safe: contains no secrets or the Aadhaar number)
  status?: number;
  txn?: string;
};
export type SandboxOk<T> = { ok: true; data: T; txn?: string };
export type SandboxResult<T> = SandboxOk<T> | SandboxFail;

export interface AadhaarKyc {
  /** DigiLocker session id (vendor reference; not the Aadhaar number). */
  refId: string;
  /** Last 4 digits of the Aadhaar (from the masked UidData uid), null when unknown. */
  last4: string | null;
  name: string;
  /** "M" | "F" | raw vendor value (route maps to F/M/T). */
  gender: string;
  /** ISO yyyy-mm-dd, or null when the vendor sent only the year. */
  dobIso: string | null;
  yearOfBirth: number | null;
  careOf: string | null;
  address: string;
  /** Raw JPEG bytes decoded from the e-Aadhaar <Pht> element, when present. */
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
    if (r.status >= 500 && r.status !== 521 && r.status !== 523) return { ok: false, reason: "unavailable", status: r.status, message: str(r.body.message).slice(0, 200), txn: str(r.body.transaction_id) || undefined };
    return { ok: true, data: { status: r.status, body: r.body }, txn: str(r.body.transaction_id) || undefined };
  }
  return { ok: false, reason: "auth_failed" };
}

const dataOf = (b: Json): Json => ((b.data && typeof b.data === "object" ? b.data : {}) as Json);

const DL = "/kyc/digilocker/sessions";

function dlFail(status: number, body: Json, txn?: string): SandboxFail {
  const message = str(dataOf(body).message || body.message).slice(0, 200);
  if (status === 521) return { ok: false, reason: "session_not_found", status, message, txn };
  if (status === 523) return { ok: false, reason: "session_incomplete", status, message, txn };
  if (status === 429) return { ok: false, reason: "retry_later", status, message, txn };
  if (status === 400 || status === 422) return { ok: false, reason: "invalid_input", status, message, txn };
  return { ok: false, reason: "bad_response", status, message, txn };
}

/** Start a DigiLocker session. `redirectUrl` must be public https. Returns the URL to send the user to. */
export async function digilockerInit(env: Env, redirectUrl: string): Promise<SandboxResult<{ sessionId: string; authorizationUrl: string }>> {
  const r = await call(env, "POST", `${DL}/init`, {
    "@entity": "in.co.sandbox.kyc.digilocker.session.request",
    flow: "signin",
    doc_types: ["aadhaar"],
    redirect_url: redirectUrl,
  });
  if (!r.ok) return r;
  const { status, body } = r.data;
  const d = dataOf(body);
  const sessionId = str(d.session_id);
  const url = str(d.authorization_url);
  if (status === 200 && sessionId && /^https:\/\//.test(url)) return { ok: true, data: { sessionId, authorizationUrl: url }, txn: r.txn };
  return dlFail(status, body, r.txn);
}

export type DigilockerState = "created" | "succeeded" | "expired" | "failed";

export async function digilockerStatus(env: Env, sessionId: string): Promise<SandboxResult<{ state: DigilockerState; documents: string[] }>> {
  if (!sessionId) return { ok: false, reason: "invalid_input" };
  const r = await call(env, "GET", `${DL}/${encodeURIComponent(sessionId)}/status`);
  if (!r.ok) return r;
  const { status, body } = r.data;
  const d = dataOf(body);
  const st = str(d.status).toLowerCase();
  if (status === 200 && (st === "created" || st === "succeeded" || st === "expired" || st === "failed")) {
    const docs = Array.isArray(d.documents_consented) ? d.documents_consented.map((x) => str(x).toLowerCase()) : [];
    return { ok: true, data: { state: st, documents: docs }, txn: r.txn };
  }
  return dlFail(status, body, r.txn);
}

async function downloadText(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // Presigned S3 URL: plain fetch, deliberately NO Authorization / x-api-key headers.
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    const txt = await r.text();
    return txt.length > 0 && txt.length < 2_000_000 ? txt : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** Fetch the consented e-Aadhaar XML and parse it. `bad_response` when the file is missing or unparseable. */
export async function digilockerAadhaar(env: Env, sessionId: string): Promise<SandboxResult<AadhaarKyc>> {
  if (!sessionId) return { ok: false, reason: "invalid_input" };
  const r = await call(env, "GET", `${DL}/${encodeURIComponent(sessionId)}/documents/aadhaar`);
  if (!r.ok) return r;
  const { status, body } = r.data;
  if (status !== 200) return dlFail(status, body, r.txn);
  const files = dataOf(body).files;
  const first = Array.isArray(files) ? (files[0] as Json | undefined) : undefined;
  const url = first ? str(first.url) : "";
  if (!/^https:\/\//.test(url)) return { ok: false, reason: "bad_response", status, txn: r.txn, message: "no aadhaar file" };
  const xml = await downloadText(url);
  if (!xml) return { ok: false, reason: "bad_response", status, txn: r.txn, message: "aadhaar file not downloadable" };
  const k = parseEAadhaarXml(xml);
  if (!k) return { ok: false, reason: "bad_response", status, txn: r.txn, message: "aadhaar file not parseable" };
  return { ok: true, txn: r.txn, data: { refId: sessionId, ...k } };
}

/** epoch ms | epoch s | "DD-MM-YYYY" | "YYYY-MM-DD" -> yyyy-mm-dd (IST calendar day), or null. */
export function profileDobToIso(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    const d = parseVendorDob(t);
    if (d) return d;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    if (!/^-?\d+$/.test(t)) return null;
    v = Number(t);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const ms = Math.abs(v) >= 1e11 ? v : v * 1000; // seconds vs milliseconds
  const d = new Date(ms + 5.5 * 3600_000); // IST day (also correct for UTC-midnight stamps)
  const y = d.getUTCFullYear();
  if (!(y >= 1900 && y <= 2100)) return null;
  return d.toISOString().slice(0, 10);
}

/** Fallback: name/DOB/gender only (no photo, address or last4). */
export async function digilockerProfile(env: Env, sessionId: string): Promise<SandboxResult<AadhaarKyc>> {
  if (!sessionId) return { ok: false, reason: "invalid_input" };
  const r = await call(env, "GET", `${DL}/${encodeURIComponent(sessionId)}/user/profile`);
  if (!r.ok) return r;
  const { status, body } = r.data;
  if (status !== 200) return dlFail(status, body, r.txn);
  const d = dataOf(body);
  const name = str(d.name).trim();
  if (!name) return { ok: false, reason: "bad_response", status, txn: r.txn, message: "no name in profile" };
  const dobIso = profileDobToIso(d.date_of_birth);
  const g = str(d.gender).trim().toLowerCase();
  const gender = g === "male" ? "M" : g === "female" ? "F" : g === "transgender" ? "T" : g.toUpperCase();
  return {
    ok: true, txn: r.txn,
    data: { refId: sessionId, last4: null, name, gender, dobIso, yearOfBirth: dobIso ? Number(dobIso.slice(0, 4)) : null, careOf: null, address: "", photo: null },
  };
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

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
    }
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; } catch { return m; }
  });
}

/** Attributes of the first `<tag ...>` in xml (case-insensitive attribute names, entity-decoded values), or null. */
function tagAttrs(xml: string, tag: string): Record<string, string> | null {
  const m = new RegExp(`<${tag}\\b([^>]*)>`, "i").exec(xml);
  if (!m) return null;
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(m[1]))) out[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? "").trim();
  return out;
}
const pick = (o: Record<string, string>, ...keys: string[]): string => {
  for (const k of keys) if (o[k]) return o[k];
  return "";
};

function decodeB64(raw: string): Uint8Array | null {
  const clean = raw.replace(/\s+/g, "");
  if (!clean) return null;
  try {
    const bin = atob(clean);
    if (!bin.length) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/**
 * Parse a UIDAI e-Aadhaar XML (Certificate > CertificateData > KycRes > UidData{uid, Poi, Poa, LData, Pht}).
 * Workers have no DOMParser, so this is attribute-regex based. The regional-language <LData> copy is ignored.
 * Returns null when the uid or the name is missing. Never logs or returns more than the last 4 digits of the uid.
 */
export function parseEAadhaarXml(xml: string): Omit<AadhaarKyc, "refId"> | null {
  if (typeof xml !== "string" || xml.length < 20) return null;
  const x = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<LData\b[^>]*?(?:\/>|>[\s\S]*?<\/LData>)/gi, "");
  const uidData = tagAttrs(x, "UidData");
  const uid = uidData ? pick(uidData, "uid") : "";
  const l4 = /(\d{4})\s*$/.exec(uid);
  if (!l4) return null;
  const poi = tagAttrs(x, "Poi");
  const name = poi ? pick(poi, "name") : "";
  if (!poi || !name) return null;

  const dobRaw = pick(poi, "dob");
  let dobIso = parseVendorDob(dobRaw);
  if (!dobIso && /^\d{4}-\d{2}-\d{2}$/.test(dobRaw)) dobIso = dobRaw;
  const yobStr = /^\d{4}$/.test(dobRaw) ? dobRaw : dobIso ? dobIso.slice(0, 4) : "";
  const yob = Number(yobStr);

  const poa = tagAttrs(x, "Poa") ?? {};
  const careOfRaw = pick(poa, "co", "careof");
  const careOf = careOfRaw.replace(/^\s*(?:c\/o|s\/o|d\/o|w\/o|h\/o)\b\s*[:,.\-]?\s*/i, "").trim();
  const parts = [
    pick(poa, "house"), pick(poa, "street"), pick(poa, "lm", "landmark"), pick(poa, "loc", "locality"), pick(poa, "vtc"),
    pick(poa, "po", "postoffice"), pick(poa, "subdist", "subdistrict"), pick(poa, "dist", "district"),
    pick(poa, "state"), pick(poa, "pc", "pincode"), pick(poa, "country"),
  ].filter(Boolean);

  const pht = /<Pht\b[^>]*>([\s\S]*?)<\/Pht>/i.exec(x);
  return {
    last4: l4[1],
    name,
    gender: pick(poi, "gender").toUpperCase(),
    dobIso,
    yearOfBirth: Number.isFinite(yob) && yob > 1900 ? yob : null,
    careOf: careOf || null,
    address: parts.join(", "),
    photo: pht ? decodeB64(pht[1]) : null,
  };
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
