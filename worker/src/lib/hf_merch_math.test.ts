import { describe, it, expect } from "vitest";
import {
  MERCH_DEFAULT_CFG, readMerchCfg, computeMerchMoney, baseUnitPaise, checkMarkup, quoteAgainstLive, earningAvailableAt, sizePrices, splitBase, sizeBreakdown, youEarnUnitPaise, bpsOf, bpsFloor,
  rupeesText, DAY_MS, profitRow, gstInclusiveSplit, merchTaxSplit, printroveInputGstPaise, merchGstOf, maxMarkupForBase, checkPriceCap, gstForCategory,
} from "./hf_merch_math";

describe("spec section 1 worked example: base 500, markup 200, Cashfree", () => {
  const m = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG });
  it("fan pays 700, influencer 120, platform 80", () => {
    expect(m.totalPaise).toBe(70_000);
    expect(m.influencerPaise).toBe(12_000);
    expect(m.platformPaise).toBe(8_000);
    expect(m.basePaise).toBe(50_000);
  });
  it("[HF-MERCH-GST-1] Cashfree fee estimate 24.50, 5% GST inside 700 = 33.33 (no input credit without a printing figure), platform net 22.17", () => {
    expect(m.cashfreeFeeEstPaise).toBe(2_450);
    expect(m.outputGstPaise).toBe(3_333);
    expect(m.inputGstPaise).toBe(0);
    expect(m.netGstPaise).toBe(3_333);
    expect(m.gstEstPaise).toBe(3_333); // legacy name carries the net
    expect(m.platformNetPaise).toBe(8_000 - 2_450 - 3_333);
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
    expect(wallet.platformNetPaise).toBe(8_000 - 3_333);
  });
});

describe("[HF-MERCH-GST-1] platform is the seller: worked example, fan pays 644", () => {
  // base 444 (shirt+print 393.75 incl. 5% GST, shipping 50, rounded up), markup 200, Cashfree 3.5%.
  const m = computeMerchMoney({ baseUnitPaise: 44_400, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG, printingUnitPaise: 39_375 });
  it("GST inside 644 is 30.67, taxable 613.33", () => {
    expect(m.totalPaise).toBe(64_400);
    expect(m.outputGstPaise).toBe(3_067);
    expect(m.taxablePaise).toBe(61_333);
    expect(m.gstRateBps).toBe(500);
  });
  it("Printrove input credit 18.75, net GST payable 11.92", () => {
    expect(m.inputGstPaise).toBe(1_875);
    expect(m.netGstPaise).toBe(1_192);
  });
  it("influencer royalty is still 60% of the markup", () => {
    expect(m.influencerPaise).toBe(12_000);
    expect(m.platformPaise).toBe(8_000);
  });
  it("platform keeps 45.79 in total (the profit row sees the 25 paise base round-up)", () => {
    const r = profitRow({ size: "S", printroveCostPaise: 39_375, shippingPaise: 5_000, fanPaysPaise: 64_400, markupPaise: 20_000, influencerPaise: 12_000, gstRateBps: 500, cashfreeFeeBps: 350 });
    expect(r.outputGstPaise).toBe(3_067);
    expect(r.inputGstPaise).toBe(1_875);
    expect(r.netGstPaise).toBe(1_192);
    expect(r.platformBeforeFeesPaise).toBe(8_025);
    expect(r.cashfreeEstPaise).toBe(2_254);
    expect(r.platformAfterFeesPaise).toBe(4_579);
  });
  it("gstInclusiveSplit rounds GST to the paisa and taxable is the rest", () => {
    expect(gstInclusiveSplit(64_400)).toEqual({ taxablePaise: 61_333, gstPaise: 3_067 });
    expect(gstInclusiveSplit(10_500)).toEqual({ taxablePaise: 10_000, gstPaise: 500 });
    expect(gstInclusiveSplit(0)).toEqual({ taxablePaise: 0, gstPaise: 0 });
    expect(gstInclusiveSplit(10_500, 0)).toEqual({ taxablePaise: 10_500, gstPaise: 0 });
    for (const t of [1, 99, 12_345, 250_000]) { const s = gstInclusiveSplit(t); expect(s.taxablePaise + s.gstPaise).toBe(t); }
  });
  it("input credit is printing x 5/105 and quantity multiplies the printing", () => {
    expect(printroveInputGstPaise(39_375)).toBe(1_875);
    const q = computeMerchMoney({ baseUnitPaise: 44_400, markupUnitPaise: 20_000, qty: 2, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG, printingUnitPaise: 39_375 });
    expect(q.inputGstPaise).toBe(3_750);
    expect(q.outputGstPaise).toBe(gstInclusiveSplit(128_800).gstPaise);
    expect(q.netGstPaise).toBe(q.outputGstPaise! - q.inputGstPaise!);
  });
  it("old snapshots read as their estimate", () => {
    expect(merchGstOf({ gstEstPaise: 1_440 })).toEqual({ outputGstPaise: 0, inputGstPaise: 0, netGstPaise: 1_440, legacy: true });
    expect(merchGstOf(m)).toMatchObject({ outputGstPaise: 3_067, inputGstPaise: 1_875, netGstPaise: 1_192, legacy: false });
  });
});

