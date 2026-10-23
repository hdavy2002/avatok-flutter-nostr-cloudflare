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
  sizes: Array<{ size: string; baseUnitPaise: number }>;
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
