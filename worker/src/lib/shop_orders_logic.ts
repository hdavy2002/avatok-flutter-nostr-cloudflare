// [SAATHUM-SHOP-API-ORDERS-1 2026-10-01] Pure rules for Shop orders (Specs/SPEC-2026-10-01-SAATHUM-SHOP.md
// §2, §4.2, §4.5): ids, external status/step mapping, the admin fulfilment transition table, the UPI deep link,
// receipt money split and the ShopOrder wire envelope. NO I/O -- everything is passed in so it is unit-testable.
// Payment-status rules are REUSED from the event checkout (lib/saathum_checkout_logic.ts), never copied.
import {
  externalStatus, externalReason, receiptAmounts, type Quote, type ReceiptLine, type Address,
} from "./saathum_checkout_logic";
import type { ShopQuote, ShopQuoteLine } from "./shop_logic";

export const SHOP_REFUND_POLICY_VERSION = "shop-refunds-2026-10-01";
export const SHOP_DEFAULT_REPORT_WINDOW_HOURS = 48;
export const SHOP_ORDER_ID_RE = /^shp_[0-9a-f]{20}$/;
/** Admin "stale" threshold: paid but not shipped for this long. */
export const SHOP_STALE_MS = 48 * 3_600_000;

export type ShopPayStatus = "awaiting_payment" | "confirmed" | "review_pending" | "expired" | "cancelled";
export type ShopFulfilStatus = "new" | "at_printer" | "shipped" | "delivered" | "cancelled" | "refunded";
export type ShopStep = "ordered" | "paid" | "printing" | "shipped" | "delivered" | "cancelled" | "refunded";

