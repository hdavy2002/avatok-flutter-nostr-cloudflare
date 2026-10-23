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
//   [HF-WIRE-10] Reels app adapter (paise): GET /api/hf/payouts/summary, PUT /api/hf/payouts/upi, POST /api/hf/payouts - see the block above the router.
// Error codes (POST): not_enabled 404, not_live 403, kyc_required 409, bank_required 409, invalid_amount 400, below_minimum 400,
//   weekly_limit 429, insufficient_withdrawable 402, wallet_error 502.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { withIdempotency, rateLimit } from "../money";
import { trackException, track } from "../hooks";
import { BRAND, brandUrl } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { tryDecryptPii, encryptPii } from "../lib/pii_crypto";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { pushWithdrawal } from "../lib/hf_push"; // [HF-APP-4]
import { readConfig } from "./config";
import { walletOp } from "./wallet";
import { readHfTokenConfig } from "../lib/hf_token_config"; // [HF-TOK-CALLS-1]
import { moneyRulesFrom, splitPayoutSources, payoutMinimumRupees, type PayoutSource } from "../lib/hf_money_rules"; // [HF-WIRE-13] HF-REEL-36
import { fanWithdrawablePaise, takeFanPayout, returnFanPayout, markFanPayoutPaid, fanPayoutRef, isFanPayoutRef, fanTakenPaise } from "../lib/hf_fan_payout";
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
    minRupees: n(c.hfPayoutMinRupees, 0), // [HF-WIRE-18] HF-REEL-38: default no minimum (0); amounts must still be > 0
    maxPerWeek: Math.max(1, n(c.hfPayoutMaxPerWeek, 2)),
    fanMinRupees: moneyRulesFrom(c).fanPayoutMinRupees, // [HF-WIRE-13] wallet-only withdrawals (default 0 = no minimum, HF-REEL-38)
    // [HF-TOK-CALLS-1] hfTokensEnabled on: the host's INR ledger (paise) replaces the WalletDO for withdrawals. Payouts stay whole rupees, no minimum (HF-REEL-38).
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

/**
 * Give a cancelled / rejected request's money back. [HF-WIRE-13] Wallet money (purchase lots) returns to the WALLET as a new purchase lot;
 * influencer earnings return to the earnings ledger. A mixed request returns both. Idempotent: a retry finishes whatever is left.
 */
async function releasePayoutMoney(env: Env, row: PayoutRow): Promise<{ status: number }> {
  const hasLots = Number(row.lots_paise ?? 0) > 0 || isFanPayoutRef(row.wallet_ref);
  if (isHostLedgerRef(row.wallet_ref)) {
    if (!(await cancelPayoutReserve(env, row.host_uid, row.id)).ok) return { status: 502 };
  } else if (!isFanPayoutRef(row.wallet_ref)) {
    const r = await walletOp(env, row.host_uid, { op: "release_reservation", uid: row.host_uid, ref: refFor(row.id), op_id: releaseOpId(row.id), app_name: WALLET_APP });
    if (r.status !== 200) return { status: r.status };
  }
  if (hasLots) {
    const rr = await returnFanPayout(env, row.host_uid, row.id);
    // "not_taken" = the request failed before the wallet part was taken: nothing to give back.
    if (!rr.ok && rr.reason !== "not_taken") return { status: 502 };
  }
  return { status: 200 };
}

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

