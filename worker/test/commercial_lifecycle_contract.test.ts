import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lifecycle = readFileSync(resolve(root, "src/routes/commercial_lifecycle.ts"), "utf8");
const checkout = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const settlement = readFileSync(resolve(root, "src/commercial_settlement.ts"), "utf8");
const moneyClaim = readFileSync(resolve(root, "src/commercial_money_claim.ts"), "utf8");
const listings = readFileSync(resolve(root, "src/routes/listings.ts"), "utf8");
const router = readFileSync(resolve(root, "src/index.ts"), "utf8");
const migration = readFileSync(resolve(root, "migrations/2026-08-25-commercial-lifecycle.sql"), "utf8");

describe("commercial money lifecycle contracts", () => {
  it("is snapshot-driven and fails closed when the policy has no exact decision", () => {
    expect(lifecycle).toContain("cancellation_policy_json");
    expect(lifecycle).toContain("creator_cancel_refund_pct");
    expect(lifecycle).toContain("provider_failure_refund_pct");
    expect(lifecycle).toContain("late_cancel_policy_missing");
    expect(lifecycle).toContain("review_pending");
    expect(lifecycle).not.toContain("rules.ts");
  });

  it("refunds from escrow exactly once and writes immutable refund authority", () => {
    expect(lifecycle).toContain("commercial:refund:");
    expect(lifecycle).not.toContain("commercial:refund:${authority.order_id}:${action}");
    expect(lifecycle).toContain("commercial_lifecycle_operations");
    expect(lifecycle).toContain("INSERT OR IGNORE INTO commercial_refund_receipts");
    expect(lifecycle).toContain("refund_receipt_immutable_mismatch");
    expect(lifecycle).toContain("UPDATE orders SET status='refunded'");
    expect(lifecycle).toContain("UPDATE commercial_entitlements SET state='refunded'");
    expect(lifecycle).toContain("UPDATE commercial_settlement_jobs SET state='refunded'");
    expect(migration).toContain("commercial_refund_receipts");
    expect(migration).toContain("UNIQUE");
    expect(migration).toContain("idx_commercial_cancel_order_claim");
    expect(settlement).toContain("NOT EXISTS");
    expect(settlement).toContain("commercial_refund_receipts");
  });

  it("serializes settlement versus refund before crossing into WalletDO", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS commercial_money_claims");
    expect(migration).toContain("order_id    TEXT PRIMARY KEY");
    expect(migration).toContain("claim_type  TEXT NOT NULL CHECK (claim_type IN ('settlement','refund'))");
    expect(moneyClaim).toContain("INSERT OR IGNORE INTO commercial_money_claims");
    expect(moneyClaim).toContain("claim_type === args.claimType && existing.claim_id === args.claimId");
    expect(settlement).toContain("claimCommercialMoney");
    expect(lifecycle).toContain("claimCommercialMoney");
    expect(settlement.indexOf("const claim = await claimCommercialMoney")).toBeLessThan(settlement.indexOf("await releaseSnapshot"));
    expect(lifecycle.indexOf("const claim = await claimCommercialMoney")).toBeLessThan(lifecycle.indexOf("const money = await refund"));
    expect(settlement).toContain("commercial money claim owned by");
    expect(lifecycle).toContain("commercial money claim owned by");
    expect(settlement).toContain("completeCommercialMoneyClaim");
    expect(lifecycle).toContain("completeCommercialMoneyClaim");
  });

  it("blocks the legacy booking endpoint only for enabled commercial service lanes", () => {
    expect(listings).toContain("commercialBookingLaneOn");
    expect(listings).toContain("commercialLiveListingsEnabled");
    expect(listings).toContain("commercialConsultListingsEnabled");
    expect(listings).toContain("commercial_checkout_required");
    expect(listings).toContain("commercial configuration unavailable");
    expect(listings.indexOf("commercialBookingLaneOn")).toBeLessThan(listings.indexOf("claimBlock(env, { userId: ctx.uid"));
  });

  it("distinguishes buyer/creator/provider outcomes and supports live cancellation", () => {
    expect(lifecycle).toContain("buyer_cancel");
    expect(lifecycle).toContain("creator_cancel");
    expect(lifecycle).toContain("creator_no_show");
    expect(lifecycle).toContain("provider_outage");
    expect(lifecycle).toContain("insufficient_delivery_evidence");
    expect(lifecycle).toContain("kind='live_event'");
    expect(lifecycle).toContain("o.buyer_id=?2 OR o.creator_id=?2");
    expect(lifecycle).toContain("for (const authority of authorities)");
    expect(router).toContain("commercialLifecycle");
    expect(router).toContain("cancel|reschedule|calendar");
    expect(lifecycle).toContain('authority.creator_id === auth.uid ? "creator_cancel" : "buyer_cancel"');
    expect(lifecycle).not.toContain("body.reason");
  });

  it("uses idempotent reschedule authority and moves the commercial calendar atomically", () => {
    expect(lifecycle).toContain("reschedule_allowed");
    expect(lifecycle).toContain("commercial-reschedule:");
    expect(lifecycle).toContain("UPDATE commercial_entitlements SET starts_at");
    expect(lifecycle).toContain("UPDATE commercial_sessions SET scheduled_at");
    expect(lifecycle).toContain("starts_at=?6 AND ends_at=?7");
    expect(lifecycle).toContain("reschedule lost a concurrent schedule claim");
    expect(lifecycle).toContain("allNew");
    expect(lifecycle).toContain("UPDATE calendar_blocks SET starts_at");
    expect(lifecycle).toContain("UPDATE calendar_events SET start_at");
    expect(lifecycle).toContain("calendar conflict");
  });

  it("claims creator and buyer calendar authority before a consult hold", () => {
    expect(checkout).toContain("claimCommercialBlock");
    expect(checkout).toContain("commercial:${bookingId}:${participant.role}");
    expect(checkout).toContain("releaseBlocks(env, \"avaconsult\"");
    expect(checkout).toContain("INSERT OR IGNORE INTO calendar_events");
    expect(checkout).toContain("notifyUser");
  });

  it("adds only owned entitlements to calendar and never mints provider access", () => {
    expect(lifecycle).toContain('import { claimBlock, releaseBlocks } from "../cal/engine"');
    expect(lifecycle).toContain("addToCalendar");
    expect(lifecycle).toContain("commercial-calendar:");
    expect(lifecycle).toContain("\"avacommercial\"");
    expect(lifecycle).toContain("conflictWith");
    expect(lifecycle).not.toContain("token");
    expect(lifecycle).not.toContain("api_key");
  });
});
