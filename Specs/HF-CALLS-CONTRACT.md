# HF-CALLS-1: masked paid calls, presence, notify-me, reviews (contract, owner-approved 2026-10-09)

Owner decisions:
- Vobiz is the provider. The owner buys one Indian number → secret/var `HF_CALL_DID` (E.164).
- Testing uses admin-added **test credits**. Real top-up comes later; `MONEY_IN_DISABLED` stays as is.
- A busy or offline host shows **Notify me** (WhatsApp). There is no queue.

Everything is dark behind flag `hfCallsEnabled` (default false), added to PlatformConfig and DEFAULTS in `worker/src/routes/config.ts`. Start returns 503 `calls_not_ready` when `HF_CALL_DID` or the Vobiz secrets are missing.

## Rules (from Specs/RULEBOOK-HELLO-FRAANDS.md — follow exactly)

**Call flow**
1. The host rings first and hears: "Call from <caller handle>. <N> previous calls with you. Press 1 to accept, 2 to decline." 10 s of silence counts as a decline.
2. On accept, the caller is dialled.
3. Both hear the safety notice: "This is a friendly chat, not counselling. In crisis, dial 14416. Press hash at any time to end the call and block."
4. Then the two legs are joined in a conference. Both legs present the platform number, so neither side ever sees the other's number.
5. `#` from either side ends the call, blocks the other person and logs an incident.

**Recording:** none. No audio and no transcripts; metadata only.

**Billing**
- Per started minute of connected time (from both-joined to end). Ringing, decline or failure costs ₹0.
- The caller needs ≥ 2 minutes of balance at the host's rate to start.
- Max call length = min(60 min, floor(balance / rate) minutes), with a spoken warning 60 s before the limit.
- The balance never goes negative.
- Host share per minute = rate − (2 + 0.4 × (rate − 2)). At ₹5/min that's ₹1.80; in paise use integer math.
- **Test credits vs paid money [HF-WALLET-1]:** test credits (admin-added) live in D1 `hf_credits` / `hf_credit_ledger`, never in the WalletDO paid balance, and are spend-only. At call start test credits are held first (up to a 60-minute call); the paid wallet reserves only the shortfall of the 2-minute start reserve. At settle `testUsed = min(testHeld, charge)`, `paidUsed = charge − testUsed`; only `paidUsed` is consumed from the wallet and the unused test hold is returned. The host share splits the same way: `hostPaid = floor(hostTotal × paidUsed / charge)` is earned to the host wallet (7-day hold, commission on the paid part); `hostTest = hostTotal − hostPaid` goes to `hf_host_test_earnings` and is never withdrawable. `hf_calls` records `paid_rupees`, `test_rupees`, `host_paid_rupees`, `host_test_rupees`. Every step is idempotent (op ids `hfres:<callId>`, `hfset:<callId>`, `hfcall:<callId>:*`, UNIQUE `hf_host_test_earnings.call_id`).

**Blocks:** a block always shows to the blocked person as "host isn't available".

## D1 tables (DB_META; agents write their own migration files, CREATE TABLE each in its own file)

**hf_calls** (calls agent): `id TEXT PK`, `caller_uid`, `host_uid`, `rate_paise INTEGER`, `status`, `lane TEXT NULL`, timestamps (`created_at`, `host_answered_at`, `connected_at`, `ended_at`), `billed_minutes INTEGER`, `charged_paise INTEGER`, `host_earning_paise INTEGER`, `end_reason`, `host_leg_uuid`, `caller_leg_uuid`, `conference_name`.
- `status`: ringing_host | host_declined | no_answer | ringing_caller | caller_no_answer | connected | completed | failed | blocked.
- `end_reason`: caller_hangup | host_hangup | hash_block | time_limit | balance | error.

**hf_blocks** (calls agent): `blocker_uid`, `blocked_uid`, `call_id`, `created_at`, PRIMARY KEY (`blocker_uid`, `blocked_uid`).

