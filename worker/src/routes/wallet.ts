// AvaWallet routes (Phase 2, §10.1). Balance math is delegated to the per-user
// WalletDO; D1 (avatok-wallet) is the audit trail / history. Top-up via Stripe is
// FLAG-GATED OFF in production pending legal (WALLET_TOPUP_ENABLED).
//
//   POST /api/wallet/topup        → create a Stripe Checkout session (flag-gated, legacy/web)
//   POST /api/wallet/topup/intent → create a Stripe PaymentIntent for the in-app
//                                   PaymentSheet (no browser redirect, native UI)
//   POST /webhooks/stripe         → credit coins on checkout.session.completed
//                                   OR payment_intent.succeeded (in-app top-ups)
//   POST /api/wallet/spend        → debit buyer, credit creator (−commission, 7d hold)
//   GET  /api/wallet/balance      → live balance (from DO)
//   GET  /api/wallet/transactions → ledger history (from D1)
//   GET  /api/wallet/earnings     → holds + released (from D1)
//   GET  /api/wallet/live         → WebSocket balance stream (DO)
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track } from "../hooks";
import { brainIngest } from "../lib/brain_ingest";
import { notifyUser } from "../notify";
import { withIdempotency, rateLimit, RL } from "../money";
import { acctUser, sendReceipt } from "../ledger";
import { payAffiliateOnTopup } from "./affiliate";
import { readConfig } from "./config";
import { getSub } from "./plans";
import { subscribeWebhookEvent } from "./subscribe";
import { verifyPlayProduct } from "../play";

// Token economics — CANONICAL, site-wide (incl. AvaPayout): 1 USD = 100 tokens,
// i.e. 1 token = $0.01. So 1 token == 1 USD cent and usdCentsForTokens is identity.
// AvaPayout (routes/payout.ts) already converts tokens→USD at this same rate.
// NOTE: this is a RENAME of the old "coins" unit at the SAME value (100/USD), so
// stored balances are unchanged. Internal D1 columns (amount_coins), Stripe
// `metadata[coins]`, and analytics prop keys keep their legacy names to protect
// live balances / in-flight payments / dashboards; the user-facing term is "Tokens".
const TOKENS_PER_USD = 100;
const usdCentsForTokens = (tokens: number) => Math.round((tokens * 100) / TOKENS_PER_USD); // tokens → USD cents (== tokens)
// [TOKENS-FX-1] Min lowered 500→100 tokens so the region-aware quote presets
// ($1 minimum / ₹100 minimum, both = 100 tokens) are actually payable on the
// Stripe rail. Play's own floor stays $5 (its lowest fixed product).
const MIN_TOPUP = 100, MAX_TOPUP = 50_000; // in TOKENS: $1 (= ₹100) .. $500

