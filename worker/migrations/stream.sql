-- AvaLive stream lifecycle (DB_META). Populated by the Cloudflare Stream webhook
-- (/webhooks/stream). The signed NIP-53 kind:30311 event remains the source of
-- truth for clients; this table is for server-side discovery, status, and cron
-- cleanup of stale/abandoned live inputs.
CREATE TABLE IF NOT EXISTS live_streams (
  uid         TEXT PRIMARY KEY,   -- Cloudflare Stream video/live-input uid
  live_input  TEXT,               -- live input id
  npub        TEXT,               -- broadcaster (from webhook meta, if provided)
  state       TEXT NOT NULL,      -- 'connected'|'disconnected'|'ready'|'unknown'
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_streams_state ON live_streams(state);
CREATE INDEX IF NOT EXISTS idx_live_streams_npub ON live_streams(npub);
