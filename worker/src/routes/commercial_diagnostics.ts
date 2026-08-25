// Read-only commercial operations diagnostics. Admin auth is mandatory and the
// response contains counts, states and ages only — never provider payloads,
// tokens, call credentials, or buyer/creator private data.

import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { commercialEvent } from "../lib/commercial_telemetry";

const CHECKOUT_STALE_MS = 15 * 60_000;
const RECON_STALE_MS = 10 * 60_000;
const SETTLEMENT_STALE_MS = 15 * 60_000;
const EVENT_STALE_MS = 10 * 60_000;

type Alarm = {
  key: string;
  count: number;
  threshold: number;
  oldest_at: number | null;
  oldest_age_ms: number;
  state: "ok" | "warning";
};

type StateRow = { state: string; count: number; oldest_at: number | null };

async function states(sql: string, env: Env): Promise<StateRow[]> {
  try {
    const rows = await metaDb(env).prepare(sql).all<StateRow>();
    return (rows.results ?? []).map((row) => ({
      state: String(row.state), count: Number(row.count ?? 0),
      oldest_at: row.oldest_at == null ? null : Number(row.oldest_at),
    }));
  } catch {
    return [];
  }
}

export type CommercialHealthSummary = {
  available: boolean;
  checked_at: number;
  alarms: Alarm[];
  states: {
    checkout_operations: StateRow[];
    sessions: StateRow[];
    settlement_jobs: StateRow[];
    provider_events: StateRow[];
  };
};

/** Bounded maintenance scan. It emits only alarm dimensions, never row data. */
export async function scanCommercialHealth(env: Env, now = Date.now()): Promise<CommercialHealthSummary> {
  const available = await (async () => {
    try {
      await metaDb(env).prepare(
        "SELECT operation_id FROM commercial_checkout_operations LIMIT 1",
      ).first<{ operation_id: string }>();
      return true;
    } catch {
      return false;
    }
  })();
  if (!available) {
    return {
      available: false, checked_at: now, alarms: [],
      states: { checkout_operations: [], sessions: [], settlement_jobs: [], provider_events: [] },
    };
  }
  const queries: AlarmQuery[] = [
    { key: "checkout_started_stale", sql: `SELECT COUNT(*) count, MIN(updated_at) oldest_at
      FROM commercial_checkout_operations WHERE state='started' AND updated_at<=?1`, threshold: CHECKOUT_STALE_MS, cutoff: now - CHECKOUT_STALE_MS },
    { key: "session_reconciliation_pending", sql: `SELECT COUNT(*) count, MIN(updated_at) oldest_at
      FROM commercial_sessions WHERE state='reconciliation_pending' AND updated_at<=?1`, threshold: RECON_STALE_MS, cutoff: now - RECON_STALE_MS },
    { key: "settlement_review_pending", sql: `SELECT COUNT(*) count, MIN(updated_at) oldest_at
      FROM commercial_settlement_jobs WHERE state='review_pending' AND updated_at<=?1`, threshold: SETTLEMENT_STALE_MS, cutoff: now - SETTLEMENT_STALE_MS },
    { key: "settlement_processing_stale", sql: `SELECT COUNT(*) count, MIN(updated_at) oldest_at
      FROM commercial_settlement_jobs WHERE state='processing' AND updated_at<=?1`, threshold: SETTLEMENT_STALE_MS, cutoff: now - SETTLEMENT_STALE_MS },
    { key: "provider_event_unbound", sql: `SELECT COUNT(*) count, MIN(received_at) oldest_at
      FROM commercial_provider_events WHERE commercial_session_id IS NULL
        AND processing_state='review_pending' AND received_at<=?1`, threshold: EVENT_STALE_MS, cutoff: now - EVENT_STALE_MS },
  ];
  const alarms = await Promise.all(queries.map((query) => alarmWithBind(env, query, now)));
  const summary: CommercialHealthSummary = {
    available: true,
    checked_at: now,
    alarms,
    states: {
      checkout_operations: await states("SELECT state,COUNT(*) count,MIN(updated_at) oldest_at FROM commercial_checkout_operations GROUP BY state", env),
      sessions: await states("SELECT state,COUNT(*) count,MIN(updated_at) oldest_at FROM commercial_sessions GROUP BY state", env),
      settlement_jobs: await states("SELECT state,COUNT(*) count,MIN(updated_at) oldest_at FROM commercial_settlement_jobs GROUP BY state", env),
      provider_events: await states("SELECT processing_state state,COUNT(*) count,MIN(received_at) oldest_at FROM commercial_provider_events GROUP BY processing_state", env),
    },
  };
  for (const item of alarms) {
    if (item.state === "warning") {
      commercialEvent(env, "alarm", null, {
        alarm_key: item.key, count: item.count, threshold_ms: item.threshold,
        oldest_age_ms: item.oldest_age_ms, outcome: "warning",
      });
    }
  }
  return summary;
}

// Query descriptor keeps the SQL and age threshold together without returning
// the SQL or any row details to callers.
type AlarmQuery = { key: string; sql: string; threshold: number; cutoff: number };

async function alarmWithBind(env: Env, query: AlarmQuery, now: number): Promise<Alarm> {
  try {
    const row = await metaDb(env).prepare(query.sql).bind(query.cutoff).first<{ count: number; oldest_at: number | null }>();
    const count = Math.max(0, Number(row?.count ?? 0));
    const oldestAt = row?.oldest_at == null ? null : Number(row.oldest_at);
    const age = oldestAt == null ? 0 : Math.max(0, now - oldestAt);
    return {
      key: query.key, count, threshold: query.threshold,
      oldest_at: oldestAt, oldest_age_ms: age,
      state: count > 0 && age >= query.threshold ? "warning" : "ok",
    };
  } catch {
    return { key: query.key, count: 0, threshold: query.threshold, oldest_at: null, oldest_age_ms: 0, state: "ok" };
  }
}

export async function commercialDiagnostics(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;
  const summary = await scanCommercialHealth(env);
  commercialEvent(env, "diagnostics_read", admin.uid, {
    outcome: summary.available ? "available" : "schema_unavailable",
    warning_count: summary.alarms.filter((item) => item.state === "warning").length,
  });
  return json(summary);
}
