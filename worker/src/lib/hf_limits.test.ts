// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WALLET-LIMITS-1] IST boundaries, limit capping at call start, and the real-money spend query (in-memory SQLite behind a D1 shim).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  istDayStart, istNextDayStart, istMonthStart, istNextMonthStart, istPrevMonthStart, istDateStr, parseIstDate, financialYear,
  limitDefaults, effectiveLimits, remaining, decideStart, callLimitReason, limitMessage, realSpent, limitSummary,
} from "./hf_limits";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
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

describe("limits", () => {
  it("defaults come from the flags, with the owner's numbers as fallback", () => {
    expect(limitDefaults({})).toEqual({ daily: 2000, monthly: 15000 });
    expect(limitDefaults({ hfDailySpendLimitRupees: 500, hfMonthlySpendLimitRupees: 3000 })).toEqual({ daily: 500, monthly: 3000 });
    expect(limitDefaults({ hfDailySpendLimitRupees: -5, hfMonthlySpendLimitRupees: "x" })).toEqual({ daily: 2000, monthly: 15000 });
  });
  it("an admin override wins per column and can lower as well as raise", () => {
    const d = { daily: 2000, monthly: 15000 };
    expect(effectiveLimits(d, null)).toEqual(d);
    expect(effectiveLimits(d, { daily_rupees: 5000, monthly_rupees: null })).toEqual({ daily: 5000, monthly: 15000 });
    expect(effectiveLimits(d, { daily_rupees: null, monthly_rupees: 4000 })).toEqual({ daily: 2000, monthly: 4000 });
  });
  it("remaining takes the tighter of day and month", () => {
    const l = { daily: 2000, monthly: 15000 };
    expect(remaining(l, 0, 0)).toMatchObject({ dayRemaining: 2000, monthRemaining: 15000, room: 2000, binding: "day" });
    expect(remaining(l, 500, 14800)).toMatchObject({ dayRemaining: 1500, monthRemaining: 200, room: 200, binding: "month" });
    expect(remaining(l, 2500, 2500)).toMatchObject({ dayRemaining: 0, room: 0 });
  });
});

describe("capping at call start", () => {
  it("caps paid funds at the room; test credits are not part of the cap", () => {
    expect(decideStart({ shortfall: 20, paidAvailable: 800, room: 500, binding: "day" })).toEqual({ ok: true, paidUsable: 500, capped: true });
    expect(decideStart({ shortfall: 20, paidAvailable: 300, room: 500, binding: "day" })).toEqual({ ok: true, paidUsable: 300, capped: false });
  });
  it("refuses when the room cannot cover the paid part of the 2-minute minimum", () => {
    expect(decideStart({ shortfall: 20, paidAvailable: 800, room: 10, binding: "day" })).toEqual({ ok: false, reason: "spend_limit", binding: "day" });
    expect(decideStart({ shortfall: 20, paidAvailable: 800, room: 0, binding: "month" })).toEqual({ ok: false, reason: "spend_limit", binding: "month" });
  });
  it("test credits cover the minimum: the call goes ahead on them even with zero room", () => {
    expect(decideStart({ shortfall: 0, paidAvailable: 800, room: 0, binding: "day" })).toEqual({ ok: true, paidUsable: 0, capped: true });
  });
  it("maxMinutes reflects the capped funds: Rs10/min, 500 room, 100 test credits -> 60 min cap not reached, 60", () => {
    // funds = test 100 + paid 500 = 600 -> exactly 60 minutes at Rs10
    expect(callLimitReason({ fundsRupees: 600, rateRupees: 10, maxCallMinutes: 60, capped: true })).toBe("time_limit");
    // funds = 0 test + 500 paid -> 50 minutes, the limit is what ends it
    expect(callLimitReason({ fundsRupees: 500, rateRupees: 10, maxCallMinutes: 60, capped: true })).toBe("spend_limit");
    // not capped: plain low balance
    expect(callLimitReason({ fundsRupees: 500, rateRupees: 10, maxCallMinutes: 60, capped: false })).toBe("balance");
  });
  it("the refusal is a rule of the service, never the host's choice", () => {
    const l = { daily: 2000, monthly: 15000 };
    expect(limitMessage("day", l)).toBe("You've reached today's limit of ₹2,000. It resets at midnight.");
    expect(limitMessage("month", l)).toBe("You've reached this month's limit of ₹15,000. It resets on the 1st.");
    expect(limitMessage("day", l).toLowerCase()).not.toContain("host");
  });
});

