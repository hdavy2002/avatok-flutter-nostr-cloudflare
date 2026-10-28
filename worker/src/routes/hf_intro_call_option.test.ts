// @ts-nocheck -- node:sqlite behind the D1 shim, as in the other HF end-to-end tests
// [HF-INTRO-W2] Call option A/B, mainAction, 2-minute queue break and the Women-to-Women Aadhaar-only gate (HF-INTRO-8/9/15/16/18/20). Harness copied from hf_call_modes_e2e.test.ts.
// (original header) The whole call-modes feature in one run with ALL FOUR flags on: host modes (A), the queue (B), chunk billing + the call DO (C) and
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
import { laneGuardSql } from "./hf_bookings";
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

const ALL_ON = { hfCallsEnabled: true, hostsPublicEnabled: true, hfTokensEnabled: true, hfCallModesEnabled: true, hfCallQueueEnabled: true, hfCallChunkBillingEnabled: true, hfBookingLengthsEnabled: true, hfBookingsEnabled: true, hfCallOptionEnabled: true };
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

// ── helpers for this file ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const setOption = (o: string | null) => db.prepare("UPDATE hf_hosts SET call_option=?1 WHERE uid=?2").run(o, HOST);
const optionRoute = (method: string, uid: string | null, body?: unknown) => hfHostModeRoute(req(method, "/api/hosts/me/call-option", uid, body), env, "/api/hosts/me/call-option").then(j);
const callRows = () => db.prepare("SELECT COUNT(*) AS n FROM hf_calls").get().n;
const makeBusy = () => {
  db.prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at,connected_at) VALUES('busy-1','someone',?1,1000,'connected',?2,?2)").run(HOST, Date.now());
  db.prepare("UPDATE hf_hosts SET presence_call_id='busy-1', on_call_since=?1, presence='busy' WHERE uid=?2").run(Date.now(), HOST);
};

