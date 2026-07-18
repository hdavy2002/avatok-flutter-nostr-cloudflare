-- [AVA-MKT-VERTICALS-1] marketplace_verticals + listing_category_versions.
--
-- GENUINELY NEW SCHEMA. Two tables that have never existed on any database.
-- Phase 1 of Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md (§2.0, §2.4).
-- DB: avatok-meta (DB_META) — same database as migrations/listings.sql, which
-- this file extends. Apply listings.sql first.
--
-- WHY — "vertical = the same data idea, one level up" (plan §0.4, §2.0).
-- Commerce and Connect are TWO VERTICALS ON ONE ENGINE, not two codebases. A
-- vertical owns its menu, category set, gate policy, moderation policy id, min
-- age and templates — and owns them as ROWS, the same way a category owns its
-- field schema. The alternative the owner brief asked for ("a replica of the
-- current marketplace") is two engines that agree on day one and disagree by
-- month three; AvaOLX (plan §2.0b) is already that story and we are not adding
-- a fourth. `vertical` is a filter on every query, defaulting to 'commerce', so
-- nothing that exists today changes behaviour.
--
-- ---------------------------------------------------------------------------
-- CONNECT IS SEEDED AS A VERTICAL BUT HAS **NO CATEGORIES**. DELIBERATE.
--
-- Plan §0.1 (owner, Rev 7): "Connect explicitly unscheduled. Nothing
-- Connect-specific gets built." Plan §2.1b: "Do not seed until §2.6 clears — a
-- category row is what makes a compose flow reachable, so seeding these IS
-- shipping the vertical."
--
-- That is the whole reason this row is safe to write today. The vertical row is
-- inert: it is a policy record with no reachable surface, because a compose flow
-- is reached through a CATEGORY, and Connect has none. `connectEnabled` does not
-- exist in config.ts DEFAULTS either, so `enabled_flag` names a switch that is
-- itself unbuilt — belt and braces.
--
-- Seeding the row now (and not the categories) buys the one thing worth having:
-- `vertical` exists as a column from the start, so every query written from here
-- on is vertical-scoped by construction rather than retrofitted later against
-- live data. Adding Connect's categories is then an INSERT — but ONLY after
-- plan §2.6 clears, which is not an engineering decision: age assurance
-- (§2.6.2 — the app floors age at 13 and treats unknown age as ADULT), CSAM
-- detection (§2.6.3 — deferred; a hard stop for any photo-upload dating
-- surface), the policy carve-out (M-D12), and the Guardian/Play question
-- (M-D16). Do not seed a Connect category to "test the plumbing."
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY — this file is NATIVELY safe to re-run, unlike its ALTER siblings.
--
-- Every statement is CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
-- INSERT OR IGNORE. There is no ALTER here, so there is no
-- "duplicate column name" failure mode and NOTHING to guard:
--   * FRESH / STAGING / PROD (absent)  -> creates + seeds. Correct.
--   * RE-RUN (present)                 -> every statement is a no-op. Correct.
--   * PARTIAL (table present, seed missing, or vice versa) -> converges. Correct.
--
-- INSERT OR IGNORE (not INSERT OR REPLACE) is load-bearing: these rows are
-- ADMIN-EDITABLE (plan §2 "category = data, not code"). REPLACE would silently
-- revert an operator's gate_policy or min_age edit on the next re-run — i.e. a
-- migration re-run would quietly reopen a gate. IGNORE means the seed is a
-- first-write default and prod stays the source of truth after that.
--
--   RUN IT RAW — this file is CREATE/INSERT, so it does NOT go through
--   scripts/d1_apply_alters.py (that runner parses ALTERs only and exits with
--   "no ALTER TABLE ... ADD COLUMN statements" on this file, by design):
--     scripts/cf.sh worker d1 execute DB_META --remote \
--       --file=migrations/2026-07-18-marketplace-verticals.sql
--
-- Goes through scripts/cf.sh, so staging is the default and prod is fail-closed
-- behind ALLOW_PROD=1. Pass the BINDING (DB_META), not a database name — prod is
-- `avatok-meta`, staging is `avatok-meta-staging`; the binding resolves per --env.
--
-- Apply order (whole Phase 1 set):
--   1. listings.sql                              (base tables — already applied)
--   2. 2026-07-18-listings-drift-columns.sql     (via d1_apply_alters.py)
--   3. 2026-07-18-listings-content-version.sql   (via d1_apply_alters.py)
--   4. THIS FILE                                 (raw --file)
--   5. 2026-07-18-listings-taxonomy-columns.sql  (via d1_apply_alters.py)
--   6. 2026-07-18-listings-taxonomy-seed.sql     (raw --file — needs 4 AND 5)
-- ---------------------------------------------------------------------------

-- Plan §2.0. A vertical is a policy record: which identity gates apply, which
-- moderation policy classifies its text, what the minimum age is, and which
-- kill switch turns it off.
CREATE TABLE IF NOT EXISTS marketplace_verticals (
  id           TEXT PRIMARY KEY,      -- 'commerce' | 'connect'
  label        TEXT NOT NULL,
  gate_policy  TEXT NOT NULL,         -- JSON: which identity gates apply (§2.6)
  policy_id    TEXT NOT NULL,         -- moderation policy id — NOT one global policy
  min_age      INTEGER,               -- NULL = no age gate; 18 for connect
  enabled_flag TEXT NOT NULL          -- 'marketplaceEnabled' | 'connectEnabled'
);

-- gate_policy JSON keys, and why each is what it is:
--   liveness      — Didit liveness. TRUE for both. `phoneGate()` (listings.ts:287)
--                   is a MISNOMER: it already enforces liveness, not phone.
--   phone         — FALSE for both, permanently. M-D1 (owner, 2026-07-17):
--                   "liveness only. No phone, anywhere." Not a gate and not a
--                   contact field — the AvaTOK number is the contact rail. Phone
--                   OTP was removed app-wide 2026-07-10 (/api/id/phone/confirm is
--                   LEGACY_GONE → 410, index.ts:43). This key exists to record the
--                   decision, not to offer a choice.
--   age_assurance — real age assurance, not self-declared birth_year.
--   unknown_age   — 'allow' | 'deny'. Commerce keeps today's behaviour ('allow').
--                   Connect is 'deny' — plan §2.6.2 requires INVERTING the current
--                   default, which treats null birth_year as ADULT in three places
--                   (call_billing_routes.ts:61-72, ava_guardian.ts:183,
--                   agent_profiles.ts:226-231). Recorded here; NOT yet enforced —
--                   enforcement is Connect work and Connect is unscheduled.
INSERT OR IGNORE INTO marketplace_verticals (id, label, gate_policy, policy_id, min_age, enabled_flag) VALUES
  ('commerce', 'Marketplace',
   '{"liveness":true,"phone":false,"age_assurance":false,"unknown_age":"allow"}',
   'default', NULL, 'marketplaceEnabled'),
  -- DESIGN-ONLY ROW. Categories deliberately NOT seeded — see the header block.
  -- policy_id 'connect' is a policy that DOES NOT EXIST YET. Today
  -- lib/moderation.ts:56-64 422s dating-shaped listings from our own classifier
  -- ("offering companionship/dates" is a literal disallow exemplar). After M-D15
  -- (no adult industry) that policy is a narrow carve-out, not a permissive
  -- rewrite — but it is still a legal-review job, and it must be scoped BY
  -- policy_id, never by loosening the shared policy, or it leaks into commerce.
  ('connect',  'Connect',
   '{"liveness":true,"phone":false,"age_assurance":true,"unknown_age":"deny"}',
   'connect', 18, 'connectEnabled');

-- Plan §2.4. "Category = data, not code" has a cost that must be paid explicitly:
-- editing a category's field_schema or agent_playbook silently changes the
-- behaviour of every listing already created under it. A seller publishes a flat
-- in July; in September someone tightens the property playbook; that seller's
-- agent now negotiates differently on their behalf, in a conversation they never
-- saw, under rules they never agreed to — and it is unauditable, because nothing
-- recorded which version was in force.
--
-- So: VERSIONS ARE ROWS, NEVER AN IN-PLACE UPDATE THAT DESTROYS HISTORY. A
-- category edit INSERTs a new (category, version) row and bumps
-- listing_categories.cat_version; the old row stays readable forever, because
-- every listing pins the versions it was born with (see the taxonomy-columns
-- migration) and buildAgentContext loads the playbook at
-- listings.playbook_version — NOT "latest".
--
-- No FK to listing_categories(id) on purpose: this table must outlive the
-- category row it describes. A deactivated or renamed category still has live
-- listings pinned to its old versions, and ON DELETE would take the audit trail
-- with it — which is the exact failure this table exists to prevent.
CREATE TABLE IF NOT EXISTS listing_category_versions (
  category        TEXT NOT NULL,      -- listing_categories.id (no FK — see above)
  version         INTEGER NOT NULL,   -- monotonic per category; 1 = as seeded
  field_schema    TEXT,               -- JSON snapshot (§2.2 shape)
  agent_playbook  TEXT,               -- JSON snapshot
  detail_template TEXT,               -- 'sell'|'rent'|'book'|'lead'|'profile'
  created_at      INTEGER NOT NULL,   -- epoch ms
  PRIMARY KEY (category, version)
);
CREATE INDEX IF NOT EXISTS idx_lcv_category ON listing_category_versions(category, version);
