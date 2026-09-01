// [PAY-PAYTM-TEST-1 2026-09-01] Paytm adapter — the REAL checksum, staging-first.
//
// WHAT CHANGED AND WHY
// --------------------
// The `[PAY-RAIL-1]` version of this file carried a deliberate placeholder:
// `sha256(body|salt|key) + salt`. Its own header said so, and said it would not
// interoperate with a live Paytm checkout. It wouldn't have — Paytm rejects a
// wrong signature with resultCode 2005, "Checksum provided is invalid", and no
// amount of retrying gets past that.
//
// This file implements Paytm's actual scheme, ported from their published
// reference implementation (`paytmchecksum` on npm, `PaytmChecksum.js`) and
// their docs at paytmpayments.com/docs/checksum:
//
//     salt      = 4 chars, base64 of 3 random bytes
//     hash      = sha256Hex(params + "|" + salt) + salt        // 68 chars
//     signature = base64( AES-128-CBC(hash, key = merchantKey, iv = FIXED_IV) )
//
// with the IV being the fixed ASCII string below — Paytm's, not a choice of
// ours. Verification decrypts the signature, takes the last 4 characters as the
// salt, recomputes, and compares.
//
// `params` differs by direction, and getting this backwards is the single
// easiest way to spend an afternoon on resultCode 2005:
//   • REQUESTS we send (initiate / status / refund) — `params` is the JSON
//     string of the `body` object, exactly as serialised into the wire payload.
//   • CALLBACKS Paytm posts back — `params` is NVP: drop CHECKSUMHASH, sort the
//     remaining keys, and join their VALUES with "|". Not JSON. The previous
//     implementation JSON-encoded the callback fields and would have rejected
//     every genuine callback as tampered.
//
// HOSTS. Paytm moved to paytmpayments.com; the staging host in their current
// docs is securestage.paytmpayments.com. The production host is NOT verified
// here — we are in test mode and nobody should reach it yet — so it is left as
// the long-standing securegw.paytm.in and `PAYTM_HOST` overrides both. Confirm
// production against the docs' Production tab before any real money.
//
// ORDER ID. Paytm has no separate gateway-minted order id: the merchant supplies
// `orderId` and Paytm echoes it. So gateway_order_id === our_order_id here, as
// with Cashfree and unlike Razorpay/Stripe.
//
// AMOUNTS. Paytm's wire format is a RUPEE decimal string ("1.00"). The
// conversion lives in this file only; every caller stays in integer paise.
//
// ⚠️ STILL UNVERIFIED END-TO-END. The algorithm matches Paytm's reference
// implementation, but no transaction has been run against their sandbox from
// this code. Until one has, treat a success here as "the code is right", not as
// "the integration works".
import type { Env } from "../../types";
import type { GatewayAdapter, GatewayOrder } from "./types";
import { sha256Hex } from "./types";

/** Paytm's fixed IV. Their constant, not ours — do not "improve" it. */
const PAYTM_IV = "@@@@&&&&####$$$$";

function baseUrl(env: Env): string {
  const override = env.PAYTM_HOST ? String(env.PAYTM_HOST).replace(/\/+$/, "") : "";
  if (override) return override;
  return String(env.PAYTM_ENV ?? "staging").toLowerCase() === "production"
    ? "https://securegw.paytm.in"
    : "https://securestage.paytmpayments.com";
}

export function paytmConfigured(env: Env): boolean {
  return Boolean(env.PAYTM_MID && env.PAYTM_MERCHANT_KEY && env.PAYTM_WEBSITE);
}

// ── checksum ────────────────────────────────────────────────────────────────

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Paytm's key is used as a raw AES-128 key, so it must be exactly 16 bytes.
 * A key of any other length is a configuration error we want to hear about
 * loudly at call time rather than as an opaque 2005 from the gateway.
 */
