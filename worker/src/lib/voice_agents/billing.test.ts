// [AUMFE-VOICE-BILLING-1] Pure billing maths + state machine, driven by a tiny in-memory wallet that is idempotent by op id
// exactly like WalletDO (a replayed op id never moves money twice).
import { describe, expect, it } from "vitest";
import {
  applyCharge, balanceEndS, balanceEndsAtSecond, chargeAtSecond, chargedPaise, closeBilling, minutesDue, newBilling, nextChargeDue,
  opIdCharge, priceTokensPerMin, remainingSeconds, runwayHoldTokens, runwayTopUpTokens, type BillingState,
} from "./billing";

class FakeWallet {
  ops = new Map<string, boolean>();
  held = 0;
  constructor(public spendable: number) {}
  charge(opId: string, tokens: number): boolean {
    if (this.ops.has(opId)) return this.ops.get(opId)!;       // replay: same answer, no second debit
    if (this.spendable < tokens) return false;                  // 402 is not recorded (spend returns before recordOp)
    this.spendable -= tokens; this.ops.set(opId, true); return true;
  }
}

/** One tick per second, like the DO. Returns how the call ended. */
function runCall(opts: { wallet: FakeWallet; price: number; free?: number; leaveAtS?: number; maxS?: number }) {
  const { wallet, price } = opts;
  const free = opts.free ?? 0;
  const max = opts.maxS ?? 900;
  let b: BillingState = newBilling(price, free, wallet.spendable);
  const charges: number[] = [];
  let ended: "customer" | "balance_out" | "time_up" = "customer";
  let at = 0;
  for (let e = 0; e <= 100000; e++) {
    at = e;
    const cap = Math.min(e, max - 1);
    let n = nextChargeDue(b, cap);
    let broke = false;
    while (n !== null) {
      if (!wallet.charge(opIdCharge("S", n), price)) { broke = true; break; }
      b = applyCharge(b, n, wallet.spendable);
      charges.push(n);
      n = nextChargeDue(b, cap);
    }
    if (broke) { ended = "balance_out"; break; }
    if (opts.leaveAtS !== undefined && e >= opts.leaveAtS) { ended = "customer"; break; }
    if (e >= max) { ended = "time_up"; break; }
  }
  return { b, charges, ended, at, wallet };
}

describe("price + minutes", () => {
  it("1 token = 100 paise, rounds up, 0 = unpriced", () => {
    expect(priceTokensPerMin(600)).toBe(6);
    expect(priceTokensPerMin(601)).toBe(7);
    expect(priceTokensPerMin(0)).toBe(0);
    expect(priceTokensPerMin(NaN)).toBe(0);
  });
  it("nothing is due in the first 10 s, minute 1 at 10 s, minute N at (N-1)*60 s", () => {
    expect(minutesDue(0, 0)).toBe(0);
    expect(minutesDue(9, 0)).toBe(0);
    expect(minutesDue(10, 0)).toBe(1);
    expect(minutesDue(59, 0)).toBe(1);
    expect(minutesDue(60, 0)).toBe(2);
    expect(minutesDue(119, 0)).toBe(2);
    expect(minutesDue(120, 0)).toBe(3);
    expect(chargeAtSecond(1, 0)).toBe(10);
    expect(chargeAtSecond(2, 0)).toBe(60);
    expect(chargeAtSecond(3, 0)).toBe(120);
  });
  it("still honours free seconds when an operator sets them", () => {
    expect(minutesDue(180, 180)).toBe(0);
    expect(minutesDue(189, 180)).toBe(0);
    expect(minutesDue(190, 180)).toBe(1);
    expect(chargeAtSecond(1, 180)).toBe(190);
    expect(chargeAtSecond(2, 180)).toBe(240);
  });
});

describe("runway hold", () => {
  it("holds min(spendable, 5 minutes)", () => {
    expect(runwayHoldTokens(100, 6)).toBe(30);
    expect(runwayHoldTokens(20, 6)).toBe(20);
    expect(runwayHoldTokens(0, 6)).toBe(0);
  });
  it("tops up only when a bigger runway becomes affordable, never negative", () => {
    expect(runwayTopUpTokens(20, 100, 6)).toBe(10);
    expect(runwayTopUpTokens(30, 24, 6)).toBe(0);
  });
});

describe("balance horizon", () => {
  it("covers charged + affordable minutes", () => {
    expect(balanceEndsAtSecond(0, 20, 6, 0)).toBe(180);  // 3 minutes
    expect(balanceEndsAtSecond(1, 14, 6, 0)).toBe(180);  // 1 paid + 2 affordable
    expect(balanceEndsAtSecond(1, 0, 6, 0)).toBe(60);
    expect(balanceEndsAtSecond(0, 5, 6, 0)).toBe(0);
    expect(balanceEndsAtSecond(0, 5, 0, 0)).toBe(Infinity);
  });
  it("remaining is the tighter of cap and balance, never negative", () => {
    expect(remainingSeconds(30, 900, 180)).toBe(150);
    expect(remainingSeconds(30, 100, 180)).toBe(70);
    expect(remainingSeconds(500, 900, 180)).toBe(0);
  });
});

