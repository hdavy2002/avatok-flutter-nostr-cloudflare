import { describe, it, expect } from "vitest";
import {
  MICRO, tokensPerMinuteMicro, formatTokens, formatDuration, consumedValuePaise, callSplit, microForValue, cumulativeMicro,
  planSpend, affordableSeconds, canStart, applyRefund, PRICING_GP_V1, PRICING_GP_V2, PRICING_PT_V1_EXAMPLE, type Lot,
} from "./hf_token_math";

const R20 = 2000; // Rs 20 per minute, in paise
const V82 = 82;

// [HF-TOK-MATH-1] spec section 11.10, the pure cases.
describe("11.10 #1 tokens per minute and how long 100 tokens last", () => {
  it("Rs20/min at Rs0.82 -> 24.390244 tokens/min (display 24.39), never rounded up to 25", () => {
    expect(tokensPerMinuteMicro(R20, V82)).toBe(24_390_244);
    expect(formatTokens(24_390_244)).toBe("24.39");
    expect(formatTokens(24_390_244, 6)).toBe("24.390244");
  });
  it("100 tokens last exactly 246 s (245 s is not enough, 246 s is exact)", () => {
    expect(cumulativeMicro(R20, 246, V82)).toBe(100 * MICRO);
    expect(cumulativeMicro(R20, 245, V82)).toBe(99_593_495);
    const lots: Lot[] = [{ id: "a", valuePaisePerToken: V82, leftMicro: 100 * MICRO }];
    expect(affordableSeconds(lots, R20, 3600)).toBe(246);
    expect(formatDuration(246)).toBe("4 min 6 s");
  });
});

describe("11.10 #2 a 246 s call at Rs20", () => {
  it("V 8200, C 820, H 4428, P 2952, 100.000000 tokens", () => {
    expect(callSplit({ ratePaise: R20, billableSeconds: 246 })).toEqual({ valuePaise: 8200, callCostPaise: 820, hostPaise: 4428, platformPaise: 2952 });
    const plan = planSpend([{ id: "a", valuePaisePerToken: V82, leftMicro: 100 * MICRO }], R20, 246);
    expect(plan.totalMicro).toBe(100_000_000);
    expect(plan.totalValuePaise).toBe(8200);
    expect(plan.secondsCovered).toBe(246);
    expect(plan.shortfall).toBe(false);
  });
});

describe("11.10 #3 one full minute at Rs20", () => {
  it("host 1080, platform 720, call cost 200", () => {
    expect(callSplit({ ratePaise: R20, billableSeconds: 60 })).toEqual({ valuePaise: 2000, callCostPaise: 200, hostPaise: 1080, platformPaise: 720 });
  });
});

describe("11.10 #4 partial minute", () => {
  it("61 s at Rs20 -> V 2033, C 203, H 1098, P 732", () => {
    expect(callSplit({ ratePaise: R20, billableSeconds: 61 })).toEqual({ valuePaise: 2033, callCostPaise: 203, hostPaise: 1098, platformPaise: 732 });
  });
  it("round half up on V", () => {
    expect(consumedValuePaise(30, 1)).toBe(1); // 0.5 -> 1
    expect(consumedValuePaise(29, 1)).toBe(0); // 0.4833 -> 0
    expect(consumedValuePaise(2000, 0)).toBe(0);
  });
});

describe("11.10 #5 rate of Rs2 or less", () => {
  it("host 0, call cost = V", () => {
    for (const rate of [0, 100, 199, 200]) {
      for (const s of [0, 1, 59, 60, 61, 3600]) {
        const x = callSplit({ ratePaise: rate, billableSeconds: s });
        expect(x.hostPaise).toBe(0);
        expect(x.callCostPaise).toBe(x.valuePaise);
        expect(x.platformPaise).toBe(0);
      }
    }
  });
});

