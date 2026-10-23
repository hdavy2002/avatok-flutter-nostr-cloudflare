// @ts-nocheck -- node:sqlite behind the D1 shim, as in the other HF end-to-end tests
// [HF-CALL-MODES-INT] The whole call-modes feature in one run with ALL FOUR flags on: host modes (A), the queue (B), chunk billing + the call DO (C) and
// booking lengths (D), plus a flags-OFF regression. REAL: every SQL migration (in-memory SQLite), hfHostModeRoute, hfCallsRoute, hfHostsListRoute, hfQueueRoute,
// startInstantCall / startTokenCall, the token ledger, HfCallDO and HfHostLineDO (behind fake namespaces whose alarms the test fires with fake time).
// MOCKED: config, auth, the telephony provider + Vobiz HTTP (recorded), WhatsApp send/verify, push, telemetry (recorded).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";

vi.mock("../authz", () => ({
  requireUser: vi.fn(async (req: Request) => {
    const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    return t ? { uid: t } : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }),
  isFail: (v: unknown) => v instanceof Response,
}));
vi.mock("../routes/config", () => ({ readConfig: vi.fn() }));
vi.mock("../money", async (orig) => ({ ...(await orig()), rateLimit: vi.fn(async () => null) }));
const events: any[] = vi.hoisted(() => []);
vi.mock("../hooks", async (orig) => ({
  ...(await orig()),
  track: vi.fn(async (_e: unknown, _u: string, event: string, _a: string, props: any) => { events.push({ event, ...props }); }),
  trackException: vi.fn(async () => undefined),
}));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: vi.fn(async (_e: unknown, uid: string) => "+91" + uid) }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: vi.fn(async () => ({ ok: true })) }));
vi.mock("../lib/hf_push", () => ({ sendHfPush: vi.fn(async () => false) }));
vi.mock("../lib/hf_reviews", () => ({ onCallCompleted: async () => {} }));
vi.mock("../lib/hf_vobiz_ledger", () => ({ recordLegFromWebhook: async () => {} }));
vi.mock("../lib/hf_vobiz_api", async () => ({ ...(await vi.importActual<any>("../lib/hf_vobiz_api")), getCdr: async () => null }));
const prov = vi.hoisted(() => ({ n: 0 }));
vi.mock("../lib/telephony_provider", () => ({ getTelephonyProvider: () => ({
  makeCall: async () => ({ callUuid: `leg-${++prov.n}` }),
  getCallState: async (uuid: string) => ({ callUuid: uuid, status: "completed", endedAt: new Date(Date.now()).toISOString() }),
  hangupCall: async () => {},
}) }));

import * as config from "../routes/config";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { HfCallDO } from "../do/hf_call";
import { HfHostLineDO } from "../do/hf_host_line";
import { hfCallsRoute } from "./hf_calls";
import { hfHostModeRoute } from "./hf_host_mode";
import { hfQueueRoute } from "./hf_queue";
import { hfHostsListRoute } from "./hf_hosts_list";
import { claimHost, releaseHost } from "../lib/hf_calls_store";
import { creditLot, getLots } from "../lib/hf_token_ledger";
import { paiseToMicro, chargePaise } from "../lib/hf_token_math";
import { pokeLiveCall } from "../lib/hf_call_funds";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const T0 = Date.parse("2026-10-23T06:00:00Z");
const HOST = "host-1", FAN_A = "fan-a", FAN_B = "fan-b", FAN_C = "fan-c";
const RATE = 1000; // influencer, Rs 10 a minute -> Rs 50 per 5 minute chunk
let env: any, db: any, callObjs: Map<string, any>, lineObjs: Map<string, any>, vobiz: { url: string; body: any }[];

