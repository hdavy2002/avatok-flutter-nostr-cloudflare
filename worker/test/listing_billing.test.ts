import { describe, expect, it } from "vitest";
import {
  FREE_LISTING_QUOTA,
  LISTING_FEE_AMOUNT,
  LISTING_FUNDING_POLICY,
  LISTING_PERIOD_MS,
  feeKeyFor,
  freeQuotaAvailable,
  freeReservationActive,
  listingFeeDecision,
  listingWalletOpId,
} from "../src/lib/listing_billing";
import { FEATURE_COSTS } from "../src/feature_pricing";

describe("marketplace listing fee contract", () => {
  const now = 1_700_000_000_000;

  it("keeps the first five listing periods free", () => {
    const q = listingFeeDecision({ feeEnabled: true, freeUsed: 0, period: 1, now });
    expect(q).toMatchObject({
      source: "free",
      amount: 0,
      free_used: 0,
      free_remaining: FREE_LISTING_QUOTA,
      funding_policy: LISTING_FUNDING_POLICY,
      period: 1,
    });
    expect(q.expires_at).toBe(now + LISTING_PERIOD_MS);
  });

  it("prices the sixth period at 100 paid tokens", () => {
    const q = listingFeeDecision({ feeEnabled: true, freeUsed: FREE_LISTING_QUOTA, period: 1, now });
    expect(q).toMatchObject({
      source: "paid",
      amount: LISTING_FEE_AMOUNT,
      free_used: FREE_LISTING_QUOTA,
      free_remaining: 0,
      funding_policy: "paid_only",
    });
    expect(FEATURE_COSTS.listing_post).toBe(100);
    expect(FEATURE_COSTS.listing_post_connect).toBe(100);
  });

  it("does not start charging when the fee flag is off", () => {
    const q = listingFeeDecision({ feeEnabled: false, freeUsed: 99, period: 2, now });
    expect(q.source).toBe("free");
    expect(q.amount).toBe(0);
    expect(q.period).toBe(2);
  });

  it("keeps vertical pricing extensible without changing the price contract", () => {
    expect(feeKeyFor("commerce")).toBe("listing_post");
    expect(feeKeyFor("connect")).toBe("listing_post_connect");
  });

  it("reserves the fifth free slot across concurrent pending operations", () => {
    expect(freeQuotaAvailable(4, 1)).toBe(false);
    expect(freeQuotaAvailable(3, 1)).toBe(true);
    expect(freeQuotaAvailable(0, 5)).toBe(false);
    expect(freeQuotaAvailable(FREE_LISTING_QUOTA, 0)).toBe(false);
  });

  it("reclaims only free reservations whose publish lease expired", () => {
    expect(freeReservationActive(now - 14 * 60_000, now)).toBe(true);
    expect(freeReservationActive(now - 15 * 60_000, now)).toBe(false);
  });

  it("uses one durable wallet operation identity for every retry of a period", () => {
    expect(listingWalletOpId("listing-42", 1)).toBe("listing:listing-42:1");
    expect(listingWalletOpId("listing-42", 1.9)).toBe("listing:listing-42:1");
    expect(listingWalletOpId("listing-42", 2)).not.toBe(listingWalletOpId("listing-42", 1));
  });
});
