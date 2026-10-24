// @ts-nocheck -- uses node:sqlite (via the D1 shim), which the worker tsconfig has no types for
// [HF-BOOK-APPROVE-BE] The REAL confirm / cancel SQL with the approval flag: manual -> pending_approval (hold + slot blocked), auto -> confirmed,
// flag off -> exactly the old statements (proved by running them on a database WITHOUT the new columns), too-soon, topic, fan cancel of a pending booking.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let who = "fan";
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: who }), isFail: (v: unknown) => v instanceof Response }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../lib/hf_demo", () => ({ isDemoHost: async () => false, DEMO_MESSAGE: "demo" }));
vi.mock("../lib/hf_exit", () => ({ isClosing: async () => false }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+919000000000" }));
vi.mock("../lib/hf_calls_store", () => ({
  hasLaneAccess: async () => true, isBlockedEitherWay: async () => false, claimHost: async () => true, releaseHost: async () => {}, callsConfigured: () => true,
}));
vi.mock("../lib/hf_push", () => ({ sendHfPush: async () => true }));
vi.mock("../lib/email_outbox", () => ({ enqueueEmail: async () => ({ status: "queued", queued: true, durable: true }) }));
vi.mock("../lib/identity", () => ({ emailFor: async () => null }));
const schedule = { timezone: "Asia/Kolkata", version: 1, durationsMinutes: [10], slotIntervalMinutes: 10, bufferMinutes: 0, minNoticeMinutes: 60, horizonDays: 21, rules: [], exceptions: [] };
vi.mock("../lib/hf_booking_store", async (orig) => ({
  ...(await orig()),
  getHfBookingSchedule: async () => schedule, listHfBusyIntervals: async () => [],
}));

import { makeDb } from "../lib/hf_token_d1_shim";
import { creditLot } from "../lib/hf_token_ledger";
import { MICRO } from "../lib/hf_token_math";
import { cancelRoute, confirmRoute } from "./hf_bookings";
import { declinePending } from "../lib/hf_booking_approval";

const HOUR = 3_600_000, MIN = 60_000;
const NOW = Date.UTC(2026, 9, 21, 6, 0);
let env: any, raw: any;

function build(withApproval: boolean) {
  const db = makeDb(["2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-09-hf-calls.sql", "2026-10-10-hf-tokens.sql"], { alters: true });
  const files = ["2026-10-12-hf-creator-price-alters.sql", "hf_creator_badges.sql", "2026-10-13-hf-bookings.sql", ...(withApproval ? ["2026-10-20-hf-booking-approval-alters.sql", "2026-10-20-hf-booking-approval.sql"] : [])];
  for (const f of files) {
    const lines = readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8").split("\n");
    for (const l of lines.filter((x) => x.trim().startsWith("ALTER TABLE"))) db._raw.exec(l.replace(/--.*$/, ""));
    db._raw.exec(lines.filter((x) => !x.trim().startsWith("ALTER TABLE")).join("\n"));
  }
  db._raw.exec(`
    ALTER TABLE hf_hosts ADD COLUMN creator_kind TEXT NOT NULL DEFAULT 'channel';
    CREATE TABLE hf_age_confirm (uid TEXT PRIMARY KEY, confirmed_at INTEGER);
    INSERT INTO hf_age_confirm VALUES ('fan',1),('fan2',1);
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE hf_user_prefs (uid TEXT PRIMARY KEY, notify_whatsapp INTEGER NOT NULL DEFAULT 1, appt_reminders INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE calendar_blocks (id TEXT PRIMARY KEY, user_id TEXT, source_app TEXT, source_ref TEXT, starts_at INTEGER, ends_at INTEGER, title TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE hf_lane_access (uid TEXT, lane TEXT, declared_at INTEGER);
    CREATE TABLE hf_kyc (uid TEXT, verified_at INTEGER, gender TEXT);
    CREATE TABLE hf_selfie (id TEXT, uid TEXT, review_status TEXT, created_at INTEGER);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE phone_otp (uid TEXT, phone_hash TEXT, status TEXT, e164 TEXT, verified_at INTEGER);
    CREATE TABLE whatsapp_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, checkout_id TEXT NOT NULL, uid TEXT NOT NULL, listing_id TEXT NOT NULL, kind TEXT NOT NULL,
      url_hash TEXT NOT NULL, e164 TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (checkout_id, kind, url_hash));
    INSERT INTO users VALUES ('fan','Ravi'),('fan2','Neha'),('host','Kavya');
    INSERT INTO hf_hosts (uid,slug,status,display_name,topics_json,created_at,updated_at) VALUES ('host','kavya-ab12','live','Kavya','["just-friendship","general-advice"]',1,1);
    INSERT INTO hf_availability_schedules VALUES ('host','Asia/Kolkata',1,'[10]',10,0,60,21,'[]','[]',1);
  `);
  for (const u of ["fan", "fan2", "host"]) {
    db._raw.prepare("INSERT INTO contact_verification VALUES (?,1,?)").run(u, "h-" + u);
    db._raw.prepare("INSERT INTO phone_otp VALUES (?,?,'verified','+9190',1)").run(u, "h-" + u);
  }
  return db;
}

/** Wallet lot + an open quote for `uid` at `startsAt`; returns the quote id. */
async function quote(uid: string, startsAt: number, id = "00000000-0000-4000-8000-" + uid.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "0")) {
  await creditLot(env, uid, { kind: "purchase", pricingVersion: "pt-v1", valuePaisePerToken: 100, micro: 300 * MICRO, paidPaise: 30000, provider: "google_play", providerRef: "o-" + id }, "op-" + id);
  const snap = { price: 2000, expectedHostNetPaise: 9000, ratePaise: 2000, callCostPaisePerMin: 500, hostShareBps: 5000, taxMode: "", splitRuleVersion: "x" };
  raw.prepare(`INSERT INTO hf_booking_quotes VALUES (?,?,?,?,?,10,1,?, 'open', 20000, ?, ?, ?, NULL)`)
    .run(id, uid, "host", startsAt, startsAt + 10 * MIN, Date.now() + 5 * MIN, JSON.stringify(snap), JSON.stringify({ lane: null }), Date.now());
  return id;
}
async function confirm(uid: string, quoteId: string, extra: Record<string, unknown> = {}, key = "key-" + uid + "-1234") {
  who = uid;
  return confirmRoute(new Request("https://x.test/api/hf/bookings", {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ quoteId, policyAccepted: true, ...extra }),
  }), env);
}
const rowOf = (uid = "fan") => raw.prepare("SELECT * FROM hf_bookings WHERE customer_uid=?").get(uid);
const reserved = () => Number(raw.prepare("SELECT COALESCE(SUM(tokens_reserved_micro),0) AS n FROM hf_token_lots").get().n);
const releases = () => Number(raw.prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE kind='release' AND op_id=?").get("hftrel:" + rowOf().call_id).n);

let q1: string;
beforeEach(() => {
  cfg = { hfCallsEnabled: true, hfBookingsEnabled: true, hfBookingApprovalEnabled: true };
  who = "fan";
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  env = { DB_META: build(true) }; raw = env.DB_META._raw;
});

describe("confirm with the approval flag on", () => {
  it("manual host: pending_approval, hold kept, slot blocked, deadline = earlier of 24 h / start-1 h, topic saved", async () => {
    const start = NOW + 40 * HOUR;
    const qid = await quote("fan", start);
    const res = await confirm("fan", qid, { topicSlug: "just-friendship" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking).toMatchObject({ status: "pending_approval", canCancel: true });
    const row = rowOf();
    expect(row).toMatchObject({ status: "pending_approval", topic_slug: "just-friendship", approval_deadline: NOW + 24 * HOUR, approved_at: null, settlement_status: "held" });
    expect(reserved()).toBeGreaterThan(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM hf_booking_occupancy WHERE booking_id=? AND status='busy'").get(row.id).n).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM calendar_blocks WHERE source_ref=? AND status='busy'").get(row.id).n).toBe(2);
    expect(raw.prepare("SELECT status FROM hf_booking_quotes WHERE id=?").get(qid).status).toBe("consumed");
    expect(raw.prepare("SELECT from_status,to_status FROM hf_booking_events WHERE booking_id=?").get(row.id)).toEqual({ from_status: "confirming", to_status: "pending_approval" });
    // a pending booking is neither auto-started nor reminded: both look only at 'confirmed'
    expect(raw.prepare("SELECT COUNT(*) AS n FROM hf_bookings WHERE status='confirmed'").get().n).toBe(0);
  });

  it("a pending booking still blocks its slot for the next fan", async () => {
    const start = NOW + 40 * HOUR;
    await confirm("fan", await quote("fan", start));
    const res2 = await confirm("fan2", await quote("fan2", start));
    expect(res2.status).toBe(409);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM hf_bookings").get().n).toBe(1);
  });

  it("deadline is start-1h when the call is sooner than 25 h away", async () => {
    const start = NOW + 5 * HOUR;
    await confirm("fan", await quote("fan", start));
    expect(rowOf().approval_deadline).toBe(start - HOUR);
  });

  it("auto host: confirmed straight away, approved by 'auto', no deadline, even 90 minutes ahead", async () => {
    raw.prepare("UPDATE hf_hosts SET booking_approval='auto' WHERE uid='host'").run();
    const res = await confirm("fan", await quote("fan", NOW + 90 * MIN));
    expect(res.status).toBe(201);
    expect(rowOf()).toMatchObject({ status: "confirmed", decided_by: "auto", approved_at: NOW, approval_deadline: null });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM hf_booking_occupancy WHERE status='busy'").get().n).toBe(2);
  });

  it("manual host refuses a booking starting in under 2 hours (409 too_soon_for_approval) and holds nothing", async () => {
    const qid = await quote("fan", NOW + 100 * MIN);
    const res = await confirm("fan", qid);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "too_soon_for_approval", message: expect.stringContaining("2 hours") });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM hf_bookings").get().n).toBe(0);
    expect(reserved()).toBe(0);
  });

  it("a topic that is not one of the influencer's own is 400 bad_topic; an omitted topic is fine", async () => {
    const start = NOW + 40 * HOUR;
    const qid = await quote("fan", start);
    const bad = await confirm("fan", qid, { topicSlug: "gaming-and-esports" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "bad_topic" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM hf_bookings").get().n).toBe(0);
    const ok = await confirm("fan", qid);
    expect(ok.status).toBe(201);
    expect(rowOf().topic_slug).toBeNull();
  });
});

describe("flag OFF is exactly the old behaviour", () => {
  it("confirms immediately and never touches the new columns (runs on a database that does not have them)", async () => {
    cfg = { hfCallsEnabled: true, hfBookingsEnabled: true };
    env = { DB_META: build(false) }; raw = env.DB_META._raw;
    const start = NOW + 100 * MIN; // would be too soon for a manual host: the flag off ignores that rule
    const res = await confirm("fan", await quote("fan", start), { topicSlug: "just-friendship" });
    expect(res.status).toBe(201);
    expect((await res.json()).booking.status).toBe("confirmed");
    expect(rowOf().status).toBe("confirmed");
    expect(Object.keys(rowOf())).not.toContain("approval_deadline");
    expect(raw.prepare("SELECT to_status FROM hf_booking_events").get().to_status).toBe("confirmed");
  });

  it("a confirmed booking is cancellable by the fan exactly as before", async () => {
    cfg = { hfCallsEnabled: true, hfBookingsEnabled: true };
    env = { DB_META: build(false) }; raw = env.DB_META._raw;
    await confirm("fan", await quote("fan", NOW + 100 * MIN));
    const id = rowOf().id;
    who = "fan";
    const res = await cancelRoute(new Request("https://x.test/x", { method: "POST" }), env, id);
    expect(res.status).toBe(200);
    expect(rowOf()).toMatchObject({ status: "cancelled", settlement_status: "released" });
    expect(reserved()).toBe(0);
  });
});

describe("cancelling a pending booking", () => {
  async function pending() {
    await confirm("fan", await quote("fan", NOW + 40 * HOUR));
    return rowOf().id as string;
  }
  it("the fan can withdraw any time (even inside the last hour rule): full refund once, reason 'fan', idempotent", async () => {
    const id = await pending();
    raw.prepare("UPDATE hf_bookings SET starts_at=?, ends_at=? WHERE id=?").run(NOW + 20 * MIN, NOW + 30 * MIN, id); // inside the confirmed-booking cutoff
    who = "fan";
    const res = await cancelRoute(new Request("https://x.test/x", { method: "DELETE" }), env, id, { fanCutoff: true });
    expect(res.status).toBe(200);
    expect(rowOf()).toMatchObject({ status: "cancelled", settlement_status: "released", cancel_reason: "fan", decided_by: "fan" });
    expect(reserved()).toBe(0);
    expect(releases()).toBe(1);
    expect(raw.prepare("SELECT status FROM hf_booking_occupancy WHERE booking_id=?").all(id).every((r: any) => r.status === "cancelled")).toBe(true);
    const again = await cancelRoute(new Request("https://x.test/x", { method: "DELETE" }), env, id, { fanCutoff: true });
    expect(again.status).toBe(200);
    expect(releases()).toBe(1);
  });
  it("fan cancel and host decline racing: one refund, one outcome", async () => {
    const id = await pending();
    who = "fan";
    const [a, b] = await Promise.all([
      cancelRoute(new Request("https://x.test/x", { method: "DELETE" }), env, id, { fanCutoff: true }),
      declinePending(env, id, "host", NOW),
    ]);
    expect(releases()).toBe(1);
    expect(reserved()).toBe(0);
    expect(["fan", "declined"]).toContain(rowOf().cancel_reason);
    expect(a.status === 200 || b.ok).toBe(true);
  });
});


describe("HF-SEC-AGE-1 confirmation and legacy reservations", () => {
  it("AGE-01 missing attestation creates no booking or wallet hold", async () => {
    const qid = await quote("fan", NOW + 40 * HOUR);
    raw.exec("DELETE FROM hf_age_confirm WHERE uid='fan'");
    const response = await confirm("fan", qid);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "age_confirmation_required" });
    expect(rowOf()).toBeUndefined();
    expect(reserved()).toBe(0);
    expect(raw.prepare("SELECT status FROM hf_booking_quotes WHERE id=?").get(qid).status).toBe("open");
  });
  it("AGE-03 existing confirmation retry and cancellation remain available without attestation", async () => {
    const qid = await quote("fan", NOW + 40 * HOUR);
    const created = await confirm("fan", qid);
    expect(created.status).toBe(201);
    const id = rowOf().id;
    raw.exec("DELETE FROM hf_age_confirm WHERE uid='fan'");
    expect((await confirm("fan", qid)).status).toBe(200);
    expect((await cancelRoute(new Request("https://x.test/api/hf/bookings/" + id + "/cancel", { method: "POST" }), env, id)).status).toBe(200);
    expect(reserved()).toBe(0);
  });
  it("AGE-04 unavailable age storage cannot create a hold", async () => {
    const qid = await quote("fan", NOW + 40 * HOUR);
    raw.exec("DROP TABLE hf_age_confirm");
    expect((await confirm("fan", qid)).status).toBe(503);
    expect(rowOf()).toBeUndefined();
    expect(reserved()).toBe(0);
  });
});
