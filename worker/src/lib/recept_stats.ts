// [RECEPT-STATS-1] Canonical receptionist call-summary pipeline (plan §C1/§C4,
// Specs/PLAN-2026-07-19-onboarding-bonus-analytics.md).
//
// ONE entry point — recordCallSummary() — called from every lane's finalize:
//   • do/reception_room.ts      (Gemini app lane, mode=agent, transport=app)
//   • do/reception_room_cf.ts   (CF conversational + VM mode, transport=app)
//   • do/vobiz_agent_room.ts    (PSTN agent lane, transport=vobiz)
//   • routes/pstn.ts            (PSTN voicemail record-cb + missed-call hangup)
//
// It does four things, ALL best-effort (a stats hiccup must never break a call):
//   1. emits the ONE canonical `ava_recept_call_summary` PostHog event
//      (owner email/phone-stamped via the trackUserContact pattern);
//   2. mirrors the summary into the self-migrating D1 table `recept_call_stats`
//      on metaDb — the analytics dashboard reads THIS, never PostHog;
//   3. enforces the 90-day retention the owner decided (cheap per-owner DELETE
//      on each insert — no cron);
//   4. feeds AvaBrain via brainIngest (domain "receptionist") — consent is
//      checked INSIDE brainIngest (master + "receptionist" guardrail key) and
//      FAILS CLOSED, per the rulebook.
//
// This is analytics plumbing, NOT engine code — routes/pstn.ts may import it
// without violating its no-engine-import rule.

import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { trackUserContact } from "../hooks";
import { brainIngest } from "./brain_ingest";

export interface ReceptCallSummary {
  /** Stable per-call id (session sid / CallUUID) — the D1 PRIMARY KEY, so a
   *  webhook retry or double finalize collapses to one row (INSERT OR REPLACE). */
  id: string;
  owner_uid: string;
  /** Call-end time (epoch ms). */
  ts: number;
  /** Caller identity — E.164 on PSTN, caller_uid on the app lane. NOT hashed:
   *  the owner is allowed to see their own callers' numbers (owner decision). */
  caller_key: string;
  caller_name?: string | null;
  /** ISO-3166 alpha-2 (e164Country / req.cf.country) or "??". */
  country?: string | null;
  mode: "agent" | "vm";
  transport: "app" | "vobiz";
  duration_s: number;
  /** Tokens actually charged for this call (0 while beta-free). */
  tokens: number;
  /** completed | missed | busy | balance_exhausted | caller_hangup */
  outcome: string;
  // ── event-only extras (not stored in D1) ──
  /** Raw cutoff reason for PostHog (ava_goodbye/time_up/hard_cap/…). */
  reason?: string | null;
  /** Owner contact for email-stamped telemetry (lanes already resolve it). */
  owner_email?: string | null;
  owner_phone?: string | null;
  /** IANA timezone for the best-effort hour_local event prop, when a lane has
   *  one (app lane: req.cf.timezone at /start). PSTN webhooks have none — the
   *  dashboard computes owner-local hours from the device's own offset instead. */
  tz?: string | null;
}

const RETENTION_DAYS = 90; // owner decision 2026-07-19 (plan "Open questions")
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

// Guarded once-per-isolate self-migration (ensureStatusColumns pattern).
let _statsEnsured = false;
export async function ensureReceptStatsTable(env: Env): Promise<void> {
  if (_statsEnsured) return;
  _statsEnsured = true;
  try {
    await metaDb(env).prepare(
      `CREATE TABLE IF NOT EXISTS recept_call_stats (
         id TEXT PRIMARY KEY,
         owner_uid TEXT NOT NULL,
         ts INTEGER NOT NULL,
         caller_key TEXT,
         caller_name TEXT,
         country TEXT,
         mode TEXT,
         transport TEXT,
         duration_s INTEGER,
         tokens REAL,
         outcome TEXT
       )`,
    ).run();
    await metaDb(env).prepare(
      `CREATE INDEX IF NOT EXISTS idx_recept_stats_owner_ts ON recept_call_stats (owner_uid, ts)`,
    ).run();
  } catch { _statsEnsured = false; /* retry on next call */ }
}

/**
 * Map a lane's raw finalize/cutoff reason onto the canonical outcome enum.
 * `hadConversation` distinguishes a caller who hung up mid-call from one who
 * bailed before anything happened (= missed).
 */
