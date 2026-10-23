// [HF-TOK-PLAY-1] HF token purchases with Google Play Billing: verify, credit a lot, acknowledge + consume, real-time notifications
// (Pub/Sub push, Google-signed JWT), refunds and the cron backstops. Spec: section 11.5 of the HF Android app spec.
//
// Rules this file keeps:
//  - Money safety first: a lot is created ONLY for a Play purchase that is PURCHASED (state 0), a known + active product, and whose
//    obfuscatedExternalAccountId equals the HMAC of the signed-in user. The credit is idempotent through the ledger op id `hfplay:<orderId>`
//    (creditLot) and the UNIQUE token / order columns of hf_play_purchases: the same purchase sent any number of times is one lot.
//  - Crash safety: hf_play_purchases is inserted (state verified) BEFORE creditLot and promoted to credited AFTER it. creditLot owns its own
//    D1 batch (lot + ledger + debt clearing), so the three steps are not one batch, but every step is idempotent and the cron resumes any
//    row left in `verified`, so a crash at any point heals without a second lot or a lost credit.
//  - Refunds: op id `hfvoid:<orderId>`, applied once (revokeLot). Host earnings are never touched (HF-TOK-D8).
//  - The "...For" Play calls are not gated by MONEY_IN_DISABLED (that is the old avaTOK switch); HF is gated by hfTokensEnabled here.
import type { Env } from "../types";
import { creditLot, revokeLot, balanceSummary, type BalanceSummary, getPricingVersion } from "./hf_token_ledger";
import { MICRO, topupSplit, paiseToMicro, RUPEE_LOT_VALUE_PAISE } from "./hf_token_math";
import { readHfStdPlan, type HfTokenConfig } from "./hf_token_config";
import { acknowledgeProductFor, consumeProductFor, verifyPlayProductFor, listVoidedFor, type PlayProductFull } from "../play";
import { trackUser, trackException } from "../hooks";
import { emailFor } from "./identity";
import { BRAND } from "./brand";
import { issuePurchaseRecord } from "./hf_receipts";
import { notifyTopupCredited } from "./hf_topup_notify";
import { readConfig } from "../routes/config";
import { pokeLiveCall } from "./hf_call_funds"; // [HF-CALL-MODES-INT]

const APP = BRAND.slug;
const DAY = 86_400_000;
export const CONSUME_RETRY_AFTER_MS = 5 * 60_000;
const VOID_SWEEP_EVERY_MS = 55 * 60_000;
const VOID_KV_KEY = "hf_play_void_sweep";
const PRODUCT_RE = /^[a-z0-9][a-z0-9_.]{0,99}$/;

export const validProductId = (v: unknown): v is string => typeof v === "string" && PRODUCT_RE.test(v);
export const validPurchaseToken = (v: unknown): v is string => typeof v === "string" && v.length >= 10 && v.length <= 2048 && !/\s/.test(v);

// ── telemetry ────────────────────────────────────────────────────────────────
export async function emit(env: Env, uid: string | null | undefined, event: string, props: Record<string, unknown>): Promise<void> {
  if (!uid) return;
  try {
    const email = await emailFor(env, uid).catch(() => null);
    await trackUser(env, uid, email, event, APP, { area: "hf_token_play", ...props });
  } catch { /* best-effort */ }
}

// ── account id (HMAC of the uid) ─────────────────────────────────────────────
const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string): Uint8Array => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};

/** base64url HMAC-SHA256(uid). Key = HF_PLAY_ACCOUNT_SALT when set, else derived from HF_PII_KEY with a fixed label
 * ([HF-TOK-PLAY-2]: the Worker is at Cloudflare's 128 text-binding limit, so no new secret can be added).
 * NEVER rotate the key source: every user's Play account id would change. Null = no key: callers FAIL CLOSED. */
export async function accountHashFor(env: Env, uid: string): Promise<string | null> {
  const direct = env.HF_PLAY_ACCOUNT_SALT;
  const pii = env.HF_PII_KEY;
  const salt = direct && direct.length >= 16 ? direct : (pii && pii.length >= 16 ? `hf-play-account-v1:${pii}` : "");
  if (!salt || !uid) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(uid))));
}
const safeEq = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
export async function rememberAccount(env: Env, uid: string, hash: string): Promise<void> {
  await env.DB_META.prepare("INSERT OR IGNORE INTO hf_play_accounts (account_hash, uid, created_at) VALUES (?1,?2,?3)").bind(hash, uid, Date.now()).run();
}
async function uidForHash(env: Env, hash: string | undefined): Promise<string | null> {
  if (!hash) return null;
  const r = await env.DB_META.prepare("SELECT uid FROM hf_play_accounts WHERE account_hash=?1").bind(hash).first<{ uid: string }>().catch(() => null);
  return r?.uid ?? null;
}

