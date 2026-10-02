// [AUMFE-CONSULT-W1-1 2026-10-02] Pure booking rules: status helpers, slot admission, DTO mapping. NO I/O.
import { PAID_CLAIM_REVIEW_MS } from "../saathum_checkout_logic";
import { HOLD_MS, JOIN_EARLY_MS, MIN_LEAD_MS } from "./slots";
import type { BookingDTO, BookingStatus, Discipline, PrepStatus } from "./types";

export const BOOKING_ID_RE = /^cb_[0-9a-f]{20}$/;
export const BOOK_HORIZON_DAYS = 60;
export const MAX_OPEN_HOLDS = 3;
/** Statuses that occupy a slot (mirrors the ux_consult_slot_live partial index). */
export const LIVE_STATUSES: BookingStatus[] = ["held", "awaiting_review", "confirmed", "in_call", "completed", "no_show_customer"];
/** Busy-calendar statuses per spec (held/awaiting_review/confirmed/in_call/completed/no_show_customer). */
export const LIVE_STATUS_SQL = LIVE_STATUSES.map((s) => `'${s}'`).join(",");
export const OPEN_PAY_STATUSES: BookingStatus[] = ["held", "awaiting_review"];

export interface BookingRow {
  id: string; ref: string; consultant_id: string; uid: string; request_key: string; discipline: Discipline;
  slot_start_ms: number; slot_end_ms: number; status: BookingStatus;
  rate_rupees: number; gst_rupees: number; total_rupees: number; fee_rupees: number; payout_rupees: number;
  intake_json: string; questions_json: string; prep_status: PrepStatus;
  pay_method: "upi" | "wallet"; receiving_account_key: string | null; amount_paise: number | null; rounding_discount_paise: number;
  payer_reference: string | null; reference_revision: number; reason_code: string | null; utr: string | null;
  paid_claimed_at: number | null; receipt_no: string | null; confirmed_at: number | null; expires_at: number | null;
  created_at: number; updated_at: number;
}

export const canCancel = (status: BookingStatus): boolean => status === "held" || status === "awaiting_review";
/** The same predicate the shop uses: automatic matching may still confirm it. */
export function openForMatching(r: Pick<BookingRow, "status" | "confirmed_at" | "reason_code">): boolean {
  return (r.status === "held" || r.status === "awaiting_review") && !r.confirmed_at && r.reason_code !== "finalize_error";
}

/** Customer-visible status: 180 s after "I've paid" a held booking reads awaiting_review; an unpaid hold past expiry reads expired. */
export function externalStatus(r: Pick<BookingRow, "status" | "paid_claimed_at" | "expires_at">, now = Date.now()): BookingStatus {
  if (r.status !== "held") return r.status;
  if (r.paid_claimed_at && now - r.paid_claimed_at > PAID_CLAIM_REVIEW_MS) return "awaiting_review";
  if (!r.paid_claimed_at && r.expires_at != null && r.expires_at <= now) return "expired";
  return "held";
}

export function receiptNoFor(id: string, nowMs: number): string {
  return `AR-${new Date(nowMs).getUTCFullYear()}-${id.replace(/^cb_/, "").slice(0, 10).toUpperCase()}`;
}

export type SlotAdmission = { ok: true } | { ok: false; error: "slot_in_past" | "slot_too_soon" | "slot_too_far" | "slot_unavailable" };
/** `produced` = start_ms values slotsFor generated for that IST date (it already applies lead time + busy). */
export function admitSlot(startMs: number, nowMs: number, produced: number[]): SlotAdmission {
  if (!Number.isSafeInteger(startMs) || startMs <= nowMs) return { ok: false, error: "slot_in_past" };
  if (startMs < nowMs + MIN_LEAD_MS) return { ok: false, error: "slot_too_soon" };
  if (startMs > nowMs + BOOK_HORIZON_DAYS * 86_400_000) return { ok: false, error: "slot_too_far" };
  return produced.includes(startMs) ? { ok: true } : { ok: false, error: "slot_unavailable" };
}

/** Which consultant statuses a viewer may see/book. Public once the flag is on; otherwise previewers see draft + live. */
export function visibleStatuses(isPublic: boolean, previewer: boolean): ("live" | "draft")[] {
  if (isPublic) return ["live"];
  return previewer ? ["draft", "live"] : [];
}

export const holdExpiry = (now: number): number => now + HOLD_MS;

export function toBookingDTO(
  r: BookingRow, c: { slug: string; name: string; photo_url: string }, now = Date.now(),
): BookingDTO {
  const questions = (() => { try { const q = JSON.parse(r.questions_json); return Array.isArray(q) ? q.filter((x): x is string => typeof x === "string") : []; } catch { return []; } })();
  return {
    id: r.id, ref: r.ref, consultant: { slug: c.slug, name: c.name, photo_url: c.photo_url }, discipline: r.discipline,
    slot_start_ms: r.slot_start_ms, slot_end_ms: r.slot_end_ms, status: externalStatus(r, now),
    price: {
      rate: r.rate_rupees, gst: r.gst_rupees, total: r.total_rupees, fee: r.fee_rupees, payout: r.payout_rupees,
      gst_rate_pct: r.rate_rupees > 0 ? Math.round((r.gst_rupees * 100) / r.rate_rupees) : 0,
      fee_rate_pct: r.rate_rupees > 0 ? Math.round((r.fee_rupees * 100) / r.rate_rupees) : 0,
    },
    questions, prep_status: r.prep_status, join_opens_ms: r.slot_start_ms - JOIN_EARLY_MS,
    expires_at: r.status === "held" || r.status === "awaiting_review" ? r.expires_at : null, created_at: r.created_at,
  };
}
