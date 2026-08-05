# PROPOSAL — Open Affiliate Program + UPI Payouts (India)

**Rev 4 — 2026-08-05.** Supersedes rev 3 after owner audit round 3.
**Target:** production · **Status:** implementation specification, decisions locked.

### Locked decisions

```
India token economics ....... FIXED ₹1 = 1 token (NOT an FX conversion)
FX for India payouts ........ NOT USED
Affiliate commission ........ 10 tokens per 100-token eligible top-up
Payout at launch ............ manual UPI, allowlist only
Automation provider ......... Cashfree Payouts (subject to onboarding/compliance)
Provider fallback ........... RazorpayX
Qualification window ........ 30 days
Wallet hold after qualify ... 7 days
Tax ......................... configurable, CA-approved before real payouts
Attribution ................. lifetime, first affiliate wins
UI .......................... AvaWallet design language
```

---

## Revision history

**Rev 3 → Rev 4.** **Economics corrected — rev 2 and rev 3 were wrong.** Both
proposed keeping USD pricing and converting at withdrawal. The repo already
carries the opposite owner decision, and it is implemented. Plus: payout provider
abstraction (§4.8), tax fields expanded (§8), and a Play-rail discrepancy found
while verifying (§B3).

**Rev 2 → Rev 3.** Eight corrections, plus two defects found while verifying them.

**Rev 1 → Rev 2.** Install Referrer binding mismatch; wallet/D1 atomicity → escrow;
VPA verification ordering; tax/reconciliation model.

### §A — Rev 3 correction table

| # | Correction | Where |
|---|---|---|
| 1 | Reservation expiry mandatory; reconciliation must **release**, not just mark failed | §4.2, §4.3, **§4.7** |
| 2 | `consume_reserved` is campaign-labelled — payout metadata required | **§4.6** |
| 3 | Same-`op_id` reconciliation; never blind-retry consume | **§4.7** |
| 4 | 30-day account age is insufficient — signed, timestamped referral token | §3.1 |
| 5 | Join-link flag must gate only `app = "avatok"` | §2.1 |
| 6 | Commission lifecycle conflicts with the immediate `earn` — **delay the credit** | **§6.1** |
| 7 | Pre-auth referral cannot be `AccountScope`-scoped | §3.4 |
| 8 | `affiliateQualifyDays = 30`, rail-specific later | §6.2, §4.5 |

### §B — Two defects found verifying the audit (new in rev 3)

> **B1 — `expires_at` on a payout reservation does nothing today.** Correction 1
> is more serious than stated. `WalletDO.alarm()` and `reapStaleAiJobReservations()`
> **both filter `ref LIKE 'aijob:%'`**. A `upi_payout:<id>` reservation may carry
> `expires_at`, but nothing reaps it *and* the alarm scheduler will not even wake
> for it. Setting the field is inert. **This requires a `WalletDO` change, not
> just a route contract.** See §4.3.
>
> **B2 — the `op_id` replay cache expires after 48 hours.** `OPS_TTL_MS = 48h`.
> Correction 3 says "reuse the same `op_id`", which is right but not sufficient:
> beyond 48 h the cached result is gone, so an identical retry issues a **real**
> `consume_reserved` and gets `404 no_active_reservation` — exactly the
> false-failure the audit warns about, just delayed. **Reconciliation must never
> treat op_id replay as durable.** See §4.7.

Both are verified against `worker/src/do/wallet.ts` at HEAD, not inferred.

### §C — Rev 4 correction table

| # | Correction | Where |
|---|---|---|
| 1 | **India is fixed ₹1 = 1 token; FX must not touch the payout path** | **§1.1**, §4.4, §4.5 |
| 2 | Tax: don't hardcode 2%; add `tds_rate` + `tax_policy_version`; don't compute TDS at request time until the CA fixes the tax event | §4.4, **§8** |
| 3 | Payout provider abstraction; wallet state machine must not couple to a provider | **§4.8** |
| 4 | Keep 30 + 7; if it bites, shorten the **hold**, never the qualification window | §6.3, §12 |

> **B3 — the Play rail does not implement the ₹1 = 1 token decision (new in rev 4).**
> Found while verifying §1.1. `PLAY_TOPUP_PRODUCTS` is a USD-only SKU map
> (`avatok_topup_5: 500`, …) and `creditPlayTopup` hardcodes `currency: 'usd'`.
> An Indian user on Android pays **Google's localised INR price tier** for
> `avatok_topup_5` and receives 500 tokens — so what a token costs in rupees on
> the primary rail is set by the Play Console price tier, not by AvaTOK.
> `walletTopupIntent` (Stripe PaymentSheet) implements the INR ladder correctly;
> `walletTopup` (legacy Stripe Checkout) hardcodes `currency: "usd"`.
>
> **This does not block the affiliate work** — commission is 10% of *tokens*, so
> it is rail-independent and exact on every rail. It matters for the **payout**
> side: paying ₹1/token out against a Play top-up whose INR receipt is set by
> Google *and* reduced by Google's store cut is a margin question, not an FX
> question. **Action: confirm the Play Console INR price tiers for each
> `avatok_topup_*` SKU line up with ₹1/token before enabling payouts.** Tracked
> as an open item (§12), not a design change here.

---

## 0. TL;DR

An affiliate system already exists (`worker/src/routes/affiliate.ts`, 831 lines;
`app/lib/features/affiliate/`; 4 migrations): open self-registration, link
minting, lifetime attribution, **10% of every top-up forever**. Dark in
production (`avaAffiliateEnabled = false`, verified live 2026-08-05).

| # | Gap | Effort |
|---|---|---|
| **G1** | No generic "join AvaTOK" link (links are per-listing) | M |
| **G2** | Attribution never binds on Android | M |
| **G3** | No UPI rail, no approval queue, no reconciliation | L |
| **G4** | Affiliate screen is `AppTier.hidden` | S |
| **G5** | Commission has one status; **and is credited to the wallet immediately** | M |
| **G6** | `WalletDO` cannot expire non-`aijob` reservations (§B1) | S |

Unchanged and correct: the 10% rate, `platform:fees` funding, `reverseAffiliate()`,
self-referral gates, and the 100-token welcome bonus in the non-cashable `bonus` bucket.

---

## 1. Money model

`TOKENS_PER_USD = 100` → 1 token = $0.01.

