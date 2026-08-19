# AvaMarketplace production plan: wallet fees + two-party Messenger replay

Date: 2026-08-19  
Status: implementation plan; no production writes or deployment performed  
Target: production, after staging proof and explicit owner approval

## Outcome

Bring the existing marketplace to a production-complete state where:

1. listing publication has a clear, auditable, idempotent AvaWallet fee;
2. users see the price and wallet impact before they publish;
3. agent-to-agent negotiation creates a normal AvaTalk Messenger thread for both buyer and seller;
4. the same completed negotiation card is durable, playable, and visible to both parties;
5. retries cannot double-charge, duplicate messages, or lose one side of delivery;
6. production can be enabled, monitored, paused, and rolled back without hiding random icons.

## Current position

The feature is substantially built, but it is not ready for fee activation or a full production claim.

### Already working

- Production marketplace browsing is reachable and `marketplaceEnabled=true`.
- Production has AI compose and multilingual negotiation enabled.
- AvaWallet spending, transaction statements, Play top-up, and an idempotent WalletDO spend primitive exist.
- Listing publication already calls `consumeListingEntitlement()` immediately before changing a listing to published.
- The implemented price model is five free 30-day listing entitlements per account, then 100 tokens for each additional listing period.
- Negotiation already creates a canonical direct-message conversation and both D1 conversation memberships.
- The app already renders `marketplace_deal` as a Messenger card with transcript and audio controls.
- Buyer-side UI currently inserts a local “agents negotiating” message and polls for the result.

### Production configuration now

| Setting | Current production value | Meaning |
|---|---:|---|
| `marketplaceEnabled` | true | Marketplace is visible |
| `aiComposeEnabled` | true | AI listing composition is available |
| `listingFeeEnabled` | false | Listing deductions are not live |
| `betaFreePremium` | false | Global free-beta bypass is already off |
| `billingEnabled` | false | Subscription billing UI remains off |
| `playTopupEnabled` | true | Android wallet top-up is available |
| `mktI18nNegotiationEnabled` | true | Negotiation translation is enabled |
| `listingBrainEnrichmentEnabled` | false | Listing enrichment is still dark |
| `listingLivenessGate` | false | Listing liveness is not required |
| `identityGatingEnabled` | true | Identity gating is available |

### Evidence from the last 90 days

- `marketplace_opened`: 740
- `listing_pipeline_opened`: 15
- `compose_started`: 6
- `my_listings_opened`: 8
- `wallet_viewed`: 62
- `wallet_balance_loaded`: 79
- `ai_job_blocked_insufficient_tokens`: 1

There is real marketplace discovery traffic, but the seller and publish funnel has barely been exercised. Fee activation must therefore be treated as a new monetized launch, not as a harmless flag flip.

## Blockers found

### P0 — must be fixed before charging or claiming full production

1. **Negotiation audio goes only to the buyer.** The queue consumer explicitly performs one InboxDO append. The seller gets only a bell notification, with FCM disabled.
2. **Queue failures are swallowed.** `handleMktAudio()` catches errors and returns; missing audio also returns normally. Cloudflare therefore acknowledges the job and its retry/DLQ configuration cannot protect failed renders or deliveries.
3. **Marketplace audio authorization is incomplete.** Any authenticated account that learns an `mkt/deal/...` R2 key can fetch it. The route does not verify buyer/seller membership.
4. **Staging cannot prove the audio path.** Staging has no `Q_MKT_AUDIO` producer binding and no `mkt-audio-staging` consumer/DLQ entries.
5. **Message delivery bypasses the normal Messenger delivery path.** Marketplace has duplicate DM creation and raw InboxDO append code, missing normal block/safety checks, deterministic client IDs, standard push behavior, and shared tracing conventions.
6. **No owner approval action exists.** `ask_before_commit` can produce `pending_owner_approval`, but there is no marketplace approve/reject API or seller UI to finish the decision.
7. **Fee renewal and expiry can be bypassed.** Every publish uses entitlement period 1. Archive/restore/re-publish and expiry extension can reuse the first entitlement without a new charge; no renewal route or cron uses period 2+.
8. **Wallet spend and entitlement write are not atomic.** The WalletDO charge happens before the D1 entitlement insert. A D1 failure after a successful spend can temporarily leave a user charged without a recorded entitlement. Idempotency helps a retry, but there is no durable charging state or reconciliation for this exact boundary.
9. **The fee source policy contradicts the code.** Comments say real marketplace charges are paid-token-only, but `chargeAmount()` always sends `allow_free:true`; promo/free coins can therefore be consumed.
10. **The marketplace kill switch is largely a UI switch.** A hidden icon is not a rollback. Server write and negotiation endpoints need independent gates.

