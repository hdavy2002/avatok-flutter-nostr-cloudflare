// [HF-WALLET-EXIT-1 2026-10-10] Refunds of UNUSED top-up money, back to the ORIGINAL payment. Rulebook: HF-PAY-15 (and HF-PAY-5).
// Flow: the caller asks (or the account-closure flow asks for them) -> the amount is RESERVED in the WalletDO -> an admin approves ->
// we call the gateway adapter's refund() once per top-up slice -> when every slice is refunded the reservation is CONSUMED.
// reject / cancel RELEASE the reservation. If the gateway refuses (or the top-up is too old) an admin can mark the request
// "paid manually" with a bank reference (UTR) instead.
//
// WHAT IS REFUNDABLE. Money that came from the caller's own top-ups and is still unspent. The WalletDO paid balance mixes three things:
// the caller's top-ups, a host's call earnings (withdrawn through payouts, never refunded), and nothing else (test credits live in
// hf_credits and never touch the wallet). So
//   callerMoney = (balance + held) - (host earnings still in the wallet) - (money already set aside for open refunds)
//   host earnings still in the wallet = sum(hf_calls.host_paid_rupees) - sum(payouts already PAID)
// and the refundable amount is allocated NEWEST top-up first, each top-up only within the refund window (180 days from paying) and
// only up to its own unspent part. FIFO assumption: spending consumes the OLDEST top-ups first, so what is left sits in the newest ones.
import type { Env } from "../types";
import { walletOp } from "../routes/wallet";
import { resolveGateway } from "./payments/registry";
import { WALLET_APP, walletPaid } from "./hf_payouts";
import { sendWhatsAppText } from "./whatsapp_send";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { trackException, track } from "../hooks";
import { BRAND } from "./brand";

export const DAY_MS = 86_400_000;
export const DEFAULT_REFUND_WINDOW_DAYS = 180;

export type RefundStatus = "requested" | "approved" | "processing" | "refunded" | "failed" | "rejected" | "cancelled";
export const REFUND_STATUSES: RefundStatus[] = ["requested", "approved", "processing", "refunded", "failed", "rejected", "cancelled"];
/** Statuses whose reservation is still held in the wallet. */
export const OPEN_REFUND_STATUSES: RefundStatus[] = ["requested", "approved", "processing", "failed"];
const OPEN_SQL = OPEN_REFUND_STATUSES.map((s) => `'${s}'`).join(",");

// pending = not sent yet. submitting = WRITTEN BEFORE the gateway call, so a crash leaves proof we may have sent it.
// needs_check = it was "submitting" and the gateway could not tell us whether the refund exists: a person must check, we never auto-resend.
// failed = the gateway cleanly refused (safe to send again). refunded / manual = done.
export type AllocStatus = "pending" | "submitting" | "needs_check" | "refunded" | "manual" | "failed";
const ALLOC_STATUSES: AllocStatus[] = ["pending", "submitting", "needs_check", "refunded", "manual", "failed"];
export interface Allocation { topupId: string | null; rupees: number; status: AllocStatus; gatewayRefundId?: string | null; error?: string; attemptAt?: number }
const isDone = (a: Allocation) => a.status === "refunded" || a.status === "manual";

export const refundRef = (id: string) => `hfrefund:${id}`;
export const refundReserveOp = (id: string) => `hfrefund_res:${id}`;
export const refundPayOp = (id: string) => `hfrefund_pay:${id}`;
export const refundReleaseOp = (id: string) => `hfrefund_rel:${id}`;
/**
 * OUR per-slice id: one per (request, top-up). It is the gateway's idempotency key AND the field we search by afterwards (Razorpay receipt +
 * notes.slice_id, Cashfree refund_id, Paytm refId), so it is short (<= 40) and only [A-Za-z0-9_] -- Cashfree and Razorpay both limit it.
 */
export const gatewayRefundOpId = (id: string, topupId: string) => `hfr_${id.replace(/-/g, "").slice(0, 10)}_${topupId.replace(/^hftop_/, "")}`;