function walletStub(env: Env, uid: string) {
  return env.WALLET_DO.get(env.WALLET_DO.idFromName(uid));
}
export async function walletOp(env: Env, uid: string, op: object): Promise<{ status: number; body: any }> {
  const r = await walletStub(env, uid).fetch("https://wallet/op", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Look up an app's commission rate (0..1); 0.20 default. */
export async function commissionRate(env: Env, app: string): Promise<number> {
  const r = await env.DB_WALLET.prepare("SELECT rate FROM commission_rates WHERE app_name=?1").bind(app).first<{ rate: number }>();
  return r?.rate ?? 0.20;
}

/**
 * Atomic coin transfer used by AvaOLX + AvaCalendar: debit buyer, credit seller
 * (minus `commissionOverride` if given, else the app rate) into a 7-day hold.
 * Returns { ok, status, buyerBalance, sellerNet, commission } or an error body.
 */
export async function transferCoins(
  env: Env,
  buyer: string,
  seller: string,
  amount: number,
  app: string,
  ref: string,
  commissionOverride?: number,
): Promise<{ ok: boolean; status: number; body: any; sellerNet: number; commission: number }> {
  const debit = await walletOp(env, buyer, { op: "spend", uid: buyer, amount, app_name: app, counterparty_uid: seller, ref });
  if (debit.status !== 200) return { ok: false, status: debit.status, body: debit.body, sellerNet: 0, commission: 0 };
  const rate = commissionOverride ?? await commissionRate(env, app);
  const commission = Math.round(amount * rate);
  const sellerNet = amount - commission;
  await walletOp(env, seller, { op: "earn", uid: seller, amount: sellerNet, commission, app_name: app, counterparty_uid: buyer, ref });
  return { ok: true, status: 200, body: debit.body, sellerNet, commission };
}

// [AVA-CAMP-B1-WALLET] Thin exports for the outbound-campaign escrow ops (Specs/
// OUTBOUND-AI-CALLING-CAMPAIGNS.md §2/§5), mirroring `transferCoins` above.
// CampaignDO/VobizAgentRoom call these instead of building the walletOp() body
// by hand. The DO exposes "release_reservation" (not "release") to avoid
// colliding with the pre-existing hold-release op of the same name.
export async function walletReserve(
  env: Env, uid: string, amount: number, ref: string, opId: string,
): Promise<{ ok: boolean; status: number; reservedTotal?: number; available?: number; body: any }> {
  const r = await walletOp(env, uid, { op: "reserve", uid, amount, ref, op_id: opId, app_name: "campaign" });
  return { ok: r.status === 200 && r.body?.ok === true, status: r.status, reservedTotal: r.body?.reservedTotal, available: r.body?.available, body: r.body };
}

export async function walletConsumeReserved(
  env: Env, uid: string, ref: string, amount: number, opId: string,
): Promise<{ ok: boolean; status: number; consumed?: number; reservedRemaining?: number; body: any }> {
  const r = await walletOp(env, uid, { op: "consume_reserved", uid, ref, amount, op_id: opId, app_name: "campaign" });
  return { ok: r.status === 200 && r.body?.ok === true, status: r.status, consumed: r.body?.consumed, reservedRemaining: r.body?.reservedRemaining, body: r.body };
}

export async function walletReleaseReservation(
  env: Env, uid: string, ref: string, opId: string,
): Promise<{ ok: boolean; status: number; refunded?: number; body: any }> {
  const r = await walletOp(env, uid, { op: "release_reservation", uid, ref, op_id: opId, app_name: "campaign" });
  return { ok: r.status === 200 && r.body?.ok === true, status: r.status, refunded: r.body?.refunded, body: r.body };
}

function topupEnabled(env: Env): boolean {
  // Fail closed: also require the webhook signing secret. Without it, a forged
  // webhook would be the only thing between an attacker and free coins, so
  // top-ups must NOT be enableable until STRIPE_WEBHOOK_SECRET is configured.
  return env.WALLET_TOPUP_ENABLED === "1" && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET;
}

// POST /api/wallet/topup { amountUsdCents } (legacy { amount } in coins also accepted).
// Money route: requires Idempotency-Key header (A1); rate-limited 5/h (A3).
export async function walletTopup(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `topup:${ctx.uid}`, RL.topup.max, RL.topup.windowSec);
  if (limited) return limited;
  return withIdempotency(req, env, ctx.uid, () => topupCore(req, env, ctx.uid));
}

async function topupCore(req: Request, env: Env, uid: string): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as any;
  // 1 coin = 1 cent, so amountUsdCents IS the coin amount.
  const amount = Math.trunc(Number(b.amountUsdCents ?? b.amount));
  if (!(amount >= MIN_TOPUP && amount <= MAX_TOPUP)) return json({ error: `amount must be ${MIN_TOPUP}..${MAX_TOPUP} tokens` }, 400);

  if (!topupEnabled(env)) {
    // Infra is built; real money-in is held pending legal (§10.1). Honest 503.
    return json({ error: "top-up unavailable", reason: "pending_legal_approval", flag: "WALLET_TOPUP_ENABLED" }, 503);
  }

  const id = crypto.randomUUID();
  const cents = usdCentsForTokens(amount);
  // Stripe Checkout Session (server-side; client redirects to session.url).
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", (env.WALLET_RETURN_URL || "https://avatok.ai/wallet") + "?topup=success");
  form.set("cancel_url", (env.WALLET_RETURN_URL || "https://avatok.ai/wallet") + "?topup=cancel");
  form.set("client_reference_id", id);
  form.set("metadata[uid]", uid);
  form.set("metadata[topup_id]", id);
  form.set("metadata[coins]", String(amount));
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(cents));
  form.set("line_items[0][price_data][product_data][name]", `${amount} Tokens`);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const session = (await res.json()) as any;
  if (!res.ok) return json({ error: "stripe error", detail: session?.error?.message }, 502);

  await env.DB_WALLET.prepare(
    "INSERT INTO topup_records (id, uid, stripe_session_id, amount_coins, amount_cents, currency, status, created_at) VALUES (?1,?2,?3,?4,?5,'usd','pending',?6)",
  ).bind(id, uid, session.id, amount, cents, Date.now()).run();
  track(env, uid, "wallet_topup_initiated", "avawallet", { amount, cents });
  return json({ checkout_url: session.url, session_id: session.id, topup_id: id });
}

