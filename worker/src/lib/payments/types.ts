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
