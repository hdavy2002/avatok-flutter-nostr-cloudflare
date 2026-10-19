// [HF-WIRE-18] HF-REEL-37 pure helpers.
import { describe, it, expect } from "vitest";
import { readInfluencerRate, pricingStd } from "./hf_influencer_rate";
import { readHfStdPlan } from "./hf_token_config";

const ON = { hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 };

describe("readInfluencerRate", () => {
  it("defaults: off, Rs 5 default, Rs 5 minimum, server max Rs 100", () => {
    expect(readInfluencerRate({})).toEqual({ on: false, defaultRupees: 5, minRupees: 5, maxRupees: 100 });
    expect(readInfluencerRate(null).defaultRupees).toBe(5);
  });
  it("reads paise config, ignores junk, and the default never sits under the minimum", () => {
    expect(readInfluencerRate({ hfInfluencerSetsRate: true, hfMinRatePaise: 1000, hfDefaultRatePaise: 500 })).toMatchObject({ on: true, minRupees: 10, defaultRupees: 10 });
    expect(readInfluencerRate({ hfMinRatePaise: 450, hfDefaultRatePaise: "x" })).toMatchObject({ minRupees: 5, defaultRupees: 5 });
    expect(readInfluencerRate({ hfMinRatePaise: 50 })).toMatchObject({ minRupees: 5 });
  });
});

describe("pricingStd", () => {
  it("switches the fixed tariff off for pricing only when hfInfluencerSetsRate is on; the wallet reading is untouched", () => {
    const base = readHfStdPlan(ON);
    expect(base.enabled).toBe(true);
    expect(pricingStd(base, ON).enabled).toBe(true);
    expect(pricingStd(base, { ...ON, hfInfluencerSetsRate: true }).enabled).toBe(false);
    expect(readHfStdPlan({ ...ON, hfInfluencerSetsRate: true }).enabled).toBe(true);
  });
});
