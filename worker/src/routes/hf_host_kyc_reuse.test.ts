import { describe, it, expect, vi } from "vitest";
import type { Env } from "../types";

vi.mock("./config", () => ({ readConfig: async () => ({ hostKycEnabled: true }) }));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: "viewer" }), isFail: () => false }));
vi.mock("../hooks", () => ({ trackUser: async () => {}, trackException: async () => {} }));
import { hfHostKycRoute } from "./hf_host_kyc";

describe("host upgrade reuses private verification", () => {
  it("upgrades only role with existing Aadhaar even when no provider credentials are configured", async () => {
    const writes: string[] = [];
    const original = { uid: "viewer", role: "lane_caller", verified_at: 123, gender: "F", aadhaar_last4: "1234", photo_r2_key: "private/evidence" };
    const env = { DB_META: { prepare: (sql: string) => ({ bind: () => ({
      first: async () => original,
      run: async () => { writes.push(sql); return { success: true }; },
    }) }) } } as unknown as Env;
    const path = "/api/hosts/kyc/digilocker/start";
    const res = await hfHostKycRoute(new Request(`https://api.test${path}`, {
      method: "POST", body: JSON.stringify({ role: "host", consent: true, returnPath: "/hosts/kyc/return?app=1" }),
    }), env, path);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ already_verified: true, gender: "F", last4: "1234" });
    expect(writes).toEqual(["UPDATE hf_kyc SET role='host', updated_at=?2 WHERE uid=?1"]);
    expect(original.verified_at).toBe(123);
    expect(original.photo_r2_key).toBe("private/evidence");
  });
});
