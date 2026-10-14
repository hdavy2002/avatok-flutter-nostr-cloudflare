import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({ states: new Map<string, any>(), cdrs: new Map<string, any>(), settle: vi.fn() }));
vi.mock("../lib/telephony_provider", () => ({ getTelephonyProvider: () => ({
  getCallState: async (uuid: string) => structuredClone(providerState.states.get(uuid)),
  hangupCall: async (uuid: string) => { const x = providerState.states.get(uuid); x.status = "completed"; x.endedAt = new Date(20_000).toISOString(); },
}) }));
vi.mock("../lib/hf_vobiz_api", async () => {
  const actual = await vi.importActual<any>("../lib/hf_vobiz_api");
  return { ...actual, getCdr: async (_env: unknown, uuid: string) => structuredClone(providerState.cdrs.get(uuid) ?? null) };
});
vi.mock("../lib/hf_token_calls", () => ({ settleTokenCall: providerState.settle }));
vi.mock("../lib/hf_calls_store", () => ({
  HF_CALL_APP: "avatok", releaseHost: async () => {}, webhookBase: () => "https://example.test",
  hfReserve: async () => ({}), hfRelease: async () => {}, hfConsume: async () => {}, hfEarn: async () => {},
}));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("../lib/hf_reviews", () => ({ onCallCompleted: async () => {} }));

import { HfCallDO } from "./hf_call";
import { makeDb } from "../lib/hf_token_d1_shim";

const callId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const hostLeg = "host-leg-uuid";
const callerLeg = "caller-leg-uuid";
let db: any, object: HfCallDO, storage: any;

function makeCall(connectedAt: number | null, legs = true) {
  const values = new Map<string, unknown>();
  storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm: async () => {}, deleteAlarm: async () => {} };
  object = new HfCallDO({ storage } as any, { DB_META: db } as any);
  const price = { ratePaise: 1000, callCostPaisePerMin: 100, hostShareBps: 5000 };
  db._raw.prepare("INSERT INTO hf_bookings(id,host_uid,customer_uid,starts_at,ends_at,host_timezone,schedule_version,quote_id,idempotency_key,status,duration_min,reserved_paise,expected_host_net_paise,price_snapshot_json,policy_snapshot_json,reservation_snapshot_json,call_id,settlement_status,created_at,updated_at) VALUES(?,?,?,?,?,'UTC',1,?,'key','active',1,1000,500,?,'{}','{}',?,'held',?,?)")
    .run(bookingId, "host", "caller", 1_000, 40_000, "quote", JSON.stringify(price), callId, 1_000, 1_000);
  db._raw.prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at,connected_at,host_leg_uuid,caller_leg_uuid,booking_id,call_cost_paise_per_min,host_share_bps) VALUES(?,?,?,?,'connected',?,?,?,?,?,?,?)")
    .run(callId, "caller", "host", 1000, 1_000, connectedAt, legs ? hostLeg : null, legs ? callerLeg : null, bookingId, 100, 5000);
  providerState.states = new Map([
    [hostLeg, { callUuid: hostLeg, status: "completed", answeredAt: new Date(2_000).toISOString(), endedAt: new Date(19_000).toISOString() }],
    [callerLeg, { callUuid: callerLeg, status: "completed", answeredAt: new Date(3_000).toISOString(), endedAt: new Date(20_000).toISOString() }],
  ]);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(20_000);
  providerState.states = new Map(); providerState.cdrs = new Map(); providerState.settle = vi.fn(async (_env: unknown, input: any) => ({
    billableSeconds: input.connectedSeconds, billedMinutes: input.connectedSeconds > 0 ? 1 : 0, shortfall: false,
    consumedValuePaise: 200, callCostPaise: 10, hostPaise: 100, platformPaise: 90, hostPaidPaise: 100, hostTestPaise: 0, tokensSpentMicro: 2, lots: [],
  }));
  db = makeDb(["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-09-hf-reviews.sql", "2026-10-12-hf-call-presence-owner.sql", "2026-10-13-hf-bookings.sql", "calendar_phase5.sql"], { alters: true });
});

afterEach(() => vi.restoreAllMocks());
async function recover() {
  return object.fetch(new Request("https://hfcall/recover", { method: "POST", body: JSON.stringify({ callId }) }));
}

describe("HfCallDO missing booking state recovery", () => {
  it("settles verified connected time using the earlier terminal provider end", async () => {
    makeCall(8_000);
    expect((await recover()).status).toBe(200);
    expect(providerState.settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ connectedSeconds: 11, booked: true }));
    expect((await db._raw.prepare("SELECT status,settlement_status FROM hf_bookings WHERE id=?").get(bookingId))).toEqual({ status: "completed", settlement_status: "settled" });
    expect((await recover()).status).toBe(200);
    expect(providerState.settle).toHaveBeenCalledTimes(1);
  });

  it("keeps the hold when there is no D1 connect time and provider answer evidence is ambiguous", async () => {
    makeCall(null);
    expect((await recover()).status).toBe(503);
    expect(providerState.settle).not.toHaveBeenCalled();
    expect((await db._raw.prepare("SELECT status,settlement_status FROM hf_bookings WHERE id=?").get(bookingId))).toEqual({ status: "active", settlement_status: "held" });
  });

  it("keeps the hold when either provider leg UUID is missing", async () => {
    makeCall(null, false);
    expect((await recover()).status).toBe(503);
    expect(providerState.settle).not.toHaveBeenCalled();
  });

  it("releases a booking when one terminal leg proves the conference never formed", async () => {
    makeCall(null);
    providerState.states.set(hostLeg, { callUuid: hostLeg, status: "completed", answeredAt: new Date(2_000).toISOString(), endedAt: new Date(19_000).toISOString() });
    providerState.states.set(callerLeg, { callUuid: callerLeg, status: "completed", endedAt: new Date(20_000).toISOString() });
    providerState.cdrs.set(hostLeg, { uuid: hostLeg, answerAt: new Date(2_000).toISOString(), billsec: 17, hangupCause: "NORMAL_CLEARING" });
    providerState.cdrs.set(callerLeg, { uuid: callerLeg, answerAt: null, billsec: 0, hangupCause: "NO_ANSWER" });
    expect((await recover()).status).toBe(200);
    expect(providerState.settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ connectedSeconds: 0, booked: true }));
    expect((await db._raw.prepare("SELECT status,settlement_status FROM hf_bookings WHERE id=?").get(bookingId))).toEqual({ status: "failed", settlement_status: "released" });
  });
});
