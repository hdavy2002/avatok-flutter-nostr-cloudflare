// @ts-nocheck
// [HF-WIRE-20] Real phone from the verified-OTP store, real email only (a @noemail placeholder is never returned).
import { describe, it, expect, vi, beforeEach } from "vitest";

let clerk: string | null = null;
vi.mock("./identity", () => ({ emailFor: async () => clerk }));

import { topupCustomer } from "./hf_topup_customer";

const dbWith = (rows: { phone?: string | null; typed?: string | null; name?: string | null }) => ({
  prepare: (q: string) => ({
    bind: () => ({
      first: async () => (q.includes("phone_otp") ? (rows.phone ? { e164: rows.phone } : null) : q.includes("display_name") ? (rows.name ? { display_name: rows.name } : null) : rows.typed ? { email: rows.typed } : null),
    }),
  }),
});
beforeEach(() => { clerk = null; });

describe("topupCustomer", () => {
  it("verified +91 number becomes 10 digits; real Clerk email wins", async () => {
    clerk = "clerk@example.com";
    expect(await topupCustomer({ DB_META: dbWith({ phone: "+919876543210", typed: "typed@example.com" }) } as any, "u1")).toEqual({ phone: "9876543210", email: "clerk@example.com", name: null });
  });
  it("placeholder Clerk email is skipped; the typed sign-up email is used", async () => {
    clerk = "wa-abc123@noemail.hellofraands.com";
    expect(await topupCustomer({ DB_META: dbWith({ phone: "+919876543210", typed: "typed@example.com" }) } as any, "u1")).toEqual({ phone: "9876543210", email: "typed@example.com", name: null });
  });
  it("nothing real known: both null, nothing invented", async () => {
    clerk = "wa-abc123@noemail.hellofraands.com";
    expect(await topupCustomer({ DB_META: dbWith({}) } as any, "u1")).toEqual({ phone: null, email: null, name: null });
  });
  it("a non-Indian or malformed stored number is not passed on", async () => {
    expect((await topupCustomer({ DB_META: dbWith({ phone: "+14155550100" }) } as any, "u1")).phone).toBeNull();
  });
  // [HF-WIRE-21]
  it("profile name is used; else the name the app asked for; the asked-for email only fills a gap", async () => {
    clerk = "wa-abc123@noemail.hellofraands.com";
    expect(await topupCustomer({ DB_META: dbWith({ phone: "+919876543210", name: "Asha Rao" }) } as any, "u1", { name: "Other", email: "given@example.com" }))
      .toEqual({ phone: "9876543210", email: "given@example.com", name: "Asha Rao" });
    expect((await topupCustomer({ DB_META: dbWith({ phone: "+919876543210" }) } as any, "u1", { name: "Meera", email: "x@@bad" })).name).toBe("Meera");
    clerk = "real@example.com";
    expect((await topupCustomer({ DB_META: dbWith({}) } as any, "u1", { email: "given@example.com" })).email).toBe("real@example.com");
  });
});
