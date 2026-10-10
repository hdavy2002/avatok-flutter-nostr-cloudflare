import { describe, it, expect } from "vitest";
import { readHfTokenConfig, HF_CHECKOUT_PROVIDERS } from "./hf_token_config";

describe("readHfTokenConfig [HF-TOK-MATH-1]", () => {
  it("defaults when nothing is set: dark, google_play, gp-v2, Rs2 call cost, 60% host", () => {
    expect(readHfTokenConfig({})).toEqual({
      enabled: false, provider: "google_play", pricingVersion: "gp-v2", callCostPaisePerMin: 200, hostShareBps: 6000, playPackageId: "com.hellofraands.app",
    });
  });
  it("enabled only for a real boolean true", () => {
    expect(readHfTokenConfig({ hfTokensEnabled: true }).enabled).toBe(true);
    expect(readHfTokenConfig({ hfTokensEnabled: "true" }).enabled).toBe(false);
    expect(readHfTokenConfig({ hfTokensEnabled: 1 }).enabled).toBe(false);
  });
  it("provider: allowed values pass, anything else is none", () => {
    for (const p of HF_CHECKOUT_PROVIDERS) expect(readHfTokenConfig({ hfCheckoutProvider: p }).provider).toBe(p);
    expect(readHfTokenConfig({ hfCheckoutProvider: "none" }).provider).toBe("none");
    expect(readHfTokenConfig({ hfCheckoutProvider: "stripe" }).provider).toBe("none");
    expect(readHfTokenConfig({ hfCheckoutProvider: 5 }).provider).toBe("none");
  });
  it("numbers: bad, fractional or out-of-range values fall back", () => {
    expect(readHfTokenConfig({ hfCallCostPaisePerMin: 250, hfHostShareBps: 5000 })).toMatchObject({ callCostPaisePerMin: 250, hostShareBps: 5000 });
    expect(readHfTokenConfig({ hfCallCostPaisePerMin: -1 }).callCostPaisePerMin).toBe(200);
    expect(readHfTokenConfig({ hfCallCostPaisePerMin: 1.5 }).callCostPaisePerMin).toBe(200);
    expect(readHfTokenConfig({ hfCallCostPaisePerMin: "300" }).callCostPaisePerMin).toBe(200);
    expect(readHfTokenConfig({ hfHostShareBps: 10_001 }).hostShareBps).toBe(6000);
    expect(readHfTokenConfig({ hfHostShareBps: 0 }).hostShareBps).toBe(0);
    expect(readHfTokenConfig({ hfHostShareBps: 10_000 }).hostShareBps).toBe(10_000);
  });
  it("pricing version and package id are shape-checked", () => {
    expect(readHfTokenConfig({ hfPricingVersion: "pt-v1" }).pricingVersion).toBe("pt-v1");
    expect(readHfTokenConfig({ hfPricingVersion: "Bad Version!" }).pricingVersion).toBe("gp-v2");
    expect(readHfTokenConfig({ hfPricingVersion: "" }).pricingVersion).toBe("gp-v2");
    expect(readHfTokenConfig({ hfPlayPackageId: "com.example.other" }).playPackageId).toBe("com.example.other");
    expect(readHfTokenConfig({ hfPlayPackageId: "nodots" }).playPackageId).toBe("com.hellofraands.app");
    expect(readHfTokenConfig({ hfPlayPackageId: "com.x y" }).playPackageId).toBe("com.hellofraands.app");
  });
});
