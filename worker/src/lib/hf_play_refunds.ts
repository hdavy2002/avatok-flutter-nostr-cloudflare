
// [HF-TOK-EXIT-1] Refunds of unused PURCHASED tokens through Google Play (hfTokensEnabled on). Rulebook: HF-PAY-15 (tokens wording), HF-PAY-14.
// One request = one purchase lot (hf_refund_requests, kind 'play_refund', amount_paise = the unspent share of what the buyer paid, pro rata).
// Flow: the buyer asks from /wallet (or the account-closure flow asks) -> an admin confirms -> the money goes back THROUGH GOOGLE:
//   * nothing of the lot was spent  -> the Orders API refunds the whole order (refundOrderFor, built by HF-TOK-PLAY-1; see the port below),
//   * part was spent                -> Google refunds whole orders only, so the admin refunds the partial amount in the Play Console and RECORDS it here,
// and only then the lot's remaining tokens are removed, exactly once (ledger op `hfrefund:<requestId>`). A refund that leaves a spent part never
// becomes a debt here: the buyer keeps what they used and gets back only what they did not. (A Google refund of a WHOLE order after spending is
// the RTDN / voided-purchase path in HF-TOK-PLAY-1: revokeLot makes that spent part a debt.) Host earnings are never touched.
// Nothing here touches the WalletDO.
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { sendWhatsAppText } from "./whatsapp_send";
import { valuePaiseOfMicro } from "./hf_token_ledger";
import { refundOrderFor } from "../play";

export const PLAY_REFUND = "play_refund";
export const DAY_MS = 86_400_000;
/** A call row still "ringing/connected" this long after it started is a stale row (calls cap at 60 minutes). */
export const ACTIVE_CALL_WINDOW_MS = 3 * 3_600_000;
export const STUCK_PROCESSING_MS = 10 * 60_000;
const APP = "hfrefund";
export const playRefundOpId = (requestId: string) => `hfrefund:${requestId}`;
export const OPEN_PLAY_STATUSES = ["requested", "approved", "processing", "failed"];
const OPEN_SQL = OPEN_PLAY_STATUSES.map((s) => `'${s}'`).join(",");

// ── port to HF-TOK-PLAY-1 ────────────────────────────────────────────────────
// TODO(HF-TOK-PLAY-1 merge): lib/hf_play.ts exports refundOrderFor; call setPlayRefundPort({ refundOrderFor: ... }) once at module load of the
// worker entry (or replace this port with a direct import). Until then a full-order refund answers "play_refund_unavailable" and the admin
// refunds in the Play Console and records it (manual: true), which works for any lot.
export type PlayRefundResult = { ok: true } | { ok: false; error: string; alreadyRefunded?: boolean };
export interface PlayRefundPort { refundOrderFor(env: Env, a: { orderId: string; packageId: string }): Promise<PlayRefundResult> }
// [HF-TOK-EXIT-1] Wired to HF-TOK-PLAY-1's Orders API refund by default; tests may swap it with setPlayRefundPort.
const defaultPort: PlayRefundPort = {
  async refundOrderFor(env, a) {
    const r = await refundOrderFor(env, a.packageId, a.orderId, { revoke: false });
    if (r.ok) return { ok: true };
    const reason = String(r.reason ?? "");
    return { ok: false, error: r.status === 0 ? "play_refund_unreachable" : `play_refund_failed_${r.status}`, alreadyRefunded: /already|refunded/i.test(reason) };
  },
};
let port: PlayRefundPort | null = defaultPort;
export const setPlayRefundPort = (p: PlayRefundPort | null): void => { port = p; };
async function refundWholeOrder(env: Env, orderId: string, packageId: string): Promise<PlayRefundResult> {
  if (!port) return { ok: false, error: "play_refund_unavailable" };
  try { return await port.refundOrderFor(env, { orderId, packageId }); } catch { return { ok: false, error: "play_refund_unreachable" }; }
}

