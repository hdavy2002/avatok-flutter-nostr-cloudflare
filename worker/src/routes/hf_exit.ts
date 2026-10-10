// [HF-WALLET-EXIT-1 2026-10-10] Pay-out-first account closure. Rulebook: HF-PAY-14. Logic: lib/hf_exit.ts. Gate: routes/account.ts deleteAccount.
//   GET    /api/hf/account/exit  -> { gateEnabled, decision:"delete"|"exit", paidBalance, withdrawable, held, heldReleaseAt, refundable, manualRefund,
//                                    forfeitRupees, bankOk, testCredits, testEarnings, exit:{status,...}|null, payout|null, refund|null, deletion|null }
//   POST   /api/hf/account/exit {forfeit?}   (Idempotency-Key required) -> { ok, status, payoutId, refundId }
//          409 nothing_to_settle | forfeit_required {forfeitRupees} | bank_required; 502 wallet_error
//   DELETE /api/hf/account/exit  -> { ok }   only while nothing has been approved or paid; 409 cannot_cancel
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { withIdempotency, rateLimit } from "../money";
import { trackException } from "../hooks";
import { exitFlags, exitSummary, decideDeletion, startExit, cancelExit, getExitRow } from "../lib/hf_exit";
import { refundIdsOf } from "../lib/hf_exit_tokens"; // [HF-TOK-EXIT-1]
import { scheduleDeletion } from "./account";

const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => json({ error, message: message ?? error, ...extra }, status);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 2_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

interface PlayRow { id: string; status: string; amount_paise: number | null; amount_rupees: number; reason: string | null }
const REFUND_TERMINAL = ["refunded", "rejected", "cancelled"];
async function aggregateTokenRefund(env: Env, ids: string[]): Promise<{ id: string; amount: number; status: string; reason: string | null; utr: string | null } | null> {
  if (ids.length === 0) return null;
  const rows = (await Promise.all(ids.map((id) => env.DB_META.prepare("SELECT id, status, amount_paise, amount_rupees, reason FROM hf_refund_requests WHERE id=?1").bind(id).first<PlayRow>().catch(() => null)))).filter((r): r is PlayRow => !!r);
  if (rows.length === 0) return null;
  const paise = rows.reduce((t, r) => t + Number(r.amount_paise ?? r.amount_rupees * 100), 0);
  const all = (st: string) => rows.every((r) => r.status === st);
  const status = all("refunded") ? "refunded" : all("rejected") ? "rejected" : all("cancelled") ? "cancelled"
    : rows.some((r) => r.status === "requested") && !rows.some((r) => ["approved", "processing", "failed"].includes(r.status)) ? "requested"
    : rows.every((r) => REFUND_TERMINAL.includes(r.status)) ? "refunded" : "processing";
  return { id: rows[0].id, amount: paise / 100, status, reason: rows.find((r) => r.status === "rejected")?.reason ?? null, utr: null };
}

async function get(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const f = await exitFlags(env);
  let s;
  try { s = await exitSummary(env, u.uid); }
  catch (e) {
    await trackException(env, e, { uid: u.uid, route: "/api/hf/account/exit", handled: true, extra: { area: "hf_exit" } });
    return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  const payout = s.exit?.payoutId
    ? await env.DB_META.prepare("SELECT id, amount_rupees, status, reject_reason, utr FROM hf_payout_requests WHERE id=?1").bind(s.exit.payoutId).first<{ id: string; amount_rupees: number; status: string; reject_reason: string | null; utr: string | null }>().catch(() => null)
    : null;
  // [HF-TOK-EXIT-1] A token closure has one play_refund per purchase lot: the page shows them as ONE refund (sum, and the least finished status).
  const exitRow = s.tokensInfo ? await getExitRow(env, u.uid) : null;
  const tokenRefund = exitRow && exitRow.refund_ids != null ? await aggregateTokenRefund(env, refundIdsOf(exitRow.refund_ids)) : null;
  const refund = tokenRefund ? null : s.exit?.refundId
    ? await env.DB_META.prepare("SELECT id, amount_rupees, status, reason, utr FROM hf_refund_requests WHERE id=?1").bind(s.exit.refundId).first<{ id: string; amount_rupees: number; status: string; reason: string | null; utr: string | null }>().catch(() => null)
    : null;
  const del = await env.DB_META.prepare("SELECT status, scheduled_at FROM deletion_requests WHERE uid=?1").bind(u.uid).first<{ status: string; scheduled_at: number }>().catch(() => null);
  return json({
    gateEnabled: f.gateEnabled,
    decision: decideDeletion({ gateEnabled: f.gateEnabled, isHfUser: s.isHfUser, hasMoney: s.hasMoney, exitStatus: s.exit?.status ?? null }),
    paidBalance: s.paidBalance, withdrawable: s.withdrawable, held: s.held, heldReleaseAt: s.heldReleaseAt, refundable: s.refundable, manualRefund: s.manualRefund,
    forfeitRupees: s.forfeitRupees, bankOk: s.bankOk, testCredits: s.testCredits, testEarnings: s.testEarnings,
    exit: s.exit,
    payout: payout ? { id: payout.id, amount: payout.amount_rupees, status: payout.status, reason: payout.status === "rejected" ? payout.reject_reason : null, utr: payout.status === "paid" ? payout.utr : null } : null,
    ...(s.tokensInfo ? { mode: "tokens", tokens: s.tokensInfo } : {}),
    refund: tokenRefund ? tokenRefund : refund ? { id: refund.id, amount: refund.amount_rupees, status: refund.status === "failed" || refund.status === "approved" ? "processing" : refund.status, reason: refund.status === "rejected" ? refund.reason : null, utr: refund.status === "refunded" ? refund.utr : null } : null,
    deletion: del && del.status === "pending" ? { status: del.status, scheduledAt: del.scheduled_at } : null,
  });
}

async function post(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const f = await exitFlags(env);
  if (!f.gateEnabled) return err(404, "not_enabled", "Closing your account this way is not open.");
  const lim = await rateLimit(env, `hfexit:${u.uid}`, 6, 3600);
  if (lim) return lim;
  const body = await readJson(req);
  return withIdempotency(req, env, u.uid, async () => {
    const r = await startExit(env, u.uid, { forfeit: body.forfeit === true, trigger: scheduleDeletion });
    if (!r.ok) return err(r.status, r.error, r.message, r.forfeitRupees != null ? { forfeitRupees: r.forfeitRupees } : {});
    return json({ ok: true, status: r.status, payoutId: r.payoutId, refundId: r.refundId, ...(r.replay ? { replay: true } : {}) });
  });
}

async function del(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const r = await cancelExit(env, u.uid);
  return r.ok ? json({ ok: true }) : err(r.status, r.error, r.message);
}

/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfExitRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p !== "/api/hf/account/exit") return null;
  try {
    if (req.method === "GET") return await get(req, env);
    if (req.method === "POST") return await post(req, env);
    if (req.method === "DELETE") return await del(req, env);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, extra: { area: "hf_exit" } });
    return err(500, "internal_error");
  }
}