// ── products ─────────────────────────────────────────────────────────────────
export interface PlayProduct {
  productId: string; tokens: number; pricingVersion: string; redemptionPaisePerToken: number; purchasePaisePerToken: number;
  /** [HF-STD-PLAN-1] Catalogue price incl. GST (fallback only when Play reports no INR price). Null on old rows. */
  listPricePaise: number | null;
}
async function loadProduct(env: Env, productId: string): Promise<PlayProduct | null> {
  const r = await env.DB_META.prepare("SELECT * FROM hf_token_products WHERE product_id=?1 AND active=1")
    .bind(productId).first<{ product_id: string; tokens: number; pricing_version: string; list_price_paise?: number | null }>().catch(() => null);
  if (!r) return null;
  const pv = await getPricingVersion(env, r.pricing_version);
  if (!pv || !Number.isInteger(Number(r.tokens)) || Number(r.tokens) <= 0) return null;
  const lp = Number(r.list_price_paise ?? 0);
  return { productId: r.product_id, tokens: Number(r.tokens), pricingVersion: pv.id, redemptionPaisePerToken: pv.redemptionPaisePerToken, purchasePaisePerToken: pv.purchasePaisePerToken,
    listPricePaise: Number.isInteger(lp) && lp > 0 ? lp : null };
}
/** [HF-STD-PLAN-1] A rupee-wallet product: its credit comes from the price paid (÷ 1.18), not from a token count. */
export const isRupeeProduct = (p: PlayProduct): boolean => p.pricingVersion === "gp-r2";
export async function listActiveProducts(env: Env): Promise<PlayProduct[]> {
  const rows = (await env.DB_META.prepare("SELECT product_id FROM hf_token_products WHERE active=1 ORDER BY tokens ASC, product_id ASC").all<{ product_id: string }>().catch(() => ({ results: [] as { product_id: string }[] }))).results ?? [];
  const out: PlayProduct[] = [];
  for (const r of rows) { const p = await loadProduct(env, r.product_id); if (p) out.push(p); }
  return out;
}
export const productPricePaise = (p: PlayProduct): number => (isRupeeProduct(p) && p.listPricePaise ? p.listPricePaise : p.tokens * p.purchasePaisePerToken);
/** What the pack adds to the wallet, in paise (units x value): gp-r1 hf_tokens_100 = 102 x 100 = 10,200 paise = Rs 102. */
export const productCreditPaise = (p: PlayProduct, gstBps = 1800, gstInclusive = true): number =>
  isRupeeProduct(p) ? topupSplit(productPricePaise(p), gstBps, gstInclusive).walletPaise : p.tokens * p.redemptionPaisePerToken;

export interface PlayPricingSnapshot {
  version: 1; product: PlayProduct; gstBps: number; gstInclusive: boolean;
}
const snapshotJson = (s: PlayPricingSnapshot): string => JSON.stringify(s);
function parsePricingSnapshot(raw: string | null | undefined, productId: string): PlayPricingSnapshot | null {
  try {
    const s = JSON.parse(raw ?? "") as PlayPricingSnapshot;
    const p = s?.product;
    if (s?.version !== 1 || p?.productId !== productId || !validProductId(p.productId) || !VERSION_RE.test(p.pricingVersion)) return null;
    if (![p.tokens, p.redemptionPaisePerToken, p.purchasePaisePerToken].every((n) => Number.isSafeInteger(n) && n > 0)) return null;
    if (p.listPricePaise != null && (!Number.isSafeInteger(p.listPricePaise) || p.listPricePaise <= 0)) return null;
    if (!Number.isInteger(s.gstBps) || s.gstBps < 0 || s.gstBps > 5000 || typeof s.gstInclusive !== "boolean") return null;
    return s;
  } catch { return null; }
}
const VERSION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Freeze the exact product/GST contract selected by prepare; later flag/catalogue changes cannot reinterpret it. */
export async function rememberPreparedProduct(env: Env, uid: string, product: PlayProduct, gstBps: number, gstInclusive: boolean): Promise<void> {
  const s: PlayPricingSnapshot = { version: 1, product, gstBps, gstInclusive };
  await env.DB_META.prepare(
    "INSERT INTO hf_play_prepare_snapshots (id,uid,product_id,pricing_snapshot,prepared_at) VALUES (?1,?2,?3,?4,?5)",
  ).bind(crypto.randomUUID(), uid, product.productId, snapshotJson(s), Date.now()).run();
}
async function preparedSnapshot(env: Env, uid: string, productId: string, purchasedAt: unknown): Promise<PlayPricingSnapshot | null> {
  const when = Number(purchasedAt);
  const cutoff = Number.isFinite(when) && when > 0 ? Math.trunc(when) + 5 * 60_000 : Date.now();
  const r = await env.DB_META.prepare(
    "SELECT pricing_snapshot FROM hf_play_prepare_snapshots WHERE uid=?1 AND product_id=?2 AND prepared_at<=?3 ORDER BY prepared_at DESC LIMIT 1",
  ).bind(uid, productId, cutoff).first<{ pricing_snapshot: string }>().catch(() => null);
  return parsePricingSnapshot(r?.pricing_snapshot, productId);
}