### P1 — required for a trustworthy launch

1. The publish screen does not quote the fee/free-slot result before submission.
2. The publish response omits fee source, amount, balance, and entitlement expiry.
3. A listing may be configured for 1, 5, 10, 20, or 30 days while its entitlement is always 30 days. The commercial promise is unclear and can feel unfair for short listings.
4. The app’s marketplace browse cache is not account-scoped; per-viewer state can leak across accounts on a shared phone.
5. Negotiation audio is only memory-cached by the card, not stored local-first in the required per-account media cache.
6. There are effectively no focused automated tests for listing fees, negotiation delivery, replay authorization, or the marketplace card.
7. Existing negotiation telemetry names are present in code but absent from observed PostHog event history; there is no launch dashboard or alerting for incomplete two-party delivery.
8. The staging database is already known to be missing `listings.expires_at`, and local Cloudflare credentials could not read production D1 (`7403 unauthorized`). Schema state must be proven with an authorized release path.

## Recommended product decisions

These choices make the existing work coherent and minimise surprise:

1. **Price:** retain five free active 30-day listing entitlements, then 100 AvaTokens per additional 30-day entitlement.
2. **Listing duration:** make a paid/free entitlement a 30-day publication window. Let sellers archive early, but remove 1/5/10/20-day pricing ambiguity from the main publish flow. A shorter user-selected expiry must not create a fresh free slot or refund automatically.
3. **Funds:** marketplace fees should use paid wallet balance only. Bonus/free daily AI tokens should not buy a real-world marketplace listing. Implement this explicitly rather than relying on comments.
4. **Negotiation charge:** do not add a separate agent-negotiation fee in this launch. Treat bounded negotiation/TTS as included in the listing model until cost telemetry justifies a separate, clearly disclosed price.
5. **Replay:** send the same immutable audio artifact and canonical transcript to both parties so both possess the same record. The envelope can keep per-language transcript variants for reading.
6. **Notifications:** seller receives a normal Messenger notification when the negotiation completes; buyer receives a silent sync/update because they initiated it. Avoid duplicate noisy buyer notifications.
7. **Approval:** when `ask_before_commit=true`, the card is visibly non-binding until the seller approves or rejects. Approval sends a second system event into the same thread for both parties.

## Target architecture

### A. Listing quote and debit

1. Client requests `GET /api/marketplace/listing-quote?listing_id=...`.
2. Server returns the authoritative result: free slots used/remaining, price, allowed funding source, current eligible balance, period, and expiry.
3. Publish request carries a stable `publish_attempt_id`; price remains server-computed.
4. Server validates identity, ownership, moderation, required fields, listing state, and master/write flags.
5. Server creates or resumes a durable entitlement operation keyed by `(listing_id, period)`.
6. WalletDO spends with a namespaced idempotency key such as `listing:<listing_id>:<period>`.
7. Server records the resulting entitlement and publishes the listing.
8. A reconciliation job repairs the small cross-store failure window: wallet-spent/no-entitlement and entitlement/no-published-listing.
9. Response includes `charged`, `source`, `eligible_balance`, `period`, and `entitlement_expires_at`; the app refreshes wallet state.

### B. Agent negotiation to Messenger

1. Buyer taps “Talk to my agent”; server creates a durable negotiation row with `negotiation_id` and status `queued`.
2. Server ensures the canonical DM and both members, with marketplace context carrying the listing and negotiation IDs.
3. Text negotiation completes and stores canonical transcript, translations, outcome, price, and approval state.
4. A staging/prod-specific render queue creates one deterministic/persisted audio artifact.
5. Consumer records the artifact, then invokes one shared internal Messenger delivery service.
6. Delivery appends the same `marketplace_deal` card to both InboxDOs using deterministic IDs:
   - buyer copy: sender is seller;
   - seller copy: sender is buyer;
   - shared logical ID: `mktdeal:<negotiation_id>:v1`.
7. Each side’s delivery timestamp is stored independently. A retry only fills the missing side.
8. Seller gets message FCM; buyer gets silent sync; live socket/Party emission remains an enhancement.
9. Both apps sync the normal Messenger list, so a new chat thread appears without relying on the marketplace screen’s polling loop.
10. Audio playback authorizes the caller against the negotiation participants and caches bytes per account on device.