// Minimal Stripe REST helper (form-encoded POST / query GET). Never throws.
async function stripeApi(
  env: Env, path: string, form?: URLSearchParams, extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(extraHeaders ?? {}),
    },
    body: form ? form.toString() : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// POST /api/wallet/topup/intent { usd_cents } — creates a Stripe PaymentIntent so
// the app can present the NATIVE in-app PaymentSheet (card / Apple Pay / Google
// Pay) with NO browser redirect. Coins are still credited server-side only, by
// the payment_intent.succeeded webhook — the client never moves money itself.
// Money route: rate-limited 5/h (A3). Client sends the real USD amount in cents;
// the server is the single source of truth for the coin conversion.
export async function walletTopupIntent(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `topup:${ctx.uid}`, RL.topup.max, RL.topup.windowSec);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  // [TOKENS-FX-1] Region-aware: the quote-driven client sends { amount_minor,
  // currency: "usd"|"inr" }; legacy { usd_cents } stays USD. INR is India's
  // FIXED price — 1 Token = ₹1 (tokens = rupees, NOT FX-converted), min ₹100.
  // USD is canonical: 1 USD = 100 Tokens. The server, never the client, decides
  // the token conversion either way.
  const currency = String(b.currency ?? "usd").toLowerCase() === "inr" ? "inr" : "usd";
  const cents = Math.trunc(Number(b.amount_minor ?? b.usd_cents ?? b.amountUsdCents)); // minor units of `currency`
  if (!(cents > 0)) return json({ error: "amount_minor required (amount in minor units)" }, 400);
  const coins = currency === "inr"
    ? Math.round(cents / 100)                       // paise → whole rupees → tokens (₹1 = 1 Token, fixed)
    : Math.round((cents * TOKENS_PER_USD) / 100);   // USD cents → tokens (1 token == 1 cent)
  if (!(coins >= MIN_TOPUP && coins <= MAX_TOPUP)) {
    return json({
      error: currency === "inr"
        ? `amount must be ₹${MIN_TOPUP}..₹${MAX_TOPUP}`
        : `amount must be $${MIN_TOPUP / TOKENS_PER_USD}..$${MAX_TOPUP / TOKENS_PER_USD}`,
    }, 400);
  }
  if (!topupEnabled(env)) {
    return json({ error: "top-up unavailable", reason: "pending_legal_approval", flag: "WALLET_TOPUP_ENABLED" }, 503);
  }

  const id = crypto.randomUUID();
  const form = new URLSearchParams();
  form.set("amount", String(cents));
  form.set("currency", currency);
  form.set("automatic_payment_methods[enabled]", "true"); // card + wallets, Stripe-managed
  form.set("description", `${coins} Tokens top-up`);
  form.set("metadata[uid]", ctx.uid);
  form.set("metadata[topup_id]", id);
  form.set("metadata[coins]", String(coins));
  const pi = await stripeApi(env, "payment_intents", form);
  if (!pi.ok) return json({ error: "stripe error", detail: pi.body?.error?.message }, 502);

  // One pending record per attempt — the PaymentIntent id rides in stripe_session_id
  // (unique-indexed) so the webhook can match THIS exact attempt.
  await env.DB_WALLET.prepare(
    // amount_cents = minor units of `currency` (USD cents, or paise for INR).
    "INSERT INTO topup_records (id, uid, stripe_session_id, amount_coins, amount_cents, currency, status, created_at) VALUES (?1,?2,?3,?4,?5,?7,'pending',?6)",
  ).bind(id, ctx.uid, pi.body.id, coins, cents, Date.now(), currency).run();
  track(env, ctx.uid, "wallet_topup_initiated", "avawallet", { coins, cents, currency, via: "payment_sheet" });
  return json({
    payment_intent_client_secret: pi.body.client_secret,
    publishable_key: env.STRIPE_PUBLISHABLE_KEY || "",
    topup_id: id, coins, cents, currency,
  });
}

