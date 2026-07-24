-- [AVA-ODL-POST-1] ava_interventions — durable decision ledger for the ODL
-- post path (Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md F7).
--
-- GENUINELY NEW SCHEMA. DB: DB_META (env.DB_META) — same database as
-- agent_inbox/agent_personas (worker/migrations/agent.sql), which is the
-- established home for Ava-adjacent per-uid decision/state rows that are NOT
-- message content itself (message content stays in the per-user InboxDO
-- SQLite, never centralized — see Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md).
--
-- WHY THIS TABLE EXISTS (F7). `ava_odl.ts` spends the account-wide Moments
-- budget (ava_budget.ts spendMoment) and the Governor/capability counters
-- BEFORE any user-visible output exists. Without a durable record tying that
-- spend to an attempted post, a crash between "budget spent" and "InboxDO
-- append acknowledged" either (a) silently burns the user's daily allowance
-- for a Moment nobody ever saw, or (b) a naive retry re-runs the whole ODL
-- funnel from scratch and double-posts. This table is the missing durability
-- layer: ONE row per (uid, conv, trigger-text, capability) decision, keyed so
-- a retry of the SAME decision is a no-op, with a status machine the posting
-- code advances only after the InboxDO write is acknowledged.
--
-- decision_id IS DETERMINISTIC, NOT RANDOM (F7: "Retry by decision_id, never
-- by a fresh random message id"). It is computed in ava_odl.ts from
-- fnv1a(uid|conv|capability) + fnv1a(triggering text) — the same (uid, conv,
-- capability, message text) always hashes to the same decision_id. odlProcess
-- has no message/event id available at its call site (ava_guardian.ts passes
-- only {uid, conv, text, senderUid, isGroup} — out of this task's file set),
-- so the message TEXT is the best available stand-in for "trigger event id":
-- it is exactly what determines whether the SAME opportunity would fire
-- again, and is stable across retries of literally the same odlProcess call
-- (e.g. an at-least-once redelivery of the Guardian scan for one message).
-- Two DIFFERENT messages that happen to contain identical text within the
-- same (uid, conv, capability) are treated as the same decision by design —
-- an acceptable trade-off for a dormant, flag-gated v1 (see F7's own framing:
-- correctness under retry matters far more here than distinguishing two
-- byte-identical nudges a few seconds apart).
--
-- STATUS MACHINE (F7): 'reserved' → 'posted' (InboxDO ack'd) | 'rejected'
-- (a gate says no AFTER the row was reserved — not used in v1, held for a
-- future two-phase flow) | 'expired' (24h TTL sweep, lazy, run from
-- odlProcess itself — see the sweep query below). INSERT is `INSERT OR
-- IGNORE` on the decision_id PK: a retried decision hits the existing row
-- and does nothing further (idempotency without a second budget spend).
--
-- budget_reserved is NOT a KV read/write here — it is the moments-budget UNIT
-- already spent by ava_budget.spendMoment() for this wake (see ava_odl.ts:
-- spendMoment() keeps running exactly where it always has, so shadow-mode
-- budget accounting for capability-cost-ledger projections is byte-for-byte
-- unchanged; this row is written immediately after that spend succeeds and
-- BEFORE the template render / private-lane post, so a crash after this
-- point always leaves an auditable 'reserved' row instead of a silently lost
-- charge). budget_reserved = 1 always in v1 (one Moments-budget unit per
-- decision); the column exists so a future capability that reserves more
-- than one unit doesn't need a schema change.
--
-- IDEMPOTENCY — this file is natively safe to re-run: every statement is
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. No ALTER, so
-- scripts/d1_apply_alters.py is not needed; run it raw via scripts/cf.sh
-- (staging by default, prod fail-closed behind ALLOW_PROD=1):
--   scripts/cf.sh worker d1 execute DB_META --remote \
--     --file=migrations/ava_interventions.sql
--
-- STAYS DARK: this table is written to ONLY when odlEnabled AND
-- avaMomentsEnabled are both true in KV, and both default false in prod
-- (worker/src/routes/config.ts DEFAULTS). Creating the table changes nothing
-- observable in production.

CREATE TABLE IF NOT EXISTS ava_interventions (
  decision_id     TEXT    PRIMARY KEY,        -- deterministic, see header
  uid             TEXT    NOT NULL,            -- the recipient whose lane may receive the Moment
  conv_hash       TEXT    NOT NULL,            -- fnv1a(conv) — never store the raw conv id/PII inline
  capability      TEXT    NOT NULL,            -- ava_capabilities.ts CAPABILITY_SEED id
  policy_version  INTEGER NOT NULL DEFAULT 1,  -- ava_triggers.TRIGGER_BANK_VERSION at decision time
  budget_reserved INTEGER NOT NULL DEFAULT 1,  -- moments-budget units this decision already spent
  status          TEXT    NOT NULL DEFAULT 'reserved', -- 'reserved'|'posted'|'rejected'|'expired'
  created_at      INTEGER NOT NULL,            -- epoch ms — reservation time; TTL sweep anchor
  updated_at      INTEGER NOT NULL             -- epoch ms — last status transition
);

-- The learning-loop / ops read path: "this user's recent Moments" and the
-- lazy TTL sweep's WHERE clause both filter on (uid, created_at) or just
-- created_at for 'reserved' rows — this index serves both.
CREATE INDEX IF NOT EXISTS idx_ava_interv_uid_created ON ava_interventions(uid, created_at);

-- The TTL sweep scans reserved rows by age across ALL users (mirrors
-- listing_entitlements' idx_le_expires pattern) — keyed on status+created_at
-- so the lazy DELETE/UPDATE-with-LIMIT query in odlProcess stays index-only.
CREATE INDEX IF NOT EXISTS idx_ava_interv_status_created ON ava_interventions(status, created_at);
