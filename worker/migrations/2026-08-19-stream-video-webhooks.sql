-- GetStream Video pilot webhook deduplication.
-- X-Webhook-Id is stable across retries and is the sole idempotency key.
CREATE TABLE IF NOT EXISTS stream_video_webhooks (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stream_video_webhooks_received
  ON stream_video_webhooks(received_at);

-- Server-authoritative provider choice for each new Stream pilot call.
-- INSERT OR IGNORE in the Worker makes the first decision win under retries or
-- concurrent requests; active calls never migrate when the rollout flag flips.
CREATE TABLE IF NOT EXISTS stream_video_provider_decisions (
  call_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'stream')),
  caller_uid TEXT NOT NULL,
  callee_uid TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('one_to_one', 'group')),
  chosen_at INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  percent INTEGER NOT NULL
);
