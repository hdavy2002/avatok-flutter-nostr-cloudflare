// Double-entry ledger + escrow primitives (Phase 2, marketplace plan §4).
//
// Balance authority for USER accounts = WalletDO (idempotent on op_id; emits the
// ledger row to Q_WALLET itself — single writer). Escrow + platform buckets are
// LEDGER-ONLY accounts in D1 (avatok-wallet `wallet_accounts`) — nothing races on
// them, the Q_WALLET consumer recomputes their balances from the ledger.
//
//   hold(uid, orderId, amount)        user → escrow:<orderId>   purchase_hold
//   release(orderId, creatorId)       escrow → user (80%)       escrow_release
//                                     escrow → platform:fees    fee (20%)
//   refund(orderId, uid, amount)      escrow → user             refund (partial OK)
//
// Consumed by Phases 6–7 (bookings/events) + the admin money console.
import type { Env } from "./types";
import { walletOp } from "./routes/wallet";

export const PLATFORM_FEE_RATE = 0.20; // §4: 80% creator / 20% platform
export const ACCT_PLATFORM_FEES = "platform:fees";
export const acctUser = (uid: string) => `user:${uid}`;
export const acctEscrow = (orderId: string) => `escrow:${orderId}`;

export interface LedgerResult { ok: boolean; status: number; body: any; }

/** Ledger-only row (no user-account side → no DO op), e.g. escrow→platform fee. */
async function sendLedgerRow(env: Env, id: string, debit: string, credit: string, amount: number, type: string, ref: string | null, meta: object | null): Promise<void> {
  await env.Q_WALLET.send({ id, ts: Date.now(), amount, ledger: { debit, credit, type, ref, meta: meta ? JSON.stringify(meta) : null } });
}

/** Escrow bucket state: prefer the consumer-maintained account row; fall back to a live ledger Σ (covers queue lag). */
export async function escrowBalance(env: Env, orderId: string): Promise<number> {
  const id = acctEscrow(orderId);
  const acct = await env.DB_WALLET.prepare("SELECT balance FROM wallet_accounts WHERE id=?1").bind(id).first<{ balance: number }>();
  if (acct) return Number(acct.balance);
  const sum = await env.DB_WALLET.prepare(
    "SELECT COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE credit=?1),0) - COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE debit=?1),0) AS bal",
  ).bind(id).first<{ bal: number }>();
  return Number(sum?.bal ?? 0);
}

/**
 * hold — move coins from the buyer's wallet into the order's escrow bucket.
 * Fails 402 if the buyer's spendable balance is insufficient. Idempotent on
 * opId (defaults to `hold:<orderId>` — one hold per order).
 */
export async function hold(env: Env, uid: string, orderId: string, amount: number, opts?: { opId?: string; title?: string; app?: string }): Promise<LedgerResult> {
  amount = Math.trunc(Number(amount));
  if (!(amount > 0)) return { ok: false, status: 400, body: { error: "amount>0 required" } };
  const opId = opts?.opId ?? `hold:${orderId}`;
  const r = await walletOp(env, uid, {
    op: "spend", uid, amount, type: "spend", app_name: opts?.app ?? "escrow", ref: orderId, op_id: opId,
    ledger: { debit: acctUser(uid), credit: acctEscrow(orderId), type: "purchase_hold", ref: orderId, meta: JSON.stringify({ title: opts?.title ?? null, gross: amount }) },
  });
  // A4: purchase receipt on every successful (non-duplicate) hold. Best-effort.
  if (r.status === 200 && !r.body?.duplicate) {
    try { await sendReceipt(env, uid, "purchase", { orderId, title: opts?.title ?? `Order ${orderId}`, lines: [{ label: opts?.title ?? `Order ${orderId}`, amount }], total: amount }); } catch { /* best-effort */ }
  }
  return { ok: r.status === 200, status: r.status, body: r.body };
}

/**
 * release — settle a completed order: 80% to the creator (into the standard
 * 7-day earnings hold — shows as "pending" in the UI), 20% platform fee.
 * Gross defaults to the escrow bucket's full balance. Idempotent per order.
 */
