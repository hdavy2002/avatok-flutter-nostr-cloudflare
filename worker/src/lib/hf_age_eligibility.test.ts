import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { requireHfAgeConfirmation } from "./hf_age_eligibility";

function fixture(row: unknown, failure = false) {
  const bind = vi.fn(() => ({ first: async () => { if (failure) throw new Error("db"); return row; } }));
  return { env: { DB_META: { prepare: () => ({ bind }) } } as unknown as Env, bind };
}
describe("authoritative age self-attestation", () => {
  it("AGE-01 missing row denies the authenticated uid", async () => {
    const { env, bind } = fixture(null);
    const r = await requireHfAgeConfirmation(env, "fan");
    expect(bind).toHaveBeenCalledWith("fan");
    expect(r?.status).toBe(403);
    expect(await r?.json()).toEqual({ error: "age_confirmation_required", message: "Please confirm that you are 18 or older to continue." });
  });
  it("AGE-02 recorded attestation allows entry", async () => {
    expect(await requireHfAgeConfirmation(fixture({ confirmed_at: 1 }).env, "fan")).toBeNull();
  });
  it("AGE-04 database failure fails closed", async () => {
    const r = await requireHfAgeConfirmation(fixture(null, true).env, "fan");
    expect(r?.status).toBe(503);
    expect(await r?.json()).toMatchObject({ error: "age_confirmation_unavailable" });
  });
});
