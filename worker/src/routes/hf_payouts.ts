// [HF-PAYOUT-1 2026-10-09] HF host withdrawals (MANUAL). Rulebook: Specs/RULEBOOK-HELLO-FRAANDS.md HF-PAY-12/10. Contract: Specs/HF-CALLS-CONTRACT.md.
// Flow: host requests -> admin approves -> the owner pays by bank transfer / UPI himself -> admin enters the UTR -> paid.
// Money: the amount is RESERVED in the host's WalletDO when they ask (so it cannot be spent twice) and CONSUMED when marked paid;
// reject / cancel RELEASE it. Only paid-funded earnings older than the 7-day hold are withdrawable (lib/hf_payouts.ts).
//   GET  /api/hosts/me/payouts                     -> { enabled, minRupees, maxPerWeek, hostStatus, kycOk, bankOk, bank|null, withdrawable, held, testEarnings, requests[] }
//   POST /api/hosts/me/payouts {amount}            (Idempotency-Key required) -> { ok, id, status:"requested", amount } | error codes below
//   POST /api/hosts/me/payouts/:id/cancel          (only while "requested")   -> { ok, status:"cancelled" }
//   GET  /api/admin/hf/payouts?status=requested|approved|paid|rejected|cancelled|all
//   GET  /api/admin/hf/payouts/:id/destination     -> full account/UPI for paying (audit-logged)
//   POST /api/admin/hf/payouts/:id/approve | /paid {utr} | /reject {reason}        (all idempotent)
// Error codes (POST): not_enabled 404, not_live 403, kyc_required 409, bank_required 409, invalid_amount 400, below_minimum 400,
//   weekly_limit 429, insufficient_withdrawable 402, wallet_error 502.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { withIdempotency, rateLimit } from "../money";
import { trackException, track } from "../hooks";
import { BRAND } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { tryDecryptPii } from "../lib/pii_crypto";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { readConfig } from "./config";
import { walletOp } from "./wallet";
import { readHfTokenConfig } from "../lib/hf_token_config"; // [HF-TOK-CALLS-1]
import { hostSummary, reservePayout, cancelPayoutReserve, markPayoutPaid, hostLedgerRef, isHostLedgerRef, wholeRupees } from "../lib/hf_host_ledger";
import {
  WALLET_APP, refFor, reserveOpId, payOpId, releaseOpId, cleanUtr, canApprove, canCancel, canPay, canReject, validatePayoutRequest,
  withdrawableFor, recentRequestCount, hostPayoutReadiness, payoutSums, sumMaturedCallRupees, parseSnapshot, STATUSES,
  type PayoutRow,
} from "../lib/hf_payouts";

const APP = BRAND.slug;
const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => json({ error, message: message ?? error, ...extra }, status);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 4_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

async function cfg(env: Env) {
  const c = (await readConfig(env)) as unknown as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return {
    enabled: c.hfPayoutsEnabled === true,
    minRupees: Math.max(1, n(c.hfPayoutMinRupees, 500)),
    maxPerWeek: Math.max(1, n(c.hfPayoutMaxPerWeek, 2)),
    // [HF-TOK-CALLS-1] hfTokensEnabled on: the host's INR ledger (paise) replaces the WalletDO for withdrawals. Payouts stay whole rupees, min Rs 500.
    tokens: readHfTokenConfig(c).enabled,
  };
}

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_payout_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { uid: adminUid, route: "/api/admin/hf/payouts", handled: true, app_name: APP, extra: { area: "hf_payout", step: "admin_audit", action } });
  }
}

/** Best-effort WhatsApp to the host. Never throws, never blocks the response. */
function notifyHost(env: Env, ctx: ExecutionContext | undefined, hostUid: string, text: string): void {
  const work = (async () => {
    try {
      const e164 = await verifiedWhatsAppNumber(env, hostUid);
      if (e164) await sendWhatsAppText(env, e164, text);
    } catch (e) {
      await trackException(env, e, { route: "hf_payouts.notifyHost", handled: true, app_name: APP, extra: { area: "hf_payout" } });
    }
  })();
  if (ctx) ctx.waitUntil(work); else void work;
}

const getRow = (env: Env, id: string) =>
  env.DB_META.prepare("SELECT * FROM hf_payout_requests WHERE id=?1").bind(id).first<PayoutRow>();

