-- [HF-DASH-FRAANDS-1] Saved ("hearted") hosts. One row per (signed-in user, host). Deleted with either account.
CREATE TABLE IF NOT EXISTS hf_favourites (uid TEXT NOT NULL, host_uid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (uid, host_uid));
CREATE INDEX IF NOT EXISTS idx_hf_favourites_host ON hf_favourites(host_uid, created_at);