**hf_incidents** (calls agent): `id`, `call_id`, `reporter_uid`, `kind` ('hash_block'), `created_at`. Kept 1 year.

**hf_hosts**: new columns `presence TEXT DEFAULT 'offline'` (offline | online | busy) and `presence_at INTEGER` (calls agent migration, ALTER).

**hf_lane_access** (phase-1 agent, other worktree): `uid`, `lane` ('women' | 'lgbtq'), `verified_at`, PRIMARY KEY (`uid`, `lane`).
- Calls must check it: if the host's `women_lane=1`, the caller must have a 'women' row; if the call request has `lane='lgbtq'`, the caller must have an 'lgbtq' row.
- Read it with a plain SQL query and treat a missing table as no access.

**hf_reviews** (reviews agent): `id`, `call_id UNIQUE`, `caller_uid`, `host_uid`, `stars 1..5`, `text`, `topic`, `status` (pending | approved | rejected), `reject_reason`, `created_at`, `decided_at`.

**hf_review_tokens** (reviews agent): `token PK`, `call_id`, `expires_at`.

**hf_notify** (reviews agent): `caller_uid`, `host_uid`, `created_at`, `notified_at`, PRIMARY KEY (`caller_uid`, `host_uid`).

## Worker API (all JSON, Clerk bearer auth unless noted, errors `{error, message}`)

### Calls agent
- **`POST /api/hf/calls`** with `{hostSlug, lane?}` → 200 `{ok, callId, status:"ringing_host", rate, maxMinutes}`.
  - Errors:
    - 401
    - 403 `not_verified` (caller has no verified WhatsApp number)
    - 403 `lane_required` (with `lane`)
    - 409 `host_unavailable` (offline, busy, not live, or blocked either way; always the same message, "This host isn't available right now.")
    - 402 `low_balance` (`{needed, balance}`)
    - 409 `call_in_progress` (caller already in a call)
    - 503 `calls_not_ready`
  - The caller's receiving number is their verified WhatsApp number (from the existing contact_verification / users phone; grep how WhatsApp-verified numbers are stored). The host's number is the host's verified WhatsApp phone.
- **`GET /api/hf/calls/:id`** (caller or host) → `{id, status, hostSlug, hostName, rate, connectedAt, endedAt, billedMinutes, chargedRupees, endReason, canReview}`. Used for polling every 2 s.
- **`POST /api/hf/calls/:id/cancel`** (caller, before connect).
- **`GET /api/hf/wallet`** → `{balanceRupees, testCredits:true}`.
- **`PUT /api/hosts/me/presence`** with `{online:boolean}` → `{ok, presence}`. Host must be live. Going online calls `notifyHostOnline(env, ctx, hostUid)` from `worker/src/lib/hf_notify.ts` (reviews agent writes it; the calls agent imports it — create a stub with that signature if absent and say so).
- **Auto-offline:** the existing scheduled() cron sets presence offline after 8 h without a heartbeat. **`POST /api/hosts/me/presence/beat`** refreshes it while the dashboard is open.
- **`GET /api/hosts/me/calls`** → recent calls for the host dashboard (no caller numbers, handle only).
- **Admin**
  - `POST /api/admin/hf/wallet/credit` with `{uid, rupees (1..2000), note}` adds test credits to `hf_credits` (spend-only; no WalletDO credit), audited; the response also returns `testBalance`.
  - `POST /api/admin/hf/wallet/migrate-test-credits` `{dry_run?: true}` one-off: moves earlier wallet `hf_test_credit` credits (capped at the paid balance) into `hf_credits` (op ids `hfmig:<uid>`); lists hosts whose earlier earnings cannot be classified.
  - `GET /api/hf/wallet` → `{paidBalance, testBalance, spendable, host?: {heldRupees, availableRupees, testEarningsRupees, lifetimePaidEarnings}, history[]}` (legacy `balanceRupees` kept).
  - `GET /api/admin/hf/calls` → list.