/** One shop_orders row (spec §2). */
export type ShopOrderRow = {
  order_id: string; order_no: string; uid: string; request_key: string;
  items_json: string; subtotal_rupees: number; discount_rupees: number; coupon_code: string | null;
  gst_rate_pct: number; gst_rupees: number; total_rupees: number;
  address_json: string; contact_name: string | null;
  terms_accepted_at: number; refund_policy_accepted_at: number; refund_policy_version: string;
  pay_status: ShopPayStatus; receiving_account_key: string; amount_paise: number; rounding_discount_paise: number;
  payer_reference: string | null; reference_revision: number; reason_code: string | null; utr: string | null;
  payer_vpa: string | null; matched_message_hash: string | null; confirm_source: string | null;
  paid_claimed_at: number | null; reviewed_by: string | null; review_note: string | null; reviewed_at: number | null;
  review_alerted_at: number | null; receipt_no: string | null; confirmed_at: number | null; expires_at: number;
  email_sent_at: number | null;
  fulfil_status: ShopFulfilStatus; printrove_order_ref: string | null; courier: string | null; awb: string | null;
  tracking_url: string | null; eta_text: string | null; sent_to_printer_at: number | null; shipped_at: number | null;
  delivered_at: number | null; cancel_reason: string | null; refund_utr: string | null; refunded_at: number | null;
  problem_json: string | null; created_at: number; updated_at: number;
};

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------
const hex = (bytes: number): string => {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
};
/** 'shp_' + 20 lowercase hex. */
export const newShopOrderId = (): string => `shp_${hex(10)}`;
/** 'SHP-' + 8 upper hex of the order id. */
export function shopOrderNo(orderId: string): string {
  return `SHP-${orderId.replace(/^shp_/, "").slice(0, 8).toUpperCase()}`;
}
/** Receipt number SS-<year>-<10 upper hex>, derived from the order id (no counter race). */
export function shopReceiptNo(orderId: string, nowMs: number): string {
  return `SS-${new Date(nowMs).getUTCFullYear()}-${orderId.replace(/^shp_/, "").slice(0, 10).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Status + steps
// ---------------------------------------------------------------------------
export type ShopExternalStatus = "awaiting_payment" | "confirmed" | "review_pending" | "expired";

/** Same rules as events: cancelled/expired -> expired; 180 s after "I've paid" -> review_pending. */
export function shopExternalStatus(row: Pick<ShopOrderRow, "pay_status" | "expires_at" | "paid_claimed_at" | "reason_code">, now = Date.now()): ShopExternalStatus {
  return externalStatus({ status: row.pay_status, expires_at: row.expires_at, paid_claimed_at: row.paid_claimed_at, reason_code: row.reason_code }, now);
}
export function shopExternalReason(row: Pick<ShopOrderRow, "pay_status" | "expires_at" | "paid_claimed_at" | "reason_code">, now = Date.now()): string | null {
  return externalReason({ status: row.pay_status, expires_at: row.expires_at, paid_claimed_at: row.paid_claimed_at, reason_code: row.reason_code }, now);
}

/** Customer-visible tracker step: Ordered -> Paid -> Printing -> Shipped -> Delivered (+ terminal cancelled/refunded). */
export function shopStep(status: ShopExternalStatus, fulfil: ShopFulfilStatus): ShopStep {
  if (status !== "confirmed") return "ordered";
  switch (fulfil) {
    case "refunded": return "refunded";
    case "cancelled": return "cancelled";
    case "at_printer": return "printing";
    case "shipped": return "shipped";
    case "delivered": return "delivered";
    default: return "paid";
  }
}

/** A shop order automatic matching may still confirm (same predicate as events). */
export function shopOpenForMatching(row: Pick<ShopOrderRow, "pay_status" | "confirmed_at" | "reason_code">): boolean {
  return (row.pay_status === "awaiting_payment" || row.pay_status === "review_pending") && !row.confirmed_at
    && row.reason_code !== "provisioning_failed" && row.reason_code !== "finalize_error";
}

// ---------------------------------------------------------------------------
// Admin fulfilment transitions (spec §4.5). Illegal -> 409 bad_transition.
// ---------------------------------------------------------------------------
export type ShopAction = "at-printer" | "shipped" | "delivered" | "cancel" | "refund";

export const SHOP_TRANSITIONS: Record<ShopAction, { from: ShopFulfilStatus[]; to: ShopFulfilStatus }> = {
  // Printrove can also be handled outside the app, so "shipped" may skip the printer step.
  "at-printer": { from: ["new"], to: "at_printer" },
  shipped: { from: ["new", "at_printer"], to: "shipped" },
  delivered: { from: ["shipped"], to: "delivered" },
  // Cancel only before the parcel leaves; after that it is a refund (wrong/damaged item).
  cancel: { from: ["new", "at_printer"], to: "cancelled" },
  // Refund is the last step from any live fulfilment state; never twice.
  refund: { from: ["new", "at_printer", "shipped", "delivered", "cancelled"], to: "refunded" },
};

export function canTransition(action: ShopAction, fulfil: ShopFulfilStatus): boolean {
  return SHOP_TRANSITIONS[action].from.includes(fulfil);
}

// ---------------------------------------------------------------------------
// Items / quote snapshot
// ---------------------------------------------------------------------------
function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { const v = JSON.parse(s); return (v ?? fallback) as T; } catch { return fallback; }
}

/** Frozen items snapshot -> ShopQuoteLine[] (amount_rupees derived when an older row lacks it). */
export function orderItems(row: Pick<ShopOrderRow, "items_json">): ShopQuoteLine[] {
  const raw = parseJson<Partial<ShopQuoteLine>[]>(row.items_json, []);
  return raw.map((l) => ({
    product_id: String(l.product_id ?? ""), slug: String(l.slug ?? ""), name: String(l.name ?? ""),
    colour: String(l.colour ?? ""), size: String(l.size ?? ""), qty: Number(l.qty ?? 1),
    unit_rupees: Number(l.unit_rupees ?? 0),
    amount_rupees: Number.isFinite(Number(l.amount_rupees)) ? Number(l.amount_rupees) : Number(l.unit_rupees ?? 0) * Number(l.qty ?? 1),
    image_url: typeof l.image_url === "string" ? l.image_url : null,
  }));
}

export function orderQuote(row: Pick<ShopOrderRow, "items_json" | "subtotal_rupees" | "discount_rupees" | "coupon_code" | "gst_rate_pct" | "gst_rupees" | "total_rupees">): ShopQuote {
  return {
    lines: orderItems(row), subtotal_rupees: row.subtotal_rupees, discount_rupees: row.discount_rupees, coupon_code: row.coupon_code,
    taxable_rupees: row.subtotal_rupees - row.discount_rupees, gst_rate_pct: row.gst_rate_pct, gst_rupees: row.gst_rupees,
    shipping_rupees: 0, total_rupees: row.total_rupees,
  };
}

/**
 * Receipt money block. Reuses the event receipt math (receiptAmounts) on a Quote whose lines are the items, the coupon
 * discount (negative line) and "Shipping (free)"; `subtotal_rupees` is the TAXABLE value so subtotal + GST = total,
 * and the unique-amount rounding discount is split between taxable value and GST exactly like events.
 */
export function shopReceiptMoney(row: Pick<ShopOrderRow, "items_json" | "subtotal_rupees" | "discount_rupees" | "coupon_code" | "gst_rate_pct" | "gst_rupees" | "total_rupees" | "amount_paise">) {
  const q = orderQuote(row);
  const lines = q.lines.map((l) => ({
    kind: "ticket" as const, label: `${l.name} (${l.colour}, ${l.size})`, qty: l.qty, unit_rupees: l.unit_rupees, amount_rupees: l.amount_rupees,
  }));
  if (q.discount_rupees > 0) {
    lines.push({ kind: "ticket", label: `Coupon ${q.coupon_code ?? ""}`.trim(), qty: 1, unit_rupees: -q.discount_rupees, amount_rupees: -q.discount_rupees });
  }
  lines.push({ kind: "ticket", label: "Shipping (free)", qty: 1, unit_rupees: 0, amount_rupees: 0 });
  const asQuote: Quote = { lines, subtotal_rupees: q.taxable_rupees, gst_rate_pct: q.gst_rate_pct, gst_rupees: q.gst_rupees, total_rupees: q.total_rupees };
  const a = receiptAmounts(asQuote, row.amount_paise);
  const out: ReceiptLine[] = a.lines;
  return { lines: out, gstRatePct: q.gst_rate_pct, gstRupees: a.gstRupees, subtotalRupees: a.subtotalRupees, totalRupees: a.totalRupees };
}

// ---------------------------------------------------------------------------
// UPI deep link (mirrors checkoutEnvelope's, note text differs)
// ---------------------------------------------------------------------------
export function shopUpiUri(a: { vpa: string; payeeName: string; amountPaise: number; note: string; merchant?: Record<string, string> }): string {
  return `upi://pay?${new URLSearchParams({
    pa: a.vpa, pn: a.payeeName, ...(a.merchant ?? {}),
    am: (a.amountPaise / 100).toFixed(2), cu: "INR", tn: a.note,
  })}`;
}

// ---------------------------------------------------------------------------
// Envelope (spec §4.2 ShopOrder)
// ---------------------------------------------------------------------------
export type ShopPayCtx = {
  now: number;
  /** policy.enabled -- when false no UPI link is offered. */
  canPay: boolean;
  vpa: string; payeeName: string; merchant: Record<string, string>; note: string;
  reportWindowHours: number;
};
export type ShopEventRow = { kind: string; at: number };

export function buildShopOrder(row: ShopOrderRow, ctx: ShopPayCtx, events: ShopEventRow[] = []) {
  const now = ctx.now;
  const status = shopExternalStatus(row, now);
  const reason = shopExternalReason(row, now);
  const upiUri = ctx.canPay && status === "awaiting_payment"
    ? shopUpiUri({ vpa: ctx.vpa, payeeName: ctx.payeeName, amountPaise: row.amount_paise, note: ctx.note, merchant: ctx.merchant })
    : null;
  const quote = orderQuote(row);
  const shipped = row.shipped_at != null || row.courier != null || row.awb != null;
  const delivered = row.fulfil_status === "delivered" && row.delivered_at != null;
  const problem = parseJson<unknown>(row.problem_json, null);
  return {
    order_id: row.order_id, order_no: row.order_no,
    status, reason_code: reason,
    fulfil_status: row.fulfil_status, step: shopStep(status, row.fulfil_status),
    items: quote.lines, quote,
    address: parseJson<Address | null>(row.address_json, null),
    created_at: row.created_at, confirmed_at: row.confirmed_at,
    payment: {
      upi_url: upiUri, vpa: ctx.vpa || null, payee_name: ctx.payeeName,
      amount_rupees: row.amount_paise / 100, amount_paise: row.amount_paise,
      expires_at: row.expires_at, utr: row.utr,
      reference_revision: row.reference_revision, reason_code: status === "awaiting_payment" ? row.reason_code : null,
    },
    upi: { vpa: ctx.vpa || null, payee_name: ctx.payeeName, uri: upiUri },
    pay_amount_paise: row.amount_paise,
    rounding_discount_paise: row.rounding_discount_paise ?? 0,
    paid_claimed_at: row.paid_claimed_at ?? null,
    receipt_url: status === "confirmed" && row.receipt_no ? `/api/shop/orders/${row.order_id}/receipt.pdf` : null,
    shipment: shipped
      ? { courier: row.courier, awb: row.awb, tracking_url: row.tracking_url, eta_text: row.eta_text, shipped_at: row.shipped_at, delivered_at: row.delivered_at }
      : null,
    timeline: events.map((e) => ({ kind: e.kind, at: e.at })),
    can_report_problem: delivered && problem == null && now - (row.delivered_at as number) <= ctx.reportWindowHours * 3_600_000,
  };
}
export type ShopOrderWire = ReturnType<typeof buildShopOrder>;

// ---------------------------------------------------------------------------
// Problem report
// ---------------------------------------------------------------------------
export function reportWindowOpen(row: Pick<ShopOrderRow, "fulfil_status" | "delivered_at">, hours: number, now: number): boolean {
  return row.fulfil_status === "delivered" && row.delivered_at != null && now - row.delivered_at <= hours * 3_600_000;
}

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------
export type ShopTab = "all" | "awaiting" | "to_print" | "at_printer" | "shipped" | "delivered" | "cancelled";
export const SHOP_TABS: ShopTab[] = ["all", "awaiting", "to_print", "at_printer", "shipped", "delivered", "cancelled"];
export const isShopTab = (v: unknown): v is ShopTab => typeof v === "string" && (SHOP_TABS as string[]).includes(v);

/** SQL predicate per tab; `?1` is always `now`. Never-paid orders whose window passed are hidden everywhere but are not "awaiting". */
const LIVE_UNPAID = `(pay_status='review_pending' OR (pay_status='awaiting_payment' AND (expires_at>?1 OR paid_claimed_at IS NOT NULL)))`;
export const SHOP_TAB_SQL: Record<ShopTab, string> = {
  all: `(${LIVE_UNPAID} OR pay_status IN ('confirmed','cancelled'))`,
  awaiting: LIVE_UNPAID,
  to_print: `(pay_status='confirmed' AND fulfil_status='new')`,
  at_printer: `(pay_status='confirmed' AND fulfil_status='at_printer')`,
  shipped: `(pay_status='confirmed' AND fulfil_status='shipped')`,
  delivered: `(pay_status='confirmed' AND fulfil_status='delivered')`,
  cancelled: `(pay_status='cancelled' OR fulfil_status IN ('cancelled','refunded'))`,
};

export const utrLast4 = (utr: string | null | undefined): string | null => (utr && utr.length >= 4 ? utr.slice(-4) : null);

/** IST calendar-day start (India has no DST). */
export function istDayStartMs(now: number): number {
  const DAY = 86_400_000, OFF = 330 * 60_000;
  return Math.floor((now + OFF) / DAY) * DAY - OFF;
}

export function validHttpUrl(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null; } catch { return null; }
}