// ── purchase rows ────────────────────────────────────────────────────────────
interface PurchaseRow {
  id: string; purchase_token: string; order_id: string; product_id: string; uid: string; state: string;
  price_micros: number | null; currency: string | null; lot_id: string | null; created_at: number;
  acked_at: number | null; consumed_at: number | null; refunded_at: number | null;
  pricing_snapshot: string | null;
}
const byToken = (env: Env, t: string) => env.DB_META.prepare("SELECT * FROM hf_play_purchases WHERE purchase_token=?1").bind(t).first<PurchaseRow>();
const byOrder = (env: Env, o: string) => env.DB_META.prepare("SELECT * FROM hf_play_purchases WHERE order_id=?1").bind(o).first<PurchaseRow>();

async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const trimRaw = (p: PlayProductFull): string =>
  JSON.stringify({ orderId: p.orderId, purchaseState: p.purchaseState, consumptionState: p.consumptionState, acknowledgementState: p.acknowledgementState, priceAmountMicros: p.priceAmountMicros, currency: p.priceCurrencyCode, purchaseTimeMillis: p.purchaseTimeMillis }).slice(0, 1000);

// ── acknowledge + consume ────────────────────────────────────────────────────
/**
 * Acknowledge then consume one credited purchase. Returns true when it ends consumed. Any failure leaves the row `credited` (the credit
 * stands) and the cron retries. `play` = a fresh purchases.products.get result when the caller has one.
 */
export async function ackAndConsume(env: Env, packageId: string, row: { purchase_token: string; product_id: string }, play?: PlayProductFull): Promise<boolean> {
  const pl = play ?? (await verifyPlayProductFor(env, packageId, row.product_id, row.purchase_token));
  if (!pl.ok || pl.purchaseState !== 0) return false;
  const now = Date.now();
  if (pl.acknowledgementState !== 1 && pl.consumptionState !== 1) {
    const a = await acknowledgeProductFor(env, packageId, row.product_id, row.purchase_token);
    if (!a.ok) return false;
    await env.DB_META.prepare("UPDATE hf_play_purchases SET acked_at=COALESCE(acked_at,?2) WHERE purchase_token=?1").bind(row.purchase_token, now).run();
  }
  if (pl.consumptionState !== 1) {
    const c = await consumeProductFor(env, packageId, row.product_id, row.purchase_token);
    if (!c.ok) return false;
  }
  await env.DB_META.prepare("UPDATE hf_play_purchases SET state='consumed', consumed_at=?2, acked_at=COALESCE(acked_at,?2) WHERE purchase_token=?1 AND state='credited'")
    .bind(row.purchase_token, now).run();
  return true;
}

// ── verify + credit ──────────────────────────────────────────────────────────
export type PlayFailCode = "disabled" | "unconfigured" | "unknown_product" | "invalid_purchase" | "account_mismatch" | "unknown_account" | "no_order" | "internal" | "unavailable";
export type PlayOutcome =
  | { ok: true; status: "credited" | "consumed"; duplicate: boolean; orderId: string; productId: string; tokensMicro: number; paidPaise: number; lotId: string; uid: string;
      /** [HF-STD-PLAN-1] rupees that reached the wallet and the GST included in paidPaise. */ walletPaise: number; gstPaise: number }
  | { ok: true; status: "pending" | "canceled" | "refunded"; orderId: string | null; uid: string }
  | { ok: false; code: PlayFailCode; httpStatus: number; message: string; transient: boolean };

export interface ProcessArgs { productId: string; purchaseToken: string; /** Signed-in user (verify route). Absent for notifications and cron. */ uid?: string; source: "verify" | "rtdn" | "cron" }

