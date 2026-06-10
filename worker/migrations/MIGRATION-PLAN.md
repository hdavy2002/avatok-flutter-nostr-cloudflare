# Creator-marketplace D1 migration plan (Phase 1 scaffold)

Phase 1 decision: NO placeholder `CREATE TABLE (...)` DDL — empty tables would
complicate each phase's real `CREATE TABLE`. This file reserves the table NAMES
and owning phases instead; each phase ships its own migration file named below.
All tables live in `avatok-meta` (D1 `DB_META`) unless noted — they are
low-write global surfaces; high-write data stays in DOs per the arch.

| Table | Migration file (ships in) | Notes |
|---|---|---|
| `wallet_ledger` | `marketplace_wallet.sql` (Phase 2) | Double-entry, immutable rows: type ∈ topup, purchase_hold, escrow_release, refund, fee, payout, storage_charge, donation; `ref` = order/event/booking id. Lives in `avatok-wallet` (DB_WALLET) next to the existing audit trail. |
| `orders` | `marketplace_wallet.sql` (Phase 2) + ALTERs in Phase 7 | One row per purchase; escrow bucket key. |
| `payout_accounts` | `marketplace_payout.sql` (Phase 3) | Wise recipient details (tokenized), KYC-gated. Existing `payout.sql` tables are reviewed/merged in Phase 3. |
| `files_index` | `marketplace_storage.sql` (Phase 4) | Universal content-addressed pool over the existing `library.sql`/`media.sql` data (DB_MEDIA). |
| `storage_quota` | `marketplace_storage.sql` (Phase 4) | 6-row summary per user — graphs repaint from this, never from files_index (perf budget §7). |
| `calendar_blocks` | `marketplace_calendar.sql` (Phase 5) | ONE availability engine; existing `calendar.sql` slots get folded in. |
| `bookings` | `marketplace_calendar.sql` (Phase 5) | Blip calendar + conflict engine. |
| `listings` | `marketplace_listings.sql` (Phase 6) | AvaExplore marketplace listings (events + consults). |
| `reviews` | `marketplace_listings.sql` (Phase 6) | Verified-purchase reviews. |

Rules
- Migrations are applied to the REMOTE D1 via wrangler (`wrangler d1 execute
  avatok-meta --remote --file=...`) — staging DB first (`avatok-meta-staging`),
  then prod, per the Phase-1 staging workflow.
- Never rename these tables; later phases and the URL stubs
  (`worker/src/routes/stubs.ts`) assume them.
- KYC stays in the existing `account_status` / `kyc_status` tables (cfnative) —
  no new table.
