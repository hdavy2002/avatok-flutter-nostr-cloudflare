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
  it("women lane: Aadhaar gender F ONLY [HF-CREATOR-SPACES-1]", () => {
    expect(womenEligible("F")).toBe(true);
    expect(womenEligible("T")).toBe(false);
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


// A fake D1: lane rows already joined on verified Aadhaar (hf_kyc); the latest selfie is a separate lookup.
function accessEnv({ gender = "F", verified = true, declared = true, selfie = "approved" as string | null } = {}) {
  return { DB_META: { prepare: (_sql: string) => ({ bind: () => ({
    all: async () => ({ results: verified ? [
      { lane: "women", gender, declared_at: null },
      { lane: "lgbtq", gender, declared_at: declared ? 1 : null },
    ] : [] }),
    first: async () => (selfie ? { review_status: selfie, review_reason: selfie === "rejected" ? "blurry" : null } : null),
  }) }) } } as any;
}

describe("current protected-space authority [HF-CREATOR-SPACES-1: video KYC]", () => {
  it("both lanes need a verified Aadhaar AND an approved selfie; LGBTQ+ also the private declaration", async () => {
    expect(await getLaneAccess(accessEnv(), "u")).toEqual({ women: true, lgbtq: true });
    expect((await getLaneAccess(accessEnv({ declared: false }), "u")).lgbtq).toBe(false);
    expect(await getLaneAccess(accessEnv({ verified: false }), "u")).toEqual({ women: false, lgbtq: false });
    expect((await getLaneAccess(accessEnv({ gender: "M" }), "u"))).toEqual({ women: false, lgbtq: true });
  });
  it.each([null, "pending", "rejected"])("a %s selfie locks both lanes", async (selfie) => {
    expect(await getLaneAccess(accessEnv({ selfie }), "u")).toEqual({ women: false, lgbtq: false });
  });
  it("women with Aadhaar F keep access, Aadhaar T does not", async () => {
    expect((await getLaneAccess(accessEnv({ gender: "F" }), "u")).women).toBe(true);
    expect((await getLaneAccess(accessEnv({ gender: "T" }), "u")).women).toBe(false);
  });
});
