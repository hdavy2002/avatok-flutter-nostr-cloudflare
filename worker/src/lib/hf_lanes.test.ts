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


// A fake D1: lane rows already joined on verified Aadhaar (hf_kyc).
function accessEnv({ gender = "F", verified = true, declared = true } = {}) {
  return { DB_META: { prepare: (sql: string) => ({ bind: () => ({
    all: async () => ({ results: verified ? [
      { lane: "women", gender, declared_at: null },
      { lane: "lgbtq", gender, declared_at: declared ? 1 : null },
    ] : [] }),
    first: async () => { throw new Error(`no selfie lookups expected: ${sql}`); },
  }) }) } } as any;
}

describe("current protected-space authority [HF-IDV-WHATSAPP-1: no selfie video]", () => {
  it("LGBTQ+ needs a verified Aadhaar and a private declaration, never a video", async () => {
    expect(await getLaneAccess(accessEnv(), "u")).toEqual({ women: true, lgbtq: true });
    expect((await getLaneAccess(accessEnv({ declared: false }), "u")).lgbtq).toBe(false);
    expect(await getLaneAccess(accessEnv({ verified: false }), "u")).toEqual({ women: false, lgbtq: false });
    expect((await getLaneAccess(accessEnv({ gender: "M" }), "u"))).toEqual({ women: false, lgbtq: true });
  });
  it.each(["F", "T"])("women with Aadhaar %s keep access", async (gender) => {
    expect((await getLaneAccess(accessEnv({ gender }), "u")).women).toBe(true);
  });
});
