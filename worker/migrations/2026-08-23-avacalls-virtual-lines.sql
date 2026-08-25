-- AVACALLS-003 — canonical multi-line ownership and telephony activity.
-- Additive only: legacy AvaTOK numbers, user_dids, campaigns, and InboxDO remain intact.

CREATE TABLE IF NOT EXISTS virtual_lines (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('did','avatok')),
  canonical_number TEXT NOT NULL,
  display_number TEXT NOT NULL,
  number_hash TEXT NOT NULL,
  provider TEXT,
  provider_number_id TEXT,
  provider_account_ref TEXT,
  country_iso2 TEXT,
  region TEXT,
  label TEXT NOT NULL,
  color_key TEXT NOT NULL DEFAULT 'blue',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','active','past_due','suspended','releasing','released','failed')),
  is_default_outgoing INTEGER NOT NULL DEFAULT 0 CHECK (is_default_outgoing IN (0,1)),
  monthly_tokens_subunits INTEGER NOT NULL DEFAULT 0,
  current_period_start INTEGER,
  next_renewal_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_virtual_lines_active_number ON virtual_lines(canonical_number) WHERE status IN ('provisioning','active','past_due','suspended');
CREATE INDEX IF NOT EXISTS idx_virtual_lines_owner_status ON virtual_lines(owner_uid, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_virtual_lines_owner_default_did ON virtual_lines(owner_uid) WHERE kind='did' AND status='active' AND is_default_outgoing=1;
CREATE INDEX IF NOT EXISTS idx_virtual_lines_number_hash ON virtual_lines(number_hash);

CREATE TABLE IF NOT EXISTS virtual_line_settings (
  line_id TEXT PRIMARY KEY REFERENCES virtual_lines(id),
  policy_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS virtual_line_activity (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  line_id TEXT NOT NULL REFERENCES virtual_lines(id),
  remote_party_key TEXT,
  type TEXT NOT NULL,
  provider TEXT,
  provider_event_id TEXT,
  call_id TEXT,
  message_id TEXT,
  direction TEXT CHECK (direction IN ('inbound','outbound','unknown')),
  started_at INTEGER,
  ended_at INTEGER,
  duration_sec INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_heard INTEGER NOT NULL DEFAULT 0,
  recording_ref TEXT,
  transcript_ref TEXT,
  display_metadata_json TEXT NOT NULL DEFAULT '{}',
  raw_event_ref TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_virtual_line_activity_owner_line ON virtual_line_activity(owner_uid, line_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_virtual_line_activity_unread ON virtual_line_activity(owner_uid, line_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS telephony_webhook_receipts (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'received',
  normalized_resource_id TEXT,
  PRIMARY KEY(provider, provider_event_id)
);
