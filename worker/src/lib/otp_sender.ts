// [WA-OTP-1 2026-09-27] One-time codes for phone verification, sent on WhatsApp
// through WasenderAPI (https://wasenderapi.com/api-docs).
//
// OWNER DECISION 2026-09-27: phone codes go on WhatsApp ONLY. SMS (2Factor.in) is
// no longer offered to users. The 2Factor path below is kept compiled purely as a
// break-glass: it runs only when WASENDER_API_KEY is NOT set. So the switch is the
// secret itself —
//   * WASENDER_API_KEY set   -> every code goes on WhatsApp
//   * WASENDER_API_KEY unset -> falls back to 2Factor SMS (if TWOFACTOR_API_KEY set)
// Do not add a user-facing "send by SMS" choice without asking the owner.
//
// ⚠️ WasenderAPI is an UNOFFICIAL WhatsApp gateway: it drives a normal WhatsApp
// account linked by QR (Linked Devices). WhatsApp can ban that number. If it is
// banned or unlinked, every send fails with provider_error — watch PostHog
// `phone_otp_send outcome=provider_error provider=wasender`. Recovery = link a new
// number in the Wasender dashboard and replace WASENDER_API_KEY (or delete the
// secret to fall back to SMS).
//
// HOW THE CODE IS CHECKED
// Wasender only delivers a message; it has no verify API (2Factor did). We make
// the 6-digit code ourselves, WhatsApp it, and store only a salted hash in
// phone_otp.session_id as  "wa:<salt>:<sha256(key|salt|e164|code)>". The plain code
// never touches D1. Rows whose session_id has no "wa:" prefix are 2Factor sessions
// and are still verified through 2Factor, so codes in flight during the switch work.
import { BRAND } from "./brand";
import type { Env } from "../types";
import { sha256Hex } from "../util";

const WA_BASE = "https://www.wasenderapi.com/api";
const TF_BASE = "https://2factor.in/API/V1";

export type OtpProvider = "wasender" | "2factor";

export type SendResult =
  | { ok: true; provider: OtpProvider; sessionId: string }
  | { ok: false; provider: OtpProvider; reason: "not_on_whatsapp" | "rate_limited" | "provider_error"; detail: string };

export type CheckResult = "match" | "mismatch" | "expired" | "unreachable";

export function otpProvider(env: Env): OtpProvider | null {
  if ((env.WASENDER_API_KEY ?? "").trim()) return "wasender";
  if ((env.TWOFACTOR_API_KEY ?? "").trim()) return "2factor";
  return null;
}

/** The word to show a user for where the code went. */
export function otpChannelWord(env: Env): "WhatsApp" | "SMS" {
  return otpProvider(env) === "2factor" ? "SMS" : "WhatsApp";
}

function sixDigits(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1_000_000).padStart(6, "0");
}

