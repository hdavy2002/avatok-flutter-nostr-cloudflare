// [AUMFE-CONSULT-W1-1 2026-10-02] Real Consultants payment side: the consult half of the UPI rail (mirrors
// routes/shop_orders.ts), wallet payment confirmation, and the hold-expiry cron step.
//   * findConsultMatchCandidates / consultReferenceClaimed -> asked by matchSaathumReceipt (routes/saathum_checkout.ts)
//   * confirmConsultBooking -> SMS auto-match, typed UTR, wallet, and lane W4's admin "confirm payment"
//   * expireHeldBookings -> cron (every 5 min): 180 s "I've paid" -> awaiting_review, unpaid hold -> expired
import type { Env } from "../../types";
import { metaDb } from "../../db/shard";
import { track, trackException, trackUser } from "../../hooks";
import { BRAND } from "../brand";
import { emailFor } from "../identity";
import { releaseAmount, sendAdminAlert } from "../saathum_upi3";
import { AMOUNT_COOLDOWN_MS, LATE_SMS_GRACE_MS, PAID_CLAIM_REVIEW_MS } from "../saathum_checkout_logic";
import { matchSaathumReceipt, type ConfirmEvidence, type SmsReceiptEvidence } from "../../routes/saathum_checkout";
import { openForMatching, receiptNoFor, type BookingRow } from "./booking_logic";
import { prepareBooking } from "./prepare";
import { notifyBookingConfirmed } from "./notify";

const APP = BRAND.slug;
export const isMissingConsultTable = (err: unknown): boolean => /no such table:?\s*(main\.)?consult_/i.test(String((err as Error)?.message ?? err));

/** ConfirmEvidence plus `wallet` (paid from the in-app wallet; no bank reference). */
export type ConsultEvidence = Omit<ConfirmEvidence, "via"> & { via: ConfirmEvidence["via"] | "wallet" };

// ---------------------------------------------------------------------------
// UPI rail: candidates, claimed check, typed-UTR finalize, reconcile
// ---------------------------------------------------------------------------
/** Is this bank reference / SMS already carried by a consult booking? Returns that booking's id (dispatcher's "claimed" check). */
export async function consultReferenceClaimed(env: Env, r: Pick<SmsReceiptEvidence, "receiving_account_key" | "bank_reference" | "message_hash">): Promise<string | null> {
  try {
    const row = await metaDb(env).prepare(
      `SELECT id FROM consult_bookings WHERE receiving_account_key=?1 AND (payer_reference=?2 OR matched_message_hash=?3) LIMIT 1`,
    ).bind(r.receiving_account_key, r.bank_reference, r.message_hash).first<{ id: string }>();
    return row?.id ?? null;
  } catch (err) {
    if (!isMissingConsultTable(err)) await trackException(env, err, { route: "consult_payment.claimed", handled: true, app_name: APP });
    return null;
  }
}

/** Consult bookings on the same account whose payable amount equals this SMS and that are still open (same window rule as shop/events). */
export async function findConsultMatchCandidates(env: Env, r: SmsReceiptEvidence): Promise<string[]> {
  try {
    const rows = await metaDb(env).prepare(
      `SELECT id FROM consult_bookings
        WHERE receiving_account_key=?1 AND amount_paise=?2 AND pay_method='upi' AND status IN ('held','awaiting_review')
          AND confirmed_at IS NULL AND (reason_code IS NULL OR reason_code<>'finalize_error')
          AND created_at<=?3 AND ?4<=COALESCE(expires_at,created_at)+?5
        LIMIT 3`,
    ).bind(r.receiving_account_key, r.amount_paise, r.received_at_end_ms, r.received_at_ms, LATE_SMS_GRACE_MS).all<{ id: string }>();
    return (rows.results ?? []).map((x) => x.id);
  } catch (err) {
    if (!isMissingConsultTable(err)) await trackException(env, err, { route: "consult_payment.candidates", handled: true, app_name: APP });
    return [];
  }
}

/** Typed-UTR path. Idempotent -- safe from GET/paid and webhooks. */
export async function finalizeConsultByIntent(env: Env, id: string, ctx?: ExecutionContext): Promise<void> {
  const db = metaDb(env);
  const row = await db.prepare(`SELECT * FROM consult_bookings WHERE id=?1`).bind(id).first<BookingRow>();
  if (!row || !openForMatching(row) || !row.payer_reference || !row.receiving_account_key) return;
  const receipt = await db.prepare(
    `SELECT message_hash, bank_reference, payer_vpa FROM hdfc_sms_smoke_receipts
      WHERE receiving_account_key=?1 AND bank_reference=?2 AND amount_paise=?3 AND disposition='accepted'
        AND received_at_end_ms>=?4 AND received_at_ms<=?5`,
  ).bind(row.receiving_account_key, row.payer_reference, row.amount_paise, row.created_at, (row.expires_at ?? row.created_at) + LATE_SMS_GRACE_MS)
    .first<{ message_hash: string; bank_reference: string; payer_vpa: string | null }>();
  if (!receipt) return;
  await confirmConsultBooking(env, id, {
    via: "utr", bankReference: row.payer_reference, payerVpa: receipt.payer_vpa, messageHash: receipt.message_hash, expectPayerReference: row.payer_reference,
  }, ctx);
}

