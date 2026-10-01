/* [SAATHUM-SHOP-WEB-CHECKOUT-1] Wire shapes of the shop HTTP contract
 * (Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §3 and §4.2). Local copies on purpose: the checkout island must not
 * depend on whichever shopApi.ts WEB-STORE ships. Do not add a field the spec does not list. */
import type { Address } from '../saathum-checkout/types';
export type { Address };

export type ShopCartItem = { product_id: string; colour: string; size: string; qty: number };

export interface ShopQuoteLine {
  product_id: string; slug: string; name: string; colour: string; size: string; qty: number;
  unit_rupees: number; amount_rupees: number; image_url: string | null;
}
export interface ShopQuote {
  lines: ShopQuoteLine[];
  subtotal_rupees: number;
  discount_rupees: number;
  coupon_code: string | null;
  taxable_rupees: number;
  gst_rate_pct: number;
  gst_rupees: number;
  shipping_rupees: 0;
  total_rupees: number;
}

export type ShopPayStatus = 'awaiting_payment' | 'confirmed' | 'review_pending' | 'expired';

export interface ShopOrder {
  order_id: string;
  order_no: string;
  status: ShopPayStatus;
  reason_code: string | null;
  fulfil_status: string;
  step: 'ordered' | 'paid' | 'printing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  items: ShopQuoteLine[];
  quote: ShopQuote;
  address: Address | null;
  created_at: number;
  confirmed_at: number | null;
  payment: {
    upi_url: string | null; vpa: string; payee_name: string; amount_rupees: number; amount_paise: number;
    expires_at: number; utr: string | null; reference_revision: number; reason_code: string | null;
  };
  upi: { vpa: string | null; payee_name: string; uri: string | null };
  pay_amount_paise: number;
  rounding_discount_paise: number;
  paid_claimed_at: number | null;
  receipt_url: string | null;
  shipment: { courier: string | null; awb: string | null; tracking_url: string | null; eta_text: string | null; shipped_at: number | null; delivered_at: number | null } | null;
  timeline: { kind: string; at: number }[];
  can_report_problem: boolean;
}

export interface CreateShopOrderBody {
  request_key: string;
  items: ShopCartItem[];
  coupon?: string;
  address: Address;
  accept_terms: true;
  refund_policy_accepted: true;
}

export type ShopStep = 'you' | 'address' | 'review' | 'pay' | 'done';
