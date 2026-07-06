// Guardian Sentinel — S1 extractors: DETERMINISTIC rules ONLY. No LLM anywhere in
// S1 (plan §1.1 rule 1 — the frozen Trust Engine's LLM-free law holds end to end).
//
// An extractor maps ONE incoming event {type, uid, payload} → EvidenceAdded[]. Each
// rule has a stable rule_id (SEN-00x) and fully satisfies the 7-question provenance
// (source_event, rule_id, ruleset_version, timestamp, replayable, decay-via-half-life)
// via the EvidenceAdded fields. Signals are safety-relevant ONLY (allowlist, §1.1
// rule 7): scam/spam, upheld reports, fake listings, mass-messaging, moderation
// failures, liveness. Never politics/religion/lawful interests/adult content.
//
// Deltas + half-lives ship DARK and are intentionally CONSERVATIVE — thresholds are
// tuned from telemetry before ANY enforcement (plan §2.4). Nothing here acts; it
// only records evidence.

import type { Env } from "../types";
import type { EvidenceAdded, SentinelBucket } from "./evidence";
import { SENTINEL_RULESET_VERSION } from "./fold";

// ─────────────────────────────────────────────────────────────────────────────
// Incoming event shape (the single fan-in). Mirrors the Q_BRAIN envelope
// {uid, event_type, source_app, payload} but named for Sentinel's own use so the
// consumer wiring (S1 §5) can adapt either the bus or a direct best-effort call.
// ─────────────────────────────────────────────────────────────────────────────
export interface SentinelEvent {
  type: string;                       // event type (e.g. "guardian_flag")
  uid: string;                        // the subject the evidence is ABOUT
  source_event?: string;              // immutable event id (falls back to a synthesised one)
  ts?: number;                        // event timestamp (ms); defaults to now
  payload?: Record<string, unknown>;  // event-specific fields
}

// Half-lives (days) by evidence "temperature". A confident harm signal decays
// slowly (stays relevant); a soft/velocity signal decays fast.
const HL_SLOW = 90;    // upheld reports, moderation failures
const HL_MED = 45;     // flags, blocks
const HL_FAST = 7;     // velocity / mass-messaging bursts
const HL_POSITIVE = 180; // identity/liveness pass — long-lived positive

function mk(
  uid: string, bucket: SentinelBucket, delta: number, reason: string,
  rule_id: string, half_life_days: number, source_event: string, created_at: number,
): EvidenceAdded {
  return {
    id: crypto.randomUUID(),
    uid, bucket, delta, reason,
    source_event, rule_id,
    ruleset_version: SENTINEL_RULESET_VERSION,
    half_life_days, created_at,
  };
}

// Map a guardian category → (bucket, base magnitude). Community reputation is the
// broad "how trusted in the network" bucket; behaviour is the actor's own conduct.
function categorySeverityDelta(category: string, severity: number): number {
  // severity 1..3 → scale the magnitude. Kept small & negative (evidence, not verdict).
  const s = Math.max(1, Math.min(3, Number(severity) || 1));
  const bad = new Set(["scam", "grooming", "csae", "trafficking", "threat", "hate", "spam", "deepfake"]);
  if (!bad.has(String(category))) return 0;
  return -(2 * s); // sev1→-2, sev2→-4, sev3→-6
}