- **Vobiz webhooks** under `/api/hf/vobiz/<VOBIZ_WEBHOOK_SECRET>/...` (answer/host, digits/host, answer/caller, conference events, hangup), with XML responses in the Plivo/Vobiz dialect, mirroring `lib/campaign_handover.ts` and `lib/vobiz_provider.ts`. State lives in a Durable Object **`HfCallDO`** (one per call, alarms for the warning and the time limit). Add the DO binding + migration tag in wrangler.toml, mirroring existing DO declarations exactly.
- **Billing ops through WalletDO**
  - reserve 2 minutes at start;
  - on end, consume `billed_minutes × rate` (capped at balance) and release the rest;
  - earn the host share to the host's wallet with a hold;
  - unique op_ids per call.
- **Public host JSON**: `status` comes from presence (online | busy | offline) and no longer from the hardcoded 'offline'.
- **Events:** hf_call_started, hf_call_host_answered, hf_call_connected, hf_call_ended `{billed_minutes, end_reason}`, hf_call_blocked.

### Reviews agent
- **`lib/hf_notify.ts`**
  - `notifyHostOnline(env, ctx, hostUid)` sends a WhatsApp to every subscriber of that host (the existing whatsapp_send helper): "<Name> is online now on <brand>. Call: <brandUrl('/h/'+slug)>". At most 1 per subscriber per 24 h; set `notified_at`, then delete the subscription.
  - `POST /api/hf/hosts/:slug/notify` → `{ok, subscribed:true}` (caller must have a verified WhatsApp).
  - `DELETE /api/hf/hosts/:slug/notify`.
  - `GET /api/hf/hosts/:slug/notify` → `{subscribed}`.
- **`lib/hf_reviews.ts`**
  - `onCallCompleted(env, ctx, call)` is called by the calls agent at the end of every call with `billed_minutes ≥ 1`. It creates a review token (7 days) and WhatsApps the caller: "How was your call with <Name>? <brandUrl('/review/'+token)>".
  - `GET /api/hf/review/:token` (no auth) → `{hostName, hostSlug, callDate, minutes, alreadyReviewed}`.
  - `POST /api/hf/review/:token` with `{stars, text (≤500, contact details blocked via contactLeak → 422 contact_details), topic?}` → `{ok}`.
  - Also `POST /api/hf/calls/:id/review` with the same body (signed-in caller, call completed, within 7 days).
- **Admin**
  - `GET /api/admin/hf/reviews?status=pending`
  - `POST /api/admin/hf/reviews/:id` with `{decision:"approve"|"reject", reason?}`
  - Both audited.
- **Public aggregates** (in `hf_hosts_public` list + detail): `rating` (avg of approved, 1 decimal or null), `reviewCount`, `ratingBreakdown {5,4,3,2,1}`, `talkedTo` (distinct callers with completed calls), `regulars` (callers with ≥ 3 completed calls).
  - Detail only: `reviews` (latest 10 approved) as `[{firstName, stars, text, topic, minutes, regular:boolean, date}]`. The first name comes from the caller's display name; fall back to "A caller".
- **Events:** hf_review_submitted, hf_review_decided, hf_notify_subscribed, hf_notify_sent.

### Web agent
- **Call buttons** on LiveHostCards, `/h/[slug]` (side rail + mobile bar):
  - "Call ₹X/min" when online.
  - "Busy — Notify me" / "Offline — Notify me" otherwise (toggle subscribe; "We'll WhatsApp you").
  - If signed out → sign-in.
- **Call flow UI** (dialog or `/call/[id]` page):
  1. Confirm sheet: rate, balance, max minutes, the safety notice, and "Your number stays hidden".
  2. Start, then show polling states:
     - "Ringing Priya…"
     - "Priya accepted — we're calling your phone now. Pick up!"
     - "Connected · 03:12 · ₹15 so far"
     - "Call ended · 4 min · ₹20"
  3. Errors mapped to friendly copy: low balance → "Add balance" (shows "Test credits only for now"); lane_required → link to `/verify/lane`.
