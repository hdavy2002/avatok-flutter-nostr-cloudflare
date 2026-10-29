-- [HF-SUPPORT-1] Custom headers on outgoing mail (Message-ID / In-Reply-To / References / Auto-Submitted) so support replies thread.
-- ADD COLUMN is not idempotent in D1: apply with scripts/d1_apply_alters.py (reads PRAGMA table_info first).
-- Backward compatible: enqueueEmail only writes this column when a message carries headers, and the email consumer reads it
-- with a fallback query, so deploy order between this migration and the worker/consumers does not matter.
ALTER TABLE email_outbox ADD COLUMN headers_json TEXT;   -- {"Message-ID":"<...>","In-Reply-To":"<...>"} or NULL
