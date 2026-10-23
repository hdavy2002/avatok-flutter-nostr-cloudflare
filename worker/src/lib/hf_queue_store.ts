// [HF-CALL-MODES-B] The call queue (HF-CALL-10, spec 2.2): D1 helpers plus the whole queue state machine. do/hf_host_line.ts (HfHostLineDO,
// one per host) serialises every mutation and owns the alarms; the logic lives here, as plain functions over (env, hostUid, LineState, now),
// so it is testable without a Durable Object runtime. Behind flag hfCallQueueEnabled (+ hfCallsEnabled): with it OFF nothing here runs,
// the three exported hooks (notifyLineFree / queueGate / closeQueue) answer "no queue" and the DO is never invoked by existing flows.
//
// Line machine (spec 2.1): the line lock is hf_hosts.presence_call_id. During the break it is 'q:<entryId>'; startInstantCall(source:'queue')
// swaps it for the real call id via claimHostFromQueue. Queue entry statuses: waiting -> offered (break + ringing, call_id set once the call
// is placed) -> done | skipped(reason) | expired | closed | left. 'connected' is reserved by the contract and unused: an entry stays 'offered'
// (with call_id) until the call ends, which keeps the one-active-entry-per-fan unique index meaningful while the fan is on the call.
//
// WhatsApp: sent directly with sendWhatsAppText, but only through the paced path below: every message is first INSERT OR IGNOREd into
// whatsapp_outbox (status 'hfq_pending', never 'queued', so the cron drain ignores it; UNIQUE(checkout_id,kind,url_hash) dedupes), then
// flushWa sends at most ONE message per host per 2 s and at most one queue message per fan per 60 s.
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { readConfig } from "../routes/config";
import { BRAND } from "./brand";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { sendWhatsAppText } from "./whatsapp_send";
import { sendHfPush } from "./hf_push";
import { ACTIVE_STATUSES, HF_CALL_APP, isBlockedEitherWay, releaseHost } from "./hf_calls_store";
import { isClosing } from "./hf_exit";
import { publicCallState } from "./hf_host_status";
import { startInstantCall } from "./hf_call_start";
import { availableLots } from "./hf_token_ledger";
import { readMoneyRules, walletSpendablePaise } from "./hf_money_rules";
import { chargePaise, type Price } from "./hf_token_math";
import { readHfStdPlan } from "./hf_token_config";
import { pricingStd } from "./hf_influencer_rate";
import { creatorSnapshotFor, isCreatorCategory, validCreatorRate } from "./hf_creator_pricing";
import {
  queueFirstName, queueJoinedMsg, queueNextMsg, queueNoAnswerMsg, queueLowBalanceMsg, queueClosedMsg, queueExpiredMsg, queuePausedMsg,
  queueBookingMsg, queueTroubleMsg, queueOutboxKind, type QueueMsgKind,
} from "./hf_queue_messages";
import type { HfHostLineMessage, HfHostLineResponse, HostMode, HostQueueView, MyQueueResponse, PublicCallState, QueueSkipReason, QueueStatus } from "./hf_call_contracts";

// ── constants ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** After a fan no-answer / skip the next fan is rung after this, not after the full break (rule 5). */
export const QUEUE_SKIP_DELAY_MS = 10_000;
/** Rule 9: a booking starting sooner than this blocks a queued call. */
export const QUEUE_BOOKING_GAP_MS = 5 * 60_000;
/** WasenderAPI pacing: one message per host per 2 s; one queue message per fan per 60 s. */
export const WA_HOST_GAP_MS = 2_000;
export const WA_FAN_GAP_MS = 60_000;
/** A pending message older than this is dropped, not sent late. */
const WA_STALE_MS = 10 * 60_000;
/** After this many consecutive system-side start failures the head is skipped. */
const MAX_START_FAILS = 3;
const START_RETRY_MS = 15_000;
/** Waiting + the entry in its break: what "N waiting" means everywhere. An entry whose call is already placed is the active call, not a waiter. */
const WAITING_SQL = "(status='waiting' OR (status='offered' AND call_id IS NULL))";

// ── types ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface QueueCfg {
  enabled: boolean; maxLen: number; breakSec: number; maxWaitMin: number; pauseExpireMin: number; chunkMin: number; bookingsOn: boolean;
  raw: Record<string, unknown>;
}
export interface QRow {
  id: string; host_uid: string; fan_uid: string; seq: number; status: QueueStatus; skip_reason: string | null; host_miss_count: number;
  call_id: string | null; joined_at: number; offered_at: number | null; ended_at: number | null; updated_at: number; wa_join_at: number | null; wa_next_at: number | null;
}
export interface HostRow {
  uid: string; slug: string | null; display_name: string | null; status: string; price_per_min: number; category: string;
  call_mode: string | null; on_call_since: number | null; presence_call_id: string | null; queue_paused: number | null;
}
/** Per-host machine state kept in the Durable Object's storage. */
export interface LineState {
  /** the entry whose break is running (line locked as 'q:<id>') */
  breakEntryId: string | null;
  breakAt: number | null;
  /** retry a failed lock claim / start */
  retryAt: number | null;
  /** consecutive queued calls the influencer missed (D3) */
  missStreak: number;
  /** consecutive system-side start / call failures */
  startFails: number;
  /** when the queue was paused (paused entries expire pauseExpireMin later) */
  pausedAt: number | null;
  /** last WhatsApp send for this host (2 s pacing) */
  lastSendAt: number;
  /** position each fan had at join (for hf_queue_dispatched); pruned when the entry ends */
  joinPos: Record<string, number>;
}
export const freshLineState = (): LineState => ({ breakEntryId: null, breakAt: null, retryAt: null, missStreak: 0, startFails: 0, pausedAt: null, lastSendAt: 0, joinPos: {} });

export type LineOutcome = "completed" | "fan_no_answer" | "host_missed" | "failed";
/** Responses may carry a few more fields than the shared contract. */
export type LineResponse = Omit<HfHostLineResponse, "error"> & {
  error?: HfHostLineResponse["error"] | "call_in_progress"; entryId?: string; shortfallPaise?: number; hostSlug?: string; reason?: string; closed?: number; paused?: boolean;
};

// ── config / small lookups ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function readQueueCfg(env: Env): Promise<QueueCfg> {
  let raw: Record<string, unknown> = {};
  try { raw = ((await readConfig(env)) as unknown as Record<string, unknown>) ?? {}; } catch { raw = {}; }
  const n = (k: string, d: number) => { const v = Number(raw[k]); return Number.isFinite(v) && v > 0 ? Math.trunc(v) : d; };
  return {
    enabled: raw.hfCallsEnabled === true && raw.hfCallQueueEnabled === true,
    maxLen: n("hfQueueMaxLength", 10), breakSec: n("hfQueueBreakSeconds", 60), maxWaitMin: n("hfQueueMaxWaitMinutes", 120),
    pauseExpireMin: n("hfQueuePauseExpireMinutes", 15), chunkMin: n("hfCallChunkMinutes", 5), bookingsOn: raw.hfBookingsEnabled === true, raw,
  };
}
export async function queueEnabled(env: Env): Promise<boolean> { return (await readQueueCfg(env)).enabled; }

