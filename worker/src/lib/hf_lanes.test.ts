import { describe, it, expect } from "vitest";
import { parseLane, womenEligible, laneEligible } from "./hf_lanes";

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