// ── Google Play top-up ──────────────────────────────────────────────────────
// The client buys a FIXED-PRICE consumable (`avatok_topup_*`) via native Play
// Billing, then POSTs the purchase token here. The server maps productId→Tokens
// from THIS table (never trusts a client amount), verifies the token with the
// Play Developer API, and credits — idempotent on Google's orderId. This is the
// Android money-in rail; Stripe stays the web rail. Keep in lock-step with the
// active `avatok_topup_*` products in the Play Console.
const PLAY_TOPUP_PRODUCTS: Record<string, number> = {
  avatok_topup_5: 500,      // $5   → 500 Tokens
  avatok_topup_10: 1_000,   // $10  → 1,000
  avatok_topup_25: 2_500,   // $25  → 2,500
  avatok_topup_50: 5_000,   // $50  → 5,000
  avatok_topup_100: 10_000, // $100 → 10,000
};

// POST /api/wallet/topup/play/verify { productId, purchaseToken }
// Money route: rate-limited 5/h (A3). Fails CLOSED until the Play service account
// (PLAY_SERVICE_ACCOUNT_JSON) is configured — a forged token can never mint Tokens.
export async function walletTopupPlayVerify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  // Killable master switch (KV): independent of subscription billing.
  try {
    if (!(await readConfig(env)).playTopupEnabled) {
      return json({ ok: false, error: "top-up unavailable", reason: "play_topup_disabled" }, 503);
    }
  } catch { /* if config read fails, fall through to the service-account gate below */ }

  const limited = await rateLimit(env, `topup:${ctx.uid}`, RL.topup.max, RL.topup.windowSec);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  const productId = String(b.productId ?? "");
  const purchaseToken = String(b.purchaseToken ?? "");
  if (!productId || !purchaseToken) return json({ error: "productId and purchaseToken required" }, 400);

  // Server-side price map is the ONLY source of the credit amount.
  const coins = PLAY_TOPUP_PRODUCTS[productId];
  if (!coins) return json({ error: "unknown product" }, 400);
  if (!(coins >= MIN_TOPUP && coins <= MAX_TOPUP)) return json({ error: "amount out of range" }, 400);

  // Fail CLOSED until the service account is wired (forged token can't mint coins).
  if (!(env as any).PLAY_SERVICE_ACCOUNT_JSON) {
    return json({ ok: false, error: "play verification not configured", reason: "play_unconfigured" }, 503);
  }

  const v = await verifyPlayProduct(env, productId, purchaseToken);
  if (!v.ok) {
    track(env, ctx.uid, "wallet_topup_verify_failed", "avawallet", { source: "play", reason: v.reason });
    return json({ ok: false, error: "play verification failed", reason: v.reason }, 502);
  }
  if (!v.purchased) {
    track(env, ctx.uid, "wallet_topup_verify_rejected", "avawallet", { source: "play", state: v.purchaseState });
    return json({ ok: false, error: "purchase not completed", reason: `state_${v.purchaseState ?? "unknown"}` }, 402);
  }

  // Idempotency key = Google order id (falls back to the token if absent).
  const orderRef = v.orderId || `token:${purchaseToken.slice(0, 40)}`;
  return creditPlayTopup(env, ctx.uid, coins, orderRef, productId);
}

