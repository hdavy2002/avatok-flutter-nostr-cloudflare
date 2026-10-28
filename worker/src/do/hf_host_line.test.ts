// @ts-nocheck -- uses node:sqlite (the D1 shim), which the worker tsconfig has no types for
// [HF-CALL-MODES-B] The call queue against REAL SQL (every migration applied to in-memory SQLite), the REAL HfHostLineDO class behind a fake
// namespace whose alarm() the test drives with fake time, and the REAL route. Mocked: config, telemetry, WhatsApp sending, WhatsApp verification,
// push, startInstantCall (Lane C) and auth.
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
vi.mock("../hooks", async (orig) => ({ ...(await orig()), track: vi.fn(async () => undefined), trackException: vi.fn(async () => undefined) }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: vi.fn(async (_e: unknown, uid: string) => "+91" + uid) }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: vi.fn(async () => ({ ok: true })) }));
vi.mock("../lib/hf_push", () => ({ sendHfPush: vi.fn(async () => false) }));
vi.mock("../lib/hf_call_start", () => ({ startInstantCall: vi.fn() }));

import * as config from "../routes/config";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { startInstantCall } from "../lib/hf_call_start";
import { HfHostLineDO } from "./hf_host_line";
import { hfQueueRoute } from "../routes/hf_queue";
import { closeQueue, notifyLineFree, queueGate, queueWa, runHfQueueCron, setQueuePaused, hostQueueView, myQueueEntry } from "../lib/hf_queue_store";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const T0 = Date.parse("2026-10-23T06:00:00Z");
const HOST = "host-1";
const FANS = ["fan-1", "fan-2", "fan-3", "fan-4"];
let env: any, db: any, objs: Map<string, any>;

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
  });
  objs = new Map();
  const e: any = { DB_META: { prepare: (q: string) => mk(q) } };
  e.HF_HOST_LINE = {
    idFromName: (n: string) => n,
    get: (id: string) => {
      if (!objs.has(id)) {
        const values = new Map<string, unknown>();
        const rec: any = { alarm: null };
        const storage = {
          get: async (k: string) => values.get(k), put: async (k: string, v: unknown) => { values.set(k, structuredClone(v)); },
          setAlarm: async (t: number) => { rec.alarm = t; }, deleteAlarm: async () => { rec.alarm = null; }, getAlarm: async () => rec.alarm,
        };
        rec.obj = new HfHostLineDO({ storage } as any, e);
        objs.set(id, rec);
      }
      const rec = objs.get(id);
      return { fetch: (url: string, init?: RequestInit) => rec.obj.fetch(new Request(url, init)) };
    },
  };
  return e;
}

const flags = (over = {}) => vi.mocked(config.readConfig).mockResolvedValue({ hfCallsEnabled: true, hfCallQueueEnabled: true, hfBookingsEnabled: false, hfQueueBreakSeconds: 60 /* [HF-INTRO-W2] default is now 120; these timings pin 60 */, ...over } as never);
const sent = () => vi.mocked(sendWhatsAppText).mock.calls.map((c) => ({ to: c[1], text: c[2] as string }));
const sentTo = (uid: string, re: RegExp) => sent().filter((s) => s.to === "+91" + uid && re.test(s.text));

/** Move time forward, firing every DO alarm that falls due on the way (in order). */
async function advance(ms: number) {
  const target = Date.now() + ms;
  for (let i = 0; i < 400; i++) {
    const due = [...objs.values()].filter((r) => r.alarm != null && r.alarm <= target).sort((a, b) => a.alarm - b.alarm)[0];
    if (!due) break;
    vi.setSystemTime(Math.max(Date.now(), due.alarm));
    due.alarm = null;
    await due.obj.alarm();
  }
  vi.setSystemTime(target);
}
const settle = async () => { await advance(0); };

