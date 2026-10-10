-- [HF-TOK-MATH-1] hf_calls pricing snapshot + per-second settlement results. DB_META. NOT APPLIED yet (HF-TOK-CALLS-1 adjusted it: rate_paise was already a column).
-- ALTERs only (D1 migration trap #6: scripts/d1_apply_alters.py applies ALTERs). Apply BEFORE flipping hfTokensEnabled.
-- ALTER lines fail harmlessly if re-run once the columns exist; run once, one statement at a time if needed.
-- Snapshot (taken at call start, so a later config change never alters a running call):
-- rate_paise already exists on hf_calls (set at call start), so it is part of the snapshot without a new column.
ALTER TABLE hf_calls ADD COLUMN call_cost_paise_per_min INTEGER;
ALTER TABLE hf_calls ADD COLUMN host_share_bps INTEGER;
ALTER TABLE hf_calls ADD COLUMN tax_mode TEXT;
ALTER TABLE hf_calls ADD COLUMN split_rule_version TEXT;
-- Results (written once at settle):
ALTER TABLE hf_calls ADD COLUMN billable_seconds INTEGER;
ALTER TABLE hf_calls ADD COLUMN consumed_value_paise INTEGER;
ALTER TABLE hf_calls ADD COLUMN call_cost_paise INTEGER;
-- host_earning_paise already exists on hf_calls (the paise the host earned); tokens mode writes it too.
ALTER TABLE hf_calls ADD COLUMN platform_paise INTEGER;
ALTER TABLE hf_calls ADD COLUMN tokens_spent_micro INTEGER;
ALTER TABLE hf_calls ADD COLUMN lots_used TEXT;      -- JSON: [{lotId, micro, valuePaise}]
