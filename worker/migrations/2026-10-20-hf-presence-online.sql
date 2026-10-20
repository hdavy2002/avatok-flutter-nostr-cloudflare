-- [HF-BOOK-APPROVE-BE] ONE-TIME DATA CHANGE at go-live (owner 2026-10-20: every influencer, existing and new, starts Online).
-- Apply once: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-20-hf-presence-online.sql
-- New live hosts start Online from the code path that publishes them; this file only fixes the ones already live.
UPDATE hf_hosts SET presence='online', presence_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE status='live' AND presence='offline';
