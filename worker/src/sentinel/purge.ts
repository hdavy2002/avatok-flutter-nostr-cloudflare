// Guardian Sentinel — S2 mem0 purge queue. See
// Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md §S2 and §1.1 rule 5:
//
//   "Deletion: canonical deletion succeeds first; mem0 purge retries asynchronously
//    until confirmed — an external SaaS can never block account deletion."
//
// CRITICAL CONTRACT: canonical account deletion (routes/account.ts) NEVER waits on
// mem0. On deletion we enqueue a row here (best-effort) and move on. A drain function
// (processPurgeQueue) confirms the purge later with retry + exponential backoff. The
// queue is a self-creating D1 table; the drain is called opportunistically from
// maybeSummarise (summariser.ts) and can be wired to a cron/consumer later.
//
// mem0 is a derived cache — even if a purge were somehow lost, no owner-of-truth data
// survives (the account's evidence log is wiped by the canonical 15-store cascade).
// This queue exists to honour the "your behaviour memory is erased" promise, not to
// protect a system of record.

import type { Env } from "../types";
import { track } from "../hooks";
import { deleteMemories, mem0Configured } from "./mem0";

const MAX_ATTEMPTS = 8;                 // give up (leave for manual/cron) after this
const BASE_BACKOFF_MS = 5 * 60_000;     // 5 min, doubling per attempt (capped)
const MAX_BACKOFF_MS = 24 * 60 * 60_000; // 24h cap
const DRAIN_BATCH = 20;                 // rows processed per opportunistic drain

let _ensured = false;
async function ensurePurgeTable(env: Env): Promise<void> {
  if (_ensured) return;
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS sentinel_mem0_purge_queue (
       uid             TEXT PRIMARY KEY,
       attempts        INTEGER NOT NULL DEFAULT 0,
       next_attempt_at INTEGER NOT NULL DEFAULT 0,
       enqueued_at     INTEGER NOT NULL DEFAULT 0
     )`,
  ).run().catch(() => {});
  await env.DB_META.prepare(
    `CREATE INDEX IF NOT EXISTS idx_sentinel_mem0_purge_next
       ON sentinel_mem0_purge_queue (next_attempt_at)`,
  ).run().catch(() => {});
  _ensured = true;
}

function backoff(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts)));
}

/**
 * Enqueue a mem0 purge for `uid`. BEST-EFFORT and non-blocking — the caller (account
 * deletion) must `void` this and never await it in a way that blocks the response.
 * Idempotent per uid (re-enqueue resets the schedule to "due now").
 */
export async function enqueueMem0Purge(env: Env, uid: string): Promise<void> {
  if (!uid) return;
  const now = Date.now();
  try {
    await ensurePurgeTable(env);
    await env.DB_META.prepare(
      `INSERT INTO sentinel_mem0_purge_queue (uid, attempts, next_attempt_at, enqueued_at)
       VALUES (?1, 0, ?2, ?2)
       ON CONFLICT(uid) DO UPDATE SET attempts=0, next_attempt_at=?2`,
    ).bind(uid, now).run();
  } catch {
    // If even the enqueue fails, canonical deletion still succeeds — we simply lose
    // the retry record. Acceptable: mem0 holds no owner-of-truth data.
  }
}

/**
 * Drain due purge rows: for each, call mem0 DELETE. On confirmed delete, remove the
 * row. On failure, bump attempts + reschedule with backoff (or drop after MAX_ATTEMPTS).
 * Bounded to DRAIN_BATCH rows per call. Fail-open; never throws. Exported so a future
 * cron/consumer can call it too. Emits mem0_purge_retry {backlog}.
 */
export async function processPurgeQueue(env: Env, now = Date.now()): Promise<{ processed: number; backlog: number }> {
  // No key → nothing to do; leave rows queued for when the secret arrives.
  if (!mem0Configured(env)) return { processed: 0, backlog: 0 };
  try {
    await ensurePurgeTable(env);
    const due = await env.DB_META.prepare(
      `SELECT uid, attempts FROM sentinel_mem0_purge_queue
        WHERE next_attempt_at <= ?1 ORDER BY next_attempt_at ASC LIMIT ?2`,
    ).bind(now, DRAIN_BATCH).all<{ uid: string; attempts: number }>();
    const rows = due.results ?? [];

    let processed = 0;
    for (const row of rows) {
      const uid = String(row.uid);
      const attempts = Number(row.attempts) || 0;
      const confirmed = await deleteMemories(env, uid).catch(() => false);
      if (confirmed) {
        await env.DB_META.prepare("DELETE FROM sentinel_mem0_purge_queue WHERE uid=?1")
          .bind(uid).run().catch(() => {});
        processed++;
      } else {
        const nextAttempts = attempts + 1;
        if (nextAttempts >= MAX_ATTEMPTS) {
          // Exhausted retries. Drop the row (leave a telemetry breadcrumb) so a stuck
          // external outage can't grow the queue unbounded; a later manual/cron sweep
          // can re-enqueue if needed. The evidence log is already gone regardless.
          await env.DB_META.prepare("DELETE FROM sentinel_mem0_purge_queue WHERE uid=?1")
            .bind(uid).run().catch(() => {});
          void track(env, uid, "mem0_purge_exhausted", "sentinel", { attempts: nextAttempts });
        } else {
          await env.DB_META.prepare(
            "UPDATE sentinel_mem0_purge_queue SET attempts=?2, next_attempt_at=?3 WHERE uid=?1",
          ).bind(uid, nextAttempts, now + backoff(nextAttempts)).run().catch(() => {});
        }
      }
    }

    const backlogRow = await env.DB_META
      .prepare("SELECT COUNT(*) AS n FROM sentinel_mem0_purge_queue")
      .first<{ n: number }>();
    const backlog = Number(backlogRow?.n ?? 0);
    if (processed > 0 || backlog > 0) {
      void track(env, "system", "mem0_purge_retry", "sentinel", { processed, backlog });
    }
    return { processed, backlog };
  } catch {
    return { processed: 0, backlog: 0 };
  }
}
