// [JOIN-LINK-1] POST /api/join-link/:token/session — the emailed link must open
// the room WITHOUT a login, and must stop working the moment the thing it was
// issued for stops being valid.
//
// Pinned here: valid → ticket + destination; expired → 410; cancelled booking →
// 410; refunded entitlement → 410; forged signature → 404; and the fact that a
// valid token for someone else's booking cannot be pointed at it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signJoinTokenV2, signJoinToken, verifyJoinTokenClaims } from "../src/cal/ics";
import { joinLinkSession } from "../src/routes/join_link";

const HOUR = 3_600_000;
const NOW = 1_760_000_000_000;

type Booking = { id: string; listing_id: string | null; buyer_id: string; kind: string; ends_at: number; status: string };
type Grant = { entitlement_id: string; state: string; ends_at: number | null };

/** D1-shaped stub: just the two SELECTs this route makes. */
function db(booking: Booking | null, grant: Grant | null) {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const st = {
        bind(...v: unknown[]) { args = v; return st; },
        async first() {
          if (sql.includes("FROM bookings")) {
            return booking && booking.id === String(args[0]) ? { ...booking } : null;
          }
          if (sql.includes("commercial_entitlements")) {
            // Mirror the route's binding order: kind, listing, booking, account.
            if (!grant) return null;
            return { ...grant };
          }
          return null;
        },
      };
      return st;
    },
  };
}

function env(booking: Booking | null, grant: Grant | null) {
  return {
    JOIN_LINK_SECRET: "test-secret",
    CLERK_SECRET_KEY: "sk_test",
    DB_META: db(booking, grant),
    Q_EVENTS: { send: async () => {} },
  } as unknown as Parameters<typeof joinLinkSession>[1];
}

const req = () => new Request("https://api.avatok.ai/api/join-link/x/session", { method: "POST" });

const liveBooking: Booking = {
  id: "commercial-booking-1", listing_id: "lst_1", buyer_id: "user_buyer",
  kind: "consult_1to1", ends_at: NOW + HOUR, status: "confirmed",
};
const liveGrant: Grant = { entitlement_id: "ent_1", state: "active", ends_at: NOW + HOUR };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/sign_in_tokens")) return new Response(JSON.stringify({ token: "tkt_abc" }), { status: 200 });
    if (u.includes("/users/")) {
      return new Response(JSON.stringify({
        primary_email_address_id: "e1",
        email_addresses: [{ id: "e1", email_address: "davy@example.com", verification: { status: "verified" } }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
});

async function token(over: Partial<Parameters<typeof signJoinTokenV2>[1]> = {}) {
  return await signJoinTokenV2({ JOIN_LINK_SECRET: "test-secret" } as never, {
    bookingId: "commercial-booking-1", listingId: "lst_1", accountId: "user_buyer",
    kind: "consult_1to1", expMs: NOW + 25 * HOUR, ...over,
  });
}

describe("join link token", () => {
  it("round-trips v2 claims and still reads v1 tokens", async () => {
    const e = { JOIN_LINK_SECRET: "test-secret" } as never;
    const c = await verifyJoinTokenClaims(e, await token());
    expect(c).toMatchObject({ version: 2, bookingId: "commercial-booking-1", listingId: "lst_1", accountId: "user_buyer", kind: "consult_1to1" });
    const v1 = await verifyJoinTokenClaims(e, await signJoinToken(e, "bk_old", NOW + HOUR));
    expect(v1).toMatchObject({ version: 1, bookingId: "bk_old", accountId: null });
  });

  it("rejects a tampered payload", async () => {
    const e = { JOIN_LINK_SECRET: "test-secret" } as never;
    const t = await token();
    const [, sig] = t.split(".");
    const forged = `${btoa(JSON.stringify({ v: 2, b: "x", l: "lst_1", u: "user_attacker", k: "consult_1to1", exp: NOW + HOUR })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyJoinTokenClaims(e, forged)).toBeNull();
  });
});

describe("POST /api/join-link/:token/session", () => {
  it("hands back a Clerk ticket and the room path for a live entitlement", async () => {
    const res = await joinLinkSession(req(), env(liveBooking, liveGrant), await token());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ticket).toBe("tkt_abc");
    expect(body.ticket_kind).toBe("clerk_sign_in_token");
    expect(body.destination).toBe("/session/commercial-booking-1");
    expect(body.account_email_masked).toBe("da**@example.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sends a live_event ticket to the listing room, with no booking row", async () => {
    const t = await token({ bookingId: null, kind: "live_event" });
    const res = await joinLinkSession(req(), env(null, { entitlement_id: "ent_2", state: "reserved", ends_at: NOW + HOUR }), t);
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).destination).toBe("/live/lst_1");
  });

  it("410s an expired link", async () => {
    const t = await token({ expMs: NOW - 1 });
    const res = await joinLinkSession(req(), env(liveBooking, liveGrant), t);
    expect(res.status).toBe(410);
    expect((await res.json() as Record<string, unknown>).reason).toBe("expired");
  });

  it("410s a link whose session ended more than 24h ago, even with a longer exp", async () => {
    const t = await token({ expMs: NOW + 400 * HOUR });
    const res = await joinLinkSession(
      req(), env({ ...liveBooking, ends_at: NOW - 30 * HOUR }, { ...liveGrant, ends_at: NOW - 30 * HOUR }), t,
    );
    expect(res.status).toBe(410);
    expect((await res.json() as Record<string, unknown>).reason).toBe("expired");
  });

  it("410s a cancelled booking", async () => {
    const res = await joinLinkSession(req(), env({ ...liveBooking, status: "cancelled" }, liveGrant), await token());
    expect(res.status).toBe(410);
    expect((await res.json() as Record<string, unknown>).reason).toBe("cancelled");
  });

  it("410s a refunded entitlement", async () => {
    const res = await joinLinkSession(req(), env(liveBooking, { ...liveGrant, state: "refunded" }), await token());
    expect(res.status).toBe(410);
    expect((await res.json() as Record<string, unknown>).reason).toBe("cancelled");
  });

  it("410s when the entitlement is gone entirely", async () => {
    const res = await joinLinkSession(req(), env(liveBooking, null), await token());
    expect(res.status).toBe(410);
    expect((await res.json() as Record<string, unknown>).reason).toBe("no_entitlement");
  });

  it("404s a token signed with the wrong secret", async () => {
    const foreign = await signJoinTokenV2({ JOIN_LINK_SECRET: "other-secret" } as never, {
      bookingId: "commercial-booking-1", listingId: "lst_1", accountId: "user_buyer",
      kind: "consult_1to1", expMs: NOW + HOUR,
    });
    const res = await joinLinkSession(req(), env(liveBooking, liveGrant), foreign);
    expect(res.status).toBe(404);
  });

  it("refuses a validly signed token whose account is not the booking's buyer", async () => {
    const t = await token({ accountId: "user_someone_else" });
    const res = await joinLinkSession(req(), env(liveBooking, liveGrant), t);
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).error).toBe("not your booking");
  });

  it("never mints without a Clerk secret", async () => {
    const e = env(liveBooking, liveGrant) as unknown as Record<string, unknown>;
    delete e.CLERK_SECRET_KEY;
    const res = await joinLinkSession(req(), e as never, await token());
    expect(res.status).toBe(503);
  });
});