| Step | Where |
|---|---|
| Signup → 100 welcome tokens | `grantWelcomeBonus()`, idempotent `op_id = welcome:<uid>`, lands in **`bonus`** — spendable, never withdrawable. |
| Top-up | Stripe / Play → `creditTopup()`, `MIN_TOPUP = 100`. |
| Commission | `payAffiliateOnTopup()`, 10%, `platform:fees → user:<affiliate>`. **Timing changes — see §6.1.** |
| Withdraw | New — §4. |

Commission is funded from platform fees, never from the user's tokens.

### 1.1 Economics — India is FIXED ₹1 = 1 token (corrected in rev 4)

**Rev 2 and rev 3 got this wrong.** Both proposed keeping USD pricing and
converting at withdrawal, on the assumption that no INR ladder existed. It does,
it is an owner decision, and it is implemented. `worker/src/lib/fx_rates.ts`
(`[TOKENS-FX-1]`) states:

> FX here is **INFORMATIONAL ONLY**. Token economics are fixed:
> canonical — 1 USD = 100 Tokens. **India — 1 Token = ₹1 FIXED (an owner pricing
> decision, NOT an FX conversion); minimum top-up ₹100 (= 100 Tokens).**

And `walletTopupIntent` implements it: `currency: "inr"` →
`coins = round(paise / 100)`, with the comment *"the server, never the client,
decides the token conversion either way."*

**Therefore, for India:**

```
gross_inr_paise = gross_coins * 100          // ₹1 per token, exact, no rate lookup
```

- **No FX in the payout path.** No rate feed, no quote freezing, no drift.
- `fx_rates.ts` stays for informational USD comparisons in the top-up quote and
  the statement. It **must not** determine an Indian affiliate payout. The
  `open.er-api.com` keyless fallback in particular must never sit in a money path.
- Retain a single **informational audit field** `inr_per_token_paise = 100` on each
  payout row, so a future rate change is legible in history rather than implicit.
- The economics are now exactly what you originally described: **₹100 top-up →
  100 tokens → affiliate earns 10 tokens → affiliate withdraws ₹10** (less TDS).
  10% end to end, with no rounding or FX slippage anywhere.

**Approved copy (replaces the rev 3 wording):**

> Affiliates earn 10% of eligible paid top-ups. In India, 1 token = ₹1, so a ₹100
> top-up earns you ₹10. Withdrawals are subject to applicable tax.

Do **not** show a conversion rate on the India withdraw screen — there isn't one.
Show `coins → ₹` directly, then TDS, then net.

> **Caveat, see §B3:** the ₹1 = 1 token promise is exact on the Stripe
> PaymentSheet rail. On the **Play Billing** rail the INR price is Google's
> localised tier for a USD-named SKU. Confirm those tiers before enabling payouts.

---

## 2. G1 — Generic join link

`POST /api/affiliate/links` requires `{listing_id, app}` with
`app ∈ {avalive, avaconsult, avavoice}`. `payAffiliateOnTopup()` already ignores
the listing (earliest attribution wins), so a generic link only needs to produce
*an* attribution row.

**Sentinel:** `listing_id = "__platform__"`, `app = "avatok"`.

1. `PLATFORM_LISTING` constant; for `app === "avatok"` skip `loadListing()` and the
   `creator_self_promo` gate (no creator exists). All other gates unchanged.
2. `affiliateLinkCreate` forces the sentinel → existing
   `UNIQUE(affiliate_uid, listing_id)` gives exactly one permanent join link per
   affiliate, idempotently.
3. `affiliateClick` renders a *join AvaTOK* page → `avatok://join?aff=<token>`
   (signed token, §3.1), Play badge `&referrer=<token>`.
4. `affiliateRegister` mints the platform link at registration.
5. **No migration** — `listing_id` is plain `TEXT`; the FK is on `affiliate_uid`.

### 2.1 Flag scoping — corrected (audit #5)

Rev 2's helper would have disabled **existing listing affiliate links** whenever
generic signup links were switched off. `affiliateJoinLinkEnabled` gates **only**
platform links:

```ts
function linkLive(cfg: PlatformConfig, link: LinkRow): boolean {
  if (cfg.avaAffiliateEnabled !== true) return false;      // master gate
  if (link.app !== "avatok") return true;                  // listing links unaffected
  return cfg.affiliateJoinLinkEnabled === true;            // platform links only
}
```

One helper, used by mint, click page, and bind. When a link is not live,
`GET /a/:linkId` serves a neutral page with **no** deep link, **no** referrer, and
**no** pending write — never a click that cannot bind.

---

## 3. G2 — Attribution binding

`affiliateBind` reads only `aff_pending:<device>` from KV via the `ava_aff_dev`
cookie. That cookie does not survive a Play install, so **every Play-origin
referral returns `no_pending`** today.

### 3.1 Signed referral token — corrected (audit #4)

Rev 2 proposed a bare `link_id` plus a 30-day account-age check. That blocks
retro-attributing an *old* account but not a **two-year-old link used by a brand
new signup** — a permanent bearer token. **The window must run from referrer
issuance, not account creation.**

`affiliateClick` issues an HMAC-signed token instead of a bare id:

```
aff1.<base64url({ link_id, issued_at, source })>.<hmac_sha256(payload, AFFILIATE_TOKEN_SECRET)>
```

`AFFILIATE_TOKEN_SECRET` is a Worker secret (never in `wrangler.toml`). Verification:

1. signature valid (constant-time compare) — else `invalid_token`;
2. `now - issued_at <= affiliateReferralTokenTtlDays` (**default 30**) — else
   `token_expired`;
3. link still live per §2.1;
4. **and** account age `<= affiliateBindWindowDays` (default 30) — kept as
   defence in depth, not as the primary control.

Both clocks must pass. A leaked or archived link is then useless after 30 days,
and Mode B stops being a bearer-token surface.

### 3.2 Two bind modes, one endpoint

```jsonc
// Mode A — existing web / warm start: consume pending KV by device
{ "device_id": "…", "source": "link" }

// Mode B — NEW: signed token from Play Install Referrer or a cold deep link
{ "token": "aff1.…", "source": "play_install_referrer" | "deep_link" }
```

**Mode B rules:**

- **Never accept a client-supplied `affiliate_uid`.** Derive it from
  `affiliate_links.id` inside the verified token payload.
- Distinct `reason` + PostHog `affiliate_attribution_rejected` for each of:
  `invalid_token`, `token_expired`, `link_not_found`, `link_inactive`,
  `affiliate_suspended`, `self_referral`, `already_attributed`, `window_expired`,
  `disabled`.