describe("11.10 #8 (pure part) not enough balance", () => {
  const one = (left: number): Lot[] => [{ id: "a", valuePaisePerToken: V82, leftMicro: left }];
  it("under 2 minutes cannot start, 2 minutes can", () => {
    // 2 min at Rs20 = Rs40 = 4000 paise = 48.780488 tokens (ceil 48_780_488 micro is needed; floor value cap of 48_780_487 is 3999)
    expect(canStart(one(48_000_000), R20)).toBe(false);
    expect(canStart(one(48_780_487), R20)).toBe(false);
    expect(canStart(one(48_780_488), R20)).toBe(true);
    expect(canStart(one(100 * MICRO), R20)).toBe(true);
    expect(canStart([], R20)).toBe(false);
  });
  it("running out mid-call stops at the last whole second the lots pay for", () => {
    const plan = planSpend(one(10 * MICRO), R20, 600); // 10 tokens = 820 paise = 24.6 s
    expect(plan.secondsCovered).toBe(24);
    expect(plan.shortfall).toBe(true);
    expect(plan.totalValuePaise).toBe(consumedValuePaise(R20, 24)); // 800
    expect(plan.totalMicro).toBe(microForValue(800, V82)); // 9_756_098
    expect(plan.totalMicro).toBeLessThanOrEqual(10 * MICRO);
    // one more second would cost 833 paise, more than the 820 on hand
    expect(consumedValuePaise(R20, 25)).toBe(833);
  });
  it("affordableSeconds caps at the cap", () => {
    expect(affordableSeconds(one(10_000 * MICRO), R20)).toBe(3600);
    expect(affordableSeconds(one(10_000 * MICRO), R20, 120)).toBe(120);
  });
});

describe("11.10 #9 mixed lots", () => {
  const lots: Lot[] = [
    { id: "old", valuePaisePerToken: 82, leftMicro: 50 * MICRO },
    { id: "new", valuePaisePerToken: 100, leftMicro: 100 * MICRO },
  ];
  it("first 123 s come from the Rs0.82 lot", () => {
    const p = planSpend(lots, R20, 123);
    expect(p.uses).toEqual([{ lotId: "old", micro: 50_000_000, valuePaise: 4100 }]);
    expect(p.totalValuePaise).toBe(4100);
  });
  it("after that the Rs1 lot is used at 20 tokens a minute", () => {
    expect(tokensPerMinuteMicro(R20, 100)).toBe(20 * MICRO);
    const p = planSpend(lots, R20, 183); // 123 s + 60 s
    expect(p.uses).toEqual([
      { lotId: "old", micro: 50_000_000, valuePaise: 4100 },
      { lotId: "new", micro: 20_000_000, valuePaise: 2000 },
    ]);
    expect(p.totalValuePaise).toBe(consumedValuePaise(R20, 183));
  });
  it("a lot that runs out mid-second hands the remainder to the next lot at its own value", () => {
    const p = planSpend(lots, R20, 124); // V 4133: lot1 4100, lot2 33 -> ceil(33e6/100) = 330_000
    expect(p.uses).toEqual([
      { lotId: "old", micro: 50_000_000, valuePaise: 4100 },
      { lotId: "new", micro: 330_000, valuePaise: 33 },
    ]);
  });
  it("host earns Rs10.80 per full minute whichever lot paid", () => {
    for (const mins of [1, 2, 3, 5, 9]) {
      expect(callSplit({ ratePaise: R20, billableSeconds: mins * 60 }).hostPaise).toBe(mins * 1080);
    }
  });
  it("total capacity across lots bounds the call", () => {
    // 4100 + 10000 paise = 14100 -> floor(14100 * 60 / 2000)=423 s; 423 s = V 14100 exactly
    expect(affordableSeconds(lots, R20, 3600)).toBe(423);
    const p = planSpend(lots, R20, 3600);
    expect(p.shortfall).toBe(true);
    expect(p.totalValuePaise).toBe(14100);
    expect(p.totalMicro).toBe(150 * MICRO);
  });
  it("empty and dust lots are skipped", () => {
    const p = planSpend([{ id: "z", valuePaisePerToken: 82, leftMicro: 0 }, { id: "d", valuePaisePerToken: 82, leftMicro: 5 }, ...lots], R20, 60);
    expect(p.uses.map((u) => u.lotId)).toEqual(["old"]);
  });
});

describe("11.10 #10 (pure part) pricing versions", () => {
  it("gp-v1 and the future pt-v1 example", () => {
    expect(PRICING_GP_V1).toEqual({ id: "gp-v1", provider: "google_play", purchasePaisePerToken: 100, redemptionPaisePerToken: 82, providerFeeBps: 1500, taxMode: "none_unregistered" });
    expect(PRICING_PT_V1_EXAMPLE.id).toBe("pt-v1");
    expect(PRICING_PT_V1_EXAMPLE.redemptionPaisePerToken).toBe(100);
  });
  it("a Rs20/min host costs 20 tokens/min at Rs1 value, 24.39 at Rs0.82; host split is identical", () => {
    expect(formatTokens(tokensPerMinuteMicro(R20, PRICING_PT_V1_EXAMPLE.redemptionPaisePerToken))).toBe("20.00");
    expect(formatTokens(tokensPerMinuteMicro(R20, PRICING_GP_V1.redemptionPaisePerToken))).toBe("24.39");
    // an old lot keeps its own value after a new version exists
    const lots: Lot[] = [
      { id: "gp", valuePaisePerToken: PRICING_GP_V1.redemptionPaisePerToken, leftMicro: 10 * MICRO },
      { id: "pt", valuePaisePerToken: PRICING_PT_V1_EXAMPLE.redemptionPaisePerToken, leftMicro: 10 * MICRO },
    ];
    expect(planSpend(lots, R20, 24).uses).toEqual([{ lotId: "gp", micro: microForValue(800, 82), valuePaise: 800 }]);
  });
});

