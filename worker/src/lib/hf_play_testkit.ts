// @ts-nocheck -- test helper only (never imported by Worker code): a fake Google Play Developer API + JWKS behind a fetch function, and a fake Env.
import { makeDb } from "./hf_token_d1_shim";

export const PKG = "com.hellofraands.app";
export const CFG = { enabled: true, provider: "google_play", pricingVersion: "gp-v1", callCostPaisePerMin: 200, hostShareBps: 6000, playPackageId: PKG };

export function makePlayWorld() {
  const purchases = new Map(); // token -> play state
  const voided = [];
  const calls = [];
  const flags = { failConsume: false, failAck: false, down: false };
  const jwks = { keys: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    calls.push(`${method} ${u.pathname}${u.search}`);
    const j = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    if (u.hostname === "www.googleapis.com" && u.pathname === "/oauth2/v3/certs") return j(200, jwks, { "cache-control": "public, max-age=3600" });
    if (flags.down) return j(503, { error: { message: "down" } });
    let m = new RegExp(`^/androidpublisher/v3/applications/${PKG.replace(/\./g, "\\.")}/purchases/products/([^/]+)/tokens/([^/:]+)(:acknowledge|:consume)?$`).exec(u.pathname);
    if (m) {
      const [, sku, token, action] = m;
      const p = purchases.get(decodeURIComponent(token));
      if (!p || p.sku !== decodeURIComponent(sku)) return j(404, { error: { message: "not found" } });
      if (action === ":acknowledge") { if (flags.failAck) return j(500, { error: { message: "ack failed" } }); p.acknowledgementState = 1; return j(200, {}); }
      if (action === ":consume") { if (flags.failConsume) return j(500, { error: { message: "consume failed" } }); p.consumptionState = 1; p.acknowledgementState = 1; return j(200, {}); }
      return j(200, {
        kind: "androidpublisher#productPurchase", orderId: p.orderId, purchaseState: p.purchaseState, consumptionState: p.consumptionState,
        acknowledgementState: p.acknowledgementState, purchaseTimeMillis: String(Date.now()), priceAmountMicros: p.priceMicros == null ? undefined : String(p.priceMicros),
        priceCurrencyCode: p.currency || "INR", obfuscatedExternalAccountId: p.obfuscated,
      });
    }
    if (u.pathname === `/androidpublisher/v3/applications/${PKG}/purchases/voidedpurchases`) return j(200, { voidedPurchases: voided });
    return j(404, { error: { message: `unmocked ${u.pathname}` } });
  };
  return {
    purchases, voided, calls, flags, jwks, fetchImpl,
    buy(token, o = {}) { purchases.set(token, { sku: "hf_tokens_100", orderId: `GPA.${token}`, purchaseState: 0, consumptionState: 0, acknowledgementState: 0, priceMicros: 100_000_000, currency: "INR", obfuscated: "", ...o }); return purchases.get(token); },
  };
}

export function makeEnv(extra = {}) {
  const kv = new Map([["play_access_token", "test-access-token"]]);
  const sent = [];
  return {
    DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-10-hf-play-accounts.sql"]),
    TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
    Q_ANALYTICS: { send: async (e) => { sent.push(e); } },
    HF_PLAY_ACCOUNT_SALT: "unit-test-salt-0123456789abcdef",
    PLAY_SERVICE_ACCOUNT_JSON: "{}",
    _kv: kv, _events: sent,
    ...extra,
  };
}

export const b64urlOf = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const b64urlStr = (s) => b64urlOf(new TextEncoder().encode(s));

/** Mint a Google-style OIDC JWT with a fresh RSA key; returns {jwt, jwk}. */
export async function mintJwt(claims, { kid = "k1", key } = {}) {
  const kp = key ?? (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]));
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid, alg: "RS256", use: "sig" };
  const head = b64urlStr(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64urlStr(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return { jwt: `${head}.${body}.${b64urlOf(sig)}`, jwk, key: kp };
}
