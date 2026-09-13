-- [AGENT-LIVE-1] AI voice agent listings on GPT-Live-1.
-- CREATEs only — apply with `cf.sh worker d1 execute DB_META --remote --file=…`.
-- Copied verbatim from Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md §1.

CREATE TABLE IF NOT EXISTS agent_live_agents (
  listing_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL,
  persona_kind TEXT NOT NULL DEFAULT 'companion',
  voice TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'auto',
  greeting TEXT, instructions TEXT NOT NULL, backend_instructions TEXT NOT NULL DEFAULT '',
  image_instructions TEXT NOT NULL DEFAULT '',
  live_model TEXT NOT NULL DEFAULT 'gpt-live-1', backend_model TEXT NOT NULL DEFAULT 'gpt-6-astra',
  price_per_min INTEGER NOT NULL, slot_minutes TEXT NOT NULL DEFAULT '5,10,20,30,40,60',
  max_concurrent INTEGER NOT NULL DEFAULT 3,
  image_reading INTEGER NOT NULL DEFAULT 1, memory_enabled INTEGER NOT NULL DEFAULT 1,
  adults_only INTEGER NOT NULL DEFAULT 0,
  vector_store_id TEXT, persona_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_live_kb_files (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, content_sha256 TEXT NOT NULL, r2_key TEXT NOT NULL,
  openai_file_id TEXT, status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded|indexing|indexed|failed|deleted
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_live_kb_agent ON agent_live_kb_files(agent_id, status);
CREATE TABLE IF NOT EXISTS agent_live_bookings (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, buyer_uid TEXT NOT NULL, buyer_email TEXT, buyer_tz TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, minutes INTEGER NOT NULL,
  price_per_min INTEGER NOT NULL, amount INTEGER NOT NULL, beneficiary_uid TEXT NOT NULL,
  persona_version INTEGER NOT NULL, policy_version TEXT NOT NULL DEFAULT 'agent-live-v2',
  order_id TEXT NOT NULL UNIQUE,            -- 'agl_<bookingId>'
  idempotency_key TEXT, request_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|booked|in_progress|completed|cancelled|failed
  money_state TEXT NOT NULL DEFAULT 'none', -- none|hold_pending|held|refund_pending|refunded|release_pending|released|needs_attention
  instant INTEGER NOT NULL DEFAULT 0, is_test INTEGER NOT NULL DEFAULT 0,
  join_token_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  -- [AGENT-LIVE-1 / M2, WS-D] Checkout recovery: `checkout_phase` lets
  -- runAgentLiveSweeps resume a crashed checkout without a browser;
  -- `quote_json`/`persona_snapshot_json` freeze what the buyer was quoted and
  -- what the agent looked like at booking time. Added to the CREATE (this
  -- migration is not applied anywhere yet) rather than as a later ALTER.
  checkout_phase TEXT NOT NULL DEFAULT 'quoted', -- quoted|reserved|hold_pending|held|confirm_pending|booked|aborted
  quote_json TEXT,
  persona_snapshot_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_live_bookings_agent ON agent_live_bookings(agent_id, status, starts_at);
CREATE INDEX IF NOT EXISTS idx_agent_live_bookings_buyer ON agent_live_bookings(buyer_uid, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_live_bookings_idem ON agent_live_bookings(buyer_uid, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_live_sessions (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, buyer_uid TEXT NOT NULL,
  session_generation INTEGER NOT NULL DEFAULT 1, provider_session_id TEXT,
  provider_started_at INTEGER, customer_first_attached_at INTEGER, last_heartbeat_at INTEGER, ended_at INTEGER,
  end_reason TEXT, -- slot_complete|customer_end|disconnect_timeout|provider_error|capacity|platform_error|emergency_stop|no_show
  billed_seconds INTEGER NOT NULL DEFAULT 0, images_count INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  transcript_r2_key TEXT, usage_json TEXT, evidence_json TEXT,
  -- [AGENT-LIVE-1] §11 M8 (WS-E2): the erasure generation this session was
  -- created/last active under. A Forget-me during a live session bumps
  -- `agent_live_user_memory.erasure_generation`; the room compares its own
  -- session's value here to detect staleness and drop old-generation writes.
  erasure_generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- [AGENT-LIVE-1 / M3, WS-D] CHECK constraints on the immutable decision row —
-- the arithmetic can never disagree with itself, and a decision is always
-- either a full refund or a full release, never a mix (D7: "no pro-rata
-- anywhere"). decideAndEnqueue() is the only writer; it never UPDATEs a row.
CREATE TABLE IF NOT EXISTS agent_live_decisions (
  booking_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, -- completed_full|no_show|cancelled_by_customer_early|refunded_platform_failure
  reason TEXT, amount INTEGER NOT NULL, refund_amount INTEGER NOT NULL, release_gross INTEGER NOT NULL,
  fee INTEGER NOT NULL, net INTEGER NOT NULL, beneficiary_uid TEXT NOT NULL, decision_hash TEXT NOT NULL, decided_at INTEGER NOT NULL,
  CHECK (refund_amount >= 0 AND release_gross >= 0),
  CHECK (refund_amount + release_gross = amount),
  CHECK (fee >= 0 AND net >= 0 AND fee + net = release_gross),
  CHECK ((refund_amount = amount AND release_gross = 0) OR (refund_amount = 0 AND release_gross = amount))
);
CREATE TABLE IF NOT EXISTS agent_live_money_jobs (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL, -- refund|release
  state TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|needs_attention
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, lock_token TEXT, lock_until INTEGER,
  last_error TEXT, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_live_money_due ON agent_live_money_jobs(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS agent_live_user_memory (
  agent_id TEXT NOT NULL, buyer_uid TEXT NOT NULL, display_name TEXT,
  summary TEXT NOT NULL DEFAULT '', facts_json TEXT NOT NULL DEFAULT '[]', open_threads_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT, sessions_count INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0, erasure_generation INTEGER NOT NULL DEFAULT 0, memory_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, buyer_uid)
);
CREATE TABLE IF NOT EXISTS agent_live_session_images (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, booking_id TEXT NOT NULL, r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'analyzing', -- analyzing|ready|failed
  analysis TEXT, error TEXT,
  -- [AGENT-LIVE-1] §11 M8 (WS-E2): client idempotency key (so a retried
  -- upload of the same photo returns the prior result instead of consuming
  -- another image slot), the session/erasure generation this image was
  -- accepted under (the room drops a stale `/image-analysis` callback whose
  -- generations no longer match), and the revision of the analysis attempt
  -- (bumped on a retried vision call for the same image).
  client_upload_id TEXT NOT NULL, session_generation INTEGER NOT NULL,
  erasure_generation INTEGER NOT NULL DEFAULT 0, analysis_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(session_id, client_upload_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_live_images_session ON agent_live_session_images(session_id, created_at);
CREATE TABLE IF NOT EXISTS agent_live_tool_calls (
  session_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_hash TEXT NOT NULL,
  result TEXT, state TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL, PRIMARY KEY (session_id, call_id)
);