describe("[HF-MERCH-GST-1] place of supply: CGST + SGST inside the supplier's state, IGST outside", () => {
  it("same state -> CGST 2.5% + SGST 2.5% (CGST rounds down, SGST takes the odd paisa)", () => {
    expect(merchTaxSplit(64_400, 500, "27", "27")).toEqual({ totalPaise: 64_400, taxablePaise: 61_333, gstPaise: 3_067, cgstPaise: 1_533, sgstPaise: 1_534, igstPaise: 0, intraState: true, stateKnown: true });
  });
  it("other state -> all IGST 5%", () => {
    const s = merchTaxSplit(64_400, 500, "29", "27");
    expect(s).toMatchObject({ taxablePaise: 61_333, gstPaise: 3_067, cgstPaise: 0, sgstPaise: 0, igstPaise: 3_067, intraState: false });
  });
  it("taxable + tax always equals the total; the parts always add up to the tax", () => {
    for (const total of [100, 9_999, 64_400, 250_000]) for (const buyer of ["27", "07"]) {
      const s = merchTaxSplit(total, 500, buyer, "27");
      expect(s.taxablePaise + s.gstPaise).toBe(total);
      expect(s.cgstPaise + s.sgstPaise + s.igstPaise).toBe(s.gstPaise);
    }
  });
  it("an unknown buyer state is treated as intra-state and flagged", () => {
    expect(merchTaxSplit(64_400, 500, null, "27")).toMatchObject({ intraState: true, stateKnown: false, igstPaise: 0 });
  });
});

describe("[HF-MERCH-GST-1] per-category GST: a mug at 18% (fan pays 500, wallet)", () => {
  // base 335 = printing 295 (incl. Printrove's 18%) + delivery 40, markup 165, no Cashfree on the wallet.
  const gst = gstForCategory(MERCH_DEFAULT_CFG, "home");
  const m = computeMerchMoney({ baseUnitPaise: 33_500, markupUnitPaise: 16_500, qty: 1, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG, printingUnitPaise: 29_500, gst, partnerGstBps: 1_800 });
  it("the home category is 18%, no cap, HSN still to confirm", () => {
    expect(gst).toMatchObject({ rateBps: 1_800, hsn: "", capApplies: false, category: "home" });
  });
  it("GST inside 500 at 18% is 76.27, taxable 423.73, frozen into the money block", () => {
    expect(m.totalPaise).toBe(50_000);
    expect(m.outputGstPaise).toBe(7_627);
    expect(m.taxablePaise).toBe(42_373);
    expect(m).toMatchObject({ gstRateBps: 1_800, hsn: "", partnerGstBps: 1_800 });
  });
  it("input credit at Printrove's 18% is 45.00, net GST 31.27", () => {
    expect(m.inputGstPaise).toBe(4_500);
    expect(m.netGstPaise).toBe(3_127);
  });
  it("royalty is still 60% of the markup and the platform keeps 34.73", () => {
    expect(m.influencerPaise).toBe(9_900);
    expect(m.platformNetPaise).toBe(3_473);
    const r = profitRow({ size: "M", printroveCostPaise: 29_500, shippingPaise: 4_000, fanPaysPaise: 50_000, markupPaise: 16_500, influencerPaise: 9_900, gstRateBps: 1_800, cashfreeFeeBps: 0 });
    expect(r).toMatchObject({ outputGstPaise: 7_627, inputGstPaise: 4_500, netGstPaise: 3_127, platformAfterFeesPaise: 3_473 });
  });
  it("input credit uses Printrove's GST when it differs from the category rate", () => {
    expect(printroveInputGstPaise(29_500, 1_800)).toBe(4_500);
    const x = computeMerchMoney({ baseUnitPaise: 33_500, markupUnitPaise: 16_500, qty: 1, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG, printingUnitPaise: 29_500, gst, partnerGstBps: 500 });
    expect(x.inputGstPaise).toBe(1_405); // 29,500 x 5/105
    expect(x.partnerGstBps).toBe(500);
  });
  it("with no partner GST the input credit uses the category rate; with no frozen gst the flat fallback (5%) applies", () => {
    const a = computeMerchMoney({ baseUnitPaise: 33_500, markupUnitPaise: 16_500, qty: 1, payMethod: "wallet", cfg: MERCH_DEFAULT_CFG, printingUnitPaise: 29_500, gst });
    expect(a.inputGstPaise).toBe(4_500);
    const legacy = computeMerchMoney({ baseUnitPaise: 44_400, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG, printingUnitPaise: 39_375 });
    expect(legacy).toMatchObject({ gstRateBps: 500, inputGstPaise: 1_875, netGstPaise: 1_192 });
  });
  it("T-shirt category is the 5% / 6109 / capped row", () => {
    expect(gstForCategory(MERCH_DEFAULT_CFG, "tshirts")).toMatchObject({ rateBps: 500, hsn: "6109", capApplies: true });
    expect(gstForCategory(MERCH_DEFAULT_CFG, "hoodies")).toMatchObject({ rateBps: 500, hsn: "6110", capApplies: true });
    expect(gstForCategory(MERCH_DEFAULT_CFG, "no-such-category")).toMatchObject({ rateBps: 500, hsn: "6109", capApplies: true });
  });
  it("no cap: checkPriceCap with a null cap always passes", () => {
    expect(checkPriceCap([{ size: "M", baseUnitPaise: 900_000 }], 5_000, null)).toEqual({ ok: true });
  });
});

