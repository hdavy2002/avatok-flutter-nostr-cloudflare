import { describe, it, expect } from "vitest";
import { slotsFor, istMidnight, istLabel, istDate } from "./slots";
const rules = [{ weekday: 2, start: "10:00", end: "11:00" }]; // Tuesday
describe("slotsFor", () => {
  const date = "2026-10-06"; // a Tuesday
  const now = istMidnight("2026-10-01");
  it("makes 30-min slots inside the window, IST labels", () => {
    const s = slotsFor(date, rules, [], [], 30, 0, now);
    expect(s.map((x) => x.label)).toEqual(["10:00 AM", "10:30 AM"]);
    expect(istDate(s[0].start_ms)).toBe(date);
  });
  it("drops busy and day-off", () => {
    const busy = [{ start_ms: istMidnight(date) + 10 * 3600e3, end_ms: istMidnight(date) + 10.5 * 3600e3 }];
    expect(slotsFor(date, rules, [], busy, 30, 0, now).map((x) => x.label)).toEqual(["10:30 AM"]);
    expect(slotsFor(date, rules, [{ date, off: true }], [], 30, 0, now)).toEqual([]);
  });
  it("respects 2 h lead time", () => {
    expect(slotsFor(date, rules, [], [], 30, 0, istMidnight(date) + 8.25 * 3600e3).map((x) => x.label)).toEqual(["10:30 AM"]);
  });
  it("label", () => { expect(istLabel(istMidnight(date) + 19.5 * 3600e3)).toBe("7:30 PM"); });
});
