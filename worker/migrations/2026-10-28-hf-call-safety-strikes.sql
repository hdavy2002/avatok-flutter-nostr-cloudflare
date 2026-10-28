-- [HF-CALL-SAFETY-BE] A strike is tied to ONE call and ONE person; active for hfStrikeExpiryDays. DB_META.
CREATE TABLE IF NOT EXISTS hf_strikes (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  role TEXT NOT NULL,                         -- fan|influencer
  call_id TEXT NOT NULL,
  review_id TEXT,
  reason TEXT NOT NULL,                       -- selling|outside_payment|contact_sharing|abuse|sexual|danger
  quote TEXT,                                 -- the person's OWN flagged words only
  auto INTEGER NOT NULL DEFAULT 0,
  by_uid TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_why TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hf_strikes_call_uid ON hf_strikes(call_id, uid);
CREATE INDEX IF NOT EXISTS idx_hf_strikes_uid ON hf_strikes(uid, expires_at);