export interface RefundRow {
  id: string; uid: string; amount_rupees: number; status: RefundStatus; reason: string | null; wallet_ref: string | null; allocations: string;
  utr: string | null; admin_uid: string | null; exit: number; created_at: number; updated_at: number; refunded_at: number | null;
}

export function parseAllocations(s: string | null | undefined): Allocation[] {
  try {
    const j = JSON.parse(s || "[]");
    if (!Array.isArray(j)) return [];
    return j.map((a: Record<string, unknown>) => ({
      topupId: typeof a.topupId === "string" ? a.topupId : null,
      rupees: Math.max(0, Math.floor(Number(a.rupees) || 0)),
      status: ((ALLOC_STATUSES as string[]).includes(String(a.status)) ? a.status : "pending") as AllocStatus,
      gatewayRefundId: typeof a.gatewayRefundId === "string" ? a.gatewayRefundId : null,
      error: typeof a.error === "string" ? a.error : undefined,
      attemptAt: typeof a.attemptAt === "number" ? a.attemptAt : undefined,
    }));
  } catch { return []; }
}

// ── pure ─────────────────────────────────────────────────────────────────────
export interface TopupSlice {
  id: string; amount_rupees: number; refunded_rupees: number | null; paid_at: number | null;
  /** Rupees already promised to OTHER open refund requests (not yet refunded). */
  pending?: number;
}
const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

export const topupRemaining = (t: TopupSlice): number => whole(t.amount_rupees - whole(Number(t.refunded_rupees ?? 0)) - whole(t.pending ?? 0));

/**
 * Pure. Spread `want` rupees over the top-ups, NEWEST first. `windowDays` null = no age limit (account closure).
 * `eligibleTotal` is the most that could be refunded at all (sum of in-window unspent parts).
 */
export function allocateRefund(topups: TopupSlice[], want: number, now: number, windowDays: number | null): { allocations: { topupId: string; rupees: number }[]; total: number; eligibleTotal: number } {
  const eligible = topups
    .filter((t) => t.paid_at != null && (windowDays == null || now - Number(t.paid_at) <= windowDays * DAY_MS))
    .map((t) => ({ t, left: topupRemaining(t) }))
    .filter((x) => x.left > 0)
    .sort((a, b) => Number(b.t.paid_at) - Number(a.t.paid_at) || (a.t.id < b.t.id ? 1 : -1));
  const eligibleTotal = eligible.reduce((s, x) => s + x.left, 0);
  let need = whole(want);
  const allocations: { topupId: string; rupees: number }[] = [];
  for (const x of eligible) {
    if (need <= 0) break;
    const take = Math.min(x.left, need);
    allocations.push({ topupId: x.t.id, rupees: take });
    need -= take;
  }
  return { allocations, total: allocations.reduce((s, a) => s + a.rupees, 0), eligibleTotal };
}

/** Pure. Money in the wallet that is the caller's own (not host earnings, not already set aside). May be negative: callers clamp. */
export function rawCallerMoney(i: { balance: number; held: number; totalHostPaid: number; paidPayouts: number; openRefundReserved: number }): number {
  const hostInWallet = Math.max(0, whole(i.totalHostPaid) - whole(i.paidPayouts));
  return whole(i.balance) + whole(i.held) - hostInWallet - whole(i.openRefundReserved);
}

export const canApproveRefund = (s: string) => s === "requested" || s === "approved" || s === "failed";
export const canCancelRefund = (s: string) => s === "requested";
export const canRejectRefund = (s: string) => s === "requested" || s === "approved" || s === "failed";
export const canPayManually = (s: string) => s === "requested" || s === "approved" || s === "failed";

// ── D1 + wallet ──────────────────────────────────────────────────────────────
interface TopupDbRow { id: string; amount_rupees: number; refunded_rupees: number | null; paid_at: number | null; gateway: string; gateway_order_id: string | null }

export async function getRefund(env: Env, id: string): Promise<RefundRow | null> {
  return (await env.DB_META.prepare("SELECT * FROM hf_refund_requests WHERE id=?1").bind(id).first<RefundRow>().catch(() => null)) ?? null;
}

