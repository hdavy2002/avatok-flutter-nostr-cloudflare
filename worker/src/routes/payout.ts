// AvaPayout routes (Phase 4, §10.3). Creators withdraw earned coins to a bank via
// Wise. Min 1,000 coins ($10). Only SPENDABLE coins (post-7-day-hold) are
// withdrawable — enforced naturally because held coins aren't in the DO's spendable
// balance. ⚠️ PRODUCTION TRANSFERS FLAG-GATED OFF pending legal (PAYOUT_ENABLED).
//   POST /api/payout/setup     → link a bank account (→ Wise recipient)
//   GET  /api/payout/accounts  → my linked accounts
//   POST /api/payout/request   → request a withdrawal { account_id, amount_coins }
//   GET  /api/payout/status    → my recent requests
//   POST /webhooks/wise        → Wise transfer state-change callback
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr } from "../auth";
import { walletOp } from "./wallet";
import { wiseConfigured, createRecipient, createQuote, createTransfer, fundTransfer } from "../wise";
import { track, brainFact } from "../hooks";
import { notifyUser } from "../notify";

const MIN_COINS = 1000; // §10.3 minimum withdrawal ($10)

function payoutEnabled(env: Env): boolean {
  return env.PAYOUT_ENABLED === "1" && wiseConfigured(env); // legal gate + creds
}

// POST /api/payout/setup
export async function payoutSetup(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const acctNum = String(b.account_number || "");
  if (!b.account_holder || !b.ifsc || !acctNum) return json({ error: "account_holder, ifsc, account_number required" }, 400);

  const id = crypto.randomUUID();
  const now = Date.now();
  let wiseRecipientId: string | null = null;
  let status = "pending";

  if (payoutEnabled(env)) {
    try {
      const rec = await createRecipient(env, {
        currency: b.currency || "INR", accountHolderName: String(b.account_holder),
        ifsc: String(b.ifsc), accountNumber: acctNum, country: b.country || "IN",
      });
      wiseRecipientId = String(rec.id);
      status = "verified";
    } catch (e: any) {
      return json({ error: "wise recipient failed", detail: String(e?.message ?? e) }, 502);
    }
  }
  // else: store the account; recipient is created when payouts go live.

  await env.DB_WALLET.prepare(
    `INSERT INTO payout_accounts (id, npub, label, country, currency, account_holder, ifsc, account_number_last4, wise_recipient_id, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)`,
  ).bind(id, auth.npub, b.label ?? null, b.country || "IN", b.currency || "INR", String(b.account_holder), String(b.ifsc), acctNum.slice(-4), wiseRecipientId, status, now).run();

  track(env, auth.npub, "payout_account_linked", "avapayout", { status });
  return json({ ok: true, account_id: id, status, payouts_enabled: payoutEnabled(env) });
}

export async function payoutAccounts(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    "SELECT id, label, country, currency, account_number_last4, status, created_at FROM payout_accounts WHERE npub=?1 ORDER BY created_at DESC",
  ).bind(auth.npub).all();
  return json({ accounts: rs.results ?? [] });
}