export async function processPlayPurchase(env: Env, cfg: HfTokenConfig, a: ProcessArgs): Promise<PlayOutcome> {
  const pkg = cfg.playPackageId;
  const row0 = await byToken(env, a.purchaseToken);
  let knownUid: string | null = a.uid ?? row0?.uid ?? null;
  const fail = async (code: PlayFailCode, httpStatus: number, message: string, transient = false): Promise<PlayOutcome> => {
    await emit(env, knownUid, "hf_token_purchase_failed", { reason: code, source: a.source, product_id: a.productId });
    return { ok: false, code, httpStatus, message, transient };
  };
  if (!cfg.enabled || cfg.provider !== "google_play") return fail("disabled", 503, "Adding money is not available right now.", false);

  if (row0 && a.uid && row0.uid !== a.uid) return fail("account_mismatch", 403, "This purchase belongs to another account.");
  if (row0 && row0.product_id !== a.productId) return fail("invalid_purchase", 400, "This purchase belongs to another pack.");

  // Already credited (verify + notification + retry all land here): same answer, never a second lot.
  if (row0 && (row0.state === "credited" || row0.state === "consumed")) {
    let consumed = row0.state === "consumed";
    if (!consumed) consumed = await ackAndConsume(env, pkg, row0);
    const lot = row0.lot_id ?? "";
    const li = await lotInfo(env, lot);
    await emit(env, row0.uid, "hf_token_purchase_verified", { tokens: li.micro / MICRO, paid_paise: li.paid, wallet_paise: li.wallet, gst_paise: li.gst, duplicate: true, source: a.source });
    return { ok: true, status: consumed ? "consumed" : "credited", duplicate: true, orderId: row0.order_id, productId: row0.product_id, tokensMicro: li.micro, paidPaise: li.paid, lotId: lot, uid: row0.uid, walletPaise: li.wallet, gstPaise: li.gst };
  }
  if (row0 && (row0.state === "refunded" || row0.state === "revoked")) return { ok: true, status: "refunded", orderId: row0.order_id, uid: row0.uid };

  // A recorded/prepared purchase owns its frozen semantics. A signed-in verify may fail unknown SKUs before Play is called; RTDN learns the
  // account only from Play, so it is allowed through and must resolve a stored prepare snapshot after account mapping.
  const recorded = parsePricingSnapshot(row0?.pricing_snapshot, a.productId);
  const preparedBeforeVerify = !recorded && a.uid ? await preparedSnapshot(env, a.uid, a.productId, Date.now()) : null;
  const catalogueProduct = recorded?.product ?? preparedBeforeVerify?.product ?? await loadProduct(env, a.productId);
  if (a.uid && !catalogueProduct) return fail("unknown_product", 400, "That pack is not available.");

  const p = await verifyPlayProductFor(env, pkg, a.productId, a.purchaseToken);
  if (!p.ok) {
    const transient = p.status === 0 || p.status >= 500 || p.status === 429;
    if (p.reason === "play_unconfigured") return fail("unconfigured", 503, "Purchases are not configured yet.", true);
    return transient ? fail("unavailable", 503, "Google Play could not be reached. Please try again.", true) : fail("invalid_purchase", 400, "Google Play does not recognise this purchase.");
  }

  // Whose purchase is it? Session user (verify) or the account map (notification / cron), always checked against Play's obfuscated id.
  const claimed = p.obfuscatedExternalAccountId;
  const uid = a.uid ?? row0?.uid ?? (await uidForHash(env, claimed));
  if (!uid) return fail("unknown_account", 200, "No account is linked to this purchase.");
  knownUid = uid;
  const expected = await accountHashFor(env, uid);
  if (!expected) return fail("unconfigured", 503, "Purchases are not configured yet.", true);
  if (!claimed || !safeEq(expected, claimed)) return fail("account_mismatch", 403, "This purchase belongs to another account.");

  // Prefer the purchase-row snapshot, then the prepare snapshot. Only an unprepared legacy/RTDN purchase falls back to the SKU's immutable
  // catalogue row plus the current GST settings. Because gp-r1 and gp-r2 have distinct SKUs, this fallback cannot change units with the flag.
  const rawCfg = (await readConfig(env).catch(() => ({}))) as unknown as Record<string, unknown>;
  const stdNow = readHfStdPlan(rawCfg);
  const prepared = recorded ?? await preparedSnapshot(env, uid, a.productId, p.purchaseTimeMillis);
  const fallbackProduct = catalogueProduct ?? prepared?.product;
  if (!prepared && !fallbackProduct) return fail("unknown_product", 400, "That pack is not available.");
  const chosen = prepared ?? {
    version: 1 as const, product: fallbackProduct!, gstBps: stdNow.gstBps, gstInclusive: stdNow.gstInclusive,
  };
  const chosenJson = snapshotJson(chosen);

  if (p.purchaseState === 2) {
    const orderId = p.orderId ?? `pending:${await sha256hex(a.purchaseToken)}`;
    await env.DB_META.prepare(
      `INSERT OR IGNORE INTO hf_play_purchases (id, purchase_token, order_id, product_id, uid, state, price_micros, currency, raw, created_at, pricing_snapshot)
       VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10)`,
    ).bind(crypto.randomUUID(), a.purchaseToken, orderId, a.productId, uid, p.priceAmountMicros ?? null, p.priceCurrencyCode ?? null, trimRaw(p), Date.now(), chosenJson).run();
    await env.DB_META.prepare("UPDATE hf_play_purchases SET pricing_snapshot=COALESCE(pricing_snapshot,?2) WHERE purchase_token=?1 AND uid=?3")
      .bind(a.purchaseToken, chosenJson, uid).run();
    return { ok: true, status: "pending", orderId, uid };
  }
  if (p.purchaseState !== 0) {
    if (row0?.state === "pending") await env.DB_META.prepare("UPDATE hf_play_purchases SET state='revoked', refunded_at=?2 WHERE purchase_token=?1 AND state='pending'").bind(a.purchaseToken, Date.now()).run();
    return { ok: true, status: "canceled", orderId: p.orderId ?? row0?.order_id ?? null, uid };
  }
  if (!p.orderId) return fail("no_order", 502, "Google Play did not return an order id.", true);
  const orderId = p.orderId;

  const db = env.DB_META;
  try {
    await db.batch([
      db.prepare("UPDATE hf_play_purchases SET order_id=?2, state='verified', price_micros=?3, currency=?4, raw=?5, pricing_snapshot=COALESCE(pricing_snapshot,?6) WHERE purchase_token=?1 AND state='pending'")
        .bind(a.purchaseToken, orderId, p.priceAmountMicros ?? null, p.priceCurrencyCode ?? null, trimRaw(p), chosenJson),
      db.prepare(
        `INSERT OR IGNORE INTO hf_play_purchases (id, purchase_token, order_id, product_id, uid, state, price_micros, currency, raw, created_at, pricing_snapshot)
         VALUES (?1,?2,?3,?4,?5,'verified',?6,?7,?8,?9,?10)`,
      ).bind(crypto.randomUUID(), a.purchaseToken, orderId, a.productId, uid, p.priceAmountMicros ?? null, p.priceCurrencyCode ?? null, trimRaw(p), Date.now(), chosenJson),
    ]);
  } catch (e) {
    await trackException(env, e, { route: "hf_play", handled: true, app_name: APP, extra: { area: "hf_token_play", step: "insert_purchase" } });
    return fail("internal", 500, "Could not record the purchase. Please try again.", true);
  }
  const row1 = await byToken(env, a.purchaseToken);
  if (!row1 || row1.uid !== uid) return fail("account_mismatch", 403, "This purchase belongs to another account.");
  if (row1.state === "refunded" || row1.state === "revoked") return { ok: true, status: "refunded", orderId, uid };

  const frozen = parsePricingSnapshot(row1.pricing_snapshot, a.productId) ?? chosen;
  const prod = frozen.product;
  // Play's verified INR price is authoritative. The frozen catalogue price is only the unavailable-price fallback.
  const paidPaise = String(p.priceCurrencyCode ?? "").toUpperCase() === "INR" && p.priceAmountMicros && p.priceAmountMicros > 0
    ? Math.round(p.priceAmountMicros / 10_000)
    : productPricePaise(prod);
  const rupee = isRupeeProduct(prod);
  const split = rupee ? topupSplit(paidPaise, frozen.gstBps, frozen.gstInclusive) : { walletPaise: prod.tokens * prod.redemptionPaisePerToken, gstPaise: 0 };
  const micro = rupee ? paiseToMicro(split.walletPaise) : prod.tokens * MICRO;
  if (!Number.isSafeInteger(micro) || micro <= 0) return fail("internal", 500, "Bad product.");

  const credit = await creditLot(env, uid, {
    kind: "purchase", pricingVersion: prod.pricingVersion, valuePaisePerToken: rupee ? RUPEE_LOT_VALUE_PAISE : prod.redemptionPaisePerToken, micro, paidPaise,
    provider: "google_play", providerRef: orderId, note: `play:${a.source}`, gstPaise: split.gstPaise,
  }, `hfplay:${orderId}`);
  if (!credit.lotId) return fail("internal", 500, "Could not add the money to your wallet. Please try again.", true);

  const upd = await db.prepare("UPDATE hf_play_purchases SET state='credited', lot_id=?2 WHERE purchase_token=?1 AND state IN ('verified','pending')").bind(a.purchaseToken, credit.lotId).run();
  if (Number((upd as any)?.meta?.changes ?? 0) === 0) {
    const now = await byToken(env, a.purchaseToken);
    if (now && (now.state === "revoked" || now.state === "refunded")) {
      // A void landed between our check and the credit: take the lot straight back.
      await applyPlayRefund(env, orderId, "race", a.purchaseToken);
      return { ok: true, status: "refunded", orderId, uid };
    }
  }

  if (credit.applied) {
    // [HF-TOK-EXIT-1] Purchase record for /wallet; best-effort (backfill covers a miss).
    let receiptNumber: string | null = null;
    try {
      const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
      const rec = await issuePurchaseRecord(env, cfg, { id: credit.lotId, uid, tokens_granted_micro: micro, paid_paise: paidPaise, redemption_paise_per_token: rupee ? RUPEE_LOT_VALUE_PAISE : prod.redemptionPaisePerToken, provider_ref: orderId, created_at: Date.now(), pricing_version: prod.pricingVersion, gst_paise: split.gstPaise });
      receiptNumber = rec?.number ?? null;
    } catch { /* backfill */ }
    // [HF-TOPUP-NOTIFY-1] WhatsApp + email receipt, once per newly applied credit (HF-PAY-20). Never throws, never blocks the credit.
    try {
      await notifyTopupCredited(env, { uid, orderId, paidPaise, creditPaise: split.walletPaise, gstPaise: split.gstPaise, receiptNumber });
    } catch { /* best-effort */ }
    // [HF-CALL-MODES-INT] Every credit path (verify, RTDN, cron) lands here: a call in progress reserves its next chunk now. Idempotent, never throws, no-op with the chunk flag off.
    await pokeLiveCall(env, uid);
  }
  const consumed = await ackAndConsume(env, pkg, { purchase_token: a.purchaseToken, product_id: a.productId }, p);
  await emit(env, uid, "hf_token_purchase_verified", { tokens: prod.tokens, paid_paise: paidPaise, wallet_paise: split.walletPaise, gst_paise: split.gstPaise, duplicate: !credit.applied, source: a.source });
  if (!credit.applied) {
    // A concurrent path credited first: report what IT credited (same order id, one lot), never this run's numbers.
    const li = await lotInfo(env, credit.lotId);
    return { ok: true, status: consumed ? "consumed" : "credited", duplicate: true, orderId, productId: a.productId, tokensMicro: li.micro, paidPaise: li.paid, lotId: credit.lotId, uid, walletPaise: li.wallet, gstPaise: li.gst };
  }
  return { ok: true, status: consumed ? "consumed" : "credited", duplicate: false, orderId, productId: a.productId, tokensMicro: micro, paidPaise, lotId: credit.lotId, uid, walletPaise: split.walletPaise, gstPaise: split.gstPaise };
}
/** [HF-STD-PLAN-1] What a purchase lot granted: micro units, rupees paid, rupees credited to the wallet, GST included. */
async function lotInfo(env: Env, lotId: string): Promise<{ micro: number; paid: number; wallet: number; gst: number }> {
  const r = await env.DB_META.prepare("SELECT tokens_granted_micro AS m, paid_paise AS p, redemption_paise_per_token AS v, gst_paise AS g FROM hf_token_lots WHERE id=?1")
    .bind(lotId).first<{ m: number; p: number; v: number; g: number | null }>().catch(() => null);
  const micro = Number(r?.m ?? 0), v = Number(r?.v ?? 100);
  return { micro, paid: Number(r?.p ?? 0), wallet: Math.floor((micro * v) / MICRO), gst: Number(r?.g ?? 0) };
}

