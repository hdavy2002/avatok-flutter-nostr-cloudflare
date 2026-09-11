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
 * A booking nobody ever opened has no session row at all and is handled by
 * the orphan no-show sweep (`runCommercialOrphanNoShowSweep`,
 * [LISTING-EXPIRY-1]) -- not this function.
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
