// [HF-WIRE-13] Anyone can withdraw their wallet (owner 2026-10-19, rulebook HF-REEL-36). The influencer path (hf_host_ledger, 7-day hold) is
// unchanged; this file is the OTHER half: money a person put into their own wallet (purchase lots) going out to their UPI.
//
//   take    When the request is made, the amount (whole rupees) is REMOVED from the person's purchase lots, oldest first, in ONE guarded
//           batch (ledger kind 'payout_take', op hftfanw:<payoutId>). So it cannot be spent on a call, or withdrawn twice.
//   return  Cancel or reject: the same value is put back as a NEW purchase lot (op hftfanr:<payoutId>, source_lot_id set so it is not counted
//           as a new purchase). The money is back in the WALLET, never sent anywhere else.
//   paid    A zero-amount marker (op hftfanp:<payoutId>); after it nothing can be returned.
// Test credits and admin adjustments are never in `purchase` lots, so they are never withdrawable. Open debt blocks everything.
import type { Env } from "../types";
import { getLots, hasOpenDebt, creditLot } from "./hf_token_ledger";
import { planFixedSpend, paiseToMicro, RUPEE_LOT_VALUE_PAISE, type Lot } from "./hf_token_math";

export const fanTakeOpId = (payoutId: string) => `hftfanw:${payoutId}`;
export const fanReturnOpId = (payoutId: string) => `hftfanr:${payoutId}`;
export const fanPaidOpId = (payoutId: string) => `hftfanp:${payoutId}`;
export const fanPayoutRef = (payoutId: string) => `hffan:${payoutId}`;
export const isFanPayoutRef = (ref: string | null | undefined) => typeof ref === "string" && ref.startsWith("hffan:");
/** Prefix of the note on the credit row of a returned withdrawal (the wallet history shows ONE line, the marker). */
export const PAYOUT_RETURN_NOTE_PREFIX = "payout_return:";

async function purchaseLots(env: Env, uid: string): Promise<Array<Lot & { reservedMicro: number }>> {
  return (await getLots(env, uid))
    .filter((l) => l.kind === "purchase")
    .map((l) => ({ id: l.id, valuePaisePerToken: l.valuePaisePerToken, leftMicro: Math.max(0, l.leftMicro - l.reservedMicro), reservedMicro: l.reservedMicro }))
    .filter((l) => l.leftMicro > 0);
}

/** Paise of real (purchase) money free to withdraw now, in whole rupees. Open debt = 0. */
export async function fanWithdrawablePaise(env: Env, uid: string): Promise<number> {
  if (await hasOpenDebt(env, uid)) return 0;
  const lots = await purchaseLots(env, uid);
  let total = 0n;
  for (const l of lots) total += (BigInt(Math.trunc(l.leftMicro)) * BigInt(Math.trunc(l.valuePaisePerToken))) / 1_000_000n;
  return Math.floor(Number(total) / 100) * 100;
}

export type TakeResult = { ok: true; again: boolean; takenPaise: number } | { ok: false; reason: "insufficient" | "conflict" | "debt" | "invalid" };

