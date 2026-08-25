import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION = "migrations/2026-08-24-messenger-call-billing.sql";

function migrationSource(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("Messenger 1:1 billing schema contract", () => {
  it("has durable authorization and append-only usage records", () => {
    const sql = migrationSource();
    expect(sql).toContain("messenger_call_authorizations");
    expect(sql).toContain("messenger_call_usage_ledger");
    for (const column of [
      "authorization_id",
      "call_id",
      "payer_uid",
      "callee_uid",
      "quality_sku",
      "consent_id",
      "price_version",
      "tick_id",
      "participant_seconds",
      "free_participant_seconds",
      "paid_participant_seconds",
    ]) {
      expect(sql, column).toContain(column);
    }
  });

  it("keeps the daily allowance in the payer WalletDO, separate from the D1 audit ledger", () => {
    const wallet = readFileSync("src/do/wallet.ts", "utf8");
    expect(wallet).toContain("messenger_audio_daily_usage");
    expect(wallet).toMatch(/day\s+TEXT\s+PRIMARY KEY|day TEXT PRIMARY KEY/i);
    expect(wallet).toContain("participant_seconds");
    expect(wallet).toContain("messenger_call_credit");
    const start = wallet.indexOf("private async consumeMessengerCallUsage");
    const end = wallet.indexOf("\n  // Earn into a 7-day hold", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const operation = wallet.slice(start, end);
    expect(operation).not.toContain("human_call_usage");
    expect(operation).not.toContain("human_call_credit");
  });

  it("pins call and tick replay keys in the schema", () => {
    const sql = migrationSource();
    expect(sql).toMatch(/authorization_id\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).toMatch(/call_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(sql).toMatch(/tick_id\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).toContain("reconciliation_pending");
  });

  it("stores enough immutable pricing and receipt data to reconcile a call", () => {
    const sql = migrationSource();
    for (const column of [
      "rate_centitokens_per_participant_minute",
      "interval_start_ms",
      "interval_end_ms",
      "tokens_funded",
      "connected_at",
      "ended_at",
      "terminal_reason",
    ]) {
      expect(sql, column).toContain(column);
    }
  });

  it("keeps the WalletDO operation idempotent and denies paid seconds at a balance boundary", () => {
    const wallet = readFileSync("src/do/wallet.ts", "utf8");
    const start = wallet.indexOf("private async consumeMessengerCallUsage");
    const end = wallet.indexOf("\n  // Earn into a 7-day hold", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const operation = wallet.slice(start, end);

    // Replay is checked before dispatch and the operation records its result
    // after the atomic daily/credit mutation.
    const dispatch = wallet.slice(wallet.indexOf("Idempotency at the authority"), start);
    expect(dispatch).toContain("body.op === \"messenger_call_usage_consume\"");
    expect(dispatch).toContain("this.seenOp(body.op_id)");
    expect(operation).toContain("this.recordOp(opId, result)");
    expect(operation).toContain("reservationRef");
    expect(operation).toContain("reservation_required");

    // A tick may consume the free prefix, but paid participant seconds are
    // explicitly denied when the caller cannot fund the overage; no silent
    // free continuation is allowed.
    expect(operation).toContain("tokensDue > 0");
    expect(operation).toContain("disconnect: true");
    expect(operation).toContain("paid_participant_seconds_denied: math.paidParticipantSeconds");
    expect(operation).toContain("math.freeParticipantSeconds");
  });

  it("freezes price version and requires caller-owned reservations for paid ticks", () => {
    const route = readFileSync("src/routes/wallet.ts", "utf8");
    expect(route).toContain("price_version: number");
    expect(route).toContain("reservation_ref?: string");
    expect(route).toContain("reserveMessengerCall");
    expect(route).toContain("messengerCallUsageStatus");
  });

  it("matches the flattened Flutter authorization and full pricing catalog contract", () => {
    const route = readFileSync("src/routes/messenger_call_billing.ts", "utf8");
    for (const field of [
      'payer: "caller"',
      "authorization_expires_at",
      "reserved_tokens",
      "free_participant_seconds_remaining",
      "attempt_id",
      "quality_sku",
      "price_version",
      "pricingCatalog",
      "public_cap",
      "settlement_status",
    ]) expect(route, field).toContain(field);
    expect(route).toContain("server-issued consent_id");
  });
});
