// play.ts — Google Play Developer API verification (server-side, Workers-native).
//
// Verifies a Play Billing purchase token for a SUBSCRIPTION so the server can
// entitle a tier ONLY for a real, paid, active purchase (we fail closed — see
// routes/subscribe.ts). No external SDK: we mint a service-account JWT with the
// Web Crypto API (RS256), exchange it for an OAuth access token (cached in KV),
// then call purchases.subscriptionsv2.
//
// Setup (owner): create a Google Cloud service account, grant it access in the
// Play Console (Users & permissions → "View financial data" + the app), download
// its JSON key, and set it as the Worker secret PLAY_SERVICE_ACCOUNT_JSON. Also
// set the var PLAY_PACKAGE_ID (defaults to ai.avatok.avatok_call).

import type { Env } from "./types";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const AT_CACHE_KEY = "play_access_token"; // KV (TOKENS); ~55-min TTL

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PlaySubResult {
  ok: boolean;
  /** Entitled = paid & not expired (ACTIVE / IN_GRACE / CANCELED-but-future). */
  entitled: boolean;
  productId?: string;
  expiryMs?: number | null;
  state?: string;
  reason?: string;
}

// ── base64url helpers ───────────────────────────────────────────────────────
function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromStr(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

// PEM (PKCS#8) → CryptoKey for RS256 signing.
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// Mint + exchange a service-account JWT for an OAuth access token (cached in KV).
async function getAccessToken(env: Env): Promise<string> {
  try {
    const cached = await env.TOKENS.get(AT_CACHE_KEY);
    if (cached) return cached;
  } catch { /* KV read best-effort */ }

  const raw = (env as any).PLAY_SERVICE_ACCOUNT_JSON as string | undefined;
  if (!raw) throw new Error("play_unconfigured");
  const sa = JSON.parse(raw) as ServiceAccount;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || TOKEN_URI,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64urlFromStr(JSON.stringify(header))}.${b64urlFromStr(JSON.stringify(claim))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;

  const res = await fetch(sa.token_uri || TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  const tok = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !tok.access_token) throw new Error("play_token_exchange_failed");

  try {
    await env.TOKENS.put(AT_CACHE_KEY, tok.access_token, {
      expirationTtl: Math.max(60, (tok.expires_in ?? 3600) - 300),
    });
  } catch { /* cache best-effort */ }
  return tok.access_token;
}

export function playPackageId(env: Env): string {
  return (env as any).PLAY_PACKAGE_ID || "ai.avatok.avatok_call";
}

// Verify a SUBSCRIPTION purchase token via purchases.subscriptionsv2.
// Returns entitled=true only when the sub is paid and not past its expiry.
export async function verifyPlaySubscription(
  env: Env,
  purchaseToken: string,
): Promise<PlaySubResult> {
  let accessToken: string;
  try { accessToken = await getAccessToken(env); }
  catch (e) { return { ok: false, entitled: false, reason: (e as Error).message }; }

  const pkg = playPackageId(env);
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(pkg)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = (await res.json()) as any;
  if (!res.ok) {
    return { ok: false, entitled: false, reason: data?.error?.message || `play_api_${res.status}` };
  }

  const state: string = data.subscriptionState || "";
  const line = Array.isArray(data.lineItems) && data.lineItems.length ? data.lineItems[0] : null;
  const productId: string | undefined = line?.productId;
  const expiryIso: string | undefined = line?.expiryTime;
  const expiryMs = expiryIso ? Date.parse(expiryIso) : null;

  // Paid & usable states. CANCELED still entitles until expiryTime passes.
  const paidStates = new Set([
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
    "SUBSCRIPTION_STATE_CANCELED",
  ]);
  const notExpired = expiryMs == null ? true : Date.now() < expiryMs;
  const entitled = paidStates.has(state) && notExpired;

  return { ok: true, entitled, productId, expiryMs, state };
}

export interface PlayProductResult {
  ok: boolean;
  /** True only when Google reports the one-time purchase as PURCHASED (state 0). */
  purchased: boolean;
  /** Google order id (e.g. GPA.xxxx) — the idempotency key for wallet crediting. */
  orderId?: string;
  purchaseState?: number;   // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number; // 0 yet-to-consume, 1 consumed
  reason?: string;
}

// Verify a ONE-TIME product purchase token via purchases.products.get. Used by
// AvaWallet top-ups: the client buys a fixed-price `avatok_topup_*` product and
// POSTs the token here; we confirm Google actually charged for it before the
// server credits Tokens. purchaseState===0 (PURCHASED) is the only creditable
// state; the returned orderId dedupes credits (never trust the client amount —
// the caller maps productId→Tokens from a server-side table).
export async function verifyPlayProduct(
  env: Env,
  productId: string,
  purchaseToken: string,
): Promise<PlayProductResult> {
  let accessToken: string;
  try { accessToken = await getAccessToken(env); }
  catch (e) { return { ok: false, purchased: false, reason: (e as Error).message }; }

  const pkg = playPackageId(env);
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(pkg)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = (await res.json()) as any;
  if (!res.ok) {
    return { ok: false, purchased: false, reason: data?.error?.message || `play_api_${res.status}` };
  }

  const purchaseState: number | undefined = typeof data.purchaseState === "number" ? data.purchaseState : undefined;
  const consumptionState: number | undefined = typeof data.consumptionState === "number" ? data.consumptionState : undefined;
  return {
    ok: true,
    purchased: purchaseState === 0,
    orderId: data.orderId,
    purchaseState,
    consumptionState,
  };
}
