-- [HF-WIRE-13] ALTERs only (D1 migration trap #6: scripts/d1_apply_alters.py applies ALTERs). Run once; a re-run fails harmlessly.
-- Which money rule shaped the charge of a finished call (e.g. 'first_minute_drop'); NULL = ordinary.
ALTER TABLE hf_calls ADD COLUMN money_rule TEXT;
-- Part of a payout request paid out of the person's own wallet (top-up money), in paise. The rest comes from influencer earnings.
ALTER TABLE hf_payout_requests ADD COLUMN lots_paise INTEGER NOT NULL DEFAULT 0;
