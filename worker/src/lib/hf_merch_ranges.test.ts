// [HF-MERCH-CORE-1] One range table: the settings PUT and the reader agree.
import { describe, it, expect } from "vitest";
import { MERCH_CFG_RANGES, readMerchCfg } from "./hf_merch_math";

describe("merch cfg ranges", () => {
  it("the table is the agreed one", () => {
    expect(MERCH_CFG_RANGES).toEqual({
      hfMerchPlatformShareBps: [0, 9000], hfMerchMinMarkupRupees: [0, 5000], hfMerchBaseBufferRupees: [0, 2000],
      hfMerchCashfreeFeeBps: [0, 1000], hfMerchGstBps: [0, 2800],
      hfMerchGstRateBps: [0, 2800], hfMerchPriceCapRupees: [1, 100_000], hfMerchHoldDays: [0, 60],
    });
  });
  it("the reader accepts the edges and rejects one past them (falls back to the default)", () => {
    expect(readMerchCfg({ hfMerchGstBps: 2800 }).gstBps).toBe(2800);
    expect(readMerchCfg({ hfMerchGstBps: 2801 }).gstBps).toBe(1800);
    expect(readMerchCfg({ hfMerchHoldDays: 60 }).holdDays).toBe(60);
    expect(readMerchCfg({ hfMerchHoldDays: 61 }).holdDays).toBe(7);
    expect(readMerchCfg({ hfMerchMinMarkupRupees: 0 }).minMarkupRupees).toBe(0);
    expect(readMerchCfg({ hfMerchPlatformShareBps: 9001 }).platformShareBps).toBe(4000);
    expect(readMerchCfg({ hfMerchBaseBufferRupees: 2000 }).baseBufferRupees).toBe(2000);
    expect(readMerchCfg({ hfMerchCashfreeFeeBps: 1001 }).cashfreeFeeBps).toBe(350);
  });
});