// ── pure ─────────────────────────────────────────────────────────────────────
const nz = (n: unknown): number => (Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0);
/** Pro-rata share of what the buyer paid that belongs to the tokens not yet spent: floor(paid * left / granted). */
export function unspentSharePaise(paidPaise: number, grantedMicro: number, leftMicro: number): number {
  const g = nz(grantedMicro);
  if (g <= 0) return 0;
  return Number((BigInt(nz(paidPaise)) * BigInt(Math.min(nz(leftMicro), g))) / BigInt(g));
}

export interface LotRow {
  id: string; uid: string; kind: string; status: string; paid_paise: number; tokens_granted_micro: number; tokens_left_micro: number;
  tokens_reserved_micro: number; provider: string | null; provider_ref: string | null; created_at: number; redemption_paise_per_token: number;
}
export interface RefundableLot {
  lotId: string; orderId: string | null; paidPaise: number; grantedMicro: number; leftMicro: number; createdAt: number;
  /** What the buyer gets back, in paise. */
  sharePaise: number;
  /** Nothing of the lot was spent: Google can refund the whole order. Otherwise an admin refunds the partial amount in the Play Console. */
  wholeOrder: boolean;
}

/** Pure. Purchase lots that can be refunded now. windowDays null = no age limit (account closure). */
export function pickRefundableLots(rows: LotRow[], openLotIds: Set<string>, now: number, windowDays: number | null): RefundableLot[] {
  const out: RefundableLot[] = [];
  for (const r of rows) {
    if (r.kind !== "purchase" || r.status !== "active") continue;
    if (openLotIds.has(r.id)) continue;
    if (nz(r.tokens_left_micro) <= 0 || nz(r.tokens_reserved_micro) > 0) continue;
    if (windowDays != null && now - Number(r.created_at) > windowDays * DAY_MS) continue;
    const share = unspentSharePaise(r.paid_paise, r.tokens_granted_micro, r.tokens_left_micro);
    if (share <= 0) continue;
    out.push({
      lotId: r.id, orderId: r.provider_ref, paidPaise: nz(r.paid_paise), grantedMicro: nz(r.tokens_granted_micro), leftMicro: nz(r.tokens_left_micro),
      createdAt: Number(r.created_at), sharePaise: share, wholeOrder: nz(r.tokens_left_micro) >= nz(r.tokens_granted_micro),
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// ── reads ────────────────────────────────────────────────────────────────────
export interface PlayRefundRow {
  id: string; uid: string; amount_rupees: number; status: string; reason: string | null; admin_uid: string | null; exit: number;
  created_at: number; updated_at: number; refunded_at: number | null; kind: string | null; amount_paise: number | null; lot_id: string | null;
  order_id: string | null; recorded_paise: number | null; utr: string | null;
}
export const isPlayRefund = (r: { kind?: string | null } | null | undefined): boolean => r?.kind === PLAY_REFUND;

export async function getPlayRefund(env: Env, id: string): Promise<PlayRefundRow | null> {
  return (await env.DB_META.prepare("SELECT * FROM hf_refund_requests WHERE id=?1").bind(id).first<PlayRefundRow>().catch(() => null)) ?? null;
}

async function openLotIds(env: Env, uid: string): Promise<Set<string>> {
  const r = (await env.DB_META.prepare(`SELECT lot_id FROM hf_refund_requests WHERE uid=?1 AND kind='play_refund' AND status IN (${OPEN_SQL})`).bind(uid).all<{ lot_id: string | null }>()).results ?? [];
  return new Set(r.map((x) => x.lot_id).filter((x): x is string => !!x));
}

export async function refundableLots(env: Env, uid: string, windowDays: number | null, now = Date.now()): Promise<RefundableLot[]> {
  const rows = (await env.DB_META.prepare("SELECT * FROM hf_token_lots WHERE uid=?1 AND kind='purchase' AND status='active' AND tokens_left_micro>0 ORDER BY created_at ASC").bind(uid).all<LotRow>()).results ?? [];
  return pickRefundableLots(rows, await openLotIds(env, uid), now, windowDays);
}

/** A call this user is on right now, as caller or as host. Fails open when the calls table is not there. */
export async function hasActiveCall(env: Env, uid: string, now = Date.now()): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare(
      "SELECT 1 AS x FROM hf_calls WHERE (caller_uid=?1 OR host_uid=?1) AND status IN ('ringing_host','ringing_caller','connected') AND created_at>?2 LIMIT 1",
    ).bind(uid, now - ACTIVE_CALL_WINDOW_MS).first();
    return !!r;
  } catch { return false; }
}

const inr2 = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
async function notify(env: Env, uid: string, text: string): Promise<void> {
  try {
    const e164 = await verifiedWhatsAppNumber(env, uid);
    if (e164) await sendWhatsAppText(env, e164, text);
  } catch (e) {
    await trackException(env, e, { route: "hf_play_refunds.notify", handled: true, app_name: APP, extra: { area: "hf_play_refund" } });
  }
}

// ── retire a lot (remove what is left, no debt) ──────────────────────────────
export interface RetireResult { applied: boolean; found: boolean; removedMicro: number; stillActive: boolean }
/**
 * Remove the tokens left in a lot and mark it revoked, ONE batch, idempotent per opId. Unlike revokeLot it never creates a debt: it is for
 * a refund of only the unspent share, and for test lots dropped at account closure. Guarded by the lot's current numbers: if a spend landed
 * between the read and the write nothing changes and it re-reads once, then fails closed (stillActive).
 */
export async function retireLot(env: Env, lotId: string, opId: string, kind: "refund_revoke" | "admin_adjust"): Promise<RetireResult> {
  const db = env.DB_META;
  for (let attempt = 0; attempt < 2; attempt++) {
    const lot = await db.prepare("SELECT * FROM hf_token_lots WHERE id=?1").bind(lotId).first<LotRow>();
    if (!lot) return { applied: false, found: false, removedMicro: 0, stillActive: false };
    if (lot.status !== "active") return { applied: false, found: true, removedMicro: 0, stillActive: false };
    const left = nz(lot.tokens_left_micro), reserved = nz(lot.tokens_reserved_micro);
    const now = Date.now(), nonce = crypto.randomUUID();
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
         SELECT ?1,?2,?3,?4,?5,?6,NULL,?7,?8,?9,?10
          WHERE EXISTS (SELECT 1 FROM hf_token_lots WHERE id=?4 AND status='active' AND tokens_left_micro=?11 AND tokens_reserved_micro=?12)`,
      ).bind(crypto.randomUUID(), lot.uid, kind, lotId, -left, valuePaiseOfMicro(left, Number(lot.redemption_paise_per_token)), lot.provider_ref, opId, nonce, now, left, reserved),
      db.prepare("UPDATE hf_token_lots SET tokens_left_micro=0, tokens_reserved_micro=0, status='revoked' WHERE id=?1 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?2 AND note=?3)")
        .bind(lotId, opId, nonce),
    ]);
    const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(opId).first<{ note: string | null }>();
    if (g?.note === nonce) {
      await db.prepare("UPDATE hf_token_ledger SET note=NULL WHERE op_id=?1").bind(opId).run();
      return { applied: true, found: true, removedMicro: left, stillActive: false };
    }
    if (g) {
      const again = await db.prepare("SELECT status FROM hf_token_lots WHERE id=?1").bind(lotId).first<{ status: string }>();
      return { applied: false, found: true, removedMicro: 0, stillActive: again?.status === "active" };
    }
  }
  return { applied: false, found: true, removedMicro: 0, stillActive: true };
}

// ── create ───────────────────────────────────────────────────────────────────
export type CreatePlayResult =
  | { ok: true; ids: string[]; amountPaise: number; lots: number }
  | { ok: false; status: number; error: string; message: string };
const bad = (status: number, error: string, message: string): { ok: false; status: number; error: string; message: string } => ({ ok: false, status, error, message });

/**
 * One refund request per refundable purchase lot (or only `lotId`). `exit` = account closure: no age limit. A user on a call (caller or host)
 * cannot ask. Safe to call twice: a lot that already has an open request is skipped, and a race that makes two rows keeps the older one.
 */
export async function requestPlayRefunds(env: Env, uid: string, o: { exit: boolean; lotId?: string; windowDays: number; now?: number }): Promise<CreatePlayResult> {
  const now = o.now ?? Date.now();
  if (await hasActiveCall(env, uid, now)) return bad(409, "active_call", "You have a call in progress. Please finish it first.");
  let lots: RefundableLot[];
  try { lots = await refundableLots(env, uid, o.exit ? null : o.windowDays, now); }
  catch (e) {
    await trackException(env, e, { uid, route: "hf_play_refunds.create", handled: true, app_name: APP, extra: { area: "hf_play_refund", step: "lots" } });
    return bad(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  if (o.lotId) lots = lots.filter((l) => l.lotId === o.lotId);
  if (lots.length === 0) return bad(402, "nothing_refundable", "There is no unused money from purchases to refund.");
  const ids: string[] = [];
  let total = 0;
  for (const l of lots) {
    const id = crypto.randomUUID();
    await env.DB_META.prepare(
      `INSERT INTO hf_refund_requests (id, uid, amount_rupees, status, wallet_ref, allocations, exit, created_at, updated_at, kind, amount_paise, lot_id, order_id)
       VALUES (?1,?2,?3,'requested',NULL,'[]',?4,?5,?5,'play_refund',?6,?7,?8)`,
    ).bind(id, uid, Math.round(l.sharePaise / 100), o.exit ? 1 : 0, now, l.sharePaise, l.lotId, l.orderId).run();
    // Row first, THEN check we are the oldest open request for this lot.
    const first = await env.DB_META.prepare(`SELECT id FROM hf_refund_requests WHERE lot_id=?1 AND kind='play_refund' AND status IN (${OPEN_SQL}) ORDER BY created_at ASC, id ASC LIMIT 1`)
      .bind(l.lotId).first<{ id: string }>();
    if (first && first.id !== id) {
      await env.DB_META.prepare("UPDATE hf_refund_requests SET status='cancelled', reason='system:duplicate', updated_at=?2 WHERE id=?1 AND status='requested'").bind(id, Date.now()).run();
      continue;
    }
    ids.push(id); total += l.sharePaise;
  }
  if (ids.length === 0) return bad(409, "already_requested", "You already have a refund in progress for this money.");
  void track(env, uid, "hf_play_refund_requested", APP, { amount_paise: total, lots: ids.length, exit: o.exit });
  return { ok: true, ids, amountPaise: total, lots: ids.length };
}

// ── actions ──────────────────────────────────────────────────────────────────
export type PlayActionResult =
  | { ok: true; status: string; replay?: boolean; recordedPaise?: number }
  | { ok: false; status: number; error: string; message: string; currentPaise?: number };

export async function cancelPlayRefund(env: Env, id: string, uid: string, viaExit = false): Promise<PlayActionResult> {
  const row = await getPlayRefund(env, id);
  if (!row || row.uid !== uid || !isPlayRefund(row)) return bad(404, "not_found", "Not found.");
  if (row.status === "cancelled") return { ok: true, status: "cancelled", replay: true };
  if (row.exit === 1 && !viaExit) return bad(409, "exit_request", "This refund belongs to your account closure. Cancel the closure instead.");
  if (row.status !== "requested") return bad(409, "not_cancellable", "This request can no longer be cancelled.");
  const up = await env.DB_META.prepare("UPDATE hf_refund_requests SET status='cancelled', updated_at=?2 WHERE id=?1 AND status='requested'").bind(id, Date.now()).run();
  if (!up.meta?.changes) return bad(409, "not_cancellable", "This request was just picked up, so it can no longer be cancelled.");
  return { ok: true, status: "cancelled" };
}

export async function rejectPlayRefund(env: Env, id: string, adminUid: string, reason: string): Promise<PlayActionResult> {
  const row = await getPlayRefund(env, id);
  if (!row || !isPlayRefund(row)) return bad(404, "not_found", "Not found.");
  if (row.status === "rejected") return { ok: true, status: "rejected", replay: true };
  if (!["requested", "approved", "failed"].includes(row.status)) return bad(409, "invalid_state", `This request is ${row.status}.`);
  const done = await env.DB_META.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(playRefundOpId(id)).first();
  if (done) return bad(409, "partly_refunded", "The money was already removed. Mark this refund as done instead.");
  const up = await env.DB_META.prepare("UPDATE hf_refund_requests SET status='rejected', reason=?2, admin_uid=?3, updated_at=?4 WHERE id=?1 AND status IN ('requested','approved','failed')")
    .bind(id, reason, adminUid, Date.now()).run();
  if (!up.meta?.changes) return bad(409, "invalid_state", "This request changed. Refresh and try again.");
  await notify(env, row.uid, `Your ${BRAND.name} refund request of ${inr2(Number(row.amount_paise ?? 0))} was not processed: ${reason}. Your money is still in your wallet.`);
  void track(env, row.uid, "hf_play_refund_rejected", APP, { id });
  return { ok: true, status: "rejected" };
}

export interface ConfirmOpts {
  packageId: string;
  /** Admin refunded in the Play Console instead of the Orders API (always for a partial amount). */
  manual?: boolean;
  /** Paise the admin refunded in the Play Console. Required when manual or when only part of the order is owed. */
  recordedPaise?: number;
  note?: string;
}

/**
 * Admin confirms a play_refund. Whole order unspent -> Orders API (or manual: admin refunded it in the Console). Partly spent -> the admin
 * refunded the unspent share in the Console and gives the amount. Then the lot's tokens are removed exactly once. Retry-safe at every step:
 * a Google "already refunded" counts as done, the token removal is an idempotent ledger op, and a row stuck in processing can be taken again.
 */
export async function confirmPlayRefund(env: Env, id: string, adminUid: string, o: ConfirmOpts, now = Date.now()): Promise<PlayActionResult> {
  const row = await getPlayRefund(env, id);
  if (!row || !isPlayRefund(row)) return bad(404, "not_found", "Not found.");
  if (row.status === "refunded") return { ok: true, status: "refunded", replay: true, recordedPaise: Number(row.recorded_paise ?? 0) };
  if (row.status === "processing" && now - Number(row.updated_at) < STUCK_PROCESSING_MS) return bad(409, "in_progress", "This refund is being processed. Refresh in a moment.");
  if (!["requested", "approved", "failed", "processing"].includes(row.status)) return bad(409, "invalid_state", `This request is ${row.status}.`);
  const prev = row.status === "processing" ? "failed" : row.status;
  const claim = await env.DB_META.prepare(
    "UPDATE hf_refund_requests SET status='processing', admin_uid=?2, updated_at=?3 WHERE id=?1 AND (status IN ('requested','approved','failed') OR (status='processing' AND updated_at<?4))",
  ).bind(id, adminUid, now, now - STUCK_PROCESSING_MS).run();
  if (!claim.meta?.changes) return bad(409, "invalid_state", "This request changed. Refresh and try again.");
  const back = async (r: PlayActionResult): Promise<PlayActionResult> => {
    await env.DB_META.prepare("UPDATE hf_refund_requests SET status=?2, updated_at=?3 WHERE id=?1 AND status='processing'").bind(id, prev, Date.now()).run();
    return r;
  };
  const fail = async (reason: string, r: PlayActionResult): Promise<PlayActionResult> => {
    await env.DB_META.prepare("UPDATE hf_refund_requests SET status='failed', reason=?2, updated_at=?3 WHERE id=?1 AND status='processing'").bind(id, `system:${reason}`.slice(0, 120), Date.now()).run();
    return r;
  };

  const lotId = row.lot_id;
  const lot = lotId ? await env.DB_META.prepare("SELECT * FROM hf_token_lots WHERE id=?1").bind(lotId).first<LotRow>() : null;
  if (!lot) return back(bad(404, "lot_missing", "The purchase behind this refund was not found."));
  const owed = nz(row.amount_paise);
  const alreadyRemoved = !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(playRefundOpId(id)).first());
  let recorded = nz(row.recorded_paise) || (alreadyRemoved ? owed : 0);

  if (!alreadyRemoved) {
    if (lot.status !== "active") {
      // Google already refunded this order and HF-TOK-PLAY-1's refund path removed the tokens: the money is back with the buyer.
      const p = await env.DB_META.prepare("SELECT state FROM hf_play_purchases WHERE order_id=?1").bind(lot.provider_ref).first<{ state: string }>().catch(() => null);
      if (p && (p.state === "refunded" || p.state === "revoked")) recorded = recorded || nz(lot.paid_paise);
      else return back(bad(409, "lot_not_active", "The money from this purchase was already removed. Reject this request."));
    } else {
      const current = unspentSharePaise(lot.paid_paise, lot.tokens_granted_micro, lot.tokens_left_micro);
      if (nz(lot.tokens_reserved_micro) > 0 || (await hasActiveCall(env, row.uid, now))) {
        return back(bad(409, "active_call", "The buyer is on a call. Try again when it ends."));
      }
      if (current !== owed) {
        return back({ ok: false, status: 409, error: "lot_changed", message: `The unused money changed since this was asked (now ${inr2(current)}). Reject it and ask the buyer to request again.`, currentPaise: current });
      }
      const whole = nz(lot.tokens_left_micro) >= nz(lot.tokens_granted_micro) && owed === nz(lot.paid_paise);
      if (whole && !o.manual) {
        const r = await refundWholeOrder(env, String(lot.provider_ref ?? ""), o.packageId);
        if (!r.ok && !r.alreadyRefunded) {
          const unavailable = r.error === "play_refund_unavailable";
          return fail(r.error, bad(unavailable ? 501 : 502, r.error, unavailable
            ? "Refunding through Google from here is not connected yet. Refund this order in the Play Console, then confirm with 'I refunded it in the Play Console'."
            : "Google did not accept the refund. You can retry, or refund it in the Play Console and confirm that."));
        }
        recorded = owed;
      } else {
        const want = Math.trunc(Number(o.recordedPaise));
        if (!Number.isInteger(want) || want <= 0 || want > owed) {
          return back(bad(400, "recorded_amount_required", `Refund ${inr2(owed)} in the Play Console, then enter the amount you refunded (up to ${inr2(owed)}).`));
        }
        if (want < owed && !(o.note ?? "").trim()) return back(bad(400, "note_required", "You are refunding less than the unused share. Add a note saying why."));
        recorded = want;
      }
    }
    // Remember what went back BEFORE removing the tokens, so a retry after a crash still knows the amount.
    await env.DB_META.prepare("UPDATE hf_refund_requests SET recorded_paise=?2 WHERE id=?1").bind(id, recorded).run();
    const rt = await retireLot(env, lot.id, playRefundOpId(id), "refund_revoke");
    if (rt.stillActive || !rt.found) return fail("tokens_not_removed", bad(409, "conflict", "The money was refunded but the money could not be removed from the wallet yet. Press Retry to finish."));
  }

  const note = (o.note ?? "").trim().slice(0, 200) || null;
  await env.DB_META.batch([
    env.DB_META.prepare("UPDATE hf_refund_requests SET status='refunded', recorded_paise=?2, reason=?3, refunded_at=?4, updated_at=?4 WHERE id=?1").bind(id, recorded, note, Date.now()),
    env.DB_META.prepare("UPDATE hf_play_purchases SET state='refunded', refunded_at=COALESCE(refunded_at,?2) WHERE order_id=?1 AND state<>'refunded'").bind(lot.provider_ref, Date.now()),
  ]);
  await notify(env, row.uid, `Your ${BRAND.name} refund of ${inr2(recorded)} for your unused wallet money has been sent back through Google Play. Google can take a few days to show it.`);
  void track(env, row.uid, "hf_play_refund_confirmed", APP, { id, recorded_paise: recorded, whole: recorded === nz(lot.paid_paise) });
  return { ok: true, status: "refunded", recordedPaise: recorded };
}