describe("call simulation", () => {
  it("a call that ends inside the first 10 s charges nothing", () => {
    for (const leave of [0, 1, 9]) {
      const r = runCall({ wallet: new FakeWallet(100), price: 6, leaveAtS: leave });
      expect(r.charges).toEqual([]);
      expect(r.wallet.spendable).toBe(100);
      expect(chargedPaise(r.b)).toBe(0);
    }
  });
  it("10 s charges exactly one minute (Rs 6)", () => {
    const r = runCall({ wallet: new FakeWallet(100), price: 6, leaveAtS: 10 });
    expect(r.charges).toEqual([1]);
    expect(r.wallet.spendable).toBe(94);
    expect(chargedPaise(r.b)).toBe(600);
  });
  it("minute boundaries: 59 s = 1 min, 60 s = 2 min, 125 s = 3 min", () => {
    expect(runCall({ wallet: new FakeWallet(100), price: 6, leaveAtS: 59 }).charges).toEqual([1]);
    expect(runCall({ wallet: new FakeWallet(100), price: 6, leaveAtS: 60 }).charges).toEqual([1, 2]);
    const r = runCall({ wallet: new FakeWallet(100), price: 6, leaveAtS: 125 });
    expect(r.charges).toEqual([1, 2, 3]);
    expect(r.wallet.spendable).toBe(82);
  });
  it("balance runs out mid-call: ends at the minute boundary, never goes negative, never charges a partial minute", () => {
    const r = runCall({ wallet: new FakeWallet(15), price: 6 }); // 2 minutes affordable (12), 3 left over
    expect(r.charges).toEqual([1, 2]);
    expect(r.ended).toBe("balance_out");
    expect(r.at).toBe(120);
    expect(r.wallet.spendable).toBe(3);
    expect(chargedPaise(r.b)).toBe(1200);
  });
  it("balanceEndS agrees with where the simulation actually stopped", () => {
    const w = new FakeWallet(15);
    const r = runCall({ wallet: w, price: 6 });
    expect(balanceEndS(r.b)).toBe(120);
  });
  it("exactly one minute of funds: one charge then balance_out at 60 s", () => {
    const r = runCall({ wallet: new FakeWallet(6), price: 6 });
    expect(r.charges).toEqual([1]);
    expect(r.ended).toBe("balance_out");
    expect(r.at).toBe(60);
    expect(r.wallet.spendable).toBe(0);
  });
  it("the time cap never opens a further minute", () => {
    const r = runCall({ wallet: new FakeWallet(1000), price: 6, maxS: 900 });
    expect(r.ended).toBe("time_up");
    expect(r.charges.length).toBe(15);
    expect(r.wallet.spendable).toBe(1000 - 90);
  });
  it("a retried minute (duplicate op id) never double-charges", () => {
    const w = new FakeWallet(100);
    expect(w.charge(opIdCharge("S", 1), 6)).toBe(true);
    expect(w.charge(opIdCharge("S", 1), 6)).toBe(true);
    expect(w.charge(opIdCharge("S", 1), 6)).toBe(true);
    expect(w.spendable).toBe(94);
  });
  it("a restarted DO replaying minutes 1..2 from scratch changes nothing in the wallet", () => {
    const w = new FakeWallet(100);
    const a = runCall({ wallet: w, price: 6, leaveAtS: 61 });
    expect(a.wallet.spendable).toBe(88);
    const b = runCall({ wallet: w, price: 6, leaveAtS: 61 }); // same session id "S": every op id is a replay
    expect(b.charges).toEqual([1, 2]);
    expect(w.spendable).toBe(88);
  });
});

describe("state", () => {
  it("applyCharge ignores an already-counted minute", () => {
    let b = newBilling(6, 0, 100);
    b = applyCharge(b, 1, 94);
    const again = applyCharge(b, 1, 94);
    expect(again).toBe(b);
    expect(b.tokensCharged).toBe(6);
  });
  it("closeBilling is exactly-once: a duplicate close is not a first close and changes nothing", () => {
    const b0 = applyCharge(newBilling(6, 0, 100), 1, 94);
    const first = closeBilling(b0);
    expect(first.firstClose).toBe(true);
    const second = closeBilling(first.state);
    expect(second.firstClose).toBe(false);
    expect(second.state.tokensCharged).toBe(6);
    expect(nextChargeDue(second.state, 500)).toBeNull(); // nothing is charged after close
  });
  it("unpriced (price 0) never charges", () => {
    expect(nextChargeDue(newBilling(0, 0, 0), 500)).toBeNull();
  });
});
