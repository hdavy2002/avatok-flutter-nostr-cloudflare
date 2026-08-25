import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Messenger 1:1 billing configuration contract", () => {
  it("declares a dark Messenger-specific master flag", () => {
    const config = read("src/routes/config.ts");
    const remote = read("../app/lib/core/remote_config.dart");
    expect(config).toMatch(/messengerCallBillingEnabled:\s*boolean;/);
    expect(config).toMatch(/messengerCallBillingEnabled:\s*false\s*,/);
    expect(remote).toContain("messengerCallBillingEnabled");
  });

  it("declares every Phase 1 numeric input in PlatformConfig, DEFAULTS and numericKeys", () => {
    const config = read("src/routes/config.ts");
    const numericStart = config.indexOf("const numericKeys");
    const numericEnd = config.indexOf("]);", numericStart);
    expect(numericStart).toBeGreaterThanOrEqual(0);
    const numericKeys = config.slice(numericStart, numericEnd);
    for (const key of [
      "messengerAudioFreeParticipantSecondsDaily",
      "messengerAudioPaidCentitokensPerParticipantMinute",
      "messengerVideoSdCentitokensPerParticipantMinute",
      "messengerVideoHdCentitokensPerParticipantMinute",
      "messengerVideo2kCentitokensPerParticipantMinute",
      "messengerVideo4kCentitokensPerParticipantMinute",
      "messengerCallReservationWallSeconds",
      "messengerCallLowBalanceWarningWallSeconds",
      "messengerCallUsageTickSeconds",
      "messengerCallPriceVersion",
    ]) {
      expect(config, `${key} interface`).toMatch(new RegExp(`${key}:\\s*number;`));
      expect(config, `${key} default`).toMatch(new RegExp(`${key}:\\s*[^,]+,`));
      expect(numericKeys, `${key} numericKeys`).toContain(`"${key}"`);
    }
  });

  it("validates non-negative pricing and a positive price version", () => {
    const config = read("src/routes/config.ts");
    expect(config).toContain("k.startsWith(\"messenger\")");
    expect(config).toContain("messengerCallPriceVersion");
    expect(config).toContain("must be >= 1");
  });

  it("keeps the new gate independent from the legacy monthly human-call flag", () => {
    const config = read("src/routes/config.ts");
    expect(config).toMatch(/messengerCallBillingEnabled/);
    expect(config).toMatch(/humanCallParticipantBillingEnabled/);
    expect(config).toMatch(/legacy monthly human-call|monthly.*per-seat|superseded/i);
  });

  it("requires a frozen numeric price_version and caller-only payer authority", () => {
    const wallet = read("src/routes/wallet.ts");
    const start = wallet.indexOf("export interface MessengerCallUsageConsumeOperation");
    const end = wallet.indexOf("export type MessengerCallWalletOperation", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const operation = wallet.slice(start, end);

    // price_version is part of the operation's immutable authorization
    // snapshot, and is required at the TypeScript wire boundary.
    expect(operation).toMatch(/price_version:\s*number;/);
    expect(operation).not.toMatch(/price_version\?/);

    // WalletDO uid is the payer authority. A caller must not be able to
    // smuggle a second wallet identity into this operation.
    expect(operation).not.toMatch(/payer_uid|callee_uid/);
    const helperStart = wallet.indexOf("export async function consumeMessengerCallUsage");
    const helperEnd = wallet.indexOf("/** Look up an app's commission rate", helperStart);
    const helper = wallet.slice(helperStart, helperEnd);
    expect(helper).toContain("walletOp(env, uid, {");
    expect(helper).toContain("uid,");
    expect(helper).not.toMatch(/payer_uid|callee_uid/);
  });

  it("retains reservations while provider state is uncertain", () => {
    const route = read("src/routes/messenger_call_billing.ts");
    expect(route).toContain("providerConfirmed = true");
    expect(route).toContain("reconciliation_pending");
    expect(route).toContain("if (providerConfirmed && row.reservation_ref)");
    expect(route).toContain("?1='reconciliation_pending' THEN ended_at");
  });
});