describe("call option (flag on)", () => {
  beforeEach(async () => {
    try { db.exec("ALTER TABLE hf_hosts ADD COLUMN call_option TEXT"); } catch { /* W1's migration already added it */ }
    for (const f of [FAN_A, FAN_B, FAN_C]) await fund(f, 500, "F-" + f);
    await hostMode(HOST, { mode: "online" });
  });

  it("option A, Online: no instant call, no queue spot; the refusal says bookings_only + canBook + not canQueue", async () => {
    setOption("A");
    const r = await startCall(FAN_A);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "host_unavailable", reason: "bookings_only", canBook: true, canQueue: false });
    expect(callRows()).toBe(0);
    expect(hostRow().presence_call_id).toBeNull();
    expect(await claimHost(env, HOST, "plain-claim")).toBe(false); // the atomic claim refuses too, whatever route called it
    const q = await joinQueue(FAN_B);
    expect(q.status).toBe(409);
    expect(q.body).toMatchObject({ error: "queue_closed", reason: "bookings_only", canBook: true, canQueue: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_call_queue").get().n).toBe(0);
  });

  it("option A, Online but BUSY on a call: still no queue (instant and queue both refuse)", async () => {
    setOption("A"); makeBusy();
    expect((await startCall(FAN_A)).body).toMatchObject({ reason: "bookings_only", canQueue: false });
    expect((await joinQueue(FAN_B)).body).toMatchObject({ error: "queue_closed", reason: "bookings_only" });
  });

  it("option A, Offline / Bookings-only switch: same answer, bookings stay open", async () => {
    setOption("A");
    for (const mode of ["offline", "bookings_only"]) {
      await hostMode(HOST, { mode });
      expect((await startCall(FAN_A)).body).toMatchObject({ error: "host_unavailable", reason: "bookings_only", canBook: true, canQueue: false });
      expect((await joinQueue(FAN_B)).body).toMatchObject({ reason: "bookings_only" });
    }
    expect(callRows()).toBe(0);
  });

  it("option A: a BOOKED call still takes the line in every state", async () => {
    setOption("A");
    for (const mode of ["online", "bookings_only", "offline"]) {
      await hostMode(HOST, { mode });
      expect(await claimHost(env, HOST, "booked-" + mode, { booked: true })).toBe(true);
      await releaseHost(env, HOST, "booked-" + mode);
    }
  });

  it("option B, Offline: no instant call, no queue, but the refusal keeps bookings open", async () => {
    setOption("B");
    await hostMode(HOST, { mode: "offline" });
    const r = await startCall(FAN_A);
    expect(r.body).toMatchObject({ error: "host_unavailable", reason: "offline", canBook: true, canQueue: false });
    expect(callRows()).toBe(0);
    expect(await claimHost(env, HOST, "plain")).toBe(false);
    expect((await joinQueue(FAN_B)).status).toBe(409);
    expect(await claimHost(env, HOST, "booked", { booked: true })).toBe(true); // a booked call still rings
    await releaseHost(env, HOST, "booked");
    const s = await publicState();
    expect(s).toMatchObject({ callOption: "B", mainAction: "book", canBook: true, canQueue: false });
  });

  it("a legacy host (no option) keeps today's rule: Offline takes no new bookings", async () => {
    setOption(null);
    await hostMode(HOST, { mode: "offline" });
    expect((await startCall(FAN_A)).body).toMatchObject({ reason: "offline", canBook: false });
    expect(await publicState()).toMatchObject({ callOption: null, mainAction: "none", canBook: false });
  });

  it("option B, busy on a call: instant call must queue; the button is queue_or_book", async () => {
    setOption("B"); makeBusy();
    expect(await publicState()).toMatchObject({ callOption: "B", mainAction: "queue_or_book", canQueue: true, canBook: true });
    const r = await startCall(FAN_A);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: "on_call", canQueue: true, canBook: true });
    expect(callRows()).toBe(1); // only the seeded busy call: nothing new started
    expect((await joinQueue(FAN_B)).status).toBe(200);
  });

  it("option B, Online and free: Call now works and the button is 'call'", async () => {
    setOption("B");
    expect(await publicState()).toMatchObject({ callOption: "B", mainAction: "call", callState: "available" });
    const r = await startCall(FAN_A);
    expect(r.status).toBe(200);
    expect(hostRow().presence_call_id).toBe(r.body.callId);
  });

  it("option A public state: bookings_only look, mainAction book", async () => {
    setOption("A");
    expect(await publicState()).toMatchObject({ callOption: "A", mainAction: "book", callState: "appointments", canQueue: false, canBook: true });
  });

  it("flag OFF is inert: an option-A host still takes calls and no new fields appear", async () => {
    setOption("A");
    cfg({ hfCallOptionEnabled: false });
    const s = await publicState();
    expect(s.mainAction).toBeUndefined();
    expect(s.callOption).toBeUndefined();
    expect(s.callState).toBe("available");
    expect((await startCall(FAN_A)).status).toBe(200);
  });

  it("public card, list, search-style spread carry callOption + mainAction", async () => {
    setOption("B");
    const { lineFieldsForUids } = await import("../lib/hf_host_line_view");
    const m = await lineFieldsForUids(env, [HOST]);
    expect(m!.get(HOST)).toMatchObject({ callOption: "B", mainAction: "call" });
    cfg({ hfCallOptionEnabled: false });
    expect((await lineFieldsForUids(env, [HOST]))!.get(HOST)!.mainAction).toBeUndefined();
  });

  it("switch endpoint: host sets A/B, A closes a running queue, validation + flag + auth", async () => {
    expect((await optionRoute("PUT", null, { option: "A" })).status).toBe(401);
    expect((await optionRoute("PUT", FAN_A, { option: "A" })).status).toBe(409); // not a host
    expect((await optionRoute("PUT", HOST, { option: "C" })).status).toBe(400);
    expect((await optionRoute("PUT", HOST, { option: "B" })).body).toMatchObject({ ok: true, callOption: "B", changed: true });
    makeBusy();
    expect((await joinQueue(FAN_B)).status).toBe(200);
    expect((await optionRoute("PUT", HOST, { option: "A" })).body).toMatchObject({ ok: true, callOption: "A", changed: true });
    expect(db.prepare("SELECT status FROM hf_call_queue WHERE fan_uid=?1").get(FAN_B).status).toBe("closed");
    expect((await optionRoute("PUT", HOST, { option: "A" })).body.changed).toBe(false);
    expect((await optionRoute("GET", HOST)).body).toEqual({ ok: true, callOption: "A" });
    expect(events.some((e) => e.event === "hf_host_call_option_changed" && e.to === "A")).toBe(true);
    cfg({ hfCallOptionEnabled: false });
    expect((await optionRoute("PUT", HOST, { option: "B" })).status).toBe(404);
  });

  it("queue break is 2 minutes by default and follows hfQueueBreakSeconds (flag independent)", async () => {
    cfg({ hfCallOptionEnabled: false });
    const { readQueueCfg } = await import("../lib/hf_queue_store");
    expect((await readQueueCfg(env)).breakSec).toBe(120);
    cfg({ hfQueueBreakSeconds: 90 });
    expect((await readQueueCfg(env)).breakSec).toBe(90);
    const { queueNextMsg } = await import("../lib/hf_queue_messages");
    expect(queueNextMsg("Tara", 120)).toContain("in about 2 minutes");
    expect(queueNextMsg("Tara", 60)).toContain("in about 1 minute");
    expect(queueNextMsg("Tara", 10)).toContain("in a few seconds");
  });
});

