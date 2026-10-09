// [HF-KYC-OTP-FALLBACK-1 2026-10-09] Pure classifier: Aadhaar OTP is the primary path, DigiLocker the fallback.
// Maps a Sandbox failure (+ how many wrong OTPs / "retry later"s this reference has had) to the HTTP response the
// /aadhaar/otp and /aadhaar/verify routes send, including whether the web UI should switch to DigiLocker.
// No I/O, no secrets, no Aadhaar number: only vendor reason codes and vendor messages.
import type { SandboxFail } from "./sandbox_client";

export const MAX_WRONG_OTPS = 3;
export const MAX_RETRY_LATER = 2;

export interface OtpFailure {
  status: number;
  error: string;
  fallback: boolean;
  message: string;
  field?: string;
  attemptsLeft?: number;
}

export interface OtpFailureCtx {
  /** Wrong/expired OTPs for this reference INCLUDING the failure being classified. */
  wrongAttempts?: number;
  /** "Request under process" answers for this reference INCLUDING the failure being classified. */
  retryLaterCount?: number;
}

export const DL_FALLBACK_HINT = "You can verify with DigiLocker instead.";
const UNAVAILABLE_MSG = `Aadhaar OTP isn’t working right now. ${DL_FALLBACK_HINT}`;

const NO_MOBILE_RE = /(mobile|phone)[^.]{0,40}(not\s+(linked|registered|available|found|updated)|no\s+longer)|no\s+(mobile|phone)|not\s+linked\s+(with|to)\s+(any\s+)?(mobile|phone)|mobile\s+number\s+(is\s+)?(missing|not)/i;
const DEPRECATED_RE = /deprecat|not\s+enabled|not\s+allowed|unauthori[sz]|not\s+subscribed|access\s+denied|forbidden/i;

export function classifyOtpFailure(f: SandboxFail, ctx: OtpFailureCtx = {}): OtpFailure {
  const msg = f.message ?? "";

  if (f.reason === "not_configured") {
    // Same Sandbox keys power DigiLocker, so there is nothing to fall back to.
    return { status: 503, error: "kyc_unavailable", fallback: false, message: "Verification isn’t available right now. Please try again shortly." };
  }
  if (NO_MOBILE_RE.test(msg)) {
    return { status: 422, error: "otp_no_mobile", fallback: true, message: `This Aadhaar has no mobile number linked, so we can’t send a code. ${DL_FALLBACK_HINT}` };
  }
  if (DEPRECATED_RE.test(msg)) {
    return { status: 503, error: "otp_unavailable", fallback: true, message: UNAVAILABLE_MSG };
  }
  switch (f.reason) {
    case "invalid_aadhaar":
      return { status: 422, error: "invalid_aadhaar", fallback: false, message: "That Aadhaar number isn’t valid. Check it and try again.", field: "aadhaar" };
    case "invalid_input":
      return { status: 400, error: "invalid_input", fallback: false, message: "Please check the details and try again." };
    case "invalid_otp":
    case "otp_expired": {
      const n = Math.max(1, ctx.wrongAttempts ?? 1);
      if (n >= MAX_WRONG_OTPS) {
        return { status: 429, error: "otp_attempts_exhausted", fallback: true, attemptsLeft: 0, message: `Too many incorrect codes. ${DL_FALLBACK_HINT}` };
      }
      const attemptsLeft = MAX_WRONG_OTPS - n;
      return f.reason === "invalid_otp"
        ? { status: 422, error: "invalid_otp", fallback: false, attemptsLeft, field: "otp", message: "That code isn’t right. Check the SMS from UIDAI and try again." }
        : { status: 410, error: "otp_expired", fallback: false, attemptsLeft, field: "otp", message: "That code has expired. Request a new one." };
    }
    case "retry_later":
      if ((ctx.retryLaterCount ?? 1) >= MAX_RETRY_LATER) return { status: 503, error: "otp_unavailable", fallback: true, message: UNAVAILABLE_MSG };
      return { status: 429, error: "retry_later", fallback: false, message: "Still checking — try again in 30 seconds." };
    default:
      // timeout, unavailable (5xx / "Source Unavailable"), auth_failed (401/403 after re-auth), bad_response, anything else vendor-side.
      return { status: 503, error: "otp_unavailable", fallback: true, message: UNAVAILABLE_MSG };
  }
}

/** 429 from OUR rate limits: the user can still finish with DigiLocker. */
export function rateLimitedFailure(message: string): OtpFailure {
  return { status: 429, error: "too_many", fallback: true, message: `${message} ${DL_FALLBACK_HINT}` };
}
