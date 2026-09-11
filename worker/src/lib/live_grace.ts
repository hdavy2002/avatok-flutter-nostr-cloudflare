// [LIVE-GRACE-1] RULEBOOK-PAID-SESSIONS.md v2 §4 L4/L5 — a creator (host) drop
// mid-broadcast gets a grace window before the event is ended and viewers are
// refunded the unconsumed part. This lib owns the three moves:
//   1. `armLiveGrace` — a host `participant_left` while the session is live
//      starts the window: writes `reconnect_deadline_ms`, opens a
//      `commercial_live_outages` row, arms the DO's `live_grace` alarm
//      (`live:<listingId>`), pushes `commercial_reconnect` to the creator.
//   2. `clearLiveGrace` — the host rejoins before the deadline: clears the
//      deadline, closes the outage row, disarms the DO alarm.
//   3. `endLiveOnHostNoReturn` — the DO's `live_grace` alarm fires with no
//      rejoin: ends the session with `end_outcome='host_no_return'`, closes
//      intervals + the outage, queues settlement (the per-ticket unconsumed
//      refund is computed in `commercial_settlement.ts`, gated on that
//      outcome).
//
// Deliberately does NOT touch `commercial_sessions.state`'s CHECK constraint —
// 'reconnecting' is never written to the `state` column (SQLite CHECK
// constraints need a full table rebuild to widen; not ALTER-only-safe — see
// migrations/2026-09-11-live-grace-alter.sql). The raw state stays 'live'
// throughout the grace window; `reconnect_deadline_ms` (non-null and not yet
// passed) is what `commercialLiveState`/`safeSessionState`
// (routes/commercial_stream_sessions.ts) project as state:'reconnecting' to
// callers — WP5 (web) and WP7 (app) read exactly that combination.
//
// No import from routes/commercial_stream_sessions.ts or do/stream_session.ts
// on purpose: both of those import THIS file (arming/clearing from the
// webhook handler, ending from the DO alarm), and a two-way import would be a
// circular dependency for no reason — everything this lib needs (D1 access,
// config, the DO op, notifications, the listing projection) already has its
// own home elsewhere.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { sessionOp } from "../routes/live";
import { notifyCommercialUser, notifyLiveAudience } from "./commercial_notifications";
import { systemMarkListingCompleted } from "../routes/listings";
import { refreshCreatorStats } from "./creator_stats";
import { commercialEvent } from "./commercial_telemetry";

export interface LiveGraceSession {
  commercialSessionId: string;
  listingId: string;
  creatorId: string;
}

/** Host `participant_left` while the event is live: arm the reconnect grace
 * window. Idempotent — a duplicate/replayed webhook for an already-armed
 * window (or a session that is no longer 'live') is a no-op. */
export async function armLiveGrace(env: Env, s: LiveGraceSession, hostLeftAtMs: number): Promise<void> {
  const cfg = await readConfig(env) as unknown as Record<string, unknown>;
  const graceMinRaw = Number(cfg.liveHostGraceMin);
  const graceMs = (Number.isFinite(graceMinRaw) && graceMinRaw > 0 ? graceMinRaw : 10) * 60_000;
  const deadline = hostLeftAtMs + graceMs;
  const armed = await metaDb(env).prepare(
    `UPDATE commercial_sessions SET reconnect_deadline_ms=?2,updated_at=?3
       WHERE commercial_session_id=?1 AND state='live' AND reconnect_deadline_ms IS NULL`,
  ).bind(s.commercialSessionId, deadline, Date.now()).run();
  if ((armed.meta?.changes ?? 0) === 0) return; // already armed, or not live — replayed webhook
  await metaDb(env).prepare(
    `INSERT INTO commercial_live_outages (outage_id,commercial_session_id,started_at,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?4)`,
  ).bind(`${s.commercialSessionId}:${hostLeftAtMs}`, s.commercialSessionId, hostLeftAtMs, Date.now()).run();
  await sessionOp(env, `live:${s.listingId}`, { op: "live_grace_arm", t: deadline });
  await notifyCommercialUser(env, s.creatorId, {
    type: "commercial_reconnect",
    eventId: `${s.commercialSessionId}:reconnect:${hostLeftAtMs}`,
    listingId: s.listingId,
    sessionId: s.commercialSessionId,
    title: "You're disconnected from your live event",
    body: "Rejoin now to keep your event running — viewers are waiting for you.",
  });
  commercialEvent(env, "live_grace", s.creatorId, { kind: "live_event", outcome: "armed" });
}

/** Host rejoin while the grace window is open: back to a normal live session,
 * close the outage interval, disarm the DO alarm. Idempotent — a rejoin
 * event with no open window is a no-op. */
