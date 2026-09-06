-- [REVIEW-MOD-1] Reviews are moderated before they are published.
-- DB: avatok-meta (DB_META). Base table: worker/migrations/listings.sql:53-64,
-- extended by 2026-09-02-reviews-trust.sql.
--
-- WHY — until now a review written by an attendee went straight onto the public
-- listing page and straight into `listings.rating_avg`. The owner's decision
-- (2026-09-06) is that every review goes to an admin first, and only an approved
-- one is shown or counted. That is one new column plus the moderator's trail.
--
-- GRANDFATHERING — `status` DEFAULTs to 'approved' ON PURPOSE. Every review that
-- already exists was written under the old rules, was already visible to the
-- public, and already counted towards its listing's average. Defaulting to
-- 'pending' would silently un-publish all of them and drop every rating to zero.
-- New rows are written with an EXPLICIT 'pending' by createReview() — the column
-- default is a backfill rule, not the insert rule, and the two deliberately
-- disagree. Do not "tidy" the default to 'pending'.
--
-- Values: 'pending' | 'approved' | 'rejected'. No CHECK constraint — D1/SQLite
-- cannot add one via ALTER, and the only writers are two server routes.
--
-- IDEMPOTENCY — no `ADD COLUMN IF NOT EXISTS` in SQLite; re-running errors on the
-- first column, which is the guarded runner's resume signal. Every column is
-- either NOT NULL with a DEFAULT or nullable, so no existing row is orphaned.
--
-- APPLY (ALTER-only file — the guarded runner handles all four lines):
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-06-review-moderation.sql --binding DB_META --dry-run
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-06-review-moderation.sql --binding DB_META
--   ALLOW_PROD=1 python3 scripts/d1_apply_alters.py worker/migrations/2026-09-06-review-moderation.sql --binding DB_META
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, per environment.

ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'; -- see GRANDFATHERING above: new rows are inserted 'pending' explicitly
ALTER TABLE reviews ADD COLUMN moderated_by TEXT;                       -- admin uid that approved/rejected
ALTER TABLE reviews ADD COLUMN moderated_at INTEGER;
ALTER TABLE reviews ADD COLUMN moderation_reason TEXT;                  -- shown to the author on a rejection
