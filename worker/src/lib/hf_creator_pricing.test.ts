import { describe, expect, it } from "vitest";
import { creatorCallSplit, creatorSnapshotFor, validCreatorSnapshot, validCreatorRate, isHostCategory } from "./hf_creator_pricing";
import { callSplit, stdSplit, stdTariff } from "./hf_token_math";

describe("creator-r1", () => {
  it("takes 40% gross commission and ₹2 recovery, with no GST added to the caller or creator", () => {
    expect(creatorCallSplit(creatorSnapshotFor("influencer", 20), 60)).toEqual({ valuePaise: 2000, hostPaise: 1000, callCostPaise: 200, platformPaise: 800 });
    expect(creatorSnapshotFor("celebrity", 100).taxMode).toBe("gst_absorbed_in_platform_commission");
  });
  it("charges only connected seconds, cumulatively, and conserves every paisa", () => {
    const snapshot = creatorSnapshotFor("celebrity", 20);
    expect(creatorCallSplit(snapshot, 0)).toEqual({ valuePaise: 0, hostPaise: 0, callCostPaise: 0, platformPaise: 0 });
    expect(creatorCallSplit(snapshot, 11)).toEqual({ valuePaise: 367, hostPaise: 183, callCostPaise: 37, platformPaise: 147 });
    for (const seconds of [1, 11, 59, 60, 61, 121, 3600]) {
      const s = creatorCallSplit(snapshot, seconds);
      expect(s.valuePaise).toBe(s.hostPaise + s.callCostPaise + s.platformPaise);
      expect(s.hostPaise).toBeGreaterThanOrEqual(0);
    }
  });
  it("leaves legacy and Standard calculation paths unchanged", () => {
    expect(callSplit({ ratePaise: 2000, billableSeconds: 60 }).hostPaise).toBe(1080);
    expect(stdSplit({ tariff: stdTariff(), billableSeconds: 60, hostPaisePerMin: 200, phoneCostPaisePerMin: 100 })).toMatchObject({ valuePaise: 399, hostPaise: 200 });
  });
  it("rejects unsupported categories, unsafe rates and altered snapshot versions", () => {
    for (const category of ["influencers", "celebrity-ish", null]) expect(isHostCategory(category)).toBe(false);
    for (const rate of [NaN, Infinity, -5, 0, 3, 4.99, 1001, "20"]) expect(validCreatorRate(rate)).toBe(false);
    const snapshot = creatorSnapshotFor("influencer", 20);
    expect(validCreatorSnapshot(snapshot)).toBe(true);
    expect(validCreatorSnapshot({ ...snapshot, version: "creator-r2" })).toBe(false);
    expect(validCreatorSnapshot({ ...snapshot, callCostPaisePerMin: 400 })).toBe(false);
  });
});
