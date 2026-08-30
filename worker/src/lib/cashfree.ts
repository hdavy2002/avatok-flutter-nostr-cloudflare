// [PAY-CASHFREE-1] Cashfree client — order creation, signature verification, refunds.
//
// WHY CASHFREE. Stripe India requires a registered company; avaTOK is an unregistered
// business (CLAUDE.md, "THERE IS NO COMPANY"). Cashfree onboards unregistered merchants.
// Owner decision 2026-08-29.
//
// SCOPE. This file talks to the gateway and nothing else — no D1, no ledger, no
// entitlements. The money and the product live in routes/cashfree.ts, which is the only
// caller. Keeping the HTTP client separate is what makes the money path readable.
//
// ⚠️ UNVERIFIED AGAINST A LIVE GATEWAY. Written from Cashfree's documented PG v2023-08-01
// contract; no sandbox credentials existed when it was written, so no request has ever
// actually been sent. Run the sandbox end-to-end before this handles a rupee, and treat
// every field name below as a claim to be checked, not a fact.
import type { Env } from "../types";

const API_VERSION = "2023-08-01";

export type CashfreeOrder = {
  order_id: string;
  payment_session_id: string;
  order_status: string;
};

function baseUrl(env: Env): string {
  return String(env.CASHFREE_ENV ?? "sandbox").toLowerCase() === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

/** Configured means ALL THREE secrets. A partial config is a misconfiguration, not a
 *  degraded mode — half-configured payments must never half-work. */
export function cashfreeConfigured(env: Env): boolean {
  return Boolean(env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY && env.CASHFREE_WEBHOOK_SECRET);
}

function headers(env: Env): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-version": API_VERSION,
    "x-client-id": String(env.CASHFREE_APP_ID),
    "x-client-secret": String(env.CASHFREE_SECRET_KEY),
  };
}

/**
 * Create a payment order. `amountPaise` is what the BUYER pays — base + fee + GST — and
 * is computed server-side from the listing. Never accept an amount from a client.
 *
 * Cashfree quotes `order_amount` in RUPEES as a decimal, while every internal amount in
 * this codebase is an integer (1 token = ₹1, and paise where a sub-rupee unit is needed).
 * The conversion happens HERE and nowhere else.
 */
export async function createCashfreeOrder(env: Env, args: {
  orderId: string;
  amountPaise: number;
  customerId: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  returnUrl?: string | null;
  notifyUrl?: string | null;
}): Promise<CashfreeOrder | { error: string; status: number }> {
  if (!cashfreeConfigured(env)) return { error: "gateway_unconfigured", status: 503 };
  const rupees = (args.amountPaise / 100).toFixed(2);
  const body = {
    order_id: args.orderId,
    order_amount: Number(rupees),
    order_currency: "INR",
    customer_details: {
      customer_id: args.customerId,
      // Cashfree requires a phone. A placeholder is used only when we genuinely have
      // none; it never reaches a user and is not stored as their number.
      customer_phone: args.customerPhone || "9999999999",
      ...(args.customerEmail ? { customer_email: args.customerEmail } : {}),
    },
    order_meta: {
      ...(args.returnUrl ? { return_url: args.returnUrl } : {}),
      ...(args.notifyUrl ? { notify_url: args.notifyUrl } : {}),
    },
  };
  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}/orders`, { method: "POST", headers: headers(env), body: JSON.stringify(body) });
  } catch {
    return { error: "gateway_unreachable", status: 502 };
  }
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!res.ok || !parsed?.payment_session_id) {
    return { error: String(parsed?.message ?? "gateway_error").slice(0, 200), status: res.status >= 400 ? 502 : 502 };
  }
  return {
    order_id: String(parsed.order_id ?? args.orderId),
    payment_session_id: String(parsed.payment_session_id),
    order_status: String(parsed.order_status ?? "ACTIVE"),
  };
}

/** Read an order back from the gateway. The webhook is the trigger; THIS is the truth. */
export async function fetchCashfreeOrder(env: Env, orderId: string): Promise<
  { order_status: string; order_amount: number; cf_order_id?: string } | null
> {
  if (!cashfreeConfigured(env)) return null;
  try {
    const res = await fetch(`${baseUrl(env)}/orders/${encodeURIComponent(orderId)}`, { headers: headers(env) });
    if (!res.ok) return null;
    const parsed = await res.json() as any;
    return {
      order_status: String(parsed?.order_status ?? ""),
      order_amount: Number(parsed?.order_amount ?? 0),
      cf_order_id: parsed?.cf_order_id != null ? String(parsed.cf_order_id) : undefined,
    };
  } catch { return null; }
}

/**
 * Verify a webhook signature: base64(HMAC-SHA256(timestamp + rawBody, secret)).
 *
 * Constant-time compare, because a fast-failing string compare on a signature leaks it
 * a byte at a time. Returns false on ANY problem — a malformed signature is an invalid
 * one, and there is no error path here that should ever result in "treat as valid".
 */
export async function verifyCashfreeSignature(
  env: Env,
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
): Promise<boolean> {
  if (!signature || !timestamp || !env.CASHFREE_WEBHOOK_SECRET) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(env.CASHFREE_WEBHOOK_SECRET)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}${rawBody}`));
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

/**
 * Reverse a payment to the payer's source (their UPI handle).
 *
 * Cashfree refunds are ASYNCHRONOUS: a 200 here means "accepted", not "the money is
 * back". The caller must treat the result as `refund_pending` until the refund webhook
 * confirms it. Marking a refund complete on this response is how a buyer gets told they
 * were refunded when they were not.
 */
export async function refundCashfreeOrder(env: Env, args: {
  orderId: string;
  refundId: string;      // idempotency key at the gateway — stable, never random
  amountPaise: number;
  note?: string;
}): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  if (!cashfreeConfigured(env)) return { ok: false, error: "gateway_unconfigured" };
  try {
    const res = await fetch(`${baseUrl(env)}/orders/${encodeURIComponent(args.orderId)}/refunds`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({
        refund_amount: Number((args.amountPaise / 100).toFixed(2)),
        refund_id: args.refundId,
        refund_note: (args.note ?? "avaTOK refund").slice(0, 100),
        refund_speed: "STANDARD",
      }),
    });
    const parsed = await res.json().catch(() => null) as any;
    // A replayed refund_id comes back as a conflict; that is success, not failure.
    if (!res.ok && res.status !== 409) {
      return { ok: false, error: String(parsed?.message ?? `gateway_${res.status}`).slice(0, 200) };
    }
    return { ok: true, status: String(parsed?.refund_status ?? "PENDING") };
  } catch {
    return { ok: false, error: "gateway_unreachable" };
  }
}
