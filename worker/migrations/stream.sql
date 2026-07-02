-- AvaLive stream lifecycle (DB_META). Populated by the Cloudflare Stream webhook
-- (/webhooks/stream). The signed NIP-53 kind:30311 event remains the source of
-- truth for clients; this table is for server-side discovery, status, and cron
-- cleanup of stale/abandoned live inputs.
CREATE TABLE IF NOT EXISTS live_streams (
  uid         TEXT PRIMARY KEY,   -- Cloudflare Stream video/live-input uid
  live_input  TEXT,               -- live input id
  broadcaster_uid TEXT,          -- broadcaster (Clerk uid, from webhook meta)
  state       TEXT NOT NULL,      -- 'connected'|'disconnected'|'ready'|'unknown'
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_streams_state ON live_streams(state);
CREATE INDEX IF NOT EXISTS idx_live_streams_broadcaster ON live_streams(broadcaster_uid);
