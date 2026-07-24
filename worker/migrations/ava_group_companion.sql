-- [AVA-GROUP-COMPANION-1] Group Ava state + member prefs
-- (Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md I1/I2/I4/I5).
--
-- DB: DB_META (env.DB_META) — same database as conversations/conversation_members
-- (worker/migrations/*, see messaging.ts) and ava_interventions
-- (worker/migrations/ava_interventions.sql, [AVA-ODL-POST-1]).
--
-- ava_group_state — ONE row per group conv (I1). `mode` is the per-group
-- owner/admin opt-in: 'off' (no observation/memory/interventions), 'assistant'
-- (@ava only), 'companion' (Ava may propose private suggestions + a bounded
-- rate of public interventions per group policy). ava_odl.ts's group path
-- treats a MISSING row identically to mode='off' (fail closed — see
-- ava_group_policy.ts getGroupState()).
--
-- budget_tokens_daily (I4): the column name matches the spec's future
-- token-cost model, but v1 (this issue) interprets it as a simple COUNT-based
-- daily cap on PUBLIC group interventions (COUNT of 'posted' rows in
-- ava_interventions with payer='group' for this conv in the last 24h) — see
-- ava_group_policy.ts checkGroupCooldownAndBudget(). Real token-cost
-- accounting arrives with the wallet/billing wave (owned elsewhere — see
-- CLAUDE.md "Never bill an arbitrary member").
--
-- cooldown_s (I5): minimum seconds between two PUBLIC group interventions in
-- the same conv, default 1800 (30 min). Private nudges are NOT rate-limited
-- by this column — they are gated by per-member mute prefs + the existing
-- account-wide Moments/eval budgets in ava_budget.ts, unchanged by this issue.
--
-- policy_version: reserved for a future group-policy schema bump; always 1 in
-- v1 and not yet read anywhere — included now so a later migration can add
-- meaning without another ALTER.
CREATE TABLE IF NOT EXISTS ava_group_state (
  conv                TEXT    PRIMARY KEY,
  mode                TEXT    NOT NULL DEFAULT 'off',   -- 'off'|'assistant'|'companion'
  budget_tokens_daily  INTEGER NOT NULL DEFAULT 20,       -- v1: max PUBLIC interventions/day (count-based, see header)
  cooldown_s           INTEGER NOT NULL DEFAULT 1800,     -- seconds between PUBLIC interventions
  policy_version       INTEGER NOT NULL DEFAULT 1,
  updated_by           TEXT,                              -- uid of the owner/admin who last changed mode/budget
  updated_at           INTEGER NOT NULL
);

-- ava_group_member_prefs — ONE row per (conv, uid) (I1/I5). A member who never
-- set a preference is NOT muted by default (opt-out model, matching I1's
-- framing: Companion mode itself is opt-in at the group level via
-- ava_group_state.mode; per-member mute is the individual override).
-- `muted_capabilities` is a JSON array of ava_capabilities.ts capability ids
-- the member has silenced individually (I5: "suppression after a member
-- dismisses or mutes the same capability") without muting Ava entirely.
CREATE TABLE IF NOT EXISTS ava_group_member_prefs (
  conv                TEXT    NOT NULL,
  uid                  TEXT    NOT NULL,
  muted                INTEGER NOT NULL DEFAULT 0,        -- 0/1 — mutes ALL unsolicited Ava output (private + public) for this member in this conv
  muted_capabilities   TEXT,                               -- JSON string[] of per-capability mutes, e.g. '["humor","auto_sticker"]'
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (conv, uid)
);

-- Ops read path: "who has Ava muted in this group" (disclosure/report tooling).
CREATE INDEX IF NOT EXISTS idx_ava_group_member_prefs_conv ON ava_group_member_prefs(conv);

-- Additive columns on the EXISTING ava_interventions ledger
-- (worker/migrations/ava_interventions.sql, [AVA-ODL-POST-1]) — SQLite/D1 has
-- no "ADD COLUMN IF NOT EXISTS"; each ALTER errors if the column already
-- exists, so this file is safe to run exactly once (same convention as
-- worker/migrations/receptionist_v2.sql).
--
-- payer (I4): 'group' for a public group intervention (billed against the
-- group's own budget_tokens_daily cap above, NEVER an arbitrary member) or
-- 'recipient' for a private group nudge (tied to that member's own
-- not-muted opt-in — never billed to anyone else). NULL on every row written
-- before this migration (the existing 1:1 private-lane path) — legacy rows
-- are left alone; the 1:1 posting code in ava_odl.ts is UNCHANGED by this
-- issue and does not set this column.
ALTER TABLE ava_interventions ADD COLUMN payer TEXT;

-- The group cooldown/budget read (ava_group_policy.ts
-- checkGroupCooldownAndBudget) filters on (conv_hash, payer, status,
-- updated_at) for the 'group' payer — this index keeps that lookup and the
-- daily COUNT(*) index-only.
CREATE INDEX IF NOT EXISTS idx_ava_interv_conv_payer_updated ON ava_interventions(conv_hash, payer, updated_at);
