// [PAY-RAIL-1] Cashfree wrapped as a GatewayAdapter, for the generic /api/pay/:gateway/*
// routes. This is a THIN WRAPPER — lib/cashfree.ts is not modified, rewritten or
// reformatted. The dedicated /api/pay/cashfree/* routes (routes/cashfree.ts) keep
// working unchanged and keep using lib/cashfree.ts directly; this adapter exists only so
// Cashfree can also sit in the generic registry per spec §2.1 ("Cashfree stays wired as a
// fourth adapter... It is not offered in the picker unless its flag is on").
//
// Cashfree does not mint a separate gateway-side order id the way Razorpay does — the
// `order_id` we send IS the id Cashfree echoes back (see lib/cashfree.ts:createCashfreeOrder).
// So for this adapter, gateway_order_id and our_order_id are the same string.
import type { Env } from "../../types";
import {
  cashfreeConfigured, createCashfreeOrder, fetchCashfreeOrder, refundCashfreeOrder,
  verifyCashfreeSignature,
} from "../cashfree";
import type { GatewayAdapter, GatewayOrder } from "./types";

function mapStatus(type: string | undefined, orderStatus: string | undefined): "paid" | "failed" | "refunded" | "pending" {
  const t = String(type ?? "").toUpperCase();
  const s = String(orderStatus ?? "").toUpperCase();
  if (t.includes("REFUND")) return "refunded";
  if (t.includes("SUCCESS") || s === "PAID") return "paid";
  if (t.includes("FAILED") || t.includes("DROPPED") || s === "EXPIRED") return "failed";
  return "pending";
}

export const cashfreeAdapter: GatewayAdapter = {
  id: "cashfree",

  configured(env) {
    return cashfreeConfigured(env);
  },

  async createOrder(env, a) {
    const created = await createCashfreeOrder(env, {
      orderId: a.orderId,
      amountPaise: a.amountPaise,
      customerId: a.uid,
      returnUrl: env.CASHFREE_RETURN_URL ?? null,
      // Cashfree's webhook URL is configured in the merchant dashboard, not per-order —
      // the existing dedicated route (routes/cashfree.ts) passes a per-request notifyUrl
      // because it has a `req` to derive an origin from; this adapter's createOrder
      // signature (spec §2.3) does not carry one, so it relies on the dashboard config.
      notifyUrl: null,
    });
    if ("error" in created) return created;
    const order: GatewayOrder = {
      gateway: "cashfree",
      gateway_order_id: created.order_id,
      amount_paise: a.amountPaise,
      currency: a.currency || "INR",
      client_payload: { payment_session_id: created.payment_session_id, order_id: created.order_id },
    };
    return order;
  },

  async verifyWebhook(env, raw, headers) {
    return verifyCashfreeSignature(
      env, raw, headers.get("x-webhook-signature"), headers.get("x-webhook-timestamp"),
    );
  },

  parseWebhook(raw) {
    let payload: any;
    try { payload = JSON.parse(raw); } catch { return null; }
    const gatewayOrderId = String(payload?.data?.order?.order_id ?? "");
    if (!gatewayOrderId) return null;
    const amountPaise = Math.round(Number(payload?.data?.order?.order_amount ?? 0) * 100);
    return {
      gateway_order_id: gatewayOrderId,
      our_order_id: gatewayOrderId, // same string — see file header
      status: mapStatus(payload?.type, payload?.data?.order?.order_status),
      amount_paise: Number.isFinite(amountPaise) ? amountPaise : 0,
      currency: String(payload?.data?.order?.order_currency ?? "INR"),
      gateway_payment_id: payload?.data?.payment?.cf_payment_id != null
        ? String(payload.data.payment.cf_payment_id) : null,
    };
  },

  async fetchOrder(env, gatewayOrderId) {
    const truth = await fetchCashfreeOrder(env, gatewayOrderId);
    if (!truth) return null;
    return { status: truth.order_status, amount_paise: Math.round(Number(truth.order_amount) * 100) };
  },

  async refund(env, a) {
    const r = await refundCashfreeOrder(env, {
      orderId: a.gatewayOrderId,
      refundId: a.opId,
      amountPaise: a.amountPaise,
      note: a.reason,
    });
    return r.ok
      ? { accepted: true, gateway_refund_id: null }
      : { accepted: false, gateway_refund_id: null, error: r.error };
  },
};
