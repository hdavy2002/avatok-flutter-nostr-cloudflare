-- [AVA-IDGATE-1] Grandfather existing users. Spec §11.1.
--
-- Apply AFTER 2026-07-10-identity-gating.sql, and ONLY ONCE:
--   scripts/cf.sh worker d1 execute avatok-meta --remote --file=migrations/2026-07-10-identity-gating-backfill.sql
--
-- Owner decision 2026-07-10: existing users must not be bothered by the new gate.
--
-- TWO THINGS THIS DELIBERATELY DOES:
--
-- 1. It records grandfathered users as provider='grandfathered', NOT 'didit'.
--    Writing 'didit' would make the database assert that a liveness check happened.
--    That record is what gets handed to law enforcement. A false record there
--    undermines every claim built on the field, and it is the only way to ever answer
--    "what fraction of our users have actually been verified?"
--
-- 2. It backdates each row by a RANDOM 0-60 days rather than using a flat timestamp.
--    A flat value expires the ENTIRE user base on the same day, 90 days later: a
--    million liveness checks in 24 hours, a Didit invoice to match, and a support
--    queue. Random backdating spreads expiry across days 30-90 — nobody is gated for
--    at least 30 days, and renewals arrive as a curve rather than a wall.
--
-- CONSEQUENCE, STATED PLAINLY: for the first 30-90 days the deterrent applies to NEW
-- users only. Every existing account — including any bad actor already on the platform
-- — is trusted without ever having faced a camera. Accepted cost of not disrupting the
-- base. It resolves itself as the window expires.
--
-- Users who REALLY passed already have an identity_proofs row with provider='didit'
-- and a real verified_at (written by applyDiditPass). We do not touch them: the
-- INSERT below skips any uid that already has a 'liveness' proof, whatever its status.
-- That is intentional — a 'rejected' or 'pending' row means the user engaged with the
-- real check, and silently promoting them to grandfathered would erase that.

-- 5184000000 ms = 60 days. ABS(RANDOM()) % that ⇒ uniform spread, evaluated PER ROW.
-- Expiry (verified_at + 90d) therefore lands between day 30 and day 90 from now.
--
-- `unixepoch()*1000` rather than a bound :cutover parameter: `wrangler d1 execute
-- --file` does not bind named parameters, and a hand-pasted literal is the kind of
-- thing that gets copied into the wrong environment three weeks later.
INSERT INTO identity_proofs (uid, proof, status, provider, evidence_ref, verified_at, updated_at)
SELECT
  u.uid,
  'liveness',
  'verified',
  'grandfathered',
  NULL,
  (unixepoch() * 1000) - (ABS(RANDOM()) % 5184000000),
  (unixepoch() * 1000)
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM identity_proofs p WHERE p.uid = u.uid AND p.proof = 'liveness'
);

-- ---------------------------------------------------------------------------
-- VERIFY BEFORE FLIPPING identityGatingEnabled
-- ---------------------------------------------------------------------------
-- (a) Should be 0. A user with no verified liveness proof gets gated on their next
--     public action — exactly what this migration exists to prevent.
--   SELECT COUNT(*) FROM users u
--    WHERE NOT EXISTS (SELECT 1 FROM identity_proofs p
--                       WHERE p.uid=u.uid AND p.proof='liveness' AND p.status='verified');
--
-- (b) The true verified fraction of the user base — a question you will be asked, and
--     one that is unanswerable without the provider distinction:
--   SELECT provider, COUNT(*) FROM identity_proofs
--    WHERE proof='liveness' AND status='verified' GROUP BY provider;
--
-- (c) Expiry spread — should be a smooth curve across ~60 buckets, not a spike:
--   SELECT ((unixepoch()*1000) - verified_at)/86400000 AS days_ago, COUNT(*)
--     FROM identity_proofs WHERE provider='grandfathered' GROUP BY 1 ORDER BY 1;