describe("11.10 #7 (pure part) refund", () => {
  it("before any spend: whole lot removed, no debt", () => {
    expect(applyRefund({ grantedMicro: 100 * MICRO, leftMicro: 100 * MICRO, reservedMicro: 0, valuePaisePerToken: 82 }))
      .toEqual({ removeMicro: 100_000_000, releaseReservedMicro: 0, debtMicro: 0, debtValuePaise: 0 });
  });
  it("after 60 tokens spent: 40 removed, debt for 60 tokens' value (Rs49.20)", () => {
    expect(applyRefund({ grantedMicro: 100 * MICRO, leftMicro: 40 * MICRO, reservedMicro: 0, valuePaisePerToken: 82 }))
      .toEqual({ removeMicro: 40_000_000, releaseReservedMicro: 0, debtMicro: 60_000_000, debtValuePaise: 4920 });
  });
  it("a reservation is released along with the unspent tokens", () => {
    expect(applyRefund({ grantedMicro: 100 * MICRO, leftMicro: 40 * MICRO, reservedMicro: 25 * MICRO, valuePaisePerToken: 82 }))
      .toEqual({ removeMicro: 40_000_000, releaseReservedMicro: 25_000_000, debtMicro: 60_000_000, debtValuePaise: 4920 });
  });
  it("fully spent: all of it is debt", () => {
    const r = applyRefund({ grantedMicro: 100 * MICRO, leftMicro: 0, reservedMicro: 0, valuePaisePerToken: 100 });
    expect(r.removeMicro).toBe(0);
    expect(r.debtValuePaise).toBe(10_000);
  });
});

describe("display helpers", () => {
  it("formatTokens", () => {
    expect(formatTokens(0)).toBe("0.00");
    expect(formatTokens(100 * MICRO)).toBe("100.00");
    expect(formatTokens(99_999_999)).toBe("100.00");
    expect(formatTokens(1_005_000, 2)).toBe("1.01");
    expect(formatTokens(1_004_999, 2)).toBe("1.00");
    expect(formatTokens(5 * MICRO, 0)).toBe("5");
    expect(formatTokens(-2_500_000)).toBe("-2.50");
  });
  it("formatDuration", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(412)).toBe("6 min 52 s");
    expect(formatDuration(3600)).toBe("60 min");
  });
  it("rejects a zero token value instead of dividing by it", () => {
    expect(() => tokensPerMinuteMicro(R20, 0)).toThrow(RangeError);
    expect(() => microForValue(10, -1)).toThrow(RangeError);
  });
  it("large products stay exact (BigInt)", () => {
    // 1e9 paise/min * 3600 s * 1e6 would pass 2^53 in floats
    expect(cumulativeMicro(1_000_000_000, 3600, 82)).toBe(Number((1_000_000_000n * 3600n * 1_000_000n) / (60n * 82n)));
  });
});

