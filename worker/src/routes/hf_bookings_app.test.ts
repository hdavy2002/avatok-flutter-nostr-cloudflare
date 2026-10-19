// [HF-WIRE-8] Reels-app booking adapter: auth, own data only, flag off, double booking, hold amount, cancel windows, host refund, no numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import * as store from "../lib/hf_booking_store";
import * as config from "./config";
import * as ledger from "../lib/hf_token_ledger";
import * as bookings from "./hf_bookings";
import * as authz from "../authz";
import { hfBookingsAppRoute, runHfBookingAutoStart } from "./hf_bookings_app";

vi.mock("../authz", () => ({
  requireUser: vi.fn(async () => ({ uid: "fan-1" })),
  isFail: (v: unknown) => v instanceof Response,
}));
vi.mock("./config", () => ({ readConfig: vi.fn() }));
vi.mock("../lib/hf_booking_store", () => ({
  acquireHfScheduleWriteLock: vi.fn(), getHfBookingSchedule: vi.fn(), listHfBusyIntervals: vi.fn(),
  releaseHfScheduleWriteLock: vi.fn(), saveHfBookingSchedule: vi.fn(),
}));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: vi.fn(async () => "+919876543210") }));
vi.mock("../lib/hf_token_ledger", async (orig) => ({
  ...(await orig<typeof import("../lib/hf_token_ledger")>()),
  getReservation: vi.fn(), buildReleaseStatements: vi.fn(),
}));
vi.mock("./hf_bookings", async (orig) => {
  const a = await orig<typeof import("./hf_bookings")>();
  return { ...a, quoteRoute: vi.fn(), confirmRoute: vi.fn(), startBookingCore: vi.fn(), cancelRoute: vi.fn(a.cancelRoute), loadHostPricing: vi.fn(async () => null) };
});

type Rule = [RegExp, unknown];
type Call = { sql: string; args: unknown[] };
function mkEnv(rules: Rule[]) {
  const calls: Call[] = [];
  const batches: unknown[][] = [];
  const env = {
    DB_META: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          calls.push({ sql, args });
          const hit = rules.find(([re]) => re.test(sql))?.[1];
          const val = typeof hit === "function" ? (hit as (s: string, a: unknown[]) => unknown)(sql, args) : hit;
          return {
            first: async () => (Array.isArray(val) ? val[0] ?? null : val ?? null),
            all: async () => ({ results: Array.isArray(val) ? val : [] }),
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
      batch: async (s: unknown[]) => { batches.push(s); return s.map(() => ({ meta: { changes: 1 } })); },
    },
  } as unknown as Env;
  return { env, calls, batches };
}

