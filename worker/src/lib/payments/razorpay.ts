// [PAY-RAIL-1] Razorpay adapter — Orders API v1, INR only.
//
// ⚠️ UNVERIFIED AGAINST A LIVE GATEWAY. Written from Razorpay's documented Orders API
// (https://razorpay.com/docs/api/orders/) and webhook contract
// (https://razorpay.com/docs/webhooks/), same caveat as lib/cashfree.ts. Run the sandbox
// end to end before this handles a rupee.
//
// AUTH. The REST API uses HTTP Basic auth: base64(key_id:key_secret). No SDK — plain
// fetch, per CLAUDE.md ("no npm SDKs").
//
// CORRELATION. Our order id is carried in BOTH `receipt` and `notes.our_order_id` on the
// Razorpay order, and Razorpay copies `notes` onto the payment entity too — so the
// webhook can read `our_order_id` straight off whichever entity it fired for.
//
// AMOUNTS. Already paise on the wire (Razorpay's own minor unit for INR) — no conversion
// needed, unlike Cashfree (rupee decimal) or Paytm (rupee string).
import type { Env } from "../../types";
import type { GatewayAdapter, GatewayOrder } from "./types";
import { constantTimeEqual, hmacSha256Hex } from "./types";

const BASE = "https://api.razorpay.com/v1";

export function razorpayConfigured(env: Env): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET);
}

function authHeader(env: Env): string {
  return `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`;
}

function mapPaymentStatus(status: string | undefined): "paid" | "failed" | "refunded" | "pending" {
  switch (String(status ?? "").toLowerCase()) {
    case "captured": return "paid";
    case "failed": return "failed";
    case "refunded": return "refunded";
    default: return "pending"; // created, authorized, attempted
  }
}

export const razorpayAdapter: GatewayAdapter = {
  id: "razorpay",

  configured(env) {
    return razorpayConfigured(env);
  },

  async createOrder(env, a) {
    if (!razorpayConfigured(env)) return { error: "gateway_unconfigured", status: 503 };
    if (a.currency.toUpperCase() !== "INR") return { error: "razorpay_inr_only", status: 400 };
    let res: Response;
    try {
      res = await fetch(`${BASE}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader(env) },
        body: JSON.stringify({
          amount: Math.trunc(a.amountPaise),
          currency: "INR",
          receipt: a.orderId.slice(0, 40), // Razorpay caps receipt at 40 chars
          payment_capture: 1,
          notes: { our_order_id: a.orderId, uid: a.uid, listing_id: a.listingId, kind: a.kind },
        }),
      });
    } catch {
      return { error: "gateway_unreachable", status: 502 };
    }
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!res.ok || !parsed?.id) {
      return { error: String(parsed?.error?.description ?? "gateway_error").slice(0, 200), status: 502 };
    }
    const order: GatewayOrder = {
      gateway: "razorpay",
      gateway_order_id: String(parsed.id),
      amount_paise: Math.trunc(a.amountPaise),
      currency: "INR",
      // Everything the Razorpay Checkout.js sheet needs. key_id is public by design.
      client_payload: {
        key_id: String(env.RAZORPAY_KEY_ID),
        razorpay_order_id: String(parsed.id),
        amount: Math.trunc(a.amountPaise),
        currency: "INR",
      },
    };
    return order;
  },

  /**
   * Razorpay signs the RAW webhook body: hex(HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)),
   * compared against the `x-razorpay-signature` header. Constant-time compare.
   */
  async verifyWebhook(env, raw, headers) {
    const signature = headers.get("x-razorpay-signature");
    if (!signature || !env.RAZORPAY_WEBHOOK_SECRET) return false;
    try {
      const expected = await hmacSha256Hex(String(env.RAZORPAY_WEBHOOK_SECRET), raw);
      return expected.length === signature.length && constantTimeEqual(expected, signature.toLowerCase());
    } catch {
      return false;
    }
  },

  parseWebhook(raw) {
    let payload: any;
    try { payload = JSON.parse(raw); } catch { return null; }
    const payment = payload?.payload?.payment?.entity;
    const order = payload?.payload?.order?.entity;
    const entity = payment ?? order;
    if (!entity) return null;
    const gatewayOrderId = String(payment?.order_id ?? order?.id ?? "");
    if (!gatewayOrderId) return null;
    const ourOrderId = String(
      payment?.notes?.our_order_id ?? order?.notes?.our_order_id ?? order?.receipt ?? "",
    );
    if (!ourOrderId) return null;
    const eventType = String(payload?.event ?? "");
    const status = eventType.startsWith("refund")
      ? "refunded"
      : mapPaymentStatus(payment?.status ?? (eventType === "order.paid" ? "captured" : undefined));
    return {
      gateway_order_id: gatewayOrderId,
      our_order_id: ourOrderId,
      status,
      amount_paise: Math.trunc(Number(payment?.amount ?? order?.amount ?? 0)),
      currency: String(payment?.currency ?? order?.currency ?? "INR"),
      gateway_payment_id: payment?.id != null ? String(payment.id) : null,
    };
  },

  async fetchOrder(env, gatewayOrderId) {
    if (!razorpayConfigured(env)) return null;
    try {
      const res = await fetch(`${BASE}/orders/${encodeURIComponent(gatewayOrderId)}`, {
        headers: { authorization: authHeader(env) },
      });
      if (!res.ok) return null;
      const parsed = await res.json() as any;
      // Razorpay order status is created|attempted|paid; amount_paid is the settled sum.
      return { status: String(parsed?.status ?? ""), amount_paise: Math.trunc(Number(parsed?.amount_paid ?? 0)) };
    } catch {
      return null;
    }
  },

  /**
   * Razorpay refunds are per-PAYMENT, not per-order, but this adapter's interface takes a
   * gatewayOrderId — so this looks up the order's captured payment first. A 200 here means
   * "accepted"; Razorpay refunds are also asynchronous.
   */
  async refund(env, a) {
    if (!razorpayConfigured(env)) return { accepted: false, gateway_refund_id: null, error: "gateway_unconfigured" };
    try {
      const paymentsRes = await fetch(`${BASE}/orders/${encodeURIComponent(a.gatewayOrderId)}/payments`, {
        headers: { authorization: authHeader(env) },
      });
      if (!paymentsRes.ok) return { accepted: false, gateway_refund_id: null, error: "order_payments_lookup_failed" };
      const payments = await paymentsRes.json().catch(() => null) as any;
      const captured = (payments?.items ?? []).find((p: any) => p?.status === "captured");
      if (!captured?.id) return { accepted: false, gateway_refund_id: null, error: "no_captured_payment" };
      const res = await fetch(`${BASE}/payments/${encodeURIComponent(String(captured.id))}/refund`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader(env),
          // Razorpay's idempotency key — a retry with the same opId must not double-refund.
          "x-razorpay-idempotency-key": a.opId,
        },
        body: JSON.stringify({ amount: Math.trunc(a.amountPaise), notes: { reason: a.reason.slice(0, 200) } }),
      });
      const parsed = await res.json().catch(() => null) as any;
      if (!res.ok) return { accepted: false, gateway_refund_id: null, error: String(parsed?.error?.description ?? `gateway_${res.status}`).slice(0, 200) };
      return { accepted: true, gateway_refund_id: parsed?.id != null ? String(parsed.id) : null };
    } catch {
      return { accepted: false, gateway_refund_id: null, error: "gateway_unreachable" };
    }
  },
};