// seeded PRNG so a failure reproduces
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("11.10 #11 property: V = C + H + P exactly", () => {
  it("random rates Rs0-200 and durations 0-3600 s", () => {
    const rnd = mulberry32(20261010);
    for (let i = 0; i < 20_000; i++) {
      const rate = Math.floor(rnd() * 20_001); // paise, 0..Rs200
      const s = Math.floor(rnd() * 3601);
      const sp = callSplit({ ratePaise: rate, billableSeconds: s });
      expect(sp.valuePaise).toBe(sp.callCostPaise + sp.hostPaise + sp.platformPaise);
      expect(sp.valuePaise).toBe(consumedValuePaise(rate, s));
      expect(sp.callCostPaise).toBeLessThanOrEqual(sp.valuePaise);
      expect(sp.hostPaise).toBeGreaterThanOrEqual(0);
      expect(sp.platformPaise).toBeGreaterThanOrEqual(0);
      for (const v of [82, 100]) {
        for (const x of [Number.isInteger(sp.valuePaise) ? sp.valuePaise : 0]) expect(Number.isInteger(microForValue(x, v))).toBe(true);
      }
    }
  });
  it("lot walk always sums to V and never exceeds a lot", () => {
    const rnd = mulberry32(777);
    for (let i = 0; i < 3_000; i++) {
      const rate = 1 + Math.floor(rnd() * 20_000);
      const s = Math.floor(rnd() * 3601);
      const lots: Lot[] = [
        { id: "a", valuePaisePerToken: 82, leftMicro: Math.floor(rnd() * 400) * MICRO + Math.floor(rnd() * MICRO) },
        { id: "b", valuePaisePerToken: 100, leftMicro: Math.floor(rnd() * 400) * MICRO + Math.floor(rnd() * MICRO) },
        { id: "c", valuePaisePerToken: 82, leftMicro: Math.floor(rnd() * 100) * MICRO },
      ];
      const p = planSpend(lots, rate, s);
      expect(p.totalValuePaise).toBe(consumedValuePaise(rate, p.secondsCovered));
      expect(p.uses.reduce((a, u) => a + u.valuePaise, 0)).toBe(p.totalValuePaise);
      for (const u of p.uses) expect(u.micro).toBeLessThanOrEqual(lots.find((l) => l.id === u.lotId)!.leftMicro);
      if (p.shortfall) {
        // one more second must NOT fit
        const total = lots.reduce((a, l) => a + Math.floor((l.leftMicro * l.valuePaisePerToken) / MICRO), 0);
        expect(consumedValuePaise(rate, p.secondsCovered + 1)).toBeGreaterThan(total);
      } else {
        expect(p.secondsCovered).toBe(s);
      }
    }
  });
});

// [HF-TOK-GPV2] Google Play packs Rs 120/240/600/1200 -> 200/400/1000/2000 tokens; 1 token = Rs 0.51 of call value.
describe("gp-v2 pricing", () => {
  const V51 = 51;
  const R10 = 1000;
  it("constants: pays 60 paise a token, worth 51 paise; gp-v1 stays for old lots", () => {
    expect(PRICING_GP_V2).toEqual({ id: "gp-v2", provider: "google_play", purchasePaisePerToken: 60, redemptionPaisePerToken: 51, providerFeeBps: 1500, taxMode: "none_unregistered" });
    expect(PRICING_GP_V1.redemptionPaisePerToken).toBe(82);
    // Rs 120 pack = 200 tokens; 200 x Rs 0.60 = Rs 120; 200 x Rs 0.51 = Rs 102 (what is left after 15% of Rs 120)
    expect(200 * PRICING_GP_V2.purchasePaisePerToken).toBe(12000);
    expect(200 * PRICING_GP_V2.redemptionPaisePerToken).toBe(10200);
    expect([120, 240, 600, 1200].map((rs) => (rs * 100) / PRICING_GP_V2.purchasePaisePerToken)).toEqual([200, 400, 1000, 2000]);
  });
  it("host Rs 10/min costs 10 / 0.51 = 19.607844 tokens a minute (rounded up to the micro, never to 20)", () => {
    expect(tokensPerMinuteMicro(R10, V51)).toBe(19_607_844);
    expect(formatTokens(19_607_844)).toBe("19.61");
  });
  it("a 200-token lot is Rs 102 = 10.2 minutes at Rs 10/min (612 s)", () => {
    const lots: Lot[] = [{ id: "a", valuePaisePerToken: V51, leftMicro: 200 * MICRO }];
    expect(cumulativeMicro(R10, 612, V51)).toBe(200 * MICRO);
    expect(affordableSeconds(lots, R10, 3600)).toBe(612);
    expect(formatDuration(612)).toBe("10 min 12 s");
  });
  it("one minute at Rs 10: call cost Rs 2.00, host Rs 4.80, platform Rs 3.20", () => {
    expect(callSplit({ ratePaise: 1000, billableSeconds: 60 })).toMatchObject({ callCostPaise: 200, hostPaise: 480, platformPaise: 320 });
  });
  it("an old gp-v1 lot is spent first at its own Rs 0.82, then the gp-v2 lot at Rs 0.51", () => {
    const lots: Lot[] = [{ id: "old", valuePaisePerToken: 82, leftMicro: 10 * MICRO }, { id: "new", valuePaisePerToken: V51, leftMicro: 200 * MICRO }];
    const p = planSpend(lots, R10, 120); // Rs 20 of call value: Rs 8.20 from the old lot, the rest from the new one
    expect(p.uses.map((u) => [u.lotId, u.valuePaise])).toEqual([["old", 820], ["new", 1180]]);
  });
});
