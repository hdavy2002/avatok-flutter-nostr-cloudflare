// [HF-WALLET-LIMITS-1] Reconciliation on fixtures: per-day buckets, mismatch detection, range parsing, CSV.
import { describe, it, expect } from "vitest";
import { buildReconciliation, detectTopupMismatches, parseRange, reconciliationCsv, CREDIT_GRACE_MS } from "./hf_reconcile";

const T = (iso: string) => Date.parse(iso);
const FROM = T("2026-10-09T18:30:00Z"); // 10 Oct 00:00 IST
const TO = FROM + 2 * 86_400_000;       // through 11 Oct
const NOW = T("2026-10-12T00:00:00Z");

const topup = (id: string, amount: number, at: number, extra = {}) => ({ id, uid: "u1", amount_rupees: amount, gateway: "razorpay", status: "paid", credited: 1, paid_at: at, created_at: at - 60_000, ...extra });
const credit = (id: string, amount: number, at: number) => ({ ref: `hftop:${id}`, uid: "u1", amount, created_at: at });

describe("mismatch detection", () => {
  const d1 = FROM + 3600_000, d2 = FROM + 86_400_000 + 3600_000;
  it("a clean day has none", () => {
    expect(detectTopupMismatches([topup("a", 500, d1)], [credit("a", 500, d1 + 5000)], FROM, TO, NOW)).toEqual([]);
  });
  it("paid top-up without a wallet credit", () => {
    const m = detectTopupMismatches([topup("a", 500, d1)], [], FROM, TO, NOW);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "paid_without_credit", topupId: "a", topupRupees: 500, creditRupees: null });
  });
  it("a very recent paid top-up is pending (audit queue lag), not a mismatch", () => {
    const now = d1 + CREDIT_GRACE_MS - 1000;
    expect(detectTopupMismatches([topup("a", 500, d1)], [], FROM, TO, now)).toEqual([]);
  });
  it("wallet credit with no top-up record, and with an unpaid top-up", () => {
    const m = detectTopupMismatches([topup("b", 200, d2, { status: "created", credited: 0, paid_at: null })], [credit("zzz", 100, d1), credit("b", 200, d2)], FROM, TO, NOW);
    expect(m.map((x) => [x.kind, x.topupId])).toEqual([["credit_without_paid_topup", "zzz"], ["credit_without_paid_topup", "b"]]);
    expect(m[1].detail).toContain("created");
  });
  it("amount difference, and a double credit for one top-up", () => {
    const m = detectTopupMismatches([topup("a", 500, d1), topup("b", 300, d2)], [credit("a", 400, d1), credit("b", 300, d2), credit("b", 300, d2 + 1)], FROM, TO, NOW);
    expect(m.map((x) => [x.kind, x.topupId, x.creditRupees])).toEqual([["amount_difference", "a", 400], ["amount_difference", "b", 600]]);
  });
  it("credits across midnight still match, and items outside the range are not reported", () => {
    const late = FROM - 600_000; // 23:50 IST the day before the range: credit lands inside the range
    expect(detectTopupMismatches([topup("a", 500, late)], [credit("a", 500, FROM + 60_000)], FROM, TO, NOW)).toEqual([]);
    expect(detectTopupMismatches([topup("old", 500, FROM - 5 * 86_400_000)], [], FROM, TO, NOW)).toEqual([]);
  });
});

