-- [AVA-IDGATE-1] Grandfather existing users. Spec §11.1.
--
-- RUN THIS SEPARATELY, AFTER 2026-07-10-identity-gating.sql, AND ONLY ONCE.
-- Owner decision 2026-07-10: existing users must not be bothered by the new gate.
--
-- TWO THINGS THIS DELIBERATELY DOES NOT DO:
--
-- 1. It does NOT record grandfathered users as having passed a Didit check.
--    liveness_source='grandfathered' says, truthfully, that no check ever ran.
--    Setting liveness_passed_at without it would make the database assert a
--    liveness check happened — and that record is what gets handed to law
--    enforcement. A false record there undermines every claim built on the field.
--
-- 2. It does NOT set a flat cutover timestamp. A flat value expires the ENTIRE
--    user base on the same day, 90 days later: a million liveness checks in 24
--    hours, a Didit invoice to match, and a support queue. Each row is backdated a
--    random 0-60 days so expiry spreads across days 30-90. Nobody is gated for at
--    least 30 days; renewals arrive as a curve, not a wall.
--
-- CONSEQUENCE, STATED PLAINLY: for the first 30-90 days the deterrent applies to
-- NEW users only. Every existing account — including any bad actor already on the
-- platform — is trusted without ever having faced a camera. Accepted cost of not
-- disrupting the base. It resolves itself as the window expires.

-- Step 1 — users who REALLY passed a liveness check keep their real timestamp.
-- identity_proofs is the append-only record written by applyDiditPass().
UPDATE clerk_account_link
   SET liveness_passed_at = (
         SELECT ip.verified_at FROM identity_proofs ip
          WHERE ip.uid = clerk_account_link.uid
            AND ip.proof = 'liveness' AND ip.status = 'verified'
       ),
       liveness_source = 'didit',
       liveness_ref    = (
         SELECT ip.evidence_ref FROM identity_proofs ip
          WHERE ip.uid = clerk_account_link.uid
            AND ip.proof = 'liveness' AND ip.status = 'verified'
       ),
       tier = 'verified'
 WHERE liveness_passed_at IS NULL
   AND EXISTS (
         SELECT 1 FROM identity_proofs ip
          WHERE ip.uid = clerk_account_link.uid
            AND ip.proof = 'liveness' AND ip.status = 'verified'
       );

-- Step 2 — everyone else is grandfathered, backdated 0-60 days.
-- 5184000000 ms = 60 days. ABS(RANDOM()) % that ⇒ uniform spread.
-- Expiry (passed_at + 90d) therefore lands between day 30 and day 90 from now.
--
-- :cutover — pass the migration run time in ms. Do NOT use a literal; the value
-- must match what the backfill telemetry reports.
UPDATE clerk_account_link
   SET liveness_passed_at = :cutover - (ABS(RANDOM()) % 5184000000),
       liveness_source    = 'grandfathered',
       tier               = 'verified'
 WHERE liveness_passed_at IS NULL;

-- Step 3 — sanity. Both should be 0. If not, STOP and investigate before enabling
-- identityGatingEnabled: a NULL here means that user gets gated on their next
-- public action, which is exactly what this migration exists to prevent.
--   SELECT COUNT(*) FROM clerk_account_link WHERE liveness_passed_at IS NULL;
--   SELECT COUNT(*) FROM clerk_account_link WHERE liveness_source IS NULL;
--
-- And this tells you the true verified fraction of the user base — a question you
-- will be asked, and which is unanswerable without liveness_source:
--   SELECT liveness_source, COUNT(*) FROM clerk_account_link GROUP BY 1;
