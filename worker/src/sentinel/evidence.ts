// Guardian Sentinel — S1 core: the EvidenceAdded op model + self-creating D1
// tables (DB_META). See Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md §S1.
//
// CONSTITUTIONAL ANCHOR (repeat it here so nobody forgets while editing):
//   Guardian Sentinel is a DERIVED safety projection. Its entire state — evidence
//   buckets, snapshots, SentinelDO caches — must be reproducible SOLELY from the
//   immutable event stream and versioned deterministic rules. No Sentinel component
//   is a system of record. The single owner of truth is the append-only evidence
//   log (this file). Snapshots/DO caches/aggregates are all rebuildable.
//
// Everything here is DARK behind `sentinelEnabled` (config.ts, default false).
// Flipping it ON requires a KV patch of platform_config (code defaults never win
// over KV — 2026-07-04 lesson). Callers gate BEFORE touching this module.
//
// Tables (self-creating, no migration — mirrors ava_guardian.ts ensureTables):
//   sentinel_evidence               : APPEND-ONLY op log (the owner of truth).
//   sentinel_snapshots              : per-(uid,bucket) consolidated fold checkpoint.
//   sentinel_conversation_aggregate : per-conv moderation projection (background).

import type { Env } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Buckets (v1 set — frozen plan §1.3). Internal only; products consume the L0–L3
// ladder + badges, never these raw buckets.
// ─────────────────────────────────────────────────────────────────────────────
export const SENTINEL_BUCKETS = [
  "identity_confidence",
  "behaviour_confidence",
  "community_reputation",
  "conversation_risk",
  "marketplace_trust",
  "media_risk",
] as const;
export type SentinelBucket = (typeof SENTINEL_BUCKETS)[number];

