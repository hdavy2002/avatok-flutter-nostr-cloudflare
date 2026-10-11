// [HF-STD-PLAN-1] Standard calling plan + GST-inclusive rupee top-ups: the owner's worked examples are the contract.
import { describe, it, expect } from "vitest";
import {
  topupSplit, chargePaise, stdTariff, stdSplit, tierBreakdown, planSpend, canStart, formatRupees, paiseToMicro, microToPaise, rateAtSecond,
  flatTariff, validTariff, consumedValuePaise, STD_TECH_MAX_SECONDS, type Lot,
} from "./hf_token_math";
import { readHfStdPlan, hfStdPlanPublic } from "./hf_token_config";

const T = stdTariff();
const rupeeLot = (id: string, paise: number): Lot => ({ id, valuePaisePerToken: 100, leftMicro: paiseToMicro(paise) });

describe("top-up: wallet = paid / 1.18 to the paisa", () => {
  it("owner examples", () => {
    expect(topupSplit(12000, 1800)).toEqual({ walletPaise: 10169, gstPaise: 1831 });
    expect(topupSplit(11800, 1800)).toEqual({ walletPaise: 10000, gstPaise: 1800 });
  });
  it("all four Play packs", () => {
    expect(topupSplit(24000, 1800)).toEqual({ walletPaise: 20339, gstPaise: 3661 });
    expect(topupSplit(60000, 1800)).toEqual({ walletPaise: 50847, gstPaise: 9153 });
    expect(topupSplit(120000, 1800)).toEqual({ walletPaise: 101695, gstPaise: 18305 });
  });
  it("never Rs 102 for Rs 120, never 18% off the total", () => {
    expect(topupSplit(12000, 1800).walletPaise).not.toBe(10200);
    expect(topupSplit(12000, 1800).walletPaise).not.toBe(9840);
  });
  it("paid = wallet + GST always; GST off or exclusive credits everything", () => {
    for (let p = 1; p < 50_000; p += 37) { const x = topupSplit(p, 1800); expect(x.walletPaise + x.gstPaise).toBe(p); }
    expect(topupSplit(12000, 0)).toEqual({ walletPaise: 12000, gstPaise: 0 });
    expect(topupSplit(12000, 1800, false)).toEqual({ walletPaise: 12000, gstPaise: 0 });
  });
});

describe("Standard tariff, progressive per connected second", () => {
  it("owner examples", () => {
    expect(chargePaise(T, 30 * 60)).toBe(11970);
    expect(chargePaise(T, 60 * 60)).toBe(22470);
    expect(chargePaise(T, 90 * 60)).toBe(32220);
    expect(chargePaise(T, 120 * 60)).toBe(41970);
  });
  it("discount only after the threshold, earlier minutes never repriced", () => {
    expect(chargePaise(T, 1799)).toBe(Math.round((399 * 1799) / 60)); // 11963.35 -> 11963
    expect(chargePaise(T, 1801) - chargePaise(T, 1800)).toBe(6); // one second at 350/min = 5.83 paise, rounded on the cumulative
    expect(chargePaise(T, 3601)).toBe(Math.round((399 * 1800 + 350 * 1800 + 325 * 1) / 60));
    expect(rateAtSecond(T, 0)).toBe(399); expect(rateAtSecond(T, 1800)).toBe(350); expect(rateAtSecond(T, 3600)).toBe(325);
  });
  it("prorated by seconds, not rounded up to whole minutes", () => {
    expect(chargePaise(T, 1)).toBe(7); // 6.65 -> 7 (half up, once)
    expect(chargePaise(T, 30)).toBe(200); // 199.5 -> 200
    expect(chargePaise(T, 61)).toBe(406); // 405.65 -> 406, not 2 x 399
    expect(chargePaise(T, 0)).toBe(0);
  });
  it("cumulative is monotonic and never drifts", () => {
    let prev = 0;
    for (let s = 0; s <= 4 * 3600; s += 7) { const c = chargePaise(T, s); expect(c).toBeGreaterThanOrEqual(prev); prev = c; }
  });
  it("a flat rate behaves exactly as before", () => {
    for (const s of [0, 1, 59, 60, 61, 3600]) expect(chargePaise(flatTariff(2000), s)).toBe(consumedValuePaise(2000, s));
    expect(validTariff(flatTariff(0))).toBe(false);
  });
});

