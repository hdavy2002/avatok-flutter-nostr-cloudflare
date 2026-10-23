import { describe, it, expect } from "vitest";
import {
  MERCH_DEFAULT_CFG, readMerchCfg, computeMerchMoney, baseUnitPaise, checkMarkup, quoteAgainstLive, earningAvailableAt, sizePrices, youEarnUnitPaise, bpsOf, bpsFloor,
  rupeesText, DAY_MS,
} from "./hf_merch_math";

describe("spec section 1 worked example: base 500, markup 200, Cashfree", () => {
  const m = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG });
  it("fan pays 700, influencer 120, platform 80", () => {
    expect(m.totalPaise).toBe(70_000);
    expect(m.influencerPaise).toBe(12_000);
    expect(m.platformPaise).toBe(8_000);
    expect(m.basePaise).toBe(50_000);
  });
  it("Cashfree fee estimate 24.50, GST estimate 14.40, platform net 41.10", () => {
    expect(m.cashfreeFeeEstPaise).toBe(2_450);
    expect(m.gstEstPaise).toBe(1_440);
    expect(m.platformNetPaise).toBe(4_110);
  });
  it("the fee and GST never change the influencer's amount", () => {
    const wallet = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG });
    expect(wallet.influencerPaise).toBe(m.influencerPaise);
    const pricey = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: { ...MERCH_DEFAULT_CFG, cashfreeFeeBps: 2000, gstBps: 5000 } });
    expect(pricey.influencerPaise).toBe(12_000);
  });
  it("a wallet payment has no gateway fee estimate; GST still applies to the platform share", () => {
    const wallet = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG });
    expect(wallet.cashfreeFeeEstPaise).toBe(0);
    expect(wallet.cashfreeFeeBps).toBe(0);
    expect(wallet.platformNetPaise).toBe(8_000 - 1_440);
  });
});

describe("split rounding", () => {
  it("influencer is floored, the platform keeps the odd paisa, and the two always add up to the markup", () => {
    for (const markup of [1000, 1001, 1003, 3333, 99_999]) {
      const m = computeMerchMoney({ baseUnitPaise: 30_000, markupUnitPaise: markup, qty: 1, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG });
      expect(m.influencerPaise + m.platformPaise).toBe(m.markupPaise);
      expect(m.influencerPaise).toBe(Math.floor((markup * 6000) / 10000));
    }
  });
  it("quantity multiplies the totals and the split is taken on the total markup", () => {
    const m = computeMerchMoney({ baseUnitPaise: 40_000, markupUnitPaise: 1_001, qty: 3, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG });
    expect(m.totalPaise).toBe(3 * 41_001);
    expect(m.markupPaise).toBe(3_003);
    expect(m.influencerPaise).toBe(Math.floor((3_003 * 6000) / 10000));
    expect(m.basePaise).toBe(120_000);
  });
  it("qty is clamped to 1..3", () => {
    expect(computeMerchMoney({ baseUnitPaise: 100, markupUnitPaise: 100, qty: 9, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG }).qty).toBe(3);
    expect(computeMerchMoney({ baseUnitPaise: 100, markupUnitPaise: 100, qty: 0, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG }).qty).toBe(1);
  });
  it("the share is configurable", () => {
    const m = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "wallet", cfg: { ...MERCH_DEFAULT_CFG, platformShareBps: 5000 } });
    expect(m.influencerPaise).toBe(10_000);
    expect(m.platformPaise).toBe(10_000);
  });
  it("bps helpers", () => {
    expect(bpsOf(70_000, 350)).toBe(2_450);
    expect(bpsOf(1, 5000)).toBe(1); // 0.5 rounds half up
    expect(bpsFloor(1, 5000)).toBe(0);
    expect(youEarnUnitPaise(20_000, 4000)).toBe(12_000);
  });
});

describe("base price", () => {
  it("rounds the partner cost UP to a whole rupee and adds the buffer", () => {
    expect(baseUnitPaise(233.4, 0)).toBe(23_400);
    expect(baseUnitPaise(234, 0)).toBe(23_400);
    expect(baseUnitPaise(234.01, 0)).toBe(23_500);
    expect(baseUnitPaise(233.4, 10)).toBe(24_400);
  });
  it("no price from the partner means no base price", () => {
    expect(baseUnitPaise(null, 0)).toBeNull();
    expect(baseUnitPaise(0, 0)).toBeNull();
    expect(baseUnitPaise(Number.NaN, 5)).toBeNull();
  });
  it("sizePrices adds the markup and shows what the influencer earns per unit", () => {
    const r = sizePrices([{ size: "M", baseUnitPaise: 50_000 }, { size: "XL", baseUnitPaise: 55_000 }], 200, 4000);
    expect(r).toEqual([
      { size: "M", basePaise: 50_000, pricePaise: 70_000, youEarnPaise: 12_000 },
      { size: "XL", basePaise: 55_000, pricePaise: 75_000, youEarnPaise: 12_000 },
    ]);
  });
});