async function hostCreate(req: Request, env: Env, app = false): Promise<Response> {
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
    let ready = await hostPayoutReadiness(env, uid);
    if (app) {
      // [HF-WIRE-10] Reels-app flow: UPI is the destination; ID check only before the FIRST payout.
      // [HF-WIRE-13] HF-REEL-36: ANYONE can withdraw (fans too). Wallet money and influencer earnings are combined in one request below.
      const ap = appValidate(body);
      if (!ap.ok) return err(400, ap.error, ap.message);
      body.amount = ap.rupees;
      const upiRow = await env.DB_META.prepare("SELECT upi_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ upi_enc: string | null }>().catch(() => null);
      if (!upiRow?.upi_enc) return err(409, "upi_required", "Add your UPI ID first.");
      if (!ready.kycOk) {
        const paidBefore = await env.DB_META.prepare("SELECT 1 AS x FROM hf_payout_requests WHERE host_uid=?1 AND status='paid' LIMIT 1").bind(uid).first().catch(() => null);
        if (!paidBefore) return err(409, "kyc_required", "We check your ID once, before your first withdrawal.", { nextStep: kycNextStep() });
      }
      ready = { ...ready, kycOk: true, bankOk: true };
    }
    let w: { withdrawable: number };
    let src: PayoutSource | null = null;
    let earnReady = 0;
    try {
      if (app) {
        const isInf = isInfluencerStatus(host?.status);
        const lotsReady = c.tokens ? await fanWithdrawablePaise(env, uid) : 0; // purchase lots only: test credits never
        earnReady = !isInf ? 0 : c.tokens ? wholeRupees((await hostSummary(env, uid)).availablePaise) * 100 : (await withdrawableFor(env, uid)).withdrawable * 100;
        src = splitPayoutSources(Number(body.amount), lotsReady, earnReady);
        w = { withdrawable: Math.floor((lotsReady + earnReady) / 100) };
      } else w = c.tokens ? { withdrawable: wholeRupees((await hostSummary(env, uid)).availablePaise) } : await withdrawableFor(env, uid);
    } catch (e) {
      await trackException(env, e, { uid, route: "/api/hosts/me/payouts", handled: true, app_name: APP, extra: { area: "hf_payout", step: "withdrawable" } });
      return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
    }
    const verdict = validatePayoutRequest({
      enabled: c.enabled, hostStatus: app ? "live" : host?.status ?? null, kycOk: ready.kycOk, bankOk: ready.bankOk, amount: body.amount,
      minRupees: app ? (src ? payoutMinimumRupees(src, c.fanMinRupees, c.minRupees) : earnReady > 0 ? c.minRupees : c.fanMinRupees) : c.minRupees,
      withdrawable: w.withdrawable, recentCount: await recentRequestCount(env, uid), maxPerWeek: c.maxPerWeek,
    });
    if (!verdict.ok) return err(verdict.status, verdict.error, verdict.message, { withdrawable: w.withdrawable });
    const amount = verdict.amount;

    const bankRow = await env.DB_META.prepare("SELECT name_at_bank_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_at_bank_enc: string | null }>().catch(() => null);
    const name = await tryDecryptPii(env, bankRow?.name_at_bank_enc);
    const snapshot = JSON.stringify({ accountLast4: ready.accountLast4, ifsc: ready.ifsc, name });
    const id = crypto.randomUUID();
    // [HF-WIRE-13] lotsPaise = wallet money taken from the person's own top-ups; earnRupees = the rest, from influencer earnings (7-day hold applies).
    const lotsPaise = app && src ? src.lotsPaise : 0;
    const earnRupees = app && src ? src.earningsPaise / 100 : amount;
    const ref = earnRupees <= 0 ? fanPayoutRef(id) : c.tokens ? hostLedgerRef(id) : refFor(id);
    const now = Date.now();
    // Row first, THEN re-check the calls ceiling including it: two concurrent requests cannot both fit.
    await env.DB_META.prepare(
      lotsPaise > 0 // only a request that takes wallet money touches the new lots_paise column
        ? `INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, wallet_ref, withdrawable_at_request, lots_paise, created_at, updated_at)
           VALUES (?1,?2,?3,'requested',?4,?5,?6,?8,?7,?7)`
        : `INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, wallet_ref, withdrawable_at_request, created_at, updated_at)
           VALUES (?1,?2,?3,'requested',?4,?5,?6,?7,?7)`,
    ).bind(...(lotsPaise > 0 ? [id, uid, amount, snapshot, ref, w.withdrawable, now, lotsPaise] : [id, uid, amount, snapshot, ref, w.withdrawable, now])).run();
    const abort = async (code: string, status: number, message: string) => {
      if (lotsPaise > 0) await returnFanPayout(env, uid, id).catch(() => undefined); // wallet money goes straight back to the wallet
      await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', reject_reason=?2, updated_at=?3 WHERE id=?1 AND status='requested'").bind(id, SYSTEM_PREFIX + code, Date.now()).run();
      return err(status, code, message, { withdrawable: w.withdrawable });
    };
    if (lotsPaise > 0) {
      // The wallet part is taken from purchase lots in one guarded batch: it can no longer be spent on a call or withdrawn twice.
      const tk = await takeFanPayout(env, uid, id, lotsPaise);
      if (!tk.ok) return abort("insufficient_withdrawable", 402, "That amount is not available right now. Please try again.");
    }
    if (c.tokens) {
      // The balance check and the reserve are ONE statement in the host ledger, so two requests cannot both fit.
      if (earnRupees > 0) {
        const rr = await reservePayout(env, uid, id, earnRupees * 100, now);
        if (!rr.ok) return abort("insufficient_withdrawable", 402, "That amount is not available yet. Earnings are held for 7 days.");
      }
      void track(env, uid, "hf_payout_requested", APP, { amount, mode: lotsPaise > 0 ? (earnRupees > 0 ? "wallet_and_earnings" : "wallet") : "inr_ledger" });
      return json({ ok: true, id, status: "requested", amount, amountPaise: amount * 100 });
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
    return json({ ok: true, id, status: "requested", amount, amountPaise: amount * 100 });
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
  const r = await releasePayoutMoney(env, row);
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
  // [HF-ADMIN-SWEEP-1] an exit payout can belong to a plain caller (no hf_hosts row): name them from their registration.
  const regNames = new Map<string, string>();
  const need = [...new Set(rows.filter((r) => !r.host_name?.trim()).map((r) => r.host_uid))].slice(0, 100);
  if (need.length) {
    const ns = (await env.DB_META.prepare(`SELECT uid, first_name, last_name FROM hf_user_registration WHERE uid IN (${need.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...need).all<{ uid: string; first_name: string; last_name: string }>().catch(() => ({ results: [] as { uid: string; first_name: string; last_name: string }[] }))).results ?? [];
    for (const x of ns) regNames.set(x.uid, `${x.first_name} ${x.last_name}`.trim());
  }
  const counts = (await env.DB_META.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_rupees),0) AS s FROM hf_payout_requests GROUP BY status").all<{ status: string; n: number; s: number }>()).results ?? [];
  return json({
    items: rows.filter((r) => !isSystemRow(r)).map((r) => {
      const b = parseSnapshot(r.bank_snapshot);
      return {
        id: r.id, hostUid: r.host_uid, hostName: r.host_name?.trim() || regNames.get(r.host_uid) || null, hostSlug: r.host_slug, amount: r.amount_rupees, status: r.status,
        accountLast4: b.accountLast4, ifsc: b.ifsc, accountName: b.name, withdrawableAtRequest: r.withdrawable_at_request, utr: r.utr,
        reason: r.reject_reason, adminUid: r.admin_uid, exit: r.exit === 1, walletPaise: Number(r.lots_paise ?? 0), // [HF-WIRE-13] part paid out of the person's own wallet
         createdAt: r.created_at, updatedAt: r.updated_at, approvedAt: r.approved_at, paidAt: r.paid_at,
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
  await pushWithdrawal(env, undefined, row.host_uid, "approved", row.amount_rupees); // [HF-APP-4]
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
  const lotsPart = Number(row.lots_paise ?? 0) > 0 || isFanPayoutRef(row.wallet_ref);
  if (lotsPart) { // [HF-WIRE-13] the wallet part was taken when the person asked; it must still be there (not returned) to be paid
    if ((await fanTakenPaise(env, id)) !== (Number(row.lots_paise ?? 0) || row.amount_rupees * 100)) return err(409, "needs_reconciliation", "The wallet part of this payout is missing. Nothing was marked paid.");
    const mf = await markFanPayoutPaid(env, row.host_uid, id);
    if (!mf.ok) return err(409, "needs_reconciliation", "The wallet part of this payout was returned or is missing. Nothing was marked paid.");
  }
  if (isHostLedgerRef(row.wallet_ref)) {
    const mp = await markPayoutPaid(env, row.host_uid, id);
    if (!mp.ok) return err(409, "needs_reconciliation", "The earnings reserve for this payout is missing or was cancelled. Nothing was marked paid.");
  } else if (isFanPayoutRef(row.wallet_ref)) {
    // wallet-only request: nothing else to settle
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
  await pushWithdrawal(env, undefined, row.host_uid, "paid", row.amount_rupees); // [HF-APP-4]
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
  const r = await releasePayoutMoney(env, row);
  if (r.status !== 200) return err(502, "wallet_error", "The wallet could not release that money. Nothing changed.");
  const up = await env.DB_META.prepare("UPDATE hf_payout_requests SET status='rejected', reject_reason=?2, admin_uid=?3, updated_at=?4 WHERE id=?1 AND status IN ('requested','approved')").bind(id, reason, a.uid, Date.now()).run();
  if (!up.meta?.changes) return err(409, "invalid_state", "This request changed. Refresh and try again.");
  await audit(env, a.uid, "rejected", id, { host: row.host_uid, amount: row.amount_rupees, reason });
  notifyHost(env, ctx, row.host_uid, row.exit === 1
    ? `Your ${BRAND.name} final withdrawal of ₹${row.amount_rupees} was not paid: ${reason}. Your account closure will continue.`
    : `Your ${BRAND.name} withdrawal of ₹${row.amount_rupees} was not paid: ${reason}. The money is back in your available balance.`);
  return json({ ok: true, status: "rejected" });
}

// ── Reels app adapter [HF-WIRE-10] (paise on the wire; additive, the host routes above are unchanged) ─────────────────────────────
//   GET  /api/hf/payouts/summary -> { readyPaise, onHoldPaise, minPaise, upi:{vpa,nameMatched}|null, kycStatus:'none'|'pending'|'verified',
//                                     history:[{id,at,amountPaise,status:'checking'|'paid'|'rejected',utr?}] }
//   PUT  /api/hf/payouts/upi {vpa} -> { ok, upi:{vpa,nameMatched} }
//   POST /api/hf/payouts {amountPaise} + Idempotency-Key -> { ok, id, status:'requested', amountPaise }
//        errors: 409 upi_required, 409 kyc_required {nextStep}, 400 invalid_amount|below_minimum, 402 insufficient_withdrawable, 429 weekly_limit
// [HF-WIRE-13] HF-REEL-36: ANYONE withdraws (fans too). readyPaise = the person's own wallet money (purchase lots; test credits never) + matured
// influencer earnings; minPaise is the fan minimum (hfFanPayoutMinRupees) unless earnings are the only money, then hfPayoutMinRupees.
const UPI_RE = /^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,32}$/;
const isInfluencerStatus = (s: string | null | undefined) => s === "live" || s === "approved";
const kycNextStep = () => ({ type: "kyc", title: "We check your ID once, before your first withdrawal.", url: brandUrl("/verify/id?next=%2Fdashboard%2Fwallet") }); // [HF-CLOSE-UPI-1] the ID check for everyone (fans too); /hosts/kyc is an info page
const maskVpa = (v: string) => { const [n, h] = v.split("@"); return `${n.length <= 2 ? n[0] : n.slice(0, 2)}${"*".repeat(Math.max(2, n.length - 2))}@${h}`; };

function appValidate(body: Record<string, unknown>): { ok: true; rupees: number } | { ok: false; error: string; message: string } {
  const p = Number(body.amountPaise);
  if (!Number.isInteger(p) || p <= 0 || p % 100 !== 0) return { ok: false, error: "invalid_amount", message: "Enter a whole number of rupees." };
  return { ok: true, rupees: p / 100 };
}

async function appSummary(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const c = await cfg(env);
  if (!c.enabled) return err(404, "not_enabled", "Withdrawals open soon.");
  const host = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ status: string }>().catch(() => null);
  const isInf = isInfluencerStatus(host?.status);
  let readyPaise = 0, onHoldPaise = 0, earningsReadyPaise = 0, walletReadyPaise = 0;
  try {
    if (isInf) {
      if (c.tokens) { const x = await hostSummary(env, u.uid); earningsReadyPaise = wholeRupees(x.availablePaise) * 100; onHoldPaise = x.pendingPaise; }
      else { const x = await withdrawableFor(env, u.uid); earningsReadyPaise = x.withdrawable * 100; onHoldPaise = x.held * 100; }
    }
    if (c.tokens) walletReadyPaise = await fanWithdrawablePaise(env, u.uid);
    readyPaise = earningsReadyPaise + walletReadyPaise;
  } catch (e) {
    await trackException(env, e, { uid: u.uid, route: "/api/hf/payouts/summary", handled: true, app_name: APP, extra: { area: "hf_payout", step: "summary" } });
    return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  const [kyc, pay, hist] = await Promise.all([
    env.DB_META.prepare("SELECT verified_at FROM hf_kyc WHERE uid=?1").bind(u.uid).first<{ verified_at: number | null }>().catch(() => null),
    env.DB_META.prepare("SELECT upi_enc, upi_verified FROM hf_payout WHERE uid=?1").bind(u.uid).first<{ upi_enc: string | null; upi_verified: number }>().catch(() => null),
    env.DB_META.prepare("SELECT * FROM hf_payout_requests WHERE host_uid=?1 ORDER BY created_at DESC LIMIT 50").bind(u.uid).all<PayoutRow>().catch(() => ({ results: [] as PayoutRow[] })),
  ]);
  const vpa = pay?.upi_enc ? await tryDecryptPii(env, pay.upi_enc) : null;
  const kycStatus = kyc?.verified_at ? "verified" : kyc ? "pending" : "none";
  const history = (hist.results ?? []).filter((r) => !isSystemRow(r) && r.status !== "cancelled").map((r) => ({
    id: r.id, at: r.created_at, amountPaise: r.amount_rupees * 100,
    status: r.status === "paid" ? "paid" : r.status === "rejected" ? "rejected" : "checking",
    ...(r.status === "paid" && r.utr ? { utr: r.utr } : {}),
  }));
  return json({
    readyPaise: Math.max(0, readyPaise), onHoldPaise: Math.max(0, onHoldPaise),
    minPaise: (isInf && walletReadyPaise === 0 ? c.minRupees : c.fanMinRupees) * 100,
    walletReadyPaise, earningsReadyPaise, isInfluencer: isInf, // [HF-WIRE-13]
    upi: vpa ? { vpa, nameMatched: pay?.upi_verified === 1 ? true : null } : null, kycStatus, history,
  }, 200, { "cache-control": "private, no-store" });
}

async function appPutUpi(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const c = await cfg(env);
  if (!c.enabled) return err(404, "not_enabled", "Withdrawals open soon.");
  const vpa = String((await readJson(req)).vpa ?? "").trim().toLowerCase();
  if (!UPI_RE.test(vpa)) return err(400, "invalid_upi", "Enter a valid UPI ID, like name@bank.");
  const lim = await rateLimit(env, `hfupi:${u.uid}`, 10, 3600);
  if (lim) return lim;
  const enc = await encryptPii(env, vpa);
  // Changing the UPI clears any earlier name check; a different destination must be re-verified. Bank columns are untouched.
  await env.DB_META.prepare(
    `INSERT INTO hf_payout (uid, upi_enc, upi_verified, updated_at) VALUES (?1,?2,0,?3)
     ON CONFLICT(uid) DO UPDATE SET upi_enc=excluded.upi_enc, upi_verified=0, updated_at=excluded.updated_at`,
  ).bind(u.uid, enc, Date.now()).run();
  void track(env, u.uid, "hf_payout_upi_set", APP, { vpa: maskVpa(vpa) });
  return json({ ok: true, upi: { vpa, nameMatched: null } });
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
  const ours = p === "/api/hosts/me/payouts" || p === "/api/hf/payouts/summary" || p === "/api/hf/payouts/upi" || p === "/api/hf/payouts" || !!hostCancelM || p === "/api/admin/hf/payouts" || !!adminM;
  if (!ours) return null;
  try {
    if (p === "/api/hosts/me/payouts" && m === "GET") return await hostGet(req, env);
    if (p === "/api/hosts/me/payouts" && m === "POST") return await hostCreate(req, env);
    if (p === "/api/hf/payouts/summary" && m === "GET") return await appSummary(req, env);
    if (p === "/api/hf/payouts/upi" && m === "PUT") return await appPutUpi(req, env);
    if (p === "/api/hf/payouts" && m === "POST") return await hostCreate(req, env, true);
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
