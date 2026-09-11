// [SETTLE-CHECKIN-1] Contract tests for the creator check-in settlement decision
// (RULEBOOK-PAID-SESSIONS.md §2 C1/C2, Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md WP3).
// Source-text contracts, matching this repo's convention for settlement wiring
// (commercial_lifecycle_contract.test.ts, commercial_hardening_contract.test.ts) —
// the settlement executor is DB-driven end to end, so its cross-module wiring is
// verified this way rather than by standing up a fake D1.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const settlement = readFileSync(resolve(root, "src/commercial_settlement.ts"), "utf8");
const moneyEngine = readFileSync(resolve(root, "src/money_engine.ts"), "utf8");
const rules = readFileSync(resolve(root, "src/rules.ts"), "utf8");
const migration = readFileSync(resolve(root, "migrations/2026-09-11-settle-checkin-receipt-meta.sql"), "utf8");

describe("consult settlement uses the check-in decision, not two-party overlap", () => {
  it("branches consult_1to1 away from deliveryError and onto consultCheckInDecision", () => {
    expect(settlement).toContain("async function consultCheckInDecision(");
    expect(settlement).toContain("if (authority.kind === \"consult_1to1\")");
    expect(settlement).toContain("consultCheckInDecision(env, job.commercial_session_id, authority.booking_id, authority.scheduled_at)");
    // live events still take the two-party overlap path — only the else branch calls it.
    const branch = settlement.slice(settlement.indexOf("if (authority.kind === \"consult_1to1\")"));
    expect(branch.indexOf("consultCheckInDecision")).toBeLessThan(branch.indexOf("await deliveryError("));
  });

  it("checked-in evidence is session_attendance(role='host') OR a creator participant interval, within the flag window", () => {
    expect(settlement).toContain("session_id=?1 AND role='host' AND joined_at<=?2");
    expect(settlement).toContain("m.role='creator' AND i.joined_at<=?2");
    expect(settlement).toContain("async function checkInWindowMs(env: Env)");
    expect(settlement).toContain("cfg.sessionCreatorCheckInMin");
    expect(settlement).toContain("readConfig(env)");
  });

  it("checked in settles full through the existing release path; not checked in refunds + strikes through the existing refund path", () => {
    expect(settlement).toContain("checkIn = { rule: \"creator_checked_in\", checkedInAt: evidence.checkedInAt as number };");
    expect(settlement).toContain("await releaseSnapshot(env, authority);");
    expect(settlement).toContain("await finishSettlement(env, job, authority, checkIn);");
    expect(settlement).toContain("const outcome = await refundCreatorNoShow(env, job, authority);");
    expect(settlement).toContain("await insertNoShowStrike(env, authority.creator_id, job.commercial_session_id);");
    // refundCreatorNoShow reuses the SAME executeCommercialRefund/finalizeCommercialRefund
    // primitives as the live-event no-show branch and the overdue sweep — one refund rail,
    // three call sites (live no-show, refundCreatorNoShow, finalizeOverdueNoShow).
    expect(settlement.match(/executeCommercialRefund\(env, \{/g)?.length).toBe(3);
    expect(settlement.match(/finalizeCommercialRefund\(env, \{/g)?.length).toBe(3);
  });

  it("mirrors the account_strikes insert pattern from money_engine.ts", () => {
    expect(settlement).toContain("INSERT INTO account_strikes");
    expect(settlement).toContain("'marketplace_no_show'");
    expect(settlement).toContain("'commercial_settlement','strike'");
    expect(moneyEngine).toContain("INSERT INTO account_strikes");
    expect(moneyEngine).toContain("'refund_engine','strike'");
  });

  it("loadOverdueNoShowAuthorities uses starts_at + check_in_ms via readConfig, not a hardcoded 15 min", () => {
    expect(settlement).not.toContain("Date.now() - 15 * 60_000");
    expect(settlement).toContain("Date.now() - checkInMs");
    expect(settlement).toContain("const checkInMs = await checkInWindowMs(env);");
  });

  it("receipt gains rule + checked_in_at (nullable, additive migration — not applied)", () => {
    expect(settlement).toContain("rule,checked_in_at)");
    expect(settlement).toContain("(receipt.rule ?? null) !== rule");
    expect(settlement).toContain("(receipt.checked_in_at ?? null) !== checkedInAt");
    expect(migration).toContain("ALTER TABLE commercial_receipts ADD COLUMN rule TEXT;");
    expect(migration).toContain("ALTER TABLE commercial_receipts ADD COLUMN checked_in_at INTEGER;");
  });
});

describe("money_engine.ts delegates commercial consult orders", () => {
  it("never moves money for bookings.kind='consult_1to1' — returns a logged noop instead", () => {
    expect(moneyEngine).toContain("async function isCommercialBooking(env: Env, msg: MoneyMsg)");
    expect(moneyEngine).toContain("bookings WHERE id=?1");
    expect(moneyEngine).toContain("row?.kind === \"consult_1to1\"");
    expect(moneyEngine).toContain("if (await isCommercialBooking(env, msg))");
    expect(moneyEngine).toContain("console.log(`[money_engine] delegation guard:");
    expect(moneyEngine).toContain("commercial_settlement.ts owns this order");
    expect(moneyEngine.indexOf("isCommercialBooking(env, msg)")).toBeLessThan(moneyEngine.indexOf("const ctx = await loadCtx(env, msg.sid, msg.kind);"));
  });
});

describe("rules.ts R2 pays the creator in full on buyer no-show (no pro-rata)", () => {
  it("releases the whole order gross to the creator and settles the order", () => {
    expect(rules).toContain("R2 buyer no-show, creator waited    → creator paid IN FULL, no refund");
    expect(rules).toContain("{ kind: \"release\", orderId: o.id, gross: o.amount, rule: \"R2\", email: \"settlement_paid\" }");
    expect(rules).toContain("{ kind: \"set_status\", orderId: o.id, status: \"settled\" }");
    expect(rules).not.toContain("prorata");
  });
});
