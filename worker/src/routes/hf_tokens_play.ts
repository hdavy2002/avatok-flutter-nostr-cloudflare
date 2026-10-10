// [HF-TOK-PLAY-1] HF token purchases with Google Play Billing (server side). Contract: Specs/HF-PLAY-BILLING-RUNBOOK.md.
//   GET  /api/hf/tokens/products        public; active packs {productId, tokens, pricingVersion, redemptionPaisePerToken, purchasePaisePerToken}.
//                                       Never a display price: the app shows Play's ProductDetails price.
//   POST /api/hf/tokens/play/prepare    {productId} signed in -> {ok, obfuscatedAccountId, confirmAbovePaise, ...}
//   POST /api/hf/tokens/play/verify     {productId, purchaseToken} signed in, idempotent -> {ok, status, duplicate, orderId, tokens, balance}
//   POST /api/hf/tokens/play/rtdn       Pub/Sub push (Google-signed JWT); 401 bad JWT, 503 unconfigured, 200 handled / ignored
// verify / prepare need hfTokensEnabled && hfCheckoutProvider === 'google_play'. The cron half is runHfPlayCron (index.ts scheduled()).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { readHfTokenConfig, type HfTokenConfig } from "../lib/hf_token_config";
import { MICRO } from "../lib/hf_token_math";
import { productCreditPaise,
  accountHashFor, rememberAccount, listActiveProducts, productPricePaise, processPlayPurchase, balanceFor, emit,
  validProductId, validPurchaseToken, verifyPushJwt, handleRtdn, runPlayCron, type PlayCronResult,
} from "../lib/hf_play";

const APP = BRAND.slug;
const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => json({ error, message: message ?? error, ...extra }, status, { "cache-control": "no-store" });

async function cfgBoth(env: Env): Promise<{ raw: Record<string, unknown>; tok: HfTokenConfig }> {
  const raw = ((await readConfig(env).catch(() => ({}))) ?? {}) as Record<string, unknown>;
  return { raw, tok: readHfTokenConfig(raw as any) };
}
async function readJson(req: Request, max = 8000): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > max) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
const playOn = (c: HfTokenConfig) => c.enabled && c.provider === "google_play";

export async function hfTokensPlayRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p !== "/api/hf/tokens/products" && p !== "/api/hf/tokens/play/prepare" && p !== "/api/hf/tokens/play/verify" && p !== "/api/hf/tokens/play/rtdn") return null;
  try {
    if (p === "/api/hf/tokens/products") {
      if (req.method !== "GET") return err(405, "method_not_allowed");
      const { tok } = await cfgBoth(env);
      const products = await listActiveProducts(env);
      return json({
        ok: true, enabled: playOn(tok), provider: tok.provider, packageId: tok.playPackageId,
        products: products.map((x) => ({ productId: x.productId, tokens: x.tokens, pricingVersion: x.pricingVersion, redemptionPaisePerToken: x.redemptionPaisePerToken, purchasePaisePerToken: x.purchasePaisePerToken, creditPaise: productCreditPaise(x) })),
      }, 200, { "cache-control": "public, max-age=60" });
    }
    if (req.method !== "POST") return err(405, "method_not_allowed");

    if (p === "/api/hf/tokens/play/rtdn") return await rtdn(req, env);

    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    const { raw, tok } = await cfgBoth(env);
    if (!playOn(tok)) return err(503, "disabled", "Adding money is not available right now.");
    const b = await readJson(req);
    if (!validProductId(b.productId)) return err(400, "bad_product", "That pack is not available.");

    if (p === "/api/hf/tokens/play/prepare") {
      const lim = await rateLimit(env, `hfplayprep:${u.uid}`, 30, 3600);
      if (lim) return lim;
      const prod = (await listActiveProducts(env)).find((x) => x.productId === b.productId);
      if (!prod) return err(400, "unknown_product", "That pack is not available.");
      const hash = await accountHashFor(env, u.uid);
      if (!hash) return err(503, "unconfigured", "Purchases are not configured yet.");
      await rememberAccount(env, u.uid, hash);
      await emit(env, u.uid, "hf_token_purchase_prepared", { product_id: prod.productId, tokens: prod.tokens, estimate_paise: productPricePaise(prod) });
      return json({
        ok: true, obfuscatedAccountId: hash, productId: prod.productId, tokens: prod.tokens,
        confirmAbovePaise: Math.max(0, Math.trunc(Number(raw.hfTopupConfirmAboveRupees ?? 1000))) * 100,
      }, 200, { "cache-control": "no-store" });
    }

    // verify
    const lim = await rateLimit(env, `hfplayverify:${u.uid}`, 30, 3600);
    if (lim) return lim;
    if (!validPurchaseToken(b.purchaseToken)) return err(400, "bad_token", "That purchase could not be read.");
    const r = await processPlayPurchase(env, tok, { productId: b.productId, purchaseToken: b.purchaseToken, uid: u.uid, source: "verify" });
    if (!r.ok) return err(r.httpStatus, r.code, r.message, r.transient ? { retry: true } : {});
    const balance = await balanceFor(env, u.uid);
    if (!("tokensMicro" in r)) return json({ ok: true, status: r.status, orderId: r.orderId, balance }, 200, { "cache-control": "no-store" });
    return json({
      ok: true, status: r.status, duplicate: r.duplicate, orderId: r.orderId, productId: r.productId,
      tokens: r.tokensMicro / MICRO, paidPaise: r.paidPaise, consumed: r.status === "consumed", balance,
    }, 200, { "cache-control": "no-store" });
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_token_play" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}

async function rtdn(req: Request, env: Env): Promise<Response> {
  const auth = await verifyPushJwt(env, req.headers.get("authorization"));
  if (!auth.ok) return err(auth.status, auth.status === 503 ? "unconfigured" : "unauthorized", auth.reason);
  const { tok } = await cfgBoth(env);
  const body = await readJson(req, 64_000);
  const r = await handleRtdn(env, tok, body);
  // A transient failure (Play unreachable) answers 503 so Pub/Sub retries with backoff; everything else is 200 so it is never redelivered.
  if (r.transient) return json({ ok: false, retry: true, detail: r.detail ?? null }, 503);
  return json({ ok: true, handled: r.handled, ignored: r.ignored ?? null }, 200);
}

/** Cron entry for index.ts scheduled(). */
export async function runHfPlayCron(env: Env): Promise<PlayCronResult> {
  const { tok } = await cfgBoth(env);
  return runPlayCron(env, tok);
}
