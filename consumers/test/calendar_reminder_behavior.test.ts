import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingReminderLadder } from "../src/calendar";

type Booking = {
  id: string;
  creator_id: string;
  buyer_id: string;
  listing_id: string;
  kind: string;
  starts_at: number;
  title: string;
};

/** D1-shaped fixture for the public reminder ladder. It intentionally returns
 * exactly 100 rows per due-booking page so the test exercises the cursor loop. */
class ReminderDb {
  readonly bookings: Booking[];
  readonly reminder24Updates: string[] = [];

  constructor(bookings: Booking[]) {
    this.bookings = bookings;
  }

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        args = values;
        return statement;
      },
      async all() {
        if (sql.includes("FROM bookings") && sql.includes("reminder24_sent")) {
          const cursor = String(args[2] ?? "");
          return { results: db.bookings.filter((booking) => booking.id > cursor).slice(0, 100) };
        }
        // The fixture has no live-ticket or legacy calendar rows.
        return { results: [] };
      },
      async first() {
        if (sql.includes("FROM profiles")) return { name: "Participant", handle: null };
        return null;
      },
      async run() {
        if (sql.includes("UPDATE bookings SET reminder24_sent=1")) {
          db.reminder24Updates.push(String(args[0]));
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

function fixtureBookings(now: number): Booking[] {
  return Array.from({ length: 205 }, (_, index) => ({
    id: `booking-${String(index).padStart(3, "0")}`,
    creator_id: `creator-${String(index).padStart(3, "0")}`,
    buyer_id: `buyer-${String(index).padStart(3, "0")}`,
    listing_id: `listing-${String(index).padStart(3, "0")}`,
    kind: "consult_1to1",
    starts_at: now + 22 * 3_600_000,
    title: `Session ${index}`,
  }));
}

describe("commercial booking reminder ladder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drains pages over 100, continues after one failure, and leaves its flag unset", async () => {
    const now = Date.now();
    const db = new ReminderDb(fixtureBookings(now));
    const env = { DB_META: db, CLERK_SECRET_KEY: "test-clerk-key" } as any;
    const emailBookingIds: string[] = [];
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const uid = String(request).split("/").pop() ?? "unknown";
      return new Response(JSON.stringify({
        primary_email_address_id: "primary",
        email_addresses: [{ id: "primary", email_address: `${uid}@example.test`, verification: { status: "verified" } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const sendEmail = vi.fn(async (message: { orderId?: string | null; recipientId?: string | null }) => {
      const bookingId = String(message.orderId ?? "");
      emailBookingIds.push(bookingId);
      if (message.recipientId === "creator-000") throw new Error("temporary mail provider failure");
    });

    await bookingReminderLadder(env, sendEmail as any);

    // 205 due rows are delivered in three pages. The first booking fails before
    // its cadence marker is written; every later booking is still processed.
    expect(new Set(emailBookingIds)).toHaveProperty("size", 205);
    expect(emailBookingIds).toContain("booking-204");
    expect(db.reminder24Updates).toHaveLength(204);
    expect(db.reminder24Updates).not.toContain("booking-000");
    expect(new Set(db.reminder24Updates).size).toBe(204);
    expect(fetch).toHaveBeenCalled();
  });
});
