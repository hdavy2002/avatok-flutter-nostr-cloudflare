// @ts-nocheck -- node:sqlite integration through the existing D1 test adapter.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary, release } from "./hf_token_ledger";
import { prepareTokenStart, settleTokenCall } from "./hf_token_calls";
import { creatorSnapshotFor } from "./hf_creator_pricing";
import { readHfStdPlan, readHfTokenConfig } from "./hf_token_config";
import { correctCallCharge } from "./hf_call_corrections";
import { paiseToMicro } from "./hf_token_math";

let env: any;
const tk = readHfTokenConfig({ hfTokensEnabled: true });
const std = readHfStdPlan({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 2078 });
beforeEach(async () => {
  env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql"], { alters: true }) };
  await creditLot(env, "caller", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(10000), paidPaise: 10000, provider: "google_play", providerRef: "creator-fixture" }, "creator-fixture");
  env.DB_META._raw.prepare("INSERT INTO hf_calls (id,caller_uid,host_uid,rate_paise,status,created_at,ended_at) VALUES ('creator_call','caller','host',2000,'completed',?,?)").run(Date.now(), Date.now());
});
const settle = (creator, seconds = 60) => settleTokenCall(env, { callId: "creator_call", callerUid: "caller", hostUid: "host", ratePaise: 99900,
  callCostPaisePerMin: 999, hostShareBps: 1, connectedSeconds: seconds, maxSeconds: 300, endedAt: Date.now(), creator });

describe("creator frozen reservation, settlement and refund", () => {
  it("reserves the creator price even with Standard enabled and settles the frozen values after edits", async () => {
    const draft = creatorSnapshotFor("influencer", 20);
    const start = await prepareTokenStart(env, { uid: "caller", callId: "creator_call", ratePaise: 1, tk, std, creator: draft });
    expect(start.ok).toBe(true);
    expect(start.maxSeconds).toBe(300);
    draft.ratePaise = 5000;
    const first = await settle(start.snapshot.creator);
    expect(first).toMatchObject({ consumedValuePaise: 2000, hostPaise: 1000, platformPaise: 800, callCostPaise: 200 });
    const second = await settle(start.snapshot.creator);
    expect(second).toEqual(first);
    expect((await balanceSummary(env, "caller")).totalPaise).toBe(8000);
    const refund = await correctCallCharge(env, { callId: "creator_call", adminUid: "admin", note: "Test correction" });
    expect(refund).toMatchObject({ ok: true, correctedPaise: 2000, hostReversedPaise: 1000 });
    const again = await correctCallCharge(env, { callId: "creator_call", adminUid: "admin", note: "Retry" });
    expect(again).toMatchObject({ again: true, correctedPaise: 2000 });
    expect((await balanceSummary(env, "caller")).totalPaise).toBe(10000);
  });
  it("returns the full reservation for an unconnected call and pays nobody", async () => {
    const creator = creatorSnapshotFor("celebrity", 20);
    await prepareTokenStart(env, { uid: "caller", callId: "creator_call", ratePaise: 2000, tk, creator });
    await release(env, "creator_call");
    expect(await settle(creator, 0)).toMatchObject({ billableSeconds: 0, consumedValuePaise: 0, hostPaise: 0 });
    expect((await balanceSummary(env, "caller")).availablePaise).toBe(10000);
  });
});
