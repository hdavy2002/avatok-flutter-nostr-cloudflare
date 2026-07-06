// Guardian Sentinel — S2 summariser: builds a DETERMINISTIC, TEMPLATED behavioural
// pattern summary for a uid and writes it to mem0 (the derived cache). See
// Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md §S2.
//
// HARD RULES honoured here:
//   • DERIVED CACHE (rule 5): the summary carries derived_from event ids,
//     summary_version, created_from_ruleset — fully regenerable from the evidence log.
//   • PATTERNS, NOT CONTENT: the text is composed ONLY from rule_ids, counts, bucket
//     bands and dates. It NEVER contains raw message text, media, emails or protected
//     attributes. Reasons are already category-level (extractors emit "guardian_flag:
//     scam", never the message).
//   • NO LLM in this phase: the summary is a deterministic template string. Cheaper,
//     and fully regenerable. (A future phase can layer an LLM paraphrase over this
//     deterministic base — see the note at buildBehaviouralSummary — but the numbers
//     and provenance always come from the deterministic layer, never the LLM.)
//   • ASYNC ONLY: maybeSummarise is fire-and-forget from ingest.ts, never on a
//     message hot path. Internally debounced (≤ 1 summary per uid per 6h).
//   • Everything DARK behind sentinelMem0Enabled AND requires MEM0_API_KEY; both
//     absent → clean no-op.

import type { Env } from "../types";
import { track } from "../hooks";
import { readConfig } from "../routes/config";
import {
  SENTINEL_BUCKETS,
  ensureSentinelTables,
  type EvidenceAdded,
  type SentinelBucket,
} from "./evidence";
import { score, bandOf, SENTINEL_RULESET_VERSION, type Band } from "./fold";
import { writeMemory, mem0Configured, type Mem0Metadata } from "./mem0";
import { processPurgeQueue } from "./purge";

// Bump when the template or the metadata semantics change (invalidates old memories
// for regeneration purposes).
export const SUMMARY_VERSION = 1;

// Debounce: at most one summary per uid per 6h. Stored in a tiny self-creating table.
const DEBOUNCE_MS = 6 * 60 * 60 * 1000;
// How far back the pattern window looks and how many rows it samples.
const WINDOW_MS = 30 * 86_400_000; // 30-day behaviour window
const MAX_ROWS = 500;