const NOW = new Date("2026-10-20T06:00:00Z"); // 11:30 IST
const BID = "11111111-1111-4111-8111-111111111111";
const row = (over: Record<string, unknown> = {}) => ({
  id: BID, host_uid: "host-1", customer_uid: "fan-1", starts_at: NOW.getTime() + 2 * 3_600_000, ends_at: NOW.getTime() + 2 * 3_600_000 + 600_000,
  status: "confirmed", settlement_status: "held", call_id: "call-1", duration_min: 10, reserved_paise: 5000, expected_host_net_paise: 2800,
  host_slug: "tara-ab12", host_name: "Tara S.", fan_name: "Ravi Kumar", ...over,
});
const get = (path: string) => new Request("https://x.test" + path);
const send = (method: string, path: string, body?: unknown) => new Request("https://x.test" + path, {
  method, headers: { "content-type": "application/json", authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const flag = (over: Record<string, unknown> = {}) => vi.mocked(config.readConfig).mockResolvedValue({ hfBookingsEnabled: true, ...over } as never);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); flag(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.mocked(authz.requireUser).mockImplementation(async () => ({ uid: "fan-1" }) as never); });

describe("auth, flag and ownership", () => {
  it("401 without a signed-in user on every app route", async () => {
    vi.mocked(authz.requireUser).mockResolvedValue(new Response(null, { status: 401 }) as never);
    const { env } = mkEnv([]);
    for (const r of [
      get("/api/hf/bookings?role=fan"), get("/api/hf/hosts/me/availability"), send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 10 }),
      send("DELETE", `/api/hf/bookings/${BID}`), send("POST", "/api/hf/bookings", { hostSlug: "tara-ab12", startAt: NOW.toISOString() }),
    ]) expect((await hfBookingsAppRoute(r, env))?.status).toBe(401);
  });

  it("is dark (404) while hfBookingsEnabled is off, and ignores paths that are not its own", async () => {
    flag({ hfBookingsEnabled: false });
    const { env } = mkEnv([]);
    expect((await hfBookingsAppRoute(get("/api/hf/bookings?role=fan"), env))?.status).toBe(404);
    expect((await hfBookingsAppRoute(get("/api/hf/hosts/tara-ab12/slots"), env))?.status).toBe(404);
    expect(await hfBookingsAppRoute(get("/api/hf/bookings?role=customer"), env)).toBeNull();
    expect(await hfBookingsAppRoute(send("POST", "/api/hf/bookings", { quoteId: "x" }), env)).toBeNull();
  });

  it("lists only the caller's own bookings (uid is the bound filter) and never leaks uids or numbers", async () => {
    const { env, calls } = mkEnv([[/FROM hf_bookings b/, [row()]]]);
    const res = await hfBookingsAppRoute(get("/api/hf/bookings?role=fan"), env);
    expect(res?.status).toBe(200);
    const q = calls.find((c) => /FROM hf_bookings b/.test(c.sql))!;
    expect(q.sql).toContain("b.customer_uid=?1");
    expect(q.args[0]).toBe("fan-1");
    const text = JSON.stringify(await res!.json());
    expect(text).not.toMatch(/fan-1|host-1|customer_uid|host_uid|\+91|9876543210/);
    expect(text).toContain("tara-ab12");
  });

  it("host list shows the fan handle (first name) and the note, never a phone number", async () => {
    vi.mocked(authz.requireUser).mockResolvedValue({ uid: "host-1" } as never);
    const { env, calls } = mkEnv([
      [/SELECT uid,slug,status,category/, { uid: "host-1", slug: "tara-ab12", status: "live", category: "influencer", price_per_min: 20 }],
      [/FROM hf_bookings b/, [row({ fan_name: "Ravi 9876543210" }), row({ id: "22222222-2222-4222-8222-222222222222", fan_name: "Neha Kapoor" })]],
      [/FROM hf_booking_notes/, [{ booking_id: BID, note: "Birthday surprise" }]],
    ]);
    const res = await hfBookingsAppRoute(get("/api/hf/bookings?role=host&day=2026-10-20"), env);
    const body = await res!.json() as { bookings: Array<Record<string, unknown>> };
    expect(calls.find((c) => /FROM hf_bookings b/.test(c.sql))!.sql).toContain("b.host_uid=?1");
    expect(body.bookings.map((b) => b.fanHandle)).toEqual(["Ravi", "Neha"]);
    expect(body.bookings[0].note).toBe("Birthday surprise");
    expect(JSON.stringify(body)).not.toMatch(/9876543210|customer_uid|fan-1/);
  });
});

