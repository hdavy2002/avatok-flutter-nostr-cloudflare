-- [IDX-PRUNE-1] Drop the unused message_index(conv, created_at DESC) index.
-- Paged thread reads (worker/src/routes/archive.ts) query
--   WHERE conv=?1 [AND serial < ?] ORDER BY serial DESC
-- which is fully served by the PRIMARY KEY (conv, serial). serial is
-- chronologically sortable, so created_at ordering is never needed; this index
-- only added write amplification on every archived message. Safe + idempotent
-- (IF EXISTS) — runs whether or not chat_archive.sql already created it.
DROP INDEX IF EXISTS idx_msgidx_conv_created;