/** Rows we cancel ourselves when a request fails after the insert; they are noise to the host and the admin. */
const SYSTEM_PREFIX = "system:";
const isSystemRow = (r: PayoutRow) => r.status === "cancelled" && (r.reject_reason ?? "").startsWith(SYSTEM_PREFIX);
const publicRow = (r: PayoutRow) => {
  const b = parseSnapshot(r.bank_snapshot);
  return {
    id: r.id, amount: r.amount_rupees, status: r.status, accountLast4: b.accountLast4, ifsc: b.ifsc, utr: r.status === "paid" ? r.utr : null,
    reason: r.status === "rejected" ? r.reject_reason : null, createdAt: r.created_at, updatedAt: r.updated_at, paidAt: r.paid_at, exit: r.exit === 1,
  };
};

// ── host ─────────────────────────────────────────────────────────────────────
async function hostGet(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const c = await cfg(env);
  const host = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ status: string }>().catch(() => null);
  const ready = await hostPayoutReadiness(env, u.uid);
  const reqs = (await env.DB_META.prepare("SELECT * FROM hf_payout_requests WHERE host_uid=?1 ORDER BY created_at DESC LIMIT 50").bind(u.uid).all<PayoutRow>().catch(() => ({ results: [] as PayoutRow[] }))).results ?? [];
  let w: Record<string, number> = { withdrawable: 0, held: 0, testEarnings: 0 };
  if (c.enabled && host && c.tokens) {
    try {
      const x = await hostSummary(env, u.uid);
      w = {
        withdrawable: wholeRupees(x.availablePaise), held: wholeRupees(x.pendingPaise), testEarnings: wholeRupees(x.testPaise),
        withdrawablePaise: x.availablePaise, pendingPaise: x.pendingPaise, testEarningsPaise: x.testPaise, totalEarnedPaise: x.earnedPaise,
      };
    } catch (e) {
      await trackException(env, e, { uid: u.uid, route: "/api/hosts/me/payouts", handled: true, app_name: APP, extra: { area: "hf_payout", step: "host_ledger" } });
      return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
    }
  } else if (c.enabled && host) {
    try { const x = await withdrawableFor(env, u.uid); w = { withdrawable: x.withdrawable, held: x.held, testEarnings: x.testEarnings }; }
    catch (e) {
      await trackException(env, e, { uid: u.uid, route: "/api/hosts/me/payouts", handled: true, app_name: APP, extra: { area: "hf_payout", step: "withdrawable" } });
      return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
    }
  }
  return json({
    enabled: c.enabled, minRupees: c.minRupees, maxPerWeek: c.maxPerWeek, holdDays: 7, hostStatus: host?.status ?? null,
    kycOk: ready.kycOk, bankOk: ready.bankOk, bank: ready.bankOk ? { accountLast4: ready.accountLast4, ifsc: ready.ifsc } : null,
    ...w, requests: reqs.filter((r) => !isSystemRow(r)).map(publicRow),
  });
}

