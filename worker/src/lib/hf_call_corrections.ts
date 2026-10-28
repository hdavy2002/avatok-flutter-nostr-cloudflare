// [HF-STD-PLAN-1] Call-charge corrections (contract rule 6). A billing error on a finished call goes back to the CALLER'S WALLET, traceable to
// the call, ONCE per call. The host's earning for that call is reversed only while it is still inside the 7-day hold; after the hold the
// platform absorbs it and the host keeps what he was paid. This is not a Google Play refund (see hf_play_refunds.ts for those).
//
// What gets written (every step idempotent through its own op id, so a retry after a crash finishes the job and never doubles anything):
//   1. hfcorr:<callId>          immutable correction intent/amount marker
//   2. ...:paid / ...:test      separate wallet lots preserving the spent paid/test provenance
//   3. ...:host:paid/test       proportional negative host-ledger rows for both earning kinds while the 7-day hold is open
//   4. hfcorr:<callId>:mark     a 'call_refund' ledger row (delta 0, rupee value = the corrected amount, call id) = the wallet history line
//                               "Call charge corrected"; its note records the host decision so a repeat request answers exactly the same.
// The wallet history hides the admin_adjust row of step 1 (note starts with `call_refund:`) so the person sees ONE line, not two.
import type { Env } from "../types";
import { creditLot } from "./hf_token_ledger";
import { RUPEE_LOT_VALUE_PAISE, paiseToMicro, formatRupees } from "./hf_token_math";
import { track, trackException } from "../hooks";
import { HF_CALL_APP as APP } from "./hf_calls_store";
import { HOST_HOLD_MS } from "./hf_host_ledger";

export type HostReversal = "reversed" | "after_hold_platform_absorbs" | "none";
export const corrOpId = (callId: string) => `hfcorr:${callId}`;
export const corrPaidOpId = (callId: string) => `hfcorr:${callId}:paid`;
export const corrTestOpId = (callId: string) => `hfcorr:${callId}:test`;
export const corrMarkOpId = (callId: string) => `hfcorr:${callId}:mark`;
export const corrHostOpId = (callId: string) => `hfcorr:${callId}:host:paid`;
export const corrHostTestOpId = (callId: string) => `hfcorr:${callId}:host:test`;
/** Prefix of the lot/ledger note that marks a correction credit (the wallet history skips these rows). */
export const CALL_REFUND_NOTE_PREFIX = "call_refund:";

export type CorrectionResult =
  | { ok: true; again: boolean; callId: string; callerUid: string; correctedPaise: number; chargedPaise: number; hostReversedPaise: number; hostReversal: HostReversal; lotId: string | null }
  | { ok: false; error: "not_found" | "no_charge" | "invalid_amount" | "exceeds_charge" | "wallet_error"; message: string; maxPaise?: number };

interface CallRow { id: string; caller_uid: string; host_uid: string; consumed_value_paise: number | null; lots_used: string | null; tokens_spent_micro: number | null; ended_at: number | null }


/** Paid/test share and traceable source lots of the corrected amount. */
function correctionShares(lotsUsed: string | null, amount: number, charge: number): { paid: number; test: number; paidSource: string | null; testSource: string | null } {
  try {
    const lots = JSON.parse(lotsUsed ?? "[]") as Array<{ lotId?: string; kind?: string; valuePaise?: number }>;
    const paid = lots.filter((l) => l.kind === "purchase").reduce((t, l) => t + Math.max(0, Math.trunc(Number(l.valuePaise) || 0)), 0);
    const share = charge > 0 ? Math.min(amount, Math.floor((paid * amount) / charge)) : 0;
    return { paid: share, test: amount - share,
      paidSource: lots.find((l) => l.kind === "purchase" && l.lotId)?.lotId ?? null,
      testSource: lots.find((l) => l.kind !== "purchase" && l.lotId)?.lotId ?? null };
  } catch { return { paid: 0, test: amount, paidSource: null, testSource: null }; }
}

/**
 * Correct (refund) the charge of one finished call to the caller's wallet. `amountPaise` defaults to the whole charge and can never exceed it.
 * One correction per call: asking again returns the first one's numbers (`again: true`) and moves no money.
 */