describe("booking", () => {
  it("holds 10 x rate: asks for a 10-minute quote, confirms with the quote id and returns the hold", async () => {
    vi.mocked(bookings.quoteRoute).mockResolvedValue(new Response(JSON.stringify({ quote: { id: "q-1", reservedPaise: 5000 } }), { status: 201 }));
    vi.mocked(bookings.confirmRoute).mockResolvedValue(new Response(JSON.stringify({ booking: { id: BID } }), { status: 201 }));
    const { env, calls } = mkEnv([[/FROM hf_bookings b/, [row()]]]);
    const start = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
    const res = await hfBookingsAppRoute(send("POST", "/api/hf/bookings", { hostSlug: "Tara-AB12", startAt: start, note: "Trip tips" }), env);
    expect(res?.status).toBe(201);
    const qBody = await vi.mocked(bookings.quoteRoute).mock.calls[0][0].json();
    expect(qBody).toEqual({ hostSlug: "tara-ab12", startUtc: start, durationMinutes: 10 });
    const cReq = vi.mocked(bookings.confirmRoute).mock.calls[0][0];
    expect(await cReq.json()).toEqual({ quoteId: "q-1", policyAccepted: true });
    expect(cReq.headers.get("Idempotency-Key")).toBe("app-q-1");
    expect(cReq.headers.get("authorization")).toBe("Bearer t");
    const body = await res!.json() as { booking: Record<string, unknown> };
    expect(body.booking).toMatchObject({ holdPaise: 5000, minutes: 10, hostSlug: "tara-ab12", canCancel: true });
    expect(calls.some((c) => /INSERT OR IGNORE INTO hf_booking_notes/.test(c.sql) && c.args.includes("Trip tips"))).toBe(true);
    const confirmations = calls.filter((c) => /INTO whatsapp_outbox/.test(c.sql));
    expect(confirmations).toHaveLength(2); // fan and influencer
    expect(JSON.stringify(confirmations.map((c) => c.args[6]))).not.toMatch(/9876543210/);
  });

  it("rejects a double booking with 409 and a plain message", async () => {
    vi.mocked(bookings.quoteRoute).mockResolvedValue(new Response(JSON.stringify({ error: "slot_unavailable" }), { status: 409 }));
    const { env } = mkEnv([]);
    const res = await hfBookingsAppRoute(send("POST", "/api/hf/bookings", { hostSlug: "tara-ab12", startAt: NOW.toISOString() }), env);
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ error: "slot_unavailable", message: expect.stringContaining("Someone just took") });
    expect(bookings.confirmRoute).not.toHaveBeenCalled();
  });

  it("low balance is 402 and says how much is needed", async () => {
    vi.mocked(bookings.quoteRoute).mockResolvedValue(new Response(JSON.stringify({ quote: { id: "q-2", reservedPaise: 12000 } }), { status: 201 }));
    vi.mocked(bookings.confirmRoute).mockResolvedValue(new Response(JSON.stringify({ error: "low_balance", reservedPaise: 12000, shortfallSeconds: 300 }), { status: 402 }));
    const { env } = mkEnv([]);
    const res = await hfBookingsAppRoute(send("POST", "/api/hf/bookings", { hostSlug: "tara-ab12", startAt: NOW.toISOString() }), env);
    expect(res?.status).toBe(402);
    expect(await res!.json()).toMatchObject({ error: "low_balance", needPaise: 12000, needRupees: 120, message: expect.stringContaining("₹120") });
  });

  it("refuses a note with a phone number", async () => {
    const { env } = mkEnv([]);
    const res = await hfBookingsAppRoute(send("POST", "/api/hf/bookings", { hostSlug: "tara-ab12", startAt: NOW.toISOString(), note: "call me on 98765 43210" }), env);
    expect(res?.status).toBe(400);
    expect(bookings.quoteRoute).not.toHaveBeenCalled();
  });
});

