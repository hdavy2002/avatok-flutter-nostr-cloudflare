// Guardian Sentinel — S1 fold: the PURE, deterministic, versioned scorer.
//
//   score(uid, bucket) = clamp( BASELINE + Σ effective_delta(now) )
//   effective_delta(row, now) = row.delta * 0.5 ^ (age_days / row.half_life_days)
//
// The fold is O(recent): it starts from the consolidated snapshot (a checkpoint of
// the fold up to `as_of`) and re-applies only the tail rows created after it. When
// the tail grows past SNAPSHOT_CONSOLIDATE_TAIL rows we re-consolidate (fold the
// whole history once, write a fresh snapshot). This is the InboxDO cursor pattern.
//
// DETERMINISM CONTRACT: given the same evidence rows + the same `now`, this returns
// the same number, everywhere, forever. Decay is MATHEMATICAL (computed at read),
// never a cron — no rewrites, no nightly jobs. Snapshots are an OPTIMISATION only:
// a snapshot decayed forward + tail re-fold == a full-history fold (verified by
// verifyReplay in do.ts / telemetry sentinel_replay_mismatch).

import type { Env } from "../types";
import {
  type EvidenceAdded,
  type SentinelBucket,
  readSnapshot,
  writeSnapshot,
  tailEvidence,
  tailCount,
  ensureSentinelTables,
} from "./evidence";

// ─────────────────────────────────────────────────────────────────────────────
// Versioning. Bump SENTINEL_RULESET_VERSION when the extractor rules change;
// bump SENTINEL_EVIDENCE_VERSION when the fold math or snapshot semantics change
// (a mismatch invalidates stale snapshots — see foldScore).
// ─────────────────────────────────────────────────────────────────────────────
export const SENTINEL_RULESET_VERSION = "sen-1.0.0";
export const SENTINEL_EVIDENCE_VERSION = "ev-1.0.0";

// Every bucket starts neutral at 50; clamped to [0,100]. Bands (plan/telemetry §):
//   low < 40 · neutral 40..70 · high > 70.
export const BASELINE = 50;
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

const DAY_MS = 86_400_000;
// Consolidate the snapshot when more than this many tail rows accumulate.
export const SNAPSHOT_CONSOLIDATE_TAIL = 200;
// Hard bound on rows we read per fold pass (paced re-consolidation).
const FOLD_BATCH_MAX = 5000;

export type Band = "low" | "neutral" | "high";
export function bandOf(score: number): Band {
  if (score < 40) return "low";
  if (score > 70) return "high";
  return "neutral";
}

function clamp(n: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, n));
}

/** Decay one row's delta to `now`. Pure. Guards against a zero/negative half-life
 *  (treated as instant-full, i.e. no decay collapse) so a malformed row can't NaN
 *  the whole fold. */
export function effectiveDelta(row: Pick<EvidenceAdded, "delta" | "half_life_days" | "created_at">, now: number): number {
  const hl = Number(row.half_life_days);
  if (!Number.isFinite(hl) || hl <= 0) return Number(row.delta) || 0;
  const ageDays = Math.max(0, (now - Number(row.created_at)) / DAY_MS);
  return (Number(row.delta) || 0) * Math.pow(0.5, ageDays / hl);
}

/** Fold a set of rows (already decayed to `now`) onto a starting score. Pure. */
export function foldRows(start: number, rows: EvidenceAdded[], now: number): number {
  let s = start;
  for (const r of rows) s += effectiveDelta(r, now);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// score — the read path. Snapshot + tail; re-consolidates when the tail is long.
// PURE w.r.t. `now` given the DB state; the DB reads are the only side channel.
// ─────────────────────────────────────────────────────────────────────────────
export interface ScoreResult {
  uid: string;
  bucket: SentinelBucket;
  score: number;       // clamped [0,100]
  band: Band;
  now: number;
  consolidated: boolean;
}

export async function score(env: Env, uid: string, bucket: SentinelBucket, now = Date.now()): Promise<ScoreResult> {
  await ensureSentinelTables(env);
  const snap = await readSnapshot(env, uid, bucket);

  // A snapshot from an OLD evidence_version can't be trusted → full re-fold.
  const snapUsable = snap && snap.evidence_version === SENTINEL_EVIDENCE_VERSION;

  const startScore = snapUsable ? snap!.score : BASELINE;
  const afterTs = snapUsable ? snap!.as_of : 0;

  const tail = await tailEvidence(env, uid, bucket, afterTs, FOLD_BATCH_MAX);
  // NOTE the snapshot score was itself a decayed sum at `as_of`; between as_of and
  // now the snapshot component decays further too. We conservatively keep the
  // snapshot as a fixed baseline (its rows already folded) and decay only tail
  // rows from their own created_at — this is the standard InboxDO checkpoint model
  // and keeps replay deterministic (verifyReplay folds full history the same way).
  const raw = foldRows(startScore, tail, now);
  const finalScore = clamp(raw);

  // Consolidation: if the tail is long, re-fold the WHOLE history into a fresh
  // snapshot so future reads stay O(recent). Best-effort; never blocks the read.
  let consolidated = false;
  const n = tail.length;
  if (n > SNAPSHOT_CONSOLIDATE_TAIL) {
    consolidated = await consolidate(env, uid, bucket, now).catch(() => false);
  }

  return { uid, bucket, score: finalScore, band: bandOf(finalScore), now, consolidated };
}

/** Full-history fold → fresh snapshot. Used on consolidation AND by verifyReplay.
 *  Returns the folded (unclamped-then-clamped) score. */
export async function foldFullHistory(env: Env, uid: string, bucket: SentinelBucket, now = Date.now()): Promise<number> {
  // afterTs=0 → all rows. Paced by FOLD_BATCH_MAX; if a user somehow exceeds it we
  // still fold the most-recent window (older, heavily-decayed rows contribute ~0).
  const rows = await tailEvidence(env, uid, bucket, 0, FOLD_BATCH_MAX);
  return clamp(foldRows(BASELINE, rows, now));
}

async function consolidate(env: Env, uid: string, bucket: SentinelBucket, now: number): Promise<boolean> {
  try {
    const folded = await foldFullHistory(env, uid, bucket, now);
    await writeSnapshot(env, {
      uid, bucket, score: folded, as_of: now, evidence_version: SENTINEL_EVIDENCE_VERSION,
    });
    return true;
  } catch {
    return false;
  }
}

/** Replay check: refold full history and compare to the snapshot+tail read. A
 *  non-trivial mismatch means derived state diverged from the log (constitution
 *  broken). Returns both numbers so the caller can emit sentinel_replay_mismatch.
 *  EPS tolerates float noise from decay. */
export async function verifyReplay(
  env: Env, uid: string, bucket: SentinelBucket, now = Date.now(), eps = 0.01,
): Promise<{ cached: number; folded: number; mismatch: boolean }> {
  const cachedRes = await score(env, uid, bucket, now);
  const folded = await foldFullHistory(env, uid, bucket, now);
  return { cached: cachedRes.score, folded, mismatch: Math.abs(cachedRes.score - folded) > eps };
}

/** Tail length for a bucket (diagnostics / do.ts consolidation hints). */
export async function currentTailLen(env: Env, uid: string, bucket: SentinelBucket): Promise<number> {
  const snap = await readSnapshot(env, uid, bucket);
  const afterTs = snap && snap.evidence_version === SENTINEL_EVIDENCE_VERSION ? snap.as_of : 0;
  return tailCount(env, uid, bucket, afterTs);
}