describe("markup rules", () => {
  it("minimum comes from the setting, maximum is 5000", () => {
    expect(checkMarkup(10, { minMarkupRupees: 10 }).ok).toBe(true);
    expect(checkMarkup(9, { minMarkupRupees: 10 })).toMatchObject({ ok: false, error: "markup_too_low" });
    expect(checkMarkup(5000, { minMarkupRupees: 10 }).ok).toBe(true);
    expect(checkMarkup(5001, { minMarkupRupees: 10 })).toMatchObject({ ok: false, error: "markup_too_high" });
    expect(checkMarkup(20.5, { minMarkupRupees: 10 })).toMatchObject({ ok: false, error: "invalid_markup" });
    expect(checkMarkup("abc", { minMarkupRupees: 10 })).toMatchObject({ ok: false, error: "invalid_markup" });
    expect(checkMarkup("200", { minMarkupRupees: 10 })).toMatchObject({ ok: true, markupRupees: 200 });
  });
});

describe("approval re-quote", () => {
  const frozen = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG }); // net 4110
  it("unchanged cost: approvable, net unchanged", () => {
    const q = quoteAgainstLive(frozen, 50_000);
    expect(q).toMatchObject({ liveBasePaise: 50_000, platformNetAfterPaise: 4_110, costRose: false, canApprove: true, risePaise: 0 });
  });
  it("a small rise eats into the platform net but can still be approved", () => {
    const q = quoteAgainstLive(frozen, 53_000);
    expect(q.platformNetAfterPaise).toBe(1_110);
    expect(q.canApprove).toBe(true);
  });
  it("net exactly zero is allowed; one paisa below is refused (cost_rose)", () => {
    expect(quoteAgainstLive(frozen, 54_110).canApprove).toBe(true);
    const q = quoteAgainstLive(frozen, 54_111);
    expect(q.platformNetAfterPaise).toBe(-1);
    expect(q.costRose).toBe(true);
    expect(q.canApprove).toBe(false);
  });
  it("quantity multiplies the rise", () => {
    const f3 = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 3, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG });
    const q = quoteAgainstLive(f3, 53_000);
    expect(q.risePaise).toBe(9_000);
    expect(q.liveBasePaise).toBe(159_000);
    expect(q.platformNetAfterPaise).toBe(f3.platformNetPaise - 9_000);
  });
  it("a cheaper live price is a saving for the platform, never a refund", () => {
    const q = quoteAgainstLive(frozen, 45_000);
    expect(q.risePaise).toBe(-5_000);
    expect(q.canApprove).toBe(true);
  });
});

describe("hold", () => {
  it("an earning is withdrawable holdDays after delivery", () => {
    expect(earningAvailableAt(1_000, 7)).toBe(1_000 + 7 * DAY_MS);
    expect(earningAvailableAt(1_000, 0)).toBe(1_000);
  });
});

describe("config reader", () => {
  it("defaults when nothing is set", () => {
    expect(readMerchCfg({})).toEqual(MERCH_DEFAULT_CFG);
    expect(readMerchCfg(null)).toEqual(MERCH_DEFAULT_CFG);
  });
  it("reads valid overrides and ignores junk", () => {
    const c = readMerchCfg({ hfMerchPlatformShareBps: 3000, hfMerchHoldDays: "10", hfMerchGstBps: "x", hfMerchMinMarkupRupees: -4, hfMerchCashfreeFeeBps: 12.5 });
    expect(c.platformShareBps).toBe(3000);
    expect(c.holdDays).toBe(10);
    expect(c.gstBps).toBe(1800);
    expect(c.minMarkupRupees).toBe(10);
    expect(c.cashfreeFeeBps).toBe(350);
  });
});

describe("rupeesText", () => {
  it("whole rupees have no decimals; paise are shown", () => {
    expect(rupeesText(70_000)).toBe("Rs 700");
    expect(rupeesText(2_450)).toBe("Rs 24.50");
    expect(rupeesText(5)).toBe("Rs 0.05");
  });
});