export function receptOutcome(reason: string | null | undefined, hadConversation: boolean): string {
  const r = String(reason ?? "").toLowerCase();
  if (r === "balance_exhausted") return "balance_exhausted";
  if (r === "busy") return "busy";
  if (r === "caller_hangup" || r === "error" || r === "gemini_connect_failed" || r === "missed") {
    return hadConversation ? "caller_hangup" : "missed";
  }
  // ava_goodbye / ava_ended / time_up / time_up_wrap / vm_complete / hard_cap /
  // inactivity / model_closed / … — the call ran and ended.
  return "completed";
}

/** Best-effort local hour for an IANA tz (undefined when tz missing/invalid). */
function hourInTz(ts: number, tz: string | null | undefined): number | undefined {
  if (!tz) return undefined;
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
      .format(new Date(ts));
    const n = Number(h) % 24;
    return Number.isFinite(n) ? n : undefined;
  } catch { return undefined; }
}

/**
 * The one call-summary sink every lane calls at call end. NEVER throws; each of
 * the four effects is independently best-effort.
 */
export async function recordCallSummary(env: Env, s: ReceptCallSummary): Promise<void> {
  if (!s?.id || !s.owner_uid) return;
  const country = (String(s.country ?? "").toUpperCase().slice(0, 2)) || "??";
  const durationS = Math.max(0, Math.round(Number(s.duration_s) || 0));
  const tokens = Math.max(0, Number(s.tokens) || 0);
  const outcome = s.outcome || "completed";
  const callerKey = s.caller_key || "unknown";

  // 1. ONE canonical PostHog event (ops/debug view; the dashboard reads D1).
  try {
    const hourUtc = new Date(s.ts).getUTCHours();
    const hourLocal = hourInTz(s.ts, s.tz);
    await trackUserContact(env, s.owner_uid, s.owner_email ?? null, s.owner_phone ?? null,
      "ava_recept_call_summary", "receptionist", {
        owner_uid: s.owner_uid,
        caller: callerKey,
        caller_name: s.caller_name ?? null,
        caller_country: country,
        mode: s.mode,
        transport: s.transport,
        duration_s: durationS,
        tokens_charged: tokens,
        hour_utc: hourUtc,
        ...(hourLocal != null ? { hour_local: hourLocal, tz: s.tz } : {}),
        outcome,
        cutoff_reason: s.reason ?? null,
        call_id: s.id,
      }, s.id);
  } catch { /* best-effort */ }

  // 2. D1 mirror + 3. 90-day per-owner retention (cheap: hits the
  // (owner_uid, ts) index, one owner's rows only, no cron needed).
  try {
    await ensureReceptStatsTable(env);
    await metaDb(env).prepare(
      `INSERT OR REPLACE INTO recept_call_stats
         (id, owner_uid, ts, caller_key, caller_name, country, mode, transport, duration_s, tokens, outcome)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(s.id, s.owner_uid, s.ts, callerKey, s.caller_name ?? null, country,
      s.mode, s.transport, durationS, tokens, outcome).run();
    await metaDb(env).prepare(
      `DELETE FROM recept_call_stats WHERE owner_uid=?1 AND ts < ?2`,
    ).bind(s.owner_uid, Date.now() - RETENTION_MS).run();
  } catch { /* best-effort */ }

  // 4. AvaBrain feed (plan §C4). brainIngest resolves the "receptionist" domain
  // from the registry and checks consent (master + "receptionist" guardrail)
  // FAIL-CLOSED before enqueueing to Q_BRAIN — no consent, no send, and any
  // consent-store error drops the event. sourceId=id → stable idempotency key.
  try {
    const who = s.caller_name || callerKey;
    const modeWord = s.mode === "vm" ? "left a voicemail" : "spoke with Ava (AI receptionist)";
    await brainIngest(env, {
      uid: s.owner_uid,
      domain: "receptionist",
      kind: "call_summary",
      sourceId: s.id,
      text: `${who} called; ${modeWord}; ${durationS}s; ${outcome}`,
      meta: {
        caller: callerKey, caller_name: s.caller_name ?? null, country,
        mode: s.mode, transport: s.transport, duration_s: durationS, outcome,
      },
      ts: s.ts,
      email: s.owner_email ?? null,
    });
  } catch { /* best-effort — consent/queue issues never break the call */ }
}
