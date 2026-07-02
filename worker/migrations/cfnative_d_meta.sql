-- Re-key batch D (avatok-meta) — agent/notifications/verification/contacts/social
-- identity uid -> uid (Clerk user id). Bare uid PK/owner cols only; *_npub
-- counterparty cols keep names but hold uid values. Clean reinstall, run once.
-- Apply: wrangler d1 execute avatok-meta --remote --file=migrations/cfnative_d_meta.sql

ALTER TABLE agent_personas RENAME COLUMN uid TO uid;
ALTER TABLE agent_conversations RENAME COLUMN uid TO uid;
ALTER TABLE agent_inbox RENAME COLUMN uid TO uid;
ALTER TABLE notifications RENAME COLUMN uid TO uid;
ALTER TABLE verification_status RENAME COLUMN uid TO uid;
ALTER TABLE verification_attempts RENAME COLUMN uid TO uid;
ALTER TABLE deletion_requests RENAME COLUMN uid TO uid;
ALTER TABLE contact_verification RENAME COLUMN uid TO uid;
ALTER TABLE follows RENAME COLUMN uid TO uid;
ALTER TABLE blocks RENAME COLUMN uid TO uid;
ALTER TABLE mutes RENAME COLUMN uid TO uid;
