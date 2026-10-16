// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-APPT-REMIND-1] Appointment reminders: windows, both people, idempotency, switches, blocks and the pre-send check.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

let cfg: Record<string, unknown> = {};
vi.mock("../routes/config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
const pushes: any[] = [];
vi.mock("./hf_push", () => ({ sendHfPush: async (_e: any, uid: string, m: any) => { pushes.push({ uid, ...m }); return true; } }));
const numbers: Record<string, string | null> = {};
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async (_e: any, uid: string) => numbers[uid] ?? null }));

import { runHfBookingReminders, revalidateBookingReminder, reminderText } from "./hf_booking_reminders";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;
const MIN = 60_000, NOW = Date.UTC(2026, 9, 16, 12, 0);

beforeEach(() => {
  cfg = {}; pushes.length = 0;
  Object.assign(numbers, { cust: "+919000000001", host: "+919000000002" });
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, display_name TEXT);
    CREATE TABLE hf_bookings (id TEXT PRIMARY KEY, host_uid TEXT, customer_uid TEXT, starts_at INTEGER, status TEXT, cancelled_at INTEGER);
    CREATE TABLE hf_blocks (blocker_uid TEXT, blocked_uid TEXT, call_id TEXT, created_at INTEGER);
    CREATE TABLE hf_user_prefs (uid TEXT PRIMARY KEY, notify_whatsapp INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
    CREATE TABLE whatsapp_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, checkout_id TEXT NOT NULL, uid TEXT NOT NULL, listing_id TEXT NOT NULL, kind TEXT NOT NULL,
      url_hash TEXT NOT NULL, e164 TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (checkout_id, kind, url_hash));
  `);
  db.exec(require_("node:fs").readFileSync(new URL("../../migrations/2026-10-16-hf-appt-reminders.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users VALUES ('cust','Ravi Kumar'); INSERT INTO hf_hosts VALUES ('host','kavya','Kavya');`);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) } };
});
const book = (id: string, mins: number, status = "confirmed") => db.prepare("INSERT INTO hf_bookings VALUES (?,?,?,?,?,NULL)").run(id, "host", "cust", NOW + mins * MIN, status);
const rows = () => db.prepare("SELECT uid, url_hash, message FROM whatsapp_outbox ORDER BY id").all();

describe("runHfBookingReminders", () => {
  it("queues the 1-hour reminder to both people, once", async () => {
    book("bk_1", 60);
    expect((await runHfBookingReminders(env, NOW)).queued).toBe(2);
    expect((await runHfBookingReminders(env, NOW + 5 * MIN)).queued).toBe(0); // same window again: no duplicate
    const r = rows();
    expect(r.map((x: any) => [x.uid, x.url_hash])).toEqual([["cust", "t60"], ["host", "t60"]]);
    expect(r[0].message).toContain("your call with Kavya");
    expect(r[1].message).not.toContain("Ravi Kumar"); // the influencer sees a handle, never the full name or number
    expect(pushes).toHaveLength(2);
  });
  it("queues the 10-minute reminder and skips bookings outside the windows or cancelled", async () => {
    book("bk_2", 8); book("bk_3", 30); book("bk_4", 9, "cancelled");
    await runHfBookingReminders(env, NOW);
    expect(rows().map((x: any) => x.url_hash)).toEqual(["t10", "t10"]);
  });
  it("respects the switch, the person's pref, blocks and a missing WhatsApp number", async () => {
    book("bk_5", 60);
    cfg = { hfBookingRemindersEnabled: false };
    expect((await runHfBookingReminders(env, NOW)).queued).toBe(0);
    cfg = {};
    db.exec("INSERT INTO hf_user_prefs (uid, notify_whatsapp, appt_reminders, updated_at) VALUES ('host',1,0,1)");
    numbers.cust = null;
    expect((await runHfBookingReminders(env, NOW)).queued).toBe(0);
    numbers.cust = "+919000000001";
    db.exec("INSERT INTO hf_blocks VALUES ('cust','host',NULL,1)");
    expect((await runHfBookingReminders(env, NOW)).queued).toBe(0);
  });
});

describe("revalidateBookingReminder", () => {
  it("only while the booking is still on, in the future and the number unchanged", async () => {
    book("bk_6", 60);
    const row = { uid: "cust", listing_id: "bk_6", e164: "+919000000001" };
    expect(await revalidateBookingReminder(env, row, NOW)).toBe("eligible");
    expect(await revalidateBookingReminder(env, { ...row, e164: "+910000000000" }, NOW)).toBe("cancelled");
    db.exec("UPDATE hf_bookings SET status='cancelled', cancelled_at=1 WHERE id='bk_6'");
    expect(await revalidateBookingReminder(env, row, NOW)).toBe("cancelled");
  });
  it("text is plain and links to the appointment", () => {
    expect(reminderText("customer", "Kavya", NOW, "t10", "bk_7")).toMatch(/in about 10 minutes.*\/bookings\/bk_7/);
  });
});