- `already_attributed` is enforced by the DB — keep
  `ON CONFLICT(referred_uid, listing_id) DO NOTHING`; report `bound:false,
  already:true`. **First affiliate wins permanently; a binding never moves.**
- Authed (`requireUser`), and `rateLimit`-ed per uid **and** per link id.

### 3.3 The four client legs — ship together

1. `app/lib/core/deep_links.dart` — `_handle()` routes only `/l/`, `/group`,
   `/add`. Add `/a/<token>` and `avatok://join?aff=<token>`.
2. `AndroidManifest.xml` — App Links filter lists `pathPrefix` `/j/`, `/add`,
   `/l/`. **Add `/a/` and `/i/`** (the referral invite link has the same bug).
3. **Play Install Referrer** plugin — read on first launch, parse the token, call
   Mode B. **This is the majority path.**
4. Call bind alongside `ReferralService.I.claimPendingAfterSignup()`
   (`sign_in_screen.dart:288`); retry each cold start until `bound` or a terminal
   reason.

### 3.4 Pre-auth storage — corrected (audit #7)

Rev 2 said to store the pending token under `AccountScope.id`. **A referral
arrives before an account exists**, so that is impossible on the cold-install path.

- Store pre-auth in a **device-local, unscoped, short-lived** record:
  key `aff_pending_token`, TTL = `affiliateReferralTokenTtlDays`, containing
  **only** the opaque token. No uid, no email, no account data — so it cannot leak
  anything across the parent/child accounts that share one phone.
- **On successful sign-in: migrate then delete.** Bind, write the outcome under
  `AccountScope.id`, and clear the global key in the same step. The global key
  must never outlive the first authenticated bind attempt.
- This is a deliberate, documented exception to the per-account scoping rule in
  `CLAUDE.md`. Note it in the code comment so the next agent does not "fix" it.

### 3.5 Verification gate

On a real device: click → install from internal track → sign up → assert exactly
one `affiliate_attributions` row → top up → assert commission row + balance moved.
Standing PostHog funnel `affiliate_link_clicked → affiliate_attribution_bound →
affiliate_topup_commission`, split by `source`. **A flat `play_install_referrer`
leg after launch means the feature is broken, whatever code review said.**

---

## 4. G3 — UPI payouts

### 4.1 Escrow, not debit-then-refund

`WalletDO` already provides:

```ts
{ op: "reserve",             amount, ref, allow_free: false, expires_at? }
{ op: "consume_reserved",    amount, ref, allow_free: false }
{ op: "release_reservation", ref }
```

- **Reservations do not move money** — they live in the DO's `resv` table and are
  subtracted from headroom, so a reserved amount can be neither double-spent nor lost.
- **`allow_free` is mandatory with no default** (missing → 400). `false` means the
  reservation can only touch paid `balance`, never `free`/`bonus`. **The welcome
  tokens are therefore structurally un-withdrawable** — enforced by the authority,
  not by our route remembering.
- `policy_mismatch` → 409 if a ref is reused under a different policy.
- Rejection is `release_reservation`: **no refund op exists or is needed**, so the
  promo-bucket problem cannot occur. `releaseReservation` is fully idempotent
  (already-released → `refunded: 0, ok: true`) and deliberately writes **no**
  statement row, because nothing moved. That is correct and stays.

### 4.2 State machine

```
created ──reserve ok──> reserved ──admin approve──> approved
   │                        │                          │
   │ reserve fails          │ reject / expiry          │ mark paid (+UTR)
   ▼                        ▼                          ▼
 failed              released (terminal)        consume_reserved ──> paid ──recon──> reconciled
                                                       │
                                              ambiguous/failed
                                                       ▼
                                              needs_reconciliation
```

- **Row written FIRST** (`created`, UUID), *then* `reserve` with
  `ref = upi_payout:<request_id>`.
- Every wallet call: `op_id = <transition>:<request_id>`.
- `needs_reconciliation` is a real alertable state, never an exception path.

### 4.3 Mandatory expiry — corrected (audit #1 + §B1)

**Contract:** `expires_at` is **required** on every payout reservation:

```ts
expires_at = created_at + upiPayoutReservationTtlHours * 3_600_000   // default 72h
```

Enforce in the `upi_payout.ts` helper (reject a call without it) — do **not** rely
on `WalletDO.reserve()`, which still accepts `expires_at: 0`.

**But setting it is inert today (§B1).** `WalletDO.alarm()` and
`reapStaleAiJobReservations()` both filter `ref LIKE 'aijob:%'`, so a payout
reservation is neither reaped nor even alarm-scheduled. **G6 — required
`WalletDO` change:**

1. Generalise the reaper to all expired, unreleased reservations
   (`expires_at > 0 AND expires_at <= now AND released = 0`), keeping the existing
   `aijob:` behaviour as one case. Rename to `reapExpiredReservations()`.
2. Drop the `ref LIKE 'aijob:%'` filter from the alarm's `nextResv` query so the
   DO wakes for a payout expiry.
3. Reaping a `upi_payout:` ref must emit a distinguishable result so §4.7 can tell
   *expired* from *never existed*.

**Belt and braces:** the reconciliation cron (§4.7) **also** issues an explicit
`release_reservation` for expired requests. Do not rely on the DO alarm alone —
a DO that is never touched again may not fire. The audit's point stands: the job
must **release**, not merely mark the D1 row failed.

### 4.4 Migration — `worker/migrations/2026-08-XX-affiliate-upi-payout.sql` (DB_WALLET)

