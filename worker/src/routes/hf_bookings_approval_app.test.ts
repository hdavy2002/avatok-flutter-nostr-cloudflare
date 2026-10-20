// [HF-BOOK-APPROVE-BE] Adapter routes for booking approval: flag off = dark (null), settings validation, status filter validation, open-window maths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import * as config from "./config";
import { hfBookingsAppRoute } from "./hf_bookings_app";
import { openWindows, windowLabel, openAlertText } from "../lib/hf_open_alerts";

vi.mock("../authz", () => ({ requireUser: vi.fn(async () => ({ uid: "host-1" })), isFail: (v: unknown) => v instanceof Response }));
vi.mock("./config", () => ({ readConfig: vi.fn() }));
vi.mock("../hooks", () => ({ track: vi.fn(async () => {}), trackUser: vi.fn(async () => {}), trackException: vi.fn(async () => {}) }));
vi.mock("../lib/hf_booking_store", () => ({
  acquireHfScheduleWriteLock: vi.fn(), getHfBookingSchedule: vi.fn(), listHfBusyIntervals: vi.fn(), releaseHfScheduleWriteLock: vi.fn(), saveHfBookingSchedule: vi.fn(),
}));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: vi.fn(async () => "+919876543210") }));

const BID = "11111111-1111-4111-8111-111111111111";
let settings = { booking_approval: "manual", open_alerts: 1 };
const updates: unknown[][] = [];
function mkEnv() {
  return {
    DB_META: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (/FROM hf_hosts WHERE uid=\?1/.test(sql) && /booking_approval/.test(sql)) return settings;
            if (/FROM hf_hosts/.test(sql)) return { uid: "host-1", slug: "tara-ab12", status: "live", display_name: "Tara" };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            if (/^UPDATE hf_hosts SET booking_approval/.test(sql)) {
              updates.push(args);
              if (args[0]) settings = { ...settings, booking_approval: String(args[0]) };
              if (args[1] !== null) settings = { ...settings, open_alerts: Number(args[1]) };
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 1 } })),
    },
  } as unknown as Env;
}
const req = (method: string, path: string, body?: unknown) => new Request("https://x.test" + path, {
  method, headers: { "content-type": "application/json", authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const flag = (over: Record<string, unknown> = {}) => vi.mocked(config.readConfig).mockResolvedValue({ hfBookingsEnabled: true, ...over } as never);

beforeEach(() => { settings = { booking_approval: "manual", open_alerts: 1 }; updates.length = 0; flag({ hfBookingApprovalEnabled: true }); });
afterEach(() => vi.clearAllMocks());

describe("flag off: the new routes do not exist", () => {
  it("accept, decline and booking-settings fall through (null) so the old router answers exactly as before", async () => {
    flag({ hfBookingApprovalEnabled: false });
    const env = mkEnv();
    expect(await hfBookingsAppRoute(req("POST", `/api/hf/bookings/${BID}/accept`), env)).toBeNull();
    expect(await hfBookingsAppRoute(req("POST", `/api/hf/bookings/${BID}/decline`), env)).toBeNull();
    expect(await hfBookingsAppRoute(req("GET", "/api/hf/hosts/me/booking-settings"), env)).toBeNull();
  });
  it("the status filter is ignored (no 400) while the flag is off", async () => {
    flag({ hfBookingApprovalEnabled: false });
    const res = await hfBookingsAppRoute(req("GET", "/api/hf/bookings?role=fan&status=nonsense"), mkEnv());
    expect(res?.status).toBe(200);
  });
});

describe("flag on", () => {
  it("rejects an unknown status filter with 400 invalid_status", async () => {
    const res = await hfBookingsAppRoute(req("GET", "/api/hf/bookings?role=fan&status=nonsense"), mkEnv());
    expect(res?.status).toBe(400);
    expect(await res?.json()).toMatchObject({ error: "invalid_status" });
  });
  it("accepts pending, upcoming and past", async () => {
    for (const s of ["pending", "upcoming", "past"]) {
      const res = await hfBookingsAppRoute(req("GET", `/api/hf/bookings?role=fan&status=${s}`), mkEnv());
      expect(res?.status).toBe(200);
    }
  });
  it("GET booking-settings returns {approval, openAlerts} with manual / on as the default", async () => {
    const res = await hfBookingsAppRoute(req("GET", "/api/hf/hosts/me/booking-settings"), mkEnv());
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ approval: "manual", openAlerts: true });
  });
  it("PUT booking-settings changes approval and openAlerts, and returns the new values", async () => {
    const res = await hfBookingsAppRoute(req("PUT", "/api/hf/hosts/me/booking-settings", { approval: "auto", openAlerts: false }), mkEnv());
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ approval: "auto", openAlerts: false });
    expect(updates).toHaveLength(1);
  });
  it("PUT booking-settings rejects bad values with 400 invalid_settings and writes nothing", async () => {
    for (const body of [{}, { approval: "maybe" }, { openAlerts: "yes" }, { approval: 1 }]) {
      const res = await hfBookingsAppRoute(req("PUT", "/api/hf/hosts/me/booking-settings", body), mkEnv());
      expect(res?.status).toBe(400);
      expect(await res?.json()).toMatchObject({ error: "invalid_settings" });
    }
    expect(updates).toHaveLength(0);
  });
});

describe("open-window maths", () => {
  it("joins consecutive ten-minute starts into one window and splits on a gap", () => {
    // 18:00-18:50 starts (one window to 19:00) and a separate 21:00 start
    const starts = [1080, 1090, 1100, 1110, 1120, 1130, 1260];
    expect(openWindows(starts)).toEqual([{ fromMin: 1080, toMin: 1140 }, { fromMin: 1260, toMin: 1270 }]);
  });
  it("treats hourly chips as hour-long windows", () => {
    expect(openWindows([1080, 1140, 1200])).toEqual([{ fromMin: 1080, toMin: 1260 }]);
    expect(openWindows([])).toEqual([]);
  });
  it("labels windows the way an influencer reads them, with no unexplained numbers", () => {
    expect(windowLabel({ fromMin: 1080, toMin: 1260 })).toBe("6–9 pm");
    expect(windowLabel({ fromMin: 540, toMin: 720 })).toBe("9 am–12 pm");
    expect(windowLabel({ fromMin: 1110, toMin: 1140 })).toBe("6:30–7 pm");
    expect(openAlertText("6–9 pm")).toContain("6–9 pm");
  });
});