async function paidTopups(env: Env, uid: string): Promise<TopupDbRow[]> {
  return (await env.DB_META.prepare(
    "SELECT id, amount_rupees, refunded_rupees, paid_at, gateway, gateway_order_id FROM hf_topups WHERE uid=?1 AND status='paid' AND credited=1 ORDER BY paid_at DESC",
  ).bind(uid).all<TopupDbRow>()).results ?? [];
}

async function openRefunds(env: Env, uid: string): Promise<RefundRow[]> {
  return (await env.DB_META.prepare(`SELECT * FROM hf_refund_requests WHERE uid=?1 AND status IN (${OPEN_SQL})`).bind(uid).all<RefundRow>()).results ?? [];
}

export interface Refundable {
  /** What the user may ask for right now (whole rupees). */
  refundable: number;
  /** Unclamped caller money (negative = open reservations already exceed it). */
  rawCallerMoney: number;
  callerMoney: number;
  /** In-window unspent top-up money (ceiling before the wallet cap). */
  eligibleTotal: number;
  /** Wallet money that could be returned but is outside the allocation (older than the window, or no top-up behind it). */
  beyondWindow: number;
  allocations: { topupId: string; rupees: number }[];
  /** Per top-up rupees promised to open requests, for the post-insert race check. */
  pendingByTopup: Map<string, number>;
  walletBalance: number;
  walletHeld: number;
}

/** Throws when the wallet cannot be read (money screens must not guess). `windowDays` null = unlimited (closure). */
export async function refundableFor(env: Env, uid: string, windowDays: number | null, now = Date.now(), wantOverride?: number): Promise<Refundable> {
  const [w, host, paidOut, open, topups] = await Promise.all([
    walletPaid(env, uid),
    env.DB_META.prepare("SELECT COALESCE(SUM(host_paid_rupees),0) AS s FROM hf_calls WHERE host_uid=?1 AND host_paid_rupees IS NOT NULL").bind(uid).first<{ s: number }>().catch(() => null),
    env.DB_META.prepare("SELECT COALESCE(SUM(amount_rupees),0) AS s FROM hf_payout_requests WHERE host_uid=?1 AND status='paid'").bind(uid).first<{ s: number }>().catch(() => null),
    openRefunds(env, uid),
    paidTopups(env, uid),
  ]);
  const pendingByTopup = new Map<string, number>();
  let openReserved = 0;
  for (const r of open) {
    openReserved += r.amount_rupees;
    for (const a of parseAllocations(r.allocations)) {
      if (a.topupId && !isDone(a)) pendingByTopup.set(a.topupId, (pendingByTopup.get(a.topupId) ?? 0) + a.rupees);
    }
  }
  const raw = rawCallerMoney({ balance: w.balance, held: w.held, totalHostPaid: Number(host?.s ?? 0), paidPayouts: Number(paidOut?.s ?? 0), openRefundReserved: openReserved });
  const callerMoney = Math.max(0, raw);
  const slices: TopupSlice[] = topups.map((t) => ({ ...t, pending: pendingByTopup.get(t.id) ?? 0 }));
  const full = allocateRefund(slices, callerMoney, now, windowDays);
  const want = wantOverride == null ? callerMoney : Math.min(callerMoney, whole(wantOverride));
  const a = want === callerMoney ? full : allocateRefund(slices, want, now, windowDays);
  return {
    refundable: full.total, rawCallerMoney: raw, callerMoney, eligibleTotal: full.eligibleTotal,
    beyondWindow: Math.max(0, callerMoney - full.total), allocations: a.allocations, pendingByTopup,
    walletBalance: w.balance, walletHeld: w.held,
  };
}

export type CreateRefundResult = { ok: true; id: string; amount: number } | { ok: false; status: number; error: string; message: string };

/**
 * Create a refund request and set the money aside. `exit` (account closure): no age limit on top-ups, and any wallet money that no
 * top-up can carry is added as a manual-only slice so an admin pays it by hand. Normal requests: window applies, amount optional.
 */
