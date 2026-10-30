-- [HF-DESK-CW-1] Sign-in sessions for the Chatwoot-based agent desk (routes/hf_desk_cw.ts). Only a sha256 of the token is stored.
CREATE TABLE IF NOT EXISTS support_desk_sessions (
  token_hash TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_desk_sessions_exp ON support_desk_sessions(expires_at);
