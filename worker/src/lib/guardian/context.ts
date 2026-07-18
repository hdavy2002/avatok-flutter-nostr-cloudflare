// ── guardianContext — the ONLY reader of the SAFETY store (SPEC §10.3) ──────────
//
// A PURPOSE-SPECIFIC reader for recent safety events about a subject — deliberately
// NOT brainRecall. Guardian results must never become general context for every Ava
// feature (§10.6); the safety store is unreachable from ChatAVA, Copilot, marketplace
// compose, and Connect. This reader is importable ONLY from worker/src/lib/guardian/
// and worker/src/routes/ava_guardian.ts — an ACL enforced by module boundary + lint
// (worker/eslint.config.mjs), not by convention (§10.3, mirroring §6.1's AvaLocalBrain
// import-walker rule).
//
// Returns MINIMAL structured events (never raw content — there is none stored). The
// `purpose` is required and recorded so every read is attributable/auditable.

import type { Env } from "../../types";

/** A minimal safety event as returned to a purpose-scoped reader. */
export interface GuardianEvent {
  subjectUid: string;
  counterpartyUid: string | null;
  conversationId: string | null;
  category: string;
  severity: number;
  action: string;
  modelVersion: string | null;
  appealState: string | null;
  ts: number;
  createdAt: number;
}

export interface GuardianContextArgs {
  /** The actor the safety events are ABOUT. */
  subjectUid: string;
  /** Optional — narrow to a single conversation. */
  conversationId?: string | null;
  /** Why this read is happening (audit/telemetry; e.g. 'connect_gate', 'digest'). */
  purpose: string;
  /** Max rows (default 50, hard-capped 200). */
  limit?: number;
}

/**
 * Read recent safety events for a subject (optionally scoped to one conversation).
 * Read-only, bounded, fail-closed to an EMPTY list on any error — a safety read must
 * never throw into the caller's path, and an unavailable store must not be mistaken
 * for "no history". Ordered newest-first.
 */
export async function guardianContext(env: Env, args: GuardianContextArgs): Promise<GuardianEvent[]> {
  const subjectUid = String(args.subjectUid ?? "").trim();
  if (!subjectUid) return [];
  const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50)));
  const conv = args.conversationId ? String(args.conversationId) : null;

  try {
    const rs = conv
      ? await env.DB_BRAIN.prepare(
          `SELECT subject_uid, counterparty_uid, conversation_id, category, severity, action, model_version, appeal_state, ts, created_at
             FROM guardian_events
            WHERE subject_uid = ?1 AND conversation_id = ?2
            ORDER BY created_at DESC LIMIT ?3`,
        ).bind(subjectUid, conv, limit).all()
      : await env.DB_BRAIN.prepare(
          `SELECT subject_uid, counterparty_uid, conversation_id, category, severity, action, model_version, appeal_state, ts, created_at
             FROM guardian_events
            WHERE subject_uid = ?1
            ORDER BY created_at DESC LIMIT ?2`,
        ).bind(subjectUid, limit).all();

    return ((rs.results ?? []) as any[]).map((r) => ({
      subjectUid: String(r.subject_uid),
      counterpartyUid: r.counterparty_uid != null ? String(r.counterparty_uid) : null,
      conversationId: r.conversation_id != null ? String(r.conversation_id) : null,
      category: String(r.category ?? ""),
      severity: Number(r.severity ?? 0),
      action: String(r.action ?? ""),
      modelVersion: r.model_version != null ? String(r.model_version) : null,
      appealState: r.appeal_state != null ? String(r.appeal_state) : null,
      ts: Number(r.ts ?? 0),
      createdAt: Number(r.created_at ?? 0),
    }));
  } catch {
    return []; // fail-closed to empty — never throw into a safety path
  }
}
