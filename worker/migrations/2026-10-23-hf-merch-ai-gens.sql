-- [HF-MERCH-STUDIO-2] One row per "Create with AI" merch picture (charge, result, refund state). CREATE only (D1 rule 6). Idempotent.
-- status: charging | generating | done | failed | refunded. UNIQUE(uid, request_key) makes a repeated request return the first result.
CREATE TABLE IF NOT EXISTS hf_merch_ai_gens (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  request_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'charging',
  charge_paise INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  style TEXT,
  ref_art_ids_json TEXT NOT NULL DEFAULT '[]',
  base_art_id TEXT,
  result_art_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (uid, request_key)
);
CREATE INDEX IF NOT EXISTS idx_hf_merch_ai_gens_uid ON hf_merch_ai_gens(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_hf_merch_ai_gens_created ON hf_merch_ai_gens(created_at);