// Credit a verified Play top-up. Idempotent twice over: a topup_records row keyed
// on the Google orderId (stripe_session_id column, unique-indexed) short-circuits
// replays, and the WalletDO dedupes on op_id `topup:play:<orderId>` so even a
// racing double-submit credits exactly once.
async function creditPlayTopup(
  env: Env, uid: string, coins: number, orderRef: string, productId: string,
): Promise<Response> {
  const existing = await env.DB_WALLET.prepare(
    "SELECT status FROM topup_records WHERE stripe_session_id=?1 AND uid=?2",
  ).bind(orderRef, uid).first<{ status: string }>();
  if (existing) {
    const bal = await walletOp(env, uid, { op: "balance", uid });
    return json({ ok: true, duplicate: true, coins, balance: bal.body?.balance ?? null });
  }

  const id = crypto.randomUUID();
  const cents = usdCentsForTokens(coins);
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO topup_records (id, uid, stripe_session_id, amount_coins, amount_cents, currency, status, paid_at, created_at) VALUES (?1,?2,?3,?4,?5,'usd','paid',?6,?6)",
    ).bind(id, uid, orderRef, coins, cents, Date.now()).run();
  } catch {
    // UNIQUE(stripe_session_id) violation → a concurrent request already recorded
    // this order. Treat as a duplicate; the op_id dedup guarantees single credit.
    const bal = await walletOp(env, uid, { op: "balance", uid });
    return json({ ok: true, duplicate: true, coins, balance: bal.body?.balance ?? null });
  }

  const meta: any = { title: `Top-up ${coins} Tokens`, cents, source: "topup", method: "google_play", product: productId };
  const r = await walletOp(env, uid, {
    op: "credit", uid, amount: coins, type: "topup", app_name: "avawallet", ref: orderRef, op_id: `topup:play:${orderRef}`,
    ledger: { debit: "external:google_play", credit: acctUser(uid), type: "topup", ref: orderRef, meta: JSON.stringify(meta) },
  });

  try { await payAffiliateOnTopup(env, uid, coins, id); } catch { /* best-effort */ }
  try { await sendReceipt(env, uid, "topup", { orderId: id, title: `${coins} Tokens`, lines: [{ label: `${coins} Tokens`, amount: coins }], total: coins }); } catch { /* best-effort */ }
  void brainIngest(env, { uid, domain: "wallet", kind: "wallet_topup", sourceId: `play:${orderRef}`, text: `Topped up ${coins} Tokens`, meta: { coins, source: "play" } });
  try { await notifyUser(env, uid, { type: "wallet", title: `Added ${coins} Tokens`, data: { deeplink: "/wallet", amount: coins } }); } catch { /* best-effort */ }
  track(env, uid, "wallet_topup_completed", "avawallet", { coins, source: "play" });
  return json({ ok: true, credited: coins, coins, balance: r.body?.balance ?? null });
}

// POST /webhooks/stripe — credit coins when Stripe confirms a payment. Handles
// BOTH the legacy hosted Checkout (checkout.session.completed) and the in-app
// PaymentSheet (payment_intent.succeeded). Either way the credit funnels through
// `creditTopup`, which is idempotent on the topup record + a deterministic op_id.
export async function stripeWebhook(req: Request, env: Env): Promise<Response> {
  const payload = await req.text();
  const sig = req.headers.get("stripe-signature");
  // Fail closed: a missing signing secret means we cannot trust this webhook, so
  // refuse it rather than fall through (closes any unsigned "free coins" path).
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "webhook not configured" }, 503);
  const ok = await verifyStripeSig(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: "bad signature" }, 400);
  let event: any; try { event = JSON.parse(payload); } catch { return json({ error: "bad json" }, 400); }

  // Phase 1 subscriptions share this signed endpoint. Let the subscribe handler
  // claim subscription-mode checkouts + customer.subscription.* events first; it
  // returns null for everything else (e.g. one-time top-ups) so we fall through.
  const subHandled = await subscribeWebhookEvent(env, event);
  if (subHandled) return subHandled;

  if (event.type === "checkout.session.completed") {
    const s = event.data?.object ?? {};
    const ref = (typeof s.payment_intent === "string" && s.payment_intent) || s.id;
    return creditTopup(env, {
      uid: s.metadata?.uid, coins: Math.trunc(Number(s.metadata?.coins || 0)), topupId: s.metadata?.topup_id,
      ref, session: s.id, method: null, brand: null, last4: null,
    });
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data?.object ?? {};
    // The webhook PaymentIntent isn't expanded, so fetch it once to read the
    // payment method (card brand/last4 or wallet) for the receipt + log detail.
    let method: string | null = null, brand: string | null = null, last4: string | null = null;
    try {
      const full = await stripeApi(env, `payment_intents/${pi.id}?expand[]=latest_charge`);
      const pmd = full.body?.latest_charge?.payment_method_details;
      method = pmd?.type ?? null;
      const cardLike = pmd?.card ?? pmd?.[method ?? ""]?.card ?? null;
      if (cardLike) { brand = cardLike.brand ?? null; last4 = cardLike.last4 ?? null; }
    } catch { /* best-effort: method stays null, credit still proceeds */ }
    return creditTopup(env, {
      uid: pi.metadata?.uid, coins: Math.trunc(Number(pi.metadata?.coins || 0)), topupId: pi.metadata?.topup_id,
      ref: pi.id, session: null, method, brand, last4,
    });
  }

  return json({ received: true });
}

