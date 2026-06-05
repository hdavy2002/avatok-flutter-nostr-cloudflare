// AvaWallet routes (Phase 2, §10.1). Balance math is delegated to the per-user
// WalletDO; D1 (avatok-wallet) is the audit trail / history. Top-up via Stripe is
// FLAG-GATED OFF in production pending legal (WALLET_TOPUP_ENABLED).
//
//   POST /api/wallet/topup        → create a Stripe Checkout session (flag-gated)
//   POST /webhooks/stripe         → credit coins on checkout.session.completed
//   POST /api/wallet/spend        → debit buyer, credit creator (−commission, 7d hold)
//   GET  /api/wallet/balance      → live balance (from DO)
//   GET  /api/wallet/transactions → ledger history (from D1)
//   GET  /api/wallet/earnings     → holds + released (from D1)
//   GET  /api/wallet/live         → WebSocket balance stream (DO)
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr } from "../auth";
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";

const COIN_CENTS = 1;            // 1 AvaCoin = $0.01
const MIN_TOPUP = 100, MAX_TOPUP = 50_000; // §10.1 free-form 100..50,000

function walletStub(env: Env, npub: string) {
  return env.WALLET_DO.get(env.WALLET_DO.idFromName(npub));
}
async function walletOp(env: Env, npub: string, op: object): Promise<{ status: number; body: any }> {
  const r = await walletStub(env, npub).fetch("https://wallet/op", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function topupEnabled(env: Env): boolean {
  return env.WALLET_TOPUP_ENABLED === "1" && !!env.STRIPE_SECRET_KEY; // legal gate + creds
}

// POST /api/wallet/topup { amount }
export async function walletTopup(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const amount = Math.trunc(Number(b.amount));
  if (!(amount >= MIN_TOPUP && amount <= MAX_TOPUP)) return json({ error: `amount must be ${MIN_TOPUP}..${MAX_TOPUP} coins` }, 400);

  if (!topupEnabled(env)) {
    // Infra is built; real money-in is held pending legal (§10.1). Honest 503.
    return json({ error: "top-up unavailable", reason: "pending_legal_approval", flag: "WALLET_TOPUP_ENABLED" }, 503);
  }

  const id = crypto.randomUUID();
  const cents = amount * COIN_CENTS;
  // Stripe Checkout Session (server-side; client redirects to session.url).
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", (env.WALLET_RETURN_URL || "https://avatok.ai/wallet") + "?topup=success");
  form.set("cancel_url", (env.WALLET_RETURN_URL || "https://avatok.ai/wallet") + "?topup=cancel");
  form.set("client_reference_id", id);
  form.set("metadata[npub]", auth.npub);
  form.set("metadata[topup_id]", id);
  form.set("metadata[coins]", String(amount));
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(cents));
  form.set("line_items[0][price_data][product_data][name]", `${amount} AvaCoins`);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const session = (await res.json()) as any;
  if (!res.ok) return json({ error: "stripe error", detail: session?.error?.message }, 502);

  await env.DB_WALLET.prepare(
    "INSERT INTO topup_records (id, npub, stripe_session_id, amount_coins, amount_cents, currency, status, created_at) VALUES (?1,?2,?3,?4,?5,'usd','pending',?6)",
  ).bind(id, auth.npub, session.id, amount, cents, Date.now()).run();
  track(env, auth.npub, "wallet_topup_initiated", "avawallet", { amount, cents });
  return json({ checkout_url: session.url, session_id: session.id, topup_id: id });
}

// POST /webhooks/stripe — credit coins when a checkout completes.
export async function stripeWebhook(req: Request, env: Env): Promise<Response> {
  const payload = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (env.STRIPE_WEBHOOK_SECRET) {
    const ok = await verifyStripeSig(payload, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return json({ error: "bad signature" }, 400);
  }
  let event: any; try { event = JSON.parse(payload); } catch { return json({ error: "bad json" }, 400); }
  if (event.type !== "checkout.session.completed") return json({ received: true });

  const s = event.data?.object ?? {};
  const npub = s.metadata?.npub; const coins = Math.trunc(Number(s.metadata?.coins || 0));
  const topupId = s.metadata?.topup_id;
  if (!npub || !(coins > 0)) return json({ received: true });

  // Security + idempotency: only credit a top-up THIS user actually initiated and
  // that is still pending. No record → ignore (prevents forged-webhook free coins
  // when no signing secret is configured). Already-paid → idempotent no-op.
  const rec = await env.DB_WALLET.prepare("SELECT status, amount_coins FROM topup_records WHERE id=?1 AND npub=?2")
    .bind(topupId, npub).first<{ status: string; amount_coins: number }>();
  if (!rec) return json({ received: true, ignored: "no matching topup record" });
  if (rec.status !== "pending") return json({ received: true, duplicate: true });
  if (rec.amount_coins !== coins) return json({ received: true, ignored: "amount mismatch" });

  await walletOp(env, npub, { op: "credit", npub, amount: coins, type: "topup", app_name: "avawallet", ref: topupId });
  await env.DB_WALLET.prepare("UPDATE topup_records SET status='paid', paid_at=?2 WHERE id=?1").bind(topupId, Date.now()).run();
  brainFact(env, npub, "wallet_topup", "avawallet", { coins });
  try { await notifyUser(env, npub, { type: "wallet", title: `Added ${coins} AvaCoins`, data: { deeplink: "/wallet", amount: coins } }); } catch { /* best-effort */ }
  track(env, npub, "wallet_topup_completed", "avawallet", { coins });
  return json({ received: true, credited: coins });
}

// POST /api/wallet/spend { amount, app_name, to_npub, ref }
export async function walletSpend(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const amount = Math.trunc(Number(b.amount));
  const app = String(b.app_name || "avawallet");
  if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);

  // 1. Debit the buyer atomically.
  const debit = await walletOp(env, auth.npub, { op: "spend", npub: auth.npub, amount, app_name: app, counterparty_npub: b.to_npub ?? null, ref: b.ref ?? null });
  if (debit.status !== 200) return json(debit.body, debit.status);

  // 2. Credit the creator minus commission, into a 7-day hold.
  let creatorNet = 0, commission = 0;
  if (b.to_npub) {
    const rate = await commissionRate(env, app);
    commission = Math.round(amount * rate);
    creatorNet = amount - commission;
    await walletOp(env, b.to_npub, { op: "earn", npub: b.to_npub, amount: creatorNet, commission, app_name: app, counterparty_npub: auth.npub, ref: b.ref ?? null });
    brainFact(env, b.to_npub, "wallet_earned", app, { amount: creatorNet, from: "spend" });
    try { await notifyUser(env, b.to_npub, { type: "wallet", title: `Earned ${creatorNet} AvaCoins`, body: "Available after a 7-day hold.", data: { deeplink: "/wallet", amount: creatorNet } }); } catch { /* best-effort */ }
  }

  brainFact(env, auth.npub, "wallet_spent", app, { amount });
  track(env, auth.npub, "wallet_spend", app, { amount, commission, creator_net: creatorNet });
  metric(env, "wallet_spend", [amount, commission]);
  return json({ ok: true, spent: amount, balance: debit.body.balance, creator_net: creatorNet, commission });
}

export async function walletBalance(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const r = await walletOp(env, auth.npub, { op: "balance", npub: auth.npub });
  return json(r.body, r.status);
}

export async function walletTransactions(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    "SELECT id, type, amount, balance_after, app_name, counterparty_npub, commission, ref, created_at FROM wallet_transactions WHERE npub=?1 ORDER BY created_at DESC LIMIT 100",
  ).bind(auth.npub).all();
  return json({ transactions: rs.results ?? [] });
}

