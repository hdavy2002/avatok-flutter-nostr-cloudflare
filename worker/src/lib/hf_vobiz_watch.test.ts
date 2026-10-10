import { describe, it, expect } from "vitest";
import { reconcileWindow, nearestBalance, lastClosedHour, dedupeKeys, istDate, istHm, istDayStart, rupees } from "./hf_vobiz_watch";

const MIN = 60_000, HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 10, 8, 30);   // 14:00 IST

describe("reconcileWindow", () => {
  const bal = (at: number, p: number) => ({ at, balancePaise: p });
  it("balanced window has zero unexplained", () => {
    const r = reconcileWindow({ balances: [bal(T0, 100000), bal(T0 + HOUR, 90000)], legs: [{ endAt: T0 + 10 * MIN, totalCostPaise: 10000 }], recharges: [] }, T0, T0 + HOUR);
    expect(r).toEqual({ openingPaise: 100000, closingPaise: 90000, callCostPaise: 10000, rechargePaise: 0, unexplainedPaise: 0 });
  });
  it("money that vanished is positive", () => {
    const r = reconcileWindow({ balances: [bal(T0, 100000), bal(T0 + HOUR, 86580)], legs: [{ endAt: T0 + 5 * MIN, totalCostPaise: 10000 }], recharges: [] }, T0, T0 + HOUR);
    expect(r.unexplainedPaise).toBe(3420);
  });
  it("extra money is negative", () => {
    const r = reconcileWindow({ balances: [bal(T0, 100000), bal(T0 + HOUR, 105000)], legs: [{ endAt: T0 + 5 * MIN, totalCostPaise: 1000 }], recharges: [] }, T0, T0 + HOUR);
    expect(r.unexplainedPaise).toBe(-6000);
  });
  it("counts recharges inside the window only", () => {
    const r = reconcileWindow({ balances: [bal(T0, 10000), bal(T0 + HOUR, 60000)], legs: [],
      recharges: [{ at: T0 + 20 * MIN, amountPaise: 50000 }, { at: T0 - 5 * MIN, amountPaise: 99999 }, { at: T0 + HOUR + MIN, amountPaise: 7 }] }, T0, T0 + HOUR);
    expect(r.rechargePaise).toBe(50000);
    expect(r.unexplainedPaise).toBe(0);
  });
  it("ignores legs ending outside (from, to]", () => {
    const r = reconcileWindow({ balances: [bal(T0, 5000), bal(T0 + HOUR, 5000)], legs: [{ endAt: T0, totalCostPaise: 700 }, { endAt: T0 + HOUR + 1, totalCostPaise: 900 }], recharges: [] }, T0, T0 + HOUR);
    expect(r.callCostPaise).toBe(0);
  });
  it("picks the snapshot nearest each edge", () => {
    const r = reconcileWindow({ balances: [bal(T0 - 2 * MIN, 111), bal(T0 + MIN, 222), bal(T0 + HOUR - MIN, 333), bal(T0 + HOUR + 2 * MIN, 444)], legs: [], recharges: [] }, T0, T0 + HOUR);
    expect(r.openingPaise).toBe(222);
    expect(r.closingPaise).toBe(333);
  });
  it("no snapshots gives zero", () => {
    expect(reconcileWindow({ balances: [], legs: [], recharges: [] }, T0, T0 + HOUR).unexplainedPaise).toBe(0);
  });
});

describe("nearestBalance", () => {
  it("respects the 3 minute tolerance", () => {
    expect(nearestBalance([{ at: T0 + 4 * MIN }], T0)).toBeNull();
    expect(nearestBalance([{ at: T0 + 3 * MIN }], T0)).not.toBeNull();
  });
  it("tie goes to the earlier", () => {
    expect(nearestBalance([{ at: T0 + MIN }, { at: T0 - MIN }], T0)?.at).toBe(T0 - MIN);
  });
});

describe("IST helpers and dedupe keys", () => {
  it("formats IST", () => {
    expect(istHm(T0)).toBe("14:00");
    expect(istDate(Date.UTC(2026, 9, 10, 19, 0))).toBe("2026-10-11");
    expect(rupees(3420)).toBe("₹34.20");
  });
  it("istDayStart is IST midnight", () => {
    expect(istDayStart(T0)).toBe(Date.UTC(2026, 9, 9, 18, 30));
  });
  it("lastClosedHour waits 15 minutes", () => {
    expect(lastClosedHour(T0 + 20 * MIN)).toEqual({ from: T0 - HOUR, to: T0 });
    expect(lastClosedHour(T0 + 10 * MIN)).toEqual({ from: T0 - 2 * HOUR, to: T0 - HOUR });
  });
  it("builds stable keys", () => {
    expect(dedupeKeys.lowBalance(T0)).toBe("low_balance:2026-10-10");
    expect(dedupeKeys.unexplainedHour(T0)).toBe(`unexplained:${T0}`);
    expect(dedupeKeys.unknownTraffic("abc")).toBe("unknown_traffic:abc");
    expect(dedupeKeys.apiFailing(T0)).toBe("api_failing:2026-10-10:2"); // 14:xx IST = 3rd six-hour block
    expect(dedupeKeys.chainBroken("hf_vobiz_legs", T0)).toBe("chain_broken:hf_vobiz_legs:2026-10-10");
  });
});