```sql
-- UPI payout destinations. One ACTIVE VPA per affiliate. India only.
-- PII: vpa, holder_name, pan_last4 must NEVER reach logs, PostHog, error
-- strings, or non-finance admin telemetry.
CREATE TABLE IF NOT EXISTS upi_accounts (
  id             TEXT PRIMARY KEY,
  uid            TEXT NOT NULL,
  vpa            TEXT NOT NULL,
  vpa_hash       TEXT NOT NULL,                     -- sha256 — clustering without exposing PII
  holder_name    TEXT NOT NULL,
  name_match     TEXT NOT NULL DEFAULT 'unchecked', -- unchecked|match|mismatch|manual_ok
  kyc_status     TEXT NOT NULL DEFAULT 'missing',   -- missing|submitted|verified|rejected
  pan_last4      TEXT,
  tax_country    TEXT NOT NULL DEFAULT 'IN',
  tax_id_type    TEXT,
  tax_form_status TEXT NOT NULL DEFAULT 'missing',
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending|verified|rejected|superseded
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upi_uid_active ON upi_accounts(uid) WHERE status IN ('pending','verified');
CREATE INDEX IF NOT EXISTS idx_upi_vpa_hash ON upi_accounts(vpa_hash);

CREATE TABLE IF NOT EXISTS upi_payout_requests (
  id                TEXT PRIMARY KEY,
  uid               TEXT NOT NULL,
  upi_account_id    TEXT NOT NULL,
  gross_coins       INTEGER NOT NULL,
  -- India is FIXED ₹1/token (§1.1). This is an AUDIT field, not an FX rate:
  -- gross_inr_paise = gross_coins * inr_per_token_paise. No rate feed involved.
  inr_per_token_paise INTEGER NOT NULL DEFAULT 100,
  gross_inr_paise   INTEGER NOT NULL,
  tds_rate          REAL,                   -- NULL until the CA fixes it (§8)
  tds_inr_paise     INTEGER NOT NULL DEFAULT 0,
  net_inr_paise     INTEGER NOT NULL,
  tax_year          TEXT NOT NULL,          -- 'FY2026-27'
  tax_policy_version TEXT,                  -- which CA-approved ruleset computed the above
  tax_event         TEXT,                   -- 'earned'|'promoted'|'paid' — set by policy, not assumed
  provider          TEXT NOT NULL DEFAULT 'manual_upi',  -- manual_upi|cashfree|razorpayx (§4.8)
  provider_reference TEXT,                  -- provider's own transfer id
  provider_status   TEXT,                   -- initiated|pending|paid|failed
  status            TEXT NOT NULL DEFAULT 'created',
  -- created|reserved|approved|paid|reconciled|released|failed|needs_reconciliation
  wallet_ref        TEXT NOT NULL,          -- 'upi_payout:<id>'
  reserve_expires_at INTEGER NOT NULL,      -- MANDATORY (§4.3)
  consume_op_id     TEXT,                   -- frozen at first consume attempt (§4.7)
  consume_result    TEXT,                   -- raw DO result JSON of the decisive attempt
  admin_uid         TEXT,
  utr               TEXT,
  bank_ref          TEXT,
  reconciled_at     INTEGER,
  reject_reason     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upireq_status ON upi_payout_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_upireq_uid    ON upi_payout_requests(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_upireq_year   ON upi_payout_requests(uid, tax_year);
CREATE INDEX IF NOT EXISTS idx_upireq_expiry ON upi_payout_requests(reserve_expires_at) WHERE status IN ('created','reserved','approved');
CREATE UNIQUE INDEX IF NOT EXISTS idx_upireq_utr ON upi_payout_requests(utr) WHERE utr IS NOT NULL;
```

### 4.5 Routes — `worker/src/routes/upi_payout.ts` (new)

| Route | Behaviour |
|---|---|
| `POST /api/payout/upi/account` | Add/replace VPA. `^[\w.\-]{2,64}@[a-zA-Z]{2,32}$`. Replacing supersedes the old row, sets `cooldown_until = now + upiVpaCooldownHours`. |
| `GET /api/payout/upi/account` | Masked VPA, `status`, `kyc_status`, `cooldown_until`. |
| `GET /api/payout/upi/quote` | **Available** coins (§6.1), min, `gross_inr_paise = coins × 100`, estimated TDS, net ₹. No rate lookup — India is fixed (§1.1). Read-only. |
| `POST /api/payout/upi/request` | Eligibility (§5) → insert `created` → `reserve` (`allow_free:false`, mandatory `expires_at`) → `reserved`. |
| `GET /api/payout/upi/requests` | Own history + statements. |
| `GET /api/admin/payouts/upi` | Queue. `requireAdminRole('finance')`. |
| `POST …/:id/approve` | → `approved`. Returns VPA + net ₹. `admin_audit` row. |
| `POST …/:id/paid {utr}` | §4.7 consume protocol → `paid`, or `needs_reconciliation`. **Never** silently `paid`. |
| `POST …/:id/reject {reason}` | `release_reservation` → `released`. |
| `POST /api/admin/payouts/upi/reconcile` | Match bank statement refs → `bank_ref`, `reconciled_at`, status `reconciled`. |

**A typed UTR is an admin's claim, not proof.** `paid` = "admin says sent";
`reconciled` = "matched against the bank statement". Two distinct states in the panel.

### 4.6 Payout-labelled wallet metadata — corrected (audit #2)

**Verified at HEAD:** `WalletDO.consumeReserved()` ends with

```ts
await this.audit(uid, { type: "campaign_call", amount: -clamp, …,
                        app_name: b.app_name || "campaign", ref, …}, b);
```

`app_name` is overridable; **`type` is hardcoded**. Calling it as-is would file a
payout in the user's statement and `wallet_ledger` as a **campaign charge**.

**Change (`WalletDO`, backward-compatible):**

```ts
const auditType = typeof b.type === "string" && b.type ? b.type : "campaign_call";
```

Existing campaign callers pass no `type` and are unaffected. Add `type?: string`
to the `consume_reserved` arm of the `WalletOperation` union so it is
compile-time enforced. Payout calls pass:

```ts
{ op: "consume_reserved", amount, ref: `upi_payout:${id}`, allow_free: false,
  type: "payout", app_name: "avapayout", op_id: `payout_consume:${id}`,
  ledger: { debit: acctUser(uid), credit: ACCT_EXTERNAL_PAYOUT,
            type: "payout", ref: `upi_payout:${id}` } }
```

On `release_reservation` the DO writes **no** statement row (correct — nothing
moved), so there is no ledger mislabelling to fix there; still pass
`app_name: "avapayout"` through the route helper so telemetry attributes it correctly.

**Acceptance test, not a code read:** run one staging payout end to end and assert
the `wallet_transactions` row and the `wallet_ledger` entry both read *payout*,
and that the user-facing statement renders it as a withdrawal, not a campaign charge.

### 4.7 Consume/reconcile protocol — corrected (audit #3 + §B2)

Escrow removes token *loss*. It does not make `consume_reserved` + the D1 status
update atomic. Protocol:

1. **Freeze `consume_op_id = payout_consume:<request_id>` in D1 *before* the first
   consume attempt.** Never regenerate it.
