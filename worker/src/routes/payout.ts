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
import { requireUser, requireStripeKyc, isFail } from "../authz";
import { walletOp } from "./wallet";
import { wiseConfigured, createRecipient, createQuote, createTransfer, fundTransfer } from "../wise";
import { track } from "../hooks";
import { brainIngest } from "../lib/brain_ingest";
import { notifyUser } from "../notify";
import { clerkEmail } from "../ledger";
import { agreementAccepted, currentAgreementVersion } from "./kyc";

const MIN_COINS = 1000; // §10.3 minimum withdrawal ($10)
const CREATOR_AGREEMENT = "creator-agreement"; // A1 — accepted before 1st withdrawal

function payoutEnabled(env: Env): boolean {
  return env.PAYOUT_ENABLED === "1" && wiseConfigured(env); // legal gate + creds
}

// Brevo status email (best-effort; address resolved from Clerk — D1 stores
// only email hashes). Phase 3 acceptance: status emails on sent/failed.
async function payoutEmail(env: Env, uid: string, subject: string, lines: string[]): Promise<void> {
  try {
    const email = await clerkEmail(env, uid);
    if (!email) return;
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 12px">${subject}</h2>
      ${lines.map((l) => `<p style="color:#444;margin:0 0 8px">${l}</p>`).join("")}
      <p style="color:#999;font-size:12px;margin-top:20px">AvaPayout · 1 AvaCoin = $0.01</p>
    </div>`;
    await env.Q_EMAIL.send({ to: email, subject: `AvaPayout — ${subject}`, html });
  } catch { /* never block payout flow on email */ }
}

// POST /api/payout/setup
export async function payoutSetup(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // Phase 3 — KYC BEFORE we accept bank details (acceptance: API-level gate).
  const kyc = await requireStripeKyc(env, ctx.uid);
  if (kyc) return json({ error: kyc.error, reason: "stripe_kyc_required" }, kyc.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const acctNum = String(b.account_number || "");
  if (!b.account_holder || !b.ifsc || !acctNum) return json({ error: "account_holder, ifsc, account_number required" }, 400);

  // A1 tax-data capture (1099-K / DAC7 runway): collected with the bank, before
  // the first withdrawal. We keep only the type + last 4 of the tax id.
  const taxCountry = b.tax_country ? String(b.tax_country).toUpperCase().slice(0, 2) : null;
  const taxIdType = b.tax_id_type ? String(b.tax_id_type).toLowerCase().slice(0, 16) : null;
  const taxIdLast4 = b.tax_id ? String(b.tax_id).replace(/\s/g, "").slice(-4) : null;
  const taxStatus = taxCountry && taxIdType && taxIdLast4 ? "collected" : "missing";

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
    `INSERT INTO payout_accounts (id, uid, label, country, currency, account_holder, ifsc, account_number_last4, wise_recipient_id, status, tax_country, tax_id_type, tax_id_last4, tax_form_status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)`,
  ).bind(id, ctx.uid, b.label ?? null, b.country || "IN", b.currency || "INR", String(b.account_holder), String(b.ifsc), acctNum.slice(-4), wiseRecipientId, status, taxCountry, taxIdType, taxIdLast4, taxStatus, now).run();

  track(env, ctx.uid, "payout_account_linked", "avapayout", { status, tax_form_status: taxStatus });
  return json({ ok: true, account_id: id, status, tax_form_status: taxStatus, payouts_enabled: payoutEnabled(env) });
}

export async function payoutAccounts(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    "SELECT id, label, country, currency, account_number_last4, status, tax_form_status, created_at FROM payout_accounts WHERE uid=?1 ORDER BY created_at DESC",
  ).bind(ctx.uid).all();
  return json({ accounts: rs.results ?? [] });
}

// POST /api/payout/request { account_id, amount_coins }
export async function payoutRequest(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // Phase 3 — KYC gate at the API level (not just UI-gated).
  const kyc = await requireStripeKyc(env, ctx.uid);
  if (kyc) return json({ error: kyc.error, reason: "stripe_kyc_required" }, kyc.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const amount = Math.trunc(Number(b.amount_coins));
  const accountId = String(b.account_id || "");
  if (!(amount >= MIN_COINS)) return json({ error: `minimum withdrawal is ${MIN_COINS} coins` }, 400);

  const acct = await env.DB_WALLET.prepare("SELECT id, wise_recipient_id, currency, tax_form_status FROM payout_accounts WHERE id=?1 AND uid=?2")
    .bind(accountId, ctx.uid).first<any>();
  if (!acct) return json({ error: "payout account not found" }, 404);

  // A1 — withdrawal blocked until tax fields + current creator agreement (per
  // acceptance criteria). Both are one-time setup steps surfaced by the app.
  if (acct.tax_form_status !== "collected") {
    return json({ error: "tax information required before withdrawing", reason: "tax_info_required" }, 403);
  }
  if (!(await agreementAccepted(env, ctx.uid, CREATOR_AGREEMENT))) {
    return json({
      error: "creator agreement must be accepted before withdrawing",
      reason: "agreement_required", doc_id: CREATOR_AGREEMENT,
      current_version: currentAgreementVersion(env, CREATOR_AGREEMENT),
    }, 403);
  }

  if (!payoutEnabled(env)) {
    // Infra built; production transfers held pending legal (§10.3). Honest 503.
    return json({ error: "payouts unavailable", reason: "pending_legal_approval", flag: "PAYOUT_ENABLED" }, 503);
  }

  // 1. Debit spendable balance atomically (held earnings are excluded by design).
  const debit = await walletOp(env, ctx.uid, { op: "spend", uid: ctx.uid, amount, type: "payout", app_name: "avapayout", ref: accountId });
  if (debit.status !== 200) return json({ error: "insufficient spendable balance", detail: debit.body }, 402);

  const id = crypto.randomUUID();
  const cents = amount; // 1 coin = 1 cent
  const now = Date.now();
  const currency = acct.currency || "INR";
  await env.DB_WALLET.prepare(
    `INSERT INTO payout_requests (id, uid, account_id, amount_coins, amount_cents, target_currency, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,'requested',?7,?7)`,
  ).bind(id, ctx.uid, accountId, amount, cents, currency, now).run();

  // 2. Wise quote → transfer → fund. On any failure, refund the coins.
  try {
    const quote = await createQuote(env, cents / 100, currency);
    const transfer = await createTransfer(env, quote.id, Number(acct.wise_recipient_id), id);
    await fundTransfer(env, transfer.id);
    await env.DB_WALLET.prepare("UPDATE payout_requests SET status='funded', wise_quote_id=?2, wise_transfer_id=?3, updated_at=?4 WHERE id=?1")
      .bind(id, quote.id, String(transfer.id), Date.now()).run();
    void brainIngest(env, { uid: ctx.uid, domain: "wallet", kind: "payout_requested", sourceId: id, text: `Requested a payout of ${amount} coins`, meta: { amount, currency } });
    track(env, ctx.uid, "payout_requested", "avapayout", { amount });
    await payoutEmail(env, ctx.uid, "Withdrawal on its way", [
      `Your withdrawal of ${amount} coins ($${(amount / 100).toFixed(2)}) has been submitted to your bank.`,
      `We'll email you again once the transfer is sent. Reference: ${id}.`,
    ]);
    return json({ ok: true, payout_id: id, status: "funded", amount_coins: amount });
  } catch (e: any) {
    // Refund coins on failure.
    await walletOp(env, ctx.uid, { op: "credit", uid: ctx.uid, amount, type: "refund", app_name: "avapayout", ref: id });
    await env.DB_WALLET.prepare("UPDATE payout_requests SET status='failed', failure_reason=?2, updated_at=?3 WHERE id=?1")
      .bind(id, String(e?.message ?? e).slice(0, 200), Date.now()).run();
    return json({ error: "payout failed; coins refunded", detail: String(e?.message ?? e) }, 502);
  }
}

