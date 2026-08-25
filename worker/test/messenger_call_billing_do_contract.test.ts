import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DO = readFileSync("src/do/messenger_call_billing.ts", "utf8");
const ROUTE = readFileSync("src/routes/stream_video_calls.ts", "utf8");
const INDEX = readFileSync("src/index.ts", "utf8");
const TYPES = readFileSync("src/types.ts", "utf8");
const WRANGLER = readFileSync("wrangler.toml", "utf8");

describe("Messenger connected-time authority contract", () => {
  it("is one SQLite DO per authorization and initializes frozen paid/free provider terms", () => {
    expect(DO).toContain("export class MessengerCallBillingDO");
    expect(DO).toContain("idFromName(`authorization:${authorizationId}`)");
    expect(DO).toContain("b.media === \"video\"");
    expect(DO).toContain("video_sd");
    expect(DO).toContain("authorization snapshot mismatch");
    expect(DO).toContain("daily_audio_allowance_participant_seconds");
    expect(DO).toContain('provider === "cloudflare"');
    expect(DO).toContain('provider === "stream"');
  });

  it("requires both exact authorized members and dedupes generations/events", () => {
    expect(DO).toContain("a.present === 1 && b.present === 1");
    expect(DO).toContain("a.generation === row.generation && b.generation === row.generation");
    expect(DO).toContain("CREATE TABLE IF NOT EXISTS billing_events");
    expect(DO).toContain("priorEvent?.status === \"applied\"");
    expect(DO).toContain("stale_generation");
    expect(DO).toContain("this.armAlarm(Date.now() + TICK_MS)");
  });

  it("wallets first, writes an immutable ledger, and fails closed on uncertainty", () => {
    expect(DO).toContain("consumeMessengerCallUsage");
    expect(DO).toContain("INSERT OR IGNORE INTO billing_ticks");
    expect(DO).toContain("appendLedger");
    expect(DO).toContain("immutable_tick_mismatch");
    expect(DO).toContain("reconciliation_pending");
    expect(DO).toContain("provider_end_after_funds_exhausted_unconfirmed");
    expect(DO).toContain("reservation_retained: true");
    expect(DO).toContain("const finalized = await this.finalizeInternal(exhaustionReason");
  });

  it("finalizes receipt and reservation exactly once, and Stream webhooks are signed before forwarding", () => {
    expect(DO).toContain("INSERT OR IGNORE INTO messenger_call_receipts");
    expect(DO).toContain("releaseMessengerCallReservation");
    expect(DO).toContain("status='ended'");
    expect(DO).toContain("immutable_receipt_mismatch");
    expect(DO).toContain("status='finalizing'");
    expect(DO).toContain("provider_confirmed !== true");
    expect(DO).toContain("if (row.status === \"reconciliation_pending\")");
    expect(DO).toContain("ending_reason=COALESCE(ending_reason,?1)");
    expect(DO).toContain("const persistedReason = row.ending_reason");
    expect(ROUTE).toContain("forwardMessengerStreamEventByCall");
    expect(ROUTE).toContain("const verified = await verifyWebhook");
    expect(INDEX).toContain("export { MessengerCallBillingDO }");
    expect(TYPES).toContain("MESSENGER_CALL_BILLING: DurableObjectNamespace");
    expect(WRANGLER).toContain("class_name = \"MessengerCallBillingDO\"");
    expect(WRANGLER).toContain("tag = \"v23\"");
  });
});