2. Call `consume_reserved` with that `op_id`. Persist the raw DO result to
   `consume_result` **before** transitioning to `paid`.
3. **Retries reuse the frozen `op_id`.** Within 48 h the DO's `ops` replay cache
   returns the original success verbatim, so a retry is genuinely free.
4. **§B2 — beyond 48 h the cache is gone** (`OPS_TTL_MS = 48h`). An identical retry
   then issues a *real* consume and returns `404 no_active_reservation`, which is
   **ambiguous**: it means either "already consumed successfully" or "never
   reserved". **A 404 must never be read as failure, and never as success.**
5. **Disambiguate from the ledger, not the retry.** On any ambiguous result,
   query `wallet_ledger` for `ref = upi_payout:<id>`, `type = 'payout'`:
   - **row present** → the money moved → set `paid`;
   - **row absent and reservation released/expired** → `released` or `failed`;
   - **anything else** → `needs_reconciliation` and alert. Never guess.
6. **Never issue a fresh consume on a request already past `approved`** without
   step 5 first.

### 4.8 Provider abstraction — new in rev 4

The wallet state machine (§4.2) must **not** couple to any payout provider. Define
one adapter interface and implement it twice:

```ts
type PayoutProviderResult = {
  state: "initiated" | "pending" | "paid" | "failed";
  utr?: string;
  provider_reference?: string;
  failure_reason?: string;
};

interface PayoutProvider {
  readonly id: "manual_upi" | "cashfree" | "razorpayx";
  validateVpa(vpa: string, expectedName?: string): Promise<VpaValidation>;
  send(req: PayoutRequestRow): Promise<PayoutProviderResult>;
  status(providerReference: string): Promise<PayoutProviderResult>;
}
```

- **`ManualUpiProvider` (launch).** `send()` is a no-op that returns
  `{ state: "initiated" }`; the admin pays by hand and posts the UTR (§4.5).
  `validateVpa()` returns `unchecked`. This is the *only* provider enabled at launch.
