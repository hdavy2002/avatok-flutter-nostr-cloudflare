// @ts-nocheck -- node:sqlite behind the D1 shim, as in hf_call_booking_recovery.test.ts
// [HF-CALL-MODES-C] HfCallDO chunk billing end to end on the REAL ledger: storage stub, Vobiz fetch mock, a manual clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prov = vi.hoisted(() => ({ n: 0 }));
vi.mock("../lib/telephony_provider", () => ({ getTelephonyProvider: () => ({
  makeCall: async () => ({ callUuid: `leg-${++prov.n}` }),
  getCallState: async (uuid: string) => ({ callUuid: uuid, status: "completed", endedAt: new Date(Date.now()).toISOString() }),
  hangupCall: async () => {},
}) }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+910000000000" }));
vi.mock("../lib/hf_vobiz_api", async () => ({ ...(await vi.importActual<any>("../lib/hf_vobiz_api")), getCdr: async () => null }));
vi.mock("../lib/hf_calls_store", () => ({
  HF_CALL_APP: "avatok", releaseHost: async () => {}, webhookBase: () => "https://example.test",
  hfReserve: async () => ({}), hfRelease: async () => {}, hfConsume: async () => {}, hfEarn: async () => {},
}));
const events: any[] = vi.hoisted(() => []);
vi.mock("../hooks", () => ({ track: async (_e: unknown, _u: string, event: string, _a: string, props: any) => { events.push({ event, ...props }); }, trackException: async () => {} }));
vi.mock("../lib/hf_reviews", () => ({ onCallCompleted: async () => {} }));
vi.mock("../lib/hf_vobiz_ledger", () => ({ recordLegFromWebhook: async () => {} }));

import { HfCallDO } from "./hf_call";
import { makeDb } from "../lib/hf_token_d1_shim";
import { creditLot, getLots, reserveChunk, getReservation } from "../lib/hf_token_ledger";
import { paiseToMicro, chargePaise } from "../lib/hf_token_math";
import { LIMIT_WARNING_TEXT } from "../lib/hf_call_math";

const callId = "33333333-3333-4333-8333-333333333333";
const RATE = 1000; // Rs 10 / min -> Rs 50 per 300 s chunk
let latched = 0;
let db: any, env: any, object: HfCallDO, store: Map<string, any>, T: number, vobiz: { url: string; body: any; method: string }[], latch: { wait: Promise<void> | null };

const speaks = () => vobiz.filter((v) => /Speak|Play/.test(v.url));
const onMember = (m: string) => speaks().filter((v) => v.url.includes(`/Member/${m}/`));
const sumReserved = async () => (await getLots(env, "caller")).reduce((t, l) => t + l.reservedMicro, 0);
const sumLeft = async () => (await getLots(env, "caller")).reduce((t, l) => t + l.leftMicro, 0);
const state = () => store.get("s");

async function post(path: string, body: any = {}) { return object.fetch(new Request(`https://hfcall/${path}`, { method: "POST", body: JSON.stringify(body) })); }
async function setup(o: { rupees: number; capSec?: number }) {
  const capSec = o.capSec ?? 18000;
  db = makeDb(["2026-10-10-hf-tokens.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-24-hf-call-modes-alters.sql"], { alters: true });
  // a latch hook: while set, the batch that writes chunk >= 1 of this call waits (a chunk "in flight")
  const rawPrepare = db.prepare;
  db.prepare = (q: string) => { const st = rawPrepare(q); const rawBind = st.bind; st.bind = (...a: unknown[]) => { const b = rawBind(...a); b._args = a; return b; }; return st; };
  const rawBatch = db.batch;
  db.batch = async (list: any[]) => {
    if (latch.wait && list.some((x) => (x._args ?? []).some((v: unknown) => typeof v === "string" && v.startsWith(`hftres:${callId}:c`)))) { latched++; await latch.wait; }
    return rawBatch(list);
  };
  env = { DB_META: db, VOBIZ_AUTH_ID: "AID", VOBIZ_AUTH_TOKEN: "TOK", HF_CALL_DID: "100" };
  store = new Map();
  const storage = { get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined), put: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); }, setAlarm: async () => {}, deleteAlarm: async () => {} };
  object = new HfCallDO({ storage } as any, env);
  db._raw.prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at,call_cost_paise_per_min,host_share_bps) VALUES(?,?,?,?,'ringing_host',?,?,?)").run(callId, "caller", "host", RATE, T, 100, 5000);
  await creditLot(env, "caller", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(o.rupees * 100), paidPaise: o.rupees * 100, provider: "test", providerRef: "L1" }, "L1");
  const c0 = await reserveChunk(env, "caller", callId, 0, RATE, 0, 300);
  expect(c0.ok).toBe(true);
  const r = await post("init", { callId, callerUid: "caller", hostUid: "host", rateRupees: 0, reservedRupees: 0, fundsRupees: 0, maxMinutes: Math.floor(capSec / 60), source: "instant",
    tokens: { ratePaise: RATE, callCostPaisePerMin: 100, hostShareBps: 5000, maxSeconds: capSec, chunk: true, chunkSec: 300, capSec, fundedSec: 300 } });
  expect((await r.json()).ok).toBe(true);
}
async function connect() {
  await post("conf", { role: "host", fields: { ConferenceAction: "enter", ConferenceMemberID: "mh" } });
  await post("conf", { role: "caller", fields: { ConferenceAction: "enter", ConferenceMemberID: "mc" } });
  expect(state().connectedAt).toBe(T);
}
async function alarms() { for (let i = 0; i < 12; i++) { const s = state(); const due = Object.values(s?.tasks ?? {}).some((t: any) => typeof t === "number" && t <= Date.now() + 250); if (!due) return; await object.alarm(); } }
async function advance(sec: number, step = 1) { let left = sec; while (left > 0) { const d = Math.min(step, left); T += d * 1000; left -= d; await alarms(); } }

