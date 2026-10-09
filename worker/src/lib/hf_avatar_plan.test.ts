import { describe, it, expect } from "vitest";
import { buildAvatarFillPlan, planTotal, sanitizeAvatarPlan } from "./hf_avatar_plan";

describe("buildAvatarFillPlan", () => {
  it("empty catalogue -> 24 entries of 4", () => {
    const p = buildAvatarFillPlan([], 4);
    expect(p.length).toBe(24);
    expect(planTotal(p)).toBe(96);
  });
  it("skips full combos and tops up partial ones", () => {
    const p = buildAvatarFillPlan([
      { gender: "woman", age_band: "20s", look: "casual", n: 4 },
      { gender: "man", age_band: "50s+", look: "office", n: 1 },
      { gender: "woman", age_band: "30s", look: "office", n: 9 },
    ], 4);
    expect(p.length).toBe(22);
    expect(p.find((e) => e.gender === "woman" && e.age === "20s" && e.look === "casual")).toBeUndefined();
    expect(p.find((e) => e.gender === "man" && e.age === "50s+" && e.look === "office")?.count).toBe(3);
  });
  it("nothing missing -> empty", () => {
    const rows = ["woman", "man"].flatMap((gender) => ["20s", "30s", "40s", "50s+"].flatMap((age_band) => ["traditional", "casual", "office"].map((look) => ({ gender, age_band, look, n: 4 }))));
    expect(buildAvatarFillPlan(rows, 4)).toEqual([]);
  });
  it("clamps target to 1..8 and defaults to 4", () => {
    expect(planTotal(buildAvatarFillPlan([], 99))).toBe(24 * 8);
    expect(planTotal(buildAvatarFillPlan([], NaN))).toBe(96);
  });
});

describe("sanitizeAvatarPlan", () => {
  it("accepts a built plan and rejects bad input", () => {
    expect(sanitizeAvatarPlan(buildAvatarFillPlan([], 4))?.length).toBe(24);
    expect(sanitizeAvatarPlan([])).toBeNull();
    expect(sanitizeAvatarPlan([{ gender: "x", age: "20s", look: "casual", count: 1 }])).toBeNull();
    expect(sanitizeAvatarPlan([{ gender: "man", age: "20s", look: "casual", count: 13 }])).toBeNull();
    expect(sanitizeAvatarPlan(buildAvatarFillPlan([], 8))).toBeNull(); // 192 > 120
  });
});