describe("[HF-MERCH-GST-1] price cap", () => {
  const sizes = [{ size: "S", baseUnitPaise: 44_400 }, { size: "3XL", baseUnitPaise: 52_400 }];
  it("max markup per size is whole rupees below the cap, never negative", () => {
    expect(maxMarkupForBase(44_400, 250_000)).toBe(2_056);
    expect(maxMarkupForBase(250_001, 250_000)).toBe(0);
    expect(maxMarkupForBase(240_050, 250_000)).toBe(99);
  });
  it("a markup that pushes ANY size over the cap is refused with the smallest allowed markup", () => {
    expect(checkPriceCap(sizes, 1_976, 250_000)).toEqual({ ok: true });
    expect(checkPriceCap(sizes, 1_977, 250_000)).toEqual({ ok: false, maxMarkupRupees: 1_976, capPaise: 250_000, size: "3XL" });
  });
  it("the cap is inclusive: exactly Rs 2,500 is allowed", () => {
    expect(checkPriceCap([{ size: "M", baseUnitPaise: 50_000 }], 2_000, 250_000)).toEqual({ ok: true });
    expect(checkPriceCap([{ size: "M", baseUnitPaise: 50_000 }], 2_001, 250_000)).toMatchObject({ ok: false, maxMarkupRupees: 2_000 });
  });
  it("sizePrices adds maxMarkupRupees only when a cap is given", () => {
    expect(sizePrices([{ size: "M", baseUnitPaise: 50_000 }], 200, 4000, 250_000)[0].maxMarkupRupees).toBe(2_000);
    expect("maxMarkupRupees" in sizePrices([{ size: "M", baseUnitPaise: 50_000 }], 200, 4000)[0]).toBe(false);
  });
  it("config: cap and rate come from the flags, junk falls back", () => {
    expect(readMerchCfg({ hfMerchPriceCapRupees: 3000, hfMerchGstRateBps: 1200, hfMerchHsn: " 6109 " })).toMatchObject({ priceCapPaise: 300_000, gstRateBps: 1200, hsn: "6109" });
    expect(readMerchCfg({ hfMerchPriceCapRupees: 0, hfMerchGstRateBps: 9999, hfMerchHsn: "abc" })).toMatchObject({ priceCapPaise: 250_000, gstRateBps: 500, hsn: "6109" });
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
  const frozen = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG }); // net 2217
  const NET = frozen.platformNetPaise;
  it("unchanged cost: approvable, net unchanged", () => {
    const q = quoteAgainstLive(frozen, 50_000);
    expect(q).toMatchObject({ liveBasePaise: 50_000, platformNetAfterPaise: NET, costRose: false, canApprove: true, risePaise: 0 });
  });
  it("a small rise eats into the platform net but can still be approved", () => {
    const q = quoteAgainstLive(frozen, 51_000);
    expect(q.platformNetAfterPaise).toBe(NET - 1_000);
    expect(q.canApprove).toBe(true);
  });
  it("net exactly zero is allowed; one paisa below is refused (cost_rose)", () => {
    expect(quoteAgainstLive(frozen, 50_000 + NET).canApprove).toBe(true);
    const q = quoteAgainstLive(frozen, 50_000 + NET + 1);
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

describe("[HF-MERCH-PROFIT-VIEW-1] profitRow", () => {
  const base = { markupPaise: 20_000, influencerPaise: 12_000, legacyGstBps: 1800, cashfreeFeeBps: 350 }; // the pre HF-MERCH-GST-1 18%-on-our-share path (old orders)
  it("size S: Printrove 267.75 + 50 = 317.75, fan 548, platform 110.25 before, 76.67 after", () => {
    const r = profitRow({ ...base, size: "S", printroveCostPaise: 26_775, shippingPaise: 5_000, fanPaysPaise: 54_800 });
    expect(r.printroveTotalPaise).toBe(31_775);
    expect(r.platformBeforeFeesPaise).toBe(11_025);
    expect(r.gstEstPaise).toBe(1_440);
    expect(r.cashfreeEstPaise).toBe(1_918);
    expect(r.platformAfterFeesPaise).toBe(7_667);
  });
  it("size 2XL: 283.50 + 50 = 333.50, before fees 110.50", () => {
    const r = profitRow({ ...base, size: "2XL", printroveCostPaise: 28_350, shippingPaise: 5_000, fanPaysPaise: 56_400 });
    expect(r.printroveTotalPaise).toBe(33_350);
    expect(r.platformBeforeFeesPaise).toBe(11_050);
  });
  it("wallet (0 bps) has no Cashfree part; a loss goes negative", () => {
    const w = profitRow({ ...base, cashfreeFeeBps: 0, size: "S", printroveCostPaise: 26_775, shippingPaise: 5_000, fanPaysPaise: 54_800 });
    expect(w.cashfreeEstPaise).toBe(0);
    expect(w.platformAfterFeesPaise).toBe(9_585);
    const loss = profitRow({ ...base, size: "S", printroveCostPaise: 50_000, shippingPaise: 5_000, fanPaysPaise: 54_800 });
    expect(loss.platformAfterFeesPaise).toBeLessThan(0);
  });
});

describe("[HF-MERCH-PRICE-LABELS-1] price breakdown", () => {
  // Premium oversized tee, small print: shirt 285 + print 90 + 5% GST = 393.75, shipping 50 -> 443.75 -> base 444.
  it("splits printing (incl. GST) and shipping and rounds the base up", () => {
    const total = Math.round((285 + 90) * 1.05 * 100) / 100 + 50;
    expect(splitBase(total, 50, 0)).toEqual({ printingPaise: 39_375, shippingPaise: 5_000, bufferPaise: 0, baseUnitPaise: 44_400 });
  });
  it("carries the admin buffer into base and reports it separately", () => {
    expect(splitBase(443.75, 50, 6)).toEqual({ printingPaise: 39_375, shippingPaise: 5_000, bufferPaise: 600, baseUnitPaise: 45_000 });
  });
  it("no shipping quote means printing is the whole cost", () => {
    expect(splitBase(393.75, null, 0)).toMatchObject({ printingPaise: 39_375, shippingPaise: 0, baseUnitPaise: 39_400 });
    expect(splitBase(null, 50, 0)).toBeNull();
  });
  it("fan price and earning follow the example: markup 200 -> fan pays 644, you earn 120", () => {
    const [r] = sizePrices([{ size: "S", baseUnitPaise: 44_400 }], 200, 4000);
    expect(r.pricePaise).toBe(64_400);
    expect(r.youEarnPaise).toBe(12_000);
  });
  it("frozen parts are used as stored", () => {
    expect(sizeBreakdown({ baseUnitPaise: 44_400, printingPaise: 39_375, shippingPaise: 5_000, bufferPaise: 0 }, 9_900, 0))
      .toEqual({ printingPaise: 39_375, shippingPaise: 5_000, bufferPaise: 0, estimated: false });
  });
  it("older products derive shipping from today's quote, add up to the base, and are flagged estimated", () => {
    const r = sizeBreakdown({ baseUnitPaise: 44_400 }, 5_000, 600);
    expect(r).toEqual({ printingPaise: 38_800, shippingPaise: 5_000, bufferPaise: 600, estimated: true });
    expect(r.printingPaise + r.shippingPaise + r.bufferPaise).toBe(44_400);
  });
  it("never goes negative when shipping exceeds the base", () => {
    const r = sizeBreakdown({ baseUnitPaise: 3_000 }, 5_000, 600);
    expect(r.printingPaise).toBe(0);
    expect(r.shippingPaise + r.bufferPaise + r.printingPaise).toBe(3_000);
  });
});