export async function correctCallCharge(
  env: Env, a: { callId: string; amountPaise?: number | null; adminUid: string; note?: string; reverseHost?: boolean /* [HF-CALL-SAFETY-BE] a ban takes the earning back even after the 7-day hold */ },
): Promise<CorrectionResult> {
  const db = env.DB_META;
  const call = await db.prepare(
    "SELECT id, caller_uid, host_uid, consumed_value_paise, lots_used, tokens_spent_micro, ended_at FROM hf_calls WHERE id=?1",
  ).bind(a.callId).first<CallRow>().catch(() => null);
  if (!call) return { ok: false, error: "not_found", message: "No such call." };
  const charge = Math.max(0, Math.trunc(Number(call.consumed_value_paise ?? 0)));
  if (call.tokens_spent_micro == null || charge <= 0) return { ok: false, error: "no_charge", message: "This call was not charged, so there is nothing to correct." };

  // Write the requested amount first. Concurrent/retried requests then converge on the first whole-paise amount before any credit is made.
  const priorIntent = await db.prepare("SELECT rupee_value_paise AS v FROM hf_token_ledger WHERE op_id=?1").bind(corrOpId(a.callId)).first<{ v: number }>();
  let amount = Math.max(0, Math.trunc(Number(priorIntent?.v ?? 0))), again = !!priorIntent;
  if (!priorIntent) {
    const asked = a.amountPaise == null ? charge : Number(a.amountPaise);
    if (!Number.isInteger(asked) || asked <= 0) return { ok: false, error: "invalid_amount", message: "The amount must be a whole number of paise above zero.", maxPaise: charge };
    if (asked > charge) return { ok: false, error: "exceeds_charge", message: `A correction cannot be more than the charge of ${formatRupees(charge)}.`, maxPaise: charge };
    const intent = await db.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id,uid,kind,lot_id,delta_micro,rupee_value_paise,call_id,purchase_id,op_id,note,created_at)
       VALUES (?1,?2,'admin_adjust',NULL,0,?3,?4,NULL,?5,?6,?7)`,
    ).bind(crypto.randomUUID(), call.caller_uid, asked, a.callId, corrOpId(a.callId), `${CALL_REFUND_NOTE_PREFIX}${a.callId};intent`, Date.now()).run();
    const first = await db.prepare("SELECT rupee_value_paise AS v FROM hf_token_ledger WHERE op_id=?1").bind(corrOpId(a.callId)).first<{ v: number }>();
    amount = Math.max(0, Math.trunc(Number(first?.v ?? 0)));
    again = Number((intent as any)?.meta?.changes ?? 0) === 0;
  }
  if (amount <= 0) return { ok: false, error: "wallet_error", message: "The correction did not reach the wallet. Please try again." };

  // Preserve the spent-money provenance. Paid-funded value returns as a purchase-kind lot (and remains eligible to fund withdrawable host
  // earnings); test-funded value returns as a test lot. source_lot_id prevents either credit from being reported as a new Play purchase.
  const shares = correctionShares(call.lots_used, amount, charge);
  const paidCredit = shares.paid > 0 ? await creditLot(env, call.caller_uid, {
    kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: RUPEE_LOT_VALUE_PAISE, micro: paiseToMicro(shares.paid), paidPaise: 0,
    provider: "admin", providerRef: corrOpId(a.callId), note: `${CALL_REFUND_NOTE_PREFIX}${a.callId};paid=${shares.paid}`, sourceLotId: shares.paidSource ?? `call:${a.callId}`,
  }, corrPaidOpId(a.callId)) : { applied: false, lotId: null };
  const testCredit = shares.test > 0 ? await creditLot(env, call.caller_uid, {
    kind: "test", pricingVersion: "gp-r2", valuePaisePerToken: RUPEE_LOT_VALUE_PAISE, micro: paiseToMicro(shares.test), paidPaise: 0,
    provider: "admin", providerRef: corrOpId(a.callId), note: `${CALL_REFUND_NOTE_PREFIX}${a.callId};test=${shares.test}`, sourceLotId: shares.testSource ?? `call:${a.callId}`,
  }, corrTestOpId(a.callId)) : { applied: false, lotId: null };
  const lotId = paidCredit.lotId ?? testCredit.lotId;
  if (!lotId || (shares.paid > 0 && !paidCredit.lotId) || (shares.test > 0 && !testCredit.lotId)) return { ok: false, error: "wallet_error", message: "The correction did not reach the wallet. Please try again." };

  // 2. host reversal, only while the host's earning for this call is still inside the 7-day hold
  const now = Date.now();
  const earns = (await db.prepare(
    "SELECT kind, amount_paise AS amt, available_at AS at, created_at FROM hf_host_ledger WHERE call_id=?1 AND host_uid=?2 AND kind IN ('call_earning','call_earning_test') AND amount_paise>0 ORDER BY created_at ASC",
  ).bind(a.callId, call.host_uid).all<{ kind: string; amt: number; at: number | null; created_at: number }>().catch(() => ({ results: [] }))).results ?? [];
  let hostReversal: HostReversal = "none", hostReversed = 0;
  const existingReversals = (await db.prepare("SELECT op_id, amount_paise AS amt FROM hf_host_ledger WHERE op_id IN (?1,?2)")
    .bind(corrHostOpId(a.callId), corrHostTestOpId(a.callId)).all<{ op_id: string; amt: number }>().catch(() => ({ results: [] }))).results ?? [];
  if (earns.length) {
    const paidEarn = earns.find((e) => e.kind === "call_earning");
    const holdUntil = Number(paidEarn?.at ?? ((call.ended_at ?? earns[0].created_at) + HOST_HOLD_MS));
    // Once either half was reversed inside the hold, a retry must finish the other half even if the clock crossed the hold boundary.
    if (holdUntil > now || existingReversals.length > 0 || a.reverseHost === true) {
      for (const e of earns) {
        const share = Number((BigInt(Math.trunc(Number(e.amt))) * BigInt(amount)) / BigInt(charge));
        if (share <= 0) continue;
        const test = e.kind === "call_earning_test";
        await db.prepare(
          `INSERT OR IGNORE INTO hf_host_ledger (id,host_uid,kind,amount_paise,call_id,payout_id,available_at,op_id,note,created_at)
           VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9)`,
        ).bind(crypto.randomUUID(), call.host_uid, test ? "call_earning_test" : "admin_adjust", -share, a.callId, test ? null : Number(e.at),
          test ? corrHostTestOpId(a.callId) : corrHostOpId(a.callId), `call_correction by ${a.adminUid}`.slice(0, 200), now).run();
      }
      const reversedRows = (await db.prepare("SELECT amount_paise AS amt FROM hf_host_ledger WHERE op_id IN (?1,?2)")
        .bind(corrHostOpId(a.callId), corrHostTestOpId(a.callId)).all<{ amt: number }>()).results ?? [];
      hostReversed = reversedRows.reduce((t, r) => t + Math.abs(Math.trunc(Number(r.amt))), 0);
      if (hostReversed > 0) hostReversal = "reversed";
    } else hostReversal = "after_hold_platform_absorbs";
  } else if (existingReversals.length) {
    hostReversal = "reversed";
    hostReversed = existingReversals.reduce((t, r) => t + Math.abs(Math.trunc(Number(r.amt))), 0);
  }

  // 3. the history line (also the "this call was already corrected" marker); its note keeps the host decision for a repeat answer
  await db.prepare(
    `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
     VALUES (?1,?2,'call_refund',?3,0,?4,?5,NULL,?6,?7,?8)`,
  ).bind(crypto.randomUUID(), call.caller_uid, lotId, amount, a.callId, corrMarkOpId(a.callId), `host=${hostReversal}`, now).run();

  if (again) {
    // Recover the stored host decision (a crash may have stopped before step 3 the first time: then our own values above are the truth).
    const m = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(corrMarkOpId(a.callId)).first<{ note: string | null }>().catch(() => null);
    const h = /host=(reversed|after_hold_platform_absorbs|none)/.exec(m?.note ?? "");
    if (h) hostReversal = h[1] as HostReversal;
  }
  if (hostReversal === "reversed") {
    const rows = (await db.prepare("SELECT amount_paise AS amt FROM hf_host_ledger WHERE op_id IN (?1,?2)")
      .bind(corrHostOpId(a.callId), corrHostTestOpId(a.callId)).all<{ amt: number }>().catch(() => ({ results: [] }))).results ?? [];
    hostReversed = rows.reduce((t, r) => t + Math.abs(Math.trunc(Number(r.amt))), 0);
  } else hostReversed = 0;
  try {
    if (!again) {
      await track(env, a.adminUid, "hf_call_charge_corrected", APP, {
        call_id: a.callId, caller_uid: call.caller_uid, host_uid: call.host_uid, amount_paise: amount, charge_paise: charge, host_reversal: hostReversal,
        host_reversed_paise: hostReversed, paid_share_paise: shares.paid, test_share_paise: shares.test, note: String(a.note ?? "").slice(0, 200),
      });
    }
  } catch (e) { await trackException(env, e, { uid: a.adminUid, route: "hf_call_corrections", handled: true, app_name: APP, extra: { area: "hf_call_corrections" } }).catch(() => undefined); }
  return { ok: true, again, callId: a.callId, callerUid: call.caller_uid, correctedPaise: amount, chargedPaise: charge, hostReversedPaise: hostReversed, hostReversal, lotId };
}
