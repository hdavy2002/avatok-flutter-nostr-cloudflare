// [AUMFE-POD-FULFIL-1 2026-10-01] Pure rules for print-partner fulfilment (Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md §6).
// NO I/O and no import of lib/pod at runtime -- everything is passed in so it is unit-testable (pod_fulfil.test.ts).
// I/O lives in lib/pod_fulfil.ts, which re-exports this file.
import { shopExternalStatus, utrLast4, type ShopOrderRow } from "./shop_orders_logic";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------
export type FulfilmentStatus = "queued" | "sending" | "sent" | "printing" | "shipped" | "delivered" | "problem" | "cancelled";
export type ProductionState = "not_sent" | FulfilmentStatus;
export type PartnerState = "sent" | "printing" | "shipped" | "delivered" | "problem" | "cancelled";
export type OrderFulfil = ShopOrderRow["fulfil_status"];

/** Forward-only rank of the healthy path; problem/cancelled are handled separately. */
const RANK: Record<string, number> = { queued: 0, sending: 0, sent: 1, printing: 2, shipped: 3, delivered: 4 };

export type StatusChange = {
  /** New shop_fulfilments.status, or null = nothing to do. */
  to: FulfilmentStatus | null;
  /** The shop_orders.fulfil_status steps to apply, in order (CAS each). [] = leave the order alone. */
  orderSteps: Array<"at_printer" | "shipped" | "delivered">;
  /** Owner alert only (problem / cancelled at the partner). */
  alertOwner: boolean;
};

/**
 * Map what the partner reported onto our rows. Monotonic: a late/duplicated poll never moves a row backwards.
 * `printing` keeps the order at 'at_printer' (the buyer already got "being printed" when it was sent -- no new message);
 * `shipped`/`delivered` walk the order forward one step at a time so a skipped poll still sends BOTH messages' state.
 */
export function mapPartnerState(current: FulfilmentStatus, orderFulfil: OrderFulfil, reported: PartnerState): StatusChange {
  if (current === "cancelled" || current === "delivered") return { to: null, orderSteps: [], alertOwner: false };
  if (reported === "problem" || reported === "cancelled") {
    if (current === reported) return { to: null, orderSteps: [], alertOwner: false };
    return { to: reported, orderSteps: [], alertOwner: true };
  }
  const have = RANK[current] ?? 0;
  const want = RANK[reported] ?? 1;
  const to: FulfilmentStatus | null = want > have || current === "problem" ? reported : null;
  const steps: StatusChange["orderSteps"] = [];
  if (reported === "printing" && orderFulfil === "new") steps.push("at_printer");
  if (reported === "shipped" && (orderFulfil === "new" || orderFulfil === "at_printer")) steps.push("shipped");
  if (reported === "delivered") {
    if (orderFulfil === "new" || orderFulfil === "at_printer") steps.push("shipped");
    if (orderFulfil !== "delivered") steps.push("delivered");
  }
  return { to, orderSteps: steps, alertOwner: false };
}

// ---------------------------------------------------------------------------
// Retry backoff: after attempt n fails, wait 5 min -> 30 min -> 2 h; after three retries leave it for the owner.
// ---------------------------------------------------------------------------
export const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;
export const MAX_AUTO_RETRIES = BACKOFF_MS.length;

/** `attempts` = how many sends have been tried so far (>=1). Returns the epoch-ms of the next try, or null = give up. */
export function nextAttemptAt(attempts: number, now: number): number | null {
  if (!Number.isFinite(attempts) || attempts < 1) return now + BACKOFF_MS[0];
  const i = attempts - 1;
  return i < BACKOFF_MS.length ? now + BACKOFF_MS[i] : null;
}

/** Orders paid less than this long ago are left for the human first (auto-send grace). */
export const AUTO_SEND_GRACE_MS = 2 * 60_000;
export const AUTO_SEND_PER_TICK = 10;
export const POLL_PER_TICK = 20;

/** Is a status row due a poll? */
export function pollDue(lastPolledAt: number | null, pollMinutes: number, now: number): boolean {
  const every = Math.max(1, Number.isFinite(pollMinutes) ? pollMinutes : 30) * 60_000;
  return lastPolledAt == null || now - lastPolledAt >= every;
}

