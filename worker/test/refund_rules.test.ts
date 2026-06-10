// Phase 7 A2 — table-driven tests for the refund/settlement rules engine.
// Each rule Rn: inputs = attendance rows + times; expected = the exact money
// actions (≙ ledger rows the executor emits) + email template ids.
//
//   npm test   (vitest run)
import { describe, it, expect } from "vitest";
import { evaluate, mergedIntervals, type SessionCtx, type Action, type AttRow } from "../src/rules";

const MIN = 60_000;
const T0 = 1_700_000_000_000;                 // session start
const RULES = [
  { id: "R1", params: { wait_min: 20 }, enabled: true },
  { id: "R2", params: { wait_min: 20, presence_pct: 75 }, enabled: true },
  { id: "R3", params: { min_pct: 50 }, enabled: true },
  { id: "R4", params: { hours: 24 }, enabled: true },
  { id: "R5", params: { refund_pct: 50 }, enabled: true },
  { id: "R6", params: {}, enabled: true },
  { id: "R7", params: { downtime_min: 5 }, enabled: true },
];

function consult(over: Partial<SessionCtx> = {}): SessionCtx {
  return {
    sid: "bk1", kind: "consult", capacity: 1,
    startsAt: T0, endsAt: T0 + 60 * MIN,        // 60-min slot
    hostId: "creator", title: "Test consult",
    orders: [{ id: "ord1", buyer_id: "buyer", amount: 1000, status: "held" }],
    attendance: [], now: T0 + 21 * MIN, rules: RULES,
    ...over,
  };
}
function live(over: Partial<SessionCtx> = {}): SessionCtx {
  return {
    sid: "lst1", kind: "live_event", capacity: 0,
    startsAt: T0, endsAt: T0 + 60 * MIN,
    hostId: "creator", title: "Test live",
    orders: [
      { id: "o1", buyer_id: "b1", amount: 500, status: "held" },
      { id: "o2", buyer_id: "b2", amount: 500, status: "held" },
    ],
    attendance: [], now: T0 + 21 * MIN, rules: RULES,
    ...over,
  };
}
const att = (user: string, role: "host" | "attendee", from: number, to: number | null): AttRow =>
  ({ user_id: user, role, joined_at: from, left_at: to });

const refunds = (a: Action[]) => a.filter((x) => x.kind === "refund") as Extract<Action, { kind: "refund" }>[];
const releases = (a: Action[]) => a.filter((x) => x.kind === "release") as Extract<Action, { kind: "release" }>[];
const statuses = (a: Action[]) => a.filter((x) => x.kind === "set_status") as Extract<Action, { kind: "set_status" }>[];

describe("R1 — creator no-show", () => {
  it("refunds every order 100%, cancels the event, strikes the creator", () => {
    const a = evaluate(live(), "noshow");
    expect(refunds(a)).toHaveLength(2);
    expect(refunds(a).map((r) => r.amount)).toEqual([500, 500]);
    expect(refunds(a).every((r) => r.rule === "R1" && r.email === "event_cancelled")).toBe(true);
    expect(a.some((x) => x.kind === "cancel_event")).toBe(true);
    expect(a.some((x) => x.kind === "strike" && x.creatorId === "creator")).toBe(true);
    expect(statuses(a).every((s) => s.status === "refunded_full")).toBe(true);
  });
  it("does NOT fire when the live input connected within the window", () => {
    const a = evaluate(live({ liveStartedAt: T0 + 5 * MIN }), "noshow");
    expect(refunds(a)).toHaveLength(0);
    expect(a.some((x) => x.kind === "strike")).toBe(false);
  });
  it("does NOT fire before start+20min", () => {
    const a = evaluate(live({ now: T0 + 10 * MIN }), "noshow");
    expect(a).toEqual([{ kind: "noop", rule: "R1", detail: "window not elapsed" }]);
  });
  it("a 60s host blip inside the window is NOT a no-show (A3)", () => {
    const a = evaluate(consult({
      attendance: [att("creator", "host", T0, T0 + 8 * MIN), att("creator", "host", T0 + 9 * MIN, null)],
    }), "noshow");
    expect(refunds(a).filter((r) => r.rule === "R1")).toHaveLength(0);
  });
});

describe("R2 — buyer no-show on a 1:1 consult", () => {
  const waited = [att("creator", "host", T0 - 2 * MIN, null)]; // host present throughout
  it("creator gets 20-min pro-rata (fee applies), remainder refunded with the no-show email", () => {
    const a = evaluate(consult({ attendance: waited }), "noshow");
    // 1000 coins × 20/60 = 333 to the creator (release → 80/20 downstream), 667 back.
    expect(releases(a)).toEqual([{ kind: "release", orderId: "ord1", gross: 333, rule: "R2", email: "settlement_paid" }]);
    expect(refunds(a)).toHaveLength(1);
    expect(refunds(a)[0]).toMatchObject({ orderId: "ord1", buyerId: "buyer", amount: 667, rule: "R2", email: "no_show_buyer" });
    expect(statuses(a)[0].status).toBe("refunded_partial");
  });
  it("does NOT fire when the buyer joined (even briefly)", () => {
    const a = evaluate(consult({ attendance: [...waited, att("buyer", "attendee", T0 + 3 * MIN, T0 + 4 * MIN)] }), "noshow");
    expect(refunds(a).filter((r) => r.rule === "R2")).toHaveLength(0);
  });
  it("does NOT fire when the creator did not actually wait", () => {
    const a = evaluate(consult({ attendance: [att("creator", "host", T0, T0 + 4 * MIN)] }), "noshow");
    expect(refunds(a).filter((r) => r.rule === "R2")).toHaveLength(0);
  });
  it("never fires for group consults", () => {
    const a = evaluate(consult({ capacity: 10, attendance: waited }), "noshow");
    expect(refunds(a).filter((r) => r.rule === "R2")).toHaveLength(0);
  });
});

