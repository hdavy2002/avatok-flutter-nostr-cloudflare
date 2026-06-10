# Phase 2 — AvaWallet: Ledger, Stripe Top-up, Escrow

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §4 (money model). Prereq: Phase 1.

## Objective
A real wallet: AvaCoins backed by USD, Stripe top-ups of any amount, an immutable
double-entry ledger with escrow buckets, and a wallet UI with balance cards,
transaction trail, row-detail popups, pagination, and filters.

## Backend — RECONCILED WITH THE EXISTING WALLET ENGINE (decision 2026-06-10)

**An engine already exists — do NOT replace it.** `worker/src/do/wallet.ts`
(WalletDO): one DO per uid, ALL balance math serialized in DO-local SQLite
(`credit|spend|earn|release` ops, 7-day earnings hold via alarm, live balance
over WS), with D1 **`avatok-wallet`** (binding `DB_WALLET`, staging twin exists)
as the async audit trail written by the `Q_WALLET` queue consumer.
`StreamSessionDO` already settles gifts → creator WalletDO. Phase 2 LAYERS
double-entry semantics onto this:

- **Balance authority = WalletDO** (per-user). Never compute a user's balance
  from D1; D1 is the queryable history.
- **Ledger lives in D1 `avatok-wallet`** (NOT avatok-meta): extend/replace its
  audit table with the `wallet_ledger` schema below, populated via `Q_WALLET`.
- **Every money primitive = WalletDO op(s) + a queued ledger row** carrying the
  same idempotency id (`op_id`), so DO-truth and ledger always correspond.
- **Escrow accounts are ledger-only** (`escrow:<orderId>`, `platform:fees` rows
  in `wallet_accounts` in D1) — escrow has no DO because nothing races on it:
  hold = buyer `WalletDO.spend` + row `user→escrow`; release = creator
  `WalletDO.earn` (KEEPS the existing 7-day held→spendable behavior — earnings
  show as "pending" in the UI) + fee row `escrow→platform:fees`; refund = buyer
  `WalletDO.credit` + row `escrow→user`.
- **Donations** (Phase 7) follow the StreamSessionDO pattern: aggregate in the
  session DO, settle to creator WalletDO, ledger rows via Q_WALLET.
- **WalletDO additions needed:** accept an `op_id` on every mutating op and
  dedupe (idempotency at the authority, not just the API); emit the ledger
  message to Q_WALLET itself (single writer).
- **Reconciliation (A2) restated:** nightly, per user: WalletDO `balance+held`
  must equal Σ ledger credits−debits for `user:<id>` **up to the queue
  watermark** (tolerate in-flight Q_WALLET messages: compare against rows older
  than 5 min and re-check mismatches once before alerting).
- `WALLET_TOPUP_ENABLED="0"` is the existing real-money flag — Phase 2's Stripe
  work goes behind it (test keys on staging first), as already specced.

### Schema (D1 `avatok-wallet`)
```sql
CREATE TABLE wallet_accounts (            -- escrow + platform buckets ONLY (user balances live in WalletDO)
  id TEXT PRIMARY KEY,            -- 'escrow:<orderId>' | 'platform:fees'
  kind TEXT NOT NULL,             -- escrow | platform
  balance INTEGER NOT NULL DEFAULT 0,  -- coins, integer (1 coin = 1 cent USD)
  updated_at INTEGER NOT NULL
);
CREATE TABLE wallet_ledger (
  id TEXT PRIMARY KEY,            -- op_id (idempotency id, UNIQUE by definition)
  debit TEXT NOT NULL,            -- account: 'user:<clerkId>' | 'escrow:<orderId>' | 'platform:fees' | 'external:stripe' | 'external:wise'
  credit TEXT NOT NULL,
  amount INTEGER NOT NULL,        -- coins
  type TEXT NOT NULL,             -- topup|purchase_hold|escrow_release|refund|fee|payout|storage_charge|donation|adjustment
  ref TEXT,                       -- orderId / bookingId / eventId / stripe pi_...
  meta TEXT,                      -- JSON: title, counterpart name, fee breakdown
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_acct_time ON wallet_ledger(debit, created_at DESC);
CREATE INDEX idx_ledger_acct_time2 ON wallet_ledger(credit, created_at DESC);
```
- Ledger rows are never edited or deleted; `adjustment` reserved for admin fixes
  (admin console must apply adjustments through WalletDO + ledger, never D1-only).
- Coin peg: **1 AvaCoin = $0.01** (integers everywhere; UI shows $). Storage
  pricing (20 AvaCoins/GB/mo from the rulebook) re-confirmed against this peg
  in Phase 4 — flag to davy if 20 coins = $0.20/GB/mo is not intended.

### Stripe top-up
- `POST /api/wallet/topup` {amountUsdCents} → Stripe Checkout Session (or
  PaymentIntent + PaymentSheet in Flutter) → webhook `checkout.session.completed`
  on worker (`/api/wallet/stripe-webhook`, signature verified) → ledger row
  `external:stripe → user:<id>`, type `topup`.
