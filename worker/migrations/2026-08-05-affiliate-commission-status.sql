-- [AFF-COMM-LIFECYCLE-1] Affiliate commission qualification lifecycle.
-- DB: avatok-wallet (DB_WALLET). Spec: Specs/proposals/PROPOSAL-AFFILIATE-UPI-2026-08-05.md §6.1.
--
-- WHY: payAffiliateOnTopup() used to call walletOp op:"earn" IMMEDIATELY, which
-- starts the 7-day WalletDO hold at top-up time. A D1 `qualify_at` on top of that
-- would have been decorative — the hold matures at day 7 and the coins become
-- spendable/withdrawable while D1 still says 'pending'. A D1 status cannot gate a
-- withdrawal; the wallet decides. The credit is therefore DELAYED until
-- qualification: the top-up writes a 'pending' D1 row with NO wallet operation,
-- and runAffiliateQualification() (worker/src/routes/affiliate.ts) promotes it
-- with walletOp 'earn' once qualify_at passes and every re-check succeeds.
--
-- Status values widen: pending | held | available | held_review | reversed.
-- ('settled' is the legacy name for 'available' and is still tolerated by the
-- read paths; the lazy flip in affiliateMe now writes 'available'.)
--
-- ⚠️ MIGRATION HAZARD — READ BEFORE RUNNING ⚠️
-- Every affiliate_commissions row that exists BEFORE this migration was already
-- credited to a wallet under the old immediate-earn path. If the promotion cron
-- ever picks one up it pays the same commission a SECOND time, out of
-- platform:fees, with no way to tell it apart from a legitimate promotion. The
-- backfill below closes that: it stamps every pre-existing row with
-- promoted_at = created_at and leaves its status alone (never 'pending'), and the
-- cron's WHERE clause carries three independent guards —
--   status='pending' AND promoted_at IS NULL AND qualify_at IS NOT NULL
-- so a legacy row fails all three. See test/affiliate_commission_lifecycle.test.ts
-- ("pre-migration rows"), which asserts this before the cron ever runs in prod.

ALTER TABLE affiliate_commissions ADD COLUMN qualify_at INTEGER;
ALTER TABLE affiliate_commissions ADD COLUMN promoted_at INTEGER;
ALTER TABLE affiliate_commissions ADD COLUMN risk_flags TEXT;   -- JSON array of flag strings
ALTER TABLE affiliate_commissions ADD COLUMN rail TEXT;         -- 'play' | 'card' | … (§6.3 rail-specific windows later)

-- Backfill: pre-existing rows are ALREADY in the wallet. promoted_at anchors the
-- 7-day hold maturity that affiliateMe reports, and (with qualify_at left NULL)
-- makes them structurally invisible to the promotion cron.
UPDATE affiliate_commissions
   SET promoted_at = created_at
 WHERE promoted_at IS NULL;

-- Legacy 'settled' is the same thing as the new 'available'.
UPDATE affiliate_commissions SET status = 'available' WHERE status = 'settled';

-- Belt and braces: nothing that predates this migration may sit in 'pending'.
UPDATE affiliate_commissions SET status = 'held' WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_aff_comm_qualify
  ON affiliate_commissions(status, qualify_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_aff_comm_promoted
  ON affiliate_commissions(affiliate_uid, promoted_at);