describe("R3 — completed normally", () => {
  it("live event that ran ≥50% releases 80/20 per order with settlement email", () => {
    const a = evaluate(live({ now: T0 + 62 * MIN, liveStartedAt: T0, liveEndedAt: T0 + 40 * MIN }), "end");
    expect(releases(a)).toHaveLength(2);
    expect(releases(a).every((r) => r.rule === "R3" && r.email === "settlement_paid" && r.gross === 500)).toBe(true);
    expect(statuses(a).every((s) => s.status === "settled")).toBe(true);
  });
  it("host-marked-complete consult settles regardless of duration", () => {
    const a = evaluate(consult({ now: T0 + 62 * MIN, hostMarkedComplete: true }), "end");
    expect(releases(a)).toEqual([{ kind: "release", orderId: "ord1", gross: 1000, rule: "R3", email: "settlement_paid" }]);
  });
  it("undelivered session falls back to a full refund", () => {
    const a = evaluate(live({ now: T0 + 62 * MIN }), "end");
    expect(refunds(a)).toHaveLength(2);
    expect(refunds(a).every((r) => r.rule === "FB" && r.amount === 500)).toBe(true);
  });
});

describe("R4/R5 — buyer cancels", () => {
  it("≥24h before: 100% refund", () => {
    const a = evaluate(consult({
      orders: [{ id: "ord1", buyer_id: "buyer", amount: 1000, status: "held", cancelled_by: "buyer", cancelled_at: T0 - 25 * 60 * MIN }],
    }), "cancel");
    expect(refunds(a)).toEqual([expect.objectContaining({ rule: "R4", amount: 1000, email: "refund_issued" })]);
    expect(releases(a)).toHaveLength(0);
    expect(statuses(a)[0].status).toBe("cancelled");
  });
  it("<24h before: 50% refund, 50% released to the creator (fee applies)", () => {
    const a = evaluate(consult({
      orders: [{ id: "ord1", buyer_id: "buyer", amount: 1000, status: "held", cancelled_by: "buyer", cancelled_at: T0 - 2 * 60 * MIN }],
    }), "cancel");
    expect(refunds(a)).toEqual([expect.objectContaining({ rule: "R5", amount: 500 })]);
    expect(releases(a)).toEqual([expect.objectContaining({ rule: "R5", gross: 500, email: "settlement_paid" })]);
    expect(statuses(a)[0].status).toBe("refunded_partial");
  });
});

describe("R6 — creator cancels", () => {
  it("100% refund + strike", () => {
    const a = evaluate(consult({
      orders: [{ id: "ord1", buyer_id: "buyer", amount: 1000, status: "held", cancelled_by: "creator", cancelled_at: T0 - MIN }],
    }), "cancel");
    expect(refunds(a)).toEqual([expect.objectContaining({ rule: "R6", amount: 1000 })]);
    expect(a.some((x) => x.kind === "strike" && x.rule === "R6")).toBe(true);
  });
});

describe("R7 — platform failure", () => {
  it("≥5 contiguous minutes of downtime: 100% refund, platform_failure email", () => {
    const a = evaluate(live({ now: T0 + 62 * MIN, liveStartedAt: T0, liveEndedAt: T0 + 55 * MIN, infraDowntimeMs: 6 * MIN }), "end");
    expect(refunds(a)).toHaveLength(2);
    expect(refunds(a).every((r) => r.rule === "R7" && r.email === "platform_failure")).toBe(true);
  });
  it("a 3-minute blip does NOT refund — R3 settles instead", () => {
    const a = evaluate(live({ now: T0 + 62 * MIN, liveStartedAt: T0, liveEndedAt: T0 + 55 * MIN, infraDowntimeMs: 3 * MIN }), "end");
    expect(refunds(a)).toHaveLength(0);
    expect(releases(a)).toHaveLength(2);
  });
});

describe("idempotency / engine hygiene", () => {
  it("already-settled orders are never touched", () => {
    const a = evaluate(live({ orders: [{ id: "o1", buyer_id: "b1", amount: 500, status: "settled" }], now: T0 + 62 * MIN }), "end");
    expect(refunds(a)).toHaveLength(0);
    expect(releases(a)).toHaveLength(0);
  });
  it("mergedIntervals bridges sub-90s gaps and respects bigger ones", () => {
    const ivs = mergedIntervals([
      att("u", "attendee", T0, T0 + 5 * MIN),
      att("u", "attendee", T0 + 5 * MIN + 60_000, T0 + 10 * MIN),  // 60s gap → merged
      att("u", "attendee", T0 + 15 * MIN, T0 + 20 * MIN),          // 5min gap → separate
    ], "u", T0 + 30 * MIN);
    expect(ivs).toHaveLength(2);
    expect(ivs[0]).toEqual({ s: T0, e: T0 + 10 * MIN });
  });
});
