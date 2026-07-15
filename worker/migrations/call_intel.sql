-- [AVADIAL-CALL-INTEL-1] Operational store for call intelligence (owner decision
-- 2026-07-15). This is the ONLY place a raw caller number is persisted server-side.
--
-- WHY RAW LIVES HERE AND NOWHERE ELSE: the product genuinely needs the real number
-- to return a call, show the incoming number, resolve a local contact name, run
-- blocklists, and look the caller up in our own data. Analytics does NOT need it —
-- PostHog only ever receives `phone_id` = HMAC-SHA256(server_secret, E.164), which
-- is stable enough for repeat-caller matching, report counts and spread graphs while
-- being useless to an attacker without the key. See routes/telemetry_calls.ts.
--
-- `call_uuid` is the PK because the device buffers events on disk and retries a
-- failed upload (at-least-once delivery), so the same call legitimately arrives more
-- than once and must not double-count. It is a real UUID minted natively per call —
-- deliberately NOT the old System.identityHashCode(call) id, which is a memory
-- address hash: it can collide and means nothing once the process dies.
--
-- NOTE: `contact_name` is deliberately absent. It is a third party's PII, captured
-- from someone else's device, about a person who never consented and cannot opt out
-- — the exact practice Truecaller has been fined for under GDPR. `contact_exists`
-- carries the signal the model needs. Do not add the name column without a
-- user-facing disclosure and a deliberate decision to accept that obligation.

CREATE TABLE IF NOT EXISTS call_intel (
  call_uuid         TEXT PRIMARY KEY,
  uid               TEXT NOT NULL,
  number_e164       TEXT,
  phone_id          TEXT,           -- HMAC-SHA256(secret, E.164); the analytics key
  direction         TEXT,           -- incoming | outgoing | unknown
  final_state       TEXT,           -- answered | missed | rejected | blocked | busy | failed
  ring_duration_ms  INTEGER,
  talk_duration_ms  INTEGER,
  total_duration_ms INTEGER,
  answer_delay_ms   INTEGER,        -- Answer tap → Telecom STATE_ACTIVE
  contact_exists    INTEGER DEFAULT 0,
  spam_score        INTEGER,
  spam_bucket       TEXT,           -- red | reported | unknown
  carrier           TEXT,
  country_code      TEXT,
  network_type      TEXT,           -- 5g | 4g | 3g | 2g | other
  started_at        INTEGER,
  ended_at          INTEGER,
  created_at        INTEGER NOT NULL
);

-- The reputation lookup: "everything we know about this number". phone_id rather
-- than number_e164 so the hot path never needs the raw column.
CREATE INDEX IF NOT EXISTS idx_call_intel_phone ON call_intel (phone_id, started_at DESC);

-- Per-user history ("times called", "last call") for the caller-details screen.
CREATE INDEX IF NOT EXISTS idx_call_intel_uid ON call_intel (uid, started_at DESC);

-- Spam-model training slice: reported/blocked calls across the whole community.
CREATE INDEX IF NOT EXISTS idx_call_intel_bucket ON call_intel (spam_bucket, started_at DESC);
