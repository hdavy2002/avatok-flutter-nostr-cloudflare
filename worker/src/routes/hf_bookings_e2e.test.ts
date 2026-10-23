// @ts-nocheck -- uses node:sqlite (the D1 shim), which the worker tsconfig has no types for
// [HF-BOOKING-E2E-1] The whole cross-side chain against the REAL route handlers and REAL SQL (every migration applied to in-memory SQLite):
// influencer saves availability -> public slots show it -> a fan books (hold + occupancy) -> the slot is gone for everybody else (and a
// race on the same slot cannot double book) -> influencer sees it booked / waiting -> cancel / decline / expiry frees the slot and the hold once.
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
vi.mock("./config", () => ({ readConfig: vi.fn() }));
vi.mock("../money", async (orig) => ({ ...(await orig()), rateLimit: vi.fn(async () => null) }));
vi.mock("../hooks", async (orig) => ({
  ...(await orig()), track: vi.fn(async () => undefined), trackUser: vi.fn(async () => undefined), trackException: vi.fn(async () => undefined),
}));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: vi.fn(async () => "+919876543210") }));
vi.mock("../lib/hf_booking_approval", async (orig) => {
  const a = await orig();
  return { ...a, notifyBooking: vi.fn(async () => undefined), emitBookingEvent: vi.fn(async () => undefined) };
});

import * as config from "./config";
import { hfBookingsAppRoute } from "./hf_bookings_app";
import { hfBookingsRoute } from "./hf_bookings";
import { acceptPending, declinePending, runHfBookingApprovalExpiry } from "../lib/hf_booking_approval";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

