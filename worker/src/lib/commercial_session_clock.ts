// [SESSION-CLOCK-0] "The schedule ends a session, never a provider event"
// (RULEBOOK-PAID-SESSIONS.md §5, §3). This is the schedule for 1:1 consults:
// a 5-minute cron sweep that ends sessions whose slot (plus the late-join
// grace) has genuinely passed, independent of whatever GetStream did or
// didn't tell us. `recordCommercialStreamEvent` (commercial_stream_sessions.ts)
// intentionally no longer ends consult_1to1 sessions on a provider
// session_ended/call.ended event -- this file is the only thing that does,
// besides the explicit `POST /api/commercial/consult/:id/end` route.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { commercialEvent } from "./commercial_telemetry";
import { consumeCommercialEntitlementsOnSessionEnd } from "../routes/commercial_stream_sessions";
import { commercialProviderIdentity } from "./commercial_stream_sessions";
import { resolveConsultCheckInCfg } from "../commercial_settlement";

type DueConsultSession = {
  commercial_session_id: string;
  listing_id: string;
  booking_id: string | null;
  creator_id: string;
  state: string;
  ends_at: number;
};

/**
 * Ends every `kind='consult_1to1'` commercial session whose booking's
 * `ends_at + commercialConsultJoinLateMin` has passed and which is not
 * already ended/cancelled. For each due session: marks it 'ended', closes
 * any still-open participant intervals (same shape the provider-event
 * terminal branch used to write), inserts a settlement job (same SQL as
 * that terminal branch), and runs `consumeCommercialEntitlementsOnSessionEnd`.
 *
 * Deliberately scoped to sessions that already have a `commercial_sessions`
 * row (i.e. somebody joined at least once and a provider call was created).
 * A booking nobody ever opened has no session row at all: if the creator
 * never checked in either, it is handled by the orphan no-show sweep
 * (`runCommercialOrphanNoShowSweep`, [LISTING-EXPIRY-1]); if the creator DID
 * check in but the buyer's room view never opened, `backfillCheckedInConsultSessions`
 * below (fix 1, [SETTLE-CHECKIN-2]) handles it instead -- not this function.
 */
export async function endDueConsultSessions(
  env: Env,
  limit = 25,
): Promise<{ scanned: number; ended: number }> {
  const config = await readConfig(env);
  const lateGraceMs = Math.max(0, Math.trunc(Number(config.commercialConsultJoinLateMin))) * 60_000;
  const now = Date.now();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await metaDb(env).prepare(
    `SELECT s.commercial_session_id, s.listing_id, s.booking_id, s.creator_id, s.state,
            b.ends_at
       FROM commercial_sessions s
       JOIN bookings b ON b.id = s.booking_id
      WHERE s.kind='consult_1to1'
        AND s.state NOT IN ('ended','cancelled')
        AND b.ends_at + ?1 <= ?2
      ORDER BY b.ends_at ASC
      LIMIT ?3`,
  ).bind(lateGraceMs, now, safeLimit).all<DueConsultSession>();

  let ended = 0;
  for (const row of rows.results ?? []) {
    const eventId = `cron:${row.commercial_session_id}:${now}`;
    const nowForRow = Date.now();
    await metaDb(env).batch([
      metaDb(env).prepare(
        `UPDATE commercial_sessions SET state='ended',ended_at=COALESCE(ended_at,?2),
          settlement_state=CASE WHEN settlement_state='not_ready' THEN 'pending' ELSE settlement_state END,
          state_version=state_version+1,updated_at=?3
         WHERE commercial_session_id=?1 AND state NOT IN ('ended','cancelled')`,
      ).bind(row.commercial_session_id, nowForRow, nowForRow),
      metaDb(env).prepare(
        `UPDATE commercial_participant_intervals
         SET left_at=?2,connected_ms=MAX(0,?2-joined_at),reconciliation_state='closed',updated_at=?3
         WHERE commercial_session_id=?1 AND reconciliation_state='open'`,
      ).bind(row.commercial_session_id, nowForRow, nowForRow),
      metaDb(env).prepare(
        `INSERT OR IGNORE INTO commercial_settlement_jobs
         (settlement_job_id,commercial_session_id,order_id,state,terminal_event_id,
          attempts,created_at,updated_at)
         SELECT 'settlement:' || ?1 || ':' || p.order_id,?1,p.order_id,'pending',?2,0,?3,?3
         FROM commercial_policy_snapshots p
         WHERE p.listing_id=(SELECT listing_id FROM commercial_sessions WHERE commercial_session_id=?1)
           AND COALESCE(p.booking_id,'')=COALESCE(
             (SELECT booking_id FROM commercial_sessions WHERE commercial_session_id=?1),''
           )`,
      ).bind(row.commercial_session_id, eventId, nowForRow),
    ]);
    await consumeCommercialEntitlementsOnSessionEnd(env, row.commercial_session_id);
    commercialEvent(env, "session_clock", null, {
      kind: "consult_1to1", outcome: "ended", reason: "schedule_due",
    });
    ended++;
  }
  return { scanned: (rows.results ?? []).length, ended };
}


type OrphanCheckedInBooking = {
  booking_id: string;
  listing_id: string;
  creator_id: string;
  order_id: string | null;
  starts_at: number;
  ends_at: number;
};