// Shared credit path for both Stripe webhook events. Idempotent: only credits a
// pending top-up THIS user initiated, matching the recorded amount; the WalletDO
// dedupes on op_id and emits the double-entry ledger row to Q_WALLET.
async function creditTopup(
  env: Env,
  p: { uid?: string; coins: number; topupId?: string; ref: string; session: string | null; method: string | null; brand: string | null; last4: string | null },
): Promise<Response> {
  const { uid, coins, topupId, ref } = p;
  if (!uid || !(coins > 0) || !topupId) return json({ received: true });

  const rec = await env.DB_WALLET.prepare("SELECT status, amount_coins FROM topup_records WHERE id=?1 AND uid=?2")
    .bind(topupId, uid).first<{ status: string; amount_coins: number }>();
  if (!rec) return json({ received: true, ignored: "no matching topup record" });
  if (rec.status !== "pending") return json({ received: true, duplicate: true });
  if (rec.amount_coins !== coins) return json({ received: true, ignored: "amount mismatch" });

  // Ledger meta drives the in-app receipt + log-detail sheet: the real USD charged,
  // and HOW it was paid (card brand/last4, Apple/Google Pay, …) so a user can see
  // "$10 paid with Visa ···4242 → 10,000 Tokens".
  const meta: any = { title: `Top-up ${coins} Tokens`, cents: usdCentsForTokens(coins), source: "topup" };
  meta.method = p.method ?? "card";
  if (p.brand) meta.card_brand = p.brand;
  if (p.last4) meta.card_last4 = p.last4;
  if (p.session) meta.session = p.session;

  await walletOp(env, uid, {
    op: "credit", uid, amount: coins, type: "topup", app_name: "avawallet", ref, op_id: `topup:${topupId}`,
    ledger: { debit: "external:stripe", credit: acctUser(uid), type: "topup", ref, meta: JSON.stringify(meta) },
  });
  await env.DB_WALLET.prepare("UPDATE topup_records SET status='paid', paid_at=?2 WHERE id=?1").bind(topupId, Date.now()).run();
  // Lifetime affiliate commission: 10% of this top-up to whoever referred the user
  // (idempotent per top-up; no-op if there's no affiliate). Never blocks the credit.
  try { await payAffiliateOnTopup(env, uid, coins, topupId); } catch { /* best-effort */ }
  // A4: top-up receipt (best-effort, never blocks the credit).
  try { await sendReceipt(env, uid, "topup", { orderId: topupId, title: `${coins} Tokens`, lines: [{ label: `${coins} Tokens`, amount: coins }], total: coins }); } catch { /* best-effort */ }
  void brainIngest(env, { uid, domain: "wallet", kind: "wallet_topup", sourceId: `stripe:${topupId}`, text: `Topped up ${coins} Tokens`, meta: { coins } });
  try { await notifyUser(env, uid, { type: "wallet", title: `Added ${coins} Tokens`, data: { deeplink: "/wallet", amount: coins } }); } catch { /* best-effort */ }
  track(env, uid, "wallet_topup_completed", "avawallet", { coins });
  return json({ received: true, credited: coins });
}