describe("cancel windows", () => {
  const releaseStatements = () => {
    const stmt = () => ({ bind: () => ({}) });
    vi.mocked(ledger.getReservation).mockResolvedValue({ secondsCovered: 600, lots: [{ lotId: "l1", micro: 1 }] } as never);
    vi.mocked(ledger.buildReleaseStatements).mockReturnValue([stmt(), stmt(), stmt()] as never);
  };
  const cancelEnv = (r: Record<string, unknown>, after: Record<string, unknown> = { ...r, status: "cancelled", settlement_status: "released" }) => {
    let reads = 0;
    return mkEnv([[/SELECT \* FROM hf_bookings WHERE id/, () => (reads++ === 0 ? r : after)],
      [/FROM hf_bookings b\s+LEFT JOIN/, r]]);
  };

  it("fan: free more than 1 hour before — hold released", async () => {
    releaseStatements();
    const { env, batches } = cancelEnv(row());
    const res = await hfBookingsAppRoute(send("DELETE", `/api/hf/bookings/${BID}`), env);
    expect(res?.status).toBe(200);
    expect(await res!.json()).toMatchObject({ ok: true, refunded: true, refundPaise: 5000, status: "cancelled" });
    expect(batches).toHaveLength(1);
  });

  it("fan: inside the last hour is 409 too_late with a message and the hold is kept", async () => {
    releaseStatements();
    const { env, batches } = cancelEnv(row({ starts_at: NOW.getTime() + 30 * 60_000, ends_at: NOW.getTime() + 40 * 60_000 }));
    const res = await hfBookingsAppRoute(send("DELETE", `/api/hf/bookings/${BID}`), env);
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ error: "too_late", message: expect.stringContaining("1 hour") });
    expect(batches).toHaveLength(0);
  });

  it("host: cancelling inside the last hour still refunds the fan", async () => {
    vi.mocked(authz.requireUser).mockResolvedValue({ uid: "host-1" } as never);
    releaseStatements();
    const { env, batches } = cancelEnv(row({ starts_at: NOW.getTime() + 10 * 60_000, ends_at: NOW.getTime() + 20 * 60_000 }));
    const res = await hfBookingsAppRoute(send("DELETE", `/api/hf/bookings/${BID}`), env);
    expect(res?.status).toBe(200);
    expect(await res!.json()).toMatchObject({ refunded: true, message: expect.stringContaining("refunded in full") });
    expect(batches).toHaveLength(1);
  });

  it("someone else's booking is a 404", async () => {
    vi.mocked(authz.requireUser).mockResolvedValue({ uid: "stranger" } as never);
    const { env } = mkEnv([]);
    expect((await hfBookingsAppRoute(send("DELETE", `/api/hf/bookings/${BID}`), env))?.status).toBe(404);
  });
});