## Data changes

Add an explicit, forward-only migration. Do not create production tables opportunistically inside request handlers.

### `listing_entitlement_operations`

Suggested fields:

- `listing_id`, `period` composite primary key
- `uid`, `vertical`, `amount`, `funding_policy`
- `wallet_op_id` unique
- `state`: `quoted | charging | charged | entitled | published | failed | refunded`
- `wallet_charged`, `wallet_balance_after`
- `entitlement_expires_at`, `last_error`
- `created_at`, `updated_at`

Keep `listing_entitlements` as the final grant/audit table. The operation table closes the WalletDO/D1 hand-off gap and gives reconciliation a durable source.

### `mkt_negotiation_artifacts`

Suggested fields:

- `negotiation_id` primary key
- `buyer_id`, `seller_id`, `listing_id`, `content_version`
- `outcome`, `approval_status`, `agreed_price`, `currency`
- `transcript_en`, `transcript_i18n`, `summary_i18n`
- `audio_key`, `audio_sha256`, `audio_bytes`, `render_status`
- `buyer_message_id`, `seller_message_id`
- `buyer_delivered_at`, `seller_delivered_at`
- `render_attempts`, `delivery_attempts`, `last_error`
- `created_at`, `updated_at`

Keep private seller mandates out of this table and out of every Messenger envelope.

### Existing table hardening

- Give each negotiation a stable ID rather than relying only on `(buyer_id, listing_id, content_version)`.
- Add participant/ownership indexes needed by the audio route.
- Make listing period selection deterministic from the latest entitlement, never client-supplied.
- Add constraints preventing one listing entitlement from belonging to a different user.

## Implementation work packages

### Phase 0 — repair and baseline staging

Files/configuration:

- `worker/wrangler.toml`
- `consumers/wrangler.toml`
- forward-only D1 migrations

Work:

- Add `Q_MKT_AUDIO -> mkt-audio-staging` to the staging API Worker.
- Add `mkt-audio-staging` and `mkt-audio-dlq-staging` consumers.
- Create/verify staging queues through the environment-safe wrapper.
- Apply the missing listings expiry migration in staging.
- Verify required production migrations read-only through an authorized deployment identity before any flag change.
- Capture baseline queue depth, DLQ, publish errors, wallet reconciliation, and marketplace funnel metrics.

Exit: one staging negotiation can render and reach a test consumer without manual database edits.

### Phase 1 — fee contract and wallet safety

Primary files:

- `worker/src/lib/listing_billing.ts`
- `worker/src/feature_pricing.ts`
- `worker/src/routes/listings.ts`
- `worker/src/routes/compose.ts`
- `worker/src/routes/wallet_statement.ts`
- new migration and reconciliation module

Work:

- Add an explicit `allowFree`/funding policy to wallet charging; set marketplace listing fees to paid-only.
- Namespace wallet operation IDs and preserve deterministic period IDs.
- Add durable operation state and reconciliation around charge -> entitlement -> publish.
- Implement fee quote endpoint and return fee metadata from both classic and AI-compose publish routes.
- Implement renewal/extension rules. Direct expiry extension and archive/restore cannot silently reuse period 1 after entitlement expiry.
- Define cancellation policy: no automatic refund after successful publication; automatic idempotent refund only when a platform failure charges but cannot publish and reconciliation cannot complete publication.
- Make wallet-ledger enqueue durable/retryable rather than best-effort for monetized marketplace spends.
- Keep live event/consult payment models outside this listing fee unless separately approved.

Exit: repeated publish, timeout, concurrent taps, WalletDO retry, and D1 failure produce at most one debit and one entitlement.

### Phase 2 — normal Messenger delivery for both parties

Primary files:

- `worker/src/routes/marketplace.ts`
- `worker/src/routes/messaging.ts`
- `worker/src/lib/delivery.ts`
- `consumers/src/mkt_audio.ts`
- `consumers/src/types.ts`
- `worker/src/do/inbox.ts`

Work:

- Replace marketplace’s private `ensureDmThread` and raw append flow with a shared internal system-DM delivery contract.
- Preserve the marketplace context while applying block/safety and valid-listing checks.
- Persist negotiation/artifact status before queueing.
- Use deterministic audio/artifact and message IDs.
- Deliver identical cards to buyer and seller, tracking each result separately.
- Throw on render or incomplete delivery failures so queue retry and DLQ actually work.
- Make ETA messages idempotent and visible only where intended.
- Add a real DLQ alert/replay path; do not silently acknowledge poison jobs.
- Add seller message push and buyer silent sync.
- Keep the client polling fallback temporarily, then remove or shorten it only after push/sync telemetry proves reliable.