export async function walletEarnings(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const now = Date.now();
  const held = await env.DB_WALLET.prepare(
    "SELECT COALESCE(SUM(amount),0) AS held FROM earning_holds WHERE npub=?1 AND released=0 AND available_at>?2",
  ).bind(auth.npub, now).first<{ held: number }>();
  const matured = await env.DB_WALLET.prepare(
    "SELECT COALESCE(SUM(amount),0) AS matured FROM earning_holds WHERE npub=?1 AND released=1",
  ).bind(auth.npub).first<{ matured: number }>();
  const upcoming = await env.DB_WALLET.prepare(
    "SELECT amount, available_at FROM earning_holds WHERE npub=?1 AND released=0 ORDER BY available_at ASC LIMIT 20",
  ).bind(auth.npub).all();
  return json({ held: held?.held ?? 0, released_total: matured?.matured ?? 0, upcoming: upcoming.results ?? [] });
}

// GET /api/wallet/live — WebSocket balance stream (auth via query: the DO needs the npub).
export async function walletLive(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  return walletStub(env, auth.npub).fetch("https://wallet/ws", req);
}

async function commissionRate(env: Env, app: string): Promise<number> {
  const r = await env.DB_WALLET.prepare("SELECT rate FROM commission_rates WHERE app_name=?1").bind(app).first<{ rate: number }>();
  return r?.rate ?? 0.20; // sane default
}

// Stripe webhook signature (HMAC-SHA256 over `${t}.${payload}`).
async function verifyStripeSig(payload: string, header: string | null, secret: string): Promise<boolean> {
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
