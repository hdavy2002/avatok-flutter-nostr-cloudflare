// @ts-nocheck -- uses node:sqlite (via the D1 shim), which the worker tsconfig has no types for
// [HF-BOOK-APPROVE-BE] Booking approval against the REAL ledger/booking SQL (in-memory SQLite behind the D1 shim):
// accept / decline / expiry refund exactly once, races, the nudge, messages, flag-off expiry, monitor.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
vi.mock("../routes/config", () => ({ readConfig: async () => cfg }));
const events: any[] = [];
vi.mock("../hooks", () => ({
  track: async (_e: any, uid: string, event: string, _a: string, props: any) => { events.push({ uid, event, ...props }); },
  trackUser: async (_e: any, uid: string, _m: any, event: string, _a: string, props: any) => { events.push({ uid, event, ...props }); },
  trackException: async () => {},
}));
const pushes: any[] = [];
vi.mock("./hf_push", () => ({ sendHfPush: async (_e: any, uid: string, m: any) => { pushes.push({ uid, ...m }); return true; } }));
const numbers: Record<string, string | null> = {};
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async (_e: any, uid: string) => numbers[uid] ?? null }));
const emails: any[] = [];
vi.mock("./email_outbox", () => ({ enqueueEmail: async (_e: any, m: any) => { emails.push(m); return { status: "queued", queued: true, durable: true }; } }));
vi.mock("./identity", () => ({ emailFor: async (_e: any, uid: string) => (uid === "fan" ? "fan@example.com" : uid === "host" ? "host@example.com" : null) }));

import { makeDb } from "./hf_token_d1_shim";
import { creditLot, reserveForCall } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";
import {
  acceptPending, approvalDeadline, approvalOn, cancelPending, declinePending, messageFor, parseTopics, runHfBookingApprovalExpiry, tooSoonForApproval,
  APPROVAL_WINDOW_MS,
} from "./hf_booking_approval";
import { runHfMoneyMonitor } from "./hf_money_monitor";
import { releaseHfBookingsForUser } from "./hf_booking_store";

const HOUR = 3_600_000, MIN = 60_000;
const NOW = Date.UTC(2026, 9, 21, 6, 0); // 11:30 IST
let env: any, raw: any;