async function aesKey(merchantKey: string): Promise<CryptoKey> {
  const raw = utf8(merchantKey);
  if (raw.length !== 16) {
    throw new Error(`paytm merchant key must be 16 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

/** 4 characters, exactly as Paytm's reference does it: base64 of 3 random bytes. */
function randomSalt(): string {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return b64encode(b);
}

/** sha256Hex(params|salt) + salt — Paytm's `calculateHash`. */
async function calculateHash(params: string, salt: string): Promise<string> {
  return (await sha256Hex(`${params}|${salt}`)) + salt;
}

/** Paytm's `generateSignature`. */
export async function paytmSignature(params: string, merchantKey: string): Promise<string> {
  const salt = randomSalt();
  const hash = await calculateHash(params, salt);
  const key = await aesKey(merchantKey);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: utf8(PAYTM_IV) }, key, utf8(hash));
  return b64encode(new Uint8Array(ct));
}

/**
 * Paytm's `verifySignature`. Decrypt, recover the salt from the tail, recompute.
 *
 * The comparison is over a value we just derived from the attacker-supplied
 * signature, so a timing-safe compare buys nothing here that the AES step has
 * not already settled — but a mismatch must be a plain `false`, never a throw
 * that a caller could mistake for a transport error and retry past.
 */
export async function paytmSignatureValid(
  params: string,
  merchantKey: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await aesKey(merchantKey);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: utf8(PAYTM_IV) },
      key,
      b64decode(signature),
    );
    const hash = new TextDecoder().decode(pt);
    if (hash.length < 5) return false;
    const salt = hash.slice(-4);
    return hash === (await calculateHash(params, salt));
  } catch {
    // Bad base64, wrong key length, or padding that doesn't decrypt: all mean
    // "not a signature we issued".
    return false;
  }
}

/**
 * The NVP form Paytm signs a CALLBACK with: sort the keys, join the VALUES with
 * "|". Their `getStringByParams`. CHECKSUMHASH is excluded by the caller.
 */
function nvpParams(fields: Array<[string, string]>): string {
  return fields
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v ?? "")
    .join("|");
}

function mapTxnStatus(status: string | undefined): "paid" | "failed" | "refunded" | "pending" {
  switch (String(status ?? "").toUpperCase()) {
    case "TXN_SUCCESS": return "paid";
    case "TXN_FAILURE": return "failed";
    case "REFUND_SUCCESS": return "refunded";
    default: return "pending"; // PENDING, OPEN, and anything unrecognised
  }
}

/** POST a signed `{body, head}` envelope and hand back the parsed reply. */
async function signedPost(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; parsed: any } | { ok: false; error: string; status: number }> {
  const bodyJson = JSON.stringify(body);
  let signature: string;
  try {
    signature = await paytmSignature(bodyJson, String(env.PAYTM_MERCHANT_KEY));
  } catch (e) {
    // A malformed merchant key lands here. Say which problem it is without ever
    // putting the key, or any part of it, into the message.
    return { ok: false, error: "paytm_key_invalid", status: 500 };
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, head: { signature } }),
    });
  } catch {
    return { ok: false, error: "gateway_unreachable", status: 502 };
  }
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON reply handled below */ }
  if (!res.ok || !parsed) {
    return { ok: false, error: `gateway_${res.status}`, status: 502 };
  }
  return { ok: true, parsed };
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
    const host = baseUrl(env);
    const mid = String(env.PAYTM_MID);

    // Where Paytm posts the result. Without this it falls back to the static URL
    // registered against websiteName, which for a staging merchant is Paytm's own
    // demo page — the payment succeeds and we never hear about it.
    const callbackUrl = env.PAYTM_CALLBACK_URL
      ? String(env.PAYTM_CALLBACK_URL)
      : "https://api.avatok.ai/api/pay/paytm/webhook";

    const body: Record<string, unknown> = {
      requestType: "Payment",
      mid,
      websiteName: String(env.PAYTM_WEBSITE),
      orderId: a.orderId,
      callbackUrl,
      txnAmount: { value: rupees, currency: "INR" },
      userInfo: { custId: a.uid },
    };

    const sent = await signedPost(
      env,
      `/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(mid)}&orderId=${encodeURIComponent(a.orderId)}`,
      body,
    );
    if (!sent.ok) return { error: sent.error, status: sent.status };

    const info = sent.parsed?.body?.resultInfo;
    const txnToken = sent.parsed?.body?.txnToken;
    if (info?.resultStatus !== "S" || !txnToken) {
      return {
        error: String(info?.resultMsg ?? "gateway_error").slice(0, 200),
        status: 502,
      };
    }

    const order: GatewayOrder = {
      gateway: "paytm",
      gateway_order_id: a.orderId, // see file header
      amount_paise: a.amountPaise,
      currency: "INR",
      client_payload: {
        // `redirect_form` tells the browser to POST these three fields as a form
        // to `payment_url` — Paytm's Show Payment Page flow. It is the only web
        // flow that needs no host-specific script tag, which is exactly the
        // ambiguity that bit the first pass at the client side.
        flow: "redirect_form",
        payment_url: `${host}/theia/api/v1/showPaymentPage?mid=${encodeURIComponent(mid)}&orderId=${encodeURIComponent(a.orderId)}`,
        mid,
        order_id: a.orderId,
        txn_token: String(txnToken),
        amount: rupees,
      },
    };
    return order;
  },

  /**
   * Paytm posts the callback as `application/x-www-form-urlencoded` carrying
   * CHECKSUMHASH beside the transaction fields. Verify over the NVP form of
   * every OTHER field — never read or trust a field before this returns true.
   */
  async verifyWebhook(env, raw, _headers) {
    if (!env.PAYTM_MERCHANT_KEY) return false;
    try {
      const params = new URLSearchParams(raw);
      const checksum = params.get("CHECKSUMHASH");
      if (!checksum) return false;
      const fields: Array<[string, string]> = [];
      for (const [k, v] of params.entries()) {
        if (k === "CHECKSUMHASH") continue;
        fields.push([k, v]);
      }
      return await paytmSignatureValid(nvpParams(fields), String(env.PAYTM_MERCHANT_KEY), checksum);
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
    const sent = await signedPost(env, "/v3/order/status", {
      mid: String(env.PAYTM_MID),
      orderId: gatewayOrderId,
    });
    if (!sent.ok) return null;
    const amountRupees = Number(sent.parsed?.body?.txnAmount ?? 0);
    return {
      // The caller wants Paytm's own vocabulary here (TXN_SUCCESS / PENDING /
      // TXN_FAILURE), not our normalised one — `resultStatus` is that field.
      status: String(sent.parsed?.body?.resultInfo?.resultStatus ?? ""),
      amount_paise: Number.isFinite(amountRupees) ? Math.round(amountRupees * 100) : 0,
    };
  },

  /**
   * A 200 here means the refund was REGISTERED, not that money moved — Paytm's
   * own docs say so in the use-case note. The refund webhook is what confirms
   * it, and `commercial_refund_rail.ts` already models that correctly.
   */
  async refund(env, a) {
    if (!paytmConfigured(env)) {
      return { accepted: false, gateway_refund_id: null, error: "gateway_unconfigured" };
    }
    // Paytm refunds against its OWN transaction id, which the caller does not
    // carry — it only knows our order id. One status lookup gets it. Guessing or
    // omitting txnId is refused with resultCode 673, "Original transaction not
    // found", which reads like a missing order rather than a missing field.
    const status = await signedPost(env, "/v3/order/status", {
      mid: String(env.PAYTM_MID),
      orderId: a.gatewayOrderId,
    });
    const txnId = status.ok ? status.parsed?.body?.txnId : null;
    if (!txnId) {
      return { accepted: false, gateway_refund_id: null, error: "txn_id_unavailable" };
    }

    const sent = await signedPost(env, "/refund/apply", {
      mid: String(env.PAYTM_MID),
      txnType: "REFUND",
      orderId: a.gatewayOrderId,
      txnId: String(txnId),
      refId: a.opId, // the gateway's idempotency key — stable, never random
      refundAmount: (a.amountPaise / 100).toFixed(2),
      comments: a.reason.slice(0, 500),
    });
    if (!sent.ok) {
      return { accepted: false, gateway_refund_id: null, error: sent.error };
    }
    const info = sent.parsed?.body?.resultInfo;
    const resultStatus = String(info?.resultStatus ?? "");
    // TXN_SUCCESS and PENDING both mean accepted; anything else is a refusal.
    if (resultStatus !== "TXN_SUCCESS" && resultStatus !== "PENDING") {
      return {
        accepted: false,
        gateway_refund_id: null,
        error: String(info?.resultMsg ?? "refund_refused").slice(0, 200),
      };
    }
    return {
      accepted: true,
      gateway_refund_id: sent.parsed?.body?.refId != null ? String(sent.parsed.body.refId) : null,
    };
  },
};
