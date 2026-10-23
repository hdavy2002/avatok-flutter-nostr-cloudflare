// @ts-nocheck -- uses node:sqlite (the D1 shim), which the worker tsconfig has no types for
// [HF-CALL-MODES-A] Host call mode + derived presence + line lock, against the REAL handlers and REAL SQL (every migration applied to in-memory SQLite).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";

const st = vi.hoisted(() => ({ cfg: {} as Record<string, unknown>, closed: [] as string[], notified: [] as string[] }));
vi.mock("../authz", () => ({
  requireUser: vi.fn(async (req: Request) => {
    const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    return t ? { uid: t } : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }),
  isFail: (v: unknown) => v instanceof Response,
}));
vi.mock("./config", () => ({ readConfig: vi.fn(async () => st.cfg) }));
vi.mock("../hooks", async (orig) => ({ ...(await orig()), track: vi.fn(async () => undefined), trackUser: vi.fn(async () => undefined), trackException: vi.fn(async () => undefined) }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: vi.fn(async () => "+919876543210") }));
vi.mock("../lib/hf_notify", async (orig) => ({ ...(await orig()), notifyHostOnline: async (_e: any, _c: any, uid: string) => { st.notified.push(uid); } }));
vi.mock("../lib/hf_queue_store", () => ({
  closeQueue: vi.fn(async (_e: any, uid: string) => { st.closed.push(uid); return 0; }),
  notifyLineFree: vi.fn(async () => undefined),
  queueGate: vi.fn(async () => ({ waiting: 0, paused: false, open: false })),
}));

import { hfHostModeRoute } from "./hf_host_mode";
import { claimHost, releaseHost, markOnCall, claimHostFromQueue, lockHostForQueue, runHfCallsCron } from "../lib/hf_calls_store";
import { forceHostOffline } from "../lib/hf_exit";
import { hfHostsPublicRoute } from "./hf_hosts_public";
import { hfHostsListRoute } from "./hf_hosts_list";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const text = readFileSync(new URL(f, dir), "utf8").replace(/^\s*--.*$/gm, "");
    for (const stmt of text.split(/;\s*\n/)) { try { if (stmt.trim()) db.exec(stmt); } catch { /* migration step not needed here */ } }
  }
  const mk = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => mk(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) as any[] }),
    _q: q, _a: args,
  });
  return { DB_META: { prepare: (q: string) => mk(q), _raw: db }, HF_CALL: { get: () => ({ fetch: async () => new Response("{}") }), idFromName: (n: string) => n } } as any;
}

