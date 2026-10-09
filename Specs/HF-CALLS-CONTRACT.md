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
