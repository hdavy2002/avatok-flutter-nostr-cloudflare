import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import * as bookingStore from "../lib/hf_booking_store";
import { hfBookingsRoute } from "./hf_bookings";

vi.mock("../authz", () => ({
  requireUser: vi.fn(async () => ({ uid: "host-1" })),
  isFail: (value: unknown) => value instanceof Response,
}));
vi.mock("../lib/hf_booking_store", () => ({
  acquireHfScheduleWriteLock: vi.fn(),
  getHfBookingSchedule: vi.fn(),
  listHfBusyIntervals: vi.fn(),
  releaseHfScheduleWriteLock: vi.fn(),
  saveHfBookingSchedule: vi.fn(),
}));

const schedule = {
  timezone: "Asia/Kolkata", version: 1, durationsMinutes: [30],
  slotIntervalMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 0,
  horizonDays: 60, rules: [{ weekday: 4, startMin: 600, endMin: 630 }], exceptions: [],
};
const env = {
  DB_META: {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => sql.includes("hf_hosts") ? { uid: "host-1", status: "live" } : null,
        all: async () => ({ results: [] }),
      }),
    }),
  },
} as unknown as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("HF booking availability routes", () => {
  it("returns public slots with UTC and host-local labels only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    vi.mocked(bookingStore.getHfBookingSchedule).mockResolvedValue(schedule);
    vi.mocked(bookingStore.listHfBusyIntervals).mockResolvedValue([]);
    const response = await hfBookingsRoute(
      new Request("https://example.invalid/api/hf/hosts/example/availability?from=2026-10-15&durationMinutes=30"),
      env,
    );
    expect(response?.status).toBe(200);
    const body = await response!.json() as { slots: Array<Record<string, unknown>> };
    expect(body.slots).toEqual([{
      startUtc: "2026-10-15T04:30:00.000Z",
      endUtc: "2026-10-15T05:00:00.000Z",
      hostLocalLabel: expect.any(String),
      offsetLabel: "UTC+05:30",
    }]);
    expect(JSON.stringify(body)).not.toMatch(/customer|phone|title|uid/i);
  });

  it("rejects impossible requested dates before reading busy intervals", async () => {
    vi.mocked(bookingStore.getHfBookingSchedule).mockResolvedValue(schedule);
    const response = await hfBookingsRoute(
      new Request("https://example.invalid/api/hf/hosts/example/availability?from=2026-02-30&durationMinutes=30"),
      env,
    );
    expect(response?.status).toBe(400);
    expect(bookingStore.listHfBusyIntervals).not.toHaveBeenCalled();
  });

  it("saves a schedule under the writer lease and returns its new revision", async () => {
    vi.mocked(bookingStore.acquireHfScheduleWriteLock).mockResolvedValue("lease-1");
    vi.mocked(bookingStore.saveHfBookingSchedule).mockResolvedValue(2);
    vi.mocked(bookingStore.releaseHfScheduleWriteLock).mockResolvedValue();
    const response = await hfBookingsRoute(
      new Request("https://example.invalid/api/hosts/me/availability", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1, schedule }),
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ schedule: { ...schedule, version: 2 } });
    expect(bookingStore.saveHfBookingSchedule).toHaveBeenCalledWith(
      env, "host-1", 1, "lease-1", schedule,
    );
    expect(bookingStore.releaseHfScheduleWriteLock).toHaveBeenCalledWith(env, "host-1", "lease-1");
  });

  it("returns the authenticated host schedule in the agreed wrapper", async () => {
    vi.mocked(bookingStore.getHfBookingSchedule).mockResolvedValue(schedule);
    const response = await hfBookingsRoute(
      new Request("https://example.invalid/api/hosts/me/availability"),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ schedule, legacyPreview: null });
  });
});
