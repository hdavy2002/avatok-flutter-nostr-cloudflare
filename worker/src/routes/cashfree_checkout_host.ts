// [HF-CASHFREE-CHECKOUT-HOST-1] Cashfree production checkout only opens from a domain whitelisted in the Cashfree dashboard.
// The approved domain is avatok.ai (not the brand domain yet), so the brand-site wallet hands the buyer to a tiny page on
// avatok.ai that opens Cashfree's checkout, and Cashfree returns him to avatok.ai, which forwards him to /wallet?topup=<id>.
// Served by this Worker through the route `avatok.ai/pay/cashfree*` (wrangler.toml); the rest of avatok.ai is untouched.
//   GET https://avatok.ai/pay/cashfree?s=<payment_session_id>&t=<hftop_id>   -> page that opens the Cashfree checkout
//   GET https://avatok.ai/pay/cashfree/done?t=<hftop_id>                     -> 302 to the brand site /wallet?topup=<id>
// Nothing here moves money: crediting is still only settleHfTopup (webhook / status poll / reconcile).
// When the brand domain is whitelisted, set CHECKOUT_ORIGIN to null and the website opens the modal on its own domain again.
import type { Env } from "../types";
import { BRAND, brandUrl } from "../lib/brand";
import { cashfreeIsProduction } from "../lib/cashfree";

/** The whitelisted domain that hosts the Cashfree checkout. null = open it on the brand site itself. */
export const CASHFREE_CHECKOUT_ORIGIN: string | null = "https://avatok.ai";
const CHECKOUT_HOSTS = new Set(["avatok.ai", "www.avatok.ai"]);
const TOPUP_RE = /^hftop_[a-f0-9]{24}$/;
/** [HF-MERCH-CORE-1] A merch order is a shop order: `shp_` + 20 hex. Same hand-off page, different landing. */
const SHOP_RE = /^(?:shp|mgp)_[a-f0-9]{20}$/; // [HF-CHANNEL-CORE-1] mgp_ = a bag payment (one gateway order for several shop orders)
const SESSION_RE = /^session_[A-Za-z0-9_\-]{10,400}$/;

export const cashfreeCheckoutUrl = (sessionId: string, topupId: string): string | null =>
  CASHFREE_CHECKOUT_ORIGIN ? `${CASHFREE_CHECKOUT_ORIGIN}/pay/cashfree?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(topupId)}` : null;
export const cashfreeReturnUrl = (): string | null =>
  CASHFREE_CHECKOUT_ORIGIN ? `${CASHFREE_CHECKOUT_ORIGIN}/pay/cashfree/done?t={order_id}` : null;

/** [HF-WIRE-20] Return URL for orders started from the native app: lands on the whitelisted host, which opens the app. */
export const cashfreeAppReturnUrl = (): string | null =>
  CASHFREE_CHECKOUT_ORIGIN ? `${CASHFREE_CHECKOUT_ORIGIN}/pay/cashfree/return?t={order_id}` : null;

/** [HF-WIRE-20] The app's own scheme is the first label of the brand domain (same rule as hf-flutter/android/app/build.gradle.kts). */
const APP_SCHEME = BRAND.domain.split(".")[0];

/** intent:// URL that opens the HF app on its top-up screen; falls back to the website wallet if the app is not installed. */
export function appReturnIntent(topupId: string): string {
  const fallback = encodeURIComponent(walletUrl(topupId));
  const path = SHOP_RE.test(topupId) ? `orders/${topupId}` : `wallet/topup/${topupId}`; // [HF-MERCH-CORE-1]
  return `intent://${path}#Intent;scheme=${APP_SCHEME};package=${BRAND.hfPlayPackageId};S.browser_fallback_url=${fallback};end`;
}

function appReturnPage(topupId: string, android: boolean): Response {
  const intent = android ? appReturnIntent(topupId) : "";
  const web = walletUrl(topupId);
  // The payer already paid at this point; the page only needs to say so and hand him back. Never claims the wallet is credited (the server confirms that).
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Payment received</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#fffdf7;color:#46113e}
main{max-width:420px;padding:24px;text-align:center}a.b{display:inline-block;margin:12px 0;padding:14px 22px;border-radius:12px;background:#f5a623;color:#46113e;font-weight:700;text-decoration:none}a{color:#46113e}</style></head>
<body><main><h1 style="font-size:22px;margin:0 0 8px">Payment received</h1>
<p>Go back to the app. Your wallet updates in a few seconds.</p>
${android ? `<p><a class="b" href="${intent}">Open the app</a></p>` : ""}
<p><a href="${web}">Or see your wallet on the website</a></p></main>
${android ? `<script>setTimeout(function(){location.replace(${JSON.stringify(intent)});},50);</script>` : ""}
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

const walletUrl = (topupId: string | null) => brandUrl(topupId && /^mgp_[a-f0-9]{20}$/.test(topupId) ? `/dashboard/orders?group=${topupId}` : topupId && SHOP_RE.test(topupId) ? `/dashboard/orders?order=${topupId}` : topupId && TOPUP_RE.test(topupId) ? `/wallet?topup=${topupId}` : "/wallet");

function page(env: Env, session: string, topupId: string): Response {
  const mode = cashfreeIsProduction(env) ? "production" : "sandbox";
  const back = walletUrl(topupId);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="origin"><title>Secure payment</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#fffdf7;color:#46113e}
main{max-width:420px;padding:24px;text-align:center}a{color:#46113e}</style></head>
<body><main><p id="m">Opening the secure Cashfree payment page…</p><p><a href="${back}">Go back to your wallet</a></p></main>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<script>
(function(){
  var m=document.getElementById("m");
  try{
    if(!window.Cashfree){m.textContent="The payment page could not load. Please check your internet and go back to try again.";return;}
    window.Cashfree({mode:${JSON.stringify(mode)}}).checkout({paymentSessionId:${JSON.stringify(session)},redirectTarget:"_self"})
      .then(function(r){ if(r&&r.error){m.textContent="Payment could not start: "+(r.error.message||"please go back and try again.");} });
  }catch(e){m.textContent="Payment could not start. Please go back and try again.";}
})();
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

/** Returns a Response for avatok.ai/pay/cashfree*, or null for anything else (falls through to the normal router). */
export function cashfreeCheckoutHost(req: Request, env: Env): Response | null {
  const url = new URL(req.url);
  if (!CHECKOUT_HOSTS.has(url.hostname) || !url.pathname.startsWith("/pay/cashfree")) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const t = url.searchParams.get("t") ?? "";
  if (url.pathname === "/pay/cashfree/done") return Response.redirect(walletUrl(t), 302);
  // [HF-WIRE-20] Return page for orders started in the native app: Android -> back into the app; anything else -> a plain "go back to the app" note.
  if (url.pathname === "/pay/cashfree/return") {
    if (!TOPUP_RE.test(t) && !SHOP_RE.test(t)) return Response.redirect(walletUrl(null), 302);
    return appReturnPage(t, /android/i.test(req.headers.get("user-agent") ?? ""));
  }
  if (url.pathname === "/pay/cashfree") {
    const s = url.searchParams.get("s") ?? "";
    if (!SESSION_RE.test(s) || !(TOPUP_RE.test(t) || SHOP_RE.test(t))) return Response.redirect(walletUrl(null), 302);
    return page(env, s, t);
  }
  return Response.redirect(walletUrl(null), 302);
}