export async function payoutStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    "SELECT id, account_id, amount_coins, target_currency, status, failure_reason, created_at, updated_at FROM payout_requests WHERE uid=?1 ORDER BY created_at DESC LIMIT 50",
  ).bind(ctx.uid).all();
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

  const reqRow = await env.DB_WALLET.prepare("SELECT id, uid, amount_coins, status FROM payout_requests WHERE wise_transfer_id=?1")
    .bind(transferId).first<any>();
  if (!reqRow) return json({ received: true, ignored: "unknown transfer" });

  await env.DB_WALLET.prepare("UPDATE payout_requests SET status=?2, updated_at=?3 WHERE id=?1").bind(reqRow.id, status, Date.now()).run();

  if (status === "failed" && reqRow.status !== "refunded") {
    await walletOp(env, reqRow.uid, { op: "credit", uid: reqRow.uid, amount: reqRow.amount_coins, type: "refund", app_name: "avapayout", ref: reqRow.id });
    await env.DB_WALLET.prepare("UPDATE payout_requests SET status='refunded' WHERE id=?1").bind(reqRow.id).run();
    try { await notifyUser(env, reqRow.uid, { type: "wallet", title: "Payout failed — refunded", data: { deeplink: "/wallet" } }); } catch { /* best-effort */ }
    await payoutEmail(env, reqRow.uid, "Withdrawal failed — coins refunded", [
      `Your withdrawal of ${reqRow.amount_coins} coins could not be completed (${stateRaw}).`,
      `The coins have been returned to your wallet. Reference: ${reqRow.id}.`,
    ]);
  } else if (status === "completed") {
    void brainIngest(env, { uid: reqRow.uid, domain: "wallet", kind: "payout_completed", sourceId: reqRow.id, text: `Payout of ${reqRow.amount_coins} coins completed`, meta: { amount: reqRow.amount_coins } });
    try { await notifyUser(env, reqRow.uid, { type: "wallet", title: "Payout sent ✓", body: `${reqRow.amount_coins} coins withdrawn`, data: { deeplink: "/wallet" } }); } catch { /* best-effort */ }
    await payoutEmail(env, reqRow.uid, "Withdrawal sent ✓", [
      `Your withdrawal of ${reqRow.amount_coins} coins ($${(reqRow.amount_coins / 100).toFixed(2)}) was sent to your bank.`,
      `Reference: ${reqRow.id}.`,
    ]);
  }
  return json({ received: true, status });
}
