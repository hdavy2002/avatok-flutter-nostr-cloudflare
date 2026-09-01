// [PAY-RAIL-1] Paytm adapter — Initiate Transaction API, INR only.
//
// ⚠️ UNVERIFIED AGAINST A LIVE GATEWAY, same caveat as lib/cashfree.ts.
//
// ⚠️ CHECKSUM SIMPLIFICATION, DELIBERATE. Paytm's production PG checksum
// (`checksumgenerator.js`) is AES-128-CBC over a random salt, not a plain HMAC — porting
// it would mean hand-rolling AES-CBC key derivation against undocumented salt handling
// with no sandbox to verify against. Per this workstream's build instructions, the
// checksum here is the SPECIFIED simplification: SHA-256-with-salt over the JSON body,
// keyed on PAYTM_MERCHANT_KEY —
//   checksum = sha256Hex(`${body}|${salt}|${key}`) + salt
// verified by stripping the trailing salt and recomputing. This is NOT Paytm's real PG
// checksum scheme and will not interoperate with a live Paytm checkout until swapped for
// their actual algorithm — flagged here so nobody mistakes this for a verified contract.
//
// ORDER ID. Paytm has no separate gateway-minted order id: the merchant supplies
// `orderId` at initiate time and Paytm uses it verbatim. So gateway_order_id and
// our_order_id are the same string here too (like Cashfree, unlike Razorpay/Stripe).
//
// AMOUNTS. Paytm's initiate-transaction body wants a RUPEE decimal string
// (`txnAmount.value`). The conversion happens HERE ONLY; everything else in this file
// and its callers stays in integer paise.
import type { Env } from "../../types";
import type { GatewayAdapter, GatewayOrder } from "./types";
import { constantTimeEqual, sha256Hex } from "./types";

function baseUrl(env: Env): string {
  return String(env.PAYTM_ENV ?? "staging").toLowerCase() === "production"
    ? "https://securegw.paytm.in"
    : "https://securegw-stage.paytm.in";
}

export function paytmConfigured(env: Env): boolean {
  return Boolean(env.PAYTM_MID && env.PAYTM_MERCHANT_KEY && env.PAYTM_WEBSITE);
}

async function paytmChecksum(bodyJson: string, key: string): Promise<string> {
  const salt = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const hash = await sha256Hex(`${bodyJson}|${salt}|${key}`);
  return `${hash}${salt}`;
}

async function paytmChecksumValid(bodyJson: string, key: string, checksum: string): Promise<boolean> {
  if (!checksum || checksum.length <= 8) return false;
  const salt = checksum.slice(-8);
  const givenHash = checksum.slice(0, -8);
  try {
    const expectedHash = await sha256Hex(`${bodyJson}|${salt}|${key}`);
    return expectedHash.length === givenHash.length && constantTimeEqual(expectedHash, givenHash);
  } catch {
    return false;
  }
}

function mapTxnStatus(status: string | undefined): "paid" | "failed" | "refunded" | "pending" {
  switch (String(status ?? "").toUpperCase()) {
    case "TXN_SUCCESS": return "paid";
    case "TXN_FAILURE": return "failed";
    case "REFUND_SUCCESS": return "refunded";
    default: return "pending"; // PENDING, OPEN
  }
}