function seed() {
  const t = T0;
  for (const u of [HOST, ...FANS]) {
    try { db.prepare("INSERT INTO users (uid, display_name, created_at, updated_at) VALUES (?1,?2,?3,?3)").run(u, u === HOST ? "Tara Sharma" : "Ravi " + u, t); } catch { /* shape differs */ }
    db.prepare("INSERT OR REPLACE INTO hf_age_confirm(uid,confirmed_at,source) VALUES(?1,?2,'test')").run(u, t);
  }
  db.prepare("INSERT INTO hf_hosts(uid,slug,display_name,status,category,price_per_min,created_at,updated_at) VALUES(?1,'tara-sharma','Tara Sharma','live','influencer',20,?2,?2)").run(HOST, t);
  for (const u of FANS) lot(u, 100000);
}
function lot(uid: string, paise: number) {
  db.prepare("DELETE FROM hf_token_lots WHERE uid=?1").run(uid);
  db.prepare(`INSERT INTO hf_token_lots(id,uid,kind,pricing_version,redemption_paise_per_token,tokens_granted_micro,tokens_left_micro,tokens_reserved_micro,paid_paise,provider,provider_ref,created_at,status)
              VALUES(?1,?2,'purchase','gp-r1',100,?3,?3,0,?4,'test','ref-'||?2||?5,?6,'active')`).run("lot-" + uid + Math.random(), uid, paise * 10_000, paise, Math.random(), T0);
}
const hostRow = () => db.prepare("SELECT presence_call_id, on_call_since, call_mode, queue_paused FROM hf_hosts WHERE uid=?1").get(HOST);
const setHost = (sql: string, ...a: unknown[]) => db.prepare(`UPDATE hf_hosts SET ${sql} WHERE uid='${HOST}'`).run(...a);
const entry = (uid: string) => db.prepare("SELECT * FROM hf_call_queue WHERE fan_uid=?1 ORDER BY joined_at DESC, rowid DESC LIMIT 1").get(uid);

/** The influencer is on a connected call (the line is taken and "On a call" shows). */
function hostOnCall(callId = "call-0") {
  db.prepare("INSERT OR REPLACE INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at,connected_at) VALUES(?1,'someone',?2,2000,'connected',?3,?3)").run(callId, HOST, Date.now());
  setHost("presence_call_id=?1, on_call_since=?2", callId, Date.now());
}
/** That call ended: HfCallDO writes the outcome, releases the host, then notifies the line. */
async function endCall(callId: string, reason: string | null, connected: boolean) {
  db.prepare("UPDATE hf_calls SET status=?2, end_reason=?3, connected_at=?4, ended_at=?5 WHERE id=?1").run(callId, connected ? "completed" : "failed", reason, connected ? Date.now() - 60000 : null, Date.now());
  setHost("presence_call_id=NULL, on_call_since=NULL");
  await notifyLineFree(env, HOST, callId);
}