describe("queue dispatch waits the configured break (120 s)", () => {
  it("the next queued call rings after ~2 minutes, not 1", async () => {
    try { db.exec("ALTER TABLE hf_hosts ADD COLUMN call_option TEXT"); } catch { /* exists */ }
    cfg({ hfCallOptionEnabled: false });
    await fund(FAN_A, 500, "A1"); await fund(FAN_B, 500, "B1");
    await hostMode(HOST, { mode: "online" });
    const a = await startCall(FAN_A);
    await confEnter(a.body.callId, "mh1", "mc1");
    expect((await joinQueue(FAN_B)).status).toBe(200);
    await callerHangs(a.body.callId);
    expect(String(hostRow().presence_call_id)).toMatch(/^q:/);
    await advance(65_000);
    expect(newestCall(FAN_B)?.source ?? null).not.toBe("queue"); // 60 s is no longer enough
    await advance(65_000);
    expect(newestCall(FAN_B)).toMatchObject({ source: "queue", status: "ringing_host" });
    expect(sentTo(FAN_B, /You're next for Tara.*in about 2 minutes/)).toHaveLength(1);
  });
});

describe("Women-to-Women fan rule (hfWomenAadhaarOnlyEnabled)", () => {
  const kyc = (uid: string, gender: string, verified = true) => db.prepare("INSERT OR REPLACE INTO hf_kyc (uid, gender, verified_at, updated_at) VALUES (?1,?2,?3,1)").run(uid, gender, verified ? 5 : null);
  beforeEach(async () => {
    try { db.exec("ALTER TABLE hf_hosts ADD COLUMN call_option TEXT"); } catch { /* exists */ }
    db.prepare("UPDATE hf_hosts SET women_lane=1 WHERE uid=?1").run(HOST);
    for (const f of [FAN_A, FAN_B, FAN_C]) await fund(f, 500, "F-" + f);
    await hostMode(HOST, { mode: "online" });
    cfg({ hfWomenAadhaarOnlyEnabled: true });
  });

  it("not verified -> need aadhaar; verified male -> need female_only; unverified-looking Aadhaar row -> need aadhaar", async () => {
    const a = await startCall(FAN_A);
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ error: "lane_required", lane: "women", need: "aadhaar" });
    kyc(FAN_B, "M");
    expect((await startCall(FAN_B)).body).toMatchObject({ error: "lane_required", lane: "women", need: "female_only" });
    kyc(FAN_C, "F", false);
    expect((await startCall(FAN_C)).body).toMatchObject({ error: "lane_required", need: "aadhaar" });
    expect(callRows()).toBe(0);
  });

  it("verified Female with NO selfie and no lane row may call", async () => {
    kyc(FAN_A, "F");
    const r = await startCall(FAN_A);
    expect(r.status).toBe(200);
    expect(callRow(r.body.callId)).toMatchObject({ lane: "women" });
  });

  it("queue join: same need codes; verified F joins", async () => {
    makeBusy();
    expect((await joinQueue(FAN_A)).body).toMatchObject({ error: "lane_required", lane: "women", need: "aadhaar" });
    kyc(FAN_B, "M");
    expect((await joinQueue(FAN_B)).body).toMatchObject({ error: "lane_required", need: "female_only" });
    kyc(FAN_C, "F");
    expect((await joinQueue(FAN_C)).status).toBe(200);
  });

  it("booking guard (atomic SQL): F verified passes without a selfie; M and unverified fail", async () => {
    kyc(FAN_C, "F"); kyc(FAN_B, "M");
    const ok = (guard: string, cust: string) => Number(db.prepare(`SELECT ${guard} AS ok`).get(cust, HOST).ok);
    const on = laneGuardSql(1, 2, null, true);
    expect(ok(on, FAN_C)).toBe(1);
    expect(ok(on, FAN_B)).toBe(0);
    expect(ok(on, FAN_A)).toBe(0);
    expect(ok(laneGuardSql(1, 2, null, false), FAN_C)).toBe(0); // flag off: the old selfie + lane-row rule still applies
  });

  it("flag OFF: verified F without a selfie is still refused, and the 403 carries no need", async () => {
    cfg({ hfWomenAadhaarOnlyEnabled: false });
    kyc(FAN_A, "F");
    const r = await startCall(FAN_A);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("lane_required");
    expect(r.body.need).toBeUndefined();
    expect(r.body.lane).toBe("women");
  });
});
