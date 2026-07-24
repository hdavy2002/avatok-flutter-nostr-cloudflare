-- [MSG-FANOUT-DURABLE-1] (Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md §J2/§J6).
-- D1 / avatok-meta (DB_META — bound in BOTH the avatok-api Worker and the
-- avatok-consumers Worker, so the consumer can write directly).
--
-- Durable per-recipient accounting for large-group ("fanout") message delivery.
-- Before this table, a queued group fan-out that partially failed was simply
-- ACKed by the queue consumer once the loop finished — a group could show
-- "sent" while some members permanently never received the message, with no
-- record anywhere that it happened. Every (fanout_id, recipient) pair now ends
-- in a terminal, operator-visible status.
--
-- fanout_id  = hash(conv_id, message client id, sender uid) — stable across
--              queue retries and across the producer's chunking (multiple
--              Q_PUSH messages for one large group share the same fanout_id,
--              one row per recipient).
-- status     = 'delivered' (InboxDO append succeeded) | 'retryable'
--              (transient failure, re-enqueued under the same fanout_id with
--              attempt+1) | 'dead_letter' (permanent failure, or ran out of
--              attempts — worker/src/routes/messaging.ts's FANOUT_MAX_ATTEMPTS
--              equivalent lives in consumers/src/fcm.ts as FANOUT_MAX_ATTEMPTS).
-- attempt    = which delivery attempt produced the CURRENT status (upserted —
--              only the latest attempt's outcome is kept per recipient).
--
-- Additive only: brand-new table, no change to any existing schema.
CREATE TABLE IF NOT EXISTS fanout_deliveries (
  fanout_id     TEXT NOT NULL,
  recipient_uid TEXT NOT NULL,
  status        TEXT NOT NULL,             -- delivered | retryable | dead_letter
  attempt       INTEGER NOT NULL DEFAULT 1,
  error         TEXT,                      -- best-effort short error tag (e.g. http_503), never PII
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (fanout_id, recipient_uid)
);
-- Operator lookup: "show me every recipient still stuck" / "show me every dead
-- letter" without a full-table scan.
CREATE INDEX IF NOT EXISTS idx_fanout_deliveries_status ON fanout_deliveries (status, updated_at);
