// [PAY-RAIL-1] Stripe adapter — PaymentIntents, INTERNATIONAL (non-INR) buyers only.
//
// WHY NOT INR. Stripe India requires a registered company; avaTOK is an unregistered
// business (CLAUDE.md, "THERE IS NO COMPANY"). Cashfree/Razorpay/Paytm onboard
// unregistered merchants for INR; Stripe here is scoped to non-INR buyers, where the
// same restriction does not apply the same way. This adapter REFUSES an INR charge —
// createOrder returns an error rather than silently accepting one.
//
// ⚠️ UNVERIFIED AGAINST A LIVE GATEWAY for THIS adapter's flow, same caveat as
// lib/cashfree.ts. (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET already exist in this repo
// for the wallet top-up and subscription rails — this is a NEW, separate use of the same
// credentials, for a different product and a different webhook route.)
//
// No Stripe SDK — plain fetch to the REST API, per CLAUDE.md ("no npm SDKs"). PaymentIntents
// use application/x-www-form-urlencoded bodies, which is Stripe's actual wire format.
import type { Env } from "../../types";
import type { GatewayAdapter, GatewayOrder } from "./types";
import { constantTimeEqual, hmacSha256Hex } from "./types";

const BASE = "https://api.stripe.com/v1";
const MAX_WEBHOOK_AGE_SECONDS = 300; // reject a stripe-signature timestamp older than 5 minutes

export function stripeIntlConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

function authHeader(env: Env): string {
  return `Bearer ${env.STRIPE_SECRET_KEY}`;
}

function mapIntentStatus(status: string | undefined): "paid" | "failed" | "refunded" | "pending" {
  switch (String(status ?? "")) {
    case "succeeded": return "paid";
    case "canceled": return "failed";
    default: return "pending"; // requires_payment_method, requires_confirmation, processing, ...
  }
}

export const stripeIntlAdapter: GatewayAdapter = {
  id: "stripe",

  configured(env) {
    return stripeIntlConfigured(env);
  },

  async createOrder(env, a) {
    if (!stripeIntlConfigured(env)) return { error: "gateway_unconfigured", status: 503 };
    // Non-INR only — the whole reason this adapter exists alongside three INR ones.
    if (a.currency.toUpperCase() === "INR") return { error: "stripe_intl_no_inr", status: 400 };
    const form = new URLSearchParams();
    form.set("amount", String(Math.trunc(a.amountPaise)));
    form.set("currency", a.currency.toLowerCase());
    form.set("automatic_payment_methods[enabled]", "true");
    form.set("metadata[our_order_id]", a.orderId);
    form.set("metadata[uid]", a.uid);
    form.set("metadata[listing_id]", a.listingId);
    form.set("metadata[kind]", a.kind);
    let res: Response;
    try {
      res = await fetch(`${BASE}/payment_intents`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: authHeader(env) },
        body: form.toString(),
      });
    } catch {
      return { error: "gateway_unreachable", status: 502 };
    }
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!res.ok || !parsed?.id || !parsed?.client_secret) {
      return { error: String(parsed?.error?.message ?? "gateway_error").slice(0, 200), status: 502 };
    }
    const order: GatewayOrder = {
      gateway: "stripe",
      gateway_order_id: String(parsed.id), // PaymentIntent id (pi_...) — Stripe has no separate "order"
      amount_paise: Math.trunc(a.amountPaise),
      currency: a.currency.toLowerCase(),
      client_payload: {
        client_secret: String(parsed.client_secret),
        publishable_key: String(env.STRIPE_PUBLISHABLE_KEY ?? ""),
        payment_intent_id: String(parsed.id),
      },
    };
    return order;
  },

  /**
   * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 keyed on
   * STRIPE_WEBHOOK_SECRET, sent as `stripe-signature: t=<ts>,v1=<hex>[,v0=...]`.
   * A stale timestamp (>5 min) is rejected even with a valid signature — that is the
   * replay-window Stripe's own libraries enforce.
   */
  async verifyWebhook(env, raw, headers) {
    const header = headers.get("stripe-signature");
    if (!header || !env.STRIPE_WEBHOOK_SECRET) return false;
    const parts = Object.fromEntries(
      header.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k, v] as [string, string];
      }),
    );
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1) return false;
    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_WEBHOOK_AGE_SECONDS) return false;
    try {
      const expected = await hmacSha256Hex(String(env.STRIPE_WEBHOOK_SECRET), `${timestamp}.${raw}`);
      return expected.length === v1.length && constantTimeEqual(expected, v1);
    } catch {
      return false;
    }
  },

  parseWebhook(raw) {
    let payload: any;
    try { payload = JSON.parse(raw); } catch { return null; }
    const obj = payload?.data?.object;
    if (!obj?.id) return null;
    const ourOrderId = String(obj?.metadata?.our_order_id ?? "");
    if (!ourOrderId) return null;
    const eventType = String(payload?.type ?? "");
    const status = eventType === "charge.refunded" || eventType === "payment_intent.refunded"
      ? "refunded"
      : eventType === "payment_intent.payment_failed"
        ? "failed"
        : mapIntentStatus(obj?.status);
    return {
      gateway_order_id: String(obj.id),
      our_order_id: ourOrderId,
      status,
      amount_paise: Math.trunc(Number(obj?.amount ?? obj?.amount_captured ?? 0)),
      currency: String(obj?.currency ?? "").toUpperCase(),
      gateway_payment_id: obj?.latest_charge != null ? String(obj.latest_charge) : (obj?.id != null ? String(obj.id) : null),
    };
  },

  async fetchOrder(env, gatewayOrderId) {
    if (!stripeIntlConfigured(env)) return null;
    try {
      const res = await fetch(`${BASE}/payment_intents/${encodeURIComponent(gatewayOrderId)}`, {
        headers: { authorization: authHeader(env) },
      });
      if (!res.ok) return null;
      const parsed = await res.json() as any;
      return { status: String(parsed?.status ?? ""), amount_paise: Math.trunc(Number(parsed?.amount ?? 0)) };
    } catch {
      return null;
    }
  },

  /** A 200 here means Stripe accepted the refund request. Stripe refunds usually settle
   *  quickly but are not guaranteed synchronous — treat as pending until confirmed. */
  async refund(env, a) {
    if (!stripeIntlConfigured(env)) return { accepted: false, gateway_refund_id: null, error: "gateway_unconfigured" };
    const form = new URLSearchParams();
    form.set("payment_intent", a.gatewayOrderId);
    form.set("amount", String(Math.trunc(a.amountPaise)));
    form.set("metadata[reason]", a.reason.slice(0, 200));
    try {
      const res = await fetch(`${BASE}/refunds`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: authHeader(env),
          "idempotency-key": a.opId,
        },
        body: form.toString(),
      });
      const parsed = await res.json().catch(() => null) as any;
      if (!res.ok) return { accepted: false, gateway_refund_id: null, error: String(parsed?.error?.message ?? `gateway_${res.status}`).slice(0, 200) };
      return { accepted: true, gateway_refund_id: parsed?.id != null ? String(parsed.id) : null };
    } catch {
      return { accepted: false, gateway_refund_id: null, error: "gateway_unreachable" };
    }
  },
};
