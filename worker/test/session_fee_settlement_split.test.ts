// [SETTLE-FEE-1] The split frozen at checkout must be the split the creator was shown.
//
// The wizard (app/lib/features/marketplace/native_listing/steps/step_3_money.dart) tells
// a creator "At ₹600/hr, avaTOK takes ₹140 and you keep ₹460", but the policy snapshot
// settlement pays out of was built from the older flat `commercialCreatorFeePct` (80/20),
// i.e. ₹480. These tests pin the new snapshot arithmetic AND the two invariants
// commercial_settlement.ts asserts on top of it (authorityError:
// `creator + platform === gross` and `creator === round(gross * pct / 100)`).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { sessionSplitFor, sessionFeeFor, MIN_PRICE_TOKENS_PER_HOUR } from "../src/lib/session_pricing";

const root = resolve(import.meta.dirname, "..");
const checkout = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const settlement = readFileSync(resolve(root, "src/commercial_settlement.ts"), "utf8");

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};

/** The exact identity commercial_settlement.ts's authorityError() enforces. */
function authorityErrorFor(gross: number, creator: number, platform: number, pct: number): string | null {
  if (creator < 0 || platform < 0 || creator + platform !== gross) return "split snapshot mismatch";
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return "creator percentage invalid";
  if (creator !== Math.round(gross * pct / 100)) return "creator amount does not match percentage";
  return null;
}

/** Verbatim copy of commercial_settlement.ts partialRefundSplit() (it is not importable
 *  without standing up the whole worker module graph); the source-text test below pins
 *  the original so this copy cannot drift silently. */
function partialRefundSplit(gross: number, gstAmount: number, creatorAmount: number, platformAmount: number, refundFraction: number) {
  const fraction = Math.max(0, Math.min(1, refundFraction));
  const refundGross = Math.round(gross * fraction);
  const refundGst = Math.round(gstAmount * fraction);
  const consumedCreatorAmount = creatorAmount - Math.round(creatorAmount * fraction);
  const consumedPlatformAmount = Math.max(0, (gross - refundGross) - consumedCreatorAmount);
  const consumedGstAmount = gstAmount - refundGst;
  return { refundGross, refundGst, refundable: refundGross + refundGst, consumedCreatorAmount, consumedPlatformAmount, consumedGstAmount };
}

describe("sessionSplitFor — the wizard's numbers, frozen into the snapshot", () => {
  it("₹600 / 60-min consult splits ₹140 platform / ₹460 creator (NOT the old 80/20 ₹480)", () => {
    const split = sessionSplitFor(600, 60);
    expect(split).toMatchObject({ grossAmount: 600, platformFeeAmount: 140, creatorAmount: 460 });
    // what the old commercialCreatorFeePct=80 path would have frozen
    expect(Math.round(600 * 80 / 100)).toBe(480);
    // the wizard and the snapshot agree, to the rupee
    expect(sessionFeeFor(600)).toEqual({ fee: 140, creator: 460 });
  });

  it("a 30-min listing still bills the full hour (wizard: 'shorter than an hour still bills the full hour')", () => {
    expect(sessionSplitFor(600, 30)).toMatchObject({ platformFeeAmount: 140, creatorAmount: 460 });
    expect(sessionSplitFor(600, 1)).toMatchObject({ platformFeeAmount: 140, creatorAmount: 460 });
    expect(sessionSplitFor(600, 59)).toMatchObject({ platformFeeAmount: 140, creatorAmount: 460 });
  });

  it("a 2-hour slot bills the flat ₹25 twice (wizard: 'a 2-hour booking bills the flat fee twice')", () => {
    // ₹200/hr: fee 25 + round(175*0.2)=35 → 60/hr → 120 for two hours.
    expect(sessionSplitFor(200, 120)).toMatchObject({ grossAmount: 200, platformFeeAmount: 120, creatorAmount: 80 });
    // 90 minutes floors to one hour, exactly like sessionFeeForHours().
    expect(sessionSplitFor(200, 90)).toMatchObject({ platformFeeAmount: 60, creatorAmount: 140 });
  });

  it("a live ticket splits on the same rule as a consult seat", () => {
    expect(sessionSplitFor(499, 120)).toMatchObject({ grossAmount: 499, platformFeeAmount: 240, creatorAmount: 259 });
    expect(sessionSplitFor(49, 60)).toMatchObject({ platformFeeAmount: 30, creatorAmount: 19 });
  });

  it("a ₹0 (free_entry) order is all zeroes and never negative", () => {
    expect(sessionSplitFor(0, 60)).toEqual({ grossAmount: 0, creatorAmount: 0, platformFeeAmount: 0, creatorFeePct: 0 });
  });

  it("a grandfathered price under the ₹49 floor clamps the fee to gross, never a negative creator leg", () => {
    for (let price = 0; price < MIN_PRICE_TOKENS_PER_HOUR; price++) {
      const split = sessionSplitFor(price, 60);
      expect(split.creatorAmount).toBeGreaterThanOrEqual(0);
      expect(split.platformFeeAmount).toBeGreaterThanOrEqual(0);
      expect(split.creatorAmount + split.platformFeeAmount).toBe(price);
    }
  });
});