export async function createRefundRequest(env: Env, uid: string, o: { exit: boolean; amount?: number; windowDays: number }): Promise<CreateRefundResult> {
  const no = (status: number, error: string, message: string): CreateRefundResult => ({ ok: false, status, error, message });
  let r: Refundable;
  try { r = await refundableFor(env, uid, o.exit ? null : o.windowDays); }
  catch (e) {
    await trackException(env, e, { uid, route: "hf_refunds.create", handled: true, app_name: WALLET_APP, extra: { area: "hf_refund", step: "refundable" } });
    return no(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  let amount: number;
  if (o.exit) amount = r.callerMoney;
  else {
    if (o.amount == null && r.refundable <= 0) return no(402, "nothing_refundable", "There is no unused top-up money to refund.");
    amount = o.amount == null ? r.refundable : Number(o.amount);
    if (!Number.isInteger(amount) || amount <= 0) return no(400, "invalid_amount", "Enter a whole number of rupees.");
    if (amount > r.refundable) return no(402, "insufficient_refundable", `You can ask for up to ₹${r.refundable} back.`);
  }
  if (amount <= 0) return no(402, "nothing_refundable", "There is no unused top-up money to refund.");
  const slices = (await paidTopups(env, uid)).map((t) => ({ ...t, pending: r.pendingByTopup.get(t.id) ?? 0 }));
  const alloc = allocateRefund(slices, amount, Date.now(), o.exit ? null : o.windowDays);
  const allocations: Allocation[] = alloc.allocations.map((a) => ({ topupId: a.topupId, rupees: a.rupees, status: "pending" }));
  if (o.exit && alloc.total < amount) allocations.push({ topupId: null, rupees: amount - alloc.total, status: "pending", error: "manual_only" });
  if (!o.exit && alloc.total !== amount) return no(402, "insufficient_refundable", `You can ask for up to ₹${alloc.total} back.`);

  const id = crypto.randomUUID();
  const ref = refundRef(id);
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO hf_refund_requests (id, uid, amount_rupees, status, wallet_ref, allocations, exit, created_at, updated_at) VALUES (?1,?2,?3,'requested',?4,?5,?6,?7,?7)`,
  ).bind(id, uid, amount, ref, JSON.stringify(allocations), o.exit ? 1 : 0, now).run();

  const abort = async (code: string, status: number, message: string) => {
    await env.DB_META.prepare("UPDATE hf_refund_requests SET status='cancelled', reason=?2, updated_at=?3 WHERE id=?1 AND status='requested'").bind(id, `system:${code}`, Date.now()).run();
    return no(status, code, message);
  };
  // Row first, THEN re-check including it: two concurrent requests cannot both fit.
  let after: Refundable;
  try { after = await refundableFor(env, uid, o.exit ? null : o.windowDays); }
  catch { return abort("wallet_error", 502, "We couldn't check your balance. Please try again."); }
  if (after.rawCallerMoney < 0) return abort("insufficient_refundable", 402, "That amount is no longer available.");
  const topupAmt = new Map((await paidTopups(env, uid)).map((t) => [t.id, t.amount_rupees - Number(t.refunded_rupees ?? 0)]));
  for (const [tid, pend] of after.pendingByTopup) if (pend > (topupAmt.get(tid) ?? 0)) return abort("insufficient_refundable", 402, "That amount is no longer available.");

  const res = await walletOp(env, uid, { op: "reserve", uid, amount, ref, allow_free: false, op_id: refundReserveOp(id), app_name: WALLET_APP });
  if (res.status !== 200 || res.body?.ok === false) {
    const short = res.status === 402;
    return abort(short ? "insufficient_refundable" : "wallet_error", short ? 402 : 502, short ? "That amount is not available right now." : "We couldn't set that money aside. Please try again.");
  }
  void track(env, uid, "hf_refund_requested", WALLET_APP, { amount, exit: o.exit });
  return { ok: true, id, amount };
}

/** Best-effort WhatsApp to the user. Never throws. */
export async function notifyUser(env: Env, uid: string, text: string): Promise<void> {
  try {
    const e164 = await verifiedWhatsAppNumber(env, uid);
    if (e164) await sendWhatsAppText(env, e164, text);
  } catch (e) {
    await trackException(env, e, { route: "hf_refunds.notify", handled: true, app_name: WALLET_APP, extra: { area: "hf_refund" } });
  }
}

export type ActionResult = { ok: true; status: RefundStatus; replay?: boolean; detail?: Allocation[] } | { ok: false; status: number; error: string; message: string };
const bad = (status: number, error: string, message: string): ActionResult => ({ ok: false, status, error, message });

/** Persist one allocation change together with the top-up's refunded_rupees (only when it newly became refunded/manual). Atomic. */
async function persistAlloc(env: Env, row: RefundRow, allocs: Allocation[], idx: number, creditTopup: boolean): Promise<void> {
  const stmts = [env.DB_META.prepare("UPDATE hf_refund_requests SET allocations=?2, updated_at=?3 WHERE id=?1").bind(row.id, JSON.stringify(allocs), Date.now())];
  const a = allocs[idx];
  if (creditTopup && a.topupId) stmts.push(env.DB_META.prepare("UPDATE hf_topups SET refunded_rupees=COALESCE(refunded_rupees,0)+?2, updated_at=?3 WHERE id=?1").bind(a.topupId, a.rupees, Date.now()));
  await env.DB_META.batch(stmts);
}

async function consumeReservation(env: Env, row: RefundRow): Promise<boolean> {
  const r = await walletOp(env, row.uid, {
    op: "consume_reserved", uid: row.uid, amount: row.amount_rupees, ref: refundRef(row.id), allow_free: false, type: "refund", app_name: WALLET_APP, op_id: refundPayOp(row.id),
    ledger: { debit: `user:${row.uid}`, credit: "external:hf_refund", type: "refund", ref: refundRef(row.id) },
  });
  return r.status === 200 && Number(r.body?.consumed ?? 0) === row.amount_rupees;
}

const AMBIGUOUS_ERRORS = ["gateway_unreachable"];

/** Ask the gateway whether a slice we may already have sent exists. */
async function lookupSlice(env: Env, id: string, a: Allocation): Promise<{ found: boolean; gateway_refund_id: string | null } | null> {
  const t = await env.DB_META.prepare("SELECT gateway, gateway_order_id FROM hf_topups WHERE id=?1").bind(a.topupId).first<{ gateway: string; gateway_order_id: string | null }>().catch(() => null);
  const adapter = t ? resolveGateway(t.gateway) : null;
  if (!t || !t.gateway_order_id || !adapter?.listRefunds || !adapter.configured(env)) return null;
  try { return await adapter.listRefunds(env, { gatewayOrderId: t.gateway_order_id, opId: gatewayRefundOpId(id, a.topupId!) }); } catch { return null; }
}

/**
 * Approve and run (also used for retry). Per slice:
 *  1. status is written as "submitting" BEFORE the gateway call;
 *  2. a slice found in "submitting"/"needs_check" is NEVER re-sent on its own: the gateway is asked for an existing refund with our slice id.
 *     Found -> recorded. Gateway says none exists -> sent. Cannot tell -> "needs_check" for a person.
 *  3. `resubmit` (admin confirmed in the UI) lists needs_check slices to send again anyway (the gateway's idempotency key still guards it).
 */
export async function processRefund(env: Env, id: string, adminUid: string, o: { resubmit?: string[] } = {}): Promise<ActionResult> {
  const row = await getRefund(env, id);
  if (!row) return bad(404, "not_found", "Not found.");
  if (row.status === "refunded") return { ok: true, status: "refunded", replay: true };
  if (row.status === "processing") return bad(409, "in_progress", "This refund is being processed. Refresh in a moment.");
  if (!canApproveRefund(row.status)) return bad(409, "invalid_state", `This request is ${row.status}.`);
  const claim = await env.DB_META.prepare("UPDATE hf_refund_requests SET status='processing', admin_uid=?2, updated_at=?3 WHERE id=?1 AND status IN ('requested','approved','failed')").bind(id, adminUid, Date.now()).run();
  if (!claim.meta?.changes) return bad(409, "invalid_state", "This request changed. Refresh and try again.");

  const allocs = parseAllocations(row.allocations);
  const resubmit = new Set(o.resubmit ?? []);
  let failures = 0;
  const finish = async (i: number) => { allocs[i].status = "refunded"; delete allocs[i].error; await persistAlloc(env, row, allocs, i, true); };
  for (let i = 0; i < allocs.length; i++) {
    const a = allocs[i];
    if (isDone(a)) continue;
    if (!a.topupId) { a.status = "failed"; a.error = "manual_only"; failures++; continue; }
    let mayHaveBeenSent = (a.status === "submitting" || a.status === "needs_check") && !a.gatewayRefundId;
    if (a.status === "needs_check" && resubmit.has(a.topupId)) mayHaveBeenSent = false; // a person confirmed: send again
    if (mayHaveBeenSent) {
      const found = await lookupSlice(env, id, a);
      if (found?.found) { a.gatewayRefundId = found.gateway_refund_id; await finish(i); continue; }
      if (!found) { a.status = "needs_check"; a.error = "gateway_could_not_confirm"; await persistAlloc(env, row, allocs, i, false); failures++; continue; }
      // found.found === false: the gateway positively has no such refund, so sending is safe
    }
    const t = await env.DB_META.prepare("SELECT gateway, gateway_order_id FROM hf_topups WHERE id=?1").bind(a.topupId).first<{ gateway: string; gateway_order_id: string | null }>().catch(() => null);
    const adapter = t ? resolveGateway(t.gateway) : null;
    if (!t || !t.gateway_order_id || !adapter || !adapter.configured(env)) { a.status = "failed"; a.error = "gateway_unavailable"; failures++; continue; }
    a.status = "submitting"; a.attemptAt = Date.now(); delete a.error;
    await persistAlloc(env, row, allocs, i, false); // durable BEFORE the call
    let out: { accepted: boolean; gateway_refund_id: string | null; error?: string };
    try {
      out = await adapter.refund(env, { gatewayOrderId: t.gateway_order_id, amountPaise: a.rupees * 100, reason: `${BRAND.name} wallet refund`, opId: gatewayRefundOpId(id, a.topupId) });
    } catch (e) { out = { accepted: false, gateway_refund_id: null, error: "gateway_unreachable" }; }
    if (out.accepted) { a.gatewayRefundId = out.gateway_refund_id; await finish(i); continue; }
    a.error = (out.error ?? "refused").slice(0, 80);
    // A clean refusal is safe to send again. A timeout / unreachable gateway is not: the request may have gone through.
    a.status = AMBIGUOUS_ERRORS.includes(a.error) ? "needs_check" : "failed";
    await persistAlloc(env, row, allocs, i, false);
    failures++;
  }
  if (failures > 0) {
    await env.DB_META.prepare("UPDATE hf_refund_requests SET status='failed', allocations=?2, reason=?3, updated_at=?4 WHERE id=?1").bind(id, JSON.stringify(allocs), "system:gateway_failed", Date.now()).run();
    return { ok: true, status: "failed", detail: allocs };
  }
  if (!(await consumeReservation(env, row))) {
    await env.DB_META.prepare("UPDATE hf_refund_requests SET status='failed', allocations=?2, reason=?3, updated_at=?4 WHERE id=?1").bind(id, JSON.stringify(allocs), "system:needs_reconciliation", Date.now()).run();
    return { ok: true, status: "failed", detail: allocs };
  }
  const now = Date.now();
  await env.DB_META.prepare("UPDATE hf_refund_requests SET status='refunded', allocations=?2, reason=NULL, refunded_at=?3, updated_at=?3 WHERE id=?1").bind(id, JSON.stringify(allocs), now).run();
  await notifyUser(env, row.uid, `Your ${BRAND.name} refund of ₹${row.amount_rupees} has been sent back to the payment you used. Banks can take a few days to show it.`);
  return { ok: true, status: "refunded", detail: allocs };
}

/** An admin checked the gateway dashboard and saw this slice was sent: record it (credits the top-up once), then finish the request. */
export async function markSliceSent(env: Env, id: string, adminUid: string, topupId: string, gatewayRefundId: string | null): Promise<ActionResult> {
  const row = await getRefund(env, id);
  if (!row) return bad(404, "not_found", "Not found.");
  if (row.status === "processing") return bad(409, "in_progress", "This refund is being processed. Refresh in a moment.");
  if (!canApproveRefund(row.status) && row.status !== "refunded") return bad(409, "invalid_state", `This request is ${row.status}.`);
  const allocs = parseAllocations(row.allocations);
  const i = allocs.findIndex((a) => a.topupId === topupId);
  if (i < 0) return bad(404, "no_such_slice", "That part of the refund does not exist.");
  if (!isDone(allocs[i])) {
    // Claim the row so a concurrent approve cannot run while we edit.
    const claim = await env.DB_META.prepare("UPDATE hf_refund_requests SET status='processing', admin_uid=?2, updated_at=?3 WHERE id=?1 AND status IN ('requested','approved','failed')").bind(id, adminUid, Date.now()).run();
    if (!claim.meta?.changes) return bad(409, "invalid_state", "This request changed. Refresh and try again.");
    allocs[i].status = "refunded"; allocs[i].gatewayRefundId = gatewayRefundId; delete allocs[i].error;
    await persistAlloc(env, row, allocs, i, true);
    await env.DB_META.prepare("UPDATE hf_refund_requests SET status='failed', updated_at=?2 WHERE id=?1 AND status='processing'").bind(id, Date.now()).run();
  }
  return processRefund(env, id, adminUid);
}

/** Admin paid the user by hand (gateway refused, or the top-up is past the window). */
export async function markPaidManually(env: Env, id: string, adminUid: string, utr: string): Promise<ActionResult> {
  const row = await getRefund(env, id);
  if (!row) return bad(404, "not_found", "Not found.");
  if (row.status === "refunded") return row.utr === utr ? { ok: true, status: "refunded", replay: true } : bad(409, "already_refunded", "This request is already settled.");
  if (!canPayManually(row.status)) return bad(409, "invalid_state", row.status === "processing" ? "This refund is being processed. Refresh in a moment." : `This request is ${row.status}.`);
  const dup = await env.DB_META.prepare("SELECT id FROM hf_refund_requests WHERE utr=?1 AND id<>?2 LIMIT 1").bind(utr, id).first().catch(() => null);
  if (dup) return bad(409, "duplicate_utr", "That UTR is already recorded on another refund.");
  const claim = await env.DB_META.prepare("UPDATE hf_refund_requests SET status='processing', admin_uid=?2, updated_at=?3 WHERE id=?1 AND status IN ('requested','approved','failed')").bind(id, adminUid, Date.now()).run();
  if (!claim.meta?.changes) return bad(409, "invalid_state", "This request changed. Refresh and try again.");
  if (!(await consumeReservation(env, row))) {
    await env.DB_META.prepare("UPDATE hf_refund_requests SET status='failed', reason='system:needs_reconciliation', updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
    return bad(409, "needs_reconciliation", "The wallet could not take that money. Nothing was marked paid; check the wallet before paying.");
  }
  const allocs = parseAllocations(row.allocations);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const a of allocs) {
    if (a.status === "refunded" || a.status === "manual") continue;
    a.status = "manual"; delete a.error;
    if (a.topupId) stmts.push(env.DB_META.prepare("UPDATE hf_topups SET refunded_rupees=COALESCE(refunded_rupees,0)+?2, updated_at=?3 WHERE id=?1").bind(a.topupId, a.rupees, now));
  }
  stmts.push(env.DB_META.prepare("UPDATE hf_refund_requests SET status='refunded', allocations=?2, utr=?3, reason=NULL, refunded_at=?4, updated_at=?4 WHERE id=?1").bind(id, JSON.stringify(allocs), utr, now));
  await env.DB_META.batch(stmts);
  await notifyUser(env, row.uid, `Your ${BRAND.name} refund of ₹${row.amount_rupees} has been paid to you. Bank reference (UTR): ${utr}.`);
  return { ok: true, status: "refunded", detail: allocs };
}

export async function rejectRefund(env: Env, id: string, adminUid: string, reason: string): Promise<ActionResult> {
  const row = await getRefund(env, id);
  if (!row) return bad(404, "not_found", "Not found.");
  if (row.status === "rejected") return { ok: true, status: "rejected", replay: true };
  if (!canRejectRefund(row.status)) return bad(409, "invalid_state", `This request is ${row.status}.`);
  if (parseAllocations(row.allocations).some((a) => a.status === "refunded" || a.status === "manual" || a.status === "submitting" || a.status === "needs_check")) {
    return bad(409, "partly_refunded", "Part of this refund already went out. Retry it or mark it paid by hand instead.");
  }
  const r = await walletOp(env, row.uid, { op: "release_reservation", uid: row.uid, ref: refundRef(id), op_id: refundReleaseOp(id), app_name: WALLET_APP });
  if (r.status !== 200) return bad(502, "wallet_error", "The wallet could not release that money. Nothing changed.");
  const up = await env.DB_META.prepare("UPDATE hf_refund_requests SET status='rejected', reason=?2, admin_uid=?3, updated_at=?4 WHERE id=?1 AND status IN ('requested','approved','failed')").bind(id, reason, adminUid, Date.now()).run();
  if (!up.meta?.changes) return bad(409, "invalid_state", "This request changed. Refresh and try again.");
  await notifyUser(env, row.uid, `Your ${BRAND.name} refund request of ₹${row.amount_rupees} was not processed: ${reason}. The money is still in your wallet.`);
  return { ok: true, status: "rejected" };
}

export async function cancelRefund(env: Env, id: string, uid: string, viaExit = false): Promise<ActionResult> {
  const row = await getRefund(env, id);
  if (!row || row.uid !== uid) return bad(404, "not_found", "Not found.");
  if (row.status === "cancelled") return { ok: true, status: "cancelled", replay: true };
  if (row.exit === 1 && !viaExit) return bad(409, "exit_request", "This refund belongs to your account closure. Cancel the closure instead.");
  if (!canCancelRefund(row.status)) return bad(409, "not_cancellable", "This request can no longer be cancelled.");
  const r = await walletOp(env, uid, { op: "release_reservation", uid, ref: refundRef(id), op_id: refundReleaseOp(id), app_name: WALLET_APP });
  if (r.status !== 200) return bad(502, "wallet_error", "We couldn't release that money. Please try again.");
  const up = await env.DB_META.prepare("UPDATE hf_refund_requests SET status='cancelled', updated_at=?2 WHERE id=?1 AND status='requested'").bind(id, Date.now()).run();
  if (!up.meta?.changes) return bad(409, "not_cancellable", "This request was just approved, so it can no longer be cancelled.");
  return { ok: true, status: "cancelled" };
}

/**
 * Refund webhook: the gateway says a payment for hftop_ order was refunded. If one of OUR requests initiated it, the slice is already
 * marked and nothing more is debited (the wallet was debited once, at consume_reserved). Otherwise it is an out-of-band refund
 * (done in the gateway dashboard): record it for the admin and do NOT touch the wallet. Returns what happened for logging.
 */
export async function noteGatewayRefund(env: Env, topupId: string): Promise<"ours" | "external"> {
  const ours = await env.DB_META.prepare("SELECT id FROM hf_refund_requests WHERE allocations LIKE ?1 AND status IN ('processing','refunded','failed') LIMIT 1")
    .bind(`%${topupId}%`).first().catch(() => null);
  await env.DB_META.prepare("UPDATE hf_topups SET raw_status='refunded', updated_at=?2 WHERE id=?1").bind(topupId, Date.now()).run().catch(() => undefined);
  return ours ? "ours" : "external";
}
