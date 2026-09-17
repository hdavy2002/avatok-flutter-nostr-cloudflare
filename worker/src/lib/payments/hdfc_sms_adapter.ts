// [PAY-HDFC-SMS-1] Private, one-account UPI rail. The bank is not queried by API:
// the companion phone proves receipt of the HDFC credit SMS to the Worker.
import type { Env } from "../../types";
import type { GatewayAdapter, GatewayOrder } from "./types";

export const hdfcSmsConfigured = (env: Env): boolean =>
  String(env.HDFC_UPI_VPA ?? "").includes("@")
  && Boolean(env.HDFC_SMS_DEVICE_ID)
  && Boolean(env.HDFC_SMS_DEVICE_SECRET);

export const hdfcSmsAdapter: GatewayAdapter = {
  id: "hdfc_sms",
  configured: hdfcSmsConfigured,
  testMode: () => true,
  async createOrder(env, a) {
    if (!hdfcSmsConfigured(env)) return { error: "gateway_unconfigured", status: 503 };
    if (a.currency.toUpperCase() !== "INR") return { error: "hdfc_sms_inr_only", status: 400 };
    const amount = Math.trunc(a.amountPaise);
    const transactionRef = a.orderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 35);
    const params = new URLSearchParams({
      pa: String(env.HDFC_UPI_VPA),
      pn: String(env.HDFC_UPI_PAYEE_NAME ?? "AvaTOK"),
      am: (amount / 100).toFixed(2),
      cu: "INR",
      tr: transactionRef,
      tn: `AvaTOK ${transactionRef}`,
    });
    const order: GatewayOrder = {
      gateway: "hdfc_sms",
      gateway_order_id: a.orderId,
      amount_paise: amount,
      currency: "INR",
      client_payload: {
        upi_url: `upi://pay?${params.toString()}`,
        vpa: String(env.HDFC_UPI_VPA),
        payee_name: String(env.HDFC_UPI_PAYEE_NAME ?? "AvaTOK"),
        amount_paise: amount,
        transaction_ref: transactionRef,
      },
    };
    return order;
  },
  // There is no bank-side webhook. The companion's HMAC is verified by the
  // dedicated SMS ingestion route, not by the generic gateway webhook route.
  verifyWebhook: async () => false,
  parseWebhook: () => null,
  fetchOrder: async () => null,
  refund: async () => ({ accepted: false, gateway_refund_id: null, error: "manual_bank_refund_required" }),
};
