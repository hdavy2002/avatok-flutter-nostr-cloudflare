-- Re-key batch C — wallet + payout identity npub -> uid (Clerk user id).
-- Target DB: avatok-wallet (binding DB_WALLET). Clean reinstall, run once.
-- Only the bare `npub` PK/owner columns are renamed; *_npub counterparty columns
-- keep their names but now hold uid values (cosmetic legacy, functionally re-keyed).
-- Apply: wrangler d1 execute avatok-wallet --remote --file=migrations/cfnative_c.sql

ALTER TABLE wallet_balances RENAME COLUMN npub TO uid;
ALTER TABLE wallet_transactions RENAME COLUMN npub TO uid;
ALTER TABLE topup_records RENAME COLUMN npub TO uid;
ALTER TABLE earning_holds RENAME COLUMN npub TO uid;
ALTER TABLE payout_accounts RENAME COLUMN npub TO uid;
ALTER TABLE payout_requests RENAME COLUMN npub TO uid;