- **`CashfreeUpiProvider` (first automation candidate).** Chosen because it
  documents UPI payouts, VPA validation, a validate-then-pay flow, payout status
  with UTR, and beneficiary management
  ([overview](https://www.cashfree.com/docs/api-reference/payouts/v1/payouts-api-overview),
  [VPA validation](https://www.cashfree.com/docs/api-reference/payouts/v1/validate-payout-v1-2),
  [verify-and-pay](https://www.cashfree.com/docs/api-reference/payouts/v2/verify-and-pay-transfers-v2)).
  Subject to onboarding and compliance approval.
- **`RazorpayXProvider` (fallback / comparison).** Supports VPA payouts with
  idempotency keys ([docs](https://razorpay.com/docs/api/x/payouts/)).

**Mapping rules:**

| Provider state | Payout row |
|---|---|
| `initiated` / `pending` | stays `approved`; `provider_status` updated |
| `paid` | run the §4.7 consume protocol, **then** `paid` |
| `failed` | `release_reservation` → `released`, `reject_reason` set |

The provider never moves wallet money. **`consume_reserved` remains the single
point at which tokens leave the wallet**, whichever provider reported success —
so an automated provider changes who types the UTR, not the money invariants.
Provider selection is per-request (`provider` column), so a Cashfree rollout can
run alongside manual payouts for an allowlist without a migration.

**Reconciliation cron** (extend `recon_runs` / `adminRecon` in `wallet_ledger.sql`):

| Sweep | Action |
|---|---|
| `created` > 10 min | retry `reserve` (same op_id) or → `failed` |
| `reserved`/`approved` past `reserve_expires_at` | explicit `release_reservation` → `released`; notify affiliate |
| `approved` > 72 h, unexpired | nag finance |
| `paid` without `bank_ref` > 7 days | flag for statement match |
| `needs_reconciliation` (any age) | page |

Every sweep idempotent on its frozen `op_id`.

---

## 5. UPI account verification

A valid VPA string proves nothing, and verifying by making the first real transfer
verifies nothing before the money is gone. Gate the first withdrawal behind:

1. **KYC** — reuse the existing payout KYC/tax gate (`payout_accounts` already has
   `tax_country`, `tax_id_type`, `tax_id_last4`, `tax_form_status`). Do not build a second.
2. **Legal name + PAN captured before any withdrawal**, not at first payout.
3. **Name match** against the KYC legal name where the PSP supports VPA name
   lookup. `mismatch` → manual review, never auto-approve. Until a provider is
   integrated `name_match` stays `unchecked` and **every first payout is manually reviewed**.
4. **Cooldown** after any VPA change (`upiVpaCooldownHours`, default 72 h) — a
   compromised account must not be able to add a VPA and drain in one sitting.
5. **One active VPA per user** — partial unique index.
6. **Ring detection** — shared `vpa_hash` across affiliates is a hard queue stop.
7. **PII discipline** — `vpa`, `holder_name`, PAN never in logs, PostHog,
   exception messages, or non-finance admin views. Add to the `scrubServer`
   deny-list in the same change **and assert it in a test**.

**Rail reality:** UPI is a payment address system, not a payout API
([NPCI](https://www.npci.org.in/product/upi/about-upi)); transfer and
beneficiary-name verification depend on the bank/PSP. Manual transfers therefore
require statement reconciliation (§4.7); automation is a separate integration (§10.8).

---

## 6. G5 — Commission lifecycle and fraud

### 6.1 The accounting conflict — corrected (audit #6). **Biggest change in rev 3.**

`payAffiliateOnTopup()` calls `walletOp op:"earn"` **immediately**, which starts
the 7-day `WalletDO` hold at top-up time. The rev 2 design then added a 14-day D1
`qualify_at`. **The hold would mature at day 7 and the coins would be spendable
and withdrawable while D1 still said `pending`.** A D1 status cannot prevent a
withdrawal, because withdrawal eligibility is decided by the wallet. Rev 2 was
wrong.

**Adopted (the audit's preferred option): delay the wallet credit until qualification.**

```
top-up ──> D1 affiliate_commissions row, status 'pending'   [NO wallet operation]
             │
             └── qualifyAt = topup_at + affiliateQualifyDays (30)
                    │  no refund / dispute / cap breach / cluster flag
                    ▼
             walletOp op:"earn"  ──> 7-day WalletDO hold ──> available
```

- **`pending` commissions do not exist in the wallet at all.** The invariant the
  audit demanded — *anything `pending` must not already be in withdrawable
  balance* — holds structurally, not by convention.
- Total time to withdrawable: **qualify (30 d) + hold (7 d) = 37 days.**
- `payAffiliateOnTopup()` becomes **D1-only**: compute, insert `pending`, no
  `walletOp`. Keep the idempotency key `aff_topup:<topupId>` on the D1 row.
- New **qualification cron** promotes due rows: re-check refund/dispute status,
  caps (§6.2), clustering, and affiliate standing **at promotion time, not at
  top-up time**, then call `earn` with `op_id = aff_topup:<topupId>` — the same
  key the immediate path used, so the operation stays idempotent and a
  double-promotion is impossible.
- Failed re-check → `reversed` (or `held_review`), never a silent skip. Emit
  `affiliate_commission_promoted` / `_reversed` to PostHog.
- **`reverseAffiliate()` gains a cheap path:** a refund before qualification is a
  pure D1 status flip with no wallet clawback at all. Most fraud is then caught
  before any money exists.

**Migration** `2026-08-XX-affiliate-commission-status.sql` (DB_WALLET):

```sql
ALTER TABLE affiliate_commissions ADD COLUMN qualify_at INTEGER;
ALTER TABLE affiliate_commissions ADD COLUMN promoted_at INTEGER;
ALTER TABLE affiliate_commissions ADD COLUMN risk_flags TEXT;   -- JSON array
CREATE INDEX IF NOT EXISTS idx_aff_comm_qualify
  ON affiliate_commissions(status, qualify_at) WHERE status='pending';
```

Status values widen to `pending | held | available | held_review | reversed`.
**Existing rows backfill to `held`** — they were already credited under the old
immediate-`earn` path, and must not be credited a second time. The promotion cron
must skip any row with `promoted_at IS NULL AND created_at < <migration ts>`;
assert this in a test before the cron ever runs in prod.

### 6.2 Caps, gates, clustering

Already enforced: self-referral, creator-self-promo, suspended-affiliate blocks,
per-IP rate limits (120 clicks/h, 60 mints/h), click dedupe (1 h/device),
`reverseAffiliate()` proportional clawback, 7-day hold.

Added — all evaluated **at promotion time** (§6.1):

- **Minimum qualifying top-up** (`affiliateMinQualifyingTopupCoins`, 100) — no dust farming.
- **Daily / monthly earning caps** per affiliate; excess stays `pending` + flagged, never silently dropped.
- **Per-referred-user cap** in the first qualifying period — the classic stolen-card pattern.
- **Clustering** on device, payment instrument, IP, phone, identity. `referral.ts`
  already hashes `device_hash`/`ip_hash`; `affiliate_attributions` does not — add both.
- **Same-person block** — clustering says one person controls both accounts → pay nothing, flag.
- **Freeze on dispute** — a refund or chargeback freezes that affiliate's
  unwithdrawn earnings pending review, on top of clawback.
- **Suspension freezes unwithdrawn earnings.** `adminAffiliateSuspend` currently
  only blocks new bindings.

### 6.3 Qualification window — corrected (audit #8)

**Launch value: `affiliateQualifyDays = 30`** (not rev 2's 14). 30 days still does
not cover every card or Play Billing dispute, so the allowlist, caps, clustering,
and manual review remain load-bearing — the window is one control among several,
not the control.

**Post-launch:** move to rail-specific qualification —

| Rail | Window |
|---|---|
| Play Billing | longer |
| Card top-up | longer |
| Low-risk settled rail | shorter |

Schema support: add `rail TEXT` to `affiliate_commissions` at the same migration
so the data exists before the policy does.

### 6.4 Terms

The code binds the **first** affiliate forever and never moves the binding. That
is a commercial term: it must appear in the user-facing terms and on the affiliate
home screen, not only in a SQL comment.

---

## 7. Flags — `worker/src/routes/config.ts`

Per the fake-flag rule (CLAUDE.md): add to `PlatformConfig` **and** `DEFAULTS` in
the same change; numbers **also** to `numericKeys`; then prove with
`ALLOW_PROD=1 scripts/flags.sh set <key>=…` not returning 400 and a cache-busted
`/api/config` re-read.

| Key | Type | Launch default |
|---|---|---|
| `upiPayoutEnabled` | bool | `false` |
| `affiliateJoinLinkEnabled` | bool | `false` |
| `affiliatePayoutAllowlistOnly` | bool | **`true`** |
| `upiPayoutMinCoins` | num | `1000` (= ₹1,000) |
| `upiPayoutAutomationEnabled` | bool | `false` — see 7.1 |
| `upiPayoutReservationTtlHours` | num | `72` |
| `upiVpaCooldownHours` | num | `72` |
| `affiliateReferralTokenTtlDays` | num | `30` |
| `affiliateBindWindowDays` | num | `30` |
| `affiliateQualifyDays` | num | **`30`** |
| `affiliateMinQualifyingTopupCoins` | num | `100` |
| `affiliateDailyEarnCapCoins` | num | `2000` (conservative) |
| `affiliateMonthlyEarnCapCoins` | num | `20000` (conservative) |
| `affiliatePerReferredCapCoins` | num | `1000` (conservative) |

Caps are deliberately below rev 2's — they can be raised on evidence; money paid
out on a fraudulent referral cannot be un-paid.

### 7.1 There is no such thing as a string flag (verified, rev 4)

`putConfig` validates every key as:

```ts
if (numericKeys.has(k) ? typeof v !== "number" : typeof v !== "boolean") {
  return json({ error: `bad type for ${k}` }, 400);
}
```

**Only numbers (declared in `numericKeys`) and booleans are storable.** An earlier
rev 4 draft of this table proposed `upiPayoutProvider: "manual_upi"` — that flag
could never have been set, and would have been a textbook fake flag: readable in
`DEFAULTS`, permanently pinned to its fallback in practice. Corrected before it
reached implementation.

Provider selection therefore lives in **three** places, none of them a string flag:

- `upiPayoutAutomationEnabled` (bool) — the brake. `false` = manual only.
- **Env/secret binding** (`UPI_PAYOUT_PROVIDER`, plus provider credentials) — which
  adapter is wired. A deploy-time concern, not a runtime toggle.
- **`upi_payout_requests.provider`** (D1 column) — what actually handled each
  request, so history stays truthful across a provider switch.

Anyone adding a flag for this feature: declare it in `PlatformConfig` **and**
`DEFAULTS` in the same change, add numbers to `numericKeys`, then prove it with
`ALLOW_PROD=1 scripts/flags.sh set <key>=…` returning non-400 and a cache-busted
`/api/config` re-read. A flag the client reads but `config.ts` does not declare is
a fake flag.

---

## 8. Tax and compliance

Affiliate earnings to Indian residents are plausibly **commission income**. The
Income Tax Department's current Section 194H material describes TDS on
commission/brokerage
([ITD PDF](https://www.incometaxindia.gov.in/documents/20117/42998/Section-194H_2026-05-05_12-03-52_4d42fe_en.pdf/727d309f-e83b-36ca-514a-784f96e606ee)),
but the actual treatment depends on the affiliate's legal and tax status.

### 8.1 Do not hardcode a rate (corrected in rev 4)

**No TDS percentage appears anywhere in code, config defaults, or UI copy until a
CA confirms it in writing.** `tds_rate` is `NULL` until then, and
`tax_policy_version` records which approved ruleset produced a given row.

### 8.2 Written CA confirmation required on

- applicable TDS section;
- **whether the tax event is at earn, promotion, or payment** — this is a design
  input, not a detail: §6.1 now has three distinct timestamps (`created_at`,
  `promoted_at`, payout `created_at`) and the answer decides which one is the
  taxable event. The `tax_event` column exists to record it rather than assume it;
- resident vs non-resident affiliates;
- the PAN-missing rate;
- the annual threshold and how it accumulates across a tax year;
- required filings and certificates;
- whether GST registration/invoicing applies to professional affiliates.

### 8.3 Implementation stance

- **Build** `gross_inr_paise`, `tds_rate`, `tds_inr_paise`, `net_inr_paise`,
  `tax_year`, `tax_policy_version`, `tax_event` and the PAN/tax-status fields **now**,
  so the records exist from day one.
- **Do not compute TDS at payout-request time** until the CA fixes the tax event.
  Until then the request stores `tds_rate = NULL`, `tds_inr_paise = 0`,
  `net_inr_paise = gross_inr_paise`, and **real payouts stay blocked**.
- Make the rate and threshold **configuration, not constants**, versioned by
  `tax_policy_version` so a mid-year change is auditable and does not rewrite history.
- **Block real payouts until tax sign-off** — `upiPayoutEnabled` stays `false`.
- **Do not finalise PAN retention, encryption, or masking until the accountant
  specifies them.** Current columns are a minimum, not a design.

Deliverables: per-affiliate payout statement and annual tax statement (CSV + PDF),
reusing `adminTaxExport` in `admin_money.ts`.

---

## 9. UI — AvaWallet design language

**Owner requirement: match the wallet page.** Reuse tokens and widgets verbatim;
introduce no new visual system.

### 9.1 Tokens (`app/lib/features/wallet/wallet_theme.dart`)

"Zine poster on a dark canvas": flat saturated accent fills, **pure-black** borders,
**hard un-blurred offset shadows** (blur 0), pill chips, Nunito w700/w800. It
deliberately does **not** extend `AD` (`core/ui/avatok_dark.dart`) — mixing the two
mid-screen reads as a bug. Same rule here.

| Token | Use |
|---|---|
| `AW.bg` `#0E0E11` | screen background |
| `AW.surf` `#1A1A1F` / `AW.surf2` `#26262D` | cards / popovers |
| `AW.tx` / `txSoft` / `txMute` | text ladder |
| `AW.ink` `#000000` | every hard border + offset shadow |
| `AW.glyph` `#131313` | text ON an accent fill |
| `AW.mint` `#77EDAE` | **available earnings, commission in** |
| `AW.lime` `#BFEB56` | **primary action — Copy link, Withdraw** |
| `AW.coral` `#FE674C` | **withdrawal out, rejected, reversed** (only fill taking white text) |
| `AW.blue` `#A0F7F1` | referred users, click stats, held |
| `AW.lilac` `#CDAEF2` | **pending / qualifying** |

Type: `AWText.walletTitle` (28/800) · `kicker` (11/800 caps) · `balanceHuge`
(56/800) · `statBig` (30/800) · `sectionTitle` (20/800) · `rowTitle` (14.5/800) ·
`rowSub` (12/700) · `amount` (16/800) · `pillLabel` (11/800).

### 9.2 Widgets to reuse (`wallet_widgets.dart`) — build nothing new

`WalletCard` (quiet default; `hardBorder: true` + `Offset(6,7)` for heroes only) ·
`WalletBadge` · `WalletChipTrack` · `WalletTxnRow` · `WalletStatusPill` ·
`WalletInfoRow` · `WalletCircleButton` · `WalletBreakdownBox` ·
`WalletMoneyTilesRow` · `WalletBarChart` · `WalletDonut`.

### 9.3 Screens

**Affiliate Home** (rebuild `affiliate_home.dart` in AW):

1. Hero `WalletCard(hardBorder: true)`, `AW.mint` — lifetime earnings in
   `balanceHuge`; sub-line **available / held / pending**.
2. **Join link card** — URL, QR, two `AW.lime` buttons **Copy** / **Share**. Primary
   action, gets the poster treatment.
3. `WalletMoneyTilesRow` — *Referred users* (`blue`) / *This month* (`mint`).
   Never hand-roll a stretched row (§9.4).
4. `WalletChipTrack` 7D/30D/ALL over `WalletBarChart` of commission by day.
5. `WalletDonut` — available (`mint`) / held (`blue`) / pending (`lilac`).
6. Commission list of `WalletTxnRow`; `WalletStatusPill` carrying
   `pending | held | available | held_review | reversed`.
7. **Pending explainer** — because of §6.1 a new affiliate sees earnings sit in
   *pending* for 30 days with **zero** wallet balance. Without an explicit
   "qualifying until <date>" line and a countdown this reads as a bug and will
   generate support load. State the 30 + 7 day path in plain words.
8. Footer `WalletInfoRow` block stating the lifetime-first-affiliate rule (§6.4).

**Withdraw to UPI:**

- `WalletBreakdownBox` as an equation — `coins × rate = ₹gross`, `− TDS`, `= ₹net` —
  the same "why this much?" idiom the wallet uses for call charges.
- Masked VPA + holder name in `WalletInfoRow`s; `AW.lilac` pill when
  `kyc_status != verified` or a cooldown is active, with the `AW.lime` confirm
  **disabled** and the reason inline.
- **No conversion rate is shown** — India is fixed ₹1 = 1 token (§1.1), so the
  equation reads `1,250 tokens = ₹1,250`. Showing a "rate" would imply one exists
  and could move.

**Payout history:** `WalletTxnRow` + `WalletStatusPill` over the §4.2 states.
Extend the status→colour map inside `WalletStatusPill` (it already centralises
this case-insensitively), never in a screen-local map.

### 9.4 Two build rules

1. **Release-only paint trap.** A stretch `Row` inside a `ListView` gets unbounded
   height and can stop every later section painting **in release builds only** —
   this produced a blank wallet screen once, which is why `WalletMoneyTilesRow`
   exists as a regression-tested boundary. Use it.
2. **Emulator first.** `scripts/dev-emulator.sh` (~200 ms hot reload), not CI.
   Every new screen gets at least one emulator debug run before it is called done.

---

## 10. Launch sequence

1. Fix web + Android attribution incl. Play Install Referrer and signed tokens (§3).
2. Generic join links; test first-click lifetime attribution (§2).
3. **G6 `WalletDO`**: generalised reservation reaper + `type` on
   `consume_reserved` (§4.3, §4.6). *Unit-test both before anything depends on them.*
4. Payout state machine + consume/reconcile protocol + reconciliation cron (§4).
5. Delayed-credit commission lifecycle + caps + clustering (§6).
6. UPI verification + KYC enforcement (§5).
7. **Staging: commissions ON, withdrawals OFF.**
8. Test refunds, duplicate callbacks, chargebacks, suspended affiliates,
   **concurrent payout requests** (409 `policy_mismatch`), **reservation expiry**,
   and **a consume retried after 48 h** (§B2).
9. Manual UPI payouts for a **small allowlist** (`affiliatePayoutAllowlistOnly`).
10. Automated payout-provider integration only after manual accounting is stable.

Tax sign-off (§8) gates step 9, not 1–8. Steps 1–6 change no production money path
while `avaAffiliateEnabled` stays false in prod; step 7 is staging only.

**Step 3 moved ahead of step 4 in rev 3** — the payout rail cannot be correct
until the DO can expire a reservation and label a payout.

---

## 11. Files touched

```
worker/src/do/wallet.ts              G6: reapExpiredReservations(); alarm nextResv
                                     filter; `type` on consumeReserved audit
worker/src/routes/wallet.ts          WalletOperation: type? on consume_reserved
worker/src/routes/affiliate.ts       G1 sentinel; G2 signed token + bind Mode B;
                                     G5 pending-only write + promotion cron
worker/src/routes/upi_payout.ts      NEW — §4.5
worker/src/routes/payout_providers/  NEW — manual_upi | cashfree | razorpayx (§4.8)
worker/src/routes/config.ts          14 flags (10 numeric, 4 bool — NO strings, §7.1)
worker/src/index.ts                  routes + cron wiring
worker/src/hooks.ts / scrubServer    VPA + PAN deny-list (§5.7)
worker/migrations/2026-08-XX-affiliate-upi-payout.sql          NEW (DB_WALLET)
worker/migrations/2026-08-XX-affiliate-commission-status.sql   NEW (DB_WALLET, §6.1)
worker/migrations/2026-08-XX-affiliate-attr-clustering.sql     NEW (DB_META, §6.2)
app/lib/core/deep_links.dart                    /a/<token> + avatok://join
app/lib/core/affiliate_bind_service.dart        NEW — Install Referrer + Mode B + §3.4
app/android/app/src/main/AndroidManifest.xml    pathPrefix /a/ and /i/
app/lib/features/auth/sign_in_screen.dart       call bind, migrate pre-auth token
app/lib/features/affiliate/*                    rebuilt in AW (§9.3)
app/lib/features/payout/upi_withdraw_screen.dart NEW
app/lib/features/wallet/wallet_screen.dart      "Refer & earn" card
app/lib/core/app_registry.dart                  hidden → visible
web/src/islands/admin/PayoutsQueue.tsx          approval + reconciliation tabs
```

**Unchanged on purpose:** the 10% rate, `platform:fees` funding, the 7-day hold
duration, `welcome_bonus.ts`, `reverseAffiliate()`'s clawback maths.

⚠️ `worker/src/do/wallet.ts` is the money authority and is touched by G6. Both
changes are additive and backward-compatible (`type` defaults to `campaign_call`;
the reaper keeps `aijob:` behaviour as one case), but this file gets a dedicated
review pass and unit tests before deploy. **Run `npx tsc --noEmit` in `worker/`
before every deploy — a green wrangler deploy is not a green typecheck.**

---

## 12. Decisions (rev 3 open items — now resolved)

| Rev 3 open item | Resolution |
|---|---|
| **1. Tax treatment** | Configurable, versioned, CA-approved before real payouts. No rate hardcoded. Blocks step 9 only. §8. |
| **2. Payout provider** | Launch manual UPI only; Cashfree Payouts as first automation candidate (VPA validation + verify-and-pay + UTR), RazorpayX as fallback. Behind an adapter so the wallet never couples to a provider. §4.8. |
| **3. FX source** | **Not used.** India is fixed ₹1 = 1 token; `gross_inr_paise = gross_coins × 100`. `fx_rates.ts` stays informational only and must not enter the money path. §1.1. |
| **4. 37-day time-to-cash** | Keep 30 + 7 at launch. Do **not** shorten the qualification window first — if the wait becomes a product problem, shorten only the post-qualification 7-day hold, since qualification has already done the risk work. Rail-specific rules later, on evidence. §6.3. |

### 12.1 Remaining open items

1. **Play Console INR price tiers (§B3)** — confirm each `avatok_topup_*` SKU's
   localised INR price is consistent with ₹1/token, and quantify the store cut
   against the 10% commission. **Verify before enabling payouts.** This is the one
   place where the fixed-price promise and the primary Android rail may disagree.
2. **Cashfree onboarding/compliance** — business entity, KYC, and whether the
   account supports the verify-and-pay flow at the volumes expected. Determines
   when `name_match` stops being `unchecked` (§5.3).
3. **Legacy Stripe Checkout rail** (`walletTopup`) hardcodes `currency: "usd"`
   while `walletTopupIntent` supports INR. Out of scope here, but an Indian user
   hitting the web checkout path gets USD pricing. Worth a separate ticket.
