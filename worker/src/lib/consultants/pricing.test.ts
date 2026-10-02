import { describe, it, expect } from "vitest";
import { priceFor, validRate } from "./pricing";
describe("priceFor (owner decision 2026-10-02)", () => {
  it("₹1,000 rate → customer ₹1,180, fee ₹200, consultant ₹800", () => {
    expect(priceFor(1000)).toEqual({ rate: 1000, gst: 180, total: 1180, fee: 200, payout: 800, gst_rate_pct: 18, fee_rate_pct: 20 });
  });
  it("rounds to whole rupees", () => { const p = priceFor(705); expect(p.gst).toBe(127); expect(p.total).toBe(832); expect(p.payout).toBe(564); });
  it("validRate", () => { expect(validRate(500, 300, 3000)).toBe(true); expect(validRate(200, 300, 3000)).toBe(false); expect(validRate(500.5)).toBe(false); });
});