// ─────────────────────────────────────────────────────────────────────────────
// The rule table. Each case is a pure function of the event → EvidenceAdded[].
// ─────────────────────────────────────────────────────────────────────────────
export function extract(ev: SentinelEvent): EvidenceAdded[] {
  const uid = String(ev.uid ?? "");
  if (!uid) return [];
  const ts = Number(ev.ts) || Date.now();
  const p = ev.payload ?? {};
  const src = ev.source_event || `${ev.type}:${ts}`;
  const out: EvidenceAdded[] = [];

  switch (ev.type) {
    // SEN-001 — a Guardian flag was raised against this user (as sender/peer). The
    // subject `uid` here is the FLAGGED actor. Maps category/severity → community +
    // behaviour deltas.
    case "guardian_flag": {
      const category = String(p.category ?? "");
      const severity = Number(p.severity ?? 1);
      const d = categorySeverityDelta(category, severity);
      if (d !== 0) {
        out.push(mk(uid, "community_reputation", d, `guardian_flag:${category}`, "SEN-001", HL_MED, src, ts));
        out.push(mk(uid, "behaviour_confidence", d, `guardian_flag:${category}`, "SEN-001", HL_MED, src, ts));
      }
      break;
    }

    // SEN-002 — Guardian auto-blocked this sender after repeated predatory messages
    // (strong negative community signal).
    case "guardian_sender_blocked": {
      out.push(mk(uid, "community_reputation", -8, "guardian_sender_blocked", "SEN-002", HL_MED, src, ts));
      break;
    }

    // SEN-003 — a user report was RECEIVED against this user (weaker than an upheld
    // report; upheld outcomes arrive with the outcome stream). Small negative.
    case "report_received": {
      out.push(mk(uid, "community_reputation", -3, "report_received", "SEN-003", HL_SLOW, src, ts));
      break;
    }

    // SEN-004 — a marketplace listing by this user FAILED moderation (fake/prohibited
    // listing). Negative marketplace_trust.
    case "listing_moderation_fail": {
      out.push(mk(uid, "marketplace_trust", -6, "listing_moderation_fail", "SEN-004", HL_SLOW, src, ts));
      break;
    }

    // SEN-005 — an upload by this user FAILED moderation (prohibited media).
    case "upload_moderation_fail": {
      out.push(mk(uid, "media_risk", -6, "upload_moderation_fail", "SEN-005", HL_SLOW, src, ts));
      break;
    }

    // SEN-006 — a liveness verification PASSED (a real human face proved). Positive
    // identity_confidence, long-lived.
    case "liveness_pass": {
      out.push(mk(uid, "identity_confidence", +10, "liveness_pass", "SEN-006", HL_POSITIVE, src, ts));
      break;
    }

    // SEN-007 — message velocity: a burst of FIRST-messages to distinct recipients in
    // a short window (mass-messaging / spray). `first_message_burst` carries the
    // window count. Negative behaviour_confidence, fast decay. The burst detection
    // itself is a deterministic counter (see recordFirstMessage/burstDelta below);
    // this rule just turns a supplied burst count into evidence.
    case "message_velocity": {
      const burst = Math.max(0, Number(p.burst ?? p.count ?? 0));
      if (burst > 0) {
        // -1 per message over the burst, capped so one event can't tank a score.
        const d = -Math.min(10, burst);
        out.push(mk(uid, "behaviour_confidence", d, `message_velocity:${burst}`, "SEN-007", HL_FAST, src, ts));
      }
      break;
    }

    default:
      // Unknown event type → no evidence (fail-safe; the allowlist is explicit).
      break;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message-velocity counter (SEN-007 support). A DETERMINISTIC D1 sliding window of
// distinct first-message recipients per sender. Self-creating table in DB_META.
// Returns the current burst count so the caller can synthesise a message_velocity
// event when the count crosses a window threshold. This is the "simple D1 counter"
// the plan permits (a DO counter is the S-scale alternative in do.ts's hot cache).
// ─────────────────────────────────────────────────────────────────────────────
const VELOCITY_WINDOW_MS = 5 * 60_000; // 5-minute burst window
export const VELOCITY_BURST_THRESHOLD = 10; // ≥10 distinct first-recipients in the window

let _velEnsured = false;
async function ensureVelocityTable(env: Env): Promise<void> {
  if (_velEnsured) return;
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS sentinel_velocity (
       uid       TEXT NOT NULL,
       recipient TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (uid, recipient)
     )`,
  ).run().catch(() => {});
  await env.DB_META.prepare(
    `CREATE INDEX IF NOT EXISTS idx_sentinel_velocity_uid ON sentinel_velocity (uid, created_at)`,
  ).run().catch(() => {});
  _velEnsured = true;
}

/** Record a FIRST message from `uid` to `recipient` and return the count of
 *  distinct recipients within the current window. Best-effort; returns 0 on error
 *  (fail-open — velocity is a soft signal). */
export async function recordFirstMessage(env: Env, uid: string, recipient: string, now = Date.now()): Promise<number> {
  if (!uid || !recipient) return 0;
  try {
    await ensureVelocityTable(env);
    // Upsert this recipient into the window (idempotent per distinct recipient).
    await env.DB_META.prepare(
      `INSERT INTO sentinel_velocity (uid, recipient, created_at) VALUES (?1,?2,?3)
       ON CONFLICT(uid, recipient) DO UPDATE SET created_at=?3`,
    ).bind(uid, recipient, now).run();
    // Opportunistic prune of aged-out rows (bounds the table).
    await env.DB_META.prepare(
      "DELETE FROM sentinel_velocity WHERE uid=?1 AND created_at < ?2",
    ).bind(uid, now - VELOCITY_WINDOW_MS).run();
    const r = await env.DB_META.prepare(
      "SELECT COUNT(*) AS n FROM sentinel_velocity WHERE uid=?1 AND created_at >= ?2",
    ).bind(uid, now - VELOCITY_WINDOW_MS).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}
