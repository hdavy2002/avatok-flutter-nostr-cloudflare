-- [HF-CALL-SAFETY-BE] One appeal per strike (UNIQUE strike_id). DB_META.
CREATE TABLE IF NOT EXISTS hf_appeals (
  id TEXT PRIMARY KEY,
  strike_id TEXT NOT NULL UNIQUE,
  uid TEXT NOT NULL,
  message TEXT,
  via TEXT NOT NULL DEFAULT 'app',            -- app|whatsapp
  status TEXT NOT NULL DEFAULT 'open',        -- open|accepted|rejected
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_hf_appeals_open ON hf_appeals(status, created_at);