beforeEach(() => {
  cfg = { hfBookingApprovalEnabled: true, hfBookingsEnabled: true, hfCallsEnabled: true };
  events.length = 0; pushes.length = 0; emails.length = 0;
  Object.assign(numbers, { fan: "+919000000001", host: "+919000000002" });
  const db = makeDb(["2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-09-hf-calls.sql", "2026-10-10-hf-tokens.sql"], { alters: true });
  // The bookings migration CREATEs an index on a column its own ALTER adds, so apply ALTERs first (as scripts/d1_apply_alters.py would), then the rest.
  for (const f of ["2026-10-13-hf-bookings.sql", "2026-10-20-hf-booking-approval-alters.sql", "2026-10-20-hf-booking-approval.sql"]) {
    const lines = readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8").split("\n");
    for (const l of lines.filter((x) => x.trim().startsWith("ALTER TABLE"))) db._raw.exec(l.replace(/--.*$/, ""));
    db._raw.exec(lines.filter((x) => !x.trim().startsWith("ALTER TABLE")).join("\n"));
  }
  raw = db._raw;
  raw.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE hf_user_prefs (uid TEXT PRIMARY KEY, notify_whatsapp INTEGER NOT NULL DEFAULT 1, appt_reminders INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE calendar_blocks (id TEXT PRIMARY KEY, user_id TEXT, source_app TEXT, source_ref TEXT, starts_at INTEGER, ends_at INTEGER, title TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE hf_money_audit (id TEXT PRIMARY KEY, kind TEXT, subject_type TEXT, subject_id TEXT, rule TEXT, status TEXT, uid TEXT, host_uid TEXT, expected_paise INTEGER, actual_paise INTEGER, detail TEXT, fix_op_id TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(subject_type, subject_id, rule));
    CREATE TABLE whatsapp_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, checkout_id TEXT NOT NULL, uid TEXT NOT NULL, listing_id TEXT NOT NULL, kind TEXT NOT NULL,
      url_hash TEXT NOT NULL, e164 TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (checkout_id, kind, url_hash));
    INSERT INTO users VALUES ('fan','Ravi Kumar'),('host','Kavya');
    INSERT INTO hf_hosts (uid,slug,status,display_name,topics_json,created_at,updated_at) VALUES ('host','kavya-ab12','live','Kavya','["just-friendship","general-advice"]',1,1);
  `);
  env = { DB_META: db };
});

/** A pending booking with a REAL hold: Rs 200 reserved from a Rs 300 lot, occupancy + calendar rows like confirmRoute writes. */
async function seed(id = "b1", o: { startsIn?: number; createdAgo?: number; deadline?: number } = {}) {
  const callId = "call-" + id;
  await creditLot(env, "fan", { kind: "purchase", pricingVersion: "pt-v1", valuePaisePerToken: 100, micro: 300 * MICRO, paidPaise: 30000, provider: "google_play", providerRef: "o-" + id }, "op-" + id);
  const r = await reserveForCall(env, "fan", callId, 2000, 600);
  expect(r.ok).toBe(true);
  const startsAt = NOW + (o.startsIn ?? 30 * HOUR);
  const createdAt = NOW - (o.createdAgo ?? 0);
  const deadline = o.deadline ?? approvalDeadline(createdAt, startsAt);
  raw.prepare(`INSERT INTO hf_bookings (id,host_uid,customer_uid,starts_at,ends_at,host_timezone,schedule_version,quote_id,idempotency_key,status,duration_min,reserved_paise,
      expected_host_net_paise,price_snapshot_json,policy_snapshot_json,reservation_snapshot_json,call_id,settlement_status,created_at,updated_at,topic_slug,approval_deadline)
    VALUES (?,?,?,?,?,?,1,?,?,'pending_approval',10,20000,9000,'{}','{}','{}',?,'held',?,?,?,?)`)
    .run(id, "host", "fan", startsAt, startsAt + 10 * MIN, "Asia/Kolkata", "q-" + id, "k-" + id, callId, createdAt, createdAt, "just-friendship", deadline);
  for (const u of ["host", "fan"]) {
    raw.prepare("INSERT INTO hf_booking_occupancy VALUES (?,?,?,?, 'busy', 1, 1)").run(id, u, startsAt, startsAt + 10 * MIN);
    raw.prepare("INSERT INTO calendar_blocks VALUES (?,?, 'hf_booking', ?,?,?,NULL,'busy',1)").run(`hfb:${id}:${u}`, u, id, startsAt, startsAt + 10 * MIN);
  }
  return { id, callId, startsAt, deadline };
}
const booking = (id = "b1") => raw.prepare("SELECT * FROM hf_bookings WHERE id=?").get(id);
const reserved = () => Number(raw.prepare("SELECT COALESCE(SUM(tokens_reserved_micro),0) AS n FROM hf_token_lots WHERE uid='fan'").get().n);
const releases = (callId: string) => Number(raw.prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE op_id=? AND kind='release'").get("hftrel:" + callId).n);
const outbox = () => raw.prepare("SELECT uid,kind,url_hash,message FROM whatsapp_outbox ORDER BY id").all();
const occupancy = (id = "b1") => raw.prepare("SELECT status FROM hf_booking_occupancy WHERE booking_id=?").all(id).map((r: any) => r.status);

describe("deadline and notice rules", () => {
  it("deadline is the earlier of created+24h and start-1h", () => {
    expect(approvalDeadline(NOW, NOW + 48 * HOUR)).toBe(NOW + APPROVAL_WINDOW_MS);
    expect(approvalDeadline(NOW, NOW + 5 * HOUR)).toBe(NOW + 4 * HOUR);
  });
  it("manual approval needs 2 h notice, auto does not", () => {
    expect(tooSoonForApproval("manual", NOW + 119 * MIN, NOW)).toBe(true);
    expect(tooSoonForApproval("manual", NOW + 2 * HOUR, NOW)).toBe(false);
    expect(tooSoonForApproval("auto", NOW + 10 * MIN, NOW)).toBe(false);
  });
  it("flag reads off by default and parseTopics keeps only catalogue slugs", async () => {
    cfg = {};
    expect(await approvalOn(env)).toBe(false);
    cfg = { hfBookingApprovalEnabled: true };
    expect(await approvalOn(env)).toBe(true);
    expect(parseTopics('["just-friendship","nope","just-friendship"]').map((t) => t.slug)).toEqual(["just-friendship"]);
    expect(parseTopics("garbage")).toEqual([]);
  });
});

describe("accept", () => {
  it("confirms, keeps the hold and the slot, tells both, and cannot be accepted or declined again", async () => {
    await seed();
    const out = await acceptPending(env, "b1", "host", NOW);
    expect(out.ok).toBe(true);
    expect(booking()).toMatchObject({ status: "confirmed", decided_by: "host", approved_at: NOW, settlement_status: "held" });
    expect(reserved()).toBeGreaterThan(0);
    expect(occupancy()).toEqual(["busy", "busy"]);
    expect(outbox().map((r: any) => r.uid).sort()).toEqual(["fan", "host"]);
    expect(events.find((e) => e.event === "hf_booking_accepted")).toMatchObject({ host_uid: "host", fan_uid: "fan", host_email: "host@example.com", fan_email: "fan@example.com" });
    expect(await acceptPending(env, "b1", "host", NOW)).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await declinePending(env, "b1", "host", NOW)).toMatchObject({ ok: false, reason: "not_pending" });
    expect(releases("call-b1")).toBe(0);
  });
  it("only the booking's own influencer can decide", async () => {
    await seed();
    expect(await acceptPending(env, "b1", "someone-else", NOW)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await declinePending(env, "b1", "someone-else", NOW)).toMatchObject({ ok: false, reason: "not_found" });
    expect(booking().status).toBe("pending_approval");
  });
  it("accepting after the deadline refunds instead (lazy expiry) and says expired", async () => {
    const s = await seed();
    const out = await acceptPending(env, "b1", "host", s.deadline + MIN);
    expect(out).toMatchObject({ ok: false, reason: "expired" });
    expect(booking()).toMatchObject({ status: "cancelled", cancel_reason: "not_accepted_24h" });
    expect(reserved()).toBe(0);
    expect(releases("call-b1")).toBe(1);
  });
});

describe("decline", () => {
  it("cancels, releases the whole hold to the wallet once, frees the slot, tells the fan, and is idempotent", async () => {
    await seed();
    const out = await declinePending(env, "b1", "host", NOW);
    expect(out.ok).toBe(true);
    expect(booking()).toMatchObject({ status: "cancelled", settlement_status: "released", cancel_reason: "declined", decided_by: "host" });
    expect(reserved()).toBe(0);
    expect(releases("call-b1")).toBe(1);
    expect(occupancy()).toEqual(["cancelled", "cancelled"]);
    expect(raw.prepare("SELECT status FROM calendar_blocks WHERE source_ref='b1'").all().every((r: any) => r.status === "cancelled")).toBe(true);
    expect(raw.prepare("SELECT operation_id FROM hf_booking_events WHERE booking_id='b1'").all().map((r: any) => r.operation_id)).toContain("hfbook-decline:b1");
    const fanMsgs = outbox().filter((r: any) => r.uid === "fan");
    expect(fanMsgs).toHaveLength(1);
    expect(fanMsgs[0].message).toMatch(/₹200/);
    expect(outbox().filter((r: any) => r.uid === "host")).toHaveLength(1);
    const again = await declinePending(env, "b1", "host", NOW + MIN);
    expect(again).toMatchObject({ ok: true, already: true });
    expect(releases("call-b1")).toBe(1);
    expect(outbox()).toHaveLength(2);
    expect(await acceptPending(env, "b1", "host", NOW)).toMatchObject({ ok: false, reason: "not_pending" });
  });
});

describe("expiry cron", () => {
  it("does nothing before the deadline", async () => {
    await seed();
    expect(await runHfBookingApprovalExpiry(env, NOW)).toMatchObject({ scanned: 0, expired: 0 });
    expect(booking().status).toBe("pending_approval");
  });
  it("cancels after the deadline, refunds exactly once across repeated runs, tells both, records the event", async () => {
    const s = await seed();
    const r1 = await runHfBookingApprovalExpiry(env, s.deadline + MIN);
    expect(r1).toMatchObject({ scanned: 1, expired: 1 });
    expect(booking()).toMatchObject({ status: "cancelled", settlement_status: "released", cancel_reason: "not_accepted_24h", decided_by: "system" });
    expect(reserved()).toBe(0);
    expect(releases("call-b1")).toBe(1);
    await runHfBookingApprovalExpiry(env, s.deadline + 2 * MIN);
    await runHfBookingApprovalExpiry(env, s.deadline + 10 * MIN);
    expect(releases("call-b1")).toBe(1);
    expect(outbox()).toHaveLength(2);
    expect(emails.map((e) => e.outboxKey).sort()).toEqual(["hf-book:b1:expired:fan", "hf-book:b1:expired:host"]);
    const refunded = events.filter((e) => e.event === "hf_booking_expired_refunded");
    expect(refunded).toHaveLength(1);
    expect(refunded[0]).toMatchObject({ amount_paise: 20000, fan_uid: "fan", host_uid: "host" });
    expect(raw.prepare("SELECT operation_id FROM hf_booking_events WHERE booking_id='b1'").all().map((r: any) => r.operation_id)).toContain("hfbook-expire:b1");
  });
  it("still runs (and refunds) with the approval flag switched OFF: a hold is never stranded", async () => {
    const s = await seed();
    cfg = {};
    expect((await runHfBookingApprovalExpiry(env, s.deadline + MIN)).expired).toBe(1);
    expect(releases("call-b1")).toBe(1);
  });
  it("expiry and a host decline racing: exactly one outcome and exactly one refund", async () => {
    const s = await seed();
    const [a, b] = await Promise.all([
      runHfBookingApprovalExpiry(env, s.deadline + MIN),
      declinePending(env, "b1", "host", s.deadline - MIN), // host acts a minute before the deadline while the cron fires
    ]);
    expect(releases("call-b1")).toBe(1);
    expect(reserved()).toBe(0);
    const row = booking();
    expect(row.status).toBe("cancelled");
    expect(["declined", "not_accepted_24h"]).toContain(row.cancel_reason);
    // whichever lost sent nothing: exactly one pair of messages (fan + host)
    expect(outbox()).toHaveLength(2);
    expect(a.expired + (b.ok && !b.already ? 1 : 0)).toBe(1);
  });
  it("accept and decline racing: exactly one wins; a decline win refunds once, an accept win refunds nothing", async () => {
    await seed();
    const [acc, dec] = await Promise.all([acceptPending(env, "b1", "host", NOW), declinePending(env, "b1", "host", NOW)]);
    expect(Number(acc.ok) + Number(dec.ok)).toBe(1);
    const row = booking();
    if (acc.ok) { expect(row.status).toBe("confirmed"); expect(releases("call-b1")).toBe(0); expect(reserved()).toBeGreaterThan(0); }
    else { expect(row.status).toBe("cancelled"); expect(releases("call-b1")).toBe(1); expect(reserved()).toBe(0); }
  });
  it("a fan's own cancel racing the cron: one refund, and the cron sends no 'expired' message", async () => {
    const s = await seed();
    // simulate the fan's cancel landing first through the same release path the cancel route uses
    expect(await cancelPending(env, "b1", "declined", "host", "hfbook-decline:b1", NOW, "host")).toBe("done");
    raw.prepare("UPDATE hf_bookings SET cancel_reason='fan', decided_by='fan' WHERE id='b1'").run();
    const before = outbox().length;
    await runHfBookingApprovalExpiry(env, s.deadline + MIN);
    expect(releases("call-b1")).toBe(1);
    expect(outbox().length).toBe(before);
  });
  it("account exit releases pending bookings too", async () => {
    await seed();
    const r = await releaseHfBookingsForUser(env, "fan", "account_exit", NOW);
    expect(r).toMatchObject({ processed: 1, blocked: 0 });
    expect(booking()).toMatchObject({ status: "cancelled", settlement_status: "released" });
    expect(releases("call-b1")).toBe(1);
  });
});

describe("still-waiting nudge", () => {
  it("goes to the influencer only, once, about 4 h before the deadline", async () => {
    const s = await seed("n1");
    expect((await runHfBookingApprovalExpiry(env, s.deadline - 5 * HOUR)).nudged).toBe(0);
    const at = s.deadline - 3 * HOUR;
    expect((await runHfBookingApprovalExpiry(env, at)).nudged).toBe(1);
    expect((await runHfBookingApprovalExpiry(env, at + 5 * MIN)).nudged).toBe(0);
    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uid: "host", kind: "hf_booking_nudge" });
    expect(rows[0].message).toMatch(/24-hour rule/);
    expect(pushes.filter((p) => p.kind === "booking_nudge")).toHaveLength(1);
  });
  it("is skipped when the whole window is short (nothing to wait 'still' for)", async () => {
    const s = await seed("n2", { startsIn: 5 * HOUR }); // deadline = start-1h = 4h after creation
    expect((await runHfBookingApprovalExpiry(env, s.deadline - 2 * HOUR)).nudged).toBe(0);
  });
});

describe("messages", () => {
  const facts = { id: "b1", host_uid: "host", customer_uid: "fan", starts_at: NOW + 30 * HOUR, reserved_paise: 20000, topic_slug: "just-friendship",
    approval_deadline: NOW + 24 * HOUR, host_name: "Kavya", fan_name: "9876543210 Ravi" };
  it("every request message states the 24-hour rule; the influencer sees the caller's handle and topic, never a number", () => {
    const fan = messageFor("request", "fan", facts), host = messageFor("request", "host", facts);
    expect(fan.text).toMatch(/24 hours/); expect(host.text).toMatch(/24 hours/);
    expect(fan.push.body).toMatch(/24 hours/); expect(host.push.body).toMatch(/24 hours/);
    expect(host.text).toContain("Just friendship");
    expect(host.text).toContain("A fan"); // the digits-bearing name falls back to the neutral handle
    for (const m of [fan, host]) { expect(m.text).not.toMatch(/\d{10}/); expect(m.push.body.length).toBeLessThanOrEqual(160); expect(m.push.title.length).toBeLessThanOrEqual(60); }
  });
  it("a block gets the neutral wording and no names", () => {
    const m = messageFor("expired", "fan", facts, { hidePeer: true });
    expect(m.text).toContain("the influencer");
    expect(m.text).not.toContain("Kavya");
  });
  it("no 30-minute reminder text anywhere", () => {
    for (const ev of ["request", "accepted", "declined", "expired", "nudge"] as const) for (const side of ["fan", "host"] as const) expect(messageFor(ev, side, facts).text).not.toMatch(/30 min/);
  });
  it("a block: nothing goes to the influencer, the caller gets the neutral message; switched-off users get nothing", async () => {
    await seed();
    raw.prepare("INSERT INTO hf_blocks VALUES ('host','fan','x',1)").run();
    await declinePending(env, "b1", "host", NOW);
    expect(outbox().map((r: any) => r.uid)).toEqual(["fan"]);
    expect(outbox()[0].message).not.toContain("Kavya");
  });
  it("respects the Appointment-reminders switch and verified WhatsApp", async () => {
    await seed();
    raw.prepare("INSERT INTO hf_user_prefs (uid, appt_reminders) VALUES ('host',0)").run();
    numbers.fan = null;
    await declinePending(env, "b1", "host", NOW);
    expect(outbox()).toHaveLength(0);
    expect(emails.map((e) => e.recipientId)).toEqual(["fan"]); // no WhatsApp number, but the fan still gets the email
  });
});

describe("money monitor", () => {
  it("expires a pending booking left 15 min past its deadline and records it", async () => {
    const s = await seed();
    const out = await runHfMoneyMonitor(env, s.deadline + 16 * MIN);
    expect(out.fixed).toBeGreaterThanOrEqual(1);
    expect(booking()).toMatchObject({ status: "cancelled", cancel_reason: "not_accepted_24h" });
    expect(releases("call-b1")).toBe(1);
    expect(raw.prepare("SELECT rule,status FROM hf_money_audit WHERE subject_id='b1'").get()).toMatchObject({ rule: "booking_pending_past_deadline", status: "fixed" });
  });
  it("flags a declined booking that has no release in the ledger", async () => {
    await seed();
    raw.prepare("UPDATE hf_bookings SET status='cancelled', cancel_reason='declined', settlement_status='released', updated_at=? WHERE id='b1'").run(NOW);
    const out = await runHfMoneyMonitor(env, NOW + MIN);
    expect(out.flagged).toBeGreaterThanOrEqual(1);
    expect(raw.prepare("SELECT rule,status FROM hf_money_audit WHERE subject_id='b1'").get()).toMatchObject({ rule: "booking_declined_or_expired_without_release", status: "open" });
  });
});
