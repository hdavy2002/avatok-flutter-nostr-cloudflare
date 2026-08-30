-- [TAX-GST-1] Tax columns on the immutable policy snapshot.
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, by hand, against a named
-- environment — same posture as every other commercial migration
-- (see 2026-08-24-commercial-stream-sessions.sql:2-3).
--
-- WHY ON THE SNAPSHOT
-- -------------------
-- The rate must be frozen per order, exactly like creator_fee_pct. A ticket sold at 18%
-- settles and refunds at 18% even if the platform rate changes the next morning.
-- Recomputing tax at settlement time from live config would silently restate the tax on
-- historical orders, which is the one thing a tax figure must never do.
--
-- THE ARITHMETIC THESE COLUMNS RECORD
-- -----------------------------------
--   taxable_base = gross_amount (listing price P, plus platform fee F when F > 0)
--   gst_amount   = round(taxable_base * gst_rate_pct / 100)
--   buyer paid   = taxable_base + gst_amount
--   escrow holds = taxable_base          <- the 80/20 split runs on THIS, not on the total
--   gst_amount   -> account 'platform:tax'
--
-- GST NEVER ENTERS ESCROW AND IS NEVER SPLIT. It is not revenue. A design where the
-- creator's 80% is computed off a tax-inclusive number pays creators out of tax money.
--
-- ⚠️ COLLECTION IS OFF BY DEFAULT (gstEnabled=false). avaTOK has no GSTIN. With the flag
-- off these columns are written as zeros, so the code path is exercised in production
-- long before it charges anyone. Do not switch it on without a GSTIN and an accountant —
-- see Specs/SPEC-2026-08-29-PAID-SESSIONS-FIX-AND-GUEST-PAY.md [TAX-GST-1].
--
-- Nullable with a 0 default and no backfill: the commercial lane has never been live
-- (all six commercial* flags read false on 2026-08-29). Verify before applying:
--   SELECT COUNT(*) FROM commercial_policy_snapshots;

ALTER TABLE commercial_policy_snapshots ADD COLUMN gst_rate_pct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commercial_policy_snapshots ADD COLUMN gst_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commercial_policy_snapshots ADD COLUMN taxable_base INTEGER NOT NULL DEFAULT 0;

-- Mirrored onto the refund receipt so a refund can be proven to have returned the tax
-- too. Refunding taxable_base and keeping gst_amount is the easy, expensive mistake.
ALTER TABLE commercial_refund_receipts ADD COLUMN gst_amount INTEGER NOT NULL DEFAULT 0;
