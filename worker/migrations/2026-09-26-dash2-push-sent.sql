-- [DASH2-PUSH 2026-09-26] Web Push dedup for Saa Thum Dashboard 2. DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- One row per (listing_id, uid, kind): kind = 't15' | 'live' | 'refund'.
-- For kind='refund' the listing_id column holds the PAYMENT id (one refund push per payment).
-- lib/web_push.ts claims the row (INSERT OR IGNORE) BEFORE sending: at-most-once delivery.
CREATE TABLE IF NOT EXISTS push_sent (
  listing_id TEXT NOT NULL,
  uid        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (listing_id, uid, kind)
);
