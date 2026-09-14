// [PAY-RAIL-1] Gateway-agnostic payment layer — shared types.
//
// This generalises the shape already proven in lib/cashfree.ts + routes/cashfree.ts:
// create an order, verify a webhook signature over the RAW body before parsing it,
// fetch order status, refund. See Specs/SPEC-2026-09-01-PAID-SESSION-PIPELINE-BUILD.md
// §2 for the contract this file implements verbatim.
//
// ⚠️ UNVERIFIED AGAINST A LIVE GATEWAY, same caveat as lib/cashfree.ts. Written from each
// gateway's documented contract; no sandbox credentials existed when this was written, so
// no request has ever actually been sent to Razorpay, Paytm or Stripe by this code. Treat
// every field name as a claim to be checked against a real sandbox run, not a fact.
import type { Env } from "../../types";

export type GatewayId = "razorpay" | "paytm" | "stripe" | "cashfree";

export interface GatewayOrder {
  gateway: GatewayId;
  gateway_order_id: string;
  amount_paise: number;
  currency: string; // 'INR' for razorpay/paytm/cashfree
  /** Everything the browser SDK needs to open the sheet. Never a secret. */
  client_payload: Record<string, string | number>;
}

export interface GatewayAdapter {
  readonly id: GatewayId;
  configured(env: Env): boolean;
  /**
   * [BETA-TESTMODE-1 2026-09-14] Is this rail pointed at the gateway's TEST/sandbox
   * environment? It drives the buyer-facing "no real money will be charged" notice, so
   * it must be a FACT about the credentials actually in use — never a platform flag.
   * A flag can be flipped while live keys stay in place, and a wrong `true` tells a
   * buyer his real card is safe when it is not. An adapter that cannot tell returns
   * `false`: the notice then stays hidden, which is the only safe direction to be
   * wrong in.
   */
  testMode(env: Env): boolean;
  createOrder(env: Env, a: {
    orderId: string; // OUR order id — becomes the gateway's receipt/notes
    amountPaise: number;
    currency: string;
    uid: string;
    listingId: string;
    kind: "live_event" | "consult_1to1";
  }): Promise<GatewayOrder | { error: string; status: number }>;
  /** Verify over the RAW body. Must not parse before verifying. */
  verifyWebhook(env: Env, raw: string, headers: Headers): Promise<boolean>;
  parseWebhook(raw: string): {
    gateway_order_id: string;
    our_order_id: string;
    status: "paid" | "failed" | "refunded" | "pending";
    amount_paise: number;
    currency: string;
    gateway_payment_id: string | null;
  } | null;
  fetchOrder(env: Env, gatewayOrderId: string): Promise<{ status: string; amount_paise: number } | null>;
  /**
   * [PAY-RAIL-3] OPTIONAL client-side handoff. Razorpay's Checkout.js hands the browser
   * `razorpay_payment_id | razorpay_order_id | razorpay_signature` on success; the
   * signature is HMAC-SHA256(`order_id|payment_id`) under the API KEY SECRET (not the
   * webhook secret), so the Worker can authenticate that handoff without waiting for the
   * webhook. An adapter that leaves this undefined is webhook-only, and
   * POST /api/pay/:gateway/verify answers 501 for it.
   */
  verifyHandoff?(env: Env, a: { gatewayOrderId: string; gatewayPaymentId: string; signature: string }): Promise<boolean>;
  /**
   * [PAY-RAIL-3] OPTIONAL single-payment read-back, the handoff path's equivalent of
   * `fetchOrder`. The browser claiming "paid" is never enough: an `authorized` payment is
   * not captured money, so the handoff route refuses to provision until the gateway itself
   * says `captured`.
   */
  fetchPayment?(env: Env, gatewayPaymentId: string): Promise<{ status: string; amount_paise: number; order_id: string } | null>;
  refund(env: Env, a: { gatewayOrderId: string; amountPaise: number; reason: string; opId: string }):
    Promise<{ accepted: boolean; gateway_refund_id: string | null; error?: string }>;
}

/** Constant-time string compare. Every signature check in this directory goes through
 *  this — a fast-failing compare on a signature leaks it a byte at a time. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