/** Remove `paise` (a whole number of rupees) from purchase lots for one payout request. Idempotent per payout id. */
export async function takeFanPayout(env: Env, uid: string, payoutId: string, paise: number): Promise<TakeResult> {
  const amt = Math.trunc(paise);
  if (!(amt > 0) || amt % 100 !== 0) return { ok: false, reason: "invalid" };
  const db = env.DB_META;
  const gate = fanTakeOpId(payoutId);
  const had = await db.prepare("SELECT rupee_value_paise AS v FROM hf_token_ledger WHERE op_id=?1").bind(gate).first<{ v: number }>();
  if (had) return { ok: true, again: true, takenPaise: Number(had.v) };
  if (await hasOpenDebt(env, uid)) return { ok: false, reason: "debt" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const lots = await purchaseLots(env, uid);
    const plan = planFixedSpend(lots, amt, 0);
    if (plan.shortfall || plan.totalValuePaise !== amt) return { ok: false, reason: "insufficient" };
    const now = Date.now(), nonce = crypto.randomUUID();
    const params: unknown[] = [crypto.randomUUID(), uid, amt, gate, nonce, now];
    const guards = plan.uses.map((u) => {
      const a = params.length + 1, b = params.length + 2;
      params.push(u.lotId, u.micro);
      return `(SELECT COUNT(*) FROM hf_token_lots WHERE id=?${a} AND uid=?2 AND kind='purchase' AND status='active' AND tokens_left_micro - tokens_reserved_micro >= ?${b})=1`;
    });
    const stmts = [db.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
       SELECT ?1,?2,'payout_take',NULL,0,?3,NULL,NULL,?4,?5,?6 WHERE ${guards.join(" AND ")}`,
    ).bind(...params)];
    for (const u of plan.uses) {
      stmts.push(
        db.prepare("UPDATE hf_token_lots SET tokens_left_micro = tokens_left_micro - ?1 WHERE id=?2 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?3 AND note=?4)")
          .bind(u.micro, u.lotId, gate, nonce),
        db.prepare(
          `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
           SELECT ?1,?2,'payout_take',?3,?4,?5,NULL,NULL,?6,NULL,?7 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?8 AND note=?9)`,
        ).bind(crypto.randomUUID(), uid, u.lotId, -u.micro, u.valuePaise, `${gate}:${u.lotId}`, now, gate, nonce),
      );
    }
    await db.batch(stmts);
    const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(gate).first<{ note: string | null }>();
    if (g?.note === nonce) {
      await db.prepare("UPDATE hf_token_ledger SET note=NULL WHERE op_id=?1").bind(gate).run();
      return { ok: true, again: false, takenPaise: amt };
    }
    if (g) return { ok: true, again: true, takenPaise: amt }; // a concurrent identical request won
  }
  return { ok: false, reason: "conflict" };
}

/** Paise taken for a payout (sum of its per-lot rows), 0 when nothing was taken. */
export async function fanTakenPaise(env: Env, payoutId: string): Promise<number> {
  const r = await env.DB_META.prepare("SELECT rupee_value_paise AS v FROM hf_token_ledger WHERE op_id=?1").bind(fanTakeOpId(payoutId)).first<{ v: number }>();
  return Number(r?.v ?? 0);
}

export type ReturnResult = { ok: true; again: boolean; returnedPaise: number } | { ok: false; reason: "not_taken" | "already_paid" | "wallet_error" };

/** Put a cancelled / rejected withdrawal back into the wallet. Idempotent. Refuses once the payout is marked paid. */
export async function returnFanPayout(env: Env, uid: string, payoutId: string): Promise<ReturnResult> {
  const db = env.DB_META;
  const taken = await fanTakenPaise(env, payoutId);
  if (!(taken > 0)) return { ok: false, reason: "not_taken" };
  if (await db.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(fanPaidOpId(payoutId)).first()) return { ok: false, reason: "already_paid" };
  const firstLot = await db.prepare("SELECT lot_id FROM hf_token_ledger WHERE kind='payout_take' AND lot_id IS NOT NULL AND op_id LIKE ?1 ORDER BY created_at ASC LIMIT 1")
    .bind(`${fanTakeOpId(payoutId)}:%`).first<{ lot_id: string }>();
  const credit = await creditLot(env, uid, {
    kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: RUPEE_LOT_VALUE_PAISE, micro: paiseToMicro(taken), paidPaise: 0,
    provider: "payout_return", providerRef: fanReturnOpId(payoutId), note: `${PAYOUT_RETURN_NOTE_PREFIX}${payoutId}`, sourceLotId: firstLot?.lot_id ?? `payout:${payoutId}`,
  }, fanReturnOpId(payoutId));
  if (!credit.lotId) return { ok: false, reason: "wallet_error" };
  // The wallet-history line (one row): a zero-delta marker with the value, so the person sees "Withdrawal returned to your wallet" once.
  await db.prepare(
    `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
     VALUES (?1,?2,'payout_return',?3,0,?4,NULL,NULL,?5,NULL,?6)`,
  ).bind(crypto.randomUUID(), uid, credit.lotId, taken, `${fanReturnOpId(payoutId)}:mark`, Date.now()).run();
  return { ok: true, again: !credit.applied, returnedPaise: taken };
}

/** Freeze a taken withdrawal as paid. Refuses when nothing was taken or it was already returned. Idempotent. */
export async function markFanPayoutPaid(env: Env, uid: string, payoutId: string): Promise<{ ok: boolean }> {
  const db = env.DB_META;
  await db.prepare(
    `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
     SELECT ?1,?2,'payout_paid',NULL,0,0,NULL,NULL,?3,NULL,?4
      WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?5) AND NOT EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?6)`,
  ).bind(crypto.randomUUID(), uid, fanPaidOpId(payoutId), Date.now(), fanTakeOpId(payoutId), fanReturnOpId(payoutId)).run();
  const ok = await db.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(fanPaidOpId(payoutId)).first();
  return { ok: !!ok };
}