describe("availability and rate", () => {
  const sched = { timezone: "Asia/Kolkata", version: 3, durationsMinutes: [10], slotIntervalMinutes: 10, bufferMinutes: 0, minNoticeMinutes: 60, horizonDays: 21, rules: [],
    exceptions: [{ date: "2026-10-22", startMin: 600, endMin: 610, status: "available" as const }, { date: "2026-10-22", startMin: 960, endMin: 970, status: "available" as const }] };
  const host = { uid: "host-1", slug: "tara-ab12", status: "live", category: "influencer", price_per_min: 100 };

  beforeEach(() => { vi.mocked(authz.requireUser).mockResolvedValue({ uid: "host-1" } as never); });

  it("GET shows open days with slots, booked slots, and the server's 'you get' number", async () => {
    vi.mocked(store.getHfBookingSchedule).mockResolvedValue(sched);
    const { env } = mkEnv([[/SELECT uid,slug,status,category/, host], [/SELECT starts_at FROM hf_bookings/, [{ starts_at: Date.parse("2026-10-22T04:30:00Z") }]]]);
    const res = await hfBookingsAppRoute(get("/api/hf/hosts/me/availability"), env);
    const b = await res!.json() as Record<string, any>;
    expect(b.days["2026-10-22"]).toEqual({ open: true, slots: ["10:00", "16:00"] });
    expect(b.booked["2026-10-22"]).toEqual(["10:00"]);
    expect(b.rate.hostGetsPerMinPaise).toBe(5800); // 60% of Rs100 minus the Rs2 call cost
    expect(b.slotChoices[0]).toBe("09:00");
  });

  it("closing a booked slot is 409 until the booking is cancelled", async () => {
    vi.mocked(store.getHfBookingSchedule).mockResolvedValue(sched);
    const { env } = mkEnv([[/SELECT uid,slug,status,category/, host], [/SELECT id,starts_at FROM hf_bookings/, [{ id: BID, starts_at: Date.parse("2026-10-22T04:30:00Z") }]]]);
    const res = await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/availability", { days: { "2026-10-22": { open: true, slots: ["16:00"] } } }), env);
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ error: "slot_booked", bookingIds: [BID] });
    expect(store.saveHfBookingSchedule).not.toHaveBeenCalled();
  });

  it("saves slots as dated windows under the write lease", async () => {
    vi.mocked(store.getHfBookingSchedule).mockResolvedValue(sched);
    vi.mocked(store.acquireHfScheduleWriteLock).mockResolvedValue("lease");
    vi.mocked(store.saveHfBookingSchedule).mockResolvedValue(4);
    vi.mocked(store.releaseHfScheduleWriteLock).mockResolvedValue();
    const { env } = mkEnv([[/SELECT uid,slug,status,category/, host], [/SELECT id,starts_at FROM hf_bookings/, []], [/SELECT starts_at FROM hf_bookings/, []]]);
    const res = await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/availability", { days: { "2026-10-23": { open: true, slots: ["10:00", "10:10", "18:00"] }, "2026-10-22": { open: false, slots: [] } } }), env);
    expect(res?.status).toBe(200);
    const saved = vi.mocked(store.saveHfBookingSchedule).mock.calls[0][4];
    expect(saved.exceptions).toEqual([
      { date: "2026-10-23", startMin: 600, endMin: 620, status: "available" },
      { date: "2026-10-23", startMin: 1080, endMin: 1090, status: "available" },
    ]);
    expect(saved.durationsMinutes).toEqual([10]);
    expect(store.releaseHfScheduleWriteLock).toHaveBeenCalled();
  });

  it("rejects a past date and a bad slot", async () => {
    vi.mocked(store.getHfBookingSchedule).mockResolvedValue(sched);
    const { env } = mkEnv([[/SELECT uid,slug,status,category/, host]]);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/availability", { days: { "2026-10-01": { open: true, slots: ["10:00"] } } }), env))?.status).toBe(400);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/availability", { days: { "2026-10-22": { open: true, slots: ["25:00"] } } }), env))?.status).toBe(400);
  });

  it("rate: valid change saves; out of range is 400; the preview uses the server rule", async () => {
    const { env, calls } = mkEnv([[/SELECT uid,slug,status,category/, host]]);
    const ok = await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 50 }), env);
    expect(ok?.status).toBe(200);
    expect(calls.some((c) => /UPDATE hf_hosts SET price_per_min/.test(c.sql) && c.args[0] === 50)).toBe(true);
    expect((await ok!.json() as any).rate.hostGetsPerMinPaise).toBe(2800);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 2 }), env))?.status).toBe(400);
    const prev = await hfBookingsAppRoute(get("/api/hf/hosts/me/rate?rate=200"), env);
    expect((await prev!.json() as any).rate.hostGetsPerMinPaise).toBe(11800);
  });

  it("rate: with the Standard plan on, a standard host gets a clear 409 rate_fixed", async () => {
    flag({ hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 99_999_999 });
    const { env } = mkEnv([[/SELECT uid,slug,status,category/, { ...host, category: "standard", price_per_min: 10 }]]);
    const res = await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 20 }), env);
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ error: "rate_fixed", message: expect.stringContaining("can't change") });
  });
});

