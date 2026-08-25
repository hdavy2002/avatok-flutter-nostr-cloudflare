import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DO = readFileSync("src/do/messenger_call_billing.ts", "utf8");
const STREAM = readFileSync("src/routes/stream_video_calls.ts", "utf8");

function methodSource(source: string, signature: string, endMarker: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error(`source boundary not found: ${signature}`);
  return source.slice(start, end);
}

describe("Messenger billing DO ordering and recovery guards", () => {
  it("ignores out-of-order same-generation participant events before presence mutation", () => {
    const streamEvent = methodSource(DO, "private async streamEvent", "  private async endProviderCall");
    const participantUpdate = streamEvent.indexOf("UPDATE billing_participants SET present=");
    expect(participantUpdate).toBeGreaterThan(0);

    // A late leave/join from the same Stream session must not overwrite a
    // newer event. generation alone only protects reconnects; the provider's
    // event timestamp is also required for same-generation ordering.
    const orderingGuard = streamEvent.slice(0, participantUpdate);
    expect(orderingGuard).toMatch(/last_event_at_ms[\s\S]{0,160}(?:<=|>=|<|>)\s*occurredAt|occurredAt[\s\S]{0,160}(?:<=|>=|<|>)\s*[^\n]*last_event_at_ms|occurredAt\s*<\s*latestParticipantEvent/);
    expect(orderingGuard).toMatch(/stale_(?:event|timestamp|generation)|out.of.order/i);
  });

  it("cannot resurrect funds-exhausted or finalizing state when a late join arrives", () => {
    const streamEvent = methodSource(DO, "private async streamEvent", "  private async endProviderCall");
    const connectedUpdate = streamEvent.indexOf("UPDATE billing_state SET status='connected'");
    expect(connectedUpdate).toBeGreaterThan(0);
    const transitionEnd = streamEvent.indexOf("\n", connectedUpdate);
    const transition = streamEvent.slice(connectedUpdate, transitionEnd > connectedUpdate ? transitionEnd : connectedUpdate + 500);

    // Participant events can arrive after the wallet has forced teardown or
    // while receipt settlement is in flight. The connected transition must be
    // restricted to authorized/connected, never an unconditional assignment.
    expect(transition).toMatch(/status\s+IN\s*\(['"]authorized['"],\s*['"]connected['"]\)|status\s*!==\s*['"](?:funds_exhausted|finalizing|ended)['"]/);
  });

  it("uses the provider event time for billing order instead of webhook receipt time", () => {
    const forwardingStart = STREAM.indexOf("const billingEvent = await forwardMessengerStreamEventByCall");
    expect(forwardingStart).toBeGreaterThan(0);
    const forwarding = STREAM.slice(Math.max(0, forwardingStart - 500), forwardingStart + 1_500);

    // Webhooks can be delivered out of order. Billing must receive Stream's
    // event/session timestamp (with receipt time only as a fallback), not a
    // fresh Date.now() for every retry.
    expect(forwarding).toMatch(/occurred_at_ms:\s*(?:provider|event)[A-Za-z0-9_.?[\]]*(?:created|occurred|timestamp|at)/i);
    expect(forwarding).not.toMatch(/occurred_at_ms:\s*Date\.now\(\)/);
  });

  it("reconciliation retries pending local ticks before final receipt", () => {
    const finalize = methodSource(DO, "private async finalizeInternal", "  private async reconcile");
    const reconcile = methodSource(DO, "private async reconcile", "  private async markReconciliationPending");
    const combined = `${finalize}\n${reconcile}`;

    // Wallet consumption can succeed just before the DO loses the local tick
    // write or D1 ledger append. A reconcile must drain billing_ticks with
    // ledger_status=pending; skipping meterAt for finalizing state would create
    // a receipt that under-reports an already charged tick.
    expect(combined).toMatch(/SELECT[\s\S]{0,180}billing_ticks[\s\S]{0,180}ledger_status\s*=\s*['"]pending['"]/i);
    expect(combined).toMatch(/billing_ticks[\s\S]{0,240}(?:retry|replay|appendLedger|consumeMessengerCallUsage)/i);
  });

  it("verifies immutable provider and SKU terms on duplicate ledger ticks", () => {
    const ledger = methodSource(DO, "private async appendLedger", "  private async finalizeCall");
    expect(ledger).toContain("provider");
    expect(ledger).toContain("quality_sku");
    expect(ledger).toMatch(/SELECT[\s\S]{0,220}provider[\s\S]{0,220}quality_sku/i);
    expect(ledger).toMatch(/prior\.provider\s*===\s*row\.provider/);
    expect(ledger).toMatch(/prior\.quality_sku\s*===\s*row\.quality_sku/);
  });
});