// POST /api/wallet/spend — DISABLED 2026-06-18 (financial hardening).
//
// This endpoint accepted a CLIENT-SUPPLIED `amount` (and an arbitrary `to_uid`),
// which a re-coded client could use to UNDERPAY for goods/features. No client
// flow uses it: every real purchase already goes through a dedicated,
// SERVER-PRICED endpoint where the amount is derived from server records, never
// from the request body —
//   • AvaOLX            → listing.price_coins   (routes/olx.ts)
//   • AvaBooking/Calendar → slot.price_coins    (routes/calendar.ts)
//   • AvaVision/AvaVoice → server-metered gross  (routes/avavision.ts, avavoice.ts)
//   • AvaTranslate       → server constant       (routes/translate.ts)
// The server, never the client, decides the amount. Do NOT reintroduce a
// client-amount spend route.
export async function walletSpend(_req: Request, _env: Env): Promise<Response> {
  return json({ error: "endpoint removed", reason: "purchases are priced server-side via their own endpoints" }, 410);
}

export async function walletBalance(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const r = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
  // BETA PHASE: report every user as premium so the whole client renders the
  // premium experience (sidebar "BETA PHASE" pill, no PAID badges, no upsell).
  // Read-only patch — does NOT mutate stored wallet state. Real coin balance is
  // untouched; flip betaFreePremium off in KV to restore the free/premium split.
  try {
    if (r.status === 200 && r.body && (await readConfig(env)).betaFreePremium) {
      r.body.premium = 1;
      r.body.beta = true;
    }
  } catch { /* serve the raw snapshot if config lookup fails */ }
  // Phase 1 subscriptions: echo the user's billing tier (0=Free..3=Max) so the
  // whole client renders the right plan pill/badges. premium = tier >= 1 (or the
  // beta flag above). Best-effort: a tier read failure never blocks the balance.
  try {
    if (r.status === 200 && r.body) {
      const sub = await getSub(env, ctx.uid);
      r.body.tier = sub.tier;
      r.body.tier_status = sub.status;
      r.body.tier_renews_at = sub.renewsAt;
      if (sub.tier >= 1) r.body.premium = 1;
    }
  } catch { /* tier optional — serve the snapshot without it */ }
  return json(r.body, r.status);
}

export async function walletTransactions(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    "SELECT id, type, amount, balance_after, app_name, counterparty_uid, commission, ref, created_at FROM wallet_transactions WHERE uid=?1 ORDER BY created_at DESC LIMIT 100",
  ).bind(ctx.uid).all();
  return json({ transactions: rs.results ?? [] });
}

export async function walletEarnings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const now = Date.now();
  const held = await env.DB_WALLET.prepare(
    "SELECT COALESCE(SUM(amount),0) AS held FROM earning_holds WHERE uid=?1 AND released=0 AND available_at>?2",
  ).bind(ctx.uid, now).first<{ held: number }>();
  const matured = await env.DB_WALLET.prepare(
    "SELECT COALESCE(SUM(amount),0) AS matured FROM earning_holds WHERE uid=?1 AND released=1",
  ).bind(ctx.uid).first<{ matured: number }>();
  const upcoming = await env.DB_WALLET.prepare(
    "SELECT amount, available_at FROM earning_holds WHERE uid=?1 AND released=0 ORDER BY available_at ASC LIMIT 20",
  ).bind(ctx.uid).all();
  return json({ held: held?.held ?? 0, released_total: matured?.matured ?? 0, upcoming: upcoming.results ?? [] });
}

// GET /api/wallet/live — WebSocket balance stream (auth via query: the DO needs the uid).
export async function walletLive(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return walletStub(env, ctx.uid).fetch("https://wallet/ws", req);
}

// ---------------------------------------------------------------------------
// Double-entry ledger read APIs (Phase 2). A user's statement = rows where
// their account is debit (out) or credit (in). Keyset pagination on
// (created_at, id); server-side filters: type, from, to, q (ref/meta search).
// ---------------------------------------------------------------------------

function decodeCursor(c: string | null): { t: number; id: string } | null {
  if (!c) return null;
  try {
    const [t, ...rest] = atob(c).split(":");
    return { t: Number(t), id: rest.join(":") };
  } catch { return null; }
}
const encodeCursor = (t: number, id: string) => btoa(`${t}:${id}`);