- **Wallet chip:** balance in the header or on the call sheet (`GET /api/hf/wallet`).
- **Host dashboard** `/hosts/dashboard` (noindex, sign-in):
  - big Online/Offline toggle (PUT presence) with a heartbeat every 5 min while open;
  - today's calls, minutes and earnings;
  - recent calls list.
  - Link to it from the onboarding Done step.
- **Review page** `/review/[token]`: stars, text and a topic chip (from TOPICS), no sign-in.
- **Ratings on profiles:** stars + count on cards; breakdown + review list on `/h/[slug]`.
- **Admin**
  - Reviews moderation at `/admin/hosts/reviews` (nav key `host-reviews` under group "Hosts").
  - Test credit form + calls list at `/admin/hosts/calls` (nav key `host-calls`).
- Respect `hfCallsEnabled` from `/api/config`. When off, keep today's disabled "Calls open soon" buttons.

### Payouts (HF-PAYOUT-1, flag `hfPayoutsEnabled`, manual: request, admin approves, owner pays by hand and enters the UTR)
Table `hf_payout_requests` (DB_META, `migrations/2026-10-09-hf-payouts.sql`): `id, host_uid, amount_rupees, status requested|approved|paid|rejected|cancelled, bank_snapshot {accountLast4, ifsc, name} (never the full account), wallet_ref hfpayout:<id>, utr, reject_reason, admin_uid, withdrawable_at_request, created_at, updated_at, approved_at, paid_at`.
Withdrawable = min(WalletDO paid balance after maturing holds minus open reservations, sum of `hf_calls.host_paid_rupees` for calls ended 7+ days ago minus all requested/approved/paid requests). NULL `host_paid_rupees` (pre-HF-WALLET-1) counts as 0; test earnings never count.
- **`GET /api/hosts/me/payouts`** → `{enabled, minRupees, maxPerWeek, holdDays, hostStatus, kycOk, bankOk, bank:{accountLast4, ifsc}|null, withdrawable, held, testEarnings, requests:[{id, amount, status, accountLast4, ifsc, utr (paid only), reason (rejected only), createdAt, updatedAt, paidAt}]}`.
- **`POST /api/hosts/me/payouts`** `{amount}` with `Idempotency-Key` → `{ok, id, status:"requested", amount}`. Reserves the amount in the WalletDO (`reserve`, `allow_free:false`, ref `hfpayout:<id>`, op `hfpayout_res:<id>`). Errors `{error, message, withdrawable?}`: 404 `not_enabled`, 403 `not_live`, 409 `kyc_required`, 409 `bank_required`, 400 `invalid_amount`, 400 `below_minimum`, 429 `weekly_limit`, 402 `insufficient_withdrawable`, 502 `wallet_error`.
- **`POST /api/hosts/me/payouts/:id/cancel`** → `{ok, status:"cancelled"}` (only while `requested`; releases the reservation; 409 `not_cancellable`).
- Admin (ADMIN_UIDS): **`GET /api/admin/hf/payouts?status=requested|approved|paid|rejected|cancelled|all`** → `{items, counts}`; **`GET /api/admin/hf/payouts/:id/destination`** → full account/UPI (audit-logged; 409 `bank_changed` if the host changed bank after asking); **`POST .../approve`**; **`POST .../paid`** `{utr 6-30 alphanumeric}` (consumes the reservation, op `hfpayout_pay:<id>`; 409 `invalid_state` unless approved, 409 `duplicate_utr`, 409 `needs_reconciliation`); **`POST .../reject`** `{reason}` (releases). All repeat safely (a repeat answers `{ok, status, replay:true}`). Paid and rejected notify the host by WhatsApp, best effort.