function makeEnv() {
  db = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const text = readFileSync(new URL(f, dir), "utf8").replace(/^\s*--.*$/gm, "");
    for (const stmt of text.split(/;\s*\n/)) { try { if (stmt.trim()) db.exec(stmt); } catch { /* step not needed here */ } }
  }
  const mk = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => mk(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) as any[] }),
    _q: q, _args: args,
  });
  callObjs = new Map(); lineObjs = new Map();
  const e: any = {
    VOBIZ_AUTH_ID: "AID", VOBIZ_AUTH_TOKEN: "TOK", VOBIZ_WEBHOOK_SECRET: "sec", HF_CALL_DID: "100",
    DB_META: {
      prepare: (q: string) => mk(q),
      batch: async (list: any[]) => { const out = []; db.exec("BEGIN"); try { for (const s of list) out.push(await s.run()); db.exec("COMMIT"); } catch (x) { db.exec("ROLLBACK"); throw x; } return out; },
    },
  };
  const ns = (store: Map<string, any>, make: (state: any) => any) => ({
    idFromName: (n: string) => n,
    get: (id: string) => {
      if (!store.has(id)) {
        const values = new Map<string, unknown>();
        const rec: any = { alarm: null, values };
        const storage = {
          get: async (k: string) => (values.has(k) ? structuredClone(values.get(k)) : undefined), put: async (k: string, v: unknown) => { values.set(k, structuredClone(v)); },
          setAlarm: async (t: number) => { rec.alarm = t; }, deleteAlarm: async () => { rec.alarm = null; }, getAlarm: async () => rec.alarm,
        };
        rec.obj = make({ storage });
        store.set(id, rec);
      }
      const rec = store.get(id);
      return { fetch: (url: string, init?: RequestInit) => rec.obj.fetch(new Request(url, init)) };
    },
  });
  e.HF_CALL = ns(callObjs, (st) => new HfCallDO(st, e));
  e.HF_HOST_LINE = ns(lineObjs, (st) => new HfHostLineDO(st, e));
  return e;
}

const ALL_ON = { hfCallsEnabled: true, hostsPublicEnabled: true, hfTokensEnabled: true, hfCallModesEnabled: true, hfCallQueueEnabled: true, hfCallChunkBillingEnabled: true, hfBookingLengthsEnabled: true, hfBookingsEnabled: false };
const cfg = (over = {}) => vi.mocked(config.readConfig).mockResolvedValue({ ...ALL_ON, ...over } as never);
const OFF = { hfCallModesEnabled: false, hfCallQueueEnabled: false, hfCallChunkBillingEnabled: false, hfBookingLengthsEnabled: false };

const sent = () => vi.mocked(sendWhatsAppText).mock.calls.map((c) => ({ to: c[1], text: c[2] as string }));
const sentTo = (uid: string, re: RegExp) => sent().filter((s) => s.to === "+91" + uid && re.test(s.text));
const speaksTo = (member: string) => vobiz.filter((v) => /Speak|Play/.test(v.url) && v.url.includes(`/Member/${member}/`));