Exit: with both apps killed, one negotiation causes one new Messenger thread/card on each account after reopen, with no duplicates after forced retries.

### Phase 3 — approval and replay security

Primary files:

- `worker/src/routes/marketplace.ts`
- route registration in `worker/src/index.ts`
- `app/lib/features/avatok/chat_thread/cards.dart`
- `app/lib/features/avatok/chat_thread/special_content.dart`
- `app/lib/core/listings_api.dart`

Work:

- Add seller-only approve/reject endpoints with idempotency and terminal state validation.
- Render Approve/Reject controls only for the seller and only while pending.
- Append the final approval/rejection event to both copies of the same thread.
- Authorize audio by persisted buyer/seller membership, not by key prefix.
- Return short-lived or streamed audio only after authorization.
- Store negotiation audio in the per-account media cache; clear it with account-scoped data.
- Scope marketplace browse/cache state by `AccountScope.id`.

Exit: unrelated authenticated users receive 403 for negotiation audio, and approval state converges on both devices.

### Phase 4 — user-facing fee experience

Primary files:

- marketplace listing form/pipeline screens
- AI compose review/publish screen
- `app/lib/core/listings_api.dart`
- wallet navigation and statement presentation

Work:

- Show “Free listing X of 5” or “100 AvaTokens for 30 days” before the final button.
- Show eligible paid balance and a direct top-up action when insufficient.
- Never deduct during draft creation, AI assistance, validation, or moderation failure.
- On successful publish, show the exact deduction and new wallet balance.
- On 402, retain the draft and return to the same final step after top-up.
- On 503/timeout, say the result is being checked; do not invite repeated taps until idempotency status is resolved.
- Give all marketplace entry points one consistent navigation/gating rule instead of hiding icons independently.

Exit: a non-technical user can predict the charge before publishing and can recover from insufficient balance without losing work.

### Phase 5 — observability, automated tests, and support tools

Tests to add:

- free listings 1-5; paid listing 6; free quota expiry;
- paid-only balance behavior;
- double tap, concurrent publish, request timeout, charge success/D1 failure, retry, and refund reconciliation;
- expiry/renewal, archive/restore, and edit-extension attempts;
- two InboxDO deliveries, one-side failure/retry, queue render failure, DLQ replay, deterministic IDs;
- block/safety behavior and invalid listing participants;
- audio authorization for buyer, seller, and unrelated user;
- pending approval, approve/reject races, and terminal-state idempotency;
- two-account device cache isolation and local replay;
- Messenger preview/card rendering and killed-app sync.

Telemetry/events:

- `listing_fee_quote_viewed`
- `listing_publish_started`
- `listing_fee_charge_succeeded|failed|reconciled|refunded`
- `listing_publish_succeeded`
- `negotiation_queued|completed`
- `negotiation_audio_render_succeeded|failed`
- `negotiation_delivered` with `buyer_delivered`, `seller_delivered`, latency, attempt
- `negotiation_delivery_reconciled`
- `negotiation_audio_played|forbidden`
- `negotiation_approved|rejected`

Every server event should include account ID, app/service, listing/negotiation ID, environment, build/revision, and trace ID; user contact enrichment should retain the test account email/phone when available under the existing telemetry policy.

Dashboard/alerts:

- quote -> publish -> charge -> published funnel;
- 402 rate and top-up recovery;
- wallet charge without entitlement/publish;
- two-party delivery completion percentage and p50/p95 latency;
- render failure, retry, DLQ age/depth;
- audio 403/404 rate;
- approval pending age;
- client crash/error by build.

Exit: forced failures are visible and support can replay or reconcile them without direct database editing.

## Staging acceptance script

Use two normal test accounts plus one unrelated account.