### Refunds and account closure (HF-WALLET-EXIT-1, flags `hfRefundsEnabled` (dark), `hfRefundWindowDays` 180, `hfExitGateEnabled` (on))
Migration `migrations/2026-10-10-hf-wallet-exit.sql`: `hf_refund_requests(id, uid, amount_rupees, status requested|approved|processing|refunded|failed|rejected|cancelled, reason, wallet_ref hfrefund:<id>, allocations JSON [{topupId|null, rupees, status pending|refunded|manual|failed, gatewayRefundId?, error?}], utr, admin_uid, exit, created_at, updated_at, refunded_at)`, `hf_exit_requests(uid PK, status waiting_hold|waiting_payouts|ready|done|cancelled, requested_at, updated_at, payout_id, refund_id, note)`, plus `hf_topups.refunded_rupees` and `hf_payout_requests.exit` (the ALTERs run once). Rulebook HF-PAY-14, HF-PAY-15.
- **`GET /api/hf/wallet/refunds`** → `{enabled:false, requests:[]}` while off (the page shows nothing), else `{enabled, windowDays, refundable, eligible, requests:[{id, amount, status requested|processing|refunded|rejected|cancelled, reason (rejected), utr (refunded), exit, createdAt, updatedAt, refundedAt}]}`.
- **`POST /api/hf/wallet/refunds`** `{amount?}` with `Idempotency-Key` → `{ok, id, status:"requested", amount}`; omitted amount = everything refundable. Reserves the amount in the WalletDO (`allow_free:false`, ref `hfrefund:<id>`). Errors: 404 `not_enabled`, 400 `invalid_amount`, 402 `insufficient_refundable`, 402 `nothing_refundable`, 502 `wallet_error`.
- **`POST /api/hf/wallet/refunds/:id/cancel`** (only while `requested`; 409 `not_cancellable`; 409 `exit_request` for a closure refund).
- Admin: **`GET /api/admin/hf/refunds?status=requested|approved|processing|failed|refunded|rejected|cancelled|all`** → `{items:[{..., allocations}], counts}`; **`POST .../:id/approve`** and **`.../retry`** (one gateway `refund()` per top-up slice, opId `hfrefund:<id>:<topupId>`; slices already refunded are skipped; all done -> `consume_reserved` op `hfrefund_pay:<id>` -> `refunded`; any failure -> `failed` with per-slice error, 409 `in_progress` while running); **`.../reject`** `{reason}` (releases; 409 `partly_refunded` once any slice went out); **`.../paid-manually`** `{utr}` (marks open slices `manual`, consumes the reservation; 409 `duplicate_utr`, `needs_reconciliation`). All repeat safely (`replay:true`). A gateway "refunded" webhook for an `hftop_` order never debits the wallet again.
- **`GET /api/hf/account/exit`** → `{gateEnabled, decision:"delete"|"exit", paidBalance, withdrawable, held, heldReleaseAt, refundable, manualRefund, forfeitRupees, bankOk, testCredits, testEarnings, exit:{status,payoutId,refundId,note,requestedAt}|null, payout|null, refund|null, deletion|null}`.
- **`POST /api/hf/account/exit`** `{forfeit?}` with `Idempotency-Key` → `{ok, status, payoutId, refundId}`; creates the final refund (no 180-day limit; money no gateway can carry is a manual-only slice) and, for a host with a verified bank and nothing in the hold, the final payout (`hf_payout_requests.exit=1`: no minimum, no weekly cap). Errors: 409 `nothing_to_settle`, 409 `forfeit_required {forfeitRupees}` (no verified bank, or money nothing accounts for), 502 `wallet_error`. **`DELETE`** cancels (409 `cannot_cancel` once anything is approved).
- **`POST /api/account/delete`** now answers **409 `{scheduled:false, deferred:true, reason:"settle_money_first", exit_url:"/account/close"}`** while the user has real HF money (and 503 `try_again` if an HF user's wallet cannot be read). Users with no real money get the old `{scheduled:true}`. The cron (`runHfExitCron`, inside `scheduled()`) advances `waiting_hold` -> final payout when the hold ends -> `scheduleDeletion()` when every payout/refund is paid/refunded/rejected.
### Spend limits, receipts and reconciliation (HF-WALLET-LIMITS-1; rules HF-PAY-7, HF-PAY-16, HF-PAY-17)
Flags (PlatformConfig): `hfDailySpendLimitRupees` 2000, `hfMonthlySpendLimitRupees` 15000, `hfTopupConfirmAboveRupees` 1000 (also in `/api/config` as `hfTopup.confirmAboveRupees`), `hfGstin` "", `hfLegalName`, `hfLegalAddress`, `hfStateCode` (two digits), `hfInvoicePrefix` "HF". Empty `hfGstin` = receipts only; set it and monthly tax invoices start (config only, no deploy).
Tables (DB_META, `migrations/2026-10-10-hf-wallet-limits.sql`): `hf_spend_limits(uid PK, daily_rupees, monthly_rupees, note, admin_uid, updated_at)` (per-user override, NULL column = default); `hf_receipts(id hfr_<32 hex>, number UNIQUE, uid, kind receipt|tax_invoice, source topup|statement|call, source_id, amount_rupees, taxable_paise, gst_paise, gstin, issued_at, data JSON)` unique per (kind, source, source_id); `hf_doc_counters(series PK "R/2026-27" | "I/26-27", next)`; `hf_calls.limit_cap_rupees` (paid money a call may still spend while in progress; the code works without it until migrated).
- **Limits.** Spent = sum of `hf_calls.paid_rupees` (caller) since IST 00:00 today / the 1st, plus `limit_cap_rupees` of calls in progress. `POST /api/hf/calls` caps the paid funds a call may use at min(paid available, day left, month left); `maxMinutes` follows, `limitReason` becomes `spend_limit` (stored as `end_reason`) when the limit is what ends the call. Test credits are never capped. If the paid part of the 2-minute minimum does not fit, **403 `{error:"spend_limit", reason:"spend_limit", period:"day"|"month", message, resetsAt?}`** (checked after the `low_balance` test, so an empty wallet still says `low_balance`).
- **`GET /api/hf/wallet`** gains `limits: {daily, monthly, spentToday, spentThisMonth, resetsAt}` (omitted if it cannot be computed).
- **Receipts.** `settleHfTopup` issues a receipt right after the wallet credit (idempotent by top-up id; a miss is healed when the caller opens /wallet). `GET /api/hf/wallet/receipts` → `{ok, invoicing, receipts:[{id,number,kind,source,amountRupees,issuedAt}]}`; `GET /api/hf/wallet/receipts/:id` → printable HTML (owner only, Bearer auth, so the web fetches it and opens it in a new tab). The cron (any tick on IST days 1-5) issues the previous month's tax invoices when `hfGstin` is set: taxable = (paid − host paid share) ÷ 1.18; CGST+SGST 9/9 (caller state unknown → intra-state), IGST when states differ.
- **Admin** (ADMIN_UIDS): `GET /api/admin/hf/limits/:uid` → `{defaults, override|null, effective, spentToday, spentThisMonth, resetsAt}`; `PUT /api/admin/hf/limits/:uid {dailyRupees?, monthlyRupees?, note}` (null clears a column, omitted keeps it; note required; audit `hf_spend_limit_set`). UI: "Spending limit" on each user row at `/admin/hosts/calls`.
- **Reconciliation.** `GET /api/admin/hf/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]` (IST, inclusive, max 93 days, default last 7): `{days:[{date, topups:{count,rupees,byGateway}, walletCredits, calls:{paid,test}, hostEarnings:{paid,test}, platformShare:{paid,test}, payouts, refunds|null}], totals, mismatches:[{kind paid_without_credit|credit_without_paid_topup|amount_difference, topupId, uid, topupRupees, creditRupees, detail, at}], payouts[], refundsAvailable, liabilities}`. Wallet credits come from `wallet_transactions` (DB_WALLET) type `hf_topup`, ref `hftop:<id>`; paid top-ups younger than 30 minutes are not flagged (audit queue lag). Refunds are read defensively from `hf_refund_requests` (status paid; null when that table is absent). Page `/admin/hosts/reconciliation` (nav key `host-reconciliation`).
