// [HF-CASHFREE-CHECKOUT-HOST-1] Cashfree production checkout only opens from a domain whitelisted in the Cashfree dashboard.
// The approved domain is avatok.ai (not the brand domain yet), so the brand-site wallet hands the buyer to a tiny page on
// avatok.ai that opens Cashfree's checkout, and Cashfree returns him to avatok.ai, which forwards him to /wallet?topup=<id>.
// Served by this Worker through the route `avatok.ai/pay/cashfree*` (wrangler.toml); the rest of avatok.ai is untouched.
//   GET https://avatok.ai/pay/cashfree?s=<payment_session_id>&t=<hftop_id>   -> page that opens the Cashfree checkout
//   GET https://avatok.ai/pay/cashfree/done?t=<hftop_id>                     -> 302 to the brand site /wallet?topup=<id>
// Nothing here moves money: crediting is still only settleHfTopup (webhook / status poll / reconcile).
// When the brand domain is whitelisted, set CHECKOUT_ORIGIN to null and the website opens the modal on its own domain again.
import type { Env } from "../types";
import { brandUrl } from "../lib/brand";
import { cashfreeIsProduction } from "../lib/cashfree";

/** The whitelisted domain that hosts the Cashfree checkout. null = open it on the brand site itself. */
export const CASHFREE_CHECKOUT_ORIGIN: string | null = "https://avatok.ai";
const CHECKOUT_HOSTS = new Set(["avatok.ai", "www.avatok.ai"]);
const TOPUP_RE = /^hftop_[a-f0-9]{24}$/;
const SESSION_RE = /^session_[A-Za-z0-9_\-]{10,400}$/;

export const cashfreeCheckoutUrl = (sessionId: string, topupId: string): string | null =>
  CASHFREE_CHECKOUT_ORIGIN ? `${CASHFREE_CHECKOUT_ORIGIN}/pay/cashfree?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(topupId)}` : null;
export const cashfreeReturnUrl = (): string | null =>
  CASHFREE_CHECKOUT_ORIGIN ? `${CASHFREE_CHECKOUT_ORIGIN}/pay/cashfree/done?t={order_id}` : null;

const walletUrl = (topupId: string | null) => brandUrl(topupId && TOPUP_RE.test(topupId) ? `/wallet?topup=${topupId}` : "/wallet");

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
  if (url.pathname === "/pay/cashfree") {
    const s = url.searchParams.get("s") ?? "";
    if (!SESSION_RE.test(s) || !TOPUP_RE.test(t)) return Response.redirect(walletUrl(null), 302);
    return page(env, s, t);
  }
  return Response.redirect(walletUrl(null), 302);
}