describe("buildReconciliation", () => {
  const d1 = FROM + 3600_000, d2 = FROM + 86_400_000 + 3600_000;
  const rep = buildReconciliation({
    fromMs: FROM, toMs: TO, now: NOW,
    topups: [topup("a", 500, d1), topup("b", 1000, d1 + 10, { gateway: "cashfree" }), topup("c", 200, d2), topup("x", 99, d2, { status: "failed", credited: 0, paid_at: null })],
    credits: [credit("a", 500, d1), credit("b", 1000, d1), credit("c", 200, d2)],
    calls: [
      { ts: d1, paid_rupees: 100, test_rupees: 0, host_paid_rupees: 48, host_test_rupees: 0 },
      { ts: d1, paid_rupees: 30, test_rupees: 20, host_paid_rupees: 14, host_test_rupees: 9 },
      { ts: d2, paid_rupees: 0, test_rupees: 60, host_paid_rupees: 0, host_test_rupees: 28 },
    ],
    payouts: [{ id: "p1", host_uid: "h1", amount_rupees: 600, utr: "UTR123456", paid_at: d2 }],
    refunds: null, liabilities: null,
  });
  it("buckets by IST day, zero-filled, by gateway", () => {
    expect(rep.days.map((d) => d.date)).toEqual(["2026-10-10", "2026-10-11"]);
    expect(rep.days[0].topups).toEqual({ count: 2, rupees: 1500, byGateway: { razorpay: { count: 1, rupees: 500 }, cashfree: { count: 1, rupees: 1000 } } });
    expect(rep.days[0].walletCredits).toEqual({ count: 2, rupees: 1500 });
    expect(rep.days[1].topups.count).toBe(1); // the failed one is not counted
  });
  it("splits call charges, host earnings and platform share into paid vs test", () => {
    expect(rep.days[0].calls).toEqual({ paid: 130, test: 20 });
    expect(rep.days[0].hostEarnings).toEqual({ paid: 62, test: 9 });
    expect(rep.days[0].platformShare).toEqual({ paid: 68, test: 11 });
    expect(rep.totals.calls).toEqual({ paid: 130, test: 80 });
    expect(rep.totals.platformShare.test).toBe(11 + 32);
  });
  it("payouts with UTR, refunds marked unavailable when that table is absent, no mismatches on clean data", () => {
    expect(rep.totals.payouts).toEqual({ count: 1, rupees: 600 });
    expect(rep.payouts[0].utr).toBe("UTR123456");
    expect(rep.refundsAvailable).toBe(false);
    expect(rep.totals.refunds).toBeNull();
    expect(rep.mismatches).toEqual([]);
  });
  it("counts refunds when the table is there", () => {
    const r = buildReconciliation({ fromMs: FROM, toMs: TO, now: NOW, topups: [], credits: [], calls: [], payouts: [], refunds: [{ id: "r1", uid: "u1", amount_rupees: 250, paid_at: d1 }], liabilities: null });
    expect(r.refundsAvailable).toBe(true);
    expect(r.totals.refunds).toEqual({ count: 1, rupees: 250 });
  });
  it("CSV has a header, one row per day, a TOTAL row, mismatches and payouts", () => {
    const csv = reconciliationCsv({ ...rep, mismatches: [{ kind: "paid_without_credit", topupId: "a", uid: "u1", topupRupees: 5, creditRupees: null, detail: 'x, "y"', at: d1 }] });
    const lines = csv.trim().split("\n");
    expect(lines[0].startsWith("date,topups_count")).toBe(true);
    expect(lines[1].startsWith("2026-10-10,2,1500,")).toBe(true);
    expect(lines[3].startsWith("TOTAL,3,1700")).toBe(true);
    expect(csv).toContain('"x, ""y"""');
    expect(csv).toContain("p1,h1,600,UTR123456,2026-10-11");
  });
});

describe("parseRange", () => {
  it("inclusive IST dates", () => {
    expect(parseRange("2026-10-10", "2026-10-11")).toEqual({ fromMs: FROM, toMs: TO });
  });
  it("defaults to the last 7 days ending today", () => {
    const r = parseRange(null, null, T("2026-10-10T06:30:00Z")) as { fromMs: number; toMs: number };
    expect((r.toMs - r.fromMs) / 86_400_000).toBe(7);
    expect(r.toMs).toBe(T("2026-10-10T18:30:00Z"));
  });
  it("rejects bad, reversed and over-long ranges", () => {
    expect("error" in parseRange("nope", "2026-10-11")).toBe(true);
    expect("error" in parseRange("2026-10-11", "2026-10-10")).toBe(true);
    expect("error" in parseRange("2026-01-01", "2026-10-10")).toBe(true);
  });
});
