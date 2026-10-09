// [HF-PAYOUT-1] Pure withdrawable math, request validation codes, UTR and state-machine rules.
import { describe, it, expect } from "vitest";
import { computeWithdrawable, validatePayoutRequest, cleanUtr, canApprove, canCancel, canPay, canReject, parseSnapshot, type RequestCheck } from "./hf_payouts";

describe("computeWithdrawable", () => {
  it("is the smaller of the wallet ceiling and the matured paid-call ceiling", () => {
    expect(computeWithdrawable({ walletBalance: 1000, openReserved: 0, maturedCallRupees: 700, activePayoutRupees: 0 })).toBe(700);
    expect(computeWithdrawable({ walletBalance: 300, openReserved: 0, maturedCallRupees: 700, activePayoutRupees: 0 })).toBe(300);
  });
  it("legacy calls with NULL host_paid_rupees contribute 0 (matured sum 0) even if the wallet holds money", () => {
    expect(computeWithdrawable({ walletBalance: 5000, openReserved: 0, maturedCallRupees: 0, activePayoutRupees: 0 })).toBe(0);
  });
  it("a caller's own top-ups sitting in the wallet are never withdrawable (calls ceiling caps it)", () => {
    expect(computeWithdrawable({ walletBalance: 2000, openReserved: 0, maturedCallRupees: 150, activePayoutRupees: 0 })).toBe(150);
  });
  it("open requests are subtracted from both ceilings; paid ones only from the calls pool", () => {
    expect(computeWithdrawable({ walletBalance: 1000, openReserved: 400, maturedCallRupees: 1000, activePayoutRupees: 400 })).toBe(600);
    // 500 already paid out: wallet already lost it (balance 500 left), calls pool remembers it
    expect(computeWithdrawable({ walletBalance: 500, openReserved: 0, maturedCallRupees: 1000, activePayoutRupees: 500 })).toBe(500);
    expect(computeWithdrawable({ walletBalance: 900, openReserved: 0, maturedCallRupees: 1000, activePayoutRupees: 500 })).toBe(500);
  });
  it("never negative, never fractional, ignores junk", () => {
    expect(computeWithdrawable({ walletBalance: 100, openReserved: 400, maturedCallRupees: 100, activePayoutRupees: 0 })).toBe(0);
    expect(computeWithdrawable({ walletBalance: 99.9, openReserved: 0, maturedCallRupees: 500, activePayoutRupees: 0 })).toBe(99);
    expect(computeWithdrawable({ walletBalance: NaN, openReserved: 0, maturedCallRupees: 500, activePayoutRupees: 0 })).toBe(0);
  });
});

const base: RequestCheck = { enabled: true, hostStatus: "live", kycOk: true, bankOk: true, amount: 600, minRupees: 500, withdrawable: 800, recentCount: 0, maxPerWeek: 2 };
const code = (o: Partial<RequestCheck>) => { const v = validatePayoutRequest({ ...base, ...o }); return v.ok ? "ok" : `${v.status}:${v.error}`; };

describe("validatePayoutRequest", () => {
  it("accepts a good request", () => expect(code({})).toBe("ok"));
  it("reason codes", () => {
    expect(code({ enabled: false })).toBe("404:not_enabled");
    expect(code({ hostStatus: "paused" })).toBe("403:not_live");
    expect(code({ hostStatus: null })).toBe("403:not_live");
    expect(code({ kycOk: false })).toBe("409:kyc_required");
    expect(code({ bankOk: false })).toBe("409:bank_required");
    expect(code({ amount: "abc" })).toBe("400:invalid_amount");
    expect(code({ amount: 600.5 })).toBe("400:invalid_amount");
    expect(code({ amount: -5 })).toBe("400:invalid_amount");
    expect(code({ amount: 499 })).toBe("400:below_minimum");
    expect(code({ recentCount: 2 })).toBe("429:weekly_limit");
    expect(code({ amount: 801 })).toBe("402:insufficient_withdrawable");
  });
  it("accepts exactly the minimum and exactly the withdrawable", () => {
    expect(code({ amount: 500 })).toBe("ok");
    expect(code({ amount: 800 })).toBe("ok");
  });
  it("accepts a numeric string amount from JSON", () => expect(code({ amount: "700" })).toBe("ok"));
});

describe("UTR and state machine", () => {
  it("UTR 6-30 alphanumeric, upper-cased", () => {
    expect(cleanUtr(" abc123 ")).toBe("ABC123");
    expect(cleanUtr("412345678901")).toBe("412345678901");
    expect(cleanUtr("abc12")).toBeNull();
    expect(cleanUtr("a".repeat(31))).toBeNull();
    expect(cleanUtr("ab-123456")).toBeNull();
    expect(cleanUtr(undefined)).toBeNull();
  });
  it("transitions", () => {
    expect(canApprove("requested")).toBe(true); expect(canApprove("approved")).toBe(false);
    expect(canCancel("requested")).toBe(true); expect(canCancel("approved")).toBe(false);
    expect(canPay("approved")).toBe(true); expect(canPay("requested")).toBe(false); expect(canPay("paid")).toBe(false);
    expect(canReject("requested")).toBe(true); expect(canReject("approved")).toBe(true); expect(canReject("paid")).toBe(false);
  });
  it("snapshot parsing never throws", () => {
    expect(parseSnapshot('{"accountLast4":"1234","ifsc":"X","name":"A"}')).toEqual({ accountLast4: "1234", ifsc: "X", name: "A" });
    expect(parseSnapshot("nope")).toEqual({ accountLast4: null, ifsc: null, name: null });
    expect(parseSnapshot(null)).toEqual({ accountLast4: null, ifsc: null, name: null });
  });
});
