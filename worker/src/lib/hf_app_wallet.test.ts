import { describe, it, expect } from "vitest";
import { normalizeAppWallet } from "./hf_app_wallet";
import { topupSplitFloor as topupSplit } from "./hf_token_math";

describe("[HF-WIRE-6] GST maths: wallet = floor(paid / 1.18)", () => {
  const table: Array<[number, number, number]> = [
    [10, 847, 153], [100, 8474, 1526], [500, 42372, 7628], [999.99, 84744, 15255], [1000, 84745, 15255], [5000, 423728, 76272],
  ];
  for (const [rupees, wallet, gst] of table) {
    it(`Rs ${rupees}`, () => {
      const paid = Math.round(rupees * 100);
      const s = topupSplit(paid, 1800);
      expect(s.walletPaise).toBe(wallet);
      expect(s.gstPaise).toBe(gst);
      expect(s.walletPaise + s.gstPaise).toBe(paid);
    });
  }
  it("Rs 500 is Rs 423.72", () => expect(topupSplit(50000, 1800).walletPaise).toBe(42372));
});

describe("[HF-WIRE-6] normalizeAppWallet", () => {
  it("standard plan", () => {
    const w = normalizeAppWallet({ mode: "rupees", wallet: { paidPaise: 5000, testPaise: 1000, reservedPaise: 200 }, history: [
      { at: 2, kind: "call_spent", amountPaise: -300, label: "Call" }, { at: 3, kind: "purchase", amountPaise: 4237, label: "Money added" } ] });
    expect(w).toMatchObject({ balancePaise: 5000, testCreditPaise: 1000, heldPaise: 200, nextCursor: null });
    expect(w.ledger.map((l) => l.kind)).toEqual(["topup", "call"]);
    expect(w.ledger[1].amountPaise).toBe(-300);
  });
  it("legacy rupee wallet", () => {
    const w = normalizeAppWallet({ paidBalance: 12.5, testBalance: 3, history: [{ at: 1, kind: "test_credit", rupees: 3, label: "Test credits added" }] });
    expect(w).toMatchObject({ balancePaise: 1250, testCreditPaise: 300, heldPaise: 0 });
  });
  it("token mode separates test tokens", () => {
    const w = normalizeAppWallet({ mode: "tokens", tokens: { balance: "10.00", testTokens: "4.00" }, history: [] });
    expect(w).toMatchObject({ balancePaise: 600, testCreditPaise: 400 });
  });
  it("pages with a cursor", () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ at: 100 - i, kind: "call_spent", amountPaise: -1, label: "c" }));
    const p1 = normalizeAppWallet({ history }, { limit: 20 });
    expect(p1.ledger).toHaveLength(20); expect(p1.nextCursor).toBe("20");
    const p2 = normalizeAppWallet({ history }, { limit: 20, cursor: p1.nextCursor });
    expect(p2.ledger).toHaveLength(5); expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.ledger, ...p2.ledger].map((l) => l.id)).size).toBe(25);
  });
});

describe("[HF-APP-PARITY-WITHDRAW] top-up rows carry the GST split", () => {
  it("passes paid and GST for a purchase row only", () => {
    const w = normalizeAppWallet({ mode: "tokens", tokens: { balance: 0, testTokens: 0 }, history: [
      { at: 5, kind: "purchase", amountPaise: 8475, label: "Money added", purchase: { paidPaise: 10000, gstPaise: 1525, walletPaise: 8475 } },
      { at: 4, kind: "call_spent", amountPaise: -300, label: "Call" },
    ] });
    expect(w.ledger[0]).toMatchObject({ kind: "topup", paidPaise: 10000, gstPaise: 1525 });
    expect(w.ledger[1].paidPaise).toBeUndefined();
  });
});
