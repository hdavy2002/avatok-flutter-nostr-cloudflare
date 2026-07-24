-- [AVABRAIN-COMPANION-2] ava_companion_drafts — the draft/approval layer on
-- top of [AVA-GROUP-COMPANION-1] (worker/migrations/ava_group_companion.sql)
-- and [AVA-ODL-POST-1] (worker/migrations/ava_interventions.sql).
--
-- WHY A NEW TABLE (not another ALTER on ava_group_companion.sql). That file's
-- ALTER TABLE statements are one-shot (D1/SQLite has no "ADD COLUMN IF NOT
-- EXISTS") and may already have been applied in an environment. Appending more
-- ALTERs to that same file would re-error on the already-applied statements
-- the next time anyone runs it. A new, independently-idempotent file is the
-- safe additive move (same convention ava_interventions.sql documents).
--
-- WHY A NEW TABLE AT ALL (not just reusing ava_interventions). ava_interventions
-- (worker/migrations/ava_interventions.sql) is the durable RESERVE→POST
-- decision ledger — it deliberately carries no message BODY, only
-- decision_id/uid/conv_hash/capability/status. Bible §6.3 requires a
-- visible-preview + approval step before anything posts
-- (Specs/AVABRAIN-PRODUCT-BIBLE-2026-07-24.md §6.2/§6.3/§P2): an approver has
-- to be shown the actual candidate text, so SOMETHING has to hold it. This
-- table is that something — one row per draft, keyed by the SAME decision_id
-- ava_odl.ts's groupDecisionIdFor/decisionIdFor pattern already produces (this
-- file's companion_policy.ts computes decision ids with an identical local
-- FNV-1a idiom — see that file's header for why it isn't a shared import).
--
-- STATUS MACHINE (mirrors + extends [AVA-ODL-POST-1]'s ava_interventions
-- status column, which already reserves 'rejected' for "a future two-phase
-- flow, unused in v1" — this IS that flow now):
--   'pending_approval' → the draft exists, nobody has decided yet.
--   'approved'         → a human said yes; the existing post path
--                        (ava_lane.ts postAvaPrivate/postAvaGroup — NOT a
--                        second sender) is about to run or already ran.
--   'posted'           → the existing post path confirmed delivery.
--   'rejected'         → a human said no. Terminal — never posted.
--   'expired'          → a lazy TTL sweep (mirrors ava_odl.ts's
--                        sweepExpiredInterventions) reclaims drafts nobody
--                        ever decided on, so a stale draft can't sit forever
--                        and can't silently "auto-post" by omission.
--
-- template_id: the bible's "no autonomous warnings about individuals; use
-- neutral safety templates" rule (§6.2) is enforced by ONLY ever storing a
-- fixed template id here (ava_templates.ts) plus the already-filled
-- placeholder text produced from it — never free-form generated text. Every
-- capability reaching this table is zero-AI/regex+template (ava_odl.ts file
-- header), so draft_text is always the deterministic output of fillTemplate,
-- never an LLM completion.
--
-- scope/target_uid: mirrors ava_group_policy.ts groupScopeOf — 'private'
-- drafts are visible/approvable only by target_uid (the specific recipient)
-- or a group admin; 'public' drafts are approvable ONLY by a group
-- owner/admin (companion_policy.ts / ava_group.ts enforce this, not this
-- schema — D1 has no row-level security).
--
-- Group memory scoping (bible §6.2 "never use one group's transcript to
-- answer another group"): this table carries `conv` (never cross-referenced
-- against any OTHER conv's rows by any query in companion_policy.ts/
-- ava_group.ts) — enforced in code (every SELECT/UPDATE below is scoped by
-- `conv` or `decision_id`, never a bare capability/uid lookup that could leak
-- across groups).
CREATE TABLE IF NOT EXISTS ava_companion_drafts (
  decision_id   TEXT    PRIMARY KEY,                     -- same id ava_interventions uses for this candidate
  conv          TEXT    NOT NULL,                        -- raw group conv id (matches ava_group_state.conv, NOT hashed — needed for conversation_members role checks)
  capability    TEXT    NOT NULL,                        -- ava_capabilities.ts CAPABILITY_SEED id
  template_id   TEXT    NOT NULL,                         -- ava_templates.ts fixed template id — never free text (bible §6.2)
  draft_text    TEXT    NOT NULL,                         -- fillTemplate(...) output shown in the draft-card preview
  scope         TEXT    NOT NULL,                         -- 'public'|'private' (ava_group_policy.ts groupScopeOf)
  target_uid    TEXT,                                     -- recipient uid for scope='private'; NULL for 'public'
  status        TEXT    NOT NULL DEFAULT 'pending_approval', -- 'pending_approval'|'approved'|'posted'|'rejected'|'expired'
  created_by    TEXT,                                     -- 'ava' for system-generated candidates (v1: always 'ava')
  decided_by    TEXT,                                     -- uid of the human who approved/rejected
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Draft-card list ("pending drafts for this group") and the daily draft
-- budget COUNT (companion_policy.ts) both filter on (conv, created_at) — this
-- index keeps both index-only.
CREATE INDEX IF NOT EXISTS idx_ava_companion_drafts_conv_created ON ava_companion_drafts(conv, created_at);

-- The lazy TTL sweep (companion_policy.ts, mirrors ava_odl.ts's
-- sweepExpiredInterventions) scans pending drafts by age across ALL groups.
CREATE INDEX IF NOT EXISTS idx_ava_companion_drafts_status_created ON ava_companion_drafts(status, created_at);
