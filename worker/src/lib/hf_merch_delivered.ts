// [HF-MERCH-CORE-1 2026-10-23] Delivered -> the influencer's earning (spec section 1). A LEAF module on purpose: lib/pod_fulfil.ts imports it,
// so it must never import pod_fulfil back. Everything is idempotent (UNIQUE op ids + compare-and-set), so the partner poll, the admin's
// manual "delivered" button and the safety-net cron can all call it for the same order and the influencer is credited exactly once.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { earningAvailableAt } from "./hf_merch_math";
import { merchFail, merchTrack, notifyMerchStatusPush, snapOf } from "./hf_merch_notify";
import type { ShopOrderRow } from "./shop_orders_logic";

export const earnOpId = (orderId: string) => `hfmerch:earn:${orderId}`;
export const earnReverseOpId = (orderId: string) => `hfmerch:earnrev:${orderId}`;

export type EarningOutcome = "credited" | "duplicate" | "skipped";

/** Credit the influencer for a delivered, approved, not-refunded merch order. Held until delivered_at + the order's frozen hold days. */
export async function creditMerchEarning(env: Env, row: ShopOrderRow, now = Date.now()): Promise<EarningOutcome> {
  if (!row.seller_uid || row.approval_status !== "approved" || row.fulfil_status !== "delivered" || !row.delivered_at) return "skipped";
  if (row.refund_status && row.refund_status !== "none") return "skipped";
  const snap = snapOf(row);
  const amt = Math.trunc(Number(snap.money?.influencerPaise ?? 0));
  if (!(amt > 0)) return "skipped";
  const availableAt = earningAvailableAt(Number(row.delivered_at), Number(snap.holdDays ?? 7));
  const db = metaDb(env);
  const r = await db.prepare(
    `INSERT OR IGNORE INTO hf_host_ledger (id, host_uid, kind, amount_paise, call_id, payout_id, available_at, op_id, note, created_at)
     VALUES (?1,?2,'merch_earning',?3,NULL,NULL,?4,?5,?6,?7)`,
  ).bind(crypto.randomUUID(), row.seller_uid, amt, availableAt, earnOpId(row.order_id), `order ${row.order_no}`, now).run();
  const applied = Number(r.meta?.changes ?? 0) === 1;
  await db.prepare("UPDATE shop_orders SET earning_credited_at=?2 WHERE order_id=?1 AND earning_credited_at IS NULL").bind(row.order_id, now).run();
  if (applied) {
    await merchTrack(env, row.seller_uid, "merch_earning_credited", { order_id: row.order_id, earning_paise: amt, available_at: availableAt, hold_days: snap.holdDays ?? 7 });
    return "credited";
  }
  return "duplicate";
}

/** Called when an order becomes delivered (any path). Never throws. */
export async function onMerchDelivered(env: Env, row: ShopOrderRow, actor: string): Promise<void> {
  try {
    const out = await creditMerchEarning(env, row);
    await merchTrack(env, row.seller_uid ?? row.uid, "merch_order_delivered", { order_id: row.order_id, buyer_uid: row.uid, actor, earning: out });
    await notifyMerchStatusPush(env, row, "delivered");
  } catch (e) { await merchFail(env, e, "on_delivered", row.uid, { order_id: row.order_id }); }
}

export type EarningReversal = "reversed" | "after_hold_platform_absorbs" | "none";

/**
 * A refund after delivery. Inside the hold: write the reversing held admin_adjust row (same pattern as the call-correction reversal in
 * lib/hf_call_corrections.ts), so it nets the earning out when it matures. After the hold the money may already be withdrawn: the platform absorbs it.
 */
export async function reverseMerchEarning(env: Env, row: ShopOrderRow, now = Date.now()): Promise<EarningReversal> {
  if (!row.seller_uid) return "none";
  const db = metaDb(env);
  const earn = await db.prepare("SELECT amount_paise AS amt, available_at AS at FROM hf_host_ledger WHERE op_id=?1").bind(earnOpId(row.order_id)).first<{ amt: number; at: number | null }>();
  if (!earn || !(Number(earn.amt) > 0)) return "none";
  const rev = await db.prepare("SELECT 1 AS x FROM hf_host_ledger WHERE op_id=?1").bind(earnReverseOpId(row.order_id)).first();
  if (rev) return "reversed";
  if (earn.at != null && Number(earn.at) <= now) return "after_hold_platform_absorbs";
  await db.prepare(
    `INSERT OR IGNORE INTO hf_host_ledger (id, host_uid, kind, amount_paise, call_id, payout_id, available_at, op_id, note, created_at)
     VALUES (?1,?2,'admin_adjust',?3,NULL,NULL,?4,?5,?6,?7)`,
  ).bind(crypto.randomUUID(), row.seller_uid, -Math.trunc(Number(earn.amt)), earn.at, earnReverseOpId(row.order_id), `merch refund ${row.order_no}`, now).run();
  return "reversed";
}