1. Publish five listings: all free, each with a distinct entitlement.
2. Quote listing six: 100 paid tokens and the correct eligible balance.
3. Publish listing six: exactly one wallet deduction, statement row, entitlement, and published listing.
4. Repeat the same request and force a client timeout: no second deduction.
5. Try with insufficient paid balance: listing remains draft and no entitlement is consumed.
6. Top up and retry the same draft: it publishes once.
7. Attempt archive/restore and expiry extension: entitlement/renewal policy is enforced.
8. Run a deal negotiation and an impasse negotiation with both apps backgrounded.
9. Confirm both accounts receive the same thread and one replay card; play and reopen it offline from each account.
10. Force buyer delivery failure, then seller delivery failure: retry fills only the missing side.
11. Force TTS failure: job retries, lands in DLQ after exhaustion, alerts, and can be replayed.
12. Confirm unrelated account cannot fetch audio.
13. Exercise pending approval, approve, reject, and repeated action attempts.
14. Switch accounts on one phone: no marketplace cache or audio crosses account boundaries.
15. Observe for at least 48 hours with fee deductions enabled only for the two allowlisted staging accounts.

## Production rollout

Production remains live; every production write requires explicit owner confirmation.

1. Merge code and forward-only migrations through the normal staging -> main path.
2. Apply production migrations with `listingFeeEnabled=false` and new publish/negotiation write switches off.
3. Deploy API Worker, consumers, and app code dark. Do not copy staging data or KV blobs to production.
4. Run read-only schema, queue binding, DLQ, wallet reconciliation, and route checks.
5. Enable new Messenger delivery for an owner/test allowlist; keep fee deduction off.
6. Prove both-party delivery, replay authorization, push/sync, and approval on production test accounts.
7. Ramp Messenger delivery: 5% -> 25% -> 100%, with automatic halt on incomplete-delivery or DLQ thresholds.
8. Enable listing fee quotes for everyone while deduction remains off, so wording and quote telemetry can be verified.
9. Enable real deductions for an allowlist, then 5% -> 25% -> 100% of eligible sellers.
10. Keep the first five free entitlements and paid-only policy visible in every confirmation.
11. Hold each monetary ramp for at least 24 hours; require zero unexplained wallet/entitlement mismatches before increasing.
12. Only after 100% stability, remove legacy buyer polling and old duplicate marketplace delivery helpers.

No build or deployment is part of this plan document. A production Android release must use the repository’s explicit production workflow when separately requested.

## Rollback

Use independent server flags, not icon hiding:

- `marketplacePublishEnabled=false`: stop new publication, keep browse and existing listings readable.
- `listingFeeEnabled=false`: immediately stop new deductions without disabling marketplace use.
- `marketplaceNegotiationEnabled=false`: stop new negotiations, keep existing threads/replays readable.
- `marketplaceDealDeliveryV2=false`: return to the prior delivery path only if it is safe; never delete already-delivered messages.
- Keep audio authorization active during rollback.
- Drain/replay queues only after identifying whether messages are pre- or post-V2.
- Reconciliation continues even while charging is off.
- Refund only verified charged-but-unpublished failures using the original wallet operation reference.

## Definition of full production

The marketplace is fully production-ready only when all are true:

- server-side flags control browse, publish, negotiation, and fees independently;
- fee quote matches the actual debit and wallet statement;
- no tested failure produces a double charge or charge without eventual publish/refund;
- renewal and archive/restore cannot bypass fees;
- buyer and seller each receive exactly one durable Messenger replay card;
- replay audio is participant-authorized and account-cached;
- pending deals can be approved/rejected and both sides converge;
- staging and production queue bindings/DLQs are verified;
- automated contract/integration/widget tests pass in CI;
- launch dashboard and alerts are live;
- staged production soak meets the monetary and delivery error thresholds.

## Suggested issue sequence

1. `[MKT-PROD-01] Repair staging schema and marketplace audio queues`
2. `[MKT-PROD-02] Add durable listing fee operation and paid-only policy`
3. `[MKT-PROD-03] Add fee quote, response metadata, and renewal enforcement`
4. `[MKT-PROD-04] Persist negotiation artifacts and authorize replay audio`
5. `[MKT-PROD-05] Deliver negotiation cards idempotently to both Messenger inboxes`
6. `[MKT-PROD-06] Add queue retry, DLQ alert, replay, and delivery reconciliation`
7. `[MKT-PROD-07] Add seller approval/rejection in Messenger`
8. `[MKT-PROD-08] Add account-scoped media/cache behavior and fee UX`
9. `[MKT-PROD-09] Add tests, PostHog dashboard, alerts, and release runbook`
10. `[MKT-PROD-10] Execute allowlisted production ramp and final cleanup`

## Estimated delivery shape

This is approximately 9 focused implementation issues plus one controlled rollout issue. The highest-risk work is the cross-store wallet transaction boundary and exactly-once two-party Messenger delivery. Those should be completed before UI polish or fee activation.
