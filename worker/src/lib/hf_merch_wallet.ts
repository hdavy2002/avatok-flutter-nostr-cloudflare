// [HF-MERCH-CORE-1 2026-10-23] Paying for a merch order from the Hello Fraands rupee wallet, and giving it back.
// Reuses the call-spend path (hf_token_ledger.settleCall with a FIXED rupee value): the same lot walk, the same guards, and an
// op id derived from the order, so a retry never charges twice. A merch order uses the pseudo call id `merch:<orderId>`.
// Refund puts the value back into NEW lots of the SAME provenance (real-money value as a purchase lot, test credit as a test lot),
// marked with source_lot_id so reconcile does not count it as a new top-up, and writes the one-line history marker.
import type { Env } from "../types";
import { balanceSummary, creditLot, hasOpenDebt, settleCall } from "./hf_token_ledger";
import { paiseToMicro, RUPEE_LOT_VALUE_PAISE } from "./hf_token_math";

export const merchWalletCallId = (orderId: string) => `merch:${orderId}`;
export const merchRefundPaidOpId = (orderId: string) => `hfmrf:${orderId}:p`;
export const merchRefundTestOpId = (orderId: string) => `hfmrf:${orderId}:t`;
export const merchRefundMarkOpId = (orderId: string) => `hfmrf:${orderId}:mark`;
/** Any positive per-minute price satisfies settleCall's input check; the FIXED value is what is charged. */
const NOMINAL_RATE_PAISE_PER_MIN = 100;

export type SpendOutcome =
  | { ok: true; again: boolean; spentPaise: number }
  | { ok: false; reason: "insufficient"; shortPaise: number; balancePaise: number }
  | { ok: false; reason: "debt" | "conflict" | "invalid" };

/** Take `amountPaise` from the wallet for this order. Idempotent per order. Never leaves a partial charge behind. */
export async function spendWalletForOrder(env: Env, uid: string, orderId: string, amountPaise: number): Promise<SpendOutcome> {
  const amt = Math.trunc(amountPaise);
  if (!(amt > 0)) return { ok: false, reason: "invalid" };
  const callId = merchWalletCallId(orderId);
  const already = await env.DB_META.prepare("SELECT rupee_value_paise AS v FROM hf_token_ledger WHERE op_id=?1").bind(`hftset:${callId}`).first<{ v: number }>();
  if (already) return { ok: true, again: true, spentPaise: Number(already.v) };
  if (await hasOpenDebt(env, uid)) return { ok: false, reason: "debt" };
  const bal = await balanceSummary(env, uid);
  if (bal.availablePaise < amt) return { ok: false, reason: "insufficient", shortPaise: amt - bal.availablePaise, balancePaise: bal.availablePaise };
  const r = await settleCall(env, uid, callId, NOMINAL_RATE_PAISE_PER_MIN, 0, { fixedValuePaise: amt });
  if (!r.ok) return { ok: false, reason: r.reason === "invalid" ? "invalid" : "conflict" };
  if (r.shortfall || r.totalValuePaise < amt) {
    // A concurrent spend drained the lots between the check and the charge: give back whatever was taken.
    await refundWalletForOrder(env, uid, orderId);
    const now = await balanceSummary(env, uid);
    return { ok: false, reason: "insufficient", shortPaise: Math.max(1, amt - now.availablePaise), balancePaise: now.availablePaise };
  }
  return { ok: true, again: r.again, spentPaise: r.totalValuePaise };
}

/** Paise (split by funding) this order took from the wallet. 0/0 when it never charged. */
export async function walletSpentForOrder(env: Env, orderId: string): Promise<{ paidPaise: number; testPaise: number }> {
  const rows = (await env.DB_META.prepare(
    `SELECT t.kind AS kind, COALESCE(SUM(l.rupee_value_paise),0) AS v
       FROM hf_token_ledger l JOIN hf_token_lots t ON t.id=l.lot_id
      WHERE l.call_id=?1 AND l.kind='spend' AND l.lot_id IS NOT NULL GROUP BY t.kind`,
  ).bind(merchWalletCallId(orderId)).all<{ kind: string; v: number }>()).results ?? [];
  let paid = 0, test = 0;
  for (const r of rows) { if (r.kind === "purchase") paid += Number(r.v); else test += Number(r.v); }
  return { paidPaise: paid, testPaise: test };
}

export type RefundWalletOutcome = { ok: true; again: boolean; refundedPaise: number } | { ok: false; reason: "nothing_spent" | "wallet_error" };

/** Put the order's wallet charge back. Idempotent: the credits carry fixed op ids, so a retry returns the first result. */
export async function refundWalletForOrder(env: Env, uid: string, orderId: string): Promise<RefundWalletOutcome> {
  const { paidPaise, testPaise } = await walletSpentForOrder(env, orderId);
  if (paidPaise + testPaise <= 0) return { ok: false, reason: "nothing_spent" };
  const callId = merchWalletCallId(orderId);
  const credit = async (kind: "purchase" | "test", paise: number, opId: string) => paise > 0
    ? creditLot(env, uid, {
      kind, pricingVersion: "gp-r2", valuePaisePerToken: RUPEE_LOT_VALUE_PAISE, micro: paiseToMicro(paise), paidPaise: 0,
      provider: "merch_refund", providerRef: opId, note: `merch_refund:${orderId};${kind}=${paise}`, sourceLotId: `merch:${orderId}`,
    }, opId)
    : { applied: false, lotId: null as string | null };
  const p = await credit("purchase", paidPaise, merchRefundPaidOpId(orderId));
  const t = await credit("test", testPaise, merchRefundTestOpId(orderId));
  if ((paidPaise > 0 && !p.lotId) || (testPaise > 0 && !t.lotId)) return { ok: false, reason: "wallet_error" };
  const lotId = p.lotId ?? t.lotId;
  await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
     VALUES (?1,?2,'call_refund',?3,0,?4,?5,NULL,?6,?7,?8)`,
  ).bind(crypto.randomUUID(), uid, lotId, paidPaise + testPaise, callId, merchRefundMarkOpId(orderId), `merch_refund:${orderId}`, Date.now()).run();
  return { ok: true, again: !(p.applied || t.applied), refundedPaise: paidPaise + testPaise };
}