function req(method: string, path: string, uid: string | null, body?: unknown) {
  return new Request("https://x.test" + path, { method, headers: { "content-type": "application/json", ...(uid ? { authorization: "Bearer " + uid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function join(uid: string, slug = "tara-sharma") {
  const r = await hfQueueRoute(req("POST", `/api/hf/hosts/${slug}/queue`, uid), env);
  return { status: r!.status, body: await r!.json() };
}
async function leave(uid: string, slug = "tara-sharma") {
  const r = await hfQueueRoute(req("DELETE", `/api/hf/hosts/${slug}/queue`, uid), env);
  return { status: r!.status, body: await r!.json() };
}
/** startInstantCall as Lane C will do it: take the line (swap q: -> call id), insert the call row. */
let startSeq = 0;
function fakeStart(ok = true, error = "boom") {
  vi.mocked(startInstantCall).mockImplementation(async (_e, input) => {
    if (!ok) return { ok: false, error };
    const callId = "call-" + input.queueEntryId + "-" + (++startSeq);
    db.prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,created_at) VALUES(?1,?2,?3,2000,'ringing_host',?4)").run(callId, input.callerUid, input.hostUid, Date.now());
    db.prepare("UPDATE hf_hosts SET presence_call_id=?2 WHERE uid=?1 AND presence_call_id=?3").run(input.hostUid, callId, "q:" + input.queueEntryId);
    return { ok: true, callId };
  });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); env = makeEnv(); flags(); seed(); fakeStart(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("join gates (rules 1, 2, D2, D4)", () => {
  it("a host who is free refuses the queue (the fan should just call); on a call it accepts", async () => {
    let r = await join("fan-1");
    expect(r.status).toBe(409); expect(r.body.error).toBe("queue_closed"); expect(r.body.reason).toBe("available");
    hostOnCall();
    r = await join("fan-1");
    expect(r.status).toBe(200); expect(r.body.position).toBe(1); expect(r.body.waiting).toBe(1);
  });

  it("closed when the mode is not online, or the queue is paused; full at the limit; blocked is closed; no balance is low_balance with the shortfall", async () => {
    hostOnCall();
    setHost("call_mode='bookings_only'");
    expect((await join("fan-1")).body.error).toBe("queue_closed");
    setHost("call_mode='online', queue_paused=1");
    expect((await join("fan-1")).body.reason).toBe("paused");
    setHost("queue_paused=0");
    db.prepare("INSERT INTO hf_blocks(blocker_uid,blocked_uid,created_at) VALUES(?1,?2,?3)").run(HOST, "fan-1", T0);
    expect((await join("fan-1")).body.error).toBe("queue_closed");
    lot("fan-2", 1000); // Rs 10: below max(Rs 20, 5 min at Rs 20 = Rs 100)
    const low = await join("fan-2");
    expect(low.status).toBe(402); expect(low.body.error).toBe("low_balance"); expect(low.body.shortfallPaise).toBe(9000);
    vi.mocked(config.readConfig).mockResolvedValue({ hfCallsEnabled: true, hfCallQueueEnabled: true, hfQueueMaxLength: 2, hfQueueBreakSeconds: 60 } as never);
    expect((await join("fan-3")).status).toBe(200);
    expect((await join("fan-4")).status).toBe(200);
    db.prepare("DELETE FROM hf_blocks").run();
    const full = await join("fan-1");
    expect(full.status).toBe(409); expect(full.body.error).toBe("queue_full");
  });

  it("one active entry per fan: the second host's join says already_queued with the current host slug; two simultaneous joins -> one wins", async () => {
    hostOnCall();
    const [a, b] = await Promise.all([join("fan-1"), join("fan-1")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error).toBe("already_queued"); expect(loser.body.hostSlug).toBe("tara-sharma");
    expect(db.prepare("SELECT COUNT(*) c FROM hf_call_queue WHERE fan_uid='fan-1'").get().c).toBe(1);
  });

  it("flag off: 404 feature_off, gate says no queue, notifyLineFree / closeQueue never wake the DO", async () => {
    flags({ hfCallQueueEnabled: false });
    hostOnCall();
    const r = await join("fan-1");
    expect(r.status).toBe(404); expect(r.body.error).toBe("feature_off");
    expect(await queueGate(env, HOST)).toEqual({ waiting: 0, paused: false, open: false });
    const spy = vi.spyOn(env.HF_HOST_LINE, "get");
    await notifyLineFree(env, HOST, "call-0");
    expect(await closeQueue(env, HOST)).toBe(0);
    expect(await runHfQueueCron(env)).toEqual({ hosts: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("position, leave, join message", () => {
  it("positions follow the order, leaving moves everyone up, and the join WhatsApp goes out once", async () => {
    hostOnCall();
    for (const u of ["fan-1", "fan-2", "fan-3"]) expect((await join(u)).status).toBe(200);
    expect((await join("fan-3")).status).toBe(409);
    expect((await myQueueEntry(env, "fan-3")).entry.position).toBe(3);
    await advance(10_000);
    expect(sentTo("fan-1", /queue, #1/).length).toBe(1);
    expect(sentTo("fan-2", /queue, #2/).length).toBe(1);
    expect(sentTo("fan-3", /queue, #3/).length).toBe(1);
    expect((await leave("fan-1")).status).toBe(200);
    expect((await myQueueEntry(env, "fan-2")).entry.position).toBe(1);
    expect((await myQueueEntry(env, "fan-3")).entry.position).toBe(2);
    expect((await myQueueEntry(env, "fan-1")).entry).toBeNull();
    expect(sent().length).toBe(3); // leaving sends nothing (rule 12)
    expect((await hostQueueView(env, HOST)).entries.map((e) => e.firstName)).toEqual(["Ravi", "Ravi"]);
  });

  it("outbox dedupe: the same message queued twice is one row and one send", async () => {
    hostOnCall();
    await join("fan-1");
    const e = entry("fan-1");
    expect(await queueWa(env, e, "join", "again", Date.now())).toBe(false);
    await advance(10_000);
    expect(db.prepare("SELECT COUNT(*) c FROM whatsapp_outbox WHERE checkout_id=?1 AND kind='hf_queue_join'").get(e.id).c).toBe(1);
    expect(sentTo("fan-1", /queue, #1/).length).toBe(1);
    expect(db.prepare("SELECT status FROM whatsapp_outbox WHERE checkout_id=?1").get(e.id).status).toBe("sent");
  });
});

describe("line free -> 60 s break -> dispatch (rule 4)", () => {
  it("locks the line as q:<id>, sends the heads-up once, dispatches after exactly the break, and the next fan waits behind the call", async () => {
    hostOnCall();
    await join("fan-1"); await join("fan-2");
    await advance(600_000); // she talks for 10 minutes
    await endCall("call-0", null, true);
    await settle();
    const e1 = entry("fan-1");
    expect(e1.status).toBe("offered");
    expect(hostRow().presence_call_id).toBe("q:" + e1.id);
    await advance(30_000);
    expect(startInstantCall).not.toHaveBeenCalled();
    await advance(29_000); // 59 s
    expect(startInstantCall).not.toHaveBeenCalled();
    await advance(2_000); // 61 s
    expect(startInstantCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startInstantCall).mock.calls[0][1]).toMatchObject({ callerUid: "fan-1", hostUid: HOST, source: "queue", queueEntryId: e1.id });
    expect(entry("fan-1").call_id).toMatch(new RegExp("^call-" + e1.id));
    expect(hostRow().presence_call_id).toBe(entry("fan-1").call_id); // fakeStart swapped the lock like claimHostFromQueue
    await advance(120_000);
    expect(sentTo("fan-1", /You're next for Tara/).length).toBe(1); // heads-up exactly once
    expect(sentTo("fan-2", /You're next/).length).toBe(0);
    expect(startInstantCall).toHaveBeenCalledTimes(1);
  });

  it("the completed queued call frees the line: the next fan gets a break, then the call", async () => {
    hostOnCall();
    await join("fan-1"); await join("fan-2");
    await endCall("call-0", null, true);
    await advance(61_000);
    const c1 = entry("fan-1").call_id;
    await endCall(c1, null, true);
    expect(entry("fan-1").status).toBe("done");
    await advance(61_000);
    expect(startInstantCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startInstantCall).mock.calls[1][1].callerUid).toBe("fan-2");
  });
});

describe("fan no-answer, host misses, low balance (rules 5, 6, 7, D3)", () => {
  it("fan no answer: skipped with a message, the next fan is rung after 10 s (not 60)", async () => {
    hostOnCall();
    await join("fan-1"); await join("fan-2");
    await endCall("call-0", null, true);
    await advance(61_000);
    const c1 = entry("fan-1").call_id;
    await endCall(c1, "caller_no_answer", false);
    expect(entry("fan-1").status).toBe("skipped"); expect(entry("fan-1").skip_reason).toBe("fan_no_answer");
    expect(hostRow().presence_call_id).toBe("q:" + entry("fan-2").id);
    await advance(9_000);
    expect(startInstantCall).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(startInstantCall).toHaveBeenCalledTimes(2);
    await advance(70_000);
    expect(sentTo("fan-1", /couldn't reach you/).length).toBe(1);
    expect(sentTo("fan-2", /You're next/).length).toBe(1);
  });

  it("the influencer misses twice in a row: first miss keeps the fan's front place, second pauses the queue (mode untouched) and tells the waiters; paused entries expire after 15 min", async () => {
    hostOnCall();
    await join("fan-1"); await join("fan-2");
    await endCall("call-0", null, true);
    await advance(61_000);
    const e1 = entry("fan-1");
    await endCall(entry("fan-1").call_id, "host_declined", false);
    expect(entry("fan-1")).toMatchObject({ status: "offered", host_miss_count: 1, call_id: null }); // front place kept: break again
    expect(db.prepare("SELECT queue_paused p FROM hf_hosts").get().p).toBe(0);
    await advance(61_000);
    expect(startInstantCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startInstantCall).mock.calls[1][1].callerUid).toBe("fan-1");
    await endCall(entry("fan-1").call_id, "no_answer", false);
    expect(db.prepare("SELECT queue_paused p FROM hf_hosts").get().p).toBe(1);
    expect(hostRow().call_mode).toBe("online");
    expect(hostRow().presence_call_id).toBeNull();
    expect(entry("fan-1").status).toBe("waiting"); expect(entry("fan-2").status).toBe("waiting");
    await advance(70_000);
    expect(sentTo("fan-1", /paused the queue/).length).toBe(1);
    expect(sentTo("fan-2", /paused the queue/).length).toBe(1);
    expect(startInstantCall).toHaveBeenCalledTimes(2); // paused: no dispatch
    expect((await join("fan-3")).body.reason).toBe("paused");
    await advance(15 * 60_000);
    expect(entry("fan-1").status).toBe("expired"); expect(entry("fan-2").status).toBe("expired");
    await advance(70_000);
    expect(sentTo("fan-1", /has expired/).length).toBe(1);
  });

  it("a fan who cannot afford it at his turn is skipped with a top-up message and the next fan goes at once", async () => {
    hostOnCall();
    await join("fan-1"); await join("fan-2");
    lot("fan-1", 1000); // spends it while waiting
    await endCall("call-0", null, true);
    await advance(61_000);
    expect(entry("fan-1")).toMatchObject({ status: "skipped", skip_reason: "low_balance" });
    expect(startInstantCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startInstantCall).mock.calls[0][1].callerUid).toBe("fan-2");
    await advance(70_000);
    expect(sentTo("fan-1", /wallet needs at least ₹100/).length).toBe(1);
  });

  it("start trouble on our side keeps the place and retries; three in a row gives the fan up neutrally", async () => {
    fakeStart(false, "wallet_busy");
    hostOnCall();
    await join("fan-1");
    await endCall("call-0", null, true);
    await advance(61_000);
    expect(startInstantCall).toHaveBeenCalledTimes(1);
    expect(hostRow().presence_call_id).toBeNull(); // line released for others
    await advance(300_000);
    expect(startInstantCall.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(entry("fan-1").status).toBe("skipped");
  });
});

describe("mode change, expiry, booking first (rules 8, 9, 11)", () => {
  it("leaving online closes the queue: every waiter is told exactly once, the lock is released, joins are refused", async () => {
    hostOnCall();
    for (const u of ["fan-1", "fan-2", "fan-3"]) await join(u);
    await advance(10_000);
    setHost("call_mode='bookings_only'");
    expect(await closeQueue(env, HOST)).toBe(3);
    expect(await closeQueue(env, HOST)).toBe(0);
    for (const u of ["fan-1", "fan-2", "fan-3"]) expect(entry(u)).toMatchObject({ status: "closed", skip_reason: "host_offline" });
    await advance(70_000); // one queue message per fan per 60 s: the join message went out first
    expect(sent().filter((s) => /stopped taking calls/.test(s.text)).length).toBe(3);
    await advance(300_000);
    expect(sent().filter((s) => /stopped taking calls/.test(s.text)).length).toBe(3);
    expect((await join("fan-4")).body.error).toBe("queue_closed");
  });

  it("mode change during the break cancels the dispatch and frees the line", async () => {
    hostOnCall();
    await join("fan-1");
    await endCall("call-0", null, true);
    await advance(10_000);
    expect(hostRow().presence_call_id).toMatch(/^q:/);
    setHost("call_mode='offline'");
    await closeQueue(env, HOST);
    expect(hostRow().presence_call_id).toBeNull();
    await advance(120_000);
    expect(startInstantCall).not.toHaveBeenCalled();
  });

  it("waiting longer than 2 hours expires the entry with a message", async () => {
    hostOnCall();
    await join("fan-1");
    await advance(119 * 60_000);
    expect(entry("fan-1").status).toBe("waiting");
    await advance(2 * 60_000);
    expect(entry("fan-1").status).toBe("expired");
    await advance(30_000);
    expect(sentTo("fan-1", /has expired/).length).toBe(1);
  });

  it("a booking starting in 3 minutes holds the dispatch; one 30 minutes away lets the queued call run, capped at the booking cutoff", async () => {
    flags({ hfBookingsEnabled: true });
    const book = (id: string, startsIn: number) => db.prepare(
      "INSERT INTO hf_bookings(id,host_uid,customer_uid,starts_at,ends_at,host_timezone,schedule_version,quote_id,idempotency_key,status,duration_min,reserved_paise,expected_host_net_paise,price_snapshot_json,policy_snapshot_json,reservation_snapshot_json,settlement_status,created_at,updated_at) VALUES(?,?,?,?,?,'UTC',1,?,?,'confirmed',15,1000,500,'{}','{}','{}','held',?,?)",
    ).run(id, HOST, "someone-else", Date.now() + startsIn, Date.now() + startsIn + 900_000, "q-" + id, "k-" + id, Date.now(), Date.now());
    hostOnCall();
    await join("fan-1");
    book("b1", 3 * 60_000);
    await endCall("call-0", null, true);
    await advance(120_000);
    expect(startInstantCall).not.toHaveBeenCalled();
    expect(hostRow().presence_call_id).toBeNull(); // nobody holds the line; the booking can claim it
    expect(entry("fan-1").status).toBe("waiting");
    // booking passes; a later one is far enough away
    db.prepare("DELETE FROM hf_bookings").run();
    book("b2", 30 * 60_000);
    await runHfQueueCron(env); // the 5-minute sweep restarts the machine
    await advance(61_000);
    expect(startInstantCall).toHaveBeenCalledTimes(1);
    const cutoff = db.prepare("SELECT starts_at-600000 AS c FROM hf_bookings WHERE id='b2'").get().c; // default 10-min buffer
    expect(vi.mocked(startInstantCall).mock.calls[0][1].hardEndsAt).toBe(cutoff);
  });
});

describe("sweep (lost alarms)", () => {
  it("an orphan q: lock with no running break is freed and the entry goes back to waiting; the machine restarts", async () => {
    hostOnCall();
    await join("fan-1");
    const e = entry("fan-1");
    setHost("presence_call_id=?1, on_call_since=NULL", "q:" + e.id);
    db.prepare("UPDATE hf_call_queue SET status='offered' WHERE id=?1").run(e.id);
    expect(await runHfQueueCron(env)).toEqual({ hosts: 1 });
    expect(hostRow().presence_call_id).toBe("q:" + e.id); // re-taken by the sweep's own evaluateIdle for the same head
    await advance(61_000);
    expect(startInstantCall).toHaveBeenCalledTimes(1);
  });

  it("an offered entry whose call already ended (line-free lost) is settled by the sweep", async () => {
    hostOnCall();
    await join("fan-1");
    await endCall("call-0", null, true);
    await advance(61_000);
    const cid = entry("fan-1").call_id;
    db.prepare("UPDATE hf_calls SET status='completed', connected_at=?2, end_reason=NULL WHERE id=?1").run(cid, Date.now() - 1000);
    setHost("presence_call_id=?1", cid);
    await runHfQueueCron(env);
    expect(entry("fan-1").status).toBe("done");
    expect(hostRow().presence_call_id).toBeNull();
  });
});

describe("pause by the influencer", () => {
  it("pause cancels the break and tells waiters; resume restarts the line", async () => {
    hostOnCall();
    await join("fan-1");
    await endCall("call-0", null, true);
    await advance(10_000);
    expect(entry("fan-1").status).toBe("offered");
    await setQueuePaused(env, HOST, true, "host");
    expect(entry("fan-1").status).toBe("waiting");
    expect(hostRow().presence_call_id).toBeNull();
    await advance(120_000);
    expect(startInstantCall).not.toHaveBeenCalled();
    expect(sentTo("fan-1", /paused the queue/).length).toBe(1);
    await setQueuePaused(env, HOST, false, "host");
    await advance(61_000);
    expect(startInstantCall).toHaveBeenCalledTimes(1);
  });
});
