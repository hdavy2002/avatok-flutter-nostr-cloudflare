import { describe, expect, it } from "vitest";
import {
  conflictsWithBusy,
  localWallTimeCandidates,
  slotsForDate,
  validateHfBookingSchedule,
  type HfBookingSchedule,
} from "./hf_booking_availability";

const springSchedule = (): HfBookingSchedule => ({
  timezone: "America/New_York", version: 1, durationsMinutes: [30],
  slotIntervalMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 0,
  horizonDays: 60, rules: [{ weekday: 0, startMin: 60, endMin: 180 }], exceptions: [],
});

describe("HF booking availability", () => {
  it("rejects impossible dates, overlap, overnight, and invalid zones", () => {
    const schedule = springSchedule();
    schedule.timezone = "Mars/Olympus";
    schedule.exceptions = [{ date: "2026-02-30", startMin: 0, endMin: 60, status: "available" }];
    schedule.rules.push({ weekday: 0, startMin: 90, endMin: 210 });
    expect(validateHfBookingSchedule(schedule).length).toBeGreaterThan(1);
  });

  it("omits nonexistent spring-forward wall times", () => {
    expect(localWallTimeCandidates("2026-03-08", 150, "America/New_York")).toEqual([]);
    expect(localWallTimeCandidates("2026-03-08", 90, "America/New_York")).toEqual([
      Date.parse("2026-03-08T06:30:00Z"),
    ]);
  });

  it("returns both UTC instants for a repeated fall-back wall time", () => {
    expect(localWallTimeCandidates("2026-11-01", 90, "America/New_York")).toEqual([
      Date.parse("2026-11-01T05:30:00Z"),
      Date.parse("2026-11-01T06:30:00Z"),
    ]);
  });

  it("keeps both fold slots distinct and inside the intended local window", () => {
    const schedule = springSchedule();
    schedule.rules = [{ weekday: 0, startMin: 60, endMin: 120 }];
    const slots = slotsForDate(schedule, "2026-11-01", 30, [], Date.parse("2026-10-31T00:00:00Z"));
    expect(slots).toHaveLength(4);
    expect(new Set(slots.map((slot) => slot.startAt)).size).toBe(4);
    expect(new Set(slots.map((slot) => slot.offsetMinutes))).toEqual(new Set([-240, -300]));
  });

  it("omits slots whose elapsed duration would extend beyond the DST-adjusted window", () => {
    const schedule = springSchedule();
    schedule.rules = [{ weekday: 0, startMin: 60, endMin: 90 }];
    const slots = slotsForDate(schedule, "2026-11-01", 30, [], Date.parse("2026-10-31T00:00:00Z"));
    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.endAt).sort()).toEqual([
      Date.parse("2026-11-01T05:30:00Z"),
      Date.parse("2026-11-01T06:30:00Z"),
    ]);
  });

  it("supports a window ending at local midnight", () => {
    const schedule = springSchedule();
    schedule.timezone = "Etc/UTC";
    schedule.rules = [{ weekday: 0, startMin: 1410, endMin: 1440 }];
    const slots = slotsForDate(schedule, "2026-11-01", 30, [], Date.parse("2026-11-01T00:00:00Z"));
    expect(slots.map((slot) => [slot.startAt, slot.endAt])).toEqual([[
      Date.parse("2026-11-01T23:30:00Z"),
      Date.parse("2026-11-02T00:00:00Z"),
    ]]);
  });

  it("does not expose dates beyond the configured horizon", () => {
    const schedule = springSchedule();
    const now = Date.parse("2026-10-31T00:00:00Z");
    expect(slotsForDate(schedule, "2026-12-30", 30, [], now)).toEqual([]);
  });

  it("uses half-open overlaps and applies symmetric buffers", () => {
    const start = Date.parse("2026-10-15T10:00:00Z");
    const end = start + 30 * 60_000;
    expect(conflictsWithBusy(start, end, [{ startAt: end, endAt: end + 60_000 }], 0)).toBe(false);
    expect(conflictsWithBusy(start, end, [{ startAt: end, endAt: end + 60_000 }], 1)).toBe(true);
  });
});

// [HF-CALL-MODES-D] lengths + hold helpers
import { bookingLengthsFor, defaultBookingMinutes, holdSecondsFor, rowHoldSeconds } from "./hf_booking_availability";
describe("booking lengths and hold", () => {
  it("flag off is [10] / 10 / whole-length hold; on is 15..300 / 15 / min(L,15) minutes", () => {
    expect(bookingLengthsFor(false)).toEqual([10]);
    expect(bookingLengthsFor(true)).toEqual([15, 30, 60, 120, 180, 240, 300]);
    expect(defaultBookingMinutes(false)).toBe(10);
    expect(defaultBookingMinutes(true)).toBe(15);
    expect(holdSecondsFor(10, false)).toBe(600);
    expect(holdSecondsFor(120, false)).toBe(7200);
    expect(holdSecondsFor(15, true)).toBe(900);
    expect(holdSecondsFor(300, true)).toBe(900);
    expect(holdSecondsFor(300, true, 10)).toBe(600);
    expect(holdSecondsFor(300, true, 999)).toBe(900);     // a bad config falls back to 15
  });
  it("rowHoldSeconds uses hold_seconds, falling back to duration_min * 60 for old rows", () => {
    expect(rowHoldSeconds({ hold_seconds: 900, duration_min: 120 })).toBe(900);
    expect(rowHoldSeconds({ hold_seconds: null, duration_min: 10 })).toBe(600);
    expect(rowHoldSeconds({ duration_min: 10 })).toBe(600);
  });
});
