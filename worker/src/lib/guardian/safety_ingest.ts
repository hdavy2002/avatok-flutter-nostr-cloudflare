// ── guardianIngest — the ONE producer path into the SAFETY store (SPEC §10.3) ──
//
// The safety store (guardian_events) is a governed, legal-basis (§10.1) record of
// platform safety events. It sits on the SAME governance plane as the brain — one
// ingest contract, §3.2 idempotency, one audit, one retention policy — but is a
// SEPARATE store with its OWN retention clock (§10.2) and NO brainRecall path. It is
// NOT per-user memory (§10.3): a flag is two-party (about a sender, raised toward a
// recipient), so it is a platform record that merely references users.
//
// ACL (§10.3): this module (worker/src/lib/guardian/) is the ONLY writer of
// guardian_events, and guardianContext() (context.ts) is the ONLY reader. The public
// brainIngest lane HARD-REJECTS domain:'safety' (brain_ingest.ts), so a spoofed
// producer cannot inject a safety record; and the write here is a DIRECT D1 write,
// never a Q_BRAIN envelope, so nothing on the general brain lane can see it. The
// import boundary is lint-enforced (worker/eslint.config.mjs).
//
// ── §10.5 POLICY BOUNDARIES (recorded here; the enforceable part is the ACL) ─────
//   • Safety data MUST NEVER feed ranking, matching, listing visibility, search
//     order, or dating recommendations. A trust score that silently changes who sees
//     you, with no notice and no appeal, is a shadow-ban — a decision with an appeals
//     process attached, not a side-effect of an ingest path. guardian_events exposes
//     no ranking reader by construction (only guardianContext, purpose-scoped).
//   • Guardian MUST NEVER infer, store, search on, or use protected traits —
//     orientation or neurodivergence (M-D17) — for trust scoring, moderation
//     weighting, or ranking. Only the MINIMAL derived record below is written:
//     category/severity, subject+counterparty ids, action, model version, ts. NEVER
//     raw message content (B-D1), and never a protected-trait inference.
//
// It is fire-and-forget for callers (returns a Promise they may `void`/`waitUntil`).
// Fail-open: a safety-record write failure must never block or delay delivery.

import type { Env } from "../../types";
import { track, metric } from "../../hooks";

/** The enforcement/outcome action a safety event records. */
export type GuardianAction = "flag" | "warn" | "block" | "ban";

/** The minimal derived safety record (§10.3). NEVER carries message content. */
export interface GuardianIngestInput {
  /** The actor the event is ABOUT — the sender / flagged party (Sentinel's subject). */
  subjectUid: string;
  /** The other party (recipient), if any. */
  counterpartyUid?: string | null;
  /** The conversation the event arose in (guardianContext filter). */
  conversationId?: string | null;
  /** Harm category — GuardianCategory from ava_guardian.ts (kept as a string here to
   *  avoid a route↔lib import cycle). */
  category: string;
  /** 1 low … 3 high. */
  severity: number;
  /** The action taken/derived. */
  action: GuardianAction;
  /** Classifier/model version, if the producer has one (provenance — §10.6). */
  modelVersion?: string | null;
  /** Appeal/correction state (§10.6). Defaults to 'none'. */
  appealState?: string | null;
  /** Event time (producer clock). serverTs (created_at) is assigned on ingest. */
  ts?: number;
  /** Stable id of the producing event (flag id, block key, …). Combined with
   *  (subjectUid, category, action) into the §3.2 idempotency key so a queue
   *  redelivery / double-fire collapses to one row. Strongly recommended. */
  sourceId?: string;
  /** Precomputed idempotency key (rare — normally derived from sourceId). */
  idempotencyKey?: string;
}

export interface GuardianIngestResult {
  ok: boolean;
  dropped?: boolean;
  reason?: "no_subject" | "db_error";
}

// FNV-1a (32-bit) → hex. Deterministic, synchronous, bounded — the §3.2 idempotency
// key only needs to be stable + collision-resistant per (subject,category,action,
// sourceId), not cryptographic. Mirrors brain_ingest.ts's key derivation shape.
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function idempotencyKeyFor(subjectUid: string, category: string, action: string, sourceId?: string): string {
  const src = sourceId != null && sourceId !== "" ? sourceId : `rnd:${crypto.randomUUID()}`;
  return fnv1aHex(`${subjectUid}\x00safety\x00${category}\x00${action}\x00${src}`);
}

/**
 * Write a minimal structured safety event into guardian_events (DB_BRAIN). Direct
 * D1 write (§10.3) — never Q_BRAIN. Idempotent on (subject_uid, idempotency_key)
 * (§3.2): a duplicate is a silent no-op. Fail-open: any error returns dropped and is
 * telemetered but never thrown, so the caller's safety path is never blocked.
 */
export async function guardianIngest(env: Env, input: GuardianIngestInput): Promise<GuardianIngestResult> {
  const subjectUid = String(input.subjectUid ?? "").trim();
  if (!subjectUid) return { ok: false, dropped: true, reason: "no_subject" };

  const now = Date.now();
  const ts = Number(input.ts ?? now);
  const idem = input.idempotencyKey || idempotencyKeyFor(subjectUid, String(input.category), String(input.action), input.sourceId);
  const category = String(input.category ?? "");
  const severity = Number.isFinite(input.severity) ? Number(input.severity) : 0;
  const action = String(input.action ?? "flag");
  const appealState = input.appealState ? String(input.appealState) : "none";

  try {
    // Idempotent insert — the partial unique index on (subject_uid, idempotency_key)
    // makes a redelivery / double-fire a no-op. NEVER upserts content (there is none).
    await env.DB_BRAIN.prepare(
      `INSERT INTO guardian_events
         (id, subject_uid, counterparty_uid, conversation_id, category, severity, action, model_version, appeal_state, idempotency_key, ts, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(subject_uid, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    ).bind(
      crypto.randomUUID(),
      subjectUid,
      input.counterpartyUid ? String(input.counterpartyUid) : null,
      input.conversationId ? String(input.conversationId) : null,
      category,
      severity,
      action,
      input.modelVersion ? String(input.modelVersion) : null,
      appealState,
      idem,
      ts,
      now,
    ).run();
    try { metric(env, "guardian_ingest", [1], [category, action]); } catch { /* best-effort */ }
    return { ok: true };
  } catch (e) {
    try {
      metric(env, "guardian_ingest_db_error", [1], [category, action]);
      void track(env, subjectUid, "guardian_ingest_db_error", "guardian", {
        category, action, severity, error: String((e as any)?.message ?? e).slice(0, 200),
      });
    } catch { /* telemetry best-effort */ }
    return { ok: false, dropped: true, reason: "db_error" };
  }
}