function makeEnv(withCapColumn = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, status TEXT, created_at INTEGER, paid_rupees INTEGER, test_rupees INTEGER ${withCapColumn ? ", limit_cap_rupees INTEGER" : ""});
           CREATE TABLE hf_spend_limits (uid TEXT PRIMARY KEY, daily_rupees INTEGER, monthly_rupees INTEGER, note TEXT, admin_uid TEXT, updated_at INTEGER);`);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  return { db, env: { DB_META: { prepare: (q: string) => stmt(q) } } as any };
}

describe("realSpent", () => {
  const NOW = T("2026-10-10T06:30:00Z"); // 12:00 IST
  const add = (h, id, status, at, paid, test, cap = null) => h.db.prepare("INSERT INTO hf_calls (id, caller_uid, status, created_at, paid_rupees, test_rupees, limit_cap_rupees) VALUES (?,?,?,?,?,?,?)").run(id, "u1", status, at, paid, test, cap);

  it("counts only real (paid) money since the boundary; test credits and other days do not count", () => {
    const h = makeEnv();
    add(h, "a", "completed", NOW - 3600_000, 300, 200);      // today: 300 paid, 200 test
    add(h, "b", "completed", NOW - 40 * 3600_000, 900, 0);   // two days ago
    add(h, "c", "failed", NOW - 1800_000, null, null);       // never billed
    return Promise.all([realSpent(h.env, "u1", istDayStart(NOW), NOW), realSpent(h.env, "u1", istMonthStart(NOW), NOW)]).then(([day, month]) => {
      expect(day).toBe(300);
      expect(month).toBe(1200);
    });
  });
  it("a call in progress counts the paid money it may still spend", async () => {
    const h = makeEnv();
    add(h, "a", "completed", NOW - 7200_000, 100, 0);
    add(h, "live", "connected", NOW - 600_000, null, null, 450);
    expect(await realSpent(h.env, "u1", istDayStart(NOW), NOW)).toBe(550);
  });
  it("an 'in progress' row older than 4 hours is a leftover and is ignored", async () => {
    const h = makeEnv();
    add(h, "stale", "ringing_host", NOW - 5 * 3600_000, null, null, 450);
    expect(await realSpent(h.env, "u1", istDayStart(NOW), NOW)).toBe(0);
  });
  it("works before the limit_cap_rupees column is migrated (settled money only)", async () => {
    const h = makeEnv(false);
    h.db.prepare("INSERT INTO hf_calls (id, caller_uid, status, created_at, paid_rupees, test_rupees) VALUES ('a','u1','completed',?,120,0)").run(NOW - 1000);
    expect(await realSpent(h.env, "u1", istDayStart(NOW), NOW)).toBe(120);
  });
  it("limitSummary applies the per-user override and reports the reset time", async () => {
    const h = makeEnv();
    add(h, "a", "completed", NOW - 1000, 700, 0);
    h.db.prepare("INSERT INTO hf_spend_limits VALUES ('u1', 5000, NULL, 'trusted', 'admin', 1)").run();
    const s = await limitSummary(h.env, "u1", {}, NOW);
    expect(s).toMatchObject({ daily: 5000, monthly: 15000, spentToday: 700, spentThisMonth: 700, dayRemaining: 4300, room: 4300, resetsAt: T("2026-10-10T18:30:00Z") });
  });
});
