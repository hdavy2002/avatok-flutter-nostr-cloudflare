-- [CALL-TRANSLATE-1] Separate pay-as-you-go state; no consult/live entitlement reuse.
CREATE TABLE IF NOT EXISTS translation_call_sessions (
  id TEXT PRIMARY KEY,
  payer_uid TEXT NOT NULL,
  call_ref TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_lease TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','activating','active','funds-stopped','provider-stopped','stopped')),
  started_at INTEGER,
  last_billed_minute INTEGER NOT NULL DEFAULT 0,
  billed_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translation_call_payer ON translation_call_sessions(payer_uid, status);
CREATE INDEX IF NOT EXISTS idx_translation_call_ref ON translation_call_sessions(call_ref, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_call_one_live
  ON translation_call_sessions(payer_uid, call_ref)
  WHERE status IN ('pending','activating','active');
