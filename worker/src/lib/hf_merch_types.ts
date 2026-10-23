// [HF-MERCH-CORE-1 2026-10-23] Shared types for the merch shop. Pure (types + tiny helpers only).
import type { MerchMoney, PayMethod } from "./hf_merch_math";

/** Frozen into shop_orders.merch_json at checkout. Never rewritten except the explicit fields in MerchSnapshotMut. */
export type MerchSnapshot = {
  v: 1;
  sellerUid: string;
  hostSlug: string;
  hostName: string;
  productId: string;
  productSlug: string;
  title: string;
  imageUrl: string | null;
  catalogId: string;
  catalogName: string;
  colour: string;
  size: string;
  qty: number;
  side: "front" | "back";
  /** Print-file R2/Blossom URL used for the Printrove order. Never sent to the influencer's order view. */
  printFileUrl: string | null;
  money: MerchMoney;
  payMethod: PayMethod;
  holdDays: number;
  /** Print size in inches and the buffer used when the base price was frozen: the approval re-quote prices the SAME print. */
  printWIn: number;
  printHIn: number;
  bufferRupees: number;
  /** [HF-CHANNEL-CORE-1] Bag checkout: every order of one bag payment carries the same `mgp_` id (also the Cashfree order id). Absent on single-item orders. */
  groupId?: string;
};

/** [HF-CHANNEL-CORE-1] Group (bag) id: `mgp_` + 20 hex. One payment, one order per bag line. */
export const MERCH_GROUP_ID_RE = /^mgp_[a-f0-9]{20}$/;
export const isMerchGroupId = (id: unknown): id is string => typeof id === "string" && MERCH_GROUP_ID_RE.test(id);
export const newMerchGroupId = (): string => `mgp_${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
/** The group an order belongs to (from its frozen snapshot), or null for a single-item order. */
export const groupIdOf = (row: { merch_json?: string | null }): string | null => {
  const g = parseJson<{ groupId?: unknown }>(row.merch_json, {}).groupId;
  return isMerchGroupId(g) ? g : null;
};

export type MerchAddress = { name: string; phone: string; line1: string; line2?: string; city: string; state: string; pincode: string };

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type RefundStatus = "none" | "done" | "pending_manual" | "refunding";

export type SellerStatus = "new" | "processing" | "shipped" | "delivered" | "cancelled";
export type FanStatus = "awaiting_payment" | "placed" | "approved" | "printing" | "shipped" | "delivered" | "cancelled" | "refunded";

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { const v = JSON.parse(s); return (v ?? fallback) as T; } catch { return fallback; }
}

/** The subset of shop_orders columns the merch status mappers need. */
export type MerchOrderStatusRow = {
  pay_status: string; fulfil_status: string; approval_status?: string | null; refund_status?: string | null;
  printrove_order_ref?: string | null; delivered_at?: number | null;
};

/** Influencer view: new (not yet approved) / processing (approved, not shipped) / shipped / delivered / cancelled (rejected, cancelled, refunded). */
export function sellerStatusOf(r: MerchOrderStatusRow): SellerStatus {
  if (r.fulfil_status === "cancelled" || r.fulfil_status === "refunded" || r.approval_status === "rejected") return "cancelled";
  if (r.fulfil_status === "delivered") return "delivered";
  if (r.fulfil_status === "shipped") return "shipped";
  if (r.approval_status === "approved") return "processing";
  return "new";
}

/** Fan view per spec FanOrder.status. */
export function fanStatusOf(r: MerchOrderStatusRow): FanStatus {
  if (r.fulfil_status === "refunded" || (r.approval_status === "rejected" && r.refund_status && r.refund_status !== "none")) return "refunded";
  if (r.fulfil_status === "cancelled" || r.pay_status === "expired" || r.pay_status === "cancelled") return "cancelled";
  if (r.pay_status !== "confirmed") return "awaiting_payment";
  if (r.fulfil_status === "delivered") return "delivered";
  if (r.fulfil_status === "shipped") return "shipped";
  if (r.fulfil_status === "at_printer") return "printing";
  if (r.approval_status === "approved") return "approved";
  return "placed";
}

/** shop_products.merch_json of an influencer product. Per-size base prices are frozen here at creation (the partner is re-quoted at order approval). */
export type ProductMerch = {
  v: 1;
  productSlug: string;
  provider: string;
  catalogId: string;
  catalogName: string;
  kind: string;
  side: "front" | "back";
  /** printingPaise / shippingPaise / bufferPaise are frozen with the base at creation [HF-MERCH-PRICE-LABELS-1]; absent on older products. */
  sizes: Array<{ size: string; baseUnitPaise: number; printingPaise?: number; shippingPaise?: number; bufferPaise?: number; /** Printrove's GST for this size, basis points (input credit); absent = the category rate */ partnerGstBps?: number }>;
  /** [HF-MERCH-GST-1] The category's GST rate + HSN + cap-applies, FROZEN at creation (a later admin edit never changes it). Absent on products made before it: flat fallback. */
  gst?: { rateBps: number; hsn: string; capApplies: boolean; category?: string };
  bufferRupees: number;
  colours: Array<{ name: string; hex: string }>;
  /** studio Placement (lib/studio_logic.ts) the partner print uses. */
  placement: Record<string, unknown>;
  mockups: string[];
  printPreviewUrl: string | null;
  artUrl: string | null;
  /** 'ok' = classifier ran and passed; 'unscanned' = classifier was unavailable (admin review required). */
  moderation: "ok" | "unscanned";
  approvedAt?: number | null;
  hiddenBy?: "admin" | "seller" | null;
  listing?: { designRef: string | null; listingRef: string | null; error: string | null } | null;
};

export type ApiProductStatus = "pending" | "live" | "rejected" | "hidden";
export const apiProductStatus = (reviewStatus: string | null | undefined): ApiProductStatus =>
  reviewStatus === "live" ? "live" : reviewStatus === "rejected" ? "rejected" : reviewStatus === "hidden" ? "hidden" : "pending";
