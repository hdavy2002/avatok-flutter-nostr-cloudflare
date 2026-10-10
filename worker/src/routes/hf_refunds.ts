// [HF-WALLET-EXIT-1 2026-10-10] Refunds of unused top-up money to the ORIGINAL payment. Rulebook: HF-PAY-15. Logic: lib/hf_refunds.ts.
//   GET  /api/hf/wallet/refunds                       -> { enabled, windowDays, refundable, requests[] }   (enabled:false => the page shows nothing)
//   POST /api/hf/wallet/refunds {amount?}             (Idempotency-Key required) -> { ok, id, status:"requested", amount } | error codes below
//   POST /api/hf/wallet/refunds/:id/cancel            (only while "requested")   -> { ok, status:"cancelled" }
//   GET  /api/admin/hf/refunds?status=requested|approved|processing|failed|refunded|rejected|cancelled|all
//   POST /api/admin/hf/refunds/:id/approve | /retry {resubmit?:[topupId]} | /reject {reason} | /paid-manually {utr} | /mark-sent {topupId, ref?}   (all idempotent)
//   A slice in "needs_check" is never re-sent on its own: /retry with resubmit:[topupId] sends it again, /mark-sent records that the admin saw it sent.
// Error codes (POST): not_enabled 404, invalid_amount 400, insufficient_refundable 402, nothing_refundable 402, wallet_error 502.
// [HF-TOK-EXIT-1] With hfTokensEnabled on, the same endpoints work on PURCHASE LOTS (kind 'play_refund', lib/hf_play_refunds.ts): GET adds mode:"tokens" and
// lots[]; POST {lotId?} makes one request per refundable lot (amount is not used: tokens go back as whole unspent shares); admin adds
//   POST /api/admin/hf/refunds/:id/play-confirm {manual?, recordedPaise?, note?}   (approve / retry do the same without manual)
// and for a play_refund "paid-manually" / "mark-sent" answer 400 use_play_confirm. Extra errors: active_call 409, lot_changed 409, recorded_amount_required 400.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { withIdempotency, rateLimit } from "../money";
import { trackException } from "../hooks";
import { isAdminUid } from "../lib/preview";
import { cleanUtr } from "../lib/hf_payouts";
import { exitFlags } from "../lib/hf_exit";
import { readConfig } from "./config";
import { readHfTokenConfig } from "../lib/hf_token_config"; // [HF-TOK-EXIT-1]
import { formatTokens } from "../lib/hf_token_math";
import {
  PLAY_REFUND, isPlayRefund, refundableLots, requestPlayRefunds, cancelPlayRefund, confirmPlayRefund, rejectPlayRefund, unspentSharePaise, type LotRow,
} from "../lib/hf_play_refunds";
import {
  REFUND_STATUSES, createRefundRequest, refundableFor, cancelRefund, getRefund, processRefund, markSliceSent, markPaidManually, rejectRefund, parseAllocations, type RefundRow,
} from "../lib/hf_refunds";

const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => json({ error, message: message ?? error, ...extra }, status);
const SYSTEM_PREFIX = "system:";
const isSystemRow = (r: RefundRow) => r.status === "cancelled" && (r.reason ?? "").startsWith(SYSTEM_PREFIX);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 4_000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

/** What the user sees: a failed gateway attempt is "processing" to them (the team is on it). */
const publicRow = (r: RefundRow) => ({
  id: r.id, amount: isPlayRefund(r) ? Number(r.amount_paise ?? r.amount_rupees * 100) / 100 : r.amount_rupees, status: r.status === "failed" || r.status === "approved" ? "processing" : r.status,
  reason: r.status === "rejected" ? r.reason : null, utr: r.status === "refunded" ? r.utr : null, exit: r.exit === 1,
  createdAt: r.created_at, updatedAt: r.updated_at, refundedAt: r.refunded_at,
});

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_refund_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch { /* audit is best-effort */ }
}

async function tokenCfg(env: Env) {
  try { return readHfTokenConfig((await readConfig(env)) as unknown as Record<string, unknown>); } catch { return readHfTokenConfig({}); }
}

