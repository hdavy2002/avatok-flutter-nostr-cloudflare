import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DO = readFileSync("src/do/messenger_call_billing.ts", "utf8");

function method(source: string, signature: string, endMarker: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error(`source boundary not found: ${signature}`);
  return source.slice(start, end);
}

describe("Messenger reservation renewal and allowance-boundary guards", () => {
  it("uses remote reservation and warning thresholds, with no healthy-path warning", () => {
    const renewal = method(DO, "private async ensureReservationRunway", "  private async handleRenewalFailure");
    expect(renewal).toContain("readConfig(this.env)");
    expect(renewal).toContain("messengerCallReservationWallSeconds");
    expect(renewal).toContain("messengerCallLowBalanceWarningWallSeconds");

    const healthyStart = renewal.indexOf("if (remainingWallSeconds > warningWallSeconds)");
    const healthyEnd = renewal.indexOf("const updated =", healthyStart);
    expect(healthyStart).toBeGreaterThanOrEqual(0);
    expect(healthyEnd).toBeGreaterThan(healthyStart);
    expect(renewal.slice(healthyStart, healthyEnd)).toContain("low_balance_notified=0");
    expect(renewal.slice(healthyStart, healthyEnd)).not.toContain("notifyBillingState");
  });

  it("renews once per UTC-minute slot and warns only when post-renewal headroom remains low", () => {
    const renewal = method(DO, "private async ensureReservationRunway", "  private async handleRenewalFailure");
    expect(renewal).toContain("last_renewal_slot");
    expect(renewal).toContain("const slot = Math.floor(now / 60_000)");
    expect(renewal).toContain("${row.authorization_id}:renew:${slot}");
    expect(renewal).toContain("const postRenewRemainingWallSeconds");
    expect(renewal).toMatch(/postRenewRemainingWallSeconds\s*<=\s*warningWallSeconds/);
    expect(renewal).toContain('"billing_low_balance"');
  });

  it("tears down on renewal failure and retains reconciliation when provider end is uncertain", () => {
    const failure = method(DO, "private async handleRenewalFailure", "  private async init");
    expect(failure).toContain("billing_renewal_failed");
    expect(failure).toContain("endProviderCall(row.call_id)");
    expect(failure).toContain("markReconciliationPending");
    expect(failure).toContain("provider_end_after_");
    expect(failure).toContain("finalizeInternal");
  });

  it("persists only the accepted free prefix before teardown on a denied paid suffix", () => {
    const meter = method(DO, "private async meterAt", "  private async appendLedger");
    const deniedStart = meter.indexOf("if (wallet.status === 402 && wallet.body?.disconnect === true)");
    const deniedEnd = meter.indexOf("this.sql.exec(\"UPDATE billing_state SET status='funds_exhausted'", deniedStart);
    expect(deniedStart).toBeGreaterThanOrEqual(0);
    expect(deniedEnd).toBeGreaterThan(deniedStart);
    const denied = meter.slice(deniedStart, deniedEnd);
    expect(denied).toContain("persistDeniedFreeTick");
    expect(denied).toContain("partialFreePersisted");
    expect(denied.indexOf("persistDeniedFreeTick")).toBeLessThan(denied.indexOf("endProviderCall"));
    expect(denied).not.toMatch(/paid_participant_seconds\s*[:=][^\n]*denied[^\n]*billing_ticks|UPDATE billing_state[^\n]*paid_participant_seconds[^\n]*denied/);
  });

  it("does not create a second hold when a renewal is retried", () => {
    const renewal = method(DO, "private async ensureReservationRunway", "  private async handleRenewalFailure");
    const slotGuard = renewal.indexOf("if (updated.last_renewal_slot === slot) return { ok: true };");
    const reserve = renewal.indexOf("reserveMessengerCall", slotGuard);
    expect(slotGuard).toBeGreaterThanOrEqual(0);
    expect(reserve).toBeGreaterThan(slotGuard);
    expect(renewal).toContain("last_renewal_slot=?1");
    expect(renewal).toContain("${row.authorization_id}:renew:${slot}");
  });
});
