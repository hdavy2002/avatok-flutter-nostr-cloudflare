// [AUMFE-CONSULT-W3-1 2026-10-02] Real Consultants — decide how a session ended and move the money.
// Pure decision (decideOutcome) + idempotent settlement (settleBooking) + the cron sweep (settleDueSessions).
// Rules (Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md §W3):
//   * consultant not in by slot_start + 10 min            -> no_show_consultant (strike, admin alert, NO automatic refund)
//   * consultant in, customer not in by slot_start + 15   -> no_show_customer (consultant is paid)
//   * both in, overlap >= 5 min, call over                 -> completed (consultant is paid, thank-you + review link)
//   * both in but overlap < 5 min                          -> "review": nobody is paid or struck, admin decides by hand
// Money: walletOp earn to the consultant uid, amount = payout, commission = fee, op_id consult:<id>:earn (replay-safe).
import type { Env } from "../../types";
import { metaDb } from "../../db/shard";
import { walletOp } from "../../routes/wallet";
import { track, trackException } from "../../hooks";
import { BRAND } from "../brand";
import { sendAdminAlert } from "../saathum_upi3";
import { formatIst } from "../whatsapp_notify";
import { GRACE_AFTER_MS } from "./slots";
import { consultantById } from "./store";
import { noShowConsultantAdminText, reviewNeededAdminText, moneyPendingAdminText, sendThanks, type BookingRow } from "./notify";

const APP = "aumfe_consult";
export const NO_SHOW_CONSULTANT_MS = 10 * 60_000;
export const NO_SHOW_CUSTOMER_MS = 15 * 60_000;
export const MIN_COMPLETE_SECONDS = 5 * 60;

export type Outcome = "completed" | "no_show_consultant" | "no_show_customer" | "review";

export interface Interval { s: number; e: number | null }

/** Seconds during which BOTH parties were present. Open intervals (e === null) run to `nowMs`. */
export function overlapSeconds(a: Interval[], b: Interval[], nowMs: number): number {
  let ms = 0;
  for (const x of a) {
    const xe = x.e ?? nowMs;
    for (const y of b) {
      const ye = y.e ?? nowMs;
      const lo = Math.max(x.s, y.s), hi = Math.min(xe, ye);
      if (hi > lo) ms += hi - lo;
    }
  }
  return Math.floor(ms / 1000);
}

export interface OutcomeInput {
  now: number;
  slot_start_ms: number;
  slot_end_ms: number;
  consultant_joined_at: number | null;
  customer_joined_at: number | null;
  /** Seconds both were present (D1 customer_seconds / consultant_seconds hold the overlap). */
  overlap_seconds: number;
  /** The DO closed the call (call_ended_at set). */
  call_ended: boolean;
}

/** null = not decidable yet (wait). Pure. */
export function decideOutcome(i: OutcomeInput): Outcome | null {
  if (!i.consultant_joined_at) return i.now >= i.slot_start_ms + NO_SHOW_CONSULTANT_MS ? "no_show_consultant" : null;
  if (!i.customer_joined_at) return i.now >= i.slot_start_ms + NO_SHOW_CUSTOMER_MS ? "no_show_customer" : null;
  const over = i.call_ended || i.now >= i.slot_end_ms + GRACE_AFTER_MS;
  if (!over) return null;
  return i.overlap_seconds >= MIN_COMPLETE_SECONDS ? "completed" : "review";
}

export interface SettleResult { ok: boolean; settled: boolean; outcome: Outcome | null }

const hex = (n: number): string => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };

/** Settle one booking if its outcome is decidable. Idempotent: the status flip is a guarded UPDATE and the earn has a stable op_id. */
export async function settleBooking(env: Env, bookingId: string): Promise<SettleResult> {
  const db = metaDb(env);
  const now = Date.now();
  let outcome: Outcome | null = null;
  try {
    const b = await db.prepare("SELECT * FROM consult_bookings WHERE id = ?1").bind(bookingId).first<BookingRow>();
    if (!b || b.settled_at || b.settle_outcome || (b.status !== "confirmed" && b.status !== "in_call")) {
      return { ok: true, settled: false, outcome: null };
    }
    outcome = decideOutcome({
      now, slot_start_ms: b.slot_start_ms, slot_end_ms: b.slot_end_ms,
      consultant_joined_at: b.consultant_joined_at, customer_joined_at: b.customer_joined_at,
      overlap_seconds: Math.min(Number(b.customer_seconds || 0), Number(b.consultant_seconds || 0)),
      call_ended: !!b.call_ended_at,
    });
    if (!outcome) return { ok: true, settled: false, outcome: null };

    const c = await consultantById(env, b.consultant_id);
    const cname = c?.name ?? "consultant";
    const when = formatIst(b.slot_start_ms);

    if (outcome === "review") {
      const r = await db.prepare(
        "UPDATE consult_bookings SET settle_outcome='review', updated_at=?2 WHERE id=?1 AND settled_at IS NULL AND settle_outcome IS NULL",
      ).bind(bookingId, now).run();
      if (Number(r.meta?.changes ?? 0) === 1) {
        await sendAdminAlert(env, reviewNeededAdminText({ ref: b.ref, consultant: cname, when, seconds: Math.min(Number(b.customer_seconds || 0), Number(b.consultant_seconds || 0)) }));
      }
      void track(env, b.uid, "consult_settled", APP, { outcome, ok: true });
      return { ok: true, settled: false, outcome };
    }

    if (outcome === "no_show_consultant") {
      const r = await db.prepare(
        "UPDATE consult_bookings SET status='no_show_consultant', settle_outcome='no_show_consultant', settled_at=?2, updated_at=?2 WHERE id=?1 AND settled_at IS NULL AND status IN ('confirmed','in_call')",
      ).bind(bookingId, now).run();
      if (Number(r.meta?.changes ?? 0) === 1) {
        await db.prepare("UPDATE consultants SET strikes = strikes + 1, updated_at=?2 WHERE id=?1").bind(b.consultant_id, now).run();
        await sendAdminAlert(env, noShowConsultantAdminText({ ref: b.ref, consultant: cname, when, total: b.total_rupees }));
      }
      void track(env, b.uid, "consult_settled", APP, { outcome, ok: true });
      return { ok: true, settled: true, outcome };
    }

    // completed / no_show_customer: the consultant is paid.
    let paidOk = true;
    if (b.payout_rupees > 0) {
      if (!c?.uid) {
        paidOk = false; // no wallet to pay: admin pays by hand
        await sendAdminAlert(env, moneyPendingAdminText({ ref: b.ref, consultant: cname, payout: b.payout_rupees }));
      } else {
        const r = await walletOp(env, c.uid, {
          op: "earn", uid: c.uid, amount: b.payout_rupees, commission: b.fee_rupees,
          app_name: "consult", ref: b.id, op_id: `consult:${b.id}:earn`, counterparty_uid: b.uid,
        });
        if (r.status !== 200) {
          await trackException(env, new Error(`consult_earn_failed:${r.status}`), { uid: b.uid, route: "consult.settle", handled: true, app_name: APP, extra: { booking: b.id } });
          void track(env, b.uid, "consult_settled", APP, { outcome, ok: false });
          return { ok: false, settled: false, outcome };
        }
      }
    }
    const token = outcome === "completed" ? hex(20) : null;
    const u = await db.prepare(
      "UPDATE consult_bookings SET status=?2, settle_outcome=?2, settled_at=?3, review_token=COALESCE(review_token, ?4), updated_at=?3 WHERE id=?1 AND settled_at IS NULL AND status IN ('confirmed','in_call')",
    ).bind(bookingId, outcome, now, token).run();
    const won = Number(u.meta?.changes ?? 0) === 1;
    void track(env, b.uid, "consult_settled", APP, { outcome, ok: true, paid: paidOk });
    if (won && outcome === "completed") {
      try { await sendThanks(env, bookingId); } catch (e) { await trackException(env, e, { route: "consult.settle.thanks", handled: true, app_name: APP }); }
    }
    return { ok: true, settled: won, outcome };
  } catch (e) {
    await trackException(env, e, { route: "consult.settle", handled: true, app_name: APP, extra: { booking: bookingId, brand: BRAND.slug } });
    void track(env, "system", "consult_settled", APP, { outcome: outcome ?? "unknown", ok: false });
    return { ok: false, settled: false, outcome };
  }
}

/** Cron (every 5 min): settle every booking whose outcome has become decidable. Cheap when there is nothing to do. */
export async function settleDueSessions(env: Env): Promise<number> {
  const now = Date.now();
  const rows = await metaDb(env).prepare(
    `SELECT id, status, slot_end_ms, call_ended_at FROM consult_bookings
      WHERE status IN ('confirmed','in_call') AND settled_at IS NULL AND settle_outcome IS NULL AND slot_start_ms <= ?1
      ORDER BY slot_start_ms LIMIT 25`,
  ).bind(now - NO_SHOW_CONSULTANT_MS).all<{ id: string; status: string; slot_end_ms: number; call_ended_at: number | null }>();
  let settled = 0;
  for (const r of rows.results ?? []) {
    try {
      // The DO alarm normally ends the call; if it never fired, poke it so presence seconds are final.
      if (r.status === "in_call" && !r.call_ended_at && now >= r.slot_end_ms + GRACE_AFTER_MS) {
        try { await env.CONSULT_CALL.get(env.CONSULT_CALL.idFromName(r.id)).fetch(`https://consult/finalize?id=${encodeURIComponent(r.id)}`); }
        catch (e) { await trackException(env, e, { route: "consult.settle.finalize", handled: true, app_name: APP }); }
      }
      const res = await settleBooking(env, r.id);
      if (res.settled) settled++;
    } catch (e) { await trackException(env, e, { route: "consult.settleDue", handled: true, app_name: APP }); }
  }
  return settled;
}