function req(method: string, path: string, uid: string | null, body?: unknown) {
  return new Request("https://x.test" + path, { method, headers: { "content-type": "application/json", ...(uid ? { authorization: "Bearer " + uid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const j = async (r: Response | null) => ({ status: r!.status, body: await r!.json() });
const hostMode = (uid: string, body: unknown) => hfHostModeRoute(req("PUT", "/api/hosts/me/presence", uid, body), env, "/api/hosts/me/presence").then(j);
const publicState = async () => (await j(await hfHostsListRoute(req("GET", "/api/hf/hosts/tara-sharma", null), env))).body;
const startCall = (uid: string) => hfCallsRoute(req("POST", "/api/hf/calls", uid, { hostSlug: "tara-sharma" }), env, "/api/hf/calls").then(j);
const joinQueue = (uid: string) => hfQueueRoute(req("POST", "/api/hf/hosts/tara-sharma/queue", uid), env).then(j);
const hostRow = () => db.prepare("SELECT presence, presence_call_id, on_call_since, call_mode, queue_paused FROM hf_hosts WHERE uid=?1").get(HOST);
const callRow = (id: string) => db.prepare("SELECT * FROM hf_calls WHERE id=?1").get(id);
const callState = (id: string) => callObjs.get(id).values.get("s");
const newestCall = (caller: string) => db.prepare("SELECT * FROM hf_calls WHERE caller_uid=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(caller);
const lotsLeft = async (uid: string) => (await getLots(env, uid)).reduce((t, l) => t + l.leftMicro, 0);
const lotsReserved = async (uid: string) => (await getLots(env, uid)).reduce((t, l) => t + l.reservedMicro, 0);

/** Fire every due DO alarm (call tasks + line alarms) on the way, moving fake time in small steps. */
async function advance(ms: number, step = 5000) {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    const next = Math.min(target, Date.now() + step);
    vi.setSystemTime(next);
    for (let i = 0; i < 12; i++) {
      let fired = false;
      for (const rec of callObjs.values()) {
        const s = rec.values.get("s");
        if (s && !s.finalized && Object.values(s.tasks ?? {}).some((t: any) => typeof t === "number" && t <= Date.now() + 250)) { await rec.obj.alarm(); fired = true; }
      }
      for (const rec of lineObjs.values()) if (rec.alarm != null && rec.alarm <= Date.now()) { rec.alarm = null; await rec.obj.alarm(); fired = true; }
      if (!fired) break;
    }
  }
}
const confEnter = async (callId: string, hm: string, cm: string) => {
  const post = (b: any) => env.HF_CALL.get(callId).fetch("https://hfcall/conf", { method: "POST", body: JSON.stringify(b) });
  await post({ role: "host", fields: { ConferenceAction: "enter", ConferenceMemberID: hm } });
  await post({ role: "caller", fields: { ConferenceAction: "enter", ConferenceMemberID: cm } });
};
const callerHangs = (callId: string) => env.HF_CALL.get(callId).fetch("https://hfcall/conf", { method: "POST", body: JSON.stringify({ role: "caller", fields: { ConferenceAction: "exit" } }) });

function seed() {
  const t = T0;
  for (const u of [HOST, FAN_A, FAN_B, FAN_C]) {
    try { db.prepare("INSERT INTO users (uid, display_name, created_at, updated_at) VALUES (?1,?2,?3,?3)").run(u, u === HOST ? "Tara Sharma" : "Fan " + u, t); } catch { /* shape differs */ }
    db.prepare("INSERT OR REPLACE INTO hf_age_confirm(uid,confirmed_at,source) VALUES(?1,?2,'test')").run(u, t);
  }
  db.prepare("INSERT INTO hf_hosts(uid,slug,display_name,status,category,price_per_min,created_at,updated_at) VALUES(?1,'tara-sharma','Tara Sharma','live','influencer',10,?2,?2)").run(HOST, t);
}
const fund = (uid: string, rupees: number, ref: string) => creditLot(env, uid, { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(rupees * 100), paidPaise: rupees * 100, provider: "test", providerRef: ref }, ref);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(T0);
  events.length = 0; vobiz = []; prov.n = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { vobiz.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") }); return new Response("{}", { status: 200 }); }));
  env = makeEnv(); cfg(); seed();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("call modes + queue + chunk billing, all flags ON", () => {
  it("instant call -> refusal + queue -> chunks -> settle -> break -> dispatch -> short whisper -> top-up -> settle -> modes / booked claim / offline closes the queue", async () => {
    await fund(FAN_A, 500, "A1");
    await fund(FAN_B, 60, "B1");

    // 1. The host goes online (mode API) and the public state says available.
    expect((await hostMode(HOST, { mode: "online" })).body).toMatchObject({ ok: true });
    expect(hostRow()).toMatchObject({ presence: "online", call_mode: "online", presence_call_id: null });
    expect((await publicState()).callState ?? (await publicState()).state).toBe("available");

    // 2. Fan A calls: chunk 0 reserved, the line is locked to the call id, the DO has the chunk contract. Not "on call" until both legs joined.
    const a = await startCall(FAN_A);
    expect(a.status).toBe(200);
    const aId = a.body.callId ?? a.body.call?.id;
    expect(aId).toBeTruthy();
    expect(hostRow().presence_call_id).toBe(aId);
    expect(hostRow().on_call_since).toBeNull();
    expect(callRow(aId)).toMatchObject({ source: "instant", funded_seconds: 300, chunks: 1 });
    expect(callState(aId).tok).toMatchObject({ chunk: true, chunkSec: 300, fundedSec: 300 });
    expect(await lotsReserved(FAN_A)).toBe(paiseToMicro(5000));

    // 3. Fan B is refused while the call connects: error unchanged, reason added.
    const b1 = await startCall(FAN_B);
    expect(b1.status).toBe(409);
    expect(b1.body.error).toBe("host_unavailable");
    expect(b1.body.reason).toBe("connecting");

    // 4. Both legs join: on_call_since is set (markOnCall), the public state is on_call and the queue is offered.
    await confEnter(aId, "mh1", "mc1");
    expect(hostRow().on_call_since).toBe(Date.now());
    expect(callRow(aId).connected_at).toBeTruthy();
    const onCall = await startCall(FAN_B);
    expect(onCall.body).toMatchObject({ error: "host_unavailable", reason: "on_call", canQueue: true });

    // 5. Fan B joins the queue: WhatsApp "#1" exactly once. Fairness: a fresh instant caller now has to queue too.
    const joined = await joinQueue(FAN_B);
    expect(joined.status).toBe(200);
    expect(sentTo(FAN_B, /queue, #1/)).toHaveLength(1);
    expect((await startCall(FAN_C)).body).toMatchObject({ error: "host_unavailable", canQueue: true });

    // 6. A talks for 12 minutes: chunks 1, 2, 3 are taken ahead of time; the hangup settles exactly 12 minutes.
    await advance(12 * 60_000);
    expect(events.filter((e) => e.event === "hf_call_chunk_reserved" && e.call_id === aId).map((e) => e.n)).toEqual([1, 2, 3]);
    await callerHangs(aId);
    expect(callState(aId).finalized).toBe(true);
    expect(callState(aId).bill.plan.billedMinutes).toBe(12);
    expect(await lotsReserved(FAN_A)).toBe(0);
    expect(await lotsLeft(FAN_A)).toBe(paiseToMicro(50_000 - chargePaise(RATE, 720)));
    expect(callRow(aId)).toMatchObject({ funded_seconds: 1200, chunks: 4 });

    // 7. The line is free: B is told "you're next", the 60 s break holds the line for the queue (nobody can take it), then B's call is dispatched.
    expect(hostRow()).toMatchObject({ on_call_since: null });
    expect(String(hostRow().presence_call_id)).toMatch(/^q:/);
    expect(sentTo(FAN_B, /You're next for Tara/)).toHaveLength(1);
    expect((await startCall(FAN_C)).body.error).toBe("host_unavailable"); // the break is the queue's, not a free line
    await advance(65_000);
    const bRow = newestCall(FAN_B);
    expect(bRow).toMatchObject({ source: "queue", status: "ringing_host" });
    expect(bRow.queue_entry_id).toBeTruthy();
    expect(hostRow().presence_call_id).toBe(bRow.id); // the q: lock swapped to the call id, never released in between
    expect(db.prepare("SELECT status, call_id FROM hf_call_queue WHERE fan_uid=?1").get(FAN_B)).toMatchObject({ status: "offered", call_id: bRow.id });

    // 8. B connects with Rs 60: chunk 0 = Rs 50, Rs 10 left -> short. The CALLER is whispered the wallet line, the host never.
    await confEnter(bRow.id, "mh2", "mc2");
    await advance(6_000);
    expect(callState(bRow.id).tok.short).toBe(true);
    expect(callState(bRow.id).tok.fundedSec).toBe(360);
    expect(speaksTo("mc2").some((v) => /wallet balance has run out/.test(v.body.text))).toBe(true);
    expect(speaksTo("mh2").some((v) => /wallet|top up|balance/i.test(v.body.text))).toBe(false);
    expect(db.prepare("SELECT status FROM hf_call_queue WHERE fan_uid=?1").get(FAN_B).status).toBe("offered"); // closed out when the call ends

    // 9. B tops up mid-call (the credit path pokes the live call): the end moves out and the caller hears it.
    await advance(60_000);
    await fund(FAN_B, 100, "B2");
    expect(await pokeLiveCall(env, FAN_B)).toBe(true);
    expect(callState(bRow.id).tok.short).toBe(false);
    expect(callState(bRow.id).tok.fundedSec).toBeGreaterThan(360);
    expect(speaksTo("mc2").some((v) => /topped up/.test(v.body.text))).toBe(true);
    expect(speaksTo("mh2").some((v) => /topped/.test(v.body.text))).toBe(false);

    // 10. B hangs up after ~2 minutes: billed 2 minutes, nothing stays reserved, the line goes back to free (the queue is empty).
    await advance(70_000);
    await callerHangs(bRow.id);
    expect(callState(bRow.id).finalized).toBe(true);
    expect(callState(bRow.id).bill.plan.billedMinutes).toBe(2);
    expect(await lotsReserved(FAN_B)).toBe(0);
    expect(db.prepare("SELECT status FROM hf_call_queue WHERE fan_uid=?1").get(FAN_B).status).toBe("done");
    expect(hostRow()).toMatchObject({ presence_call_id: null, on_call_since: null, presence: "online" });
    expect((await publicState()).callState ?? (await publicState()).state).toBe("available");

    // 11. Bookings only: instant calls are refused with reason "appointments", but a BOOKED call can still take the line (claimHost booked), a plain claim cannot.
    expect((await hostMode(HOST, { mode: "bookings_only" })).body).toMatchObject({ ok: true });
    expect(hostRow()).toMatchObject({ presence: "offline", call_mode: "bookings_only" });
    expect((await startCall(FAN_A)).body).toMatchObject({ error: "host_unavailable", reason: "appointments", canQueue: false });
    expect(await claimHost(env, HOST, "plain-claim")).toBe(false);
    expect(await claimHost(env, HOST, "booked-claim", { booked: true })).toBe(true);
    expect(hostRow().presence_call_id).toBe("booked-claim");
    await releaseHost(env, HOST, "booked-claim");
    expect(hostRow().presence_call_id).toBeNull();

    // 12. Back online with a call in progress, a fan queues, then the influencer goes offline: the queue closes with ONE message, nothing is charged.
    await hostMode(HOST, { mode: "online" });
    await fund(FAN_C, 200, "C1");
    db.prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at,connected_at) VALUES('busy-1','someone',?1,1000,'connected',?2,?2)").run(HOST, Date.now());
    db.prepare("UPDATE hf_hosts SET presence_call_id='busy-1', on_call_since=?1, presence='busy' WHERE uid=?2").run(Date.now(), HOST);
    expect((await joinQueue(FAN_C)).status).toBe(200);
    await hostMode(HOST, { mode: "offline" });
    expect(db.prepare("SELECT status FROM hf_call_queue WHERE fan_uid=?1").get(FAN_C).status).toBe("closed");
    await advance(20 * 60_000, 30_000); // the WhatsApp outbox is paced per fan by the line DO: the closing message goes when the gap since her "#1" has passed
    expect(sentTo(FAN_C, /stopped taking calls/)).toHaveLength(1);
    expect(sentTo(FAN_C, /queue/i).filter((s) => !/#1/.test(s.text))).toHaveLength(1);
    expect(await lotsReserved(FAN_C)).toBe(0);
  });
});

describe("flags OFF: the shipped behaviour, byte for byte", () => {
  beforeEach(() => { cfg(OFF); });

  it("legacy presence, no new fields on the refusal, a whole-call reserve and no chunk columns", async () => {
    await fund(FAN_A, 1000, "A1");
    expect((await hostMode(HOST, { online: true })).body).toEqual({ ok: true, presence: "online" });
    const a = await startCall(FAN_A);
    expect(a.status).toBe(200);
    const aId = a.body.callId ?? a.body.call?.id;
    expect(hostRow().presence_call_id).toBe(aId);
    // the whole-call reserve: no chunk contract on the DO, no chunk columns on the row
    expect(callState(aId).tok.chunk).toBeUndefined();
    expect(callRow(aId).chunks ?? null).toBeNull();
    expect(callRow(aId).funded_seconds ?? null).toBeNull();
    expect(await lotsReserved(FAN_A)).toBe(paiseToMicro(60 * RATE)); // 60 minutes up front, as before
    // a second caller gets the old refusal, with no reason / canQueue fields
    await fund(FAN_B, 100, "B1");
    const b = await startCall(FAN_B);
    expect(b.status).toBe(409);
    expect(b.body.error).toBe("host_unavailable");
    expect(b.body.canQueue).toBe(false); // the extra fields are additive; the queue is never offered with the flags off
    expect(b.body.reason).toBe("on_call"); // legacy presence is 'busy' from the claim on
    // the queue endpoint is dark
    const q = await joinQueue(FAN_B);
    expect(q.status).not.toBe(200);
    // the whole reserve comes back minus the minutes talked
    await confEnter(aId, "mh1", "mc1");
    await advance(3 * 60_000);
    await callerHangs(aId);
    expect(callState(aId).bill.plan.billedMinutes).toBe(3);
    expect(await lotsReserved(FAN_A)).toBe(0);
    expect(await lotsLeft(FAN_A)).toBe(paiseToMicro(100_000 - chargePaise(RATE, 180)));
    expect(hostRow().presence_call_id).toBeNull();
  });
});