/** UTR path first, then the unique-amount rule via the shared dispatcher. */
export async function reconcileOpenConsultBooking(env: Env, id: string, ctx?: ExecutionContext): Promise<void> {
  await finalizeConsultByIntent(env, id, ctx);
  const row = await metaDb(env).prepare(`SELECT * FROM consult_bookings WHERE id=?1`).bind(id).first<BookingRow>();
  if (!row || !openForMatching(row) || row.pay_method !== "upi" || !row.receiving_account_key) return;
  const rows = await metaDb(env).prepare(
    `SELECT message_hash, receiving_account_key, bank_reference, amount_paise, received_at_ms, received_at_end_ms, payer_vpa
       FROM hdfc_sms_smoke_receipts
      WHERE receiving_account_key=?1 AND amount_paise=?2 AND disposition='accepted' AND bank_reference IS NOT NULL
        AND claimed_intent_id IS NULL AND received_at_end_ms>=?3 AND received_at_ms<=?4
      ORDER BY received_at_ms ASC LIMIT 3`,
  ).bind(row.receiving_account_key, row.amount_paise, row.created_at, (row.expires_at ?? row.created_at) + LATE_SMS_GRACE_MS).all<SmsReceiptEvidence>();
  for (const r of rows.results ?? []) {
    const out = await matchSaathumReceipt(env, r);
    if (out.result === "confirmed" || out.result === "failed") return;
  }
}

// ---------------------------------------------------------------------------
// Confirmation (first writer wins)
// ---------------------------------------------------------------------------
/** Run the post-confirm jobs. With ctx they ride waitUntil; without, they are awaited but bounded (cron retries both). */
async function afterConfirm(env: Env, id: string, ctx?: ExecutionContext): Promise<void> {
  const jobs = [
    (async () => { try { await prepareBooking(env, id); } catch (err) { await trackException(env, err, { route: "confirmConsultBooking:prepare", handled: true, app_name: APP, extra: { booking_id: id } }); } })(),
    (async () => { try { await notifyBookingConfirmed(env, id); } catch (err) { await trackException(env, err, { route: "confirmConsultBooking:notify", handled: true, app_name: APP, extra: { booking_id: id } }); } })(),
  ];
  const all = Promise.all(jobs).then(() => undefined);
  if (ctx) { ctx.waitUntil(all); return; }
  await Promise.race([all, new Promise<void>((res) => setTimeout(res, 10_000))]);
}

/**
 * First-writer-wins confirmation shared by SMS auto-match, typed UTR, wallet and admin (lane W4 calls this for
 * "confirm payment"). Returns "confirmed" once the claim landed, "lost" when another writer got there first (or the slot
 * was taken meanwhile), "failed" only if the row vanished. Bookkeeping/notify failures never un-confirm.
 * Admin may also confirm an `expired` hold (money arrived late) -- the slot unique index decides if it is still free.
 */
export async function confirmConsultBooking(env: Env, id: string, ev: ConsultEvidence, ctx?: ExecutionContext): Promise<"confirmed" | "lost" | "failed"> {
  const db = metaDb(env);
  const now = Date.now();
  const admin = ev.via === "admin";
  let claim;
  try {
    claim = await db.prepare(
      `UPDATE consult_bookings SET status='confirmed', payer_reference=COALESCE(?2,payer_reference), utr=COALESCE(?2,payer_reference),
              confirmed_at=?3, updated_at=?3, reason_code=NULL, payer_vpa=COALESCE(?4,payer_vpa), matched_message_hash=?5,
              confirm_source=?6, reviewed_by=COALESCE(?7,reviewed_by), review_note=COALESCE(?8,review_note),
              reviewed_at=CASE WHEN ?7 IS NULL THEN reviewed_at ELSE ?3 END, receipt_no=COALESCE(receipt_no,?11),
              pay_method=CASE WHEN ?6='wallet' THEN 'wallet' ELSE pay_method END
        WHERE id=?1 AND (status IN ('held','awaiting_review') OR (?9=1 AND status='expired'))
          AND (?9=1 OR confirmed_at IS NULL) AND (?10 IS NULL OR payer_reference=?10)`,
    ).bind(id, ev.bankReference, now, ev.payerVpa ?? null, ev.messageHash ?? null, ev.via, ev.adminUid ?? null, ev.note ?? null,
      admin ? 1 : 0, ev.expectPayerReference ?? null, receiptNoFor(id, now)).run();
  } catch {
    // Slot unique index (an expired hold whose slot was re-booked) -- nothing was changed.
    return "lost";
  }
  if (Number((claim as any).meta?.changes ?? 0) !== 1) return "lost";
  const row = await db.prepare(`SELECT * FROM consult_bookings WHERE id=?1`).bind(id).first<BookingRow>();
  if (!row) return "failed";
  await releaseAmount(env, id, now); // payment consumed: the unique-amount slot is free again
  const email = await emailFor(env, row.uid).catch(() => null);
  await trackUser(env, row.uid, email, "consult_booking_paid", APP, {
    booking_id: id, method: ev.via === "wallet" ? "wallet" : "upi", via: ev.via, ok: true, total_rupees: row.total_rupees,
    discipline: row.discipline, admin_uid: ev.adminUid ?? undefined,
  });
  await afterConfirm(env, id, ctx);
  return "confirmed";
}