describe("[HF-WIRE-18] influencers set their own rate (HF-REEL-37)", () => {
  const std = { hfStdPlanEnabled: true, hfTokensEnabled: true, hfAppMinBuild: 99_999_999 };
  const stdHost = { uid: "host-1", slug: "tara-ab12", status: "live", category: "standard", price_per_min: 5 };
  beforeEach(() => { vi.mocked(authz.requireUser).mockResolvedValue({ uid: "host-1" } as never); });

  it("with hfInfluencerSetsRate on, the Standard plan stays on but her rate is editable: min Rs 5, max Rs 100, 'you get' by the HF-REEL-30 rule", async () => {
    flag({ ...std, hfInfluencerSetsRate: true });
    const { env, calls } = mkEnv([[/SELECT uid,slug,status,category/, stdHost]]);
    const got = await hfBookingsAppRoute(get("/api/hf/hosts/me/rate"), env);
    expect((await got!.json() as any).rate).toMatchObject({ ratePerMin: 5, minRate: 5, maxRate: 100, editable: true, hostGetsPerMinPaise: 180 });
    const ok = await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 5 }), env);
    expect(ok?.status).toBe(200);
    expect(calls.some((c) => /UPDATE hf_hosts SET price_per_min/.test(c.sql) && c.args[0] === 5)).toBe(true);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 4 }), env))?.status).toBe(400);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 101 }), env))?.status).toBe(400);
    const prev = await hfBookingsAppRoute(get("/api/hf/hosts/me/rate?rate=50"), env);
    expect((await prev!.json() as any).rate.hostGetsPerMinPaise).toBe(2880); // 60% of (Rs 50 - Rs 2)
  });

  it("with hfMinRatePaise raised, the stepper floor follows the server", async () => {
    flag({ ...std, hfInfluencerSetsRate: true, hfMinRatePaise: 1000 });
    const { env } = mkEnv([[/SELECT uid,slug,status,category/, { ...stdHost, price_per_min: 10 }]]);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 9 }), env))?.status).toBe(400);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 10 }), env))?.status).toBe(200);
  });

  it("with the switch off nothing changes: Standard plan still fixes a standard host's rate", async () => {
    flag({ ...std, hfInfluencerSetsRate: false });
    const { env } = mkEnv([[/SELECT uid,slug,status,category/, stdHost]]);
    expect((await hfBookingsAppRoute(send("PUT", "/api/hf/hosts/me/rate", { pricePerMin: 20 }), env))?.status).toBe(409);
  });
});

describe("public slots and auto-start", () => {
  it("slots: only free open dates, no uids", async () => {
    const sched = { timezone: "Asia/Kolkata", version: 2, durationsMinutes: [10], slotIntervalMinutes: 10, bufferMinutes: 0, minNoticeMinutes: 60, horizonDays: 21, rules: [],
      exceptions: [{ date: "2026-10-22", startMin: 600, endMin: 610, status: "available" as const }, { date: "2026-10-22", startMin: 960, endMin: 970, status: "available" as const }] };
    vi.mocked(store.getHfBookingSchedule).mockResolvedValue(sched);
    // the 10:00 IST slot (04:30Z) is already taken
    vi.mocked(store.listHfBusyIntervals).mockResolvedValue([{ startAt: Date.parse("2026-10-22T04:30:00Z"), endAt: Date.parse("2026-10-22T04:40:00Z") }]);
    const { env } = mkEnv([[/FROM hf_hosts WHERE slug/, { uid: "host-1", slug: "tara-ab12", status: "live", category: "influencer", price_per_min: 20 }]]);
    const res = await hfBookingsAppRoute(get("/api/hf/hosts/tara-ab12/slots?from=2026-10-20&to=2026-10-26"), env);
    const b = await res!.json() as Record<string, any>;
    expect(b.days).toEqual({ "2026-10-22": ["16:00"] });
    expect(b.openDates).toEqual(["2026-10-22"]);
    expect(b.holdPaise).toBe(20 * 100 * 10);
    expect(JSON.stringify(b)).not.toMatch(/host-1|uid/);
  });

  it("auto-start starts due, unstarted bookings only", async () => {
    vi.mocked(bookings.startBookingCore).mockResolvedValue(new Response("{}", { status: 201 }));
    const { env, calls } = mkEnv([[/FROM hf_bookings b WHERE b.status='confirmed'/, [row()]]]);
    const r = await runHfBookingAutoStart(env, NOW.getTime());
    expect(r).toEqual({ scanned: 1, started: 1, blocked: 0 });
    expect(calls[0].sql).toContain("NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.booking_id=b.id)");
    expect(vi.mocked(bookings.startBookingCore).mock.calls[0][2]).toBeNull();
  });
});
