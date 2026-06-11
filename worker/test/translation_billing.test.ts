// Voice-translation billing math (routes/translate.ts).
// $3/hour = 5 AvaCoins/min, metered in 5-min pay-ahead slices, per-minute
// pro-rata true-up on stop. 1 AvaCoin = $0.01.
import { describe, it, expect } from "vitest";
import { slicesDue, fairCoins, RATE_PER_MIN, SLICE_MIN, SLICE_COINS } from "../src/routes/translate";

describe("translation pricing constants", () => {
  it("$3/hour exactly", () => {
    expect(RATE_PER_MIN * 60).toBe(300); // 300 coins = $3.00
  });
  it("one slice = 5 min = 25 coins", () => {
    expect(SLICE_MIN).toBe(5);
    expect(SLICE_COINS).toBe(25);
  });
});

describe("slicesDue (pay-ahead metering)", () => {
  it("pays the first slice at t=0", () => expect(slicesDue(0)).toBe(1));
  it("still 1 slice through minute 4", () => expect(slicesDue(4)).toBe(1));
  it("2nd slice at minute 5", () => expect(slicesDue(5)).toBe(2));
  it("hour mark = 13 slices ahead", () => expect(slicesDue(60)).toBe(13));
  it("never negative", () => expect(slicesDue(-3)).toBe(1));
});

describe("fairCoins (per-minute pro-rata true-up)", () => {
  it("minimum 1 minute", () => expect(fairCoins(1_000)).toBe(5));
  it("rounds up partial minutes", () => expect(fairCoins(61_000)).toBe(10));
  it("exactly one hour = 300 coins = $3", () => expect(fairCoins(3_600_000)).toBe(300));
  it("90 min = 450 coins = $4.50", () => expect(fairCoins(90 * 60_000)).toBe(450));
});

describe("booking prepay (the $60 + 1h example)", () => {
  it("a $60 one-hour consult with translation totals $63", () => {
    const consult = 6000;                 // $60 in coins
    const translation = 60 * RATE_PER_MIN; // 60 min × 5
    expect(consult + translation).toBe(6300); // $63
  });
});