/** True when S2 behaviour memory is enabled (KV-merged). Default OFF. */
export async function sentinelMem0Enabled(env: Env): Promise<boolean> {
  try {
    return (await readConfig(env)).sentinelMem0Enabled === true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Debounce store (self-creating). last_summarised_at per uid.
// ─────────────────────────────────────────────────────────────────────────────
let _debounceEnsured = false;
async function ensureDebounceTable(env: Env): Promise<void> {
  if (_debounceEnsured) return;
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS sentinel_mem0_debounce (
       uid                 TEXT PRIMARY KEY,
       last_summarised_at  INTEGER NOT NULL
     )`,
  ).run().catch(() => {});
  _debounceEnsured = true;
}

async function debounceOk(env: Env, uid: string, now: number): Promise<boolean> {
  try {
    await ensureDebounceTable(env);
    const r = await env.DB_META
      .prepare("SELECT last_summarised_at FROM sentinel_mem0_debounce WHERE uid=?1")
      .bind(uid)
      .first<{ last_summarised_at: number }>();
    const last = Number(r?.last_summarised_at ?? 0);
    return now - last >= DEBOUNCE_MS;
  } catch {
    // On a read error, DON'T summarise (avoids hammering mem0 when D1 is unhealthy).
    return false;
  }
}

async function markSummarised(env: Env, uid: string, now: number): Promise<void> {
  try {
    await ensureDebounceTable(env);
    await env.DB_META.prepare(
      `INSERT INTO sentinel_mem0_debounce (uid, last_summarised_at) VALUES (?1,?2)
       ON CONFLICT(uid) DO UPDATE SET last_summarised_at=?2`,
    ).bind(uid, now).run();
  } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence sampling (via evidence.ts table). Recent rows across all buckets for uid.
// ─────────────────────────────────────────────────────────────────────────────
async function recentEvidence(env: Env, uid: string, sinceTs: number): Promise<EvidenceAdded[]> {
  try {
    await ensureSentinelTables(env);
    const rs = await env.DB_META.prepare(
      `SELECT id, uid, bucket, delta, reason, source_event, rule_id, ruleset_version, half_life_days, created_at
         FROM sentinel_evidence
        WHERE uid=?1 AND created_at>=?2
        ORDER BY created_at ASC LIMIT ?3`,
    ).bind(uid, sinceTs, MAX_ROWS).all<EvidenceAdded>();
    return rs.results ?? [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The deterministic template. Produces a category-level English pattern string plus
// the metadata (provenance) for mem0. NO raw content ever enters `text`.
//
// FUTURE (v2): an LLM paraphrase could be layered on top for readability, but it must
// consume ONLY this deterministic string + these counts — never message content — and
// it must never alter numbers or provenance. The deterministic layer stays the source.
// ─────────────────────────────────────────────────────────────────────────────
export interface BehaviouralSummary {
  text: string;
  metadata: Mem0Metadata;
  empty: boolean; // nothing safety-relevant → skip the write
}

function ymd(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Compose a templated behavioural summary from recent evidence + bucket bands.
 *  Reads bucket scores via fold.ts. Pure w.r.t. the DB state given `now`. */
export async function buildBehaviouralSummary(
  env: Env,
  uid: string,
  now = Date.now(),
): Promise<BehaviouralSummary> {
  const sinceTs = now - WINDOW_MS;
  const rows = await recentEvidence(env, uid, sinceTs);

  // Category counts by extractor reason prefix (category-level; e.g. "guardian_flag",
  // "report_received"). We split on ':' so "guardian_flag:scam" → "guardian_flag".
  const catCounts = new Map<string, number>();
  const buckets = new Set<string>();
  const derivedFrom: string[] = [];
  let flags = 0;
  let reports = 0;
  for (const r of rows) {
    const reason = String(r.reason ?? r.rule_id ?? "");
    const cat = reason.split(":")[0] || String(r.rule_id ?? "signal");
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    buckets.add(String(r.bucket));
    if (r.source_event) derivedFrom.push(String(r.source_event));
    if (cat === "guardian_flag" || cat === "guardian_sender_blocked") flags++;
    if (cat === "report_received") reports++;
  }

  // Behaviour band from the behaviour_confidence bucket (the actor's own conduct).
  let behaviourBand: Band = "neutral";
  try {
    behaviourBand = bandOf((await score(env, uid, "behaviour_confidence", now)).score);
  } catch { /* keep neutral */ }

  // Nothing safety-relevant in the window → skip (don't write empty/neutral noise).
  if (rows.length === 0) {
    return {
      text: "",
      metadata: {
        derived_from: [], summary_version: SUMMARY_VERSION,
        created_from_ruleset: SENTINEL_RULESET_VERSION, buckets: [],
      },
      empty: true,
    };
  }

  const d1 = ymd(rows[0].created_at);
  const d2 = ymd(rows[rows.length - 1].created_at);
  const categories = Array.from(catCounts.keys()).sort().join(", ") || "none";

  // TEMPLATE (deterministic). Category-level only — no message text, media, emails or
  // protected attributes. Example:
  //   "Between 2026-06-06 and 2026-07-06: 3 guardian flags
  //    (guardian_flag, report_received), 1 reports received; behaviour band low."
  const text =
    `Between ${d1} and ${d2}: ${flags} guardian flags (${categories}), ` +
    `${reports} reports received; behaviour band ${behaviourBand}.`;

  return {
    text,
    metadata: {
      derived_from: dedupe(derivedFrom).slice(0, 200), // cap provenance list size
      summary_version: SUMMARY_VERSION,
      created_from_ruleset: SENTINEL_RULESET_VERSION,
      buckets: Array.from(buckets).sort(),
    },
    empty: false,
  };
}

function dedupe(a: string[]): string[] {
  return Array.from(new Set(a));
}

// ─────────────────────────────────────────────────────────────────────────────
// maybeSummarise — the async entry point ingest.ts calls (fire-and-forget).
//   1. gate on sentinelMem0Enabled + MEM0_API_KEY (both required).
//   2. opportunistically drain the mem0 purge queue (deletion retries never block
//      canonical deletion; this is the drain that eventually confirms them).
//   3. debounce (≤ 1 per uid per 6h).
//   4. build the deterministic summary; write to mem0; stamp the debounce.
// Never throws. Never on a message hot path (caller invokes with void).
// ─────────────────────────────────────────────────────────────────────────────
export async function maybeSummarise(env: Env, uid: string, now = Date.now()): Promise<void> {
  try {
    if (!uid) return;
    if (!(await sentinelMem0Enabled(env))) return;
    if (!mem0Configured(env)) return;

    // Opportunistic purge drain (best-effort; bounded). Keeps deletion retries moving
    // without a dedicated cron. Guarded internally; never throws.
    void processPurgeQueue(env).catch(() => {});

    if (!(await debounceOk(env, uid, now))) return;

    const summary = await buildBehaviouralSummary(env, uid, now);
    if (summary.empty) {
      // Still stamp the debounce so we don't re-scan an empty window every event.
      await markSummarised(env, uid, now);
      return;
    }

    const ok = await writeMemory(env, uid, summary.text, summary.metadata);
    // Stamp regardless of write success: a failed write already emitted
    // mem0_write_failed, and we don't want to retry-storm mem0 on every event. The
    // next window (6h) picks up any missed patterns — the evidence log is durable.
    await markSummarised(env, uid, now);

    void track(env, uid, "mem0_summarised", "sentinel", {
      written: ok, summary_version: SUMMARY_VERSION,
      derived_count: summary.metadata.derived_from.length,
      buckets: summary.metadata.buckets,
    });
  } catch {
    /* fail-open: mem0 summarisation must never affect anything upstream */
  }
}

// Re-export buckets list for callers/tests.
export { SENTINEL_BUCKETS };
export type { SentinelBucket };
