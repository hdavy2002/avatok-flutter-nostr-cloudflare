-- [HF-LANE-VERIFY-1 2026-10-09] Hello Fraands protected lanes: who has been let into the women-only / LGBTQ+ lane.
-- Rulebook HF-WOM-2, HF-LGBT-3. A row means "verified and joined"; deleting it leaves the lane.
-- declared_at is set only for the LGBTQ+ lane (private self-declaration). No identity detail is ever stored here.
CREATE TABLE IF NOT EXISTS hf_lane_access (uid TEXT NOT NULL, lane TEXT NOT NULL CHECK (lane IN ('women','lgbtq')), verified_at INTEGER NOT NULL, declared_at INTEGER, PRIMARY KEY (uid, lane));