/** [HF-TOK-EXIT-1] tokens on: what can be refunded is the unspent share of each purchase lot inside the window. */
async function tokenGet(env: Env, uid: string, windowDays: number): Promise<Response> {
  let lots;
  try { lots = await refundableLots(env, uid, windowDays); }
  catch (e) {
    await trackException(env, e, { uid, route: "/api/hf/wallet/refunds", handled: true, extra: { area: "hf_refund", step: "lots" } });
    return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  const paise = lots.reduce((t, l) => t + l.sharePaise, 0);
  const rows = (await env.DB_META.prepare("SELECT * FROM hf_refund_requests WHERE uid=?1 ORDER BY created_at DESC LIMIT 50").bind(uid).all<RefundRow>().catch(() => ({ results: [] as RefundRow[] }))).results ?? [];
  return json({
    enabled: true, mode: "tokens", windowDays, refundable: paise / 100, eligible: paise / 100,
    lots: lots.map((l) => ({ lotId: l.lotId, tokens: formatTokens(l.leftMicro, 2), paid: l.paidPaise / 100, refund: l.sharePaise / 100, wholeOrder: l.wholeOrder, boughtAt: l.createdAt })),
    requests: rows.filter((r) => !isSystemRow(r)).map(publicRow),
  });
}

async function userGet(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const f = await exitFlags(env);
  if ((await tokenCfg(env)).enabled) return tokenGet(env, u.uid, f.windowDays); // [HF-TOK-EXIT-1] token refunds do not wait for hfRefundsEnabled: the public terms promise them
  if (!f.refundsEnabled) return json({ enabled: false, requests: [] });
  let refundable = 0, eligible = 0;
  try { const r = await refundableFor(env, u.uid, f.windowDays); refundable = r.refundable; eligible = r.eligibleTotal; }
  catch (e) {
    await trackException(env, e, { uid: u.uid, route: "/api/hf/wallet/refunds", handled: true, extra: { area: "hf_refund", step: "refundable" } });
    return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  const rows = (await env.DB_META.prepare("SELECT * FROM hf_refund_requests WHERE uid=?1 ORDER BY created_at DESC LIMIT 50").bind(u.uid).all<RefundRow>().catch(() => ({ results: [] as RefundRow[] }))).results ?? [];
  return json({ enabled: true, windowDays: f.windowDays, refundable, eligible, requests: rows.filter((r) => !isSystemRow(r)).map(publicRow) });
}

async function userCreate(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const f = await exitFlags(env);
  const tokens = (await tokenCfg(env)).enabled;
  if (!f.refundsEnabled && !tokens) return err(404, "not_enabled", "Refunds open soon.");
  const lim = await rateLimit(env, `hfrefund:${u.uid}`, 6, 3600);
  if (lim) return lim;
  const body = await readJson(req);
  if (tokens) {
    return withIdempotency(req, env, u.uid, async () => {
      const r = await requestPlayRefunds(env, u.uid, { exit: false, lotId: typeof body.lotId === "string" ? body.lotId : undefined, windowDays: f.windowDays });
      if (!r.ok) return err(r.status, r.error, r.message);
      return json({ ok: true, id: r.ids[0], ids: r.ids, status: "requested", amount: r.amountPaise / 100 });
    });
  }
  return withIdempotency(req, env, u.uid, async () => {
    const r = await createRefundRequest(env, u.uid, { exit: false, amount: body.amount == null || body.amount === "" ? undefined : Number(body.amount), windowDays: f.windowDays });
    if (!r.ok) return err(r.status, r.error, r.message);
    return json({ ok: true, id: r.id, status: "requested", amount: r.amount });
  });
}

async function userCancel(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const row = await getRefund(env, id);
  const r = isPlayRefund(row) ? await cancelPlayRefund(env, id, u.uid) : await cancelRefund(env, id, u.uid); // [HF-TOK-EXIT-1]
  return r.ok ? json({ ok: true, status: r.status, ...(r.replay ? { replay: true } : {}) }) : err(r.status, r.error, r.message);
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
  const status = (REFUND_STATUSES as string[]).includes(q) ? q : q === "all" ? null : "requested";
  const rows = (await env.DB_META.prepare(`SELECT * FROM hf_refund_requests ${status ? "WHERE status=?1" : ""} ORDER BY created_at DESC LIMIT 200`)
    .bind(...(status ? [status] : [])).all<RefundRow>()).results ?? [];
  const counts = (await env.DB_META.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_rupees),0) AS s FROM hf_refund_requests GROUP BY status").all<{ status: string; n: number; s: number }>()).results ?? [];
  // [HF-TOK-EXIT-1] play_refund rows carry the lot they refund; the admin sees what the tokens are worth now (the confirm step re-checks it).
  const lotIds = rows.map((r) => r.lot_id).filter((x): x is string => !!x);
  const lotMap = new Map<string, LotRow>();
  if (lotIds.length) {
    const ls = (await env.DB_META.prepare(`SELECT * FROM hf_token_lots WHERE id IN (${lotIds.map((_, i) => `?${i + 1}`).join(",")})`).bind(...lotIds).all<LotRow>().catch(() => ({ results: [] as LotRow[] }))).results ?? [];
    for (const l of ls) lotMap.set(l.id, l);
  }
  return json({
    items: rows.filter((r) => !isSystemRow(r)).map((r) => {
      const lot = r.lot_id ? lotMap.get(r.lot_id) : undefined;
      return {
        id: r.id, uid: r.uid, amount: isPlayRefund(r) ? Number(r.amount_paise ?? 0) / 100 : r.amount_rupees, status: r.status, exit: r.exit === 1, utr: r.utr, reason: r.reason, adminUid: r.admin_uid,
        allocations: parseAllocations(r.allocations), createdAt: r.created_at, updatedAt: r.updated_at, refundedAt: r.refunded_at,
        ...(isPlayRefund(r) ? {
          kind: PLAY_REFUND, amountPaise: Number(r.amount_paise ?? 0), orderId: r.order_id ?? null, lotId: r.lot_id ?? null, recordedPaise: r.recorded_paise ?? null,
          lot: lot ? {
            status: lot.status, paidPaise: Number(lot.paid_paise), tokensBought: formatTokens(Number(lot.tokens_granted_micro), 2), tokensLeft: formatTokens(Number(lot.tokens_left_micro), 2),
            wholeOrder: Number(lot.tokens_left_micro) >= Number(lot.tokens_granted_micro), currentSharePaise: unspentSharePaise(lot.paid_paise, lot.tokens_granted_micro, lot.tokens_left_micro),
          } : null,
        } : {}),
      };
    }),
    counts: Object.fromEntries(counts.map((c) => [c.status, { n: Number(c.n), rupees: Number(c.s) }])),
  });
}

async function adminAct(req: Request, env: Env, id: string, action: string): Promise<Response> {
  const a = await adminCtx(req, env); if (a instanceof Response) return a;
  let res;
  const target = await getRefund(env, id);
  if (isPlayRefund(target)) { // [HF-TOK-EXIT-1] a Google Play refund of unused tokens: its own confirm / reject, no WalletDO, no gateway slices
    const packageId = (await tokenCfg(env)).playPackageId;
    let pr;
    if (action === "approve" || action === "retry" || action === "play-confirm") {
      const b = action === "play-confirm" ? await readJson(req) : {};
      const recordedPaise = b.recordedPaise == null || b.recordedPaise === "" ? undefined : Number(b.recordedPaise);
      const note = typeof b.note === "string" ? b.note : undefined;
      pr = await confirmPlayRefund(env, id, a.uid, { packageId, manual: b.manual === true, recordedPaise, note });
      if (pr.ok) await audit(env, a.uid, "play_confirm", id, { status: pr.status, manual: b.manual === true, recordedPaise: pr.recordedPaise ?? null, note: note ?? null });
    } else if (action === "reject") {
      const reason = String((await readJson(req)).reason ?? "").trim().slice(0, 200);
      if (reason.length < 3) return err(400, "reason_required", "Write a short reason. The user will see it.");
      pr = await rejectPlayRefund(env, id, a.uid, reason);
      if (pr.ok) await audit(env, a.uid, "rejected", id, { reason, kind: PLAY_REFUND });
    } else return err(400, "use_play_confirm", "This is a Google Play refund. Use Refund through Google Play, or record the refund you made in the Play Console.");
    if (!pr.ok) return err(pr.status, pr.error, pr.message, pr.currentPaise != null ? { currentPaise: pr.currentPaise } : {});
    return json({ ok: true, status: pr.status, ...(pr.replay ? { replay: true } : {}), ...(pr.recordedPaise != null ? { recordedPaise: pr.recordedPaise } : {}) });
  }
  if (action === "play-confirm") return err(400, "not_play_refund", "This is not a Google Play refund.");
  if (action === "approve" || action === "retry") {
    const b = action === "retry" ? await readJson(req) : {};
    const resubmit = Array.isArray(b.resubmit) ? b.resubmit.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
    res = await processRefund(env, id, a.uid, { resubmit });
    if (res.ok) await audit(env, a.uid, action, id, { status: res.status, resubmit });
  } else if (action === "mark-sent") {
    const b = await readJson(req);
    const topupId = String(b.topupId ?? "");
    if (!/^hftop_[a-f0-9]{24}$/.test(topupId)) return err(400, "invalid_topup", "Choose which part you checked.");
    const ref = typeof b.ref === "string" && b.ref.trim() ? b.ref.trim().slice(0, 60) : null;
    res = await markSliceSent(env, id, a.uid, topupId, ref);
    if (res.ok) await audit(env, a.uid, "mark_sent", id, { topupId, ref, status: res.status });
  } else if (action === "paid-manually") {
    const utr = cleanUtr((await readJson(req)).utr);
    if (!utr) return err(400, "invalid_utr", "Enter the UTR: 6 to 30 letters or numbers.");
    res = await markPaidManually(env, id, a.uid, utr);
    if (res.ok) await audit(env, a.uid, "paid_manually", id, { utr });
  } else {
    const reason = String((await readJson(req)).reason ?? "").trim().slice(0, 200);
    if (reason.length < 3) return err(400, "reason_required", "Write a short reason. The user will see it.");
    res = await rejectRefund(env, id, a.uid, reason);
    if (res.ok) await audit(env, a.uid, "rejected", id, { reason });
  }
  if (!res.ok) return err(res.status, res.error, res.message);
  return json({ ok: true, status: res.status, ...(res.replay ? { replay: true } : {}), ...(res.detail ? { allocations: res.detail } : {}) });
}

// ── router ───────────────────────────────────────────────────────────────────
const ID = "([A-Za-z0-9-]{8,64})";
const USER_CANCEL_RE = new RegExp(`^/api/hf/wallet/refunds/${ID}/cancel$`);
const ADMIN_RE = new RegExp(`^/api/admin/hf/refunds/${ID}/(approve|retry|reject|paid-manually|mark-sent|play-confirm)$`);
/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfRefundsRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method;
  const cancelM = p.match(USER_CANCEL_RE);
  const adminM = p.match(ADMIN_RE);
  const ours = p === "/api/hf/wallet/refunds" || !!cancelM || p === "/api/admin/hf/refunds" || !!adminM;
  if (!ours) return null;
  try {
    if (p === "/api/hf/wallet/refunds" && m === "GET") return await userGet(req, env);
    if (p === "/api/hf/wallet/refunds" && m === "POST") return await userCreate(req, env);
    if (cancelM && m === "POST") return await userCancel(req, env, cancelM[1]);
    if (p === "/api/admin/hf/refunds" && m === "GET") return await adminList(req, env);
    if (adminM && m === "POST") return await adminAct(req, env, adminM[1], adminM[2]);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, extra: { area: "hf_refund" } });
    return err(500, "internal_error");
  }
}
