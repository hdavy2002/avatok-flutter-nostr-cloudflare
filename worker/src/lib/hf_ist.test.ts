// [HF-WALLET-LIMITS-1] IST boundaries.
import { describe, it, expect } from "vitest";
import {
  istDayStart, istNextDayStart, istMonthStart, istNextMonthStart, istPrevMonthStart, istDateStr, parseIstDate, financialYear,
} from "./hf_ist";

const T = (iso: string) => Date.parse(iso);

describe("IST boundaries", () => {
  it("day starts at 00:00 IST (18:30 UTC the evening before)", () => {
    expect(istDayStart(T("2026-10-10T06:30:00Z"))).toBe(T("2026-10-09T18:30:00Z"));
    expect(istDayStart(T("2026-10-09T18:30:00Z"))).toBe(T("2026-10-09T18:30:00Z")); // exactly midnight IST is the new day
    expect(istDayStart(T("2026-10-09T18:29:59Z"))).toBe(T("2026-10-08T18:30:00Z")); // one second earlier is still yesterday
    expect(istNextDayStart(T("2026-10-10T06:30:00Z"))).toBe(T("2026-10-10T18:30:00Z"));
  });
  it("a late-evening UTC moment is already tomorrow in India", () => {
    expect(istDateStr(T("2026-10-10T20:00:00Z"))).toBe("2026-10-11");
  });
  it("month starts on the 1st at 00:00 IST, across year end too", () => {
    expect(istMonthStart(T("2026-10-31T19:00:00Z"))).toBe(T("2026-10-31T18:30:00Z")); // 1 Nov 00:30 IST
    expect(istMonthStart(T("2026-10-31T17:00:00Z"))).toBe(T("2026-09-30T18:30:00Z")); // 31 Oct 22:30 IST
    expect(istNextMonthStart(T("2026-12-15T00:00:00Z"))).toBe(T("2026-12-31T18:30:00Z"));
    expect(istPrevMonthStart(T("2027-01-05T00:00:00Z"))).toBe(T("2026-11-30T18:30:00Z"));
  });
  it("parseIstDate accepts real dates only", () => {
    expect(parseIstDate("2026-10-10")).toBe(T("2026-10-09T18:30:00Z"));
    expect(parseIstDate("2026-02-30")).toBeNull();
    expect(parseIstDate("10-10-2026")).toBeNull();
    expect(parseIstDate(null)).toBeNull();
  });
  it("financial year runs April to March in IST", () => {
    expect(financialYear(T("2026-10-10T00:00:00Z"))).toEqual({ startYear: 2026, label: "2026-27", short: "26-27" });
    expect(financialYear(T("2027-03-31T17:00:00Z")).label).toBe("2026-27"); // 31 Mar 22:30 IST
    expect(financialYear(T("2027-03-31T19:00:00Z")).label).toBe("2027-28"); // 1 Apr 00:30 IST
    expect(financialYear(T("2026-03-31T18:29:00Z")).label).toBe("2025-26");
    expect(financialYear(T("2099-04-01T00:00:00Z")).label).toBe("2099-00");
  });
});
