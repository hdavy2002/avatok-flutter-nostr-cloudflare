// Guardian Sentinel — S1 ingest: the single fan-in that turns an incoming event
// into evidence, records it, and emits telemetry. This is the join point between
// the deterministic extractors (extractors.ts), the append-only log (evidence.ts),
// and the fold (fold.ts). NO LLM, NO mem0 (S1 is telemetry-only).
//
// DARK behind `sentinelEnabled` — the caller MUST gate on the flag before calling
// (this module also self-gates as a backstop). Flipping ON requires a KV patch of
// platform_config (code defaults never win over KV — 2026-07-04 lesson).
//
// Fail-open, best-effort, detached: a Sentinel failure NEVER affects the user's
// request. Callers invoke `void sentinelIngest(env, event)`.

import type { Env } from "../types";
import { track } from "../hooks";
import { readConfig } from "../routes/config";
import { appendEvidence } from "./evidence";
import { extract, type SentinelEvent } from "./extractors";
import { score, bandOf, SENTINEL_RULESET_VERSION } from "./fold";
// S2 — async behaviour-memory summariser (mem0). DARK behind sentinelMem0Enabled and
// no-ops without MEM0_API_KEY. Fire-and-forget, internally debounced (≤1/uid/6h);
// NEVER on a message hot path and no LLM calls. See summariser.ts.
import { maybeSummarise, sentinelMem0Enabled } from "./summariser";

/** True when Sentinel is enabled (KV-merged). Best-effort; default OFF. */
export async function sentinelEnabled(env: Env): Promise<boolean> {
  try {
    return (await readConfig(env)).sentinelEnabled === true;
  } catch {
    return false;
  }
}

export interface IngestResult {
  ingested: boolean;
  evidenceAdded: number;
  reason?: string;
}

/**
 * Ingest ONE event. Deterministic pipeline:
 *   1. gate on sentinelEnabled (KV).
 *   2. extract() → EvidenceAdded[] (pure, versioned rules).
 *   3. for each: read band BEFORE, append evidence, read band AFTER; emit
 *      sentinel_evidence_added (+ sentinel_bucket_crossed on a band change).
 *   4. emit sentinel_event_ingested (source, type, lag_ms).
 * Never throws.
 */
export async function sentinelIngest(
  env: Env,
  event: SentinelEvent,
  opts: { source?: string } = {},
): Promise<IngestResult> {
  const source = opts.source ?? "hook";
  try {
    if (!(await sentinelEnabled(env))) return { ingested: false, evidenceAdded: 0, reason: "disabled" };

    const now = Date.now();
    const evTs = Number(event.ts) || now;
    const lagMs = Math.max(0, now - evTs);

    const items = extract(event);
    void track(env, event.uid, "sentinel_event_ingested", "sentinel", {
      source, type: event.type, lag_ms: lagMs,
      derived: items.length, ruleset_version: SENTINEL_RULESET_VERSION,
    });
    if (!items.length) return { ingested: true, evidenceAdded: 0, reason: "no_rule" };

    let added = 0;
    for (const ev of items) {
      // Band BEFORE (best-effort; a read failure just omits the before-band).
      let bandBefore: string | null = null;
      try { bandBefore = (await score(env, ev.uid, ev.bucket, now)).band; } catch { /* */ }

      const ok = await appendEvidence(env, ev);
      if (!ok) continue;
      added++;

      // Band AFTER.
      let bandAfter: string | null = bandBefore;
      let scoreAfter: number | null = null;
      try {
        const s = await score(env, ev.uid, ev.bucket, now);
        bandAfter = s.band; scoreAfter = s.score;
      } catch { /* */ }

      void track(env, ev.uid, "sentinel_evidence_added", "sentinel", {
        bucket: ev.bucket, delta: ev.delta, rule_id: ev.rule_id,
        ruleset_version: ev.ruleset_version, reason: ev.reason,
        band_before: bandBefore, band_after: bandAfter,
        score_after: scoreAfter, source_event: ev.source_event,
      });

      if (bandBefore && bandAfter && bandBefore !== bandAfter) {
        void track(env, ev.uid, "sentinel_bucket_crossed", "sentinel", {
          bucket: ev.bucket, band_from: bandBefore, band_to: bandAfter,
          rule_id: ev.rule_id, ruleset_version: ev.ruleset_version,
        });
      }
    }

    // S2 — after evidence is appended, kick the async behaviour-memory summariser for
    // the subject uid. Fire-and-forget, self-debounced, and DARK behind
    // sentinelMem0Enabled (re-checked here so the flag is a hard gate). This is the
    // ONLY hot-path touch and it is fully detached — a mem0 issue can never affect
    // ingestion. mem0 is a derived cache; nothing here owns truth.
    if (added > 0) {
      try {
        if (await sentinelMem0Enabled(env)) void maybeSummarise(env, event.uid);
      } catch { /* mem0 gate/summarise must never break ingest */ }
    }

    return { ingested: true, evidenceAdded: added };
  } catch {
    return { ingested: false, evidenceAdded: 0, reason: "error" };
  }
}

export { bandOf };