async function hostCreate(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const c = await cfg(env);
  if (!c.enabled) return err(404, "not_enabled", "Withdrawals open soon.");
  const lim = await rateLimit(env, `hfpayout:${u.uid}`, 6, 3600);
  if (lim) return lim;
  const uid = u.uid;
  const body = await readJson(req);
  return withIdempotency(req, env, uid, async () => {
    const host = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>().catch(() => null);
    const ready = await hostPayoutReadiness(env, uid);
    let w: { withdrawable: number };
    try { w = c.tokens ? { withdrawable: wholeRupees((await hostSummary(env, uid)).availablePaise) } : await withdrawableFor(env, uid); }
    catch (e) {
      await trackException(env, e, { uid, route: "/api/hosts/me/payouts", handled: true, app_name: APP, extra: { area: "hf_payout", step: "withdrawable" } });
      return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
    }
    const verdict = validatePayoutRequest({
      enabled: c.enabled, hostStatus: host?.status ?? null, kycOk: ready.kycOk, bankOk: ready.bankOk, amount: body.amount,
      minRupees: c.minRupees, withdrawable: w.withdrawable, recentCount: await recentRequestCount(env, uid), maxPerWeek: c.maxPerWeek,
    });
    if (!verdict.ok) return err(verdict.status, verdict.error, verdict.message, { withdrawable: w.withdrawable });
    const amount = verdict.amount;

    const bankRow = await env.DB_META.prepare("SELECT name_at_bank_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_at_bank_enc: string | null }>().catch(() => null);
    const name = await tryDecryptPii(env, bankRow?.name_at_bank_enc);
    const snapshot = JSON.stringify({ accountLast4: ready.accountLast4, ifsc: ready.ifsc, name });
    const id = crypto.randomUUID();
    const ref = c.tokens ? hostLedgerRef(id) : refFor(id);
    const now = Date.now();
    // Row first, THEN re-check the calls ceiling including it: two concurrent requests cannot both fit.
    await env.DB_META.prepare(
      `INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, wallet_ref, withdrawable_at_request, created_at, updated_at)
       VALUES (?1,?2,?3,'requested',?4,?5,?6,?7,?7)`,
    ).bind(id, uid, amount, snapshot, ref, w.withdrawable, now).run();
    const abort = async (code: string, status: number, message: string) => {
      await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', reject_reason=?2, updated_at=?3 WHERE id=?1 AND status='requested'").bind(id, SYSTEM_PREFIX + code, Date.now()).run();
      return err(status, code, message, { withdrawable: w.withdrawable });
    };
    if (c.tokens) {
      // The balance check and the reserve are ONE statement in the host ledger, so two requests cannot both fit.
      const rr = await reservePayout(env, uid, id, amount * 100, now);
      if (!rr.ok) return abort("insufficient_withdrawable", 402, "That amount is not available yet. Earnings are held for 7 days.");
      void track(env, uid, "hf_payout_requested", APP, { amount, mode: "inr_ledger" });
      return json({ ok: true, id, status: "requested", amount });
    }
    const [matured, sums] = await Promise.all([sumMaturedCallRupees(env, uid, now), payoutSums(env, uid)]);
    if (sums.active > matured) return abort("insufficient_withdrawable", 402, `You can withdraw up to ₹${w.withdrawable} right now.`);
    const r = await walletOp(env, uid, { op: "reserve", uid, amount, ref, allow_free: false, op_id: reserveOpId(id), app_name: WALLET_APP });
    if (r.status !== 200 || r.body?.ok === false) {
      const short = r.status === 402;
      return abort(short ? "insufficient_withdrawable" : "wallet_error", short ? 402 : 502,
        short ? "That amount is not available yet. Earnings are held for 7 days." : "We couldn't set that money aside. Please try again.");
    }
    void track(env, uid, "hf_payout_requested", APP, { amount });
    return json({ ok: true, id, status: "requested", amount });
  });
}

async function hostCancel(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const row = await getRow(env, id);
  if (!row || row.host_uid !== u.uid) return err(404, "not_found");
  if (row.status === "cancelled") return json({ ok: true, status: "cancelled", replay: true });
  if (row.exit === 1) return err(409, "exit_request", "This withdrawal belongs to your account closure. Cancel the closure instead.");
  if (!canCancel(row.status)) return err(409, "not_cancellable", "This request can no longer be cancelled.");
  // [HF-TOK-CALLS-1] which path holds the money is decided by the request itself (wallet_ref), so a flag flip never strands a payout.
  const r = isHostLedgerRef(row.wallet_ref)
    ? { status: (await cancelPayoutReserve(env, row.host_uid, id)).ok ? 200 : 502 }
    : await walletOp(env, row.host_uid, { op: "release_reservation", uid: row.host_uid, ref: refFor(id), op_id: releaseOpId(id), app_name: WALLET_APP });
  if (r.status !== 200) return err(502, "wallet_error", "We couldn't release that money. Please try again.");
  const up = await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', updated_at=?2 WHERE id=?1 AND status='requested'").bind(id, Date.now()).run();
  if (!up.meta?.changes) return err(409, "not_cancellable", "This request was just approved, so it can no longer be cancelled.");
  return json({ ok: true, status: "cancelled" });
}

// ── admin ────────────────────────────────────────────────────────────────────
async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  return { uid: u.uid };
}

async function adminList(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const q = new URL(req.url).searchParams.get("status") ?? "requested";
  const status = (STATUSES as string[]).includes(q) ? q : q === "all" ? null : "requested";
  const rows = (await env.DB_META.prepare(
    `SELECT r.*, h.display_name AS host_name, h.slug AS host_slug FROM hf_payout_requests r LEFT JOIN hf_hosts h ON h.uid=r.host_uid
     ${status ? "WHERE r.status=?1" : ""} ORDER BY r.created_at DESC LIMIT 200`,
  ).bind(...(status ? [status] : [])).all<PayoutRow & { host_name: string | null; host_slug: string | null }>()).results ?? [];
  const counts = (await env.DB_META.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_rupees),0) AS s FROM hf_payout_requests GROUP BY status").all<{ status: string; n: number; s: number }>()).results ?? [];
  return json({
    items: rows.filter((r) => !isSystemRow(r)).map((r) => {
      const b = parseSnapshot(r.bank_snapshot);
      return {
        id: r.id, hostUid: r.host_uid, hostName: r.host_name, hostSlug: r.host_slug, amount: r.amount_rupees, status: r.status,
        accountLast4: b.accountLast4, ifsc: b.ifsc, accountName: b.name, withdrawableAtRequest: r.withdrawable_at_request, utr: r.utr,
        reason: r.reject_reason, adminUid: r.admin_uid, exit: r.exit === 1, createdAt: r.created_at, updatedAt: r.updated_at, approvedAt: r.approved_at, paidAt: r.paid_at,
      };
    }),
    counts: Object.fromEntries(counts.map((c) => [c.status, { n: Number(c.n), rupees: Number(c.s) }])),
  });
}