export const paytmAdapter: GatewayAdapter = {
  id: "paytm",

  configured(env) {
    return paytmConfigured(env);
  },

  async createOrder(env, a) {
    if (!paytmConfigured(env)) return { error: "gateway_unconfigured", status: 503 };
    if (a.currency.toUpperCase() !== "INR") return { error: "paytm_inr_only", status: 400 };
    const rupees = (a.amountPaise / 100).toFixed(2);
    const body = {
      requestType: "Payment",
      mid: String(env.PAYTM_MID),
      websiteName: String(env.PAYTM_WEBSITE),
      orderId: a.orderId,
      txnAmount: { value: rupees, currency: "INR" },
      userInfo: { custId: a.uid },
    };
    const bodyJson = JSON.stringify(body);
    let signature: string;
    try {
      signature = await paytmChecksum(bodyJson, String(env.PAYTM_MERCHANT_KEY));
    } catch {
      return { error: "checksum_failed", status: 500 };
    }
    let res: Response;
    try {
      res = await fetch(
        `${baseUrl(env)}/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(String(env.PAYTM_MID))}&orderId=${encodeURIComponent(a.orderId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body, head: { signature } }),
        },
      );
    } catch {
      return { error: "gateway_unreachable", status: 502 };
    }
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const txnToken = parsed?.body?.txnToken;
    if (!res.ok || parsed?.body?.resultInfo?.resultStatus !== "S" || !txnToken) {
      return {
        error: String(parsed?.body?.resultInfo?.resultMsg ?? "gateway_error").slice(0, 200),
        status: 502,
      };
    }
    const order: GatewayOrder = {
      gateway: "paytm",
      gateway_order_id: a.orderId, // see file header — Paytm has no separate id
      amount_paise: a.amountPaise,
      currency: "INR",
      client_payload: {
        mid: String(env.PAYTM_MID),
        order_id: a.orderId,
        txn_token: String(txnToken),
        amount: rupees,
      },
    };
    return order;
  },

  /**
   * Paytm posts the callback as an application/x-www-form-urlencoded body carrying
   * CHECKSUMHASH alongside the transaction fields. Verify over every OTHER field,
   * reconstructed as Paytm's own JSON-body-and-salt scheme (see file header) — never
   * parse/trust a field before this passes.
   */
  async verifyWebhook(env, raw, _headers) {
    if (!env.PAYTM_MERCHANT_KEY) return false;
    try {
      const params = new URLSearchParams(raw);
      const checksum = params.get("CHECKSUMHASH");
      if (!checksum) return false;
      const rest = new URLSearchParams(raw);
      rest.delete("CHECKSUMHASH");
      const sortedBody = JSON.stringify(Object.fromEntries([...rest.entries()].sort(([a], [b]) => a.localeCompare(b))));
      return await paytmChecksumValid(sortedBody, String(env.PAYTM_MERCHANT_KEY), checksum);
    } catch {
      return false;
    }
  },

  parseWebhook(raw) {
    let params: URLSearchParams;
    try { params = new URLSearchParams(raw); } catch { return null; }
    const orderId = params.get("ORDERID");
    if (!orderId) return null;
    const amountRupees = Number(params.get("TXNAMOUNT") ?? "0");
    return {
      gateway_order_id: orderId,
      our_order_id: orderId,
      status: mapTxnStatus(params.get("STATUS") ?? undefined),
      amount_paise: Number.isFinite(amountRupees) ? Math.round(amountRupees * 100) : 0,
      currency: params.get("CURRENCY") ?? "INR",
      gateway_payment_id: params.get("TXNID"),
    };
  },

  async fetchOrder(env, gatewayOrderId) {
    if (!paytmConfigured(env)) return null;
    const body = { mid: String(env.PAYTM_MID), orderId: gatewayOrderId };
    const bodyJson = JSON.stringify(body);
    try {
      const signature = await paytmChecksum(bodyJson, String(env.PAYTM_MERCHANT_KEY));
      const res = await fetch(`${baseUrl(env)}/v3/order/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, head: { signature } }),
      });
      if (!res.ok) return null;
      const parsed = await res.json().catch(() => null) as any;
      const amountRupees = Number(parsed?.body?.txnAmount ?? 0);
      return {
        status: String(parsed?.body?.resultInfo?.resultStatus ?? ""),
        amount_paise: Number.isFinite(amountRupees) ? Math.round(amountRupees * 100) : 0,
      };
    } catch {
      return null;
    }
  },

  /** A 200 here means "accepted", not "the money is back" — same asynchronous-refund
   *  caveat as Cashfree. */
  async refund(env, a) {
    if (!paytmConfigured(env)) return { accepted: false, gateway_refund_id: null, error: "gateway_unconfigured" };
    const rupees = (a.amountPaise / 100).toFixed(2);
    const body = {
      mid: String(env.PAYTM_MID),
      txnType: "REFUND",
      orderId: a.gatewayOrderId,
      refId: a.opId, // idempotency key at the gateway — stable, never random
      refundAmount: rupees,
    };
    const bodyJson = JSON.stringify(body);
    try {
      const signature = await paytmChecksum(bodyJson, String(env.PAYTM_MERCHANT_KEY));
      const res = await fetch(`${baseUrl(env)}/refund/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, head: { signature } }),
      });
      const parsed = await res.json().catch(() => null) as any;
      const status = String(parsed?.body?.resultInfo?.resultStatus ?? "");
      // TXN_SUCCESS or PENDING both mean "accepted"; the refund webhook confirms later.
      if (!res.ok || (status !== "TXN_SUCCESS" && status !== "PENDING")) {
        return { accepted: false, gateway_refund_id: null, error: String(parsed?.body?.resultInfo?.resultMsg ?? `gateway_${res.status}`).slice(0, 200) };
      }
      return { accepted: true, gateway_refund_id: parsed?.body?.refId != null ? String(parsed.body.refId) : null };
    } catch {
      return { accepted: false, gateway_refund_id: null, error: "gateway_unreachable" };
    }
  },
};