// ---------------------------------------------------------------------------
// Money state (spec §6.1)
// ---------------------------------------------------------------------------
export type MoneyState = "bank_confirmed" | "owner_confirmed" | "customer_claimed" | "awaiting" | "expired" | "rejected";
export type MoneySms = { amount_paise: number | null; received_at_ms: number | null; bank_reference: string | null; payer_vpa: string | null };
export type Money = {
  state: MoneyState; label: string;
  amount_expected_rupees: number; amount_received_rupees: number | null; received_at: number | null;
  utr_last4: string | null; payer_vpa_masked: string | null; matched: "auto" | "manual" | null; buyer_notified_at: number | null;
  /** When the customer pressed "I've paid" (additive to the spec shape; drives "Bank has not confirmed yet · 6 min"). */
  claimed_at: number | null;
};

export const MONEY_LABEL: Record<MoneyState, string> = {
  bank_confirmed: "Paid · bank confirmed ✓", owner_confirmed: "Paid · confirmed by you ✓", customer_claimed: "Customer says paid",
  awaiting: "Awaiting payment", expired: "Expired", rejected: "Rejected",
};

/** ravi.kumar@okaxis -> ravi••@okaxis (never the full address). */
export function maskVpa(vpa: string | null | undefined): string | null {
  if (!vpa) return null;
  const at = vpa.indexOf("@");
  if (at < 1) return "••";
  const local = vpa.slice(0, at);
  return `${local.slice(0, Math.min(4, Math.max(1, local.length - 2)))}••${vpa.slice(at)}`;
}

type MoneyRow = Pick<ShopOrderRow, "pay_status" | "confirm_source" | "paid_claimed_at" | "utr" | "payer_reference" | "payer_vpa" | "expires_at" | "reason_code"
  | "amount_paise" | "confirmed_at" | "email_sent_at">;

export function deriveMoney(row: MoneyRow, sms: MoneySms | null, outboxSentAt: number | null, now: number): Money {
  let state: MoneyState;
  if (row.pay_status === "confirmed") state = row.confirm_source === "sms_auto" ? "bank_confirmed" : "owner_confirmed";
  else if (row.pay_status === "cancelled") state = row.reason_code === "rejected" ? "rejected" : "expired";
  else if (shopExternalStatus(row, now) === "expired") state = "expired";
  else state = row.paid_claimed_at != null || !!row.utr ? "customer_claimed" : "awaiting";
  const confirmed = state === "bank_confirmed" || state === "owner_confirmed";
  const ref = row.utr ?? row.payer_reference ?? sms?.bank_reference ?? null;
  return {
    state, label: MONEY_LABEL[state],
    amount_expected_rupees: row.amount_paise / 100,
    amount_received_rupees: confirmed && sms?.amount_paise != null ? sms.amount_paise / 100 : null,
    received_at: confirmed ? (sms?.received_at_ms ?? row.confirmed_at) : null,
    utr_last4: utrLast4(ref),
    payer_vpa_masked: maskVpa(row.payer_vpa),
    matched: !confirmed ? null : state === "bank_confirmed" ? "auto" : "manual",
    buyer_notified_at: confirmed ? (row.email_sent_at ?? outboxSentAt) : null,
    claimed_at: row.paid_claimed_at ?? null,
  };
}

export const moneyIsConfirmed = (s: MoneyState): boolean => s === "bank_confirmed" || s === "owner_confirmed";

// ---------------------------------------------------------------------------
// Production state (spec §6.1)
// ---------------------------------------------------------------------------
export type FulfilmentLite = {
  status: FulfilmentStatus; provider: string; provider_order_id: string | null; courier: string | null; awb: string | null;
  tracking_url: string | null; last_error: string | null;
};
export type Production = {
  state: ProductionState; provider: string | null; provider_order_id: string | null; courier: string | null; awb: string | null;
  tracking_url: string | null; problem: string | null; can_send: boolean; send_blocked_reason: string | null;
};

export type SendContext = {
  money: MoneyState;
  /** 'api' = a print partner with an API is selected; 'manual' = by hand. */
  providerLabel: string; providerSupportsApi: boolean; providerId: string;
  /** First reason the order cannot be built (unmapped variant, address, phone) or null. */
  buildBlocker: string | null;
};

