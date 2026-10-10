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
// set the var PLAY_PACKAGE_ID (defaults to com.saathum.app).

import type { Env } from "./types";
import { MONEY_IN_DISABLED } from "./money";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const AT_CACHE_KEY = "play_access_token"; // KV (TOKENS); ~55-min TTL
const PLAY_PAYMENTS_DISABLED = "payments_disabled";

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
  return (env as any).PLAY_PACKAGE_ID || "com.saathum.app";
}

// [SAATHUM-APP-3] Saathum ships as a NEW Play app (com.saathum.app) so that
// existing avaTOK testers never receive it as an update. Both packages talk to
// THIS worker, so purchase verification must accept either: a token minted by
// the old app is only valid against the old package id, and vice versa. Trying
// the configured package first and falling back keeps old testers' wallet
// top-ups working without a second deployment.
export function playPackageIds(env: Env): string[] {
  const primary = playPackageId(env);
  const legacy = (env as any).PLAY_PACKAGE_ID_LEGACY || "ai.avatok.avatok_call";
  return primary === legacy ? [primary] : [primary, legacy];
}

// Verify a SUBSCRIPTION purchase token via purchases.subscriptionsv2.
// Returns entitled=true only when the sub is paid and not past its expiry.
export async function verifyPlaySubscription(
  env: Env,
  purchaseToken: string,
): Promise<PlaySubResult> {
  if (MONEY_IN_DISABLED) return { ok: false, entitled: false, reason: PLAY_PAYMENTS_DISABLED };
  let accessToken: string;
  try { accessToken = await getAccessToken(env); }
  catch (e) { return { ok: false, entitled: false, reason: (e as Error).message }; }

  let res!: Response;
  let data: any;
  for (const pkg of playPackageIds(env)) {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(pkg)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    data = (await res.json()) as any;
    if (res.ok) break; // a token is only valid against the package that minted it
  }
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
  priceAmountMicros?: number;
  priceCurrencyCode?: string;
  purchaseTimeMillis?: number;
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
  if (MONEY_IN_DISABLED) return { ok: false, purchased: false, reason: PLAY_PAYMENTS_DISABLED };
  let accessToken: string;
  try { accessToken = await getAccessToken(env); }
  catch (e) { return { ok: false, purchased: false, reason: (e as Error).message }; }

  let res!: Response;
  let data: any;
  for (const pkg of playPackageIds(env)) {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(pkg)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    data = (await res.json()) as any;
    if (res.ok) break;
  }
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
    priceAmountMicros: Number.isFinite(Number(data.priceAmountMicros)) ? Number(data.priceAmountMicros) : undefined,
    priceCurrencyCode: typeof data.priceCurrencyCode === "string" ? data.priceCurrencyCode.toLowerCase() : undefined,
    purchaseTimeMillis: Number.isFinite(Number(data.purchaseTimeMillis)) ? Number(data.purchaseTimeMillis) : undefined,
  };
}

export interface PlayVoidedPurchase {
  purchaseToken: string;
  orderId?: string;
  productId?: string;
  voidedTimeMillis?: number;
  voidedReason?: number;
}

