-- Re-key batch C — wallet + payout identity uid -> uid (Clerk user id).
-- Target DB: avatok-wallet (binding DB_WALLET). Clean reinstall, run once.
-- Only the bare `uid` PK/owner columns are renamed; *_npub counterparty columns
-- keep their names but now hold uid values (cosmetic legacy, functionally re-keyed).
-- Apply: wrangler d1 execute avatok-wallet --remote --file=migrations/cfnative_c.sql

ALTER TABLE wallet_balances RENAME COLUMN uid TO uid;
ALTER TABLE wallet_transactions RENAME COLUMN uid TO uid;
ALTER TABLE topup_records RENAME COLUMN uid TO uid;
ALTER TABLE earning_holds RENAME COLUMN uid TO uid;
ALTER TABLE payout_accounts RENAME COLUMN uid TO uid;
ALTER TABLE payout_requests RENAME COLUMN uid TO uid;