/** Why "Send to production" is off, or null when it can be pressed. Order matters: money first, then what was already done. */
export function sendBlockedReason(orderFulfil: OrderFulfil, hasRow: boolean, rowStatus: FulfilmentStatus | null, ctx: SendContext): string | null {
  if (!moneyIsConfirmed(ctx.money)) {
    if (ctx.money === "customer_claimed") return "The customer says they paid, but your bank has not confirmed it yet.";
    if (ctx.money === "rejected" || ctx.money === "expired") return "This order was not paid.";
    return "Waiting for payment.";
  }
  if (hasRow && rowStatus !== "problem") return `Already sent to ${ctx.providerLabel}.`;
  if (orderFulfil !== "new") return "This order has already been handled by hand.";
  if (!ctx.providerSupportsApi) return `${ctx.providerLabel} is not connected. Place the order in the partner's dashboard, then use "Sent to Printrove".`;
  return ctx.buildBlocker;
}

export function deriveProduction(orderFulfil: OrderFulfil, row: FulfilmentLite | null, ctx: SendContext): Production {
  const blocked = sendBlockedReason(orderFulfil, !!row, row?.status ?? null, ctx);
  let state: ProductionState = "not_sent";
  if (row) state = row.status;
  else if (orderFulfil === "at_printer") state = "printing";
  else if (orderFulfil === "shipped") state = "shipped";
  else if (orderFulfil === "delivered") state = "delivered";
  else if (orderFulfil === "cancelled" || orderFulfil === "refunded") state = "cancelled";
  return {
    state, provider: row?.provider ?? (state === "not_sent" ? null : "manual"),
    provider_order_id: row?.provider_order_id ?? null, courier: row?.courier ?? null, awb: row?.awb ?? null, tracking_url: row?.tracking_url ?? null,
    problem: row?.status === "problem" ? (row.last_error ?? "The print partner reported a problem.") : null,
    can_send: blocked == null, send_blocked_reason: blocked,
  };
}

// ---------------------------------------------------------------------------
// Placement (studio_designs.placement_json -> the partner's frame, inches from the print area's top-left)
// ---------------------------------------------------------------------------
export type StudioPlacementLike = {
  side?: unknown; frame_w_in?: unknown; frame_h_in?: unknown; frame_top_in?: unknown; frame_left_in?: unknown;
  print_w_in?: unknown; print_h_in?: unknown; print_left_in?: unknown; print_top_in?: unknown; nudge_x_in?: unknown;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Where the print PNG sits on the print area, in inches from the area's top-left -- the numbers the partner is given AND the
 * ones the detail panel shows (describeShipment calls this too). studio_designs.placement_json stores the PNG's own box as
 * print_left_in / print_top_in / print_w_in / print_h_in (it can be smaller than the frame when the art is zoomed out), so those
 * win. Only a placement without them (older rows) falls back to the frame, centred on the print area unless frame_left_in is stored.
 * Returns null when there is no usable size (the caller then blocks the send).
 */
export function placementForPartner(p: StudioPlacementLike | null | undefined, areaWidthIn: number | null): { side: "front" | "back"; width_in: number; height_in: number; top_in: number; left_in: number } | null {
  if (!p) return null;
  const side = p.side === "back" ? "back" : "front";
  const pw = num(p.print_w_in), ph = num(p.print_h_in), pl = num(p.print_left_in), pt = num(p.print_top_in);
  if (pw != null && ph != null && pl != null && pt != null && pw > 0 && ph > 0) {
    return { side, width_in: round2(pw), height_in: round2(ph), top_in: round2(pt), left_in: round2(pl) };
  }
  const w = pw ?? num(p.frame_w_in), h = ph ?? num(p.frame_h_in);
  if (w == null || h == null || w <= 0 || h <= 0) return null;
  const left = pl ?? num(p.frame_left_in) ?? (areaWidthIn != null ? Math.max(0, (areaWidthIn - w) / 2) : 0);
  return { side, width_in: round2(w), height_in: round2(h), top_in: round2(pt ?? num(p.frame_top_in) ?? 0), left_in: round2(left) };
}