export const queueLockId = (entryId: string) => `q:${entryId}`;
const isQueueLock = (v: string | null | undefined): v is string => typeof v === "string" && v.startsWith("q:");

const HOST_COLS = "uid, slug, display_name, status, price_per_min, category, call_mode, on_call_since, presence_call_id, queue_paused";
export async function loadHostByUid(env: Env, uid: string): Promise<HostRow | null> {
  try { return await env.DB_META.prepare(`SELECT ${HOST_COLS} FROM hf_hosts WHERE uid=?1`).bind(uid).first<HostRow>(); } catch { return null; }
}
export async function loadHostBySlug(env: Env, slug: string): Promise<HostRow | null> {
  try { return await env.DB_META.prepare(`SELECT ${HOST_COLS} FROM hf_hosts WHERE slug=?1`).bind(slug).first<HostRow>(); } catch { return null; }
}
async function getEntry(env: Env, id: string): Promise<QRow | null> {
  return (await env.DB_META.prepare("SELECT * FROM hf_call_queue WHERE id=?1").bind(id).first<QRow>().catch(() => null)) ?? null;
}
async function waitingRows(env: Env, hostUid: string, limit = 50): Promise<QRow[]> {
  const r = await env.DB_META.prepare(`SELECT * FROM hf_call_queue WHERE host_uid=?1 AND ${WAITING_SQL} ORDER BY seq ASC LIMIT ?2`).bind(hostUid, limit).all<QRow>().catch(() => null);
  return r?.results ?? [];
}
export async function waitingCount(env: Env, hostUid: string): Promise<number> {
  const r = await env.DB_META.prepare(`SELECT COUNT(*) AS n FROM hf_call_queue WHERE host_uid=?1 AND ${WAITING_SQL}`).bind(hostUid).first<{ n: number }>().catch(() => null);
  return Number(r?.n ?? 0);
}
/** 1-based position among the host's waiters (an entry whose call is placed shows 1). */
export async function positionOf(env: Env, row: Pick<QRow, "host_uid" | "seq" | "call_id" | "status">): Promise<number> {
  if (row.status === "offered" && row.call_id) return 1;
  const r = await env.DB_META.prepare(`SELECT COUNT(*) AS n FROM hf_call_queue WHERE host_uid=?1 AND ${WAITING_SQL} AND seq<?2`).bind(row.host_uid, row.seq).first<{ n: number }>().catch(() => null);
  return Number(r?.n ?? 0) + 1;
}
const hostLabel = (h: HostRow) => queueFirstName(h.display_name);
const waitS = (row: QRow, now: number) => Math.max(0, Math.round((now - row.joined_at) / 1000));
const activePlaceholders = (from: number) => ACTIVE_STATUSES.map((_, i) => `?${from + i}`).join(",");

