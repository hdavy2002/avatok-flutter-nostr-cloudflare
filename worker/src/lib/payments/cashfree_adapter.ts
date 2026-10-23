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
  cashfreeConfigured, cashfreeIsProduction, createCashfreeOrder, fetchCashfreeOrder, refundCashfreeOrder, findCashfreeRefund,
  verifyCashfreeSignature,
} from "../cashfree";
import type { GatewayAdapter, GatewayOrder } from "./types";
import { BRAND, brandUrl } from "../brand";
import { cashfreeCheckoutUrl, cashfreeReturnUrl, cashfreeAppReturnUrl } from "../../routes/cashfree_checkout_host";

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

  testMode(env) {
    // [BETA-TESTMODE-1] [HF-CASHFREE-TOPUP-2] CASHFREE_ENV if set, else the key prefix (lib/cashfree.ts cashfreeIsProduction).
    return !cashfreeIsProduction(env);
  },

  async createOrder(env, a) {
    const created = await createCashfreeOrder(env, {
      orderId: a.orderId,
      amountPaise: a.amountPaise,
      customerId: a.uid,
      // [HF-CASHFREE-TOPUP-1] Wallet top-ups get their own return + notify URLs per order, so the live rail works without
      // anyone pasting a webhook into the Cashfree dashboard. {order_id} is Cashfree's own placeholder. The status poll on
      // /wallet is the backstop if a webhook is ever lost.
      // [HF-WIRE-20] Orders started from the native app return to the app (avatok.ai/pay/cashfree/return -> hellofraands://wallet/topup/<id>),
      // never to the website. CASHFREE_APP_RETURN_URL overrides; the website's CASHFREE_RETURN_URL is deliberately ignored for them.
      returnUrl: a.kind === "hf_merch" // [HF-MERCH-CORE-1] merch returns to the order page (web) or the app, via the checkout host's /done and /return
        ? (a.client === "app"
          ? (env.CASHFREE_APP_RETURN_URL ?? cashfreeAppReturnUrl() ?? brandUrl("/dashboard/orders?order={order_id}"))
          : (cashfreeReturnUrl() ?? brandUrl("/dashboard/orders?order={order_id}")))
        : a.kind === "wallet_topup"
        ? (a.client === "app"
          ? (env.CASHFREE_APP_RETURN_URL ?? cashfreeAppReturnUrl() ?? brandUrl("/wallet?topup={order_id}"))
          : (env.CASHFREE_RETURN_URL ?? cashfreeReturnUrl() ?? brandUrl("/wallet?topup={order_id}")))
        : (env.CASHFREE_RETURN_URL ?? null),
      notifyUrl: a.kind === "hf_merch" ? `${BRAND.apiOrigin}/api/hf/merch/webhook/cashfree`
        : a.kind === "wallet_topup" ? `${BRAND.apiOrigin}/api/hf/wallet/topup/webhook/cashfree` : null,
      // [HF-WIRE-20] The payer's real details only. A wallet top-up with no valid number is refused, never sent with a made-up one.
      customerPhone: a.customer?.phone ?? null,
      customerEmail: a.customer?.email ?? null,
      customerName: a.customer?.name ?? null, // [HF-WIRE-21]
      // [HF-WIRE-21] In-app checkout: only the modes the app's own screens offer (UPI apps, UPI ID, cards).
      paymentMethods: a.kind === "wallet_topup" && a.checkoutMode === "native" ? "upi,cc,dc" : null,
      requirePhone: a.kind === "wallet_topup" || a.kind === "hf_merch",
    });
    if ("error" in created) return created;
    const order: GatewayOrder = {
      gateway: "cashfree",
      gateway_order_id: created.order_id,
      amount_paise: a.amountPaise,
      currency: a.currency || "INR",
      client_payload: {
        payment_session_id: created.payment_session_id, order_id: created.order_id,
        // [HF-CASHFREE-CHECKOUT-HOST-1] Present = open the checkout on the whitelisted domain (full-page hand-off), not as a modal here.
        ...((a.kind === "wallet_topup" || a.kind === "hf_merch") && a.checkoutMode !== "native" && cashfreeCheckoutUrl(created.payment_session_id, a.orderId)
          ? { checkout_url: cashfreeCheckoutUrl(created.payment_session_id, a.orderId)! } : {}),
      },
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

  /** [HF-WALLET-EXIT-1] our per-slice id IS the Cashfree refund_id (refund() above passes opId as refundId). */
  async listRefunds(env, a) {
    const r = await findCashfreeRefund(env, a.gatewayOrderId, a.opId);
    return r ? { found: r.found, gateway_refund_id: r.id } : null;
  },
};