export function isSentinelBucket(b: string): b is SentinelBucket {
  return (SENTINEL_BUCKETS as readonly string[]).includes(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceAdded — the ONE immutable op. Append-only; never overwritten. The
// current bucket score is fold(evidence) over snapshot + tail (see fold.ts).
//
// Provenance checklist (plan §1.1 rule 6 — every item must answer all 7):
//   which immutable event  → source_event
//   which deterministic rule → rule_id
//   which ruleset version  → ruleset_version
//   which policy version   → (S1 has no policy engine yet; T1 adds policy_version)
//   which timestamp        → created_at
//   replayable?            → YES (deterministic fold; decay computed at read)
//   appealable? / expires? → decay via half_life_days makes every item time-bound;
//                            appeal UX arrives with T1/U1.
// ─────────────────────────────────────────────────────────────────────────────
export interface EvidenceAdded {
  id: string;               // uuid — idempotency + audit handle
  uid: string;              // the subject the evidence is ABOUT
  bucket: SentinelBucket;
  delta: number;            // signed contribution BEFORE decay (points)
  reason: string;           // short human-readable note (category-level, no PII)
  source_event: string;     // the immutable event id/type this derives from
  rule_id: string;          // deterministic rule that emitted it (e.g. "SEN-001")
  ruleset_version: string;  // SENTINEL_RULESET_VERSION at emit time
  half_life_days: number;   // decay half-life; effective_delta computed at read
  created_at: number;       // ms epoch
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-creating tables. Idempotent DDL — cached per isolate like ava_guardian.
// ─────────────────────────────────────────────────────────────────────────────
let _ensured = false;
export async function ensureSentinelTables(env: Env): Promise<void> {
  if (_ensured) return;
  await env.DB_META.batch([
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS sentinel_evidence (
         id              TEXT PRIMARY KEY,
         uid             TEXT NOT NULL,
         bucket          TEXT NOT NULL,
         delta           REAL NOT NULL,
         reason          TEXT,
         source_event    TEXT,
         rule_id         TEXT NOT NULL,
         ruleset_version TEXT NOT NULL,
         half_life_days  REAL NOT NULL,
         created_at      INTEGER NOT NULL
       )`,
    ),
    env.DB_META.prepare(
      `CREATE INDEX IF NOT EXISTS idx_sentinel_evidence_uid_bucket
         ON sentinel_evidence (uid, bucket, created_at)`,
    ),
    // Consolidated fold checkpoint. score = baseline+Σ effective_delta at as_of;
    // the fold re-applies only the tail rows created after as_of. evidence_version
    // lets a schema/rule change invalidate stale snapshots deterministically.
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS sentinel_snapshots (
         uid              TEXT NOT NULL,
         bucket           TEXT NOT NULL,
         score            REAL NOT NULL,
         as_of            INTEGER NOT NULL,
         evidence_version TEXT NOT NULL,
         updated_at       INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (uid, bucket)
       )`,
    ),
    // Conversation moderation projection (plan §1.2). Background-updated from
    // events; NOBODY writes it synchronously on the hot path, and cross-user
    // queries never touch SentinelDOs. Derived — rebuildable from evidence/events.
    env.DB_META.prepare(
      `CREATE TABLE IF NOT EXISTS sentinel_conversation_aggregate (
         conv_id             TEXT PRIMARY KEY,
         unique_reporters    INTEGER NOT NULL DEFAULT 0,
         messages_flagged    INTEGER NOT NULL DEFAULT 0,
         participants_flagged INTEGER NOT NULL DEFAULT 0,
         last_updated        INTEGER NOT NULL DEFAULT 0
       )`,
    ),
  ]);
  _ensured = true;
}

/** Append one immutable evidence op. Idempotent on `id` (INSERT OR IGNORE so a
 *  re-delivered event never double-counts). Never throws — a failed audit write
 *  must not break the caller's request (fail-open, matching guardian policy). */
export async function appendEvidence(env: Env, ev: EvidenceAdded): Promise<boolean> {
  try {
    await ensureSentinelTables(env);
    await env.DB_META.prepare(
      `INSERT OR IGNORE INTO sentinel_evidence
         (id, uid, bucket, delta, reason, source_event, rule_id, ruleset_version, half_life_days, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(
      ev.id, ev.uid, ev.bucket, ev.delta, ev.reason ?? null, ev.source_event ?? null,
      ev.rule_id, ev.ruleset_version, ev.half_life_days, ev.created_at,
    ).run();
    return true;
  } catch {
    return false;
  }
}

export interface SnapshotRow {
  uid: string;
  bucket: SentinelBucket;
  score: number;
  as_of: number;
  evidence_version: string;
}

/** Read the fold checkpoint for one (uid, bucket). Null if none consolidated yet. */
export async function readSnapshot(
  env: Env, uid: string, bucket: SentinelBucket,
): Promise<SnapshotRow | null> {
  try {
    await ensureSentinelTables(env);
    const r = await env.DB_META
      .prepare("SELECT uid, bucket, score, as_of, evidence_version FROM sentinel_snapshots WHERE uid=?1 AND bucket=?2")
      .bind(uid, bucket)
      .first<SnapshotRow>();
    return r ?? null;
  } catch {
    return null;
  }
}

/** Write/replace the fold checkpoint. Best-effort (a lost snapshot only costs a
 *  larger tail re-fold next time — correctness is unaffected). */
export async function writeSnapshot(env: Env, s: SnapshotRow): Promise<void> {
  try {
    await ensureSentinelTables(env);
    await env.DB_META.prepare(
      `INSERT INTO sentinel_snapshots (uid, bucket, score, as_of, evidence_version, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(uid, bucket) DO UPDATE SET score=?3, as_of=?4, evidence_version=?5, updated_at=?6`,
    ).bind(s.uid, s.bucket, s.score, s.as_of, s.evidence_version, Date.now()).run();
  } catch { /* best-effort */ }
}

/** Tail rows for a (uid, bucket) created strictly after `afterTs`, oldest-first. */
export async function tailEvidence(
  env: Env, uid: string, bucket: SentinelBucket, afterTs: number, limit = 500,
): Promise<EvidenceAdded[]> {
  try {
    await ensureSentinelTables(env);
    const rs = await env.DB_META.prepare(
      `SELECT id, uid, bucket, delta, reason, source_event, rule_id, ruleset_version, half_life_days, created_at
         FROM sentinel_evidence
        WHERE uid=?1 AND bucket=?2 AND created_at>?3
        ORDER BY created_at ASC LIMIT ?4`,
    ).bind(uid, bucket, afterTs, limit).all<EvidenceAdded>();
    return rs.results ?? [];
  } catch {
    return [];
  }
}

/** Count of tail rows after `afterTs` — used to decide snapshot consolidation. */
export async function tailCount(
  env: Env, uid: string, bucket: SentinelBucket, afterTs: number,
): Promise<number> {
  try {
    await ensureSentinelTables(env);
    const r = await env.DB_META.prepare(
      "SELECT COUNT(*) AS n FROM sentinel_evidence WHERE uid=?1 AND bucket=?2 AND created_at>?3",
    ).bind(uid, bucket, afterTs).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation aggregate projection (background-updated). Best-effort upserts.
// ─────────────────────────────────────────────────────────────────────────────
export async function bumpConversationAggregate(
  env: Env,
  conv: string,
  d: { messagesFlagged?: number; participantsFlagged?: number; uniqueReporters?: number },
): Promise<void> {
  if (!conv) return;
  try {
    await ensureSentinelTables(env);
    await env.DB_META.prepare(
      `INSERT INTO sentinel_conversation_aggregate
         (conv_id, unique_reporters, messages_flagged, participants_flagged, last_updated)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(conv_id) DO UPDATE SET
         unique_reporters     = unique_reporters + ?2,
         messages_flagged     = messages_flagged + ?3,
         participants_flagged = participants_flagged + ?4,
         last_updated         = ?5`,
    ).bind(
      conv,
      Math.max(0, Number(d.uniqueReporters ?? 0)),
      Math.max(0, Number(d.messagesFlagged ?? 0)),
      Math.max(0, Number(d.participantsFlagged ?? 0)),
      Date.now(),
    ).run();
  } catch { /* best-effort */ }
}