export async function clearLiveGrace(env: Env, s: LiveGraceSession, rejoinAtMs: number): Promise<void> {
  const cleared = await metaDb(env).prepare(
    `UPDATE commercial_sessions SET reconnect_deadline_ms=NULL,updated_at=?2
       WHERE commercial_session_id=?1 AND reconnect_deadline_ms IS NOT NULL`,
  ).bind(s.commercialSessionId, Date.now()).run();
  if ((cleared.meta?.changes ?? 0) === 0) return;
  await metaDb(env).prepare(
    `UPDATE commercial_live_outages SET ended_at=?2,updated_at=?3
       WHERE commercial_session_id=?1 AND ended_at IS NULL`,
  ).bind(s.commercialSessionId, rejoinAtMs, Date.now()).run();
  await sessionOp(env, `live:${s.listingId}`, { op: "live_grace_clear" });
  commercialEvent(env, "live_grace", s.creatorId, { kind: "live_event", outcome: "rejoined" });
}

/** DO `live_grace` alarm fired with no host rejoin: end the event with
 * `end_outcome='host_no_return'` (RULEBOOK §4 L5), close open intervals and
 * the outage, queue settlement jobs, consume entitlements, and project the
 * listing back to completed. Idempotent — a stale alarm (host already
 * rejoined, or the session is already terminal) is a no-op. */
export async function endLiveOnHostNoReturn(env: Env, listingId: string): Promise<void> {
  const session = await metaDb(env).prepare(
    `SELECT commercial_session_id,state,ended_at,creator_id,reconnect_deadline_ms
       FROM commercial_sessions WHERE kind='live_event' AND listing_id=?1
       ORDER BY session_version DESC LIMIT 1`,
  ).bind(listingId).first<{
    commercial_session_id: string; state: string; ended_at: number | null;
    creator_id: string; reconnect_deadline_ms: number | null;
  }>();
  if (!session || session.state === "ended" || session.state === "cancelled") return;
  if (session.reconnect_deadline_ms == null) return; // host already rejoined — stale alarm
  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `UPDATE commercial_sessions SET state='ended',ended_at=COALESCE(ended_at,?2),
         end_outcome='host_no_return',reconnect_deadline_ms=NULL,
         settlement_state=CASE WHEN settlement_state='not_ready' THEN 'pending' ELSE settlement_state END,
         state_version=state_version+1,updated_at=?3
       WHERE commercial_session_id=?1 AND state NOT IN ('ended','cancelled')`,
    ).bind(session.commercial_session_id, now, now),
    metaDb(env).prepare(
      `UPDATE commercial_participant_intervals
         SET left_at=?2,connected_ms=MAX(0,?2-joined_at),reconciliation_state='closed',updated_at=?3
       WHERE commercial_session_id=?1 AND reconciliation_state='open'`,
    ).bind(session.commercial_session_id, now, now),
    metaDb(env).prepare(
      `UPDATE commercial_live_outages SET ended_at=COALESCE(ended_at,?2),updated_at=?3
         WHERE commercial_session_id=?1 AND ended_at IS NULL`,
    ).bind(session.commercial_session_id, now, now),
    metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_settlement_jobs
       (settlement_job_id,commercial_session_id,order_id,state,terminal_event_id,attempts,created_at,updated_at)
       SELECT 'settlement:' || ?1 || ':' || p.order_id,?1,p.order_id,'pending','live_grace:' || ?1,0,?2,?2
       FROM commercial_policy_snapshots p WHERE p.listing_id=?3 AND p.booking_id IS NULL`,
    ).bind(session.commercial_session_id, now, listingId),
  ]);
  await metaDb(env).prepare(
    `UPDATE commercial_entitlements SET state='consumed',updated_at=?2
       WHERE kind='live_event' AND listing_id=?1 AND state IN ('reserved','held','active')`,
  ).bind(listingId, now).run();
  try {
    const projected = await systemMarkListingCompleted(env, listingId);
    await notifyLiveAudience(env, {
      type: "commercial_broadcast_ended",
      eventId: `${session.commercial_session_id}:host_no_return`,
      listingId,
      sessionId: session.commercial_session_id,
      title: "Live event ended",
      body: "The creator did not return in time — you'll be refunded for the time you missed.",
    }, session.creator_id);
    commercialEvent(env, "listing_projection", null, {
      kind: "live_event", outcome: projected.ok ? "completed" : "not_applied", reason: projected.reason ?? "",
    });
  } catch (err) {
    commercialEvent(env, "listing_projection", null, {
      kind: "live_event", outcome: "error", reason: String((err as Error)?.message ?? err).slice(0, 160),
    });
  }
  void refreshCreatorStats(env, session.creator_id).catch((e) => console.warn("creator_stats refresh skipped:", String(e)));
  commercialEvent(env, "live_grace", session.creator_id, { kind: "live_event", outcome: "host_no_return" });
}