export interface BalanceOut {
  totalTokens: number; availableTokens: number; debtValuePaise: number; byValue: Array<{ valuePaisePerToken: number; tokens: number }>;
  /** [HF-STD-PLAN-1] the wallet in rupees */ balancePaise: number; availablePaise: number;
}
export const balanceOut = (b: BalanceSummary, standard = false): BalanceOut => ({
  balancePaise: b.totalPaise, availablePaise: b.availablePaise,
  // Legacy names remain literal token counts while Standard is OFF. Once the guarded rollout is ON, compatible clients treat them only as
  // a transitional copy of the rupee amount and use balancePaise/availablePaise as authoritative.
  totalTokens: standard ? b.totalPaise / 100 : b.totalMicro / MICRO,
  availableTokens: standard ? b.availablePaise / 100 : b.availableMicro / MICRO,
  debtValuePaise: b.debtValuePaise,
  byValue: b.byValue.map((x) => ({ valuePaisePerToken: x.valuePaisePerToken, tokens: x.micro / MICRO })),
});
export const balanceFor = async (env: Env, uid: string, standard = false): Promise<BalanceOut> => balanceOut(await balanceSummary(env, uid), standard);

// ── refund / void ────────────────────────────────────────────────────────────
export interface RefundOutcome { found: boolean; applied: boolean; duplicate: boolean; retry: boolean; removedMicro: number; debtMicro: number; debtValuePaise: number }
/**
 * Apply a Google refund / void of one purchase, once (op id `hfvoid:<orderId>`): the unspent tokens of its lot (reservation included) are
 * removed and the spent part becomes an open debt (calls blocked until the next purchase clears it). Host earnings are never touched.
 * `purchaseToken` is a fallback lookup when Google gave no order id. Exported for the EXIT agent (refund flow) and used by RTDN + cron.
 */
