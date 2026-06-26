-- Free-tier AI Search quota (Specs/PROPOSAL-AI-SEARCH-SHARDING.md). Target: DB_META.
-- Track bytes per indexed item so FREE users can be capped on total ingested
-- volume (freeQuota: default 100 items / 25 MB). Premium is uncapped.
ALTER TABLE ava_search_items ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