const H = "host-1";
let env: any;
const raw = () => env.DB_META._raw;
const row = () => raw().prepare("SELECT presence, call_mode, on_call_since, presence_call_id, queue_paused FROM hf_hosts WHERE uid=?1").get(H);
const ON = { hfCallsEnabled: true, hfReelsEnabled: true, hostsPublicEnabled: true, hfCallModesEnabled: true };
const req = (method: string, path: string, body?: unknown) => new Request("https://x.test" + path, { method, headers: { authorization: "Bearer " + H, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function put(body: unknown) { const r = await hfHostModeRoute(req("PUT", "/api/hosts/me/presence", body), env, "/api/hosts/me/presence"); return { status: r.status, body: await r.json() }; }
async function get() { const r = await hfHostModeRoute(req("GET", "/api/hosts/me/presence"), env, "/api/hosts/me/presence"); return { status: r.status, body: await r.json() }; }

beforeEach(() => {
  st.cfg = { ...ON }; st.closed = []; st.notified = [];
  env = makeEnv();
  raw().prepare("INSERT INTO hf_hosts(uid,slug,display_name,status,category,price_per_min,presence,created_at,updated_at) VALUES(?1,'tara-sharma','Tara Sharma','live','influencer',20,'online',1,1)").run(H);
});

describe("PUT /api/hosts/me/presence (flag ON)", () => {
  it("legacy {online:false} -> bookings_only, {online:true} -> online (D6); presence is derived in the same statement", async () => {
    let r = await put({ online: false });
    expect(r.body).toMatchObject({ ok: true, presence: "offline", mode: "bookings_only", onCall: false, queue: { waiting: 0, paused: false, open: false } });
    expect(row()).toMatchObject({ call_mode: "bookings_only", presence: "offline" });
    r = await put({ online: true });
    expect(r.body).toMatchObject({ presence: "online", mode: "online" });
    expect(row()).toMatchObject({ call_mode: "online", presence: "online" });
  });
  it("{mode} drives the three-way switch and rejects junk", async () => {
    expect((await put({ mode: "offline" })).body).toMatchObject({ mode: "offline", presence: "offline" });
    expect(row().call_mode).toBe("offline");
    expect((await put({ mode: "sideways" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });
  it("a mode change while on a joined call keeps presence busy; the lock release re-derives it from the mode", async () => {
    expect(await claimHost(env, H, "c1")).toBe(true);
    await markOnCall(env, H, "c1");
    expect((await put({ mode: "bookings_only" })).body).toMatchObject({ presence: "busy", mode: "bookings_only", onCall: true });
    await releaseHost(env, H, "c1");
    expect(row()).toMatchObject({ presence: "offline", on_call_since: null, presence_call_id: null });
  });
  it("leaving Online closes the queue; going Online calls notifyHostOnline; staying put does neither", async () => {
    await put({ mode: "bookings_only" });
    expect(st.closed).toEqual([H]);
    await put({ mode: "bookings_only" });
    expect(st.closed).toEqual([H]);
    await put({ mode: "online" });
    expect(st.notified).toEqual([H]);
  });
  it("Offline warns how many booked calls will still ring (D1)", async () => {
    const d = raw();
    const ins = d.prepare(`INSERT INTO hf_bookings(id,host_uid,customer_uid,starts_at,ends_at,host_timezone,schedule_version,quote_id,idempotency_key,status,duration_min,reserved_paise,expected_host_net_paise,price_snapshot_json,policy_snapshot_json,reservation_snapshot_json,created_at,updated_at)
      VALUES(?1,?2,'fan',?3,?4,'Asia/Kolkata',1,?1,?1,?5,15,100,100,'{}','{}','{}',1,1)`);
    ins.run("b1", H, Date.now() + 3600_000, Date.now() + 4500_000, "confirmed");
    ins.run("b2", H, Date.now() + 7200_000, Date.now() + 8100_000, "confirmed");
    ins.run("b3", H, Date.now() + 9200_000, Date.now() + 9900_000, "cancelled");
    expect((await put({ mode: "offline" })).body.bookedCalls).toBe(2);
    expect((await get()).body).toMatchObject({ mode: "offline", bookedCalls: 2 });
  });
  it("not a live host -> 409; closing account asks for nothing new", async () => {
    raw().prepare("UPDATE hf_hosts SET status='draft'").run();
    expect((await put({ mode: "online" })).status).toBe(409);
  });
});

describe("flag OFF keeps today's contract", () => {
  beforeEach(() => { st.cfg = { hfCallsEnabled: true }; });
  it("PUT returns exactly {ok, presence}; GET {ok, presence, nudgesPaused}; call_mode is kept in step", async () => {
    let r = await put({ online: false });
    expect(r.body).toEqual({ ok: true, presence: "offline" });
    expect(row()).toMatchObject({ presence: "offline", call_mode: "bookings_only" });
    r = await put({ online: true });
    expect(r.body).toEqual({ ok: true, presence: "online" });
    expect(row().call_mode).toBe("online");
    expect((await get()).body).toEqual({ ok: true, presence: "online", nudgesPaused: false });
    expect((await put({ mode: "offline" })).status).toBe(400); // {mode} is not accepted until the flag is on
  });
  it("claimHost / releaseHost are the legacy statements (busy at claim; Offline host cannot be claimed)", async () => {
    expect(await claimHost(env, H, "c1")).toBe(true);
    expect(row()).toMatchObject({ presence: "busy", presence_call_id: "c1", on_call_since: null });
    await markOnCall(env, H, "c1"); // no-op while the flag is off
    expect(row().on_call_since).toBeNull();
    await releaseHost(env, H, "c1");
    expect(row()).toMatchObject({ presence: "online", presence_call_id: null });
    raw().prepare("UPDATE hf_hosts SET presence='offline'").run();
    expect(await claimHost(env, H, "c2", { booked: true })).toBe(false);
  });
  it("public cards carry no new keys", async () => {
    st.cfg = { hfCallsEnabled: true, hostsPublicEnabled: true };
    const res = await hfHostsPublicRoute(new Request("https://x.test/api/hosts/public"), env);
    const items = await res.json();
    expect(items[0]).toMatchObject({ slug: "tara-sharma", status: "online" });
    for (const k of ["mode", "callState", "queue"]) expect(items[0]).not.toHaveProperty(k);
    const one = await (await hfHostsListRoute(new Request("https://x.test/api/hf/hosts/tara-sharma"), env)).json();
    expect(one).toEqual({ ok: true, slug: "tara-sharma", status: "online" });
  });
});

describe("claim / release / markOnCall (flag ON)", () => {
  it("claim takes only the lock; she keeps showing Online while it rings; second claim fails", async () => {
    expect(await claimHost(env, H, "c1")).toBe(true);
    expect(row()).toMatchObject({ presence: "online", presence_call_id: "c1", on_call_since: null });
    expect(await claimHost(env, H, "c2")).toBe(false);
    expect(await claimHost(env, H, "c3", { booked: true })).toBe(false); // one call at a time
  });
  it("markOnCall sets busy + on_call_since only for the lock owner, and only after connect", async () => {
    await claimHost(env, H, "c1");
    await markOnCall(env, H, "other");
    expect(row().on_call_since).toBeNull();
    await markOnCall(env, H, "c1");
    expect(row()).toMatchObject({ presence: "busy" });
    expect(row().on_call_since).toBeGreaterThan(0);
  });
  it("an old call cannot clear a newer lock", async () => {
    await claimHost(env, H, "c1");
    await releaseHost(env, H, "c1");
    await claimHost(env, H, "c2");
    await markOnCall(env, H, "c2");
    await releaseHost(env, H, "c1"); // stale retry
    expect(row()).toMatchObject({ presence_call_id: "c2", presence: "busy" });
    expect(row().on_call_since).not.toBeNull();
    await releaseHost(env, H, "c2");
    expect(row()).toMatchObject({ presence_call_id: null, presence: "online", on_call_since: null });
  });
  it("a BOOKED claim works in bookings_only and offline (the live bug); an instant claim does not", async () => {
    for (const mode of ["bookings_only", "offline"]) {
      await put({ mode });
      expect(await claimHost(env, H, "i-" + mode)).toBe(false);
      expect(await claimHost(env, H, "b-" + mode, { booked: true })).toBe(true);
      expect(row().presence).toBe("offline");
      await markOnCall(env, H, "b-" + mode);
      expect(row().presence).toBe("busy");
      await releaseHost(env, H, "b-" + mode);
      expect(row()).toMatchObject({ presence: "offline", presence_call_id: null });
    }
  });
  it("while fans wait (queue flag on) an instant claim is refused but a booked one and the queue swap work", async () => {
    st.cfg = { ...ON, hfCallQueueEnabled: true };
    raw().prepare("INSERT INTO hf_call_queue(id,host_uid,fan_uid,seq,status,joined_at,updated_at) VALUES('q1',?1,'fan',1,'waiting',1,1)").run(H);
    expect(await claimHost(env, H, "c1")).toBe(false);
    expect(await claimHost(env, H, "b1", { booked: true })).toBe(true);
    await releaseHost(env, H, "b1");
    expect(await lockHostForQueue(env, H, "q1")).toBe(true);
    expect(row().presence_call_id).toBe("q:q1");
    expect(await claimHostFromQueue(env, H, "other", "c9")).toBe(false);
    expect(await claimHostFromQueue(env, H, "q1", "c9")).toBe(true);
    expect(row().presence_call_id).toBe("c9");
  });
});

describe("cron sweep + forceHostOffline", () => {
  it("clears an orphan on_call_since / call lock with no live call, re-deriving presence from the mode", async () => {
    raw().prepare("UPDATE hf_hosts SET call_mode='bookings_only', presence='busy', on_call_since=5, presence_call_id='dead', presence_at=?1").run(Date.now() - 30 * 60_000);
    await runHfCallsCron(env);
    expect(row()).toMatchObject({ presence: "offline", on_call_since: null, presence_call_id: null });
  });
  it("leaves a lock that still has a live call, and a fresh one", async () => {
    raw().prepare("UPDATE hf_hosts SET presence='busy', on_call_since=5, presence_call_id='live1', presence_at=?1").run(Date.now() - 30 * 60_000);
    raw().prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at) VALUES('live1','fan',?1,100,'connected',?2)").run(H, Date.now() - 20 * 60_000);
    await runHfCallsCron(env);
    expect(row()).toMatchObject({ presence: "busy", presence_call_id: "live1" });
  });
  it("clears an orphan q: lock but keeps one an offered queue entry still owns", async () => {
    st.cfg = { ...ON, hfCallQueueEnabled: true };
    raw().prepare("UPDATE hf_hosts SET presence_call_id='q:qa', presence_at=?1").run(Date.now() - 30 * 60_000);
    await runHfCallsCron(env);
    expect(row().presence_call_id).toBeNull();
    raw().prepare("UPDATE hf_hosts SET presence_call_id='q:qb', presence_at=?1").run(Date.now() - 30 * 60_000);
    raw().prepare("INSERT INTO hf_call_queue(id,host_uid,fan_uid,seq,status,joined_at,updated_at) VALUES('qb',?1,'fan',1,'offered',1,1)").run(H);
    await runHfCallsCron(env);
    expect(row().presence_call_id).toBe("q:qb");
  });
  it("flag OFF: the legacy sweep (busy with no live call -> online)", async () => {
    st.cfg = { hfCallsEnabled: true };
    raw().prepare("UPDATE hf_hosts SET presence='busy', presence_call_id='dead', presence_at=?1").run(Date.now() - 30 * 60_000);
    await runHfCallsCron(env);
    expect(row()).toMatchObject({ presence: "online", presence_call_id: null });
  });
  it("forceHostOffline -> call_mode offline + closeQueue (flag ON); keeps busy while on a call", async () => {
    await forceHostOffline(env, H);
    expect(row()).toMatchObject({ call_mode: "offline", presence: "offline" });
    expect(st.closed).toEqual([H]);
    await put({ mode: "online" });
    await claimHost(env, H, "c1"); await markOnCall(env, H, "c1");
    await forceHostOffline(env, H);
    expect(row()).toMatchObject({ call_mode: "offline", presence: "busy" });
  });
  it("forceHostOffline flag OFF is today's presence behaviour and also sets call_mode", async () => {
    st.cfg = {};
    await forceHostOffline(env, H);
    expect(row()).toMatchObject({ presence: "offline", call_mode: "offline" });
    expect(st.closed).toEqual([]);
  });
});

describe("public readers (flag ON)", () => {
  it("cards add mode / callState / queue; legacy status stays identical", async () => {
    const before = await (await hfHostsPublicRoute(new Request("https://x.test/api/hosts/public"), env)).json();
    expect(before[0]).toMatchObject({ status: "online", mode: "online", callState: "available", queue: { open: false, waiting: 0 } });
    await claimHost(env, H, "c1"); await markOnCall(env, H, "c1");
    const on = await (await hfHostsListRoute(new Request("https://x.test/api/hf/hosts?limit=5"), env)).json();
    expect(on.items[0]).toMatchObject({ status: "busy", mode: "online", callState: "on_call" });
    await releaseHost(env, H, "c1");
    await put({ mode: "bookings_only" });
    const one = await (await hfHostsListRoute(new Request("https://x.test/api/hf/hosts/tara-sharma"), env)).json();
    expect(one).toMatchObject({ ok: true, status: "offline", mode: "bookings_only", callState: "appointments", canBook: true, canQueue: false });
  });
  it("queue open + waiting count show when the queue flag is on", async () => {
    st.cfg = { ...ON, hfCallQueueEnabled: true };
    raw().prepare("INSERT INTO hf_call_queue(id,host_uid,fan_uid,seq,status,joined_at,updated_at) VALUES('q1',?1,'f1',1,'waiting',1,1),('q2',?1,'f2',2,'waiting',2,2)").run(H);
    const one = await (await hfHostsListRoute(new Request("https://x.test/api/hf/hosts/tara-sharma"), env)).json();
    expect(one).toMatchObject({ callState: "queue_only", queue: { open: true, waiting: 2 }, canQueue: true });
  });
});

describe("queue pause endpoints", () => {
  it("404 until both flags are on; then GET lists first names and PUT pauses", async () => {
    const q = (m, b) => hfHostModeRoute(req(m, "/api/hosts/me/queue", b), env, "/api/hosts/me/queue");
    expect((await q("GET")).status).toBe(404);
    st.cfg = { ...ON, hfCallQueueEnabled: true };
    raw().prepare("INSERT INTO hf_user_registration(uid,username,first_name,last_name,terms_accepted_at,privacy_accepted_at,disclaimer_accepted_at,community_accepted_at,engagement_accepted_at,created_at) VALUES('f1','ravi','ravi','kumar',1,1,1,1,1,1)").run();
    raw().prepare("INSERT INTO hf_call_queue(id,host_uid,fan_uid,seq,status,joined_at,updated_at) VALUES('q1',?1,'f1',1,'waiting',5,5)").run(H);
    const g = await (await q("GET")).json();
    expect(g).toEqual({ ok: true, waiting: 1, paused: false, entries: [{ position: 1, firstName: "Ravi", joinedAt: 5 }] });
    const p = await (await q("PUT", { paused: true })).json();
    expect(p.paused).toBe(true);
    expect(row().queue_paused).toBe(1);
    expect((await q("PUT", { paused: "x" })).status).toBe(400);
  });
});