/** Full account / UPI so the owner can pay. Every read is audit-logged. Refuses if the host changed bank after asking. */
async function adminDestination(req: Request, env: Env, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const row = await getRow(env, id);
  if (!row) return err(404, "not_found");
  if (row.status !== "requested" && row.status !== "approved") return err(409, "not_payable", "Only open requests show payment details.");
  const p = await env.DB_META.prepare("SELECT upi_enc, upi_verified, account_enc, account_last4, ifsc, name_at_bank_enc FROM hf_payout WHERE uid=?1").bind(row.host_uid)
    .first<{ upi_enc: string | null; upi_verified: number; account_enc: string | null; account_last4: string | null; ifsc: string | null; name_at_bank_enc: string | null }>().catch(() => null);
  if (!p) return err(404, "no_bank");
  const snap = parseSnapshot(row.bank_snapshot);
  const matches = snap.accountLast4 === p.account_last4 && snap.ifsc === p.ifsc;
  await audit(env, a.uid, "destination_viewed", id, { host: row.host_uid, matches });
  if (!matches) return err(409, "bank_changed", "The host changed their bank details after asking. Reject this request and ask them to request again.");
  const [account, upi, name] = await Promise.all([tryDecryptPii(env, p.account_enc), tryDecryptPii(env, p.upi_enc), tryDecryptPii(env, p.name_at_bank_enc)]);
  return json({ amount: row.amount_rupees, accountName: name, account, ifsc: p.ifsc, upi, upiVerified: p.upi_verified === 1 });
}

async function adminApprove(req: Request, env: Env, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const row = await getRow(env, id);
  if (!row) return err(404, "not_found");
  if (row.status === "approved") return json({ ok: true, status: "approved", replay: true });
  if (!canApprove(row.status)) return err(409, "invalid_state", `This request is ${row.status}.`);
  const now = Date.now();
  const up = await env.DB_META.prepare("UPDATE hf_payout_requests SET status='approved', admin_uid=?2, approved_at=?3, updated_at=?3 WHERE id=?1 AND status='requested'").bind(id, a.uid, now).run();
  if (!up.meta?.changes) return err(409, "invalid_state", "This request changed. Refresh and try again.");
  await audit(env, a.uid, "approved", id, { host: row.host_uid, amount: row.amount_rupees });
  return json({ ok: true, status: "approved" });
}

async function adminPaid(req: Request, env: Env, ctx: ExecutionContext | undefined, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const utr = cleanUtr((await readJson(req)).utr);
  if (!utr) return err(400, "invalid_utr", "Enter the UTR: 6 to 30 letters or numbers.");
  const row = await getRow(env, id);
  if (!row) return err(404, "not_found");
  if (row.status === "paid") return row.utr === utr ? json({ ok: true, status: "paid", replay: true }) : err(409, "already_paid", "This request is already paid with a different UTR.");
  if (!canPay(row.status)) return err(409, "invalid_state", row.status === "requested" ? "Approve this request first." : `This request is ${row.status}.`);
  const dup = await env.DB_META.prepare("SELECT id FROM hf_payout_requests WHERE utr=?1 AND id<>?2 LIMIT 1").bind(utr, id).first();
  if (dup) return err(409, "duplicate_utr", "That UTR is already recorded on another payout.");
  const ref = refFor(id);
  if (isHostLedgerRef(row.wallet_ref)) {
    const mp = await markPayoutPaid(env, row.host_uid, id);
    if (!mp.ok) return err(409, "needs_reconciliation", "The earnings reserve for this payout is missing or was cancelled. Nothing was marked paid.");
  } else {
  const r = await walletOp(env, row.host_uid, {
    op: "consume_reserved", uid: row.host_uid, amount: row.amount_rupees, ref, allow_free: false, type: "payout", app_name: WALLET_APP, op_id: payOpId(id),
    ledger: { debit: `user:${row.host_uid}`, credit: "external:hf_payout", type: "payout", ref },
  });
  if (r.status !== 200) return err(r.status === 404 ? 409 : 502, r.status === 404 ? "needs_reconciliation" : "wallet_error", "The wallet could not take that money. Nothing was marked paid.");
  if (Number(r.body?.consumed ?? 0) !== row.amount_rupees) return err(409, "needs_reconciliation", "The wallet took a different amount. Nothing was marked paid; check the wallet before paying.");
  }
  const now = Date.now();
  await env.DB_META.prepare("UPDATE hf_payout_requests SET status='paid', utr=?2, admin_uid=?3, paid_at=?4, updated_at=?4 WHERE id=?1 AND status='approved'").bind(id, utr, a.uid, now).run();
  await audit(env, a.uid, "paid", id, { host: row.host_uid, amount: row.amount_rupees, utr });
  notifyHost(env, ctx, row.host_uid, `Your ${BRAND.name} withdrawal of ₹${row.amount_rupees} has been paid. Bank reference (UTR): ${utr}.`);
  return json({ ok: true, status: "paid" });
}