// ── public hooks (other lanes call these; all must be cheap and safe when the flag is off) ────────────────────────────────────────────────
/** Poke the host's HfHostLineDO. Never throws; null when the binding is absent or the call failed. */
export async function pokeLine(env: Env, hostUid: string, msg: HfHostLineMessage | { op: string; [k: string]: unknown }): Promise<LineResponse | null> {
  try {
    if (!env.HF_HOST_LINE) return null;
    const stub = env.HF_HOST_LINE.get(env.HF_HOST_LINE.idFromName(hostUid));
    const r = await stub.fetch(`https://hfline/${msg.op}`, { method: "POST", body: JSON.stringify({ ...msg, hostUid }) });
    return (await r.json().catch(() => null)) as LineResponse | null;
  } catch (e) {
    await trackException(env, e, { route: "hf_queue.pokeLine", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue", op: msg.op } }).catch(() => undefined);
    return null;
  }
}

/** What happened to a finished call, from its hf_calls row (HfCallDO writes end_reason before releaseHost). */
export function outcomeFromCall(row: { status?: string | null; end_reason?: string | null; connected_at?: number | null } | null): LineOutcome {
  if (!row) return "failed";
  if (row.connected_at) return "completed";
  const r = String(row.end_reason ?? "");
  if (r === "caller_no_answer" || r === "cancelled" || r === "caller_cancelled" || r === "caller_hangup" || String(row.status ?? "") === "cancelled") return "fan_no_answer";
  if (r === "host_declined" || r === "no_answer") return "host_missed";
  return "failed";
}

/**
 * The host's line became free (HfCallDO called releaseHost). Pokes the host's HfHostLineDO so it can start the break and dispatch the next fan.
 * Never throws. Flag off: no-op. No waiters and no queue entry tied to this call: no-op, the DO is not even woken.
 */
export async function notifyLineFree(env: Env, hostUid: string, callId: string): Promise<void> {
  try {
    if (!(await queueEnabled(env))) return;
    const pending = await env.DB_META.prepare("SELECT 1 AS x FROM hf_call_queue WHERE host_uid=?1 AND (status='waiting' OR (status='offered' AND call_id=?2)) LIMIT 1").bind(hostUid, callId).first().catch(() => null);
    if (!pending) return;
    const call = await env.DB_META.prepare("SELECT status, end_reason, connected_at FROM hf_calls WHERE id=?1").bind(callId).first<{ status: string; end_reason: string | null; connected_at: number | null }>().catch(() => null);
    await pokeLine(env, hostUid, { op: "line-free", callId, outcome: outcomeFromCall(call) });
  } catch (e) {
    await trackException(env, e, { route: "hf_queue.notifyLineFree", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue" } }).catch(() => undefined);
  }
}

/**
 * Fairness gate: while anyone waits, an instant caller must queue instead of jumping. { waiting, paused, open } for the host.
 * Flag off: nobody waiting, queue closed.
 */
export async function queueGate(env: Env, hostUid: string, _state?: PublicCallState): Promise<{ waiting: number; paused: boolean; open: boolean }> {
  try {
    const cfg = await readQueueCfg(env);
    if (!cfg.enabled) return { waiting: 0, paused: false, open: false };
    const host = await loadHostByUid(env, hostUid);
    if (!host) return { waiting: 0, paused: false, open: false };
    const paused = Number(host.queue_paused ?? 0) === 1;
    return { waiting: await waitingCount(env, hostUid), paused, open: (host.call_mode ?? "online") === "online" && !paused };
  } catch { return { waiting: 0, paused: false, open: false }; }
}

/**
 * Close the whole queue (mode left 'online', account closing, host forced offline): every waiting entry -> 'closed' with skip_reason, WhatsApp
 * each fan, release any 'q:' lock. Returns how many entries were closed. Cheap no-op (no DO call) when nobody is queued.
 */
export async function closeQueue(env: Env, hostUid: string, reason: QueueSkipReason = "host_offline"): Promise<number> {
  try {
    const any = await env.DB_META.prepare("SELECT 1 AS x FROM hf_call_queue WHERE host_uid=?1 AND status IN ('waiting','offered') AND call_id IS NULL LIMIT 1").bind(hostUid).first().catch(() => null);
    if (!any) return 0;
    const r = await pokeLine(env, hostUid, { op: "mode", mode: "offline" as HostMode, reason });
    if (r && typeof r.closed === "number") return r.closed;
    // The DO is unreachable: close the rows directly so nobody waits for a host who is gone (no messages; the DO sends them when it is back).
    const now = Date.now();
    const res = await env.DB_META.prepare("UPDATE hf_call_queue SET status='closed', skip_reason=?2, ended_at=?3, updated_at=?3 WHERE host_uid=?1 AND status IN ('waiting','offered') AND call_id IS NULL").bind(hostUid, reason, now).run();
    await env.DB_META.prepare("UPDATE hf_hosts SET presence_call_id=NULL WHERE uid=?1 AND presence_call_id LIKE 'q:%'").bind(hostUid).run().catch(() => undefined);
    return Number(res.meta?.changes ?? 0);
  } catch { return 0; }
}

/** Lane A's queue-pause endpoint calls this. Writes hf_hosts.queue_paused through the DO so break/dispatch/expiry stay consistent. */
export async function setQueuePaused(env: Env, hostUid: string, paused: boolean, by: "host" | "system" = "host"): Promise<{ waiting: number; paused: boolean }> {
  const r = await pokeLine(env, hostUid, { op: "pause", paused, by });
  if (!r) { // DO unreachable: still persist the flag so the host's choice is honoured
    await env.DB_META.prepare("UPDATE hf_hosts SET queue_paused=?2 WHERE uid=?1").bind(hostUid, paused ? 1 : 0).run().catch(() => undefined);
  }
  return { waiting: await waitingCount(env, hostUid), paused };
}

/** GET /api/hosts/me/queue (Lane A route): first names only, never numbers. */
export async function hostQueueView(env: Env, hostUid: string): Promise<HostQueueView> {
  await dropBlockedEntries(env, hostUid).catch(() => 0);
  const host = await loadHostByUid(env, hostUid);
  const rows = await waitingRows(env, hostUid, 50);
  const entries: HostQueueView["entries"] = [];
  let i = 0;
  for (const r of rows) {
    const u = await env.DB_META.prepare("SELECT display_name FROM users WHERE uid=?1").bind(r.fan_uid).first<{ display_name: string | null }>().catch(() => null);
    entries.push({ position: ++i, firstName: queueFirstName(u?.display_name, "A fan"), joinedAt: Number(r.joined_at) });
  }
  return { ok: true, waiting: entries.length, paused: Number(host?.queue_paused ?? 0) === 1, entries };
}

/** Rule 10: blocks removed silently. Pass the host or the fan uid: every uncalled entry between a blocked pair is dropped. */
export async function dropBlockedEntries(env: Env, uid: string): Promise<number> {
  const now = Date.now();
  const r = await env.DB_META.prepare(
    `UPDATE hf_call_queue SET status='skipped', skip_reason='blocked', ended_at=?2, updated_at=?2
      WHERE status IN ('waiting','offered') AND call_id IS NULL AND (host_uid=?1 OR fan_uid=?1)
        AND EXISTS (SELECT 1 FROM hf_blocks b WHERE (b.blocker_uid=hf_call_queue.host_uid AND b.blocked_uid=hf_call_queue.fan_uid) OR (b.blocker_uid=hf_call_queue.fan_uid AND b.blocked_uid=hf_call_queue.host_uid))`,
  ).bind(uid, now).run().catch(() => null);
  return Number(r?.meta?.changes ?? 0);
}

/** GET /api/hf/queue/me */
export async function myQueueEntry(env: Env, fanUid: string): Promise<MyQueueResponse> {
  const row = await env.DB_META.prepare("SELECT * FROM hf_call_queue WHERE fan_uid=?1 AND status IN ('waiting','offered') LIMIT 1").bind(fanUid).first<QRow>().catch(() => null);
  if (!row) return { ok: true, entry: null };
  const host = await loadHostByUid(env, row.host_uid);
  return {
    ok: true,
    entry: {
      entryId: row.id, hostSlug: host?.slug ?? "", hostName: host?.display_name ?? "", position: await positionOf(env, row), status: row.status,
      ...(row.call_id ? { callId: row.call_id } : {}),
    },
  };
}

// ── WhatsApp (paced) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Queue one WhatsApp message for a fan. Idempotent per (entry, kind, urlHash). The send happens in flushWa (paced). Returns false when the fan
 * has no verified WhatsApp number or the same message was already queued.
 */
export async function queueWa(env: Env, row: Pick<QRow, "id" | "host_uid" | "fan_uid">, kind: QueueMsgKind, text: string, now: number, urlHash = "q"): Promise<boolean> {
  try {
    const e164 = await verifiedWhatsAppNumber(env, row.fan_uid);
    if (!e164) return false;
    const r = await env.DB_META.prepare(
      `INSERT OR IGNORE INTO whatsapp_outbox (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'hfq_pending',0,?8,?8)`,
    ).bind(row.id, row.fan_uid, row.host_uid, queueOutboxKind(kind), urlHash, e164, text, now).run();
    return Number(r.meta?.changes ?? 0) === 1;
  } catch (e) {
    await trackException(env, e, { route: "hf_queue.queueWa", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue", kind } }).catch(() => undefined);
    return false;
  }
}

interface PendingWa { id: number; checkout_id: string; uid: string; kind: string; e164: string; message: string; created_at: number; attempts: number }
async function pendingWa(env: Env, hostUid: string): Promise<PendingWa[]> {
  const r = await env.DB_META.prepare(
    `SELECT id, checkout_id, uid, kind, e164, message, created_at, attempts FROM whatsapp_outbox
      WHERE kind LIKE 'hf_queue_%' AND status='hfq_pending' AND listing_id=?1 ORDER BY created_at ASC, id ASC LIMIT 30`,
  ).bind(hostUid).all<PendingWa>().catch(() => null);
  return r?.results ?? [];
}
async function lastSentToFan(env: Env, uid: string): Promise<number> {
  const r = await env.DB_META.prepare("SELECT MAX(sent_at) AS t FROM whatsapp_outbox WHERE uid=?1 AND kind LIKE 'hf_queue_%' AND status='sent'").bind(uid).first<{ t: number | null }>().catch(() => null);
  return Number(r?.t ?? 0);
}

/** Send at most ONE pending queue message for this host (2 s pacing), honouring one-per-fan-per-60-s. Returns true if one was sent. */
export async function flushWa(env: Env, hostUid: string, st: LineState, now: number): Promise<boolean> {
  const rows = await pendingWa(env, hostUid);
  for (const w of rows) {
    if (now - w.created_at > WA_STALE_MS) {
      await env.DB_META.prepare("UPDATE whatsapp_outbox SET status='cancelled', error='stale', updated_at=?2 WHERE id=?1 AND status='hfq_pending'").bind(w.id, now).run().catch(() => undefined);
      continue;
    }
    // A join / next message is only worth sending while the fan is still in the queue.
    if (w.kind === queueOutboxKind("join") || w.kind === queueOutboxKind("next")) {
      const e = await getEntry(env, w.checkout_id);
      if (!e || !(e.status === "waiting" || e.status === "offered")) {
        await env.DB_META.prepare("UPDATE whatsapp_outbox SET status='cancelled', error='left_queue', updated_at=?2 WHERE id=?1 AND status='hfq_pending'").bind(w.id, now).run().catch(() => undefined);
        continue;
      }
    }
    if (now - st.lastSendAt < WA_HOST_GAP_MS) return false; // per-host send lock: try again on the next alarm
    if (now - (await lastSentToFan(env, w.uid)) < WA_FAN_GAP_MS) continue; // this fan was messaged < 60 s ago: later
    const claim = await env.DB_META.prepare("UPDATE whatsapp_outbox SET status='sending', attempts=attempts+1, updated_at=?2 WHERE id=?1 AND status='hfq_pending'").bind(w.id, now).run();
    if (!Number(claim.meta?.changes ?? 0)) continue;
    st.lastSendAt = now;
    let res: Awaited<ReturnType<typeof sendWhatsAppText>>;
    try { res = await sendWhatsAppText(env, w.e164, w.message); } catch (e) { res = { ok: false, reason: "provider_error", detail: String(e).slice(0, 100) }; }
    if (res.ok) {
      await env.DB_META.prepare("UPDATE whatsapp_outbox SET status='sent', sent_at=?2, updated_at=?2, error=NULL WHERE id=?1").bind(w.id, now).run().catch(() => undefined);
      if (w.kind === queueOutboxKind("join")) await env.DB_META.prepare("UPDATE hf_call_queue SET wa_join_at=?2 WHERE id=?1").bind(w.checkout_id, now).run().catch(() => undefined);
      if (w.kind === queueOutboxKind("next")) await env.DB_META.prepare("UPDATE hf_call_queue SET wa_next_at=?2 WHERE id=?1").bind(w.checkout_id, now).run().catch(() => undefined);
    } else if (res.reason === "rate_limited" && w.attempts + 1 < 4) {
      await env.DB_META.prepare("UPDATE whatsapp_outbox SET status='hfq_pending', error=?2, updated_at=?3 WHERE id=?1").bind(w.id, res.detail.slice(0, 120), now).run().catch(() => undefined);
    } else {
      await env.DB_META.prepare("UPDATE whatsapp_outbox SET status='failed', error=?2, updated_at=?3 WHERE id=?1").bind(w.id, `${res.reason}: ${res.detail}`.slice(0, 160), now).run().catch(() => undefined);
    }
    return res.ok;
  }
  return false;
}

/** When the next WhatsApp flush can send something (null = nothing pending). */
async function nextWaAt(env: Env, hostUid: string, st: LineState, now: number): Promise<number | null> {
  const rows = await pendingWa(env, hostUid);
  let best: number | null = null;
  for (const w of rows) {
    const at = Math.max(st.lastSendAt + WA_HOST_GAP_MS, (await lastSentToFan(env, w.uid)) + WA_FAN_GAP_MS, now);
    if (best == null || at < best) best = at;
  }
  return best;
}

// ── booking cutoff (rule 9). Mirrors routes/hf_calls.ts nextBookingCutoff (not exported there; Lane C owns that file). ───────────────────
async function bookingCutoff(env: Env, parties: [string, string], now: number): Promise<number | null> {
  try {
    const active = await env.DB_META.prepare(
      "SELECT 1 AS x FROM hf_bookings b WHERE b.status IN ('confirmed','pending_approval','starting','active','settling') " +
      "AND (b.host_uid IN (?1,?2) OR b.customer_uid IN (?1,?2)) AND b.starts_at<=?3 " +
      "AND b.ends_at+COALESCE((SELECT buffer_min*60000 FROM hf_availability_schedules s WHERE s.host_uid=b.host_uid),600000)>?3 LIMIT 1",
    ).bind(parties[0], parties[1], now).first();
    if (active) return now;
    const next = await env.DB_META.prepare(
      "SELECT MIN(b.starts_at-COALESCE((SELECT buffer_min*60000 FROM hf_availability_schedules s WHERE s.host_uid=b.host_uid),600000)) AS cutoff " +
      "FROM hf_bookings b WHERE b.status IN ('confirmed','pending_approval','starting','active','settling') " +
      "AND (b.host_uid IN (?1,?2) OR b.customer_uid IN (?1,?2)) AND b.starts_at>?3",
    ).bind(parties[0], parties[1], now).first<{ cutoff: number | null }>();
    return next?.cutoff == null ? null : Number(next.cutoff);
  } catch { return null; }
}

// ── money gate (D2) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function hostPrice(host: HostRow, cfg: QueueCfg): Promise<Price | null> {
  const rate = Math.trunc(Number(host.price_per_min));
  try {
    if (isCreatorCategory(host.category)) return validCreatorRate(rate) ? creatorSnapshotFor(host.category, rate).ratePaise : null;
    const std = pricingStd(readHfStdPlan(cfg.raw), cfg.raw);
    if (std.enabled) return std.tariff;
  } catch { /* fall through to the host's own rate */ }
  return rate > 0 ? rate * 100 : null;
}
/** max(the wallet minimum, one chunk at her rate), in paise. */
export async function startNeedPaise(env: Env, host: HostRow, cfg: QueueCfg): Promise<number> {
  const rules = await readMoneyRules(env);
  const price = await hostPrice(host, cfg);
  const chunk = price == null ? 0 : chargePaise(price, cfg.chunkMin * 60);
  return Math.max(rules.minBalancePaise, chunk);
}
async function balanceCheck(env: Env, fanUid: string, host: HostRow, cfg: QueueCfg): Promise<{ ok: boolean; needPaise: number; shortfallPaise: number }> {
  const needPaise = await startNeedPaise(env, host, cfg);
  let have = 0;
  try { have = walletSpendablePaise(await availableLots(env, fanUid)); } catch { have = 0; }
  return { ok: have >= needPaise, needPaise, shortfallPaise: Math.max(0, needPaise - have) };
}

// ── mutations (all run inside the host's DO, one at a time) ──────────────────────────────────────────────────────────────────────────────
async function releaseQueueLock(env: Env, hostUid: string, entryId: string): Promise<void> {
  await env.DB_META.prepare("UPDATE hf_hosts SET presence_call_id=NULL WHERE uid=?1 AND presence_call_id=?2").bind(hostUid, queueLockId(entryId)).run().catch(() => undefined);
}
function endEntry(st: LineState, id: string) { delete st.joinPos[id]; }

/** Join (spec rules 1 and 2). Fan-side gates (age, WhatsApp, lane) are in routes/hf_queue.ts; everything about the host and the line is here. */
export async function joinQueue(env: Env, hostUid: string, fanUid: string, entryId: string, st: LineState, now: number): Promise<LineResponse> {
  const cfg = await readQueueCfg(env);
  if (!cfg.enabled) return { ok: false, error: "queue_closed", reason: "feature_off" };
  const host = await loadHostByUid(env, hostUid);
  if (!host || host.status !== "live" || host.uid === fanUid) return { ok: false, error: "queue_closed", reason: "unavailable" };
  const mine = await env.DB_META.prepare("SELECT h.slug AS slug FROM hf_call_queue q LEFT JOIN hf_hosts h ON h.uid=q.host_uid WHERE q.fan_uid=?1 AND q.status IN ('waiting','offered') LIMIT 1")
    .bind(fanUid).first<{ slug: string | null }>().catch(() => null);
  if (mine) return { ok: false, error: "already_queued", hostSlug: mine.slug ?? undefined };
  if ((host.call_mode ?? "online") !== "online") return { ok: false, error: "queue_closed", reason: "mode" };
  if (Number(host.queue_paused ?? 0) === 1) return { ok: false, error: "queue_closed", reason: "paused" };
  if ((await isClosing(env, hostUid)) || (await isClosing(env, fanUid)) || (await isBlockedEitherWay(env, fanUid, hostUid))) return { ok: false, error: "queue_closed", reason: "unavailable" };
  const open = await env.DB_META.prepare(`SELECT 1 AS x FROM hf_calls WHERE caller_uid=?1 AND status IN (${activePlaceholders(3)}) AND created_at>?2 LIMIT 1`)
    .bind(fanUid, now - 25 * 3600_000, ...ACTIVE_STATUSES).first().catch(() => null);
  if (open) return { ok: false, error: "call_in_progress" };
  const waiting = await waitingCount(env, hostUid);
  const state = publicCallState({ mode: host.call_mode, onCallSince: host.on_call_since, lockCallId: host.presence_call_id, waiting });
  if (state !== "on_call" && state !== "connecting" && state !== "queue_only") return { ok: false, error: "queue_closed", reason: state };
  if (waiting >= cfg.maxLen) return { ok: false, error: "queue_full", waiting };
  const bal = await balanceCheck(env, fanUid, host, cfg);
  if (!bal.ok) return { ok: false, error: "low_balance", shortfallPaise: bal.shortfallPaise };
  try {
    await env.DB_META.prepare(
      `INSERT INTO hf_call_queue (id, host_uid, fan_uid, seq, status, joined_at, updated_at)
       SELECT ?1, ?2, ?3, COALESCE(MAX(seq),0)+1, 'waiting', ?4, ?4 FROM hf_call_queue WHERE host_uid=?2`,
    ).bind(entryId, hostUid, fanUid, now).run();
  } catch {
    // The unique index: two simultaneous joins from one fan, one wins.
    const again = await env.DB_META.prepare("SELECT h.slug AS slug FROM hf_call_queue q LEFT JOIN hf_hosts h ON h.uid=q.host_uid WHERE q.fan_uid=?1 AND q.status IN ('waiting','offered') LIMIT 1").bind(fanUid).first<{ slug: string | null }>().catch(() => null);
    return { ok: false, error: "already_queued", hostSlug: again?.slug ?? undefined };
  }
  const row = (await getEntry(env, entryId))!;
  const position = await positionOf(env, row);
  st.joinPos[entryId] = position;
  await queueWa(env, row, "join", queueJoinedMsg(hostLabel(host), position, host.slug ?? ""), now);
  void track(env, fanUid, "hf_queue_joined", HF_CALL_APP, { area: "hf_queue", host_uid: hostUid, position }).catch(() => undefined);
  // Waiters but no break running and the line idle (e.g. a booking hold ended): get the machine going.
  if (!st.breakEntryId) await evaluateIdle(env, cfg, hostUid, st, now, cfg.breakSec * 1000);
  return { ok: true, entryId, position, waiting: await waitingCount(env, hostUid) };
}

/** Leave (rule 12): any time, no message. */
export async function leaveQueue(env: Env, hostUid: string, fanUid: string, entryId: string | undefined, st: LineState, now: number): Promise<LineResponse> {
  const row = await env.DB_META.prepare(
    `SELECT * FROM hf_call_queue WHERE host_uid=?1 AND fan_uid=?2 AND ${WAITING_SQL} ${entryId ? "AND id=?3" : ""} LIMIT 1`,
  ).bind(...(entryId ? [hostUid, fanUid, entryId] : [hostUid, fanUid])).first<QRow>().catch(() => null);
  if (!row) return { ok: true, waiting: await waitingCount(env, hostUid) };
  await env.DB_META.prepare("UPDATE hf_call_queue SET status='left', ended_at=?2, updated_at=?2 WHERE id=?1 AND status IN ('waiting','offered')").bind(row.id, now).run();
  endEntry(st, row.id);
  void track(env, fanUid, "hf_queue_left", HF_CALL_APP, { area: "hf_queue", wait_s: waitS(row, now) }).catch(() => undefined);
  if (st.breakEntryId === row.id) {
    st.breakEntryId = null; st.breakAt = null;
    await releaseQueueLock(env, hostUid, row.id);
    const cfg = await readQueueCfg(env);
    await evaluateIdle(env, cfg, hostUid, st, now, QUEUE_SKIP_DELAY_MS);
  }
  return { ok: true, waiting: await waitingCount(env, hostUid) };
}

/** Rule 4: pick the head, take the line ('q:<id>'), send the heads-up once, start the break. */
async function evaluateIdle(env: Env, cfg: QueueCfg, hostUid: string, st: LineState, now: number, delayMs: number): Promise<void> {
  if (!cfg.enabled || st.breakEntryId) return;
  const host = await loadHostByUid(env, hostUid);
  if (!host || host.status !== "live") return;
  if ((host.call_mode ?? "online") !== "online" || Number(host.queue_paused ?? 0) === 1) return;
  if (host.presence_call_id || host.on_call_since != null) return; // the line is taken (a call, a booking or a break): line-free will come back here
  // Rule 9, host side: a booking starting within 5 minutes holds everyone. The booked call's own line-free (or the 5-minute sweep) retries.
  if (cfg.bookingsOn) {
    const hostCut = await bookingCutoff(env, [hostUid, hostUid], now);
    if (hostCut != null && hostCut - now < QUEUE_BOOKING_GAP_MS) return;
  }
  for (const head of await waitingRows(env, hostUid, 10)) {
    if (head.status !== "waiting") continue;
    if (cfg.bookingsOn) { // rule 9, fan side: the fan's own booking is too close, for this fan only
      const cut = await bookingCutoff(env, [hostUid, head.fan_uid], now);
      if (cut != null && cut - now < QUEUE_BOOKING_GAP_MS) { await skipEntry(env, cfg, host, head, st, now, "booking_conflict", "booking", false); continue; }
    }
    const claim = await env.DB_META.prepare(
      "UPDATE hf_hosts SET presence_call_id=?2 WHERE uid=?1 AND presence_call_id IS NULL AND on_call_since IS NULL AND status='live' AND call_mode='online'",
    ).bind(hostUid, queueLockId(head.id)).run();
    if (!Number(claim.meta?.changes ?? 0)) { st.retryAt = now + START_RETRY_MS; return; }
    await env.DB_META.prepare("UPDATE hf_call_queue SET status='offered', offered_at=?2, updated_at=?2 WHERE id=?1 AND status='waiting'").bind(head.id, now).run();
    st.breakEntryId = head.id; st.breakAt = now + delayMs; st.retryAt = null;
    if (head.wa_next_at == null) { // heads-up WhatsApp + push, once (the outbox dedupes the WhatsApp; wa_next_at is set when it is actually sent)
      await queueWa(env, head, "next", queueNextMsg(hostLabel(host), Math.round(delayMs / 1000)), now);
      void sendHfPush(env, head.fan_uid, { kind: "queue_next", title: BRAND.name, body: `You're next for ${hostLabel(host)}. Keep your phone free.`, path: `/h/${host.slug ?? ""}` }).catch(() => undefined);
    }
    return;
  }
}

/** End a waiting/offered entry with a reason, tell the fan (unless silent), free the line and (optionally) move on to the next fan. */
async function skipEntry(env: Env, cfg: QueueCfg, host: HostRow, row: QRow, st: LineState, now: number, reason: QueueSkipReason, msg: QueueMsgKind | null, advance: boolean, needPaise = 0): Promise<void> {
  await env.DB_META.prepare("UPDATE hf_call_queue SET status='skipped', skip_reason=?2, ended_at=?3, updated_at=?3 WHERE id=?1 AND status IN ('waiting','offered')").bind(row.id, reason, now).run();
  endEntry(st, row.id);
  if (st.breakEntryId === row.id) { st.breakEntryId = null; st.breakAt = null; }
  await releaseQueueLock(env, host.uid, row.id);
  const name = hostLabel(host);
  const slug = host.slug ?? "";
  if (msg === "noanswer") await queueWa(env, row, "noanswer", queueNoAnswerMsg(name, slug), now);
  else if (msg === "lowbalance") await queueWa(env, row, "lowbalance", queueLowBalanceMsg(name, needPaise), now);
  else if (msg === "booking") await queueWa(env, row, "booking", queueBookingMsg(name, slug), now);
  else if (msg === "trouble") await queueWa(env, row, "trouble", queueTroubleMsg(name, slug), now);
  void track(env, row.fan_uid, "hf_queue_skipped", HF_CALL_APP, { area: "hf_queue", reason }).catch(() => undefined);
  if (advance) await evaluateIdle(env, cfg, host.uid, st, now, reason === "low_balance" || reason === "blocked" ? 0 : QUEUE_SKIP_DELAY_MS);
}

/** Break over: re-check rule 1 and place the call (the influencer is rung first, HF-CALL-1; that is startInstantCall's job). */
async function dispatch(env: Env, cfg: QueueCfg, hostUid: string, st: LineState, now: number): Promise<void> {
  const entryId = st.breakEntryId;
  st.breakEntryId = null; st.breakAt = null;
  if (!entryId) return;
  const host = await loadHostByUid(env, hostUid);
  const row = await getEntry(env, entryId);
  if (!host || !row || row.status !== "offered" || row.call_id) { await releaseQueueLock(env, hostUid, entryId); return evaluateIdle(env, cfg, hostUid, st, now, 0); }
  const paused = Number(host.queue_paused ?? 0) === 1;
  if (!cfg.enabled || (host.call_mode ?? "online") !== "online" || paused || host.presence_call_id !== queueLockId(entryId)) {
    // Mode / pause handlers normally got here first; stay safe: put the entry back and free the line.
    await env.DB_META.prepare("UPDATE hf_call_queue SET status='waiting', offered_at=NULL, updated_at=?2 WHERE id=?1 AND status='offered' AND call_id IS NULL").bind(entryId, now).run();
    await releaseQueueLock(env, hostUid, entryId);
    return;
  }
  // blocks / closing: silent (rule 10)
  if ((await isBlockedEitherWay(env, row.fan_uid, hostUid)) || (await isClosing(env, row.fan_uid)) || (await isClosing(env, hostUid))) return skipEntry(env, cfg, host, row, st, now, "blocked", null, true);
  // the fan is on another call
  const busy = await env.DB_META.prepare(`SELECT 1 AS x FROM hf_calls WHERE caller_uid=?1 AND status IN (${activePlaceholders(3)}) AND created_at>?2 LIMIT 1`)
    .bind(row.fan_uid, now - 25 * 3600_000, ...ACTIVE_STATUSES).first().catch(() => null);
  if (busy) return skipEntry(env, cfg, host, row, st, now, "fan_no_answer", "noanswer", true);
  // rule 1 re-check: money
  const bal = await balanceCheck(env, row.fan_uid, host, cfg);
  if (!bal.ok) return skipEntry(env, cfg, host, row, st, now, "low_balance", "lowbalance", true, bal.needPaise);
  // rule 9: booking first
  let hardEndsAt: number | undefined;
  if (cfg.bookingsOn) {
    const hostCut = await bookingCutoff(env, [hostUid, hostUid], now);
    if (hostCut != null && hostCut - now < QUEUE_BOOKING_GAP_MS) { // hold everyone; the booked call's line-free (or the sweep) retries
      await env.DB_META.prepare("UPDATE hf_call_queue SET status='waiting', offered_at=NULL, updated_at=?2 WHERE id=?1 AND status='offered' AND call_id IS NULL").bind(entryId, now).run();
      await releaseQueueLock(env, hostUid, entryId);
      return;
    }
    const cut = await bookingCutoff(env, [hostUid, row.fan_uid], now);
    if (cut != null && cut - now < QUEUE_BOOKING_GAP_MS) return skipEntry(env, cfg, host, row, st, now, "booking_conflict", "booking", true);
    if (cut != null) hardEndsAt = cut;
  }
  let result: Awaited<ReturnType<typeof startInstantCall>>;
  try {
    result = await startInstantCall(env, { callerUid: row.fan_uid, hostUid, source: "queue", queueEntryId: entryId, ...(hardEndsAt != null ? { hardEndsAt } : {}) });
  } catch (e) {
    result = { ok: false, error: "start_threw" };
    await trackException(env, e, { uid: row.fan_uid, route: "hf_queue.dispatch", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue" } }).catch(() => undefined);
  }
  if (result.ok) {
    st.startFails = 0;
    await env.DB_META.prepare("UPDATE hf_call_queue SET call_id=?2, updated_at=?3 WHERE id=?1").bind(entryId, result.callId, now).run();
    void track(env, row.fan_uid, "hf_queue_dispatched", HF_CALL_APP, { area: "hf_queue", wait_s: waitS(row, now), position_at_join: st.joinPos[entryId] ?? null, call_id: result.callId }).catch(() => undefined);
    delete st.joinPos[entryId];
    return;
  }
  if (result.error === "low_balance" || result.error === "debt_open") return skipEntry(env, cfg, host, row, st, now, "low_balance", "lowbalance", true, bal.needPaise);
  if (result.error === "booking_window_conflict") return skipEntry(env, cfg, host, row, st, now, "booking_conflict", "booking", true);
  // System-side trouble: free the line, keep the place, retry shortly; after MAX_START_FAILS in a row give this fan up with a neutral message.
  st.startFails += 1;
  if (st.startFails >= MAX_START_FAILS) { st.startFails = 0; return skipEntry(env, cfg, host, row, st, now, "host_missed", "trouble", true); }
  await env.DB_META.prepare("UPDATE hf_call_queue SET status='waiting', offered_at=NULL, updated_at=?2 WHERE id=?1 AND status='offered' AND call_id IS NULL").bind(entryId, now).run();
  await releaseQueueLock(env, hostUid, entryId);
  st.retryAt = now + START_RETRY_MS;
}

/** The host's line is free (HfCallDO released it). Settles the entry tied to this call, counts host misses (D3), starts the next break. */
export async function lineFree(env: Env, hostUid: string, callId: string, outcome: LineOutcome, st: LineState, now: number): Promise<LineResponse> {
  const cfg = await readQueueCfg(env);
  if (!cfg.enabled) return { ok: true };
  const host = await loadHostByUid(env, hostUid);
  if (!host) return { ok: true };
  const entry = await env.DB_META.prepare("SELECT * FROM hf_call_queue WHERE host_uid=?1 AND call_id=?2 AND status='offered' LIMIT 1").bind(hostUid, callId).first<QRow>().catch(() => null);
  let delay = cfg.breakSec * 1000;
  if (entry) {
    if (outcome === "completed") {
      await env.DB_META.prepare("UPDATE hf_call_queue SET status='done', ended_at=?2, updated_at=?2 WHERE id=?1").bind(entry.id, now).run();
      endEntry(st, entry.id); st.missStreak = 0; st.startFails = 0;
    } else if (outcome === "fan_no_answer") {
      await skipEntry(env, cfg, host, entry, st, now, "fan_no_answer", "noanswer", false);
      delay = QUEUE_SKIP_DELAY_MS;
    } else if (outcome === "host_missed") {
      // D3: the first miss keeps the fan's front place (same seq, back to waiting); the second consecutive miss pauses the queue.
      await env.DB_META.prepare("UPDATE hf_call_queue SET status='waiting', call_id=NULL, offered_at=NULL, host_miss_count=host_miss_count+1, updated_at=?2 WHERE id=?1").bind(entry.id, now).run();
      st.missStreak += 1;
      if (st.missStreak >= 2) { await setPaused(env, cfg, host, st, true, "system", now); return { ok: true, waiting: await waitingCount(env, hostUid), paused: true }; }
    } else { // failed: not the influencer's fault; keep the place and retry, give up on this fan after a few in a row
      st.startFails += 1;
      if (st.startFails >= MAX_START_FAILS) { st.startFails = 0; await skipEntry(env, cfg, host, entry, st, now, "host_missed", "trouble", false); }
      else await env.DB_META.prepare("UPDATE hf_call_queue SET status='waiting', call_id=NULL, offered_at=NULL, updated_at=?2 WHERE id=?1").bind(entry.id, now).run();
      delay = QUEUE_SKIP_DELAY_MS;
    }
  }
  await evaluateIdle(env, cfg, hostUid, st, now, delay);
  return { ok: true, waiting: await waitingCount(env, hostUid) };
}

/** Rule 8 (mode): every waiter whose call is not yet placed is told and closed; the 'q:' lock is released. */
export async function closeAll(env: Env, hostUid: string, reason: QueueSkipReason, st: LineState, now: number): Promise<LineResponse> {
  const host = await loadHostByUid(env, hostUid);
  const rows = (await env.DB_META.prepare("SELECT * FROM hf_call_queue WHERE host_uid=?1 AND status IN ('waiting','offered') AND call_id IS NULL ORDER BY seq ASC").bind(hostUid).all<QRow>().catch(() => null))?.results ?? [];
  for (const r of rows) {
    await env.DB_META.prepare("UPDATE hf_call_queue SET status='closed', skip_reason=?2, ended_at=?3, updated_at=?3 WHERE id=?1 AND status IN ('waiting','offered')").bind(r.id, reason, now).run();
    endEntry(st, r.id);
    if (host) await queueWa(env, r, "closed", queueClosedMsg(hostLabel(host), host.slug ?? ""), now);
  }
  await env.DB_META.prepare("UPDATE hf_hosts SET presence_call_id=NULL WHERE uid=?1 AND presence_call_id LIKE 'q:%'").bind(hostUid).run().catch(() => undefined);
  st.breakEntryId = null; st.breakAt = null; st.retryAt = null; st.missStreak = 0; st.startFails = 0; st.pausedAt = null;
  if (rows.length) void track(env, hostUid, "hf_queue_closed", HF_CALL_APP, { area: "hf_queue", reason, waiting: rows.length }).catch(() => undefined);
  return { ok: true, closed: rows.length, waiting: 0 };
}

/** Mode change from the influencer (or account closing). Anything but 'online' closes the queue. */
export async function modeChanged(env: Env, hostUid: string, mode: HostMode | string, reason: QueueSkipReason, st: LineState, now: number): Promise<LineResponse> {
  if (mode !== "online") return closeAll(env, hostUid, reason, st, now);
  const cfg = await readQueueCfg(env);
  await evaluateIdle(env, cfg, hostUid, st, now, cfg.breakSec * 1000);
  return { ok: true, waiting: await waitingCount(env, hostUid) };
}

async function setPaused(env: Env, cfg: QueueCfg, host: HostRow, st: LineState, paused: boolean, by: "host" | "system", now: number): Promise<void> {
  await env.DB_META.prepare("UPDATE hf_hosts SET queue_paused=?2 WHERE uid=?1").bind(host.uid, paused ? 1 : 0).run();
  void track(env, host.uid, "hf_queue_paused", HF_CALL_APP, { area: "hf_queue", paused, by }).catch(() => undefined);
  if (paused) {
    st.pausedAt = now; st.retryAt = null;
    if (st.breakEntryId) { // cancel the running break: the head returns to the front of the line
      await env.DB_META.prepare("UPDATE hf_call_queue SET status='waiting', offered_at=NULL, updated_at=?2 WHERE id=?1 AND status='offered' AND call_id IS NULL").bind(st.breakEntryId, now).run();
      await releaseQueueLock(env, host.uid, st.breakEntryId);
      st.breakEntryId = null; st.breakAt = null;
    }
    for (const r of await waitingRows(env, host.uid, 50)) await queueWa(env, r, "paused", queuePausedMsg(hostLabel(host), cfg.pauseExpireMin), now, `p${now}`);
  } else {
    st.pausedAt = null; st.missStreak = 0;
    await evaluateIdle(env, cfg, host.uid, st, now, cfg.breakSec * 1000);
  }
}
export async function pauseChanged(env: Env, hostUid: string, paused: boolean, by: "host" | "system", st: LineState, now: number): Promise<LineResponse> {
  const cfg = await readQueueCfg(env);
  const host = await loadHostByUid(env, hostUid);
  if (!host) return { ok: false };
  await setPaused(env, cfg, host, st, paused, by, now);
  return { ok: true, waiting: await waitingCount(env, hostUid), paused };
}

/** Rule 11 + paused expiry + silent block removal. */
async function expireEntries(env: Env, cfg: QueueCfg, host: HostRow, st: LineState, now: number): Promise<void> {
  await dropBlockedEntries(env, host.uid);
  const paused = Number(host.queue_paused ?? 0) === 1;
  if (paused && st.pausedAt == null) st.pausedAt = now; // paused before this DO knew (restart): start the clock now
  for (const r of await waitingRows(env, host.uid, 50)) {
    if (r.status !== "waiting") continue;
    const tooLong = now - r.joined_at >= cfg.maxWaitMin * 60_000;
    const pauseOver = paused && st.pausedAt != null && now - st.pausedAt >= cfg.pauseExpireMin * 60_000;
    if (!tooLong && !pauseOver) continue;
    await env.DB_META.prepare("UPDATE hf_call_queue SET status='expired', ended_at=?2, updated_at=?2 WHERE id=?1 AND status='waiting'").bind(r.id, now).run();
    endEntry(st, r.id);
    await queueWa(env, r, "expired", queueExpiredMsg(hostLabel(host)), now);
    void track(env, r.fan_uid, "hf_queue_left", HF_CALL_APP, { area: "hf_queue", wait_s: waitS(r, now), expired: true }).catch(() => undefined);
  }
}

/** Lost-alarm / orphan repair, run by the 5-minute cron through the DO ({op:'sweep'}). */
async function repairOrphans(env: Env, host: HostRow, st: LineState, now: number): Promise<void> {
  // 1. A 'q:' lock this DO does not know about (alarm lost, DO restarted): free it and put the entry back.
  if (isQueueLock(host.presence_call_id) && host.presence_call_id !== queueLockId(st.breakEntryId ?? "")) {
    const id = host.presence_call_id.slice(2);
    const e = await getEntry(env, id);
    if (e && e.status === "offered" && !e.call_id) await env.DB_META.prepare("UPDATE hf_call_queue SET status='waiting', offered_at=NULL, updated_at=?2 WHERE id=?1").bind(id, now).run();
    await releaseQueueLock(env, host.uid, id);
  }
  // 2. A break that should have fired long ago: fire it now.
  if (st.breakEntryId && st.breakAt != null && now - st.breakAt > 60_000) st.breakAt = now;
  // 3. An offered entry whose call is already over but whose line-free never arrived.
  const cfg = await readQueueCfg(env);
  const stuck = (await env.DB_META.prepare(
    "SELECT q.call_id AS call_id, c.status AS cstatus, c.end_reason AS end_reason, c.connected_at AS connected_at FROM hf_call_queue q JOIN hf_calls c ON c.id=q.call_id WHERE q.host_uid=?1 AND q.status='offered' AND q.call_id IS NOT NULL",
  ).bind(host.uid).all<{ call_id: string; cstatus: string; end_reason: string | null; connected_at: number | null }>().catch(() => null))?.results ?? [];
  for (const s of stuck) {
    if ((ACTIVE_STATUSES as readonly string[]).includes(s.cstatus)) continue;
    await releaseHost(env, host.uid, s.call_id).catch(() => undefined);
    if (cfg.enabled) await lineFree(env, host.uid, s.call_id, outcomeFromCall({ status: s.cstatus, end_reason: s.end_reason, connected_at: s.connected_at }), st, now);
  }
}

/** Everything time-driven: runs on every alarm and on the cron sweep. Idempotent. */
export async function tick(env: Env, hostUid: string, st: LineState, now: number, sweep = false): Promise<void> {
  const cfg = await readQueueCfg(env);
  if (!cfg.enabled) { await flushWa(env, hostUid, st, now).catch(() => false); return; }
  let host = await loadHostByUid(env, hostUid);
  if (!host) return;
  if ((host.call_mode ?? "online") !== "online" && (await waitingCount(env, hostUid)) > 0) await closeAll(env, hostUid, "host_offline", st, now);
  if (sweep) { await repairOrphans(env, host, st, now); host = (await loadHostByUid(env, hostUid)) ?? host; }
  await expireEntries(env, cfg, host, st, now);
  if (st.breakEntryId && st.breakAt != null && st.breakAt <= now) await dispatch(env, cfg, hostUid, st, now);
  else if (!st.breakEntryId) {
    const retry = st.retryAt != null && st.retryAt <= now;
    if (retry || sweep) { st.retryAt = null; await evaluateIdle(env, cfg, hostUid, st, now, retry ? QUEUE_SKIP_DELAY_MS : cfg.breakSec * 1000); }
  }
  await flushWa(env, hostUid, st, now).catch(() => false);
}

/** The next time this host's DO must wake (null = nothing to do; the DO deletes its alarm). */
export async function nextAlarmAt(env: Env, hostUid: string, st: LineState, now: number): Promise<number | null> {
  const cfg = await readQueueCfg(env);
  const c: number[] = [];
  if (st.breakEntryId && st.breakAt != null) c.push(st.breakAt);
  if (st.retryAt != null) c.push(st.retryAt);
  const waiting = await env.DB_META.prepare("SELECT MIN(joined_at) AS t, COUNT(*) AS n FROM hf_call_queue WHERE host_uid=?1 AND status='waiting'").bind(hostUid).first<{ t: number | null; n: number }>().catch(() => null);
  if (waiting && Number(waiting.n) > 0 && waiting.t != null) {
    c.push(Number(waiting.t) + cfg.maxWaitMin * 60_000);
    if (st.pausedAt != null) c.push(st.pausedAt + cfg.pauseExpireMin * 60_000);
  }
  const wa = await nextWaAt(env, hostUid, st, now);
  if (wa != null) c.push(wa);
  return c.length ? Math.min(...c) : null;
}

/** 5-minute cron safety net (index.ts scheduled()): wakes only hosts that have queue rows or a stale 'q:' lock. Flag off: nothing. */
export async function runHfQueueCron(env: Env): Promise<{ hosts: number }> {
  try {
    if (!(await queueEnabled(env))) return { hosts: 0 };
    const rows = (await env.DB_META.prepare(
      `SELECT host_uid AS h FROM hf_call_queue WHERE status IN ('waiting','offered')
       UNION SELECT uid AS h FROM hf_hosts WHERE presence_call_id LIKE 'q:%' LIMIT 50`,
    ).all<{ h: string }>().catch(() => null))?.results ?? [];
    for (const r of rows) await pokeLine(env, r.h, { op: "sweep" });
    return { hosts: rows.length };
  } catch (e) {
    await trackException(env, e, { route: "hf_queue.cron", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue" } }).catch(() => undefined);
    return { hosts: 0 };
  }
}
