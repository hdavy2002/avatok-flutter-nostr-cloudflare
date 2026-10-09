// [HF-KYC-OTP-FALLBACK-1] classifyOtpFailure: when the web UI must switch from Aadhaar OTP to DigiLocker.
import { describe, it, expect } from "vitest";
import { classifyOtpFailure, rateLimitedFailure, DL_FALLBACK_HINT } from "./hf_kyc_fallback";
import type { SandboxFail } from "./sandbox_client";

const f = (reason: SandboxFail["reason"], message?: string, status?: number): SandboxFail => ({ ok: false, reason, message, status });

describe("vendor/service side always falls back", () => {
  for (const [name, fail] of [
    ["timeout", f("timeout")],
    ["network unavailable", f("unavailable")],
    ["503 Source Unavailable", f("unavailable", "Source Unavailable", 503)],
    ["bad_response", f("bad_response", "weird", 200)],
    ["401/403 after re-auth", f("auth_failed", undefined, 403)],
  ] as const) {
    it(name, () => {
      const r = classifyOtpFailure(fail);
      expect(r).toMatchObject({ status: 503, error: "otp_unavailable", fallback: true, message: "Aadhaar OTP isn’t working right now. You can verify with DigiLocker instead." });
    });
  }
  it.each(["This endpoint has been deprecated by UIDAI", "API not enabled for your account", "Operation not allowed", "Unauthorised request"])("message %s", (m) => {
    const r = classifyOtpFailure(f("bad_response", m, 200));
    expect(r.error).toBe("otp_unavailable");
    expect(r.fallback).toBe(true);
  });
});

describe("retry_later", () => {
  it("first occurrence: no fallback", () => {
    expect(classifyOtpFailure(f("retry_later"), { retryLaterCount: 1 })).toMatchObject({ status: 429, error: "retry_later", fallback: false });
  });
  it("second occurrence: otp_unavailable with fallback", () => {
    expect(classifyOtpFailure(f("retry_later"), { retryLaterCount: 2 })).toMatchObject({ status: 503, error: "otp_unavailable", fallback: true });
  });
});

describe("no mobile linked", () => {
  it.each(["Mobile number not linked with Aadhaar", "No mobile number found", "mobile is not registered"])("%s", (m) => {
    expect(classifyOtpFailure(f("bad_response", m, 200))).toMatchObject({ status: 422, error: "otp_no_mobile", fallback: true });
  });
  it("wins over invalid_aadhaar reason", () => {
    expect(classifyOtpFailure(f("invalid_aadhaar", "Mobile number not linked", 422)).error).toBe("otp_no_mobile");
  });
});

describe("rate limits", () => {
  it("our rate limit -> 429 + fallback", () => {
    const r = rateLimitedFailure("Too many Aadhaar codes requested.");
    expect(r).toMatchObject({ status: 429, fallback: true });
    expect(r.message).toContain(DL_FALLBACK_HINT);
  });
});

describe("wrong / expired OTP", () => {
  it("1st and 2nd invalid_otp: no fallback, attemptsLeft", () => {
    expect(classifyOtpFailure(f("invalid_otp", "Invalid OTP"), { wrongAttempts: 1 })).toMatchObject({ status: 422, error: "invalid_otp", fallback: false, attemptsLeft: 2, field: "otp" });
    expect(classifyOtpFailure(f("invalid_otp"), { wrongAttempts: 2 })).toMatchObject({ error: "invalid_otp", fallback: false, attemptsLeft: 1 });
  });
  it("otp_expired 1st/2nd: no fallback", () => {
    expect(classifyOtpFailure(f("otp_expired"), { wrongAttempts: 2 })).toMatchObject({ status: 410, error: "otp_expired", fallback: false, attemptsLeft: 1 });
  });
  it("3rd failure: exhausted, 429, fallback", () => {
    expect(classifyOtpFailure(f("invalid_otp"), { wrongAttempts: 3 })).toMatchObject({ status: 429, error: "otp_attempts_exhausted", fallback: true, attemptsLeft: 0 });
    expect(classifyOtpFailure(f("otp_expired"), { wrongAttempts: 3 })).toMatchObject({ status: 429, error: "otp_attempts_exhausted", fallback: true });
  });
});

describe("user typo / config", () => {
  it("invalid_aadhaar: 422, no fallback, field aadhaar", () => {
    expect(classifyOtpFailure(f("invalid_aadhaar", "Invalid Aadhaar Card"))).toMatchObject({ status: 422, error: "invalid_aadhaar", fallback: false, field: "aadhaar" });
  });
  it("not_configured: 503, no fallback", () => {
    expect(classifyOtpFailure(f("not_configured"))).toMatchObject({ status: 503, error: "kyc_unavailable", fallback: false });
  });
});
