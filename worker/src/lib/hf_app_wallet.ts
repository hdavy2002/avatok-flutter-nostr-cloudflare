// [HF-WIRE-6] One wallet shape for the Android app. The existing GET /api/hf/wallet answers in three shapes (rupee WalletDO, token lots,
// Standard plan); this folds them into {balancePaise, testCreditPaise, heldPaise, ledger[], nextCursor}. Pure: no I/O.
export type AppLedgerKind = "call" | "topup" | "hold" | "release" | "payout" | "refund";
export interface AppLedgerRow { id: string; kind: AppLedgerKind; amountPaise: number; at: number; label: string }
export interface AppWallet { balancePaise: number; testCreditPaise: number; heldPaise: number; ledger: AppLedgerRow[]; nextCursor: string | null }

type R = Record<string, unknown>;
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const paise = (rupees: unknown) => Math.round(n(rupees) * 100);

export function kindOf(raw: string): AppLedgerKind {
  switch (raw) {
    case "call_spent": case "call_earned": return "call";
    case "refund_revoke": case "call_refund": case "debt_create": case "debt_clear": return "refund";
    case "payout": case "payout_take": return "payout"; // [HF-WIRE-13] money leaving the wallet for the person's UPI
    case "payout_return": return "refund"; // [HF-WIRE-13] a cancelled/rejected withdrawal is back in the wallet
    default: return "topup"; // purchase, admin_adjust, grant, migrate, test_credit(_removed)
  }
}

export function normalizeAppWallet(b: R, page: { cursor?: string | null; limit?: number } = {}): AppWallet {
  let balancePaise = 0, testCreditPaise = 0, heldPaise = 0;
  const w = b.wallet as R | undefined;
  if (w && typeof w === "object") {            // Standard plan (rupees, paise)
    balancePaise = Math.max(0, Math.trunc(n(w.paidPaise))); testCreditPaise = Math.max(0, Math.trunc(n(w.testPaise))); heldPaise = Math.max(0, Math.trunc(n(w.reservedPaise)));
  } else if (b.mode === "tokens") {            // token lots (1 token = Rs 1 here)
    const t = (b.tokens ?? {}) as R;
    balancePaise = Math.max(0, paise(t.balance) - paise(t.testTokens)); testCreditPaise = paise(t.testTokens);
  } else {                                      // rupee WalletDO
    balancePaise = paise(b.paidBalance ?? b.balanceRupees); testCreditPaise = paise(b.testBalance);
  }
  const hist = Array.isArray(b.history) ? (b.history as R[]) : [];
  const rows: AppLedgerRow[] = hist.map((h, i) => {
    const raw = String(h.kind ?? "");
    const amt = h.amountPaise != null ? Math.trunc(n(h.amountPaise)) : h.rupees != null ? paise(h.rupees) : paise(h.tokens);
    const at = Math.trunc(n(h.at));
    return { id: `${raw}:${String(h.callId ?? at)}:${i}`, kind: kindOf(raw), amountPaise: amt, at, label: String(h.label ?? "") };
  }).sort((a, c) => c.at - a.at);
  const limit = Math.min(50, Math.max(1, Math.trunc(page.limit || 20)));
  const start = Math.max(0, Math.trunc(Number(page.cursor ?? 0)) || 0);
  const slice = rows.slice(start, start + limit);
  return { balancePaise, testCreditPaise, heldPaise, ledger: slice, nextCursor: start + limit < rows.length ? String(start + limit) : null };
}
