// [AUDIT-7 / Android A1] /api/calendar/blocks must resolve each diary row to
// its real booking, listing and status so the phone can open the correct
// appointment instead of a legacy action and render one card per booking.
//
// Two rules are load-bearing here:
//   * owner-scoped: metadata is only attached for rows the caller owns;
//   * unambiguous: a booking id is never guessed. Two candidates or a foreign
//     reservation leave booking_id null (the block stays "busy").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const H = vi.hoisted(() => ({ uid: "creator" }));
vi.mock("../src/authz", () => ({
  requireUser: async () => ({ uid: H.uid }),
  isFail: (value: any) => Boolean(value?.error),
}));
vi.mock("../src/hooks", () => ({ track: async () => undefined, brainFact: async () => undefined }));
vi.mock("../src/notify", () => ({ notifyUser: async () => undefined }));
vi.mock("../src/routes/wallet", () => ({ transferTokens: async () => ({ ok: false }) }));
vi.mock("../src/cal/emails", () => ({
  emailBookingConfirmed: async () => undefined,
  emailBookingCancelled: async () => undefined,
  emailRefundIssued: async () => undefined,
}));
vi.mock("../src/cal/gcal", () => ({ gcalExport: async () => undefined }));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};
const AVAILABILITY = readFileSync(
  fileURLToPath(new URL("../migrations/2026-09-10-unified-availability.sql", import.meta.url)),
  "utf8",
);

function d1(db: any): any {
  const wrapped: any = {
    prepare(sql: string) {
      let named = "", next = 1;
      const used = new Set<number>();
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] !== "?") { named += sql[i]; continue; }
        let j = i + 1; while (j < sql.length && /\d/.test(sql[j])) j++;
        if (j > i + 1) {
          const index = Number(sql.slice(i + 1, j));
          named += `$p${index}`; used.add(index); next = Math.max(next, index + 1); i = j - 1;
        } else { named += `$p${next}`; used.add(next); next++; }
      }
      let params: Record<string, unknown> = {};
      const statement: any = {
        bind(...values: unknown[]) {
          const maxIndex = used.size ? Math.max(...used) : 0;
          if (values.length > maxIndex) throw new Error(`too many binds: ${values.length} > ${maxIndex}`);
          params = {};
          for (const index of used) params[`p${index}`] = values[index - 1] === undefined ? null : values[index - 1];
          return statement;
        },
        async run() {
          const result = db.prepare(named).run(params);
          return { meta: { changes: Number(result.changes ?? 0) } };
        },
        async first<T = any>(): Promise<T | null> {
          return (db.prepare(named).get(params) as T | undefined) ?? null;
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          return { results: db.prepare(named).all(params) as T[] };
        },
      };
      return statement;
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    withSession() { return wrapped; },
  };
  return wrapped;
}

