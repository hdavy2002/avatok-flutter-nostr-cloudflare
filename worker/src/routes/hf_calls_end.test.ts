// @ts-nocheck -- SQLite + Durable Object storage adapter for endpoint/settlement regression coverage.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ uid: "caller" }));
const phone = vi.hoisted(() => ({ fail: false, failLegs: new Set<string>(), ended: new Set<string>(), hangups: [] as string[] }));
vi.mock("../authz", () => ({ requireUser: async () => auth.uid ? { uid: auth.uid } : { error: "unauthorized", status: 401 }, isFail: (x: any) => !!x.error }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfCallsEnabled: true, hfTokensEnabled: true }) }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("../lib/telephony_provider", () => ({ getTelephonyProvider: () => ({
  hangupCall: async (leg: string) => {
    phone.hangups.push(leg);
    if (phone.fail || phone.failLegs.has(leg)) throw new Error("provider unavailable");
    phone.ended.add(leg);
  },
  getCallState: async (leg: string) => ({ callUuid: leg, status: phone.ended.has(leg) ? "completed" : "in-progress", endedAt: phone.ended.has(leg) ? new Date().toISOString() : null }),
}) }));
vi.mock("../lib/hf_reviews", () => ({ onCallCompleted: async () => {} }));
import { makeDb } from "../lib/hf_token_d1_shim";
import { HfCallDO } from "../do/hf_call";
import { hfCallsRoute } from "./hf_calls";
import { creatorSnapshotFor } from "../lib/hf_creator_pricing";
import { prepareTokenStart } from "../lib/hf_token_calls";
import { creditLot, balanceSummary } from "../lib/hf_token_ledger";
import { readHfTokenConfig } from "../lib/hf_token_config";
import { paiseToMicro } from "../lib/hf_token_math";

let env: any, state: any, stored: Map<string, any>, requests: number;
const id = "creator_call_end";
const endpoint = (suffix = "", method = "POST") => {
  const p = `/api/hf/calls/${id}${suffix}`;
  return hfCallsRoute(new Request(`https://api.test${p}`, { method }), env, p);
};
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 12));
  auth.uid = "caller"; requests = 0; phone.fail = false; phone.failLegs.clear(); phone.ended.clear(); phone.hangups = [];
  env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-09-hf-reviews.sql", "2026-10-12-hf-call-presence-owner.sql"], { alters: true }) };
  await creditLot(env, "caller", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(10000), paidPaise: 10000, provider: "google_play", providerRef: "end-fixture" }, "end-fixture");
  const creator = creatorSnapshotFor("influencer", 20);
  const start = await prepareTokenStart(env, { uid: "caller", callId: id, ratePaise: 2000, tk: readHfTokenConfig({ hfTokensEnabled: true }), creator });
  const now = Date.now();
  env.DB_META._raw.prepare("INSERT INTO hf_hosts(uid,slug,display_name,status,presence,presence_call_id,created_at,updated_at) VALUES ('host','host-aaaa','Host','live','busy',?,?,?)").run(id, now, now);
  env.DB_META._raw.prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at,connected_at,pricing_snapshot) VALUES (?,'caller','host',2000,'connected',?,?,?)").run(id, now - 20000, now - 11000, JSON.stringify(creator));
  stored = new Map([["s", { callId: id, callerUid: "caller", hostUid: "host", status: "connected", createdAt: now - 20000, connectedAt: now - 11000, endedAt: null,
    finalized: false, finalStatus: null, tasks: {}, bill: { attempts: 0 }, hostLeg: null, callerLeg: null,
    tok: { ...start.snapshot, maxSeconds: start.maxSeconds }, maxMinutes: 5, limitReason: "balance" }]]);
  state = { storage: { get: async (key: string) => structuredClone(stored.get(key)), put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); }, setAlarm: async () => {}, deleteAlarm: async () => {} } };
  const object = new HfCallDO(state, env);
  env.HF_CALL = { idFromName: (name: string) => name, get: () => ({ fetch: async (url: string, options: RequestInit) => { requests++; return object.fetch(new Request(url, options)); } }) };
});
afterEach(() => vi.restoreAllMocks());
describe("caller End call", () => {
  it("ends eleven connected seconds, settles once, and permits review", async () => {
    expect((await endpoint("/end")).status).toBe(200);
    const result = await (await endpoint("", "GET")).json();
    expect(result).toMatchObject({ status: "completed", billableSeconds: 11, chargedPaise: 367, canReview: true, plan: "creator" });
    expect((await endpoint("/end")).status).toBe(200);
    expect(requests).toBe(1);
    expect((await balanceSummary(env, "caller")).totalPaise).toBe(9633);
  });
  it("does not expose or end somebody else's call", async () => {
    auth.uid = "stranger";
    expect((await endpoint("/end")).status).toBe(404);
    expect(requests).toBe(0);
  });
  it("does not charge prompt/ringing time without conference connection evidence", async () => {
    stored.get("s").connectedAt = null; stored.get("s").status = "ringing_caller";
    env.DB_META._raw.prepare("UPDATE hf_calls SET connected_at=NULL,status='ringing_caller' WHERE id=?").run(id);
    expect((await endpoint("/end")).status).toBe(200);
    expect(await (await endpoint("", "GET")).json()).toMatchObject({ status: "failed", billableSeconds: 0, chargedPaise: 0, canReview: false });
    expect((await balanceSummary(env, "caller")).totalPaise).toBe(10000);
  });
  it("does not claim completion when provider disconnect fails and retries safely", async () => {
    stored.get("s").hostLeg = "host-leg";
    stored.get("s").callerLeg = "caller-leg";
    phone.fail = true;
    const pending = await endpoint("/end");
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({ error: "end_pending" });
    expect(stored.get("s")).toMatchObject({ status: "ending", finalized: false });

    phone.fail = false;
    expect((await endpoint("/end")).status).toBe(200);
    expect(phone.hangups).toHaveLength(4);
    expect(await (await endpoint("", "GET")).json()).toMatchObject({ status: "completed", billableSeconds: 11 });
  });
  it("persists each disconnected leg and does not retry the successful leg", async () => {
    stored.get("s").hostLeg = "host-leg";
    stored.get("s").callerLeg = "caller-leg";
    phone.failLegs.add("caller-leg");
    expect((await endpoint("/end")).status).toBe(503);
    expect(phone.hangups).toEqual(["host-leg", "caller-leg"]);
    expect(stored.get("s").finishing).toMatchObject({ hostDone: true, callerDone: false });

    phone.failLegs.clear();
    expect((await endpoint("/end")).status).toBe(200);
    expect(phone.hangups).toEqual(["host-leg", "caller-leg", "caller-leg"]);
    expect(await (await endpoint("", "GET")).json()).toMatchObject({ status: "completed", billableSeconds: 11 });
  });
});