/**
 * [SETTLE-CHECKIN-2] fix 1: C1 ("creator present, buyer never came") when the buyer
 * never even opened the waiting room -- so no `commercial_sessions` row was ever
 * created (rows are created on `/join`, see commercial_stream_sessions.ts) -- but the
 * creator's own check-in evidence (`session_attendance` role='host', or a creator
 * `commercial_participant_intervals` row, inside the fix-3 window) proves he was there.
 *
 * Without this pass those bookings would never settle: `runCommercialOrphanNoShowSweep`
 * now SKIPS any booking with host check-in evidence in that window (it is not a
 * no-show), and nothing else looks at a booking with no session row. This synthesizes
 * the missing `commercial_sessions` row -- already 'ended', using the same provider
 * identity contract (`commercialProviderIdentity`) the real `/join` path uses, so the
 * row is indistinguishable from one a real join would have produced -- and its
 * settlement job, so the normal check-in-decision settlement path
 * (`consultCheckInDecision` in commercial_settlement.ts) pays the creator in full.
 */
export async function backfillCheckedInConsultSessions(
  env: Env,
  limit = 25,
): Promise<{ scanned: number; created: number }> {
  const config = await readConfig(env);
  const lateGraceMs = Math.max(0, Math.trunc(Number(config.commercialConsultJoinLateMin))) * 60_000;
  // [SETTLE-CHECKIN-3] R10: one shared helper for the check-in window's minutes ->
  // ms conversion and defaulting -- the settlement decision (commercial_settlement.ts),
  // the orphan sweep (commercial_lifecycle.ts) and this backfill all call the SAME
  // function instead of each keeping their own copy of the maths.
  const { earlyMs, checkInMs } = resolveConsultCheckInCfg(config as unknown as Record<string, unknown>);
  const now = Date.now();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await metaDb(env).prepare(
    `SELECT b.id booking_id, b.listing_id, b.creator_id, b.order_id, b.starts_at, b.ends_at
       FROM bookings b
       JOIN orders o ON o.id = b.order_id
      WHERE b.kind='consult_1to1'
        AND o.kind='consult_1to1'
        AND b.status='confirmed'
        AND o.status IN ('held','free')
        AND b.ends_at + ?1 <= ?2
        -- [SETTLE-CHECKIN-3] R8: only a genuinely COMMERCIAL order -- one that actually
        -- went through commercial checkout and has a policy snapshot -- is eligible. A
        -- legacy Phase-7 AvaConsult booking shares this same bookings/orders shape
        -- (kind='consult_1to1' too) but settles through money_engine.ts, not
        -- commercial_settlement.ts; without this it would get a phantom
        -- commercial_sessions/settlement_job row that can never find its settlement
        -- authority (no policy snapshot exists) and sits in review forever.
        AND EXISTS (SELECT 1 FROM commercial_policy_snapshots p WHERE p.order_id=o.id)
        AND NOT EXISTS (SELECT 1 FROM commercial_sessions sx
                         WHERE sx.kind='consult_1to1' AND sx.booking_id=b.id)
        AND EXISTS (
          SELECT 1 FROM session_attendance a
           WHERE a.session_id=b.id AND a.role='host' AND a.user_id=b.creator_id
             AND a.joined_at<=b.starts_at+?3 AND COALESCE(a.left_at,?2)>=b.starts_at-?4
        )
      ORDER BY b.ends_at ASC
      LIMIT ?5`,
  ).bind(lateGraceMs, now, checkInMs, earlyMs, safeLimit).all<OrphanCheckedInBooking>();

  let created = 0;
  for (const row of rows.results ?? []) {
    const identity = commercialProviderIdentity({
      kind: "consult_1to1",
      listingId: row.listing_id,
      bookingId: row.booking_id,
      sessionVersion: 1,
    });
    const sessionId = `consult_${row.booking_id}`;
    const nowForRow = Date.now();
    // [SETTLE-CHECKIN-3] R8: session insert + job insert in ONE batch -- they are the
    // same "this booking is now backfilled" fact, not two independently-retriable steps.
    const [sessionResult] = await metaDb(env).batch([
      metaDb(env).prepare(
        `INSERT OR IGNORE INTO commercial_sessions
         (commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,provider,
          provider_call_type,provider_call_id,session_version,scheduled_at,ended_at,state,state_version,
          settlement_state,recording_state,replay_state,created_at,updated_at)
         VALUES (?1,'consult_1to1',?2,?3,?4,?5,?6,?7,?8,1,?9,?10,'ended',1,
          'pending','disabled','disabled',?10,?10)`,
      ).bind(
        sessionId, row.listing_id, row.booking_id, row.order_id, row.creator_id,
        identity.provider, identity.callType, identity.callId, row.starts_at, nowForRow,
      ),
      metaDb(env).prepare(
        `INSERT OR IGNORE INTO commercial_settlement_jobs
         (settlement_job_id,commercial_session_id,order_id,state,terminal_event_id,
          attempts,created_at,updated_at)
         SELECT 'settlement:' || ?1 || ':' || p.order_id,?1,p.order_id,'pending',?2,0,?3,?3
         FROM commercial_policy_snapshots p
         WHERE p.listing_id=?4 AND COALESCE(p.booking_id,'')=?5`,
      ).bind(sessionId, `backfill:${sessionId}:${nowForRow}`, nowForRow, row.listing_id, row.booking_id),
    ]);
    if ((sessionResult?.meta?.changes ?? 0) !== 1) continue;
    await consumeCommercialEntitlementsOnSessionEnd(env, sessionId);
    commercialEvent(env, "session_clock", null, {
      kind: "consult_1to1", outcome: "backfilled", reason: "creator_checked_in_buyer_absent",
    });
    created++;
  }
  return { scanned: (rows.results ?? []).length, created };
}
