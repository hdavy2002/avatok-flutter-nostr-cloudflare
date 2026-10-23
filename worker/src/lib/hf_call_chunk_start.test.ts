// @ts-nocheck -- node:sqlite behind the D1 shim
// [HF-CALL-MODES-C] Chunk-mode start gate (spec D2), flag-off sameness, and the money monitor's view of a chunk-billed call.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, getLots, getReservation } from "./hf_token_ledger";
import { prepareTokenStart } from "./hf_token_calls";
import { readHfTokenConfig } from "./hf_token_config";
import { paiseToMicro, chargePaise } from "./hf_token_math";
import { judgeCall } from "./hf_money_rules";
import { factsOf } from "./hf_money_monitor";
import { chunkSettingsFrom } from "./hf_call_start";

const TK = readHfTokenConfig({ hfTokensEnabled: true });
let env: any;
beforeEach(() => { env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-10-hf-calls-token-snapshot.sql"], { alters: true }) }; });
const rup = (rupees: number, op = "L1") => creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(rupees * 100), paidPaise: rupees * 100, provider: "test", providerRef: op }, op);
const reserved = async () => (await getLots(env, "u1")).reduce((t, l) => t + l.reservedMicro, 0);
const CH = { sec: 300, capSec: 18000 };

describe("chunkSettingsFrom", () => {
  it("is null with the flag off (today's behaviour) and 5 min / 5 h with it on", () => {
    expect(chunkSettingsFrom({})).toBeNull();
    expect(chunkSettingsFrom({ hfCallChunkBillingEnabled: false, hfCallChunkMinutes: 5, hfCallMaxMinutes: 300 })).toBeNull();
    expect(chunkSettingsFrom({ hfCallChunkBillingEnabled: true, hfCallChunkMinutes: 5, hfCallMaxMinutes: 300 })).toEqual({ sec: 300, capSec: 18000 });
  });
});

describe("prepareTokenStart with chunk billing", () => {
  it("reserves ONLY chunk 0 (300 s), reports the 5 h cap, and leaves the rest of the wallet free", async () => {
    await rup(500);
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 1000, tk: TK, chunk: CH });
    expect(r.ok).toBe(true);
    expect(r.maxSeconds).toBe(18000); expect(r.secondsCovered).toBe(300); expect(r.limitReason).toBe("balance");
    expect(r.chunk).toEqual({ sec: 300, capSec: 18000, fundedSec: 300 });
    expect(await reserved()).toBe(paiseToMicro(5000));
    expect((await getReservation(env, "c1")).secondsCovered).toBe(300);
  });
  it("the start minimum is max(Rs 20, one chunk): Rs 49 cannot start a Rs 10/min call, Rs 50 can; nothing stays reserved on refusal", async () => {
    await rup(49);
    const no = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 1000, tk: TK, minBalancePaise: 2000, chunk: CH });
    expect(no.ok).toBe(false); expect(no.status).toBe(402); expect(no.extra.minBalancePaise).toBe(5000); expect(no.extra.shortfallPaise).toBe(100);
    expect(await reserved()).toBe(0);
    await rup(1, "L2");
    const yes = await prepareTokenStart(env, { uid: "u1", callId: "c2", ratePaise: 1000, tk: TK, minBalancePaise: 2000, chunk: CH });
    expect(yes.ok).toBe(true);
  });
  it("a cheap call keeps the owner's Rs 20 minimum (one chunk costs less than that)", async () => {
    await rup(15);
    const no = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 100, tk: TK, minBalancePaise: 2000, chunk: CH });
    expect(no.ok).toBe(false); expect(no.extra.minBalancePaise).toBe(2000);
  });
  it("flag off (no chunk option): the whole-call reserve is unchanged - 60 minutes, limit reason by balance", async () => {
    await rup(2000);
    const r = await prepareTokenStart(env, { uid: "u1", callId: "c1", ratePaise: 1000, tk: TK });
    expect(r.ok).toBe(true); expect(r.maxSeconds).toBe(3600); expect(r.limitReason).toBe("time_limit"); expect(r.chunk).toBeUndefined();
    expect(await reserved()).toBe(paiseToMicro(chargePaise(1000, 3600)));
  });
});

describe("money monitor and chunk-billed calls", () => {
  const row = (o = {}) => ({ status: "completed", connected_at: 1_000_000, ended_at: 1_000_000 + 365_000, rate_paise: 1000, consumed_value_paise: 6000, tokens_spent_micro: 1, host_earning_paise: 0, billable_seconds: 360, funded_seconds: 360, ...o });
  it("a call that ran 5 s past what was funded is judged at the funded seconds, not flagged", () => {
    const f = factsOf(row());
    expect(f.fundedSeconds).toBe(360);
    expect(judgeCall(f, { dropChargePaise: 100 }).kind).toBe("ok");
  });
  it("without funded_seconds (an old call) the same numbers behave as before", () => {
    const f = factsOf(row({ funded_seconds: null, billable_seconds: 365 }));
    expect(f.fundedSeconds).toBeNull();
    expect(judgeCall(f, { dropChargePaise: 100 }).kind).toBe("flag"); // charged 6000 vs 365 s = 6083: the old rule still bites
  });
  it("charging MORE than the funded seconds is still flagged", () => {
    expect(judgeCall(factsOf(row({ consumed_value_paise: 6500 })), { dropChargePaise: 100 }).kind).toBe("flag");
  });
});