export async function release(env: Env, orderId: string, creatorId: string, opts?: { title?: string; app?: string; feeRate?: number; gross?: number }): Promise<LedgerResult> {
  // Phase 7: pass opts.gross for a PARTIAL release (R2 pro-rata, R5 split);
  // default stays "everything left in the bucket".
  const avail = await escrowBalance(env, orderId);
  const gross = opts?.gross != null ? Math.min(Math.trunc(opts.gross), avail) : avail;
  if (!(gross > 0)) return { ok: false, status: 409, body: { error: "escrow empty or not yet settled", orderId } };
  const rate = opts?.feeRate ?? PLATFORM_FEE_RATE;
  const fee = Math.round(gross * rate);
  const net = gross - fee;
  const meta = { title: opts?.title ?? null, gross, fee, net, fee_rate: rate, counterpart: creatorId };

  const r = await walletOp(env, creatorId, {
    op: "earn", uid: creatorId, amount: net, commission: fee, app_name: opts?.app ?? "escrow", ref: orderId, op_id: `rel:${orderId}`,
    ledger: { debit: acctEscrow(orderId), credit: acctUser(creatorId), type: "escrow_release", ref: orderId, meta: JSON.stringify(meta) },
  });
  if (r.status !== 200) return { ok: false, status: r.status, body: r.body };
  if (fee > 0) {
    await sendLedgerRow(env, `fee:${orderId}`, acctEscrow(orderId), ACCT_PLATFORM_FEES, fee, "fee", orderId, { title: opts?.title ?? null, gross, fee_rate: rate });
  }
  return { ok: true, status: 200, body: { ok: true, orderId, gross, net, fee, ...r.body } };
}

/**
 * refund — return coins from escrow to the buyer (partial OK; spendable
 * immediately). opId must be unique per refund (`refund:<orderId>` default —
 * pass your own for multiple partials on one order).
 */
export async function refund(env: Env, orderId: string, uid: string, amount: number, opts?: { opId?: string; reason?: string; title?: string }): Promise<LedgerResult> {
  amount = Math.trunc(Number(amount));
  if (!(amount > 0)) return { ok: false, status: 400, body: { error: "amount>0 required" } };
  const avail = await escrowBalance(env, orderId);
  if (amount > avail) return { ok: false, status: 409, body: { error: "refund exceeds escrow balance", available: avail } };
  const opId = opts?.opId ?? `refund:${orderId}`;
  const r = await walletOp(env, uid, {
    op: "credit", uid, amount, type: "refund", app_name: "escrow", ref: orderId, op_id: opId,
    ledger: { debit: acctEscrow(orderId), credit: acctUser(uid), type: "refund", ref: orderId, meta: JSON.stringify({ title: opts?.title ?? null, reason: opts?.reason ?? null, amount }) },
  });
  return { ok: r.status === 200, status: r.status, body: r.body };
}

/**
 * donation — Phase 7 live tips (universal §4): instant to the creator (NO
 * escrow, NO 7-day hold — it's a gift, not a deliverable), minus the 20%
 * platform fee. Three balanced rows: buyer→creator gross (type donation),
 * ledger-only creator→platform:fees fee, and the creator credit is the net.
 * Idempotent on `don:<donationId>:*` op_ids.
 */
export async function donation(env: Env, buyer: string, creator: string, amount: number, donationId: string, opts?: { title?: string; feeRate?: number }): Promise<LedgerResult & { net: number; fee: number }> {
  amount = Math.trunc(Number(amount));
  if (!(amount > 0)) return { ok: false, status: 400, body: { error: "amount>0 required" }, net: 0, fee: 0 };
  const rate = opts?.feeRate ?? PLATFORM_FEE_RATE;
  const fee = Math.round(amount * rate);
  const net = amount - fee;
  const ref = `don:${donationId}`;
  const meta = JSON.stringify({ title: opts?.title ?? "Live donation", gross: amount, fee, net, fee_rate: rate });
  // 1. Debit the buyer (gross) — carries the buyer→creator donation row.
  const d = await walletOp(env, buyer, {
    op: "spend", uid: buyer, amount, type: "spend", app_name: "avalive", counterparty_npub: creator, ref, op_id: `${ref}:spend`,
    ledger: { debit: acctUser(buyer), credit: acctUser(creator), type: "donation", ref, meta },
  });
  if (d.status !== 200) return { ok: false, status: d.status, body: d.body, net: 0, fee: 0 };
  // 2. Credit the creator the NET, spendable immediately (no hold).
  await walletOp(env, creator, { op: "credit", uid: creator, amount: net, type: "donation", app_name: "avalive", counterparty_npub: buyer, ref, op_id: `${ref}:credit` });
  // 3. Ledger-only fee row balances the creator's account (gross in − fee out = net).
  if (fee > 0) await sendLedgerRow(env, `${ref}:fee`, acctUser(creator), ACCT_PLATFORM_FEES, fee, "fee", ref, { title: "Donation fee", gross: amount, fee_rate: rate });
  return { ok: true, status: 200, body: { ok: true, gross: amount, net, fee, buyer_balance: d.body?.balance }, net, fee };
}