- Idempotency: ledger `ref` = payment-intent id, UNIQUE index; replays no-op.
- NOTE: existing wallet infra has real-money flag-gated OFF (legal pending).
  This phase builds behind the same flag `WALLET_REAL_MONEY`; test mode keys first.

### Escrow primitives (consumed by Phases 6–7)
- `hold(userId, orderId, amount)` → ledger `user → escrow:<orderId>` type
  `purchase_hold`. Fails if insufficient balance.
- `release(orderId, creatorId)` → two rows: `escrow → user:<creator>` (80%,
  `escrow_release`), `escrow → platform:fees` (20%, `fee`).
- `refund(orderId, userId, amount)` → `escrow → user` type `refund` (partial OK).
- Exposed as internal functions + admin-only HTTP for testing.

### Read APIs
- `GET /api/wallet/balance`
- `GET /api/wallet/ledger?cursor=&limit=50&type=&from=&to=&q=` — keyset pagination
  (created_at+id cursor); `q` matches `meta.title`/ref (event/consult name).
- `GET /api/wallet/ledger/:id` — full detail (fee breakdown, counterpart, ref).

## Flutter (`app/lib/features/wallet/`)
- **Wallet home:** top cards — Balance ($ + coins), "Top up" button, This-month
  in/out. Below: transaction list (infinite scroll on the cursor API).
- **Row:** icon by type, title, signed amount (green in / red out), date.
- **Row tap → detail sheet:** source/destination, event or consult name, gross,
  platform fee, net, Stripe/Wise ref, timestamps.
- **Filters bar:** date range, type chips, search by event/consult name.
- **Top-up flow:** amount input (any amount) → Stripe PaymentSheet → success state;
  balance refreshes from server.
- Local-first: drift table `wallet_ledger_cache` scoped per account
  (`AccountScope.id`); render cache instantly, refresh from network.
- PostHog: `wallet_viewed`, `wallet_topup_started/succeeded`, `wallet_filter_used`.

## Acceptance criteria
- [ ] Test-mode Stripe top-up credits exact coins; webhook replay does not double-credit.
- [ ] hold/release/refund produce balanced ledger rows (sum debits = sum credits); a
      scripted test (worker route or vitest) verifies invariants.
- [ ] Ledger UI paginates past 100+ rows smoothly; filters and search work server-side.
- [ ] Row detail shows fee breakdown for a settled escrow.
- [ ] All local state per-account scoped; second account on same phone sees own wallet only.

## Folded from audit (build in this phase)

### A1. Idempotency layer [MUST]
- Every mutating money endpoint (`topup`, future `book`, `donate`, `withdraw`)
  requires header `Idempotency-Key: <uuid>` (client generates per tap).
- Worker helper `withIdempotency(key, userId, fn)`: KV `idem:<userId>:<key>`
  (TTL 24 h) stores the response; replay returns the stored response, never
  re-executes. 400 if header missing on money routes.
- Flutter: `MoneyApi` wrapper auto-attaches a key and retries safely on timeout.
- Acceptance: double-tap booking / flaky-network retry produces exactly one
  ledger entry (test: fire same key twice, assert one row).

### A2. Money ops console + reconciliation [MUST]
- Admin routes (Clerk role `admin`, all actions audit-logged to a new
  `admin_audit(id, admin_id, action, target, meta, created_at)` table):
  - `GET /api/admin/ledger?user=&ref=` — search any user's ledger.
  - `POST /api/admin/refund` {orderId, amount, reason} — manual (partial) refund
    via the standard `refund()` primitive; reason stored in ledger `meta`.
  - `POST /api/admin/adjust` {account, amount, reason} — `adjustment` rows only.
  - `GET /api/admin/account/:userId` — balance, holds, KYC, strikes, recent orders.
- Minimal Flutter admin screen (visible only to role admin; route
  `/admin/money`): user lookup → ledger table → refund/adjust dialogs.
- **Reconciliation cron** (consumers, nightly): for every `wallet_accounts` row,
  Σ(credits)−Σ(debits) in `wallet_ledger` must equal `balance`; Σ over
  `escrow:*` accounts must equal Σ amount of orders in status `held`. Any
  mismatch → Brevo alert email to hdavy2005@gmail.com with the diff + freeze
  flag option. Store run results in `recon_runs(date, ok, diff_json)`.
- Acceptance: seeded mismatch (manual UPDATE) is caught by the next recon run.

### A3. Shared rate limiter [SHOULD]
- Worker helper `rateLimit(key, max, windowSec)` on KV (sliding window):
  defaults — topup 5/h, withdraw 3/h, (later) bookings 10/h, donations 10/min
  + min 50 / max 50,000 coins per donation. Returns 429 with retry-after;
  Flutter shows a friendly cooldown message.

### A4. Purchase receipts [SHOULD]
- Brevo template `receipt`: line items (listing title, gross, platform fee shown
  as creator-side), total, payment source (wallet), order id, date — emailed to
  buyer on every `purchase_hold` and on `topup` (top-up receipt).
- Re-send button on the wallet row detail sheet ("Email me this receipt").

## Definition of done
Deploy (staging then prod), secrets in `secrets/secret-values.env` + worker
secrets, Graphiti episode, STATUS_REPORT.md, commit/push.