// POST /api/payout/request { account_id, amount_coins }
export async function payoutRequest(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const amount = Math.trunc(Number(b.amount_coins));
  const accountId = String(b.account_id || "");
  if (!(amount >= MIN_COINS)) return json({ error: `minimum withdrawal is ${MIN_COINS} coins` }, 400);

  const acct = await env.DB_WALLET.prepare("SELECT id, wise_recipient_id, currency FROM payout_accounts WHERE id=?1 AND npub=?2")
    .bind(accountId, auth.npub).first<any>();
  if (!acct) return json({ error: "payout account not found" }, 404);

  if (!payoutEnabled(env)) {
    // Infra built; production transfers held pending legal (§10.3). Honest 503.
    return json({ error: "payouts unavailable", reason: "pending_legal_approval", flag: "PAYOUT_ENABLED" }, 503);
  }

  // 1. Debit spendable balance atomically (held earnings are excluded by design).
  const debit = await walletOp(env, auth.npub, { op: "spend", npub: auth.npub, amount, type: "payout", app_name: "avapayout", ref: accountId });
  if (debit.status !== 200) return json({ error: "insufficient spendable balance", detail: debit.body }, 402);

  const id = crypto.randomUUID();
  const cents = amount; // 1 coin = 1 cent
  const now = Date.now();
  const currency = acct.currency || "INR";
  await env.DB_WALLET.prepare(
    `INSERT INTO payout_requests (id, npub, account_id, amount_coins, amount_cents, target_currency, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,'requested',?7,?7)`,
  ).bind(id, auth.npub, accountId, amount, cents, currency, now).run();

  // 2. Wise quote → transfer → fund. On any failure, refund the coins.
  try {
    const quote = await createQuote(env, cents / 100, currency);
    const transfer = await createTransfer(env, quote.id, Number(acct.wise_recipient_id), id);
    await fundTransfer(env, transfer.id);
    await env.DB_WALLET.prepare("UPDATE payout_requests SET status='funded', wise_quote_id=?2, wise_transfer_id=?3, updated_at=?4 WHERE id=?1")
      .bind(id, quote.id, String(transfer.id), Date.now()).run();
    brainFact(env, auth.npub, "payout_requested", "avapayout", { amount, currency });
    track(env, auth.npub, "payout_requested", "avapayout", { amount });
    return json({ ok: true, payout_id: id, status: "funded", amount_coins: amount });
  } catch (e: any) {
    // Refund coins on failure.
    await walletOp(env, auth.npub, { op: "credit", npub: auth.npub, amount, type: "refund", app_name: "avapayout", ref: id });
    await env.DB_WALLET.prepare("UPDATE payout_requests SET status='failed', failure_reason=?2, updated_at=?3 WHERE id=?1")
      .bind(id, String(e?.message ?? e).slice(0, 200), Date.now()).run();
    return json({ error: "payout failed; coins refunded", detail: String(e?.message ?? e) }, 502);
  }
}

export async function payoutStatus(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    "SELECT id, account_id, amount_coins, target_currency, status, failure_reason, created_at, updated_at FROM payout_requests WHERE npub=?1 ORDER BY created_at DESC LIMIT 50",
  ).bind(auth.npub).all();
  return json({ requests: rs.results ?? [], payouts_enabled: payoutEnabled(env) });
}

// POST /webhooks/wise — transfer state change. Wise sends { data: { resource:{id}, current_state } }.
export async function wiseWebhook(req: Request, env: Env): Promise<Response> {
  const evt = (await req.json().catch(() => ({}))) as any;
  const transferId = String(evt?.data?.resource?.id ?? "");
  const stateRaw = String(evt?.data?.current_state || evt?.data?.currentState || "").toLowerCase();
  if (!transferId) return json({ received: true });

  const map: Record<string, string> = {
    outgoing_payment_sent: "completed", funds_converted: "transferred",
    bounced_back: "failed", charged_back: "failed", cancelled: "failed",
  };
  const status = map[stateRaw];
  if (!status) return json({ received: true, ignored: stateRaw });

  const reqRow = await env.DB_WALLET.prepare("SELECT id, npub, amount_coins, status FROM payout_requests WHERE wise_transfer_id=?1")
    .bind(transferId).first<any>();
  if (!reqRow) return json({ received: true, ignored: "unknown transfer" });

  await env.DB_WALLET.prepare("UPDATE payout_requests SET status=?2, updated_at=?3 WHERE id=?1").bind(reqRow.id, status, Date.now()).run();

  if (status === "failed" && reqRow.status !== "refunded") {
    await walletOp(env, reqRow.npub, { op: "credit", npub: reqRow.npub, amount: reqRow.amount_coins, type: "refund", app_name: "avapayout", ref: reqRow.id });
    await env.DB_WALLET.prepare("UPDATE payout_requests SET status='refunded' WHERE id=?1").bind(reqRow.id).run();
    try { await notifyUser(env, reqRow.npub, { type: "wallet", title: "Payout failed — refunded", data: { deeplink: "/wallet" } }); } catch { /* best-effort */ }
  } else if (status === "completed") {
    brainFact(env, reqRow.npub, "payout_completed", "avapayout", { amount: reqRow.amount_coins });
    try { await notifyUser(env, reqRow.npub, { type: "wallet", title: "Payout sent ✓", body: `${reqRow.amount_coins} coins withdrawn`, data: { deeplink: "/wallet" } }); } catch { /* best-effort */ }
  }
  return json({ received: true, status });
}