async function adminReject(req: Request, env: Env, ctx: ExecutionContext | undefined, id: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  const reason = String((await readJson(req)).reason ?? "").trim().slice(0, 200);
  if (reason.length < 3) return err(400, "reason_required", "Write a short reason. The host will see it.");
  const row = await getRow(env, id);
  if (!row) return err(404, "not_found");
  if (row.status === "rejected") return json({ ok: true, status: "rejected", replay: true });
  if (!canReject(row.status)) return err(409, "invalid_state", `This request is ${row.status}.`);
  // [HF-TOK-CALLS-1] which path holds the money is decided by the request itself (wallet_ref), so a flag flip never strands a payout.
  const r = isHostLedgerRef(row.wallet_ref)
    ? { status: (await cancelPayoutReserve(env, row.host_uid, id)).ok ? 200 : 502 }
    : await walletOp(env, row.host_uid, { op: "release_reservation", uid: row.host_uid, ref: refFor(id), op_id: releaseOpId(id), app_name: WALLET_APP });
  if (r.status !== 200) return err(502, "wallet_error", "The wallet could not release that money. Nothing changed.");
  const up = await env.DB_META.prepare("UPDATE hf_payout_requests SET status='rejected', reject_reason=?2, admin_uid=?3, updated_at=?4 WHERE id=?1 AND status IN ('requested','approved')").bind(id, reason, a.uid, Date.now()).run();
  if (!up.meta?.changes) return err(409, "invalid_state", "This request changed. Refresh and try again.");
  await audit(env, a.uid, "rejected", id, { host: row.host_uid, amount: row.amount_rupees, reason });
  notifyHost(env, ctx, row.host_uid, row.exit === 1
    ? `Your ${BRAND.name} final withdrawal of ₹${row.amount_rupees} was not paid: ${reason}. Your account closure will continue.`
    : `Your ${BRAND.name} withdrawal of ₹${row.amount_rupees} was not paid: ${reason}. The money is back in your available balance.`);
  return json({ ok: true, status: "rejected" });
}

// ── router ───────────────────────────────────────────────────────────────────
const ID = "([A-Za-z0-9-]{8,64})";
const HOST_CANCEL_RE = new RegExp(`^/api/hosts/me/payouts/${ID}/cancel$`);
const ADMIN_RE = new RegExp(`^/api/admin/hf/payouts/${ID}/(approve|paid|reject|destination)$`);
/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfPayoutsRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = req.method;
  const hostCancelM = p.match(HOST_CANCEL_RE);
  const adminM = p.match(ADMIN_RE);
  const ours = p === "/api/hosts/me/payouts" || !!hostCancelM || p === "/api/admin/hf/payouts" || !!adminM;
  if (!ours) return null;
  try {
    if (p === "/api/hosts/me/payouts" && m === "GET") return await hostGet(req, env);
    if (p === "/api/hosts/me/payouts" && m === "POST") return await hostCreate(req, env);
    if (hostCancelM && m === "POST") return await hostCancel(req, env, hostCancelM[1]);
    if (p === "/api/admin/hf/payouts" && m === "GET") return await adminList(req, env);
    if (adminM) {
      const [, id, action] = adminM;
      if (action === "destination" && m === "GET") return await adminDestination(req, env, id);
      if (action === "approve" && m === "POST") return await adminApprove(req, env, id);
      if (action === "paid" && m === "POST") return await adminPaid(req, env, ctx, id);
      if (action === "reject" && m === "POST") return await adminReject(req, env, ctx, id);
    }
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_payout" } });
    return err(500, "internal_error");
  }
}
