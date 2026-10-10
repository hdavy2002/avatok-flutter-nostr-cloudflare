-- [HF-TOK-EXIT-1] Token-aware refunds and account closing. DB_META. ALTERs only (D1 migration trap #6: scripts/d1_apply_alters.py applies ALTERs).
-- Apply BEFORE flipping hfTokensEnabled. ALTER lines fail harmlessly if re-run once the columns exist; run once, one statement at a time if needed.
-- Nothing in the flag-OFF code path reads these columns, so shipping the worker before applying this file is safe.
-- A refund request row with kind='play_refund' is one purchase lot (lot_id) whose unspent tokens are refunded through Google Play.
-- kind NULL / 'wallet' = the old WalletDO refund of unused top-up rupees.
ALTER TABLE hf_refund_requests ADD COLUMN kind TEXT DEFAULT 'wallet';
ALTER TABLE hf_refund_requests ADD COLUMN amount_paise INTEGER;    -- exact amount owed to the buyer for a play_refund (amount_rupees is the rounded figure)
ALTER TABLE hf_refund_requests ADD COLUMN lot_id TEXT;              -- hf_token_lots.id the refund is for
ALTER TABLE hf_refund_requests ADD COLUMN order_id TEXT;            -- Google Play order id of that lot
ALTER TABLE hf_refund_requests ADD COLUMN recorded_paise INTEGER;   -- paise actually refunded (by the Orders API, or recorded by an admin after a partial refund in the Play Console)
-- An account closure may need one play_refund per purchase lot: JSON array of refund request ids. NULL = a closure made without tokens.
ALTER TABLE hf_exit_requests ADD COLUMN refund_ids TEXT;