function randomSalt(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function waHash(env: Env, salt: string, e164: string, code: string): Promise<string> {
  return sha256Hex(`${env.WASENDER_API_KEY ?? ""}|${salt}|${e164}|${code}`);
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function wasender(env: Env, path: string, init: RequestInit = {}): Promise<{ status: number; body: any } | null> {
  try {
    const r = await fetch(`${WA_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.WASENDER_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return null;
  }
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

/**
 * [WA-LOGIN-1 2026-09-28] Preflight WhatsApp-presence check, for a caller that
 * wants to fail fast BEFORE sending — the unauthenticated WhatsApp-login faucet
 * (routes/whatsapp_auth.ts) checks this first so a number that isn't on
 * WhatsApp never costs a real send attempt (send failures are exactly the kind
 * of provider signal that risks the linked number's ban status — see the
 * WasenderAPI warning at the top of this file). `sendOtp` below still does the
 * same check as its OWN fallback when a send fails, so authenticated phone
 * verification (routes/phone_otp.ts, routes/me_dashboard.ts) is unaffected.
 * Returns null when the provider can't be reached or isn't wasender — callers
 * should not block a send on that, only on a definite `false`.
 */
export async function checkOnWhatsapp(env: Env, e164: string): Promise<boolean | null> {
  if (otpProvider(env) !== "wasender") return null;
  const chk = await wasender(env, `/on-whatsapp/${encodeURIComponent(e164)}`);
  if (chk && chk.body?.success === true && typeof chk.body?.data?.exists === "boolean") {
    return chk.body.data.exists as boolean;
  }
  return null;
}

/** Send a fresh code to an E.164 number. `ttlMin` only feeds the message text. */
export async function sendOtp(env: Env, e164: string, ttlMin: number): Promise<SendResult> {
  const provider = otpProvider(env);

  if (provider === "wasender") {
    const code = sixDigits();
    const text =
      `${code} is your ${BRAND.name} verification code.\n\n` +
      `It expires in ${ttlMin} minutes. Do not share this code with anyone — ${BRAND.name} will never ask you for it.`;
    const r = await wasender(env, "/send-message", { method: "POST", body: JSON.stringify({ to: e164, text }) });
    if (r && r.status < 300 && r.body?.success === true) {
      const salt = randomSalt();
      return { ok: true, provider, sessionId: `wa:${salt}:${await waHash(env, salt, e164, code)}` };
    }
    const detail = r ? `${r.status} ${String(r.body?.message ?? JSON.stringify(r.body ?? "")).slice(0, 110)}` : "no_response";
    if (r?.status === 429) return { ok: false, provider, reason: "rate_limited", detail };
    // Send failed: find out whether the number simply isn't on WhatsApp, so the
    // user gets a useful message instead of "try again".
    const chk = await wasender(env, `/on-whatsapp/${encodeURIComponent(e164)}`);
    if (chk && chk.body?.success === true && chk.body?.data?.exists === false) {
      return { ok: false, provider, reason: "not_on_whatsapp", detail };
    }
    return { ok: false, provider, reason: "provider_error", detail };
  }

  // Break-glass SMS path (only when WASENDER_API_KEY is unset).
  const tpl = (env.TWOFACTOR_OTP_TEMPLATE ?? "").trim();
  const res = await twoFactor(env, `SMS/${e164.slice(1)}/AUTOGEN${tpl ? "/" + encodeURIComponent(tpl) : ""}`);
  if (res?.Status === "Success" && res.Details) return { ok: true, provider: "2factor", sessionId: res.Details };
  return { ok: false, provider: "2factor", reason: "provider_error", detail: String(res?.Details ?? "no_response").slice(0, 120) };
}

/** Check a code against the session stored at send time. Expiry by clock is the caller's job. */
export async function checkOtp(env: Env, sessionId: string, e164: string, code: string): Promise<CheckResult> {
  if (sessionId.startsWith("wa:")) {
    const [, salt, want] = sessionId.split(":");
    if (!salt || !want) return "mismatch";
    return safeEq(await waHash(env, salt, e164, code), want) ? "match" : "mismatch";
  }
  const res = await twoFactor(env, `SMS/VERIFY/${encodeURIComponent(sessionId)}/${code}`);
  if (!res) return "unreachable";
  if (res.Status === "Success" && /match/i.test(String(res.Details ?? ""))) return "match";
  return /expire/i.test(String(res.Details ?? "")) ? "expired" : "mismatch";
}

/** User-facing copy for a failed send. */
export function sendFailMessage(env: Env, reason: string): string {
  if (reason === "not_on_whatsapp") return "This number isn’t on WhatsApp. Use a mobile number that has WhatsApp.";
  if (reason === "rate_limited") return "We’re sending a lot of codes right now. Please try again in a minute.";
  return otpChannelWord(env) === "WhatsApp"
    ? "We couldn’t send the code on WhatsApp. Check the number and try again."
    : "We couldn’t send the SMS. Check the number and try again.";
}