/**
 * adjust — admin-only correction. Positive amount credits the user
 * (platform:fees → user), negative debits (user → platform:fees). Always type
 * 'adjustment', always through WalletDO + ledger (never D1-only).
 */
export async function adjust(env: Env, uid: string, amount: number, reason: string, adminId: string, opId: string): Promise<LedgerResult> {
  amount = Math.trunc(Number(amount));
  if (!amount) return { ok: false, status: 400, body: { error: "non-zero amount required" } };
  const meta = JSON.stringify({ reason, admin: adminId, amount });
  const r = amount > 0
    ? await walletOp(env, uid, { op: "credit", uid, amount, type: "refund", app_name: "admin", ref: `adj:${opId}`, op_id: opId, ledger: { debit: ACCT_PLATFORM_FEES, credit: acctUser(uid), type: "adjustment", ref: `adj:${opId}`, meta } })
    : await walletOp(env, uid, { op: "spend", uid, amount: -amount, type: "spend", app_name: "admin", ref: `adj:${opId}`, op_id: opId, ledger: { debit: acctUser(uid), credit: ACCT_PLATFORM_FEES, type: "adjustment", ref: `adj:${opId}`, meta } });
  return { ok: r.status === 200, status: r.status, body: r.body };
}

// ---------------------------------------------------------------------------
// Receipts (A4) — Brevo email via Q_EMAIL. The user's email comes from Clerk
// (D1 stores only email hashes). Best-effort: failures never block money ops.
// ---------------------------------------------------------------------------
export async function clerkEmail(env: Env, uid: string): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${uid}`, { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    if (!r.ok) return null;
    const u = (await r.json()) as any;
    const primary = (u.email_addresses ?? []).find((e: any) => e.id === u.primary_email_address_id) ?? (u.email_addresses ?? [])[0];
    return primary?.email_address ?? null;
  } catch { return null; }
}

export interface ReceiptLine { label: string; amount: number; } // coins (1 = $0.01)
const usd = (coins: number) => `$${(coins / 100).toFixed(2)}`;

export async function sendReceipt(env: Env, uid: string, kind: "topup" | "purchase", opts: { orderId: string; title: string; lines: ReceiptLine[]; total: number; date?: number }): Promise<boolean> {
  const email = await clerkEmail(env, uid);
  if (!email) return false;
  const when = new Date(opts.date ?? Date.now()).toUTCString();
  const rows = opts.lines.map((l) => `<tr><td style="padding:6px 12px 6px 0;color:#444">${l.label}</td><td style="padding:6px 0;text-align:right">${usd(l.amount)}</td></tr>`).join("");
  const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 4px">AvaTok receipt</h2>
    <p style="color:#666;margin:0 0 16px">${kind === "topup" ? "Wallet top-up" : "Purchase"} — ${when}</p>
    <p style="margin:0 0 16px;font-weight:600">${opts.title}</p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee">${rows}
      <tr><td style="padding:10px 12px 0 0;font-weight:700;border-top:1px solid #eee">Total</td><td style="padding:10px 0 0;text-align:right;font-weight:700;border-top:1px solid #eee">${usd(opts.total)}</td></tr>
    </table>
    <p style="color:#999;font-size:12px;margin-top:20px">Payment source: ${kind === "topup" ? "card (Stripe)" : "AvaTok wallet"} · Order ${opts.orderId}<br>1 AvaCoin = $0.01</p>
  </div>`;
  try {
    await env.Q_EMAIL.send({ to: email, subject: `Your AvaTok receipt — ${opts.title}`, html });
    return true;
  } catch { return false; }
}
