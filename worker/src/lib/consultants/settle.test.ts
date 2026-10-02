import { describe, it, expect } from "vitest";
import { decideOutcome, overlapSeconds, type OutcomeInput } from "./settle";

const START = 1_000_000_000_000, END = START + 30 * 60_000;
const base: OutcomeInput = { now: START, slot_start_ms: START, slot_end_ms: END, consultant_joined_at: null, customer_joined_at: null, overlap_seconds: 0, call_ended: false };
const min = (n: number) => n * 60_000;

describe("decideOutcome", () => {
  it("waits before the no-show windows", () => {
    expect(decideOutcome({ ...base, now: START + min(9) })).toBeNull();
  });
  it("consultant absent at +10 min -> no_show_consultant", () => {
    expect(decideOutcome({ ...base, now: START + min(10) })).toBe("no_show_consultant");
    expect(decideOutcome({ ...base, now: START + min(11), customer_joined_at: START })).toBe("no_show_consultant");
  });
  it("consultant in, customer absent: waits until +15 then no_show_customer", () => {
    const i = { ...base, consultant_joined_at: START };
    expect(decideOutcome({ ...i, now: START + min(14) })).toBeNull();
    expect(decideOutcome({ ...i, now: START + min(15) })).toBe("no_show_customer");
  });
  it("both in, call still running -> wait", () => {
    expect(decideOutcome({ ...base, now: START + min(20), consultant_joined_at: START, customer_joined_at: START, overlap_seconds: 900 })).toBeNull();
  });
  it("both in, ended with >= 5 min overlap -> completed", () => {
    const i = { ...base, now: START + min(25), consultant_joined_at: START, customer_joined_at: START, call_ended: true };
    expect(decideOutcome({ ...i, overlap_seconds: 300 })).toBe("completed");
    expect(decideOutcome({ ...i, overlap_seconds: 299 })).toBe("review");
  });
  it("both in, never ended but slot + grace passed -> decided", () => {
    const i = { ...base, now: END + min(5), consultant_joined_at: START, customer_joined_at: START, overlap_seconds: 1500 };
    expect(decideOutcome(i)).toBe("completed");
    expect(decideOutcome({ ...i, now: END + min(4) })).toBeNull();
  });
});

describe("overlapSeconds", () => {
  it("sums only the time both were present", () => {
    const a = [{ s: 0, e: 100_000 }, { s: 200_000, e: null }];
    const b = [{ s: 50_000, e: 250_000 }];
    expect(overlapSeconds(a, b, 400_000)).toBe(50 + 50);
  });
  it("is zero when never together", () => {
    expect(overlapSeconds([{ s: 0, e: 10_000 }], [{ s: 20_000, e: 30_000 }], 99_000)).toBe(0);
  });
});