const HOUR = 3_600_000;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, duration_min INTEGER,
      starts_at INTEGER, ends_at INTEGER, attrs TEXT, price INTEGER DEFAULT 0
    );
    CREATE TABLE listing_slots (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, status TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 1, booked_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE calendar_blocks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_app TEXT NOT NULL,
      source_ref TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      title TEXT, status TEXT NOT NULL, gcal_event_id TEXT, created_at INTEGER
    );
    CREATE TABLE bookings (
      id TEXT PRIMARY KEY, listing_id TEXT, creator_id TEXT, buyer_id TEXT,
      kind TEXT, status TEXT, starts_at INTEGER, ends_at INTEGER
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, buyer_id TEXT NOT NULL,
      creator_id TEXT NOT NULL, amount INTEGER, status TEXT, booking_id TEXT
    );
    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY, booking_id TEXT, slot_id TEXT, owner_uid TEXT,
      role TEXT, host_uid TEXT, attendee_uid TEXT, title TEXT,
      start_at INTEGER, end_at INTEGER, price_coins INTEGER, paid INTEGER,
      status TEXT, source TEXT, created_at INTEGER
    );
  `);
  db.exec(AVAILABILITY);
  const now = Date.now();
  const at = (hours: number) => Math.ceil((now + hours * HOUR) / HOUR) * HOUR;
  db.prepare("INSERT INTO listings (id,creator_id,kind,title,status,duration_min) VALUES (?,?,?,?,?,?)")
    .run("listing-1", "creator", "consult", "Consult", "published", 60);
  const block = (id: string, user: string, app: string, ref: string | null, start: number, end: number, title: string) =>
    db.prepare("INSERT INTO calendar_blocks (id,user_id,source_app,source_ref,starts_at,ends_at,title,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, user, app, ref, start, end, title, "busy", now);
  const reservation = (id: string, creator: string, kind: string, status: string, ref: string | null, start: number, end: number, hold?: number | null) =>
    db.prepare("INSERT INTO availability_reservations (id,creator_id,listing_id,kind,status,starts_at,ends_at,title,source_ref,hold_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, creator, "listing-1", kind, status, start, end, "Consult", ref, hold ?? null, now, now);
  const booking = (id: string, creator: string, buyer: string, kind: string, status: string, start: number, end: number) =>
    db.prepare("INSERT INTO bookings (id,listing_id,creator_id,buyer_id,kind,status,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, "listing-1", creator, buyer, kind, status, start, end);

  const paidStart = at(48), paidEnd = paidStart + HOUR;
  block("availability:res-1", "creator", "availability", "res-1", paidStart, paidEnd, "Consult");
  reservation("res-1", "creator", "booking", "reserved", "commercial-availability:creator:order-1", paidStart, paidEnd);
  booking("booking-1", "creator", "buyer-1", "consult_1to1", "confirmed", paidStart, paidEnd);
  db.prepare("INSERT INTO orders (id,listing_id,buyer_id,creator_id,amount,status,booking_id) VALUES (?,?,?,?,?,?,?)")
    .run("order-1", "listing-1", "buyer-1", "creator", 100, "held", "booking-1");

  // A foreign reservation under MY block must never be attributed to me.
  const foreignStart = at(96), foreignEnd = foreignStart + HOUR;
  block("availability:res-foreign", "creator", "availability", "res-foreign", foreignStart, foreignEnd, "Private");
  reservation("res-foreign", "other-creator", "booking", "reserved", "booking:booking-9", foreignStart, foreignEnd);
  booking("booking-9", "other-creator", "buyer-9", "consult_1to1", "confirmed", foreignStart, foreignEnd);

  // The buyer's own projection of a commercial consult.
  const buyerStart = at(144), buyerEnd = buyerStart + HOUR;
  block("blk-buyer-consult", "creator", "avaconsult", "commercial:booking-2:buyer", buyerStart, buyerEnd, "Consult");
  booking("booking-2", "expert", "creator", "consult_1to1", "confirmed", buyerStart, buyerEnd);

  // A live checkout hold: no booking exists yet, so no booking id is invented.
  const holdStart = at(168), holdEnd = holdStart + HOUR;
  block("availability:res-hold", "creator", "availability", "res-hold", holdStart, holdEnd, "Commercial checkout hold");
  reservation("res-hold", "creator", "hold", "held", "commercial-hold:creator:key-1", holdStart, holdEnd, now + 5 * 60_000);

  // Two candidate bookings at the same listing+interval: stay unattributed.
  const ambiguousStart = at(192), ambiguousEnd = ambiguousStart + HOUR;
  block("availability:res-ambiguous", "creator", "availability", "res-ambiguous", ambiguousStart, ambiguousEnd, "Consult");
  reservation("res-ambiguous", "creator", "booking", "reserved", null, ambiguousStart, ambiguousEnd);
  booking("booking-a", "creator", "buyer-a", "consult_1to1", "confirmed", ambiguousStart, ambiguousEnd);
  booking("booking-b", "someone", "creator", "consult_1to1", "confirmed", ambiguousStart, ambiguousEnd);
  booking("booking-elsewhere", "someone", "someone-else", "consult_1to1", "confirmed", ambiguousStart, ambiguousEnd);

  block("blk-gcal", "creator", "gcal", "gcal:primary:event-1", at(216), at(216) + HOUR, "Google Calendar");

  // Legacy AvaBooking blocks stored the bare booking id as their source_ref.
  block("blk-legacy-booking", "creator", "avabooking", "booking-1", paidStart, paidEnd, "Consult");

  // [REV-3] Two candidate bookings share ONE listing and interval. Each
  // reservation is linked to its own order, and only the order says which
  // booking that reservation is: a scan of "bookings at this interval" would
  // hand the first one to both rows and open the wrong appointment.
  const orderedStart = at(240), orderedEnd = orderedStart + HOUR;
  block("availability:res-order-a", "creator", "availability", "res-order-a", orderedStart, orderedEnd, "Consult");
  reservation("res-order-a", "creator", "booking", "reserved", "commercial-availability:buyer-a:order-a", orderedStart, orderedEnd);
  booking("booking-ordered-a", "creator", "buyer-a", "consult_1to1", "confirmed", orderedStart, orderedEnd);
  db.prepare("INSERT INTO orders (id,listing_id,buyer_id,creator_id,amount,status,booking_id) VALUES (?,?,?,?,?,?,?)")
    .run("order-a", "listing-1", "buyer-a", "creator", 100, "held", "booking-ordered-a");

  block("availability:res-order-b", "creator", "availability", "res-order-b", orderedStart, orderedEnd, "Consult");
  reservation("res-order-b", "creator", "booking", "reserved", "commercial-availability:creator:order-b", orderedStart, orderedEnd);
  booking("booking-ordered-b", "someone", "creator", "consult_1to1", "confirmed", orderedStart, orderedEnd);
  db.prepare("INSERT INTO orders (id,listing_id,buyer_id,creator_id,amount,status,booking_id) VALUES (?,?,?,?,?,?,?)")
    .run("order-b", "listing-1", "creator", "someone", 100, "held", "booking-ordered-b");

  // An order the caller is NOT a party to must never resolve a booking here,
  // even though the reservation itself is the caller's own.
  const foreignOrderStart = at(264), foreignOrderEnd = foreignOrderStart + HOUR;
  block("availability:res-order-foreign", "creator", "availability", "res-order-foreign", foreignOrderStart, foreignOrderEnd, "Consult");
  reservation("res-order-foreign", "creator", "booking", "reserved", "commercial-availability:stranger:order-foreign", foreignOrderStart, foreignOrderEnd);
  db.prepare("INSERT INTO orders (id,listing_id,buyer_id,creator_id,amount,status,booking_id) VALUES (?,?,?,?,?,?,?)")
    .run("order-foreign", "listing-1", "stranger", "other-creator", 100, "held", "booking-9");

  db.prepare("INSERT INTO calendar_events (id,booking_id,slot_id,owner_uid,role,host_uid,attendee_uid,title,start_at,end_at,price_coins,paid,status,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("commercial-calendar-event:booking-1:creator", "booking-1", "listing-1", "creator", "host", "creator", "buyer-1", "Consult", paidStart, paidEnd, 100, 1, "confirmed", "commercial", now);

  return { db, env: { DB_META: d1(db) }, paidStart };
}

type BlocksResponse = { blocks: any[] };
function blocksRequest(): Request {
  const from = Date.now() - 24 * HOUR;
  const to = Date.now() + 30 * 24 * HOUR;
  return new Request(`https://api.test/api/calendar/blocks?from=${from}&to=${to}`);
}

