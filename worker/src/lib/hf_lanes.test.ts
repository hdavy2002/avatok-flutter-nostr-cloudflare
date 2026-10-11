import { describe, it, expect } from "vitest";
import { parseLane, womenEligible, laneEligible, getLaneAccess } from "./hf_lanes";

describe("hf_lanes", () => {
  it("parses the lane param", () => {
    expect(parseLane("women")).toBe("women");
    expect(parseLane(" LGBTQ ")).toBe("lgbtq");
    expect(parseLane("men")).toBeNull();
    expect(parseLane(null)).toBeNull();
    expect(parseLane(undefined)).toBeNull();
    expect(parseLane(5)).toBeNull();
  });
  it("women lane: Aadhaar gender F or T only", () => {
    expect(womenEligible("F")).toBe(true);
    expect(womenEligible("T")).toBe(true);
    expect(womenEligible("M")).toBe(false);
    expect(womenEligible(null)).toBe(false);
    expect(womenEligible(undefined)).toBe(false);
  });
  it("lane eligibility needs Aadhaar; LGBTQ+ accepts any gender", () => {
    expect(laneEligible("women", false, "F")).toBe(false);
    expect(laneEligible("women", true, "F")).toBe(true);
    expect(laneEligible("women", true, "M")).toBe(false);
    expect(laneEligible("lgbtq", false, "M")).toBe(false);
    expect(laneEligible("lgbtq", true, "M")).toBe(true);
    expect(laneEligible("lgbtq", true, null)).toBe(true);
  });
});


// A fake D1 models failures independently so women never depend on selfie availability.
function accessEnv({ gender = "F", verified = true, declared = true, selfie = "approved", failSelfie = false } = {}) {
  return { DB_META: { prepare: (sql: string) => ({ bind: () => ({
    all: async () => ({ results: verified ? [
      { lane: "women", gender, declared_at: null },
      { lane: "lgbtq", gender, declared_at: declared ? 1 : null },
    ] : [] }),
    first: async () => {
      expect(sql).toContain("ORDER BY created_at DESC, id DESC");
      if (failSelfie) throw new Error("selfie unavailable");
      return selfie === "none" ? null : { review_status: selfie, review_reason: null };
    },
  }) }) } } as any;
}

describe("current protected-space authority", () => {
  it.each(["none", "pending", "rejected"])("membership without approved latest video (%s) never grants LGBTQ+", async (selfie) => {
    expect(await getLaneAccess(accessEnv({ selfie }), "u")).toEqual({ women: true, lgbtq: false });
  });
  it("approved video still requires verified Aadhaar and a private declaration", async () => {
    expect((await getLaneAccess(accessEnv({ declared: false }), "u")).lgbtq).toBe(false);
    expect(await getLaneAccess(accessEnv({ verified: false }), "u")).toEqual({ women: false, lgbtq: false });
    expect((await getLaneAccess(accessEnv({ gender: "M" }), "u")).lgbtq).toBe(true);
  });
  it.each(["F", "T"])("women with Aadhaar %s keep access when selfie queries fail", async (gender) => {
    expect(await getLaneAccess(accessEnv({ gender, failSelfie: true }), "u")).toEqual({ women: true, lgbtq: false });
  });
});
