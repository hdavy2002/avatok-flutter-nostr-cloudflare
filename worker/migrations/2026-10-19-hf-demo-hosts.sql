-- [HF-WIRE-4] Marker for demo (starter) influencers, HF-REEL-12. DB_META. CREATE only (no ALTER on hf_hosts).
-- Apply: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-19-hf-demo-hosts.sql
-- A host with a row here is hidden from the feed and the public profile when hfDemoInfluencersVisible=false.
-- Delete the rows (and the hosts / reels) to remove the demo content for good. See scripts/hf_seed_demo_influencers.md.
CREATE TABLE IF NOT EXISTS hf_demo_hosts (
  host_uid TEXT PRIMARY KEY,                      -- hf_hosts.uid of the demo host
  handle TEXT,                                    -- shown as "@handle" (demo hosts have no real channel)
  followers INTEGER NOT NULL DEFAULT 0,           -- shown follower count
  created_at INTEGER NOT NULL
);