describe("split: host Rs 2/min, phone estimate Rs 1/min, platform remainder", () => {
  const split = (s: number) => stdSplit({ tariff: T, billableSeconds: s, hostPaisePerMin: 200, phoneCostPaisePerMin: 100 });
  it("60-minute call (owner example)", () => {
    expect(split(3600)).toEqual({ valuePaise: 22470, hostPaise: 12000, phoneCostPaise: 6000, platformPaise: 4470 });
  });
  it("per-minute retention 0.99 / 0.50 / 0.25", () => {
    expect(split(1800).platformPaise).toBe(11970 - 6000 - 3000); // 2970 = 30 x 0.99
    expect(split(7200)).toEqual({ valuePaise: 41970, hostPaise: 24000, phoneCostPaise: 12000, platformPaise: 5970 });
  });
  it("V = H + C + P, never negative, host floored", () => {
    for (let s = 0; s < 3 * 3600; s += 13) {
      const x = split(s);
      expect(x.hostPaise + x.phoneCostPaise + x.platformPaise).toBe(x.valuePaise);
      expect(x.platformPaise).toBeGreaterThanOrEqual(0);
      expect(x.hostPaise).toBe(Math.floor((200 * s) / 60));
    }
  });
});

describe("breakdown lines add up to the charge", () => {
  it("90 minutes", () => {
    const b = tierBreakdown(T, 5400);
    expect(b.map((l) => l.amountPaise)).toEqual([11970, 10500, 9750]);
    expect(b.reduce((t, l) => t + l.amountPaise, 0)).toBe(chargePaise(T, 5400));
  });
  it("odd seconds", () => {
    for (const s of [1, 1799, 1801, 3599, 3601, 5555]) expect(tierBreakdown(T, s).reduce((t, l) => t + l.amountPaise, 0)).toBe(chargePaise(T, s));
  });
});

describe("rupee lots: paise in, paise out", () => {
  it("keeps the explicit 24-hour operational safety ceiling", () => {
    expect(STD_TECH_MAX_SECONDS).toBe(86_400);
    expect(planSpend([rupeeLot("a", 1_000_000)], T, STD_TECH_MAX_SECONDS).secondsCovered).toBe(86_400);
  });
  it("micro <-> paise", () => { expect(paiseToMicro(10169)).toBe(101_690_000); expect(microToPaise(101_690_000)).toBe(10169); expect(microToPaise(9_999)).toBe(0); });
  it("Rs 101.69 pays for a little over 25 minutes within the safety ceiling", () => {
    const p = planSpend([rupeeLot("a", 10169)], T, STD_TECH_MAX_SECONDS);
    expect(p.shortfall).toBe(true);
    expect(p.totalValuePaise).toBeLessThanOrEqual(10169);
    expect(chargePaise(T, p.secondsCovered + 1)).toBeGreaterThan(10169);
    for (const u of p.uses) expect(u.micro % 10_000).toBe(0); // every posting is whole paise
  });
  it("Rs 500 runs past 60 minutes into the cheapest band", () => {
    const p = planSpend([rupeeLot("a", 50000)], T, STD_TECH_MAX_SECONDS);
    expect(p.secondsCovered).toBeGreaterThan(3600);
  });
  it("start needs 2 minutes at Rs 3.99 = Rs 7.98", () => {
    expect(canStart([rupeeLot("a", 798)], T)).toBe(true);
    expect(canStart([rupeeLot("a", 797)], T)).toBe(false);
  });
});

describe("config", () => {
  it("defaults are the owner's numbers", () => {
    const s = readHfStdPlan({});
    expect(s.enabled).toBe(false);
    expect(s.tariff).toEqual(T);
    expect([s.hostPaisePerMin, s.phoneCostPaisePerMin, s.gstBps, s.gstInclusive]).toEqual([200, 100, 1800, true]);
  });
  it("activates only on explicit true and rejects unsafe economics by falling back", () => {
    expect(readHfStdPlan({ hfStdPlanEnabled: true }).enabled).toBe(false);
    expect(readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2077 }).enabled).toBe(false);
    expect(readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 }).enabled).toBe(true);
    expect(readHfStdPlan({ hfStdTier3PaisePerMin: 250, hfStdHostPaisePerMin: 200, hfStdPhoneCostPaisePerMin: 100 }).tariff).toEqual(T);
  });
  it("bad band ends fall back", () => { expect(readHfStdPlan({ hfStdTier1EndMin: 60, hfStdTier2EndMin: 30 }).tariff).toEqual(T); });
  it("public block shows rates, never host pay", () => {
    const pub = hfStdPlanPublic({});
    expect(pub.minCompatibleBuild).toBe(2078);
    expect(pub.tiers.map((t) => t.rupeesPerMin)).toEqual(["3.99", "3.50", "3.25"]);
    expect(JSON.stringify(pub)).not.toMatch(/host|phone/i);
  });
});

describe("formatRupees", () => {
  it("two decimals, Indian grouping", () => {
    expect(formatRupees(10169)).toBe("₹101.69");
    expect(formatRupees(12000)).toBe("₹120.00");
    expect(formatRupees(101695)).toBe("₹1,016.95");
    expect(formatRupees(12345678)).toBe("₹1,23,456.78");
    expect(formatRupees(-500)).toBe("-₹5.00");
  });
});
