// [COMM-REFUND-POL-1] The screen behind `review_pending`.
//
// The commercial lane parks money in `review_pending` in a dozen places — an invalid or
// incomplete policy snapshot, a partial refund percentage the refund machinery cannot
// express, an escrow balance that has not caught up with the DO debit, a terminal
// provider state recovered without signed attendance evidence, a money claim already
// owned by another path. Every one of those was a dead end: there was NO route anywhere
// in worker/src that could move a commercial settlement job out of review_pending. Only
// the generic ledger `adjust()` (ledger.ts), which writes an adjustment row and leaves
// the job, the order, the entitlements and the receipts untouched and inconsistent.
//
// Money that a system can freeze but not thaw is a support ticket with no tool behind it.
// This is the tool.
//
//   GET  /api/admin/commercial/claims                 list what is stuck, newest first
//   POST /api/admin/commercial/claims/:orderId        {decision, reason}
//
// decision is one of:
//   "refund"  → full refund to the buyer, receipt written, order/booking/entitlements
//               marked refunded, settlement job closed as refunded
//   "release" → let it settle: the job goes back to `pending` and the normal cron picks
//               it up, applying the SNAPSHOTTED 80/20 split. We deliberately do NOT
//               release the escrow by hand here — reimplementing the split in an admin
//               route is how the two paths drift apart.
//
// NOT SUPPORTED, deliberately: partial refunds. commercial_refund_receipts is written
// with refunded_amount = gross and remaining_amount = 0, and the CHECK constraints and
// every downstream reader assume that shape. A "split" decision would need the receipt
// model to grow first; until then this route refuses rather than writing a receipt that
// says something the ledger does not.
import type { Env } from "../types";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { requireAdmin } from "./admin_money";
import { escrowBalance } from "../ledger";
import { executeCommercialRefund } from "../lib/commercial_refund_rail";
import { claimCommercialMoney } from "../commercial_money_claim";
import { commercialEvent } from "../lib/commercial_telemetry";

type StuckRow = {
  job_id: string;
  order_id: string;
  commercial_session_id: string | null;
  state: string;
  last_error: string | null;
  attempts: number;
  updated_at: number;
  listing_id: string | null;
  booking_id: string | null;
  buyer_id: string | null;
  creator_id: string | null;
  kind: string | null;
  order_amount: number | null;
  order_status: string | null;
  policy_snapshot_id: string | null;
  gross_amount: number | null;
  gst_amount: number | null;
  creator_amount: number | null;
  platform_fee_amount: number | null;
  currency: string | null;
};

const STUCK_SQL = `
  SELECT j.settlement_job_id job_id, j.order_id, j.commercial_session_id, j.state,
         j.last_error, j.attempts, j.updated_at,
         o.listing_id, o.buyer_id, o.creator_id, o.amount order_amount, o.status order_status,
         p.booking_id, p.kind, p.policy_snapshot_id, p.gross_amount, p.creator_amount,
         p.platform_fee_amount, p.currency, p.gst_amount
    FROM commercial_settlement_jobs j
    LEFT JOIN orders o ON o.id = j.order_id
    LEFT JOIN commercial_policy_snapshots p ON p.order_id = j.order_id
   WHERE j.state = 'review_pending'`;

/** GET /api/admin/commercial/claims — what is stuck, and everything needed to judge it. */
export async function adminCommercialClaims(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) return a;
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") || 50)));
  const rows = await metaDb(env).prepare(
    `${STUCK_SQL} ORDER BY j.updated_at ASC LIMIT ${limit}`,
  ).all<StuckRow>();
  const results = rows.results ?? [];
  // Escrow is read per row rather than joined: it is recomputed by the wallet queue
  // consumer (consumers/src/wallet.ts) and a stale or lagging consumer is itself one of
  // the reasons a job lands here. Showing the live number is the point — an admin
  // deciding "refund" needs to know whether the money is actually sitting in escrow.
  const enriched = await Promise.all(results.map(async (r) => ({
    ...r,
    escrow_balance: await escrowBalance(env, r.order_id).catch(() => null),
  })));
  return json({ ok: true, count: enriched.length, claims: enriched });
}