export async function applyPlayRefund(env: Env, orderId: string | null | undefined, source: string, purchaseToken?: string): Promise<RefundOutcome> {
  const none: RefundOutcome = { found: false, applied: false, duplicate: false, retry: false, removedMicro: 0, debtMicro: 0, debtValuePaise: 0 };
  const row = (orderId ? await byOrder(env, orderId) : null) ?? (purchaseToken ? await byToken(env, purchaseToken) : null);
  if (!row) return none;
  if (row.state === "refunded") return { ...none, found: true, duplicate: true };
  const db = env.DB_META;
  const lotId = row.lot_id ?? (await db.prepare("SELECT id FROM hf_token_lots WHERE provider='google_play' AND provider_ref=?1").bind(row.order_id).first<{ id: string }>().catch(() => null))?.id ?? null;
  const now = Date.now();
  if (!lotId) {
    // Voided before it was ever credited: make sure it never is.
    await db.prepare("UPDATE hf_play_purchases SET state='revoked', refunded_at=?2 WHERE id=?1 AND state IN ('pending','verified','revoked')").bind(row.id, now).run();
    return { ...none, found: true, applied: true };
  }
  const r = await revokeLot(env, lotId, `hfvoid:${row.order_id}`);
  const st = await db.prepare("SELECT status FROM hf_token_lots WHERE id=?1").bind(lotId).first<{ status: string }>();
  if (st?.status !== "revoked") return { ...none, found: true, retry: true }; // failed closed (a spend raced); the next sweep retries
  await db.prepare("UPDATE hf_play_purchases SET state='refunded', refunded_at=COALESCE(refunded_at,?2), lot_id=COALESCE(lot_id,?3) WHERE id=?1 AND state!='refunded'").bind(row.id, now, lotId).run();
  if (r.applied) await emit(env, row.uid, "hf_token_refund_applied", { debt_paise: r.debtValuePaise, source, removed_tokens: r.removedMicro / MICRO });
  return { found: true, applied: r.applied, duplicate: !r.applied, retry: false, removedMicro: r.removedMicro, debtMicro: r.debtMicro, debtValuePaise: r.debtValuePaise };
}

