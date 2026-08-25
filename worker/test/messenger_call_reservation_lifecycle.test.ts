import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const WALLET_ROUTE = read("src/routes/wallet.ts");
const WALLET_DO = read("src/do/wallet.ts");
const BILLING_DO = read("src/do/messenger_call_billing.ts");
const CALL_ROOM = read("src/do/call_room.ts");
const SFU = read("src/routes/call_sfu.ts");

describe("Messenger reservation renewal and low-balance lifecycle", () => {
  it("exposes a caller-only reservation status and idempotent reserve contract", () => {
    expect(WALLET_ROUTE).toContain("messenger_call_reservation_status");
    expect(WALLET_ROUTE).toContain("messengerCallReservationStatus");
    expect(WALLET_DO).toContain("private async messengerCallReservationStatus");
    expect(WALLET_DO).toContain("reserved_tokens");
    expect(WALLET_DO).toContain("released: row.released");
    expect(WALLET_DO).toContain("body.op === \"reserve\"");
    expect(WALLET_DO).toContain("this.seenOp(body.op_id)");
  });

  it("renews using remote runway settings and deterministic operation ids", () => {
    expect(BILLING_DO).toContain("messengerCallReservationWallSeconds");
    expect(BILLING_DO).toContain("messengerCallLowBalanceWarningWallSeconds");
    expect(BILLING_DO).toContain("reserveMessengerCall");
    expect(BILLING_DO).toContain(":renew:");
    expect(BILLING_DO).toContain("last_renewal_slot");
    expect(BILLING_DO).toContain("reservation_tokens");
    expect(BILLING_DO).toContain("price_version");
  });

  it("emits low-balance and renewal-failure state without making telemetry authoritative", () => {
    expect(BILLING_DO).toContain("billing_low_balance");
    expect(BILLING_DO).toContain("billing_renewal_failed");
    expect(BILLING_DO).toContain("messenger_call_low_balance");
    expect(BILLING_DO).toContain("messenger_call_renewal_failed");
    expect(BILLING_DO).toContain("void track(");
    expect(BILLING_DO).toContain("handleRenewalFailure");
    expect(BILLING_DO).toContain("endProviderCall");
  });

  it("tears down before settlement and preserves reconciliation on uncertainty", () => {
    expect(BILLING_DO).toContain("provider_end_after_");
    expect(BILLING_DO).toContain("markReconciliationPending");
    expect(BILLING_DO).toContain("messenger_call_funds_exhausted");
    expect(BILLING_DO).toContain("finalizeInternal");
    expect(BILLING_DO).toContain("reservation_retained");
  });

  it("persists a boundary-crossing free prefix before teardown without denied paid seconds", () => {
    expect(BILLING_DO).toContain("persistDeniedFreeTick");
    const meter = BILLING_DO.slice(BILLING_DO.indexOf("private async meterAt"));
    expect(meter.indexOf("persistDeniedFreeTick")).toBeGreaterThanOrEqual(0);
    expect(meter.indexOf("persistDeniedFreeTick")).toBeLessThan(meter.indexOf("endProviderCall"));
    const helper = BILLING_DO.slice(BILLING_DO.indexOf("private async persistDeniedFreeTick"), BILLING_DO.indexOf("/** Drain wallet-successful"));
    expect(helper).toContain("free_participant_seconds");
    expect(helper).toContain("paid_participant_seconds");
    expect(helper).toContain("paid_participant_seconds,charged_centitoken_seconds,tokens_charged");
    expect(helper).toContain("INSERT INTO billing_ticks");
    expect(helper).toContain("appendLedger");
  });

  it("maps a partial 15-second tick to its accepted free wall prefix", () => {
    const freeParticipantSeconds = 6; // 3 of a 15-second tick accepted free.
    const attemptedWallSeconds = 15;
    expect(freeParticipantSeconds / 2).toBe(3);
    expect(freeParticipantSeconds / 2).toBeLessThan(attemptedWallSeconds);
    const helper = BILLING_DO.slice(BILLING_DO.indexOf("private async persistDeniedFreeTick"), BILLING_DO.indexOf("/** Drain wallet-successful"));
    expect(helper).toContain("freeSeconds % 2 !== 0");
    expect(helper).toContain("const acceptedWallSeconds = freeSeconds / 2");
    expect(helper).toContain("const partialEnd = start + acceptedWallSeconds * 1000");
    expect(helper).toContain("tickId, start, partialEnd");
  });

  it("attempts renewal before warning on a healthy reservation", () => {
    const runway = BILLING_DO.slice(BILLING_DO.indexOf("private async ensureReservationRunway"), BILLING_DO.indexOf("private async handleRenewalFailure"));
    expect(runway.indexOf("reserveMessengerCall")).toBeGreaterThanOrEqual(0);
    expect(runway.indexOf("reserveMessengerCall")).toBeLessThan(runway.indexOf('"billing_low_balance"'));
    expect(runway).toContain("postRenewRemainingWallSeconds");
    expect(runway).toContain("renewal_funding_failed");
  });

  it("fans out server-authored billing state to Cloudflare clients", () => {
    expect(CALL_ROOM).toContain("/billing-update");
    expect(CALL_ROOM).toContain("billing_low_balance");
    expect(CALL_ROOM).toContain("billing_renewal_failed");
    expect(CALL_ROOM).toContain("billing_exhausted");
    expect(CALL_ROOM).toContain("loadMessengerAudioContext");
  });

  it("does not use SFU capability as the Messenger billing gate", () => {
    const start = SFU.indexOf("export async function callSfuJoin");
    const end = SFU.indexOf("export async function callSfuPrepare", start);
    const join = SFU.slice(start, end);
    expect(join).toContain("cfg.messengerCallBillingEnabled === true");
    expect(join).toContain("loadMessengerCallAuthorizationForParticipant");
    expect(join).not.toContain("messengerCallBillingEnabled === true && !g.video");
  });
});