let calendar: typeof import("../src/routes/calendar");
let currentDb: any;
beforeEach(async () => {
  H.uid = "creator";
  calendar = await import("../src/routes/calendar");
});
afterEach(() => { currentDb?.close(); currentDb = null; });

function findBlock(body: BlocksResponse, id: string): any {
  return body.blocks.find((row) => row.id === id);
}

describe("diary block metadata", () => {
  it("resolves an availability block to its booking, listing, kind and status", async () => {
    const { db, env } = setup();
    currentDb = db;
    const response = await calendar.listBlocks(blocksRequest(), env as any);
    expect(response.status).toBe(200);
    const body = await response.json() as BlocksResponse;

    expect(findBlock(body, "availability:res-1")).toMatchObject({
      booking_id: "booking-1", listing_id: "listing-1",
      booking_kind: "consult_1to1", booking_status: "confirmed",
      booking_role: "creator",
    });
    // The buyer's avaconsult projection resolves to the same booking, which is
    // what lets a client render one card instead of two.
    expect(findBlock(body, "blk-buyer-consult")).toMatchObject({
      booking_id: "booking-2", listing_id: "listing-1",
      booking_kind: "consult_1to1", booking_status: "confirmed",
      // Proven from the booking row (buyer_id), not guessed from a listing.
      booking_role: "customer",
    });
    expect(new Set([
      findBlock(body, "availability:res-1").booking_id,
      findBlock(body, "blk-buyer-consult").booking_id,
    ]).size).toBe(2);
  });

  it("does not attribute another owner's reservation to the caller", async () => {
    const { db, env } = setup();
    currentDb = db;
    const body = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    expect(findBlock(body, "availability:res-foreign")).toMatchObject({
      booking_id: null, listing_id: null, booking_kind: null, booking_status: null, booking_role: null,
    });
  });

  it("resolves a legacy AvaBooking block whose source_ref is the booking id", async () => {
    const { db, env } = setup();
    currentDb = db;
    const body = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    expect(findBlock(body, "blk-legacy-booking")).toMatchObject({
      booking_id: "booking-1", listing_id: "listing-1",
      booking_kind: "consult_1to1", booking_status: "confirmed",
      booking_role: "creator",
    });
  });

  it("reports a hold without inventing a booking id, and leaves non-booking sources empty", async () => {
    const { db, env } = setup();
    currentDb = db;
    const body = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    expect(findBlock(body, "availability:res-hold")).toMatchObject({
      booking_id: null, listing_id: "listing-1", booking_kind: "hold", booking_status: "held",
      // The reservation row was loaded with creator_id = caller, so the caller
      // is provably the host even though no booking exists yet.
      booking_role: "creator",
    });
    expect(findBlock(body, "blk-gcal")).toMatchObject({
      booking_id: null, listing_id: null, booking_kind: null, booking_status: null, booking_role: null,
    });
  });

  it("leaves booking_id null when the interval matches more than one booking", async () => {
    const { db, env } = setup();
    currentDb = db;
    const body = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    expect(findBlock(body, "availability:res-ambiguous")).toMatchObject({
      booking_id: null, listing_id: "listing-1", booking_kind: "booking", booking_status: "reserved",
      booking_role: "creator",
    });
  });

  it("uses the order's own booking when two bookings share the interval", async () => {
    const { db, env } = setup();
    currentDb = db;
    const body = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    // Same listing, same start/end, two different orders → two different
    // bookings, each with the role the booking row proves.
    expect(findBlock(body, "availability:res-order-a")).toMatchObject({
      booking_id: "booking-ordered-a", listing_id: "listing-1", booking_role: "creator",
    });
    expect(findBlock(body, "availability:res-order-b")).toMatchObject({
      booking_id: "booking-ordered-b", listing_id: "listing-1", booking_role: "customer",
    });
    expect(findBlock(body, "availability:res-order-a").booking_id)
      .not.toBe(findBlock(body, "availability:res-order-b").booking_id);
  });

  it("never resolves a booking through an order the caller is not party to", async () => {
    const { db, env } = setup();
    currentDb = db;
    const body = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    // The reservation is the caller's, but the order/booking is not: the honest
    // answer is "busy with no booking id", never another party's appointment.
    expect(findBlock(body, "availability:res-order-foreign")).toMatchObject({
      booking_id: null, booking_kind: "booking", booking_status: "reserved", booking_role: "creator",
    });
  });

  it("shares one booking id between the busy block and the appointment event", async () => {
    const { db, env } = setup();
    currentDb = db;
    const blocks = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    const events = await (await calendar.listEvents(new Request("https://api.test/api/calendar/events"), env as any)).json() as { events: any[] };
    const block = findBlock(blocks, "availability:res-1");
    const event = events.events.find((row) => row.booking_id === "booking-1");
    expect(event).toBeTruthy();
    expect(event.booking_id).toBe(block.booking_id);
  });

  it("keeps the pre-existing block fields for older clients", async () => {
    const { db, env } = setup();
    currentDb = db;
    const body = await (await calendar.listBlocks(blocksRequest(), env as any)).json() as BlocksResponse;
    expect(findBlock(body, "availability:res-1")).toMatchObject({
      source_app: "availability", source_ref: "res-1", status: "busy", title: "Consult",
    });
  });
});
