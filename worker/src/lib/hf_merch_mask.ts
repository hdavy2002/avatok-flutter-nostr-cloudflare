// [HF-MERCH-CORE-1 2026-10-23] THE ONLY place an influencer-facing order is built (spec section 4 / HF-MERCH-7).
// Pure. The output is an ALLOW-LIST: nothing is copied from the row except what is written out below, so a new column
// can never leak by accident. Forbidden for the seller: phone, email, utr, payer_vpa, payer_reference, Cashfree ids,
// wallet op ids, full line1/line2, full pincode, buyer uid.
import { earningAvailableAt } from "./hf_merch_math";
import { parseJson, sellerStatusOf, type MerchAddress, type MerchSnapshot, type SellerStatus } from "./hf_merch_types";

export type SellerOrder = {
  id: string; orderNo: string; createdAt: number; status: SellerStatus;
  product: { title: string; imageUrl: string | null; colour: string; size: string; qty: number };
  money: { pricePaise: number; basePaise: number; youEarnPaise: number; availableAt: number | null; credited: boolean };
  buyer: { firstName: string; city: string; state: string; addressMasked: string };
  shipping: { courier: string | null; awb: string | null; trackingUrl: string | null } | null;
};

/** The columns maskOrderForSeller reads. It receives the whole row but touches only these. */
export type MaskInput = {
  order_id: string; order_no: string; created_at: number; pay_status: string; fulfil_status: string;
  approval_status?: string | null; refund_status?: string | null; printrove_order_ref?: string | null;
  address_json: string; merch_json: string | null; courier: string | null; awb: string | null; tracking_url: string | null;
  delivered_at: number | null; earning_credited_at?: number | null;
} & Record<string, unknown>;

const BULLETS = "•••••";

/** First name only, capped, letters/spaces only. */
export function firstNameOf(full: unknown): string {
  const s = String(full ?? "").trim().split(/\s+/)[0] ?? "";
  return s.replace(/[^\p{L}\p{M}'.-]/gu, "").slice(0, 20) || "Customer";
}

/** "H-12 •••••, Dehradun 2480••": keeps only a short leading house/flat token, the city and the first four pincode digits. */
export function maskAddress(a: Partial<MerchAddress>): string {
  const first = String(a.line1 ?? "").trim().split(/\s+/)[0] ?? "";
  const house = /\d/.test(first) && first.length <= 6 ? first.replace(/[^\p{L}\p{N}\-\/]/gu, "") : "";
  const pin = String(a.pincode ?? "").replace(/\D/g, "");
  const pinMasked = pin.length >= 4 ? `${pin.slice(0, 4)}••` : "";
  const city = String(a.city ?? "").trim().slice(0, 40);
  return [house ? `${house} ${BULLETS}` : BULLETS, [city, pinMasked].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

export function maskOrderForSeller(row: MaskInput, now = Date.now()): SellerOrder {
  const snap = parseJson<Partial<MerchSnapshot>>(row.merch_json, {});
  const addr = parseJson<Partial<MerchAddress>>(row.address_json, {});
  const money = snap.money;
  const status = sellerStatusOf(row);
  const credited = !!row.earning_credited_at;
  const deliveredAt = typeof row.delivered_at === "number" ? row.delivered_at : null;
  const earns = status === "cancelled" ? 0 : Number(money?.influencerPaise ?? 0);
  const availableAt = status !== "cancelled" && deliveredAt != null ? earningAvailableAt(deliveredAt, Number(snap.holdDays ?? 7)) : null;
  const hasShip = !!(row.courier || row.awb || row.tracking_url);
  void now;
  return {
    id: String(row.order_id),
    orderNo: String(row.order_no),
    createdAt: Number(row.created_at),
    status,
    product: {
      title: String(snap.title ?? ""), imageUrl: snap.imageUrl ?? null, colour: String(snap.colour ?? ""), size: String(snap.size ?? ""), qty: Number(snap.qty ?? 1),
    },
    money: {
      pricePaise: Number(money?.totalPaise ?? 0), basePaise: Number(money?.basePaise ?? 0), youEarnPaise: earns, availableAt, credited,
    },
    buyer: { firstName: firstNameOf(addr.name), city: String(addr.city ?? "").slice(0, 40), state: String(addr.state ?? "").slice(0, 40), addressMasked: maskAddress(addr) },
    shipping: hasShip ? { courier: row.courier ?? null, awb: row.awb ?? null, trackingUrl: row.tracking_url ?? null } : null,
  };
}

/** Keys that must never appear anywhere in a seller-facing payload (used by the leak test and as a runtime assertion in routes). */
export const SELLER_FORBIDDEN_KEYS = [
  "phone", "email", "utr", "payer_vpa", "payerVpa", "payer_reference", "payerReference", "cashfree_order_id", "cashfreeOrderId", "cfOrderId",
  "wallet_op_id", "walletOpId", "line1", "line2", "pincode", "uid", "buyerUid", "buyer_uid", "address_json", "contact_name", "printFileUrl",
] as const;

/** Throws if a payload contains a forbidden key (defence in depth for the route layer). */
export function assertNoSellerLeak(payload: unknown): void {
  const bad = new Set<string>(SELLER_FORBIDDEN_KEYS);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (bad.has(k)) throw new Error(`seller_leak:${k}`);
        walk(x);
      }
    }
  };
  walk(payload);
}