/** List one-time Play purchases voided/refunded since startTimeMillis. */
export async function listVoidedPlayPurchases(
  env: Env,
  startTimeMillis: number,
  pageToken?: string,
): Promise<{ ok: boolean; purchases: PlayVoidedPurchase[]; nextPageToken?: string; reason?: string }> {
  if (MONEY_IN_DISABLED) return { ok: false, purchases: [], reason: PLAY_PAYMENTS_DISABLED };
  let accessToken: string;
  try { accessToken = await getAccessToken(env); }
  catch (e) { return { ok: false, purchases: [], reason: (e as Error).message }; }

  const u = new URL(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(playPackageId(env))}/purchases/voidedpurchases`,
  );
  u.searchParams.set("startTime", String(Math.max(0, Math.trunc(startTimeMillis))));
  u.searchParams.set("maxResults", "1000");
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) return { ok: false, purchases: [], reason: data?.error?.message || `play_api_${res.status}` };
  const rows = Array.isArray(data.voidedPurchases) ? data.voidedPurchases : [];
  return {
    ok: true,
    purchases: rows.map((p: any) => ({
      purchaseToken: String(p.purchaseToken || ""),
      orderId: typeof p.orderId === "string" ? p.orderId : undefined,
      productId: typeof p.productId === "string" ? p.productId : undefined,
      voidedTimeMillis: Number.isFinite(Number(p.voidedTimeMillis)) ? Number(p.voidedTimeMillis) : undefined,
      voidedReason: Number.isFinite(Number(p.voidedReason)) ? Number(p.voidedReason) : undefined,
    })).filter((p: PlayVoidedPurchase) => p.purchaseToken),
    nextPageToken: typeof data.tokenPagination?.nextPageToken === "string" ? data.tokenPagination.nextPageToken : undefined,
  };
}

// ── [HF-TOK-PLAY-1] package-id-as-parameter variants ────────────────────────
// The functions above are tied to playPackageId(env) and gated by MONEY_IN_DISABLED (the old avaTOK wallet switch). The "...For"
// functions below take the package id explicitly (HF = hfPlayPackageId from config) and are NOT gated by MONEY_IN_DISABLED: HF has its
// own gate (hfTokensEnabled, checked by the callers). Existing avaTOK behaviour is unchanged.
const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const pkgUrl = (packageId: string, tail: string) => `${PLAY_API}/${encodeURIComponent(packageId)}/${tail}`;

export interface PlayProductFull {
  ok: boolean;
  /** HTTP status of the Play call (0 = never reached Play). 4xx = Google rejected the token; 5xx / 0 = transient. */
  status: number;
  purchased: boolean;
  orderId?: string;
  purchaseState?: number;          // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number;       // 0 yet to consume, 1 consumed
  acknowledgementState?: number;   // 0 yet to acknowledge, 1 acknowledged
  priceAmountMicros?: number;
  priceCurrencyCode?: string;
  purchaseTimeMillis?: number;
  obfuscatedExternalAccountId?: string;
  reason?: string;
}

async function playCall(env: Env, method: "GET" | "POST", url: string): Promise<{ ok: boolean; status: number; data: any; reason?: string }> {
  let accessToken: string;
  try { accessToken = await getAccessToken(env); }
  catch (e) { return { ok: false, status: 0, data: {}, reason: (e as Error).message }; }
  try {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${accessToken}` } });
    const data = (await res.json().catch(() => ({}))) as any;
    return { ok: res.ok, status: res.status, data, reason: res.ok ? undefined : data?.error?.message || `play_api_${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, data: {}, reason: `play_fetch_${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
}

/** purchases.products.get for an explicit package. Includes the obfuscated account id and the acknowledgement state. */
export async function verifyPlayProductFor(env: Env, packageId: string, productId: string, purchaseToken: string): Promise<PlayProductFull> {
  const r = await playCall(env, "GET", pkgUrl(packageId, `purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`));
  if (!r.ok) return { ok: false, status: r.status, purchased: false, reason: r.reason };
  const d = r.data;
  const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== "" ? Number(v) : undefined);
  const purchaseState = typeof d.purchaseState === "number" ? d.purchaseState : undefined;
  return {
    ok: true, status: r.status, purchased: purchaseState === 0, orderId: typeof d.orderId === "string" ? d.orderId : undefined,
    purchaseState,
    consumptionState: typeof d.consumptionState === "number" ? d.consumptionState : undefined,
    acknowledgementState: typeof d.acknowledgementState === "number" ? d.acknowledgementState : undefined,
    priceAmountMicros: num(d.priceAmountMicros),
    priceCurrencyCode: typeof d.priceCurrencyCode === "string" ? d.priceCurrencyCode.toLowerCase() : undefined,
    purchaseTimeMillis: num(d.purchaseTimeMillis),
    obfuscatedExternalAccountId: typeof d.obfuscatedExternalAccountId === "string" ? d.obfuscatedExternalAccountId : undefined,
  };
}

export interface PlayActionResult { ok: boolean; status: number; reason?: string }

/** purchases.products.acknowledge. Google refunds purchases that are not acknowledged within 3 days. */
export async function acknowledgeProductFor(env: Env, packageId: string, productId: string, purchaseToken: string): Promise<PlayActionResult> {
  const r = await playCall(env, "POST", pkgUrl(packageId, `purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`));
  return { ok: r.ok, status: r.status, reason: r.reason };
}

/** purchases.products.consume: lets the buyer purchase the same product again (consumables). */
export async function consumeProductFor(env: Env, packageId: string, productId: string, purchaseToken: string): Promise<PlayActionResult> {
  const r = await playCall(env, "POST", pkgUrl(packageId, `purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`));
  return { ok: r.ok, status: r.status, reason: r.reason };
}

/** purchases.voidedpurchases.list for an explicit package (one page; pass `pageToken` from the previous page). */
export async function listVoidedFor(
  env: Env, packageId: string, startTimeMs: number, pageToken?: string,
): Promise<{ ok: boolean; purchases: PlayVoidedPurchase[]; nextPageToken?: string; reason?: string }> {
  const u = new URL(pkgUrl(packageId, "purchases/voidedpurchases"));
  u.searchParams.set("startTime", String(Math.max(0, Math.trunc(startTimeMs))));
  u.searchParams.set("maxResults", "1000");
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  const r = await playCall(env, "GET", u.toString());
  if (!r.ok) return { ok: false, purchases: [], reason: r.reason };
  const rows = Array.isArray(r.data.voidedPurchases) ? r.data.voidedPurchases : [];
  return {
    ok: true,
    purchases: rows.map((p: any) => ({
      purchaseToken: String(p.purchaseToken || ""),
      orderId: typeof p.orderId === "string" ? p.orderId : undefined,
      productId: typeof p.productId === "string" ? p.productId : undefined,
      voidedTimeMillis: Number.isFinite(Number(p.voidedTimeMillis)) ? Number(p.voidedTimeMillis) : undefined,
      voidedReason: Number.isFinite(Number(p.voidedReason)) ? Number(p.voidedReason) : undefined,
    })).filter((p: PlayVoidedPurchase) => p.purchaseToken),
    nextPageToken: typeof r.data.tokenPagination?.nextPageToken === "string" ? r.data.tokenPagination.nextPageToken : undefined,
  };
}

/** orders.refund: refund (and for the Orders API, void) a Play order. For the EXIT agent's caller-refund flow. */
export async function refundOrderFor(env: Env, packageId: string, orderId: string, opts: { revoke?: boolean } = {}): Promise<PlayActionResult> {
  const u = new URL(pkgUrl(packageId, `orders/${encodeURIComponent(orderId)}:refund`));
  if (opts.revoke) u.searchParams.set("revoke", "true");
  const r = await playCall(env, "POST", u.toString());
  return { ok: r.ok, status: r.status, reason: r.reason };
}