/** POST /api/admin/commercial/claims/:orderId  {decision:"refund"|"release", reason} */
export async function adminResolveCommercialClaim(req: Request, env: Env, orderId: string): Promise<Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as { decision?: unknown; reason?: unknown };
  const decision = String(b.decision || "");
  const reason = String(b.reason || "").trim();
  if (!["refund", "release"].includes(decision)) {
    return json({ error: "decision must be refund or release" }, 400);
  }
  // A reason is mandatory and is not decoration: this row is the only record of why a
  // human overrode an automated money decision.
  if (reason.length < 8) return json({ error: "reason required (min 8 chars)" }, 400);

  const row = await metaDb(env).prepare(
    `${STUCK_SQL} AND j.order_id = ?1 LIMIT 1`,
  ).bind(orderId).first<StuckRow>();
  if (!row) return json({ error: "no review_pending claim for that order" }, 404);
  // buyer/creator/listing are NOT NULL on commercial_refund_receipts, and both joins in
  // STUCK_SQL are LEFT joins — a job whose order or snapshot row is missing must not be
  // resolved by writing a receipt full of nulls. Refuse and let a human look.
  if (!row.buyer_id || !row.creator_id || !row.listing_id || !row.kind) {
    return json({ error: "order or policy snapshot row missing — resolve by hand", job_id: row.job_id }, 409);
  }

  const now = Date.now();
  const gross = Math.max(0, Math.trunc(Number(row.gross_amount ?? row.order_amount ?? 0)));
  // [TAX-GST-1] The buyer paid base + tax in one hold, so an admin refund returns both.
  // Refunding only the base here while the automated path returns base+tax would make an
  // admin decision quietly worse for the buyer than the machine's.
  const gstAmount = Math.max(0, Math.trunc(Number(row.gst_amount ?? 0)));
  const refundable = gross + gstAmount;

  if (decision === "release") {
    // Hand it back to the cron rather than paying it out here. runCommercialSettlements
    // re-verifies the snapshot arithmetic and the delivery evidence before releasing, and
    // a second implementation of the split living in an admin route is a guarantee the
    // two will disagree eventually. Clearing attempts gives it a clean run; last_error
    // keeps the audit trail of why it was here.
    await metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs
          SET state='pending', attempts=0, last_error=?2, updated_at=?3
        WHERE order_id=?1 AND state='review_pending'`,
    ).bind(orderId, `admin_release:${a.uid}:${reason}`.slice(0, 500), now).run();
    commercialEvent(env, "admin_claim", a.uid, {
      kind: row.kind ?? "unknown", outcome: "released_to_settlement", reason,
    });
    return json({ ok: true, order_id: orderId, decision, state: "pending" });
  }

  // --- refund ---
  if (!["held", "free"].includes(String(row.order_status))) {
    return json({ error: "order is not refundable from escrow", order_status: row.order_status }, 409);
  }
  if (refundable > 0) {
    const bal = await escrowBalance(env, orderId).catch(() => null);
    if (bal === null) return json({ error: "escrow balance unavailable" }, 503);
    // Same guard the automated path uses. A short balance usually means the wallet queue
    // consumer has not caught up, NOT that the money is gone — refunding against it would
    // create a ledger row with nothing behind it.
    if (bal < refundable) {
      return json({ error: "escrow balance below gross", escrow_balance: bal, gross, gst_amount: gstAmount }, 409);
    }
  }
  // Same claim primitive as the automated paths, so an admin refund and a cron settlement
  // can never both act on one order.
  const claim = await claimCommercialMoney(env, {
    orderId, claimType: "refund", claimId: `admin:${a.uid}:${orderId}`,
  });
  if (!claim.owned) {
    return json({
      error: "commercial money claim already owned",
      owner: claim.existing ? `${claim.existing.claim_type}:${claim.existing.claim_id}` : "unknown",
    }, 409);
  }
  if (refundable > 0) {
    // Same opId as the automated refund. If the automated path already refunded this
    // order and merely failed to record it, the DO returns the original result and no
    // second ledger row is written.
    // [PAY-REFUND-1] Same rail selection as the automated path. An admin decision must
    // not be quietly worse for the buyer than the machine's — refunding a Cashfree
    // purchase into a wallet would strand it behind the payout lane's KYC and ₹1,000
    // minimum.
    const money = await executeCommercialRefund(env, {
      orderId,
      buyerId: row.buyer_id,
      amount: refundable,
      reason: `admin:${reason}`.slice(0, 200),
    });
    if (!money.ok) return json({ error: "refund failed", reason: money.error }, 502);
  }
  const receiptId = `commercial-refund:${orderId}`;
  await metaDb(env).batch([
    metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_refund_receipts
       (refund_receipt_id,order_id,commercial_session_id,listing_id,booking_id,buyer_id,creator_id,
        kind,gross_amount,refunded_amount,remaining_amount,platform_fee_amount,creator_amount,
        currency,settlement_state,reason,actor,policy_snapshot_id,issued_at,gst_amount)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?14,0,0,0,?10,'refunded',?11,'system',?12,?13,?15)`,
    ).bind(receiptId, orderId, row.commercial_session_id, row.listing_id, row.booking_id,
      row.buyer_id, row.creator_id, row.kind, gross,
      row.currency ?? "INR", `admin_review:${reason}`.slice(0, 200),
      row.policy_snapshot_id ?? "unknown", now, refundable, gstAmount),
    metaDb(env).prepare("UPDATE orders SET status='refunded',updated_at=?2 WHERE id=?1").bind(orderId, now),
    metaDb(env).prepare(
      "UPDATE bookings SET status='refunded',updated_at=?2 WHERE order_id=?1",
    ).bind(orderId, now),
    metaDb(env).prepare(
      "UPDATE commercial_entitlements SET state='refunded',updated_at=?2 WHERE order_id=?1",
    ).bind(orderId, now),
    metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='refunded',last_error=?2,updated_at=?3
        WHERE order_id=?1`,
    ).bind(orderId, `admin_refund:${a.uid}:${reason}`.slice(0, 500), now),
  ]);
  commercialEvent(env, "admin_claim", a.uid, {
    kind: row.kind ?? "unknown", outcome: "refunded", reason,
  });
  return json({ ok: true, order_id: orderId, decision, refunded_amount: refundable, gst_amount: gstAmount, refund_receipt_id: receiptId });
}