describe("settlement invariants hold for every price the split can produce", () => {
  it("creator + platform === gross and creator === round(gross × pct / 100)", () => {
    for (const duration of [1, 30, 45, 60, 90, 120, 240]) {
      for (let price = 0; price <= 5000; price += 7) {
        const s = sessionSplitFor(price, duration);
        expect(authorityErrorFor(price, s.creatorAmount, s.platformFeeAmount, s.creatorFeePct)).toBeNull();
      }
    }
  });

  it("the derived percentage survives a real SQLite round-trip through the INTEGER-affinity column", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE commercial_policy_snapshots (
      policy_snapshot_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE,
      gross_amount INTEGER NOT NULL,
      creator_fee_pct INTEGER NOT NULL CHECK (creator_fee_pct BETWEEN 0 AND 100),
      platform_fee_amount INTEGER NOT NULL, creator_amount INTEGER NOT NULL
    );`);
    const insert = db.prepare("INSERT INTO commercial_policy_snapshots VALUES (?,?,?,?,?,?)");
    const prices = [49, 99, 300, 499, 600, 1001, 4999];
    for (const price of prices) {
      const s = sessionSplitFor(price, 60);
      insert.run(`policy:${price}`, `order:${price}`, s.grossAmount, s.creatorFeePct, s.platformFeeAmount, s.creatorAmount);
    }
    for (const price of prices) {
      const row: any = db.prepare("SELECT * FROM commercial_policy_snapshots WHERE order_id=?").get(`order:${price}`);
      const expected = sessionSplitFor(price, 60);
      expect(Number(row.creator_amount)).toBe(expected.creatorAmount);
      expect(Number(row.creator_fee_pct)).toBe(expected.creatorFeePct);
      expect(authorityErrorFor(
        Number(row.gross_amount), Number(row.creator_amount), Number(row.platform_fee_amount), Number(row.creator_fee_pct),
      )).toBeNull();
    }
    db.close();
  });

  it("partialRefundSplit still sums to gross with the new split", () => {
    for (const price of [49, 300, 600, 999, 4999]) {
      const s = sessionSplitFor(price, 60);
      for (const fraction of [0, 0.01, 0.1, 1 / 3, 0.5, 0.666, 0.99, 1]) {
        const parts = partialRefundSplit(price, 0, s.creatorAmount, s.platformFeeAmount, fraction);
        expect(parts.consumedCreatorAmount).toBeGreaterThanOrEqual(0);
        expect(parts.consumedPlatformAmount).toBeGreaterThanOrEqual(0);
        // the consumed remainder plus what is refunded is exactly the gross the buyer paid
        expect(parts.consumedCreatorAmount + parts.consumedPlatformAmount + parts.refundGross).toBe(price);
        // ...and the clamp in consumedPlatformAmount never had to swallow anything
        expect((price - parts.refundGross) - parts.consumedCreatorAmount).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("checkout wiring (source contract)", () => {
  it("the snapshot insert is fed by sessionSplitFor, behind sessionFeeRuleEnabled", () => {
    expect(checkout).toContain('import { sessionSplitFor } from "../lib/session_pricing"');
    expect(checkout).toContain("const sessionFeeRuleEnabled = (config as unknown as Record<string, unknown>).sessionFeeRuleEnabled !== false;");
    expect(checkout).toContain("const sessionSplit = useSessionFeeRule ? sessionSplitFor(price, listingDurationMin) : null;");
    expect(checkout).toContain("const creatorFeePct = sessionSplit ? sessionSplit.creatorFeePct : configCreatorFeePct;");
    // a ₹0 order never enters the new path
    expect(checkout).toContain("sessionFeeRuleEnabled && price > 0");
    // and the snapshot is still the only thing bound into the insert
    expect(checkout).toContain("creator_fee_pct,settlement_hold_hours,platform_fee_amount,creator_amount,cancellation_policy_json,");
  });

  it("partialRefundSplit in settlement is still the formula copied above", () => {
    expect(settlement).toContain("const consumedCreatorAmount = creatorAmount - Math.round(creatorAmount * fraction);");
    expect(settlement).toContain("const consumedPlatformAmount = Math.max(0, (gross - refundGross) - consumedCreatorAmount);");
    expect(settlement).toContain("if (creator !== Math.round(gross * pct / 100)) return \"creator amount does not match percentage\";");
  });
});
