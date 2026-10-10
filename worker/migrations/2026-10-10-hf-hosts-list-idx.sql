-- [HF-NATIVE-S2] Indexes for GET /api/hf/hosts (CREATE INDEX only; safe to re-run). DB_META.
-- Needs 2026-10-09-hf-hosts.sql, 2026-10-09-hf-presence.sql (ALTER, adds presence) and 2026-10-09-hf-reviews.sql applied first. Apply:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-10-hf-hosts-list-idx.sql
CREATE INDEX IF NOT EXISTS hf_hosts_live_list ON hf_hosts(status, presence, price_per_min);
-- covers the per-host rating aggregate (host_uid, status, stars) without touching the table rows
CREATE INDEX IF NOT EXISTS idx_hf_reviews_host_stars ON hf_reviews(host_uid, status, stars);
