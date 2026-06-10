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
import { requireUser, isFail } from "../authz";
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";
import { withIdempotency, rateLimit, RL } from "../money";
import { acctUser, sendReceipt } from "../ledger";

const COIN_CENTS = 1;            // 1 AvaCoin = $0.01
const MIN_TOPUP = 50, MAX_TOPUP = 50_000; // any amount ≥ Stripe's $0.50 floor, ≤ $500

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
  const debit = await walletOp(env, buyer, { op: "spend", uid: buyer, amount, app_name: app, counterparty_npub: seller, ref });
  if (debit.status !== 200) return { ok: false, status: debit.status, body: debit.body, sellerNet: 0, commission: 0 };
  const rate = commissionOverride ?? await commissionRate(env, app);
  const commission = Math.round(amount * rate);
  const sellerNet = amount - commission;
  await walletOp(env, seller, { op: "earn", uid: seller, amount: sellerNet, commission, app_name: app, counterparty_npub: buyer, ref });
  return { ok: true, status: 200, body: debit.body, sellerNet, commission };
}

function topupEnabled(env: Env): boolean {
  return env.WALLET_TOPUP_ENABLED === "1" && !!env.STRIPE_SECRET_KEY; // legal gate + creds
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
  if (!(amount >= MIN_TOPUP && amount <= MAX_TOPUP)) return json({ error: `amount must be ${MIN_TOPUP}..${MAX_TOPUP} cents` }, 400);

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
  form.set("metadata[uid]", uid);
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
    "INSERT INTO topup_records (id, uid, stripe_session_id, amount_coins, amount_cents, currency, status, created_at) VALUES (?1,?2,?3,?4,?5,'usd','pending',?6)",
  ).bind(id, uid, session.id, amount, cents, Date.now()).run();
  track(env, uid, "wallet_topup_initiated", "avawallet", { amount, cents });
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
  const uid = s.metadata?.uid; const coins = Math.trunc(Number(s.metadata?.coins || 0));
  const topupId = s.metadata?.topup_id;
  if (!uid || !(coins > 0)) return json({ received: true });

  // Security + idempotency: only credit a top-up THIS user actually initiated and
  // that is still pending. No record → ignore (prevents forged-webhook free coins
  // when no signing secret is configured). Already-paid → idempotent no-op.
  const rec = await env.DB_WALLET.prepare("SELECT status, amount_coins FROM topup_records WHERE id=?1 AND uid=?2")
    .bind(topupId, uid).first<{ status: string; amount_coins: number }>();
  if (!rec) return json({ received: true, ignored: "no matching topup record" });
  if (rec.status !== "pending") return json({ received: true, duplicate: true });
  if (rec.amount_coins !== coins) return json({ received: true, ignored: "amount mismatch" });

  // Credit via WalletDO with a deterministic op_id — the DO dedupes AND emits the
  // double-entry ledger row (external:stripe → user) to Q_WALLET. The Stripe
  // payment-intent id rides in `ref` (unique-indexed on type='topup' in D1).
  const pi = (typeof s.payment_intent === "string" && s.payment_intent) || s.id || topupId;
  await walletOp(env, uid, {
    op: "credit", uid, amount: coins, type: "topup", app_name: "avawallet", ref: pi, op_id: `topup:${topupId}`,
    ledger: { debit: "external:stripe", credit: acctUser(uid), type: "topup", ref: pi, meta: JSON.stringify({ title: `Top-up ${coins} AvaCoins`, cents: coins * COIN_CENTS, session: s.id }) },
  });
  await env.DB_WALLET.prepare("UPDATE topup_records SET status='paid', paid_at=?2 WHERE id=?1").bind(topupId, Date.now()).run();
  // A4: top-up receipt (best-effort, never blocks the credit).
  try { await sendReceipt(env, uid, "topup", { orderId: topupId, title: `${coins} AvaCoins`, lines: [{ label: `${coins} AvaCoins`, amount: coins }], total: coins }); } catch { /* best-effort */ }
  brainFact(env, uid, "wallet_topup", "avawallet", { coins });
  try { await notifyUser(env, uid, { type: "wallet", title: `Added ${coins} AvaCoins`, data: { deeplink: "/wallet", amount: coins } }); } catch { /* best-effort */ }
  track(env, uid, "wallet_topup_completed", "avawallet", { coins });
  return json({ received: true, credited: coins });
}

// POST /api/wallet/spend { amount, app_name, to_npub, ref }
export async function walletSpend(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const amount = Math.trunc(Number(b.amount));
  const app = String(b.app_name || "avawallet");
  if (!(amount > 0)) return json({ error: "amount>0 required" }, 400);

  // 1. Debit the buyer atomically.
  const debit = await walletOp(env, ctx.uid, { op: "spend", uid: ctx.uid, amount, app_name: app, counterparty_npub: b.to_npub ?? null, ref: b.ref ?? null });
  if (debit.status !== 200) return json(debit.body, debit.status);

  // 2. Credit the creator minus commission, into a 7-day hold.
  let creatorNet = 0, commission = 0;
  if (b.to_npub) {
    const rate = await commissionRate(env, app);
    commission = Math.round(amount * rate);
    creatorNet = amount - commission;
    await walletOp(env, b.to_npub, { op: "earn", uid: b.to_npub, amount: creatorNet, commission, app_name: app, counterparty_npub: ctx.uid, ref: b.ref ?? null });
    brainFact(env, b.to_npub, "wallet_earned", app, { amount: creatorNet, from: "spend" });
    try { await notifyUser(env, b.to_npub, { type: "wallet", title: `Earned ${creatorNet} AvaCoins`, body: "Available after a 7-day hold.", data: { deeplink: "/wallet", amount: creatorNet } }); } catch { /* best-effort */ }
  }

  brainFact(env, ctx.uid, "wallet_spent", app, { amount });
  track(env, ctx.uid, "wallet_spend", app, { amount, commission, creator_net: creatorNet });
  metric(env, "wallet_spend", [amount, commission]);
  return json({ ok: true, spent: amount, balance: debit.body.balance, creator_net: creatorNet, commission });
}

export async function walletBalance(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const r = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
  return json(r.body, r.status);
}

export async function walletTransactions(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    "SELECT id, type, amount, balance_after, app_name, counterparty_npub, commission, ref, created_at FROM wallet_transactions WHERE uid=?1 ORDER BY created_at DESC LIMIT 100",
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