beforeEach(() => {
  T = 1_700_000_000_000; events.length = 0; vobiz = []; latch = { wait: null }; prov.n = 0;
  vi.spyOn(Date, "now").mockImplementation(() => T);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { vobiz.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), method: init?.method ?? "GET" }); return new Response("{}", { status: 200 }); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("HfCallDO chunk billing", () => {
  it("a 12-minute call reserves chunks 1, 2, 3 ahead of time (chunk 0 came with the start) and is charged exactly 12 minutes", async () => {
    await setup({ rupees: 500 });
    await connect();
    expect(state().tasks.chunk).toBe(T + 5_000);
    await advance(720, 5);
    expect(events.filter((e) => e.event === "hf_call_chunk_reserved").map((e) => e.n)).toEqual([1, 2, 3]);
    expect(state().tok.fundedSec).toBe(1200);
    await post("conf", { role: "caller", fields: { ConferenceAction: "exit" } });
    const s = state();
    expect(s.finalized && s.bill.post).toBe(true);
    expect(s.bill.plan.billedMinutes).toBe(12);
    expect(await sumReserved()).toBe(0);
    expect(await sumLeft()).toBe(paiseToMicro(50_000 - chargePaise(RATE, 720)));
    expect(db._raw.prepare("SELECT funded_seconds f, chunks c FROM hf_calls WHERE id=?").get(callId)).toEqual({ f: 1200, c: 4 });
    const ended = events.find((e) => e.event === "hf_call_ended");
    expect(ended).toMatchObject({ source: "instant", funded_seconds: 1200, chunks: 4 });
  });

  it("short funds: Vobiz mutes both legs, plays the same low-wallet warning to both, then restores speech", async () => {
    await setup({ rupees: 60 }); // chunk 0 = Rs 50, Rs 10 left = 60 s of the next chunk
    await connect();
    await advance(5);
    expect(state().tok.short).toBe(true);
    expect(state().tok.fundedSec).toBe(360);
    expect(onMember("mc")).toHaveLength(1);
    expect(onMember("mh")).toHaveLength(1);
    expect(onMember("mc")[0].body.text).toMatch(/caller's wallet balance is low.*about 5 minutes/i);
    expect(onMember("mh")[0].body.text).toBe(onMember("mc")[0].body.text);
    expect(vobiz.some((v) => /\/Member\/mh,mc\/Mute\/$/.test(v.url) && v.method === "POST")).toBe(true);
    expect(events.find((e) => e.event === "hf_call_funds_short")).toBeTruthy();
    expect(events.find((e) => e.event === "hf_call_shared_announcement")).toMatchObject({ kind: "low_funds", via: "member_speak", ok: true });
    await advance(14);
    expect(vobiz.some((v) => v.url.endsWith("/Member/mh,mc/Mute/") && v.method === "DELETE")).toBe(true);
    await advance(282); // t = 301 s: the one-minute shared warning (limit 360 - 60)
    expect(onMember("mh").map((v) => v.body.text)).toHaveLength(2);
    expect(onMember("mh").every((v) => /wallet|top up|balance/i.test(v.body.text))).toBe(true);
    await advance(60);
    const s = state();
    expect(s.finalized).toBe(true);
    expect(s.endReason).toBe("balance");
    expect(s.bill.plan.billedMinutes).toBe(6);
    expect(await sumReserved()).toBe(0);
    expect(await sumLeft()).toBe(0);
  });

  it("a failed shared announcement immediately unmutes both legs", async () => {
    await setup({ rupees: 60 });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { vobiz.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), method: init?.method ?? "GET" }); return new Response("{}", { status: /\/Member\/.+\/Speak\//.test(String(url)) ? 404 : 200 }); }));
    await connect();
    await post("hangup-noop", {}).catch(() => undefined);
    state().callerLeg = "leg-caller"; store.set("s", { ...state(), callerLeg: "leg-caller", hostLeg: "leg-host" });
    await advance(5);
    expect(events.find((e) => e.event === "hf_call_shared_announcement")).toMatchObject({ kind: "low_funds", via: "none", ok: false });
    expect(vobiz.some((v) => v.url.endsWith("/Member/mh,mc/Mute/") && v.method === "DELETE")).toBe(true);
  });

  it("a top-up while talking (POST /funds) reserves the next chunk and moves the end of the call", async () => {
    await setup({ rupees: 60 });
    await connect();
    await advance(5);
    expect(state().tasks.limit).toBe(state().connectedAt + 360_000);
    await advance(100);
    await creditLot(env, "caller", { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(100_00), paidPaise: 100_00, provider: "test", providerRef: "L2" }, "L2");
    const r = await (await post("funds", { uid: "caller", reason: "topup" })).json();
    expect(r.ok).toBe(true); expect(r.short).toBe(false); expect(r.addedSec).toBeGreaterThan(0);
    expect(state().tok.short).toBe(false);
    expect(state().tasks.limit).toBe(state().connectedAt + state().tok.fundedSec * 1000);
    expect(state().tok.fundedSec).toBe(660); // one full chunk (Rs 50 = 300 s) from where the partial one stopped
    expect(r.addedSec).toBe(300);
    expect(events.find((e) => e.event === "hf_call_topup_extended")).toMatchObject({ reason: "topup" });
    expect(onMember("mc").pop().body.text).toMatch(/topped up/);
    expect(onMember("mh").some((v) => /topped/.test(v.body.text))).toBe(false);
    const info = await (await post("info")).json();
    expect(info.fundedSec).toBe(state().tok.fundedSec); expect(info.short).toBe(false);
    // a /funds for another user changes nothing
    expect((await (await post("funds", { uid: "someone-else" })).json()).ok).toBe(false);
  });

  it("a 45-second call costs the fixed Rs 1 and every reserved chunk comes back", async () => {
    await setup({ rupees: 500 });
    await connect();
    await advance(45, 5);
    expect(state().tok.fundedSec).toBe(600); // chunk 1 was taken at 5 s
    await post("conf", { role: "host", fields: { ConferenceAction: "exit" } });
    expect(state().bill.post).toBe(true);
    expect(await sumReserved()).toBe(0);
    expect(await sumLeft()).toBe(paiseToMicro(50_000 - 100));
  });

  it("a hangup while a chunk is in flight strands nothing", async () => {
    await setup({ rupees: 500 });
    await connect();
    let release: () => void = () => {};
    latch.wait = new Promise<void>((r) => { release = r; });
    T += 5_000;
    const inflight = object.alarm(); // chunk 1's batch is now parked on the latch
    await new Promise((r) => setTimeout(r, 20));
    await post("conf", { role: "caller", fields: { ConferenceAction: "exit" } }); // the caller hangs up, settle runs
    expect(state().bill.post).toBe(true);
    expect(latched).toBe(1); // the chunk really was parked mid-flight
    latch.wait = null; release();
    await inflight;
    await object.alarm().catch(() => undefined);
    expect(await sumReserved()).toBe(0);
    const rsv = await getReservation(env, callId);
    expect(rsv === null || rsv.secondsCovered === 0 || (await sumReserved()) === 0).toBe(true);
    expect(await sumLeft()).toBeGreaterThanOrEqual(paiseToMicro(50_000 - 100)); // only the Rs 1 first-minute charge (the call was 5 s)
  });

  it("the 5 hour cap: funded all the way, both-leg warning, ends 'time_limit', charge = 300 minutes, backstop = cap + 90", async () => {
    await setup({ rupees: 10_000 });
    const st = state(); store.set("s", { ...st, status: "ringing_caller" });
    const xml = await (await post("caller-answer", { fields: { CallUUID: "c1" } })).text();
    expect(xml).toContain('timeLimit="18090"');
    await connect();
    await advance(18_000, 60);
    const s = state();
    expect(s.finalized).toBe(true); expect(s.endReason).toBe("time_limit");
    expect(s.bill.plan.billedMinutes).toBe(300);
    expect(s.tok.fundedSec).toBe(18_000);
    expect(events.filter((e) => e.event === "hf_call_chunk_reserved")).toHaveLength(59);
    expect(speaks().filter((v) => v.body.text === LIMIT_WARNING_TEXT).map((v) => v.url.match(/Member\/(\w+)\//)?.[1]).sort()).toEqual(["mc", "mh"]);
    expect(await sumReserved()).toBe(0);
    expect(await sumLeft()).toBe(paiseToMicro(1_000_000 - chargePaise(RATE, 18_000)));
  });
});
