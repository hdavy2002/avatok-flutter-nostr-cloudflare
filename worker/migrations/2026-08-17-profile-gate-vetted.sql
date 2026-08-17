-- [PROFILE-HARD-GATE-1] 2026-08-17 — persisted profile approval.
--
-- Owner decision (2026-08-17): a user whose profile has NOT passed the checks
-- loses the whole app except the profile editor, until they fix it. Second
-- owner decision, and the reason this column exists at all: during an AI
-- moderation OUTAGE, ALREADY-APPROVED USERS MUST KEEP WORKING — only new or
-- changed profiles are held.
--
-- That rule is impossible if the gate re-runs the classifier on every launch:
-- an OpenRouter/Gemini outage would then lock out every user of the app at
-- once, turning a third-party hiccup into a total outage for ~1M people. So
-- approval is a FACT WE STORE, not a verdict we recompute. profileUpsert
-- stamps profile_vetted_at when a profile passes completeness + name
-- plausibility + content moderation; the gate simply reads the column.
--
-- profile_vetted_reason records WHICH path granted approval, so a future audit
-- can tell a genuinely-classified pass from a grandfathered row.
ALTER TABLE users ADD COLUMN profile_vetted_at INTEGER;
ALTER TABLE users ADD COLUMN profile_vetted_reason TEXT;

-- GRANDFATHER EXISTING COMPLETE PROFILES.
--
-- Without this, shipping the gate locks out EVERY existing user on first
-- launch: nobody has the column set, so everyone fails the gate at once and
-- lands in the profile editor — including accounts that already passed the
-- same checks when they saved. That is not a hypothetical; profileCompletionGate
-- has been ON in production, so these rows were vetted at save time under the
-- exact rules the gate enforces.
--
-- Scope is deliberately narrow: only rows that satisfy the SAME completeness
-- contract profileUpsert enforces (photo, first, last, birth year, gender,
-- About — phone is the only optional field). An incomplete row is NOT
-- grandfathered and will be asked to finish, which is the intended behaviour.
UPDATE users
   SET profile_vetted_at = COALESCE(updated_at, created_at, 0),
       profile_vetted_reason = 'grandfathered_2026_08_17'
 WHERE profile_vetted_at IS NULL
   AND COALESCE(TRIM(avatar_url), '') <> ''
   AND COALESCE(TRIM(first_name), '') <> ''
   AND COALESCE(TRIM(last_name),  '') <> ''
   AND COALESCE(TRIM(bio),        '') <> ''
   AND COALESCE(TRIM(gender),     '') <> ''
   AND birth_year IS NOT NULL;

-- The gate reads this per request on launch; keep it cheap.
CREATE INDEX IF NOT EXISTS idx_users_profile_vetted_at ON users (profile_vetted_at);