// ── real-time developer notifications ────────────────────────────────────────
interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { keys: Jwk[]; exp: number } | null = null;
export const _resetJwksCache = (): void => { jwksCache = null; };
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

async function getJwks(force: boolean): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.exp > now) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`jwks_${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  const ttl = Math.min(6 * 3600_000, Math.max(300_000, (m ? Number(m[1]) : 3600) * 1000));
  jwksCache = { keys: Array.isArray(body.keys) ? body.keys : [], exp: now + ttl };
  return jwksCache.keys;
}

export type OidcResult = { ok: true; email: string } | { ok: false; status: 401 | 503; reason: string };
/** Verify the Google-signed OIDC JWT of a Pub/Sub push request. 503 when HF_RTDN_AUDIENCE / HF_RTDN_PUSH_SA are not set (fail closed). */
export async function verifyPushJwt(env: Env, authorization: string | null): Promise<OidcResult> {
  const aud = env.HF_RTDN_AUDIENCE, sa = env.HF_RTDN_PUSH_SA;
  if (!aud || !sa) return { ok: false, status: 503, reason: "rtdn_unconfigured" };
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return { ok: false, status: 401, reason: "no_bearer" };
  const parts = m[1].split(".");
  if (parts.length !== 3) return { ok: false, status: 401, reason: "malformed" };
  let header: any, claims: any, sig: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    sig = fromB64url(parts[2]);
  } catch { return { ok: false, status: 401, reason: "malformed" }; }
  if (header?.alg !== "RS256" || typeof header?.kid !== "string") return { ok: false, status: 401, reason: "bad_alg" };
  let jwk: Jwk | undefined;
  try {
    jwk = (await getJwks(false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await getJwks(true)).find((k) => k.kid === header.kid); // key rotation: one forced refresh
  } catch { return { ok: false, status: 503, reason: "jwks_unavailable" }; }
  if (!jwk) return { ok: false, status: 401, reason: "unknown_kid" };
  let good = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { good = false; }
  if (!good) return { ok: false, status: 401, reason: "bad_signature" };
  const nowS = Math.floor(Date.now() / 1000);
  if (claims?.iss !== "accounts.google.com" && claims?.iss !== "https://accounts.google.com") return { ok: false, status: 401, reason: "bad_iss" };
  if (claims?.aud !== aud) return { ok: false, status: 401, reason: "bad_aud" };
  if (!(Number(claims?.exp) > nowS - 60)) return { ok: false, status: 401, reason: "expired" };
  if (claims?.email !== sa || claims?.email_verified === false) return { ok: false, status: 401, reason: "bad_email" };
  return { ok: true, email: claims.email };
}

export interface RtdnResult { handled: boolean; ignored?: string; transient?: boolean; detail?: string }
/** Process one decoded Pub/Sub push body ({message:{data}}). Never throws for a bad payload: unknown shapes are ignored (200). */
export async function handleRtdn(env: Env, cfg: HfTokenConfig, body: any): Promise<RtdnResult> {
  let n: any;
  try {
    const data = body?.message?.data;
    if (typeof data !== "string") return { handled: false, ignored: "no_data" };
    n = JSON.parse(new TextDecoder().decode(fromB64url(data)));
  } catch { return { handled: false, ignored: "bad_payload" }; }
  if (n?.testNotification) return { handled: false, ignored: "test" };
  if (typeof n?.packageName === "string" && n.packageName !== cfg.playPackageId) return { handled: false, ignored: "other_package" };

  const one = n?.oneTimeProductNotification;
  if (one) {
    const token = one.purchaseToken, sku = one.sku;
    if (!validPurchaseToken(token) || !validProductId(sku)) return { handled: false, ignored: "bad_fields" };
    if (one.notificationType === 1) {
      const r = await processPlayPurchase(env, cfg, { productId: sku, purchaseToken: token, source: "rtdn" });
      if (!r.ok) return { handled: false, ignored: r.code, transient: r.transient, detail: r.message };
      return { handled: true, detail: r.status };
    }
    if (one.notificationType === 2) {
      const row = await byToken(env, token);
      if (row?.state === "pending") await env.DB_META.prepare("UPDATE hf_play_purchases SET state='revoked', refunded_at=?2 WHERE purchase_token=?1 AND state='pending'").bind(token, Date.now()).run();
      return { handled: true, detail: "canceled" };
    }
    return { handled: false, ignored: "type" };
  }
  const v = n?.voidedPurchaseNotification;
  if (v) {
    if (v.productType === 2) return { handled: false, ignored: "subscription" };
    const orderId = typeof v.orderId === "string" ? v.orderId : null;
    const token = typeof v.purchaseToken === "string" ? v.purchaseToken : undefined;
    const r = await applyPlayRefund(env, orderId, "rtdn", token);
    if (!r.found) return { handled: false, ignored: "unknown_order" };
    return { handled: true, transient: r.retry, detail: r.duplicate ? "duplicate" : "refunded" };
  }
  return { handled: false, ignored: "unknown_notification" };
}

// ── cron ─────────────────────────────────────────────────────────────────────
export interface PlayCronResult { consumeRetried: number; consumed: number; rechecked: number; voidedScanned: number; refundsApplied: number; swept: boolean }
/**
 * (a) retry acknowledge + consume for credited rows older than 5 minutes (Google refunds unacknowledged purchases after 3 days),
 * (c) re-check pending / half-credited (verified) purchases, (b) voidedpurchases sweep (at most about hourly) since the stored cursor.
 * Runs whenever a service account exists and at least one Play purchase row exists; refunds and acknowledgements are never skipped
 * because the token flag is off, but a pending purchase is only credited while hfTokensEnabled is on.
 */
export async function runPlayCron(env: Env, cfg: HfTokenConfig, now = Date.now()): Promise<PlayCronResult> {
  const out: PlayCronResult = { consumeRetried: 0, consumed: 0, rechecked: 0, voidedScanned: 0, refundsApplied: 0, swept: false };
  if (cfg.provider !== "google_play" || !(env as any).PLAY_SERVICE_ACCOUNT_JSON) return out;
  const db = env.DB_META;
  const any = await db.prepare("SELECT 1 AS x FROM hf_play_purchases LIMIT 1").first().catch(() => null);
  if (!any) return out;

  const stale = (await db.prepare("SELECT * FROM hf_play_purchases WHERE state='credited' AND created_at<?1 ORDER BY created_at ASC LIMIT 25").bind(now - CONSUME_RETRY_AFTER_MS).all<PurchaseRow>()).results ?? [];
  for (const r of stale) {
    out.consumeRetried++;
    if (await ackAndConsume(env, cfg.playPackageId, r).catch(() => false)) out.consumed++;
  }

  const open = (await db.prepare("SELECT * FROM hf_play_purchases WHERE state IN ('pending','verified') AND created_at<?1 AND created_at>?2 ORDER BY created_at ASC LIMIT 20").bind(now - 60_000, now - 5 * DAY).all<PurchaseRow>()).results ?? [];
  for (const r of open) {
    out.rechecked++;
    await processPlayPurchase(env, cfg, { productId: r.product_id, purchaseToken: r.purchase_token, uid: r.uid, source: "cron" }).catch(() => null);
  }

  let cur: { lastRun: number; since: number } | null = null;
  try { const raw = await env.TOKENS.get(VOID_KV_KEY); if (raw) cur = JSON.parse(raw); } catch { /* start fresh */ }
  if (cur && now - cur.lastRun < VOID_SWEEP_EVERY_MS) return out;
  const oldest = await db.prepare("SELECT MIN(created_at) AS m FROM hf_play_purchases").first<{ m: number | null }>();
  const since = Math.max(now - 30 * DAY, cur?.since ?? (Number(oldest?.m ?? now) - 3_600_000));
  out.swept = true;
  let page: string | undefined, allOk = true;
  for (let i = 0; i < 10; i++) {
    const l = await listVoidedFor(env, cfg.playPackageId, since, page);
    if (!l.ok) { allOk = false; break; }
    for (const v of l.purchases) {
      out.voidedScanned++;
      const r = await applyPlayRefund(env, v.orderId ?? null, "voided_sweep", v.purchaseToken);
      if (r.applied && r.found) out.refundsApplied++;
      if (r.retry) allOk = false;
    }
    page = l.nextPageToken;
    if (!page) break;
  }
  try { await env.TOKENS.put(VOID_KV_KEY, JSON.stringify({ lastRun: now, since: allOk ? now - 3_600_000 : since })); } catch { /* retried next tick */ }
  return out;
}