// ── a D1-shaped wrapper over node:sqlite, with every migration applied (statement by statement; ones that need other things are skipped) ──
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
  const DB_META = {
    prepare: (q: string) => mk(q),
    batch: async (stmts: any[]) => { // atomic, like D1
      db.exec("BEGIN");
      try { const out = stmts.map((s) => { const r = db.prepare(s._q).run(...s._a); return { meta: { changes: Number(r.changes) } }; }); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    _raw: db,
  };
  return { DB_META, HF_CALL_DID: "x", VOBIZ_AUTH_ID: "x", VOBIZ_AUTH_TOKEN: "x", VOBIZ_WEBHOOK_SECRET: "x" } as any;
}

const NOW = Date.parse("2026-10-23T06:00:00Z");           // 11:30 IST
const TOMORROW = "2026-10-24";
const at = (hhmm: string, date = TOMORROW) => Date.parse(`${date}T${hhmm}:00+05:30`);
const HOST = "host-1", FAN = "fan-1", FAN2 = "fan-2";
let env: any;
const raw = () => env.DB_META._raw;

function req(method: string, path: string, uid: string | null, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://x.test" + path, {
    method, headers: { "content-type": "application/json", ...(uid ? { authorization: "Bearer " + uid } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(r: Request) {
  const res = (await hfBookingsAppRoute(r, env)) ?? (await hfBookingsRoute(r, env));
  const text = res ? await res.text() : "";
  return { status: res?.status ?? 0, body: text ? JSON.parse(text) : null };
}

function seed(approval = false) {
  const d = raw(), t = NOW;
  for (const u of [HOST, FAN, FAN2]) {
    try { d.prepare("INSERT INTO users(uid,display_name) VALUES(?1,?2)").run(u, u === HOST ? "Tara Sharma" : "Ravi Kumar"); } catch { /* users shape differs */ }
    d.prepare("INSERT OR REPLACE INTO hf_age_confirm(uid,confirmed_at,source) VALUES(?1,?2,'test')").run(u, t);
    d.prepare("INSERT INTO phone_otp(uid,phone_hash,e164,status,created_at) VALUES(?1,?2,'+919876543210','verified',?3)").run(u, "h-" + u, t);
    d.prepare("INSERT OR REPLACE INTO contact_verification(uid,phone_hash,phone_verified,updated_at) VALUES(?1,?2,1,?3)").run(u, "h-" + u, t);
  }
  d.prepare("INSERT INTO hf_hosts(uid,slug,display_name,status,category,price_per_min,created_at,updated_at) VALUES(?1,'tara-sharma','Tara Sharma','live','influencer',20,?2,?2)").run(HOST, t);
  if (approval) d.prepare("UPDATE hf_hosts SET booking_approval='manual' WHERE uid=?1").run(HOST);
  for (const u of [FAN, FAN2]) {
    d.prepare(`INSERT INTO hf_token_lots(id,uid,kind,pricing_version,redemption_paise_per_token,tokens_granted_micro,tokens_left_micro,tokens_reserved_micro,paid_paise,provider,provider_ref,created_at,status)
               VALUES(?1,?2,'purchase','gp-r1',100,1000000000,1000000000,0,100000,'test','ref-'||?2,?3,'active')`).run("lot-" + u, u, t);
  }
}
const flags = (over = {}) => vi.mocked(config.readConfig).mockResolvedValue({
  hfBookingsEnabled: true, hfCallsEnabled: true, hfTokensEnabled: true, hfBookingApprovalEnabled: false, ...over,
} as never);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); env = makeEnv(); flags(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const slotsOf = async (uid: string | null = null) => (await call(req("GET", "/api/hf/hosts/tara-sharma/slots?from=2026-10-23&to=2026-10-30", uid))).body;
const reservedOf = (uid: string) => Number(raw().prepare("SELECT COALESCE(SUM(tokens_reserved_micro),0) r FROM hf_token_lots WHERE uid=?1").get(uid).r);
const occupancy = (status = "busy") => raw().prepare("SELECT COUNT(*) c FROM hf_booking_occupancy WHERE user_id=?1 AND status=?2").get(HOST, status).c;
async function openDay(slots = ["10:00", "11:00", "12:00"]) {
  const g = await call(req("GET", "/api/hf/hosts/me/availability", HOST));
  expect(g.status).toBe(200);
  const p = await call(req("PUT", "/api/hf/hosts/me/availability", HOST, { days: { [TOMORROW]: { open: true, slots } }, expectedVersion: g.body.version }));
  expect(p.status).toBe(200);
  return p.body;
}
const book = (uid: string, hhmm: string, extra = {}) => call(req("POST", "/api/hf/bookings", uid, { hostSlug: "tara-sharma", startAt: at(hhmm), ...extra }));

describe("availability -> slots -> book -> gone -> cancel -> back (approval flag OFF)", () => {
  beforeEach(() => seed(false));

  it("1. what the influencer opens is exactly what a signed-out visitor can book (IST, min notice, horizon)", async () => {
    const saved = await openDay();
    expect(saved.days[TOMORROW].slots).toEqual(["10:00", "11:00", "12:00"]);
    const s = await slotsOf();
    expect(s.openDates).toEqual([TOMORROW]);
    expect(s.days[TOMORROW]).toEqual(["10:00", "11:00", "12:00"]);
    expect(s.timezone).toBe("Asia/Kolkata");
    // a day not opened is not offered; today's already-passed / inside-notice times are not offered either
    expect(s.days["2026-10-25"]).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/host-1|fan-1|uid/);
  });

  it("1b. the web booking page's endpoint (/availability) shows the same days, and tells the page which lengths are bookable", async () => {
    await openDay();
    const r = await call(req("GET", "/api/hf/hosts/tara-sharma/availability?from=2026-10-24&to=2026-10-24&durationMinutes=10", null));
    expect(r.status).toBe(200);
    expect(r.body.slots.map((x) => x.startUtc)).toEqual(["10:00", "11:00", "12:00"].map((h) => new Date(at(h)).toISOString()));
    expect(r.body.durationsMinutes).toEqual([10]);
    const bad = await call(req("GET", "/api/hf/hosts/tara-sharma/availability?from=2026-10-24&to=2026-10-24&durationMinutes=30", null));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_duration");
    expect(bad.body.durationsMinutes).toEqual([10]); // so the page can switch to a length that exists
  });

  it("2. booking writes the booking + hold + occupancy; the slot disappears for the next fan; the influencer sees it booked", async () => {
    await openDay();
    const b = await book(FAN, "11:00");
    expect(b.status).toBe(201);
    expect(b.body.booking).toMatchObject({ status: "confirmed", day: TOMORROW, time: "11:00", holdPaise: 20000 });
    expect(reservedOf(FAN)).toBeGreaterThan(0);              // wallet hold
    expect(occupancy()).toBe(1);                              // host busy interval
    expect(raw().prepare("SELECT COUNT(*) c FROM calendar_blocks WHERE user_id=?1 AND status='busy'").get(HOST).c).toBe(1);

    const s = await slotsOf(FAN2);
    expect(s.days[TOMORROW]).toEqual(["10:00", "12:00"]);     // 11:00 is gone for everyone else
    const again = await book(FAN2, "11:00");
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/slot_unavailable|slot_or_wallet_changed/);
    expect(reservedOf(FAN2)).toBe(0);                         // nothing held for the loser

    const av = await call(req("GET", "/api/hf/hosts/me/availability", HOST));
    expect(av.body.booked[TOMORROW]).toEqual(["11:00"]);      // the influencer's bird's-eye view
    expect(av.body.days[TOMORROW].slots).toContain("11:00");  // ...still an open time, shown as booked
    const hostList = await call(req("GET", "/api/hf/bookings?role=host&shape=app&day=" + TOMORROW, HOST));
    expect(hostList.body.bookings.map((x) => x.time)).toEqual(["11:00"]);
    const fanList = await call(req("GET", "/api/hf/bookings?role=fan", FAN));
    expect(fanList.body.bookings.map((x) => x.time)).toEqual(["11:00"]);
    const summary = await call(req("GET", "/api/hosts/me/bookings/summary", HOST));
    expect(summary.body.summary).toMatchObject({ upcomingCount: 1, bookedDays: 1, waitingCount: 0 });
  });

  it("3. two fans race for the same slot: exactly one wins, exactly one hold, exactly one occupancy row", async () => {
    await openDay();
    const [a, b] = await Promise.all([book(FAN, "10:00"), book(FAN2, "10:00")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(occupancy()).toBe(1);
    expect(raw().prepare("SELECT COUNT(*) c FROM hf_bookings WHERE status='confirmed'").get().c).toBe(1);
    expect(reservedOf(FAN) > 0 ? 1 : 0).toBe(reservedOf(FAN2) > 0 ? 0 : 1);
  });

  it("3b. the SQL guard itself refuses an overlapping insert even if the quote step were bypassed (occupancy is the lock)", async () => {
    await openDay();
    expect((await book(FAN, "10:00")).status).toBe(201);
    // a second quote straight into the table for the same host/time: the quote INSERT ... WHERE NOT EXISTS (occupancy) must write 0 rows
    const q = await call(req("POST", "/api/hf/bookings/quote", FAN2, { hostSlug: "tara-sharma", startUtc: new Date(at("10:00")).toISOString(), durationMinutes: 10 }));
    expect(q.status).toBe(409);
    expect(q.body.error).toBe("slot_unavailable");
  });

  it("3c. two fans both hold a valid quote for the SAME slot, then both confirm: the confirm SQL guard lets exactly one in and holds nothing for the other", async () => {
    await openDay();
    const startUtc = new Date(at("10:00")).toISOString();
    const q1 = await call(req("POST", "/api/hf/bookings/quote", FAN, { hostSlug: "tara-sharma", startUtc, durationMinutes: 10 }));
    const q2 = await call(req("POST", "/api/hf/bookings/quote", FAN2, { hostSlug: "tara-sharma", startUtc, durationMinutes: 10 }));
    expect([q1.status, q2.status]).toEqual([201, 201]);       // quotes do not lock; only a booking does
    const c1 = await call(req("POST", "/api/hf/bookings", FAN, { quoteId: q1.body.quote.id, policyAccepted: true }, { "Idempotency-Key": "key-fan-one-1" }));
    const c2 = await call(req("POST", "/api/hf/bookings", FAN2, { quoteId: q2.body.quote.id, policyAccepted: true }, { "Idempotency-Key": "key-fan-two-1" }));
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(409);
    expect(c2.body.error).toBe("slot_or_wallet_changed");
    expect(reservedOf(FAN2)).toBe(0);
    expect(occupancy()).toBe(1);
    // retrying the winner's request with the same key is idempotent: no second hold
    const again = await call(req("POST", "/api/hf/bookings", FAN, { quoteId: q1.body.quote.id, policyAccepted: true }, { "Idempotency-Key": "key-fan-one-1" }));
    expect(again.status).toBe(200);
    expect(occupancy()).toBe(1);
  });

  it("4. fan cancels (more than 1 h ahead) -> hold released once, slot is back for everyone, host sees it free again", async () => {
    await openDay();
    const b = await book(FAN, "11:00");
    const id = b.body.booking.id;
    expect(reservedOf(FAN)).toBeGreaterThan(0);
    const c = await call(req("DELETE", "/api/hf/bookings/" + id, FAN));
    expect(c.status).toBe(200);
    expect(reservedOf(FAN)).toBe(0);
    expect(occupancy()).toBe(0);
    expect(occupancy("cancelled")).toBe(1);
    expect((await slotsOf(FAN2)).days[TOMORROW]).toEqual(["10:00", "11:00", "12:00"]);
    expect((await call(req("GET", "/api/hf/hosts/me/availability", HOST))).body.booked).toEqual({});
    // cancelling again never releases twice
    const lotBefore = raw().prepare("SELECT tokens_left_micro l, tokens_reserved_micro r FROM hf_token_lots WHERE uid=?1").get(FAN);
    await call(req("DELETE", "/api/hf/bookings/" + id, FAN));
    await call(req("POST", `/api/hf/bookings/${id}/cancel`, FAN, {}));
    expect(raw().prepare("SELECT tokens_left_micro l, tokens_reserved_micro r FROM hf_token_lots WHERE uid=?1").get(FAN)).toEqual(lotBefore);
    // and somebody else can now take the freed time
    expect((await book(FAN2, "11:00")).status).toBe(201);
  });

  it("5. the influencer cancels -> the fan always gets the hold back and the slot reopens", async () => {
    await openDay();
    const id = (await book(FAN, "12:00")).body.booking.id;
    const c = await call(req("DELETE", "/api/hf/bookings/" + id, HOST));
    expect(c.status).toBe(200);
    expect(reservedOf(FAN)).toBe(0);
    expect((await slotsOf()).days[TOMORROW]).toContain("12:00");
  });

  it("6. the web cancel route obeys the same one-hour rule as the app (HF-REEL-28)", async () => {
    await openDay();
    const id = (await book(FAN, "12:00")).body.booking.id;
    vi.setSystemTime(at("11:30"));                             // 30 minutes before the call
    const c = await call(req("POST", `/api/hf/bookings/${id}/cancel`, FAN, {}));
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("too_late");
    expect(reservedOf(FAN)).toBeGreaterThan(0);                // hold kept
    const h = await call(req("POST", `/api/hf/bookings/${id}/cancel`, HOST, {}));
    expect(h.status).toBe(200);                                // the influencer can always cancel -> fan refunded
    expect(reservedOf(FAN)).toBe(0);
  });

  it("7. saving availability later never drops a booked time or double-opens it; closing a day keeps the booked slot", async () => {
    await openDay();
    await book(FAN, "10:00");
    const g = await call(req("GET", "/api/hf/hosts/me/availability", HOST));
    const p = await call(req("PUT", "/api/hf/hosts/me/availability", HOST, { days: { [TOMORROW]: { open: false, slots: [] } }, expectedVersion: g.body.version }));
    expect(p.status).toBe(200);
    expect(p.body.days[TOMORROW].slots).toEqual(["10:00"]);    // only the booked time stays open
    expect(p.body.booked[TOMORROW]).toEqual(["10:00"]);
    expect((await slotsOf()).days[TOMORROW]).toBeUndefined();  // ...but it is not offered to anyone else
  });

  it("8. the rule-based (web) schedule shows up the same way, with its own lengths, and a booking blocks it too", async () => {
    const g = await call(req("GET", "/api/hosts/me/availability", HOST));
    const wd = new Date(at("10:00")).getUTCDay();             // weekday of TOMORROW (IST day == UTC day at 10:00 IST)
    const schedule = { ...g.body.schedule, timezone: "Asia/Kolkata", durationsMinutes: [10, 30], slotIntervalMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 60, horizonDays: 14,
      rules: [{ weekday: wd, startMin: 600, endMin: 720 }], exceptions: [] };
    const p = await call(req("PUT", "/api/hosts/me/availability", HOST, { schedule, expectedVersion: g.body.schedule.version }));
    expect(p.status).toBe(200);
    // the app's slots endpoint reads the same rows
    expect((await slotsOf()).days[TOMORROW]).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    const web = await call(req("GET", "/api/hf/hosts/tara-sharma/availability?from=2026-10-24&to=2026-10-24&durationMinutes=10", null));
    expect(web.body.slots).toHaveLength(4);
    expect(web.body.durationsMinutes).toEqual([10]);          // [HF-BOOKING-UNIFY-1] the product books 10 minutes only; extra lengths are not stored
    expect((await book(FAN, "10:30")).status).toBe(201);
    const after = await call(req("GET", "/api/hf/hosts/tara-sharma/availability?from=2026-10-24&to=2026-10-24&durationMinutes=10", null));
    expect(after.body.slots.map((x) => x.startUtc)).not.toContain(new Date(at("10:30")).toISOString());
    // the web editor cannot move a paid booking out from under the fan
    const g2 = await call(req("GET", "/api/hosts/me/availability", HOST));
    const closed = await call(req("PUT", "/api/hosts/me/availability", HOST, { schedule: { ...g2.body.schedule, rules: [] }, expectedVersion: g2.body.schedule.version }));
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe("schedule_conflicts_with_bookings");
    expect(typeof closed.body.message).toBe("string");        // a sentence the page can show, not a code
  });
});

describe("booking approval ON: a pending request blocks the slot and is counted as waiting", () => {
  beforeEach(() => { seed(true); flags({ hfBookingApprovalEnabled: true }); });

  it("9. pending request -> slot blocked for others, host sees 'waiting', accept confirms; decline / expiry / withdraw free the slot and the hold once", async () => {
    await openDay(["10:00", "11:00", "12:00", "13:00"]);
    const p1 = await book(FAN, "11:00");
    expect(p1.status).toBe(201);
    expect(p1.body.booking.status).toBe("pending_approval");
    expect((await slotsOf(FAN2)).days[TOMORROW]).toEqual(["10:00", "12:00", "13:00"]);     // blocked while waiting
    expect(occupancy()).toBe(1);
    const sum = (await call(req("GET", "/api/hosts/me/bookings/summary", HOST))).body.summary;
    expect(sum).toMatchObject({ waitingCount: 1, bookedDays: 1 });
    const pending = await call(req("GET", "/api/hf/bookings?role=host&shape=app&status=pending", HOST));
    expect(pending.body.bookings.map((x) => x.status)).toEqual(["pending_approval"]);
    const av = await call(req("GET", "/api/hf/hosts/me/availability", HOST));
    expect(av.body.booked[TOMORROW]).toEqual(["11:00"]);

    // decline -> full refund once, slot back
    const id1 = p1.body.booking.id;
    expect((await call(req("POST", `/api/hf/bookings/${id1}/decline`, HOST, {}))).status).toBe(200);
    expect(reservedOf(FAN)).toBe(0);
    expect((await call(req("POST", `/api/hf/bookings/${id1}/decline`, HOST, {}))).status).toBeGreaterThanOrEqual(200); // second decline is a no-op
    expect(reservedOf(FAN)).toBe(0);
    expect((await call(req("POST", `/api/hf/bookings/${id1}/accept`, HOST, {}))).status).toBe(409);            // first decision wins
    expect((await slotsOf(FAN2)).days[TOMORROW]).toContain("11:00");

    // fan withdraws a pending request at any time (HF-BOOK-4)
    const p2 = await book(FAN, "12:00");
    expect((await call(req("DELETE", "/api/hf/bookings/" + p2.body.booking.id, FAN))).status).toBe(200);
    expect(reservedOf(FAN)).toBe(0);
    expect((await slotsOf(FAN2)).days[TOMORROW]).toContain("12:00");

    // accept -> confirmed, still blocks, counts as upcoming not waiting
    const p3 = await book(FAN, "13:00");
    expect((await call(req("POST", `/api/hf/bookings/${p3.body.booking.id}/accept`, HOST, {}))).status).toBe(200);
    expect((await slotsOf(FAN2)).days[TOMORROW]).not.toContain("13:00");
    expect((await call(req("GET", "/api/hosts/me/bookings/summary", HOST))).body.summary).toMatchObject({ waitingCount: 0, upcomingCount: 1, bookedDays: 1 });

    // expiry: not accepted in 24 h (or 1 h before the call) -> auto-cancelled, full refund once, slot back
    const p4 = await book(FAN2, "10:00");
    expect(p4.body.booking.status).toBe("pending_approval");
    vi.setSystemTime(at("09:30"));
    await runHfBookingApprovalExpiry(env, Date.now());
    await runHfBookingApprovalExpiry(env, Date.now());           // running twice must not release twice
    expect(raw().prepare("SELECT status FROM hf_bookings WHERE id=?1").get(p4.body.booking.id).status).toBe("cancelled");
    expect(reservedOf(FAN2)).toBe(0);
    expect(occupancy("cancelled")).toBeGreaterThanOrEqual(3);
  });
});

// [HF-BOOKING-UNIFY-1] One availability model for the app and the web: weekly rules + dated windows in the same row, each writer merges.
describe("app and web share one availability schedule without destroying each other", () => {
  beforeEach(() => seed(false));
  const WEEKDAY = new Date(at("10:00")).getUTCDay();          // weekday of TOMORROW (Saturday)
  const NEXT_WEEK = "2026-10-31";                             // the same weekday one week later
  const webSched = (over = {}) => ({
    timezone: "Asia/Kolkata", durationsMinutes: [10], slotIntervalMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 60, horizonDays: 14,
    rules: [{ weekday: WEEKDAY, startMin: 600, endMin: 720 }], exceptions: [], ...over,
  });
  async function webSave(over = {}) {
    const g = await call(req("GET", "/api/hosts/me/availability", HOST));
    const p = await call(req("PUT", "/api/hosts/me/availability", HOST, { schedule: { ...g.body.schedule, ...webSched(), ...over }, expectedVersion: g.body.schedule.version }));
    expect(p.status).toBe(200);
    return p.body.schedule;
  }
  async function appSave(days) {
    const g = await call(req("GET", "/api/hf/hosts/me/availability", HOST));
    const p = await call(req("PUT", "/api/hf/hosts/me/availability", HOST, { days, expectedVersion: g.body.version }));
    return p;
  }
  const slotsLong = async () => (await call(req("GET", "/api/hf/hosts/tara-sharma/slots?from=2026-10-23&to=2026-11-02", null))).body;
  const webSlots = async (date, duration = 10) => (await call(req("GET", `/api/hf/hosts/tara-sharma/availability?from=${date}&to=${date}&durationMinutes=${duration}`, null)));
  const webTimes = async (date) => (await webSlots(date)).body.slots.map((x) => new Date(x.startUtc).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }));

  it("U1. a web schedule saved without the 10-minute length (older save) still yields slots in the app AND on the web", async () => {
    const g = await call(req("GET", "/api/hosts/me/availability", HOST));
    await call(req("PUT", "/api/hosts/me/availability", HOST, { schedule: { ...g.body.schedule, ...webSched() }, expectedVersion: g.body.schedule.version }));
    raw().prepare("UPDATE hf_availability_schedules SET durations_json='[15,30]' WHERE host_uid=?1").run(HOST); // what an old save left in D1
    expect((await slotsOf()).days[TOMORROW]).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    expect(await webTimes(TOMORROW)).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    expect((await webSlots(TOMORROW, 15)).status).toBe(400);   // only the product's length is offered
    expect((await webSlots(TOMORROW, 15)).body.durationsMinutes).toEqual([10]);
    expect((await book(FAN, "10:30")).status).toBe(201);        // and it can really be booked
    // the app's own editor sees the weekly pattern as open times
    expect((await call(req("GET", "/api/hf/hosts/me/availability", HOST))).body.days[TOMORROW].slots).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  it("U2. web-saved weekly rules show in the app slots; the app then saves and the weekly rules + settings survive", async () => {
    const before = await webSave();
    expect((await slotsLong()).days[NEXT_WEEK]).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    const p = await appSave({ [TOMORROW]: { open: true, slots: ["10:00", "11:00"] }, "2026-10-27": { open: true, slots: ["14:00"] } });
    expect(p.status).toBe(200);
    const after = (await call(req("GET", "/api/hosts/me/availability", HOST))).body.schedule;
    expect(after.rules).toEqual(before.rules);                  // the weekly rules are not wiped
    expect(after).toMatchObject({ slotIntervalMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 60, timezone: "Asia/Kolkata", durationsMinutes: [10] });
    expect(after.horizonDays).toBeGreaterThanOrEqual(14);
    // what she marked in the app is exactly what every fan surface shows ...
    const s = await slotsLong();
    expect(s.days[TOMORROW]).toEqual(["10:00", "11:00"]);       // 10:30 + 11:30 switched off for that date only
    expect(s.days["2026-10-27"]).toEqual(["14:00"]);
    expect(await webTimes(TOMORROW)).toEqual(["10:00", "11:00"]);
    expect(await webTimes("2026-10-27")).toEqual(["14:00"]);
    // ... and next week's weekly pattern is untouched
    expect(s.days[NEXT_WEEK]).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    expect(await webTimes(NEXT_WEEK)).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  it("U3. app-saved dated windows show on the web editor as date overrides, and a web save keeps them (and the app keeps the web's new rule)", async () => {
    expect((await appSave({ [TOMORROW]: { open: true, slots: ["10:00", "11:00"] } })).status).toBe(200);
    const g = await call(req("GET", "/api/hosts/me/availability", HOST));
    expect(g.body.schedule.exceptions.filter((e) => e.date === TOMORROW && e.status === "available").map((e) => e.startMin)).toEqual([600, 660]);
    expect(g.body.schedule.durationsMinutes).toEqual([10]);
    // the web editor saves the whole schedule it loaded, plus a new weekly rule on Monday
    const p = await call(req("PUT", "/api/hosts/me/availability", HOST, {
      schedule: { ...g.body.schedule, rules: [{ weekday: 1, startMin: 900, endMin: 960 }] }, expectedVersion: g.body.schedule.version }));
    expect(p.status).toBe(200);
    const s = await slotsOf();
    expect(s.days[TOMORROW]).toEqual(["10:00", "11:00"]);       // the app-made windows survived the web save
    expect(s.days["2026-10-26"]).toEqual(["15:00", "15:10", "15:20", "15:30", "15:40", "15:50"]); // Monday rule; the schedule began in the app, so its grid is 10 minutes
    expect(await webTimes(TOMORROW)).toEqual(["10:00", "11:00"]);
    expect((await call(req("GET", "/api/hf/hosts/me/availability", HOST))).body.days[TOMORROW].slots).toEqual(["10:00", "11:00"]);
  });

  it("U4. a stale web editor cannot silently overwrite an app save (version check), and vice versa", async () => {
    const g = await call(req("GET", "/api/hosts/me/availability", HOST));
    expect((await appSave({ [TOMORROW]: { open: true, slots: ["10:00"] } })).status).toBe(200);
    const stale = await call(req("PUT", "/api/hosts/me/availability", HOST, { schedule: { ...g.body.schedule, ...webSched() }, expectedVersion: g.body.schedule.version }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("schedule_changed");
    expect((await slotsOf()).days[TOMORROW]).toEqual(["10:00"]);
  });

  it("U5. booked and waiting times stay blocked across both surfaces, and an app save never frees or removes them", async () => {
    await webSave();
    expect((await book(FAN, "10:30")).status).toBe(201);
    expect(await webTimes(TOMORROW)).toEqual(["10:00", "11:00", "11:30"]);
    expect((await slotsOf()).days[TOMORROW]).toEqual(["10:00", "11:00", "11:30"]);
    // she closes the whole day in the app: only the booked time stays on her calendar, nothing else is offered
    const p = await appSave({ [TOMORROW]: { open: false, slots: [] } });
    expect(p.status).toBe(200);
    expect(p.body.days[TOMORROW].slots).toEqual(["10:30"]);
    expect(p.body.booked[TOMORROW]).toEqual(["10:30"]);
    expect((await slotsOf()).days[TOMORROW]).toBeUndefined();
    expect(await webTimes(TOMORROW)).toEqual([]);
    expect(raw().prepare("SELECT status FROM hf_bookings WHERE host_uid=?1").get(HOST).status).toBe("confirmed");
    // a different fan cannot take it, and next week's pattern is still there
    expect((await book(FAN2, "10:30")).status).toBe(409);
    expect(await webTimes(NEXT_WEEK)).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    // the web editor cannot remove the booked time either
    const g = await call(req("GET", "/api/hosts/me/availability", HOST));
    const closed = await call(req("PUT", "/api/hosts/me/availability", HOST, { schedule: { ...g.body.schedule, rules: [], exceptions: [] }, expectedVersion: g.body.schedule.version }));
    expect(closed.status).toBe(409);
  });

  it("U6. a pending request (approval on) blocks the slot on the app and the web alike", async () => {
    flags({ hfBookingApprovalEnabled: true });
    raw().prepare("UPDATE hf_hosts SET booking_approval='manual' WHERE uid=?1").run(HOST);
    await webSave();
    const b = await book(FAN, "11:00");
    expect(b.body.booking.status).toBe("pending_approval");
    expect((await slotsOf()).days[TOMORROW]).toEqual(["10:00", "10:30", "11:30"]);
    expect(await webTimes(TOMORROW)).toEqual(["10:00", "10:30", "11:30"]);
  });

  it("U7. app times that sit back-to-back on a wider web grid are still shown exactly as marked", async () => {
    await webSave();
    const p = await appSave({ [TOMORROW]: { open: true, slots: ["10:00", "10:10", "10:20"] } });
    expect(p.status).toBe(200);
    expect((await slotsOf()).days[TOMORROW]).toEqual(["10:00", "10:10", "10:20"]);
    expect(await webTimes(TOMORROW)).toEqual(["10:00", "10:10", "10:20"]);
    expect(((await call(req("GET", "/api/hosts/me/availability", HOST))).body.schedule.rules)).toEqual(webSched().rules);
  });
});

// ── [HF-CALL-MODES-D] booking lengths 15..300 min, 15-min hold, booked start in any mode ─────────────────────────────────────────────
describe("[HF-CALL-MODES-D] booking lengths, the 15-minute hold and booked start in any mode", () => {
  beforeEach(() => seed(false));
  const LENGTHS = [15, 30, 60, 120, 180, 240, 300];
  const slotsFor = async (len: number | null, uid: string | null = null) =>
    (await call(req("GET", "/api/hf/hosts/tara-sharma/slots?from=2026-10-23&to=2026-10-30" + (len == null ? "" : "&durationMinutes=" + len), uid)));
  const bookingRow = (id: string) => raw().prepare("SELECT * FROM hf_bookings WHERE id=?1").get(id);
  const ledgerNote = (callId: string) => raw().prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").get("hftres:" + callId)?.note;
  function stubCalls() {
    const inits: any[] = [];
    env.HF_CALL = { idFromName: (n: string) => n, get: () => ({ fetch: async (_u: string, init: any) => { inits.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); } }) };
    return inits;
  }

  it("L1. each length only offers the starts it fully covers (open hour chips 10:00-13:00 = one 3-hour window)", async () => {
    flags({ hfBookingLengthsEnabled: true });
    await openDay(["10:00", "11:00", "12:00"]);
    const want: Record<number, string[]> = {
      15: ["10:00", "11:00", "12:00"], 30: ["10:00", "11:00", "12:00"], 60: ["10:00", "11:00", "12:00"],
      120: ["10:00", "11:00"], 180: ["10:00"], 240: [], 300: [],
    };
    for (const len of LENGTHS) {
      const s = await slotsFor(len);
      expect(s.status).toBe(200);
      expect(s.body.days[TOMORROW] ?? [], "length " + len).toEqual(want[len]);
      expect(s.body.minutes).toBe(len);
      expect(s.body.durationsMinutes).toEqual(LENGTHS);
      expect(s.body.holdMinutes).toBe(Math.min(len, 15));
      expect(s.body.holdPaise).toBe(2000 * Math.min(len, 15));
    }
    expect((await slotsFor(null)).body.minutes).toBe(15);        // no length asked -> the shortest
    const bad = await slotsFor(45);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_duration");
    // the web endpoint agrees
    const web = await call(req("GET", "/api/hf/hosts/tara-sharma/availability?from=2026-10-24&to=2026-10-24&durationMinutes=120", null));
    expect(web.body.slots.map((x: any) => x.startUtc)).toEqual(["10:00", "11:00"].map((h) => new Date(at(h)).toISOString()));
    expect(web.body.durationsMinutes).toEqual(LENGTHS);
  });

  it("L2. a booked long call blocks every start it overlaps for every other length", async () => {
    flags({ hfBookingLengthsEnabled: true });
    await openDay(["10:00", "11:00", "12:00"]);
    expect((await book(FAN, "10:00", { durationMinutes: 120 })).status).toBe(201);   // 10:00-12:00
    expect((await slotsFor(60, FAN2)).body.days[TOMORROW]).toEqual(["12:00"]);
    expect((await slotsFor(15, FAN2)).body.days[TOMORROW]).toEqual(["12:00"]);
    expect((await slotsFor(120, FAN2)).body.days[TOMORROW] ?? []).toEqual([]);
    expect((await book(FAN2, "11:00", { durationMinutes: 15 })).status).toBe(409);
    expect((await book(FAN2, "12:00", { durationMinutes: 60 })).status).toBe(201);
  });

  it("L3. a 120-minute booking holds only 15 minutes; cancel, host cancel and decline each give exactly that hold back once", async () => {
    flags({ hfBookingLengthsEnabled: true });
    await openDay(["10:00", "11:00", "12:00"]);
    const b = await book(FAN, "10:00", { durationMinutes: 120 });
    expect(b.status).toBe(201);
    expect(b.body.booking).toMatchObject({ minutes: 120, holdMinutes: 15, holdPaise: 2000 * 15 });
    const row = bookingRow(b.body.booking.id);
    expect(row).toMatchObject({ duration_min: 120, hold_seconds: 900, reserved_paise: 30000 });
    expect(row.ends_at - row.starts_at).toBe(120 * 60_000);
    expect(ledgerNote(row.call_id)).toBe("secs:900");
    const held = reservedOf(FAN);
    expect(held).toBeGreaterThan(0);
    // the same fan's 10-minute-style comparison: 15 minutes of reservation, not 120
    const b2 = await book(FAN2, "12:00", { durationMinutes: 60 });
    expect(reservedOf(FAN2)).toBe(held);                        // a 60-minute booking holds the same 15 minutes
    expect(b2.body.booking.holdMinutes).toBe(15);
    // fan cancels the 120: hold released, once
    const id = b.body.booking.id;
    expect((await call(req("DELETE", "/api/hf/bookings/" + id, FAN))).status).toBe(200);
    expect(reservedOf(FAN)).toBe(0);
    await call(req("DELETE", "/api/hf/bookings/" + id, FAN));
    await call(req("POST", `/api/hf/bookings/${id}/cancel`, FAN, {}));
    expect(reservedOf(FAN)).toBe(0);
    expect(raw().prepare("SELECT COUNT(*) c FROM hf_token_ledger WHERE op_id=?1").get("hftrel:" + row.call_id).c).toBe(1);
    // host cancels the 60: the fan gets the hold back
    expect((await call(req("DELETE", "/api/hf/bookings/" + b2.body.booking.id, HOST))).status).toBe(200);
    expect(reservedOf(FAN2)).toBe(0);
  });

  it("L4. decline and expiry (approval on) refund the 15-minute hold exactly once", async () => {
    flags({ hfBookingLengthsEnabled: true, hfBookingApprovalEnabled: true });
    raw().prepare("UPDATE hf_hosts SET booking_approval='manual' WHERE uid=?1").run(HOST);
    await openDay(["10:00", "11:00", "12:00"]);
    const p1 = await book(FAN, "10:00", { durationMinutes: 180 });
    expect(p1.body.booking.status).toBe("pending_approval");
    expect(p1.body.booking.holdMinutes).toBe(15);
    const held = reservedOf(FAN);
    expect(held).toBeGreaterThan(0);
    expect((await call(req("POST", `/api/hf/bookings/${p1.body.booking.id}/decline`, HOST, {}))).status).toBe(200);
    expect(reservedOf(FAN)).toBe(0);
    await call(req("POST", `/api/hf/bookings/${p1.body.booking.id}/decline`, HOST, {}));
    expect(reservedOf(FAN)).toBe(0);
    const p2 = await book(FAN2, "11:00", { durationMinutes: 120 });
    expect(reservedOf(FAN2)).toBe(held);
    vi.setSystemTime(at("10:30"));
    await runHfBookingApprovalExpiry(env, Date.now());
    await runHfBookingApprovalExpiry(env, Date.now());
    expect(raw().prepare("SELECT status FROM hf_bookings WHERE id=?1").get(p2.body.booking.id).status).toBe("cancelled");
    expect(reservedOf(FAN2)).toBe(0);
  });

  it("L5. legacy rows (hold_seconds NULL, made before lengths) still cancel after the flag is turned on", async () => {
    flags({});
    await openDay(["10:00", "11:00"]);
    const b = await book(FAN, "10:00");
    expect(b.status).toBe(201);
    const id = b.body.booking.id;
    expect(bookingRow(id).hold_seconds).toBeNull();
    expect(bookingRow(id).duration_min).toBe(10);
    const held = reservedOf(FAN);
    expect(held).toBeGreaterThan(0);
    flags({ hfBookingLengthsEnabled: true });
    const list = await call(req("GET", "/api/hf/bookings?role=fan", FAN));
    expect(list.body.bookings[0]).toMatchObject({ minutes: 10, holdPaise: 20000 });
    expect(list.body.bookings[0].holdMinutes).toBeUndefined();
    expect((await call(req("DELETE", "/api/hf/bookings/" + id, FAN))).status).toBe(200);
    expect(reservedOf(FAN)).toBe(0);
  });

  it("L6. an app POST with no durationMinutes books 15 minutes when lengths are on, 10 when off (and off ignores any length)", async () => {
    flags({ hfBookingLengthsEnabled: true });
    await openDay(["10:00", "11:00", "12:00"]);
    const on = await book(FAN, "10:00");
    expect(on.status).toBe(201);
    expect(on.body.booking).toMatchObject({ minutes: 15, holdMinutes: 15, holdPaise: 30000 });
    expect((await book(FAN2, "11:00", { durationMinutes: 45 })).status).toBe(400);

    env = makeEnv(); seed(false); flags({});
    await openDay(["10:00", "11:00", "12:00"]);
    const off = await book(FAN, "10:00", { durationMinutes: 60 });          // an off server never sells 60
    expect(off.status).toBe(201);
    expect(off.body.booking).toMatchObject({ minutes: 10, holdPaise: 20000 });
    expect(off.body.booking.holdMinutes).toBeUndefined();
    expect(bookingRow(off.body.booking.id)).toMatchObject({ duration_min: 10, hold_seconds: null, reserved_paise: 20000 });
  });

  it("L7. flag OFF: web schedule save/slots stay at [10]; ON: the 15..300 list", async () => {
    flags({});
    const g = await call(req("GET", "/api/hosts/me/availability", HOST));
    expect(g.body.schedule.durationsMinutes).toEqual([10]);
    flags({ hfBookingLengthsEnabled: true });
    const g2 = await call(req("GET", "/api/hosts/me/availability", HOST));
    expect(g2.body.schedule.durationsMinutes).toEqual(LENGTHS);
    const saved = await call(req("PUT", "/api/hosts/me/availability", HOST, { expectedVersion: 0, schedule: { ...g2.body.schedule, durationsMinutes: [10], rules: [{ weekday: new Date(at("10:00")).getUTCDay(), startMin: 600, endMin: 780 }] } }));
    expect(saved.status).toBe(200);
    expect(saved.body.schedule.durationsMinutes).toEqual(LENGTHS);       // the server decides the lengths, not the page
  });

  async function bookAndGoToStart(extra: Record<string, unknown>, hhmm = "10:00") {
    const b = await book(FAN, hhmm, extra);
    expect(b.status).toBe(201);
    vi.setSystemTime(at(hhmm) - 60_000);
    return b.body.booking.id as string;
  }

  it("S1. a confirmed booking rings in Bookings-only / Offline mode (it used to need presence=online); the line is taken, presence untouched", async () => {
    flags({ hfBookingLengthsEnabled: true, hfCallChunkBillingEnabled: true });
    await openDay(["10:00", "11:00", "12:00"]);
    const inits = stubCalls();
    const id = await bookAndGoToStart({ durationMinutes: 120 });
    raw().prepare("UPDATE hf_hosts SET presence='offline' WHERE uid=?1").run(HOST);
    const s = await call(req("POST", `/api/hf/bookings/${id}/start`, FAN, {}));
    expect(s.status).toBe(201);
    const row = bookingRow(id);
    expect(row.status).toBe("starting");
    const host = raw().prepare("SELECT presence,presence_call_id FROM hf_hosts WHERE uid=?1").get(HOST);
    expect(host).toMatchObject({ presence: "offline", presence_call_id: row.call_id });
    // what the call engine is told (Lane C contract): hold funded up front, the booking end is the hard stop, chunked past the hold
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ callId: row.call_id, bookingId: id, hardEndsAt: row.ends_at, maxMinutes: 120 });
    expect(inits[0].tokens).toMatchObject({ booked: true, maxSeconds: 900, chunked: true, fundedSec: 900, source: "booking" });
  });

  it("S2. same in 'busy-looking' states: a different call holding the line still refuses, so two calls never share her", async () => {
    flags({ hfBookingLengthsEnabled: true });
    await openDay(["10:00", "11:00", "12:00"]);
    stubCalls();
    const id = await bookAndGoToStart({ durationMinutes: 60 });
    raw().prepare("UPDATE hf_hosts SET presence='online', presence_call_id='some-other-call' WHERE uid=?1").run(HOST);
    const s = await call(req("POST", `/api/hf/bookings/${id}/start`, FAN, {}));
    expect(s.status).toBe(409);
    expect(s.body.error).toBe("host_unavailable");
    expect(bookingRow(id).status).toBe("confirmed");
  });

  it("S3. chunk engine OFF: a long booking can only be funded for its hold, so the call is capped at the hold and carries no chunk fields", async () => {
    flags({ hfBookingLengthsEnabled: true });
    await openDay(["10:00", "11:00", "12:00"]);
    const inits = stubCalls();
    const id = await bookAndGoToStart({ durationMinutes: 60 });
    expect((await call(req("POST", `/api/hf/bookings/${id}/start`, FAN, {}))).status).toBe(201);
    expect(inits[0].tokens.maxSeconds).toBe(900);
    expect(inits[0].tokens.chunked).toBeUndefined();
  });

  it("S4. flag OFF regression: a 10-minute booking starts exactly as before (online host -> busy, maxSeconds 600, no chunk fields)", async () => {
    flags({});
    await openDay(["10:00", "11:00"]);
    const inits = stubCalls();
    const id = await bookAndGoToStart({});
    raw().prepare("UPDATE hf_hosts SET presence='online' WHERE uid=?1").run(HOST);
    expect((await call(req("POST", `/api/hf/bookings/${id}/start`, FAN, {}))).status).toBe(201);
    const row = bookingRow(id);
    expect(raw().prepare("SELECT presence,presence_call_id FROM hf_hosts WHERE uid=?1").get(HOST)).toMatchObject({ presence: "busy", presence_call_id: row.call_id });
    expect(inits[0]).toMatchObject({ hardEndsAt: row.ends_at, maxMinutes: 10 });
    expect(inits[0].tokens).toMatchObject({ booked: true, maxSeconds: 600 });
    expect(inits[0].tokens.chunked).toBeUndefined();
  });

  it("S5. a legacy 10-minute booking (hold_seconds NULL) still starts after the lengths flag is turned on", async () => {
    flags({});
    await openDay(["10:00", "11:00"]);
    const inits = stubCalls();
    const id = await bookAndGoToStart({});
    flags({ hfBookingLengthsEnabled: true, hfCallChunkBillingEnabled: true });
    expect((await call(req("POST", `/api/hf/bookings/${id}/start`, FAN, {}))).status).toBe(201);
    expect(inits[0].tokens).toMatchObject({ maxSeconds: 600 });
    expect(inits[0].tokens.chunked).toBeUndefined();     // hold already covers the whole booking: nothing to chunk
  });
});