/** Shape a ledger row for the requesting account: signed amount + parsed meta. */
function shapeRow(r: any, acct: string) {
  let meta: any = null; try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { /* raw */ }
  const out = r.debit === acct;
  return {
    id: r.id, type: r.type, ref: r.ref, created_at: r.created_at,
    debit: r.debit, credit: r.credit,
    amount: out ? -Number(r.amount) : Number(r.amount), // signed for this account
    title: meta?.title ?? null, meta,
  };
}

// GET /api/wallet/ledger?cursor=&limit=50&type=&from=&to=&q=
export async function walletLedger(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const acct = acctUser(ctx.uid);
  const u = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") || 50)));
  const cur = decodeCursor(u.searchParams.get("cursor"));
  const types = (u.searchParams.get("type") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const from = Number(u.searchParams.get("from") || 0);
  const to = Number(u.searchParams.get("to") || 0);
  const q = (u.searchParams.get("q") || "").trim();

  const where: string[] = ["(debit=?1 OR credit=?1)"];
  const binds: unknown[] = [acct];
  let i = 2;
  if (cur) { where.push(`(created_at < ?${i} OR (created_at = ?${i} AND id < ?${i + 1}))`); binds.push(cur.t, cur.id); i += 2; }
  if (types.length) { where.push(`type IN (${types.map(() => `?${i++}`).join(",")})`); binds.push(...types); }
  if (from > 0) { where.push(`created_at >= ?${i++}`); binds.push(from); }
  if (to > 0) { where.push(`created_at <= ?${i++}`); binds.push(to); }
  if (q) { where.push(`(ref LIKE ?${i} OR meta LIKE ?${i})`); binds.push(`%${q}%`); i++; }

  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    `SELECT id, debit, credit, amount, type, ref, meta, created_at FROM wallet_ledger
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  track(env, ctx.uid, q || types.length || from || to ? "wallet_filter_used" : "wallet_ledger_viewed", "avawallet", { n: page.length });
  return json({
    entries: page.map((r) => shapeRow(r, acct)),
    cursor: rows.length > limit && last ? encodeCursor(Number(last.created_at), String(last.id)) : null,
  });
}

// GET /api/wallet/ledger/:id — full detail (fee breakdown, counterpart, refs).
export async function walletLedgerDetail(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const acct = acctUser(ctx.uid);
  const r = await env.DB_WALLET.prepare(
    "SELECT id, debit, credit, amount, type, ref, meta, created_at FROM wallet_ledger WHERE id=?1 AND (debit=?2 OR credit=?2)",
  ).bind(id, acct).first<any>();
  if (!r) return json({ error: "not found" }, 404);
  // Sibling rows on the same ref complete the picture (e.g. the fee row of a release).
  const siblings = r.ref
    ? ((await env.DB_WALLET.prepare("SELECT id, debit, credit, amount, type, created_at FROM wallet_ledger WHERE ref=?1 AND id<>?2 LIMIT 10").bind(r.ref, id).all()).results ?? [])
    : [];
  return json({ entry: shapeRow(r, acct), related: siblings });
}

// POST /api/wallet/ledger/:id/receipt — "Email me this receipt" (A4 re-send).
export async function walletReceiptResend(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const acct = acctUser(ctx.uid);
  const r = await env.DB_WALLET.prepare(
    "SELECT id, debit, credit, amount, type, ref, meta, created_at FROM wallet_ledger WHERE id=?1 AND (debit=?2 OR credit=?2)",
  ).bind(id, acct).first<any>();
  if (!r) return json({ error: "not found" }, 404);
  let meta: any = {}; try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { /* ignore */ }
  const title = meta?.title || r.type;
  const lines = [{ label: title, amount: Number(meta?.gross ?? r.amount) }];
  if (meta?.fee) lines.push({ label: "Platform fee (creator-side)", amount: -Number(meta.fee) });
  const ok = await sendReceipt(env, ctx.uid, r.type === "topup" ? "topup" : "purchase", {
    orderId: r.ref || r.id, title, lines, total: Number(r.amount), date: Number(r.created_at),
  });
  return json(ok ? { sent: true } : { sent: false, error: "no email on file or email disabled" }, ok ? 200 : 502);
}

// Stripe webhook signature (HMAC-SHA256 over `${t}.${payload}`).
export async function verifyStripeSig(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const t = parts["t"]; const v1 = parts["v1"];
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (hex.length !== v1.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
