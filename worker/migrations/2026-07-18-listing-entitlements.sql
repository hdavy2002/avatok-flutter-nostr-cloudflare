-- [AVA-MKT-ENTITLEMENTS-1] listing_entitlements — per-listing publish rights.
--
-- GENUINELY NEW SCHEMA. One table that has never existed on any database.
-- Phase 5 ("Money") of Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md
-- (§1.3 token model, §3.3c idempotency, §5 quota/expiry). DB: avatok-meta
-- (DB_META) — the SAME database as migrations/listings.sql. Apply listings.sql
-- first. This table is READ AND WRITTEN inside the listings publish transaction,
-- so it MUST be co-located with `listings`; see the DB-placement block below.
--
-- WHY THIS TABLE EXISTS AT ALL (and why it is NOT the token ledger).
-- The token ledger (wallet_ledger, DB_WALLET) already records the MONEY: a debit
-- keyed on op_id, immutable, idempotent on replay (wallet_ledger.sql:18-19).
-- `chargeFeature` already gives us server-owned pricing, WalletDO idempotency,
-- and the 402/`insufficient` path (§1.3). What the ledger does NOT do is answer
-- the two questions the marketplace has to answer on every publish:
--   1. "Has this uid used their 5 free listings this period?"  (the quota)
--   2. "Is THIS listing entitled to be live right now, and until when?" (expiry)
-- Those are per-LISTING facts, not per-wallet-op facts, and the beta runs with
-- `betaFreePremium: true` (§1.3) which short-circuits chargeFeature to
-- {ok:true, charged:0} BEFORE any wallet call — so during beta the ledger sees
-- NOTHING and the quota still has to hold. That is the whole reason quota lives
-- here, "independent of tokens" (§1.3, §5): this table records the OUTCOME of a
-- publish (free grant or paid charge), and the ledger records the money when
-- there is money. They agree via op_id but neither depends on the other.
--
-- Do NOT add a Stripe/Play/payment-rail table here. The rail is Play top-up +
-- Stripe web (wallet.ts) feeding the token balance; entitlements only record
-- that a listing was granted or charged, never how the tokens were acquired.
--
-- ---------------------------------------------------------------------------
-- DB PLACEMENT — DB_META, NEXT TO `listings`. NOT DB_WALLET. DELIBERATE.
--
-- Wallet audit (wallet_ledger, admin_audit) lives in DB_WALLET = avatok-wallet.
-- Entitlements live in DB_META = avatok-meta, with `listings`. The deciding
-- constraint is §3.3c: "the 5-free quota must be consumed INSIDE the publish
-- transaction, keyed on listing_id, never on a separate call — a retried publish
-- that debits twice is a billing bug that reaches the user's wallet." The publish
-- transaction is a D1 write against `listings` in DB_META. D1 has NO cross-database
-- transaction, so an entitlement row in DB_WALLET could only be written by a
-- SECOND, non-atomic call — reintroducing exactly the at-least-once double-consume
-- §3.3c forbids. Co-locating the entitlement with the listing lets the draft->
-- published flip and the entitlement INSERT land in ONE atomic D1 batch. The money
-- (op_id -> wallet_ledger) stays in DB_WALLET and is reconciled by op_id; the
-- ENTITLEMENT (the right to be live) is a listings-domain fact and stays in DB_META.
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- PRIMARY KEY (listing_id, period) — WHY THIS MAKES DOUBLE-CONSUME IMPOSSIBLE.
--
-- The entitlement is 1:1 with a (listing, 30-day period). `period` is a
-- DETERMINISTIC ORDINAL — 1 for the initial publish, 2 for the first renewal, 3
-- for the next — NOT a wall-clock value. That is the load-bearing choice:
--
--   * A retried / double-tapped publish is ALWAYS period 1, computed the same way
--     no matter when the retry fires. So the publish INSERT is:
--        INSERT OR IGNORE INTO listing_entitlements
--          (listing_id, period, uid, source, ...) VALUES (?, 1, ?, 'free', ...);
--     and the second attempt hits the (listing_id, 1) primary key and is a no-op.
--     No second row, no second free-quota grant, no second charge. The schema
--     itself makes double-consumption impossible — it does not rely on the caller
--     remembering to check first. This is the §3.3c correctness point expressed as
--     a constraint: consumption is keyed on the listing (listing_id, period=1) and
--     is idempotent by the PK, inside the publish txn.
--
--   * listing_id ALONE was rejected as the key (the task's "PK or UNIQUE — think
--     about which"). A sole-listing_id PK forces renewal to be an in-place UPDATE
--     that OVERWRITES the prior period's op_id, charge and window — destroying the
--     billing audit trail, which is the exact anti-pattern the immutable
--     wallet_ledger (wallet_ledger.sql:18) and listing_category_versions
--     (2026-07-18-marketplace-verticals.sql:129 "versions are rows, never an
--     in-place update that destroys history") were built to avoid. So renewal is a
--     NEW ROW, and the key is composite.
--
--   * period_start (an epoch ms) was rejected as part of the key: it is clock-
--     derived, so a retry a few seconds later would compute a DIFFERENT value and
--     DEFEAT the dedup. `period` is the stable ordinal; `period_start` is only the
--     window's start instant, never a key.
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- RENEWAL = A NEW ROW, NOT AN EDIT (plan §1.3, §5).
--
-- "A listing expires at 30 days. Renewal is ANOTHER ONE-SHOT CHARGE, not a
-- subscription ... 'Renew' debits listing_post again with opId = ${listing_id}:
-- ${period}" (§1.3). So renewal INSERTs (listing_id, period+1, ...) with a fresh
-- period_start/expires_at, its own op_id, its own charged. Every period the
-- listing was live is a durable, immutable row; nothing is overwritten. op_id here
-- is exactly §1.3's '<listing_id>:<period>' so this table and wallet_ledger point
-- at the same charge, and the per-period op_id is what keeps the RENEWAL charge
-- idempotent on retry too (the wallet debit no-ops on op_id; this INSERT no-ops on
-- the PK — belt and braces).
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY — this file is NATIVELY safe to re-run (like marketplace-verticals).
--
-- Every statement is CREATE TABLE IF NOT EXISTS / CREATE [UNIQUE] INDEX IF NOT
-- EXISTS. There is NO ALTER here, so there is no "duplicate column name" failure
-- and nothing to guard:
--   * FRESH / STAGING / PROD (absent)  -> creates. Correct.
--   * RE-RUN (present)                 -> every statement is a no-op. Correct.
--   * PARTIAL (table present, an index missing) -> converges. Correct.
--
-- There is NO seed in this file (Phase 5 seeds nothing — entitlements are written
-- at runtime by the publish path). The project rule "INSERT OR IGNORE, never OR
-- REPLACE" still governs any future runtime write to admin-editable rows, but this
-- migration contains no INSERT at all.
--
--   RUN IT RAW — this file is CREATE/INDEX, so it does NOT go through
--   scripts/d1_apply_alters.py (that runner parses ALTERs only and exits with
--   "no ALTER TABLE ... ADD COLUMN statements" on this file, by design):
--     scripts/cf.sh worker d1 execute DB_META --remote \
--       --file=migrations/2026-07-18-listing-entitlements.sql
--
-- Goes through scripts/cf.sh, so staging is the default and prod is fail-closed
-- behind ALLOW_PROD=1. Pass the BINDING (DB_META), not a database name — prod is
-- `avatok-meta`, staging is `avatok-meta-staging`; the binding resolves per --env.
--
-- Apply order: AFTER migrations/listings.sql (the `listings` table this table's
-- listing_id references). Independent of the taxonomy migrations — Phase 5 does
-- not depend on Phase 1 columns.
-- ---------------------------------------------------------------------------

-- One row per (listing, 30-day period). See the PK block above for why the key is
-- (listing_id, period) and why that makes a retried publish impossible to
-- double-consume. NO FK to listings(id): a billing/entitlement record must outlive
-- the listing it describes (a deleted listing still had a charge that happened),
-- exactly as listing_category_versions holds no FK to listing_categories.
CREATE TABLE IF NOT EXISTS listing_entitlements (
  listing_id   TEXT    NOT NULL,            -- listings.id (no FK — see above)
  period       INTEGER NOT NULL DEFAULT 1,  -- ordinal: 1 = initial publish, 2 = 1st renewal, ...
  uid          TEXT    NOT NULL,            -- listings.creator_id (Clerk uid) — the quota owner
  source       TEXT    NOT NULL,            -- 'free' | 'paid'
  charged      INTEGER NOT NULL DEFAULT 0,  -- tokens debited (0 for free, and 0 in beta / betaFreePremium)
  op_id        TEXT,                        -- wallet opId used, '<listing_id>:<period>'; NULL for free/beta
  period_start INTEGER NOT NULL,            -- epoch ms — start of this 30-day window
  expires_at   INTEGER NOT NULL,            -- epoch ms — period_start + 30d (the live-until instant)
  created_at   INTEGER NOT NULL,            -- epoch ms — when the row was written
  PRIMARY KEY (listing_id, period)
);

-- THE QUOTA INDEX. Answers "has this uid used their 5 free listings this period?"
-- cheaply, without a scan:
--   SELECT COUNT(*) FROM listing_entitlements
--   WHERE uid = ?1 AND source = 'free' AND expires_at > ?2;   -- ?2 = now (epoch ms)
-- The 5-free are per-period (§5, §1.3), so "this period" = free entitlements whose
-- 30-day window has not yet elapsed. Leading (uid, source) makes the free rows for
-- one user contiguous; trailing expires_at lets the range predicate run in the
-- index. Same index also serves "list this user's live entitlements".
CREATE INDEX IF NOT EXISTS idx_le_uid_quota ON listing_entitlements(uid, source, expires_at);

-- Charge idempotency + audit at the entitlement layer, mirroring wallet_ledger's
-- op_id PK. One entitlement per wallet op. Partial (WHERE op_id IS NOT NULL) so the
-- many free/beta rows (op_id NULL) are exempt — SQLite treats multiple NULLs as
-- distinct anyway, but the partial index makes the intent explicit and keeps the
-- unique index small.
CREATE UNIQUE INDEX IF NOT EXISTS idx_le_opid ON listing_entitlements(op_id) WHERE op_id IS NOT NULL;

-- THE EXPIRY-CRON INDEX (§5: "notify at T-3d, expire at T, archive at T+30d").
-- The cron sweeps by window boundary across ALL listings, so it keys on expires_at
-- alone rather than per-user.
CREATE INDEX IF NOT EXISTS idx_le_expires ON listing_entitlements(expires_at);