// ---------------------------------------------------------------------------
// Cron: hold expiry + "I've paid" -> awaiting_review
// ---------------------------------------------------------------------------
/** Free one slot's stale hold right now (an unpaid hold past expiry) so a new booking can take it. Never throws. */
export async function expireStaleHoldAt(env: Env, consultantId: string, slotStartMs: number, now = Date.now()): Promise<void> {
  try {
    const db = metaDb(env);
    const rows = await db.prepare(
      `SELECT id FROM consult_bookings WHERE consultant_id=?1 AND slot_start_ms=?2 AND status='held' AND paid_claimed_at IS NULL AND expires_at<=?3`,
    ).bind(consultantId, slotStartMs, now).all<{ id: string }>();
    for (const { id } of rows.results ?? []) await expireOne(env, id, now);
  } catch (err) { await trackException(env, err, { route: "consult_payment.expire_stale", handled: true, app_name: APP }); }
}

async function expireOne(env: Env, id: string, now: number): Promise<boolean> {
  const res = await metaDb(env).prepare(
    `UPDATE consult_bookings SET status='expired', updated_at=?2 WHERE id=?1 AND status='held' AND paid_claimed_at IS NULL AND expires_at<=?2`,
  ).bind(id, now).run();
  if (Number((res as any).meta?.changes ?? 0) !== 1) return false;
  await releaseAmount(env, id, now, AMOUNT_COOLDOWN_MS); // a late SMS must not collide with a re-issued amount
  return true;
}

/** Cron step. Returns how many rows moved. Cheap when there is nothing to do. */
export async function expireHeldBookings(env: Env): Promise<number> {
  const db = metaDb(env);
  const now = Date.now();
  let moved = 0;
  // 1) "I've paid" older than 180 s: the DB agrees with what reads compute -> awaiting_review (admin queue), owner pinged once.
  const claimed = await db.prepare(
    `SELECT id, ref, amount_paise FROM consult_bookings WHERE status='held' AND paid_claimed_at IS NOT NULL AND paid_claimed_at<=?1 AND confirmed_at IS NULL LIMIT 50`,
  ).bind(now - PAID_CLAIM_REVIEW_MS).all<{ id: string; ref: string; amount_paise: number | null }>();
  for (const b of claimed.results ?? []) {
    const res = await db.prepare(
      `UPDATE consult_bookings SET status='awaiting_review', reason_code=COALESCE(reason_code,'awaiting_bank'), updated_at=?2 WHERE id=?1 AND status='held' AND confirmed_at IS NULL`,
    ).bind(b.id, now).run();
    if (Number((res as any).meta?.changes ?? 0) !== 1) continue;
    moved++;
    // Keep the unique amount reserved so a late SMS still matches only this booking.
    try { await db.prepare(`UPDATE saathum_amount_reservations SET reserved_until=?2 WHERE checkout_id=?1 AND reserved_until<?2`).bind(b.id, now + LATE_SMS_GRACE_MS).run(); } catch { /* best-effort */ }
    try {
      const mine = await db.prepare(`UPDATE consult_bookings SET review_alerted_at=?2 WHERE id=?1 AND review_alerted_at IS NULL`).bind(b.id, now).run();
      if (Number((mine as any).meta?.changes ?? 0) === 1) {
        const ok = await sendAdminAlert(env, `${BRAND.nameCompact} consultation payment needs manual review\nBooking ${b.ref} - Rs. ${((b.amount_paise ?? 0) / 100).toFixed(2)}\nOpen admin > Consultant bookings.`);
        if (!ok) await db.prepare(`UPDATE consult_bookings SET review_alerted_at=NULL WHERE id=?1`).bind(b.id).run();
      }
    } catch (err) { await trackException(env, err, { route: "consult_payment.review_alert", handled: true, app_name: APP }); }
  }
  // 2) Unpaid holds past expiry -> expired (slot freed by the partial unique index).
  const stale = await db.prepare(
    `SELECT id FROM consult_bookings WHERE status='held' AND paid_claimed_at IS NULL AND expires_at<=?1 LIMIT 100`,
  ).bind(now).all<{ id: string }>();
  for (const { id } of stale.results ?? []) {
    if (await expireOne(env, id, now)) { moved++; void track(env, "system", "consult_booking_failed", APP, { reason: "hold_expired", booking_id: id }); }
  }
  return moved;
}
