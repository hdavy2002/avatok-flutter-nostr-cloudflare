# HDFC UPI SMS — revised implementation plan

Date: 2026-09-18. Status: **approved for implementation and deployment by the owner on 2026-09-18**.
Owner also authorized required migrations, GitHub Actions builds and release approvals;
Android format/environment selection remains subject to the project build widget.
Astra source audit: `Specs/AUDIT-HDFC-UPI-SMS-REPLAN.md`.
Baseline: `c06a87b29c75fc0f77d786cdb6c5639637d5d76c` (main).
The prior broad implementation remains isolated, uncommitted and undeployed under
`/Users/davy/.cache/deepastra/hdfc-20260918/`. Do not integrate it wholesale.

## Decisions and limits

1. HDFC SMS is a web-only, administrator-only ₹1 internal test. Delete commercial
   creation/provisioning and picker integration. No Flutter checkout is added; existing
   app billing/Razorpay paths remain outside this task. Future app support needs a new decision.
2. Keep the scope small: no finance console, case/audit ledger, legacy backfill service,
   retention engine, heartbeat replay store, health-based checkout gate or new alerting.
3. **Do not equate a unique receipt with a proven payer.** One pending QR and one ₹1 SMS
   cannot distinguish an unrelated transfer or a late payment to a replaced QR. Signed
   phone receipt time is not bank settlement time and does not identify a browser.
4. Confirmation must correlate to stored evidence. Read-only production inspection on
   2026-09-18 found two stored SMS messages: neither echoes the QR tr=AV… or tn note.
   Both contain `(UPI <12 digits>)`. For this observed format, UTR entry remains optional
   to create/pay/observe, but required before showing attributed **confirmed**. No
   amount/time-only confirmation. A future supported SMS format may allow automatic
   attribution only if verified evidence echoes the exact intent-specific reference;
   that is not assumed or implemented without a fixture and explicit contract update.
5. Keep one small legacy HDFC refund rejection even after deleting commercial creation.
   Existing rows may survive; removal cannot prove that no old money needs reconciliation.
6. No production changes, CI dispatch or builds are authorized by approving this document.
   Production rollout needs its own explicit authorization and existing project gates.

## Release grouping

Phases 1 and 2 are separately reviewable changes shipped as **one Worker release**.
Do not deploy containment alone as a planned intermediate product. A brief controlled
migration pause is still required; no claim of zero downtime. Browser compatibility
must be checked before re-enabling. No releases are dispatched by this planning task.

## Phase 1 — contain the current exposure

Files:
- `worker/src/routes/hdfc_sms_payments.ts`
- `worker/src/lib/payments/registry.ts`, `worker/src/lib/payments/hdfc_sms_adapter.ts`
- `worker/src/lib/commercial_refund_rail.ts`, `worker/src/routes/admin_money.ts`
- `worker/src/index.ts`, only if route wiring changes
- `web/src/islands/checkout/GatewayPicker.tsx`, `types.ts`, `UpiSmokeCheckout.tsx`
- `web/src/pages/test/upi.astro`

Tasks:
- Use existing `requireAdmin` for all smoke method/create/current/status/claim/recheck
  APIs; require intent ownership even for another administrator. No guest fallback in
  the smoke component. Page displays sign-in/access-denied; Worker is the authority.
  Astro's public/static shell must contain no QR or payment state before authorization.
- Allow only `avatok-upi-smoke-2026`, hardcode 100 paise, and remove commercial quote,
  snapshot and provisioning branches and imports. Remove adapter registration/implementation
  and all picker HDFC rendering, injection, polling and fallback order IDs. Preserve only
  legacy identifiers/types needed to recognize old records; none may enable a new order.
- Explicitly reject `hdfc_sms-order:` at commercial refund entry before zero-amount or
  wallet-credit shortcuts. Reject it in generic admin refund as well. Return a stable
  manual-reconciliation-required error; do not credit wallet, claim bank refund or move
  old ledger entries. Source-search other refund entry points for direct bypasses.
- Fix negative-keyword word boundaries; test “Shopping” and `sapin@okhdfc` alongside
  genuine OTP/PIN/debit messages. Require valid configured suffix (4–6 digits), strict
  allowed sender family, positive safe-integer amount, INR and suffix match.
- Remove the unsafe old matcher in the combined Phase 1+2 release. Keep creation/claim
  paused until its schema and one-time seed are ready. During the brief seed boundary,
  ingress returns retryable 503 so the companion retains evidence; afterwards verified
  ingress stores evidence even with the creation/claim flag off. Status is read-only,
  returns persisted historical state and real stored order ID for legacy commercial
  records; smoke order_id is always null. Mark legacy state as protocol 1/unverified.
- Retire the old amount-only reconcile helper. Do not ship a partial patch that leaves
  GET /status able to confirm while the feature flag is off.

## Phase 2 — two-table smoke state and atomic claims

Files: route above; new `worker/src/lib/hdfc_sms_smoke.ts`; new
`worker/migrations/2026-09-18-hdfc-sms-smoke-v2.sql`; new one-shot
`scripts/hdfc_sms_seed_v2.py`; `worker/test/hdfc_sms_payments.test.ts`.

Use two new tables rather than ALTER-ing live legacy status constraints. Preserve both
old tables unchanged. No legacy rows are automatically promoted into v2 evidence.

- `hdfc_sms_smoke_intents`: intent_id PK, uid, request_key, receiving_account_key,
  fixed amount_paise=100, created_at, expires_at, recover_until, active 0/1,
  superseded_by, payer_reference nullable, reference_revision default 0, updated_at. UNIQUE(uid,request_key); partial unique
  index on receiving_account_key WHERE active=1. Stable account key is server-configured
  account identity (single bank/suffix namespace), not mutable VPA or a client field.
- `hdfc_sms_smoke_receipts`: message_hash PK, receiving_account_key, bank_reference
  nullable, amount_paise, currency, received_at_ms, ingested_at, disposition,
  reason_code, claimed_intent_id nullable UNIQUE FK, claimed_at nullable.
  Partial UNIQUE(receiving_account_key,bank_reference) for non-null references.
  Raw accepted bank-credit evidence stays in the existing receipt table; no second raw copy.
  Metadata fields amount/currency/received_at may be NULL only for non-claimable legacy
  rows; accepted v2 rows require fully validated values. New ingress hashes remain strict
  64-hex strings. Legacy state is immutable and cannot be promoted by duplicate delivery.
- **One-time legacy seed, not a runtime lookup subsystem.** The migration helper reads
  the frozen old receipts and intent references once, parses the supported observed
  formats, and generates a deterministic seed. Insert every legacy receipt hash with
  disposition=legacy and NULL claimed_intent_id; preserve originals unchanged.
  For duplicate account+UTR groups, only the deterministic canonical receipt (earliest
  created_at, then hash) carries bank_reference. Siblings retain their hash, NULL reference
  and reason=legacy_duplicate_reference. Thus hash retries hit a legacy row and new-hash
  UTR retries hit its canonical legacy reservation without violating the unique index.
  Legacy rows lacking a supported reference remain permanently non-claimable.
  Ambiguous account/reference attribution fails migration preflight before readiness;
  do not invent identity from the current configuration if it contradicts old evidence.
- Include supported legacy intent-only references in the same seed as metadata-only
  reservation rows keyed `legacy-intent:<intent_id>`, disposition=legacy,
  reason=legacy_reference_only, NULL amount/time when unknown. Prefer a real receipt
  canonical row if present; one reservation per account/reference. Never fabricate a raw
  SMS row or treat `sms:<UUID>` as a bank reference. The observed production snapshot has
  two reference-bearing receipts; the seed still tests duplicate and intent-only cases.
- Capture cutover once in the immutable migration/seed artifact; no new environment
  field, typed configuration or workflow input. Seed helper is migration-only; normal
  requests never scan legacy bodies. A final readiness view records the fixed cutover
  literal/seed identity after successful seeding; this adds no third state table.
  New evidence predating cutover is ineligible. Freeze/drain old ingress before snapshot;
  verify source inventory unchanged, seed and readiness marker atomically, or abort.
  Restart/retry uses the same manifest and cannot overwrite v2 claims or promote legacy.
  Preserve raw SMS/reference data outside git/logs; publish only counts and seed digest.
- CREATE TABLE/INDEX IF NOT EXISTS, with schema checks before enabling v2 paths.
  All new metadata and original accepted receipt insert happen in one D1 batch.
  Rerunning migration must succeed. Never use ADD COLUMN ... UNIQUE.

Claim authority and invariants:
- Current companion format is `yyyy-MM-ddTHH:mm:ss+03:00`, derived from epoch millis
  by `TimeUtils.iso8601Eat`; `ApiClient` signs it unchanged. Production rows confirm the
  explicit +03:00 offset. Parse that offset, never assume IST/device locale; permit valid
  ISO UTC Z too. Existing transport truncates milliseconds: treat its timestamp as a
  one-second interval and test overlap against the original intent window (at most 999ms
  quantization tolerance). This cannot provide subsecond ordering or payer identity.
  A timestamp interval wholly outside the original window is ineligible. Use millisecond
  precision for new companion timestamps if changed, retaining old signatures byte-exact.
  The original interval is [intent.created_at, intent.expires_at], not expiry+24h. Recovery invocation is allowed
  until recover_until=expires_at+24h; it does not extend the original payment window.
  Timestamp validity is an exclusion rule, not evidence of payer identity.
- Normalize a supported 12-digit HDFC UTR as a string, preserving leading zeros.
  Explicitly support the observed `(UPI <12 digits>)` credit template; the old regex
  only recognizes UTR/UPI REF/REFERENCE and misses both stored production messages.
  Add redacted shape-equivalent fixtures with synthetic references and the existing
  supported UTR/REF labels. No random fallback or arbitrary 12-digit number extraction.
  Unsupported/reference-less formats cannot confirm in this harness; record this known
  limit in the handover and return unsupported_reference rather than waiting forever.
- One shared claim helper for ingress, POST claim and POST recheck. GET is read-only.
  Claim only accepted, conflict-free v2 evidence matching account, INR, amount, exact
  saved payer_reference and original SMS window. Require current eligible unsuperseded
  v2 intent and recovery deadline **inside the UPDATE predicate**, not only a prior SELECT.
- Authoritative UPDATE changes an unclaimed receipt to claimed_intent_id. UNIQUE receipt
  bank identity plus UNIQUE claimed_intent_id enforce one transfer/one intent both ways.
  Derive confirmed status by joining the claimed accepted receipt; do not maintain a
  second independent mutable confirmed bit that can diverge after a zero-row update.
  Persist claim time; reread authoritative result. Same-pair retry succeeds idempotently;
  different-pair claim cannot overwrite. Test concurrent attempts with real SQL.
- Duplicate delivery reruns reconciliation from stored eligible metadata. Same bank
  reference with a different transport hash is one transfer, never a second payment.
  For an already known account/reference, preserve the new raw receipt, then UPDATE the
  canonical metadata row in the same batch rather than inserting a second metadata row.
  Return the canonical receipt_id. Semantically identical signed evidence is a duplicate;
  changed evidence that cannot safely be reconciled durably marks the canonical row
  review_required. Never let a unique-index exception roll back the new raw evidence,
  and never use INSERT OR IGNORE to silently discard a conflict.
  Conflicting amount/account/evidence is marked review_required and excluded. Preserve
  evidence and never silently select whichever arrived first. A conflict discovered after
  a claim surfaces review_required, not a fresh claim or silent financial side effect.
- Set payer_reference under a conditional write while unclaimed. Allow an explicit
  correction only while no receipt is claimed, with expected_reference_revision compare-and-set
  (zero for first submission, increment on each accepted correction); a concurrent claim wins and makes correction fail 409.
  Never silently overwrite it on retries. The claim UPDATE joins the current saved
  reference inside SQL. This avoids permanently stranding a test after a typing mistake.
- Zero evidence remains awaiting_sms, not a terminal review state. Wrong reference is
  a generic no_match response without exposing other receipts. Multiple/conflicting
  candidates stay unresolved. Signed unrelated/OTP messages are acknowledged ignored
  without persisting raw unrelated content. Storage/matcher failure returns retryable 503;
  persisted evidence remains available for duplicate retry or explicit recheck.
  After INSERT OR IGNORE, verify the exact message_hash row exists: nonce collisions
  must not acknowledge an unstored new message or manufacture eligible metadata.
- Creation uses request_key UUID and returns the same intent after response loss.
  Resume an existing owned active intent by default. Replacement requires explicit
  replace_intent_id owned by caller; another admin gets busy, never supersedes it.
  Expire/release old active rows and insert in one batch with conditional predicates;
  a repeated request must not supersede its own original result. Superseded intents
  cannot be auto-claimed. A receipt may still be recovered for an expired, unsuperseded
  intent using its exact UTR; creation of another QR does not turn the old receipt into proof.
- Flag off blocks new QR creation and all claims. Authenticated reads and verified ingress
  remain available. No heartbeat-derived readiness requirement is added.

Freeze these contracts before parallel workers:
- GET current: account_id, enabled, intent|null; GET status?intent_id: owned intent.
- Intent: protocol_version, intent_id, status, reason_code, amount_paise, expires_at,
  recover_until, updated_at, claim_submitted, smoke_test:true, order_id:null.
  Include reference_revision for compare-and-set correction; never return raw reference
  in status, telemetry, URL or logs. Same-reference retry is idempotent even with a stale
  revision; a different reference needs the current revision and an unclaimed intent.
  Authorized owner alone receives upi_url for an unexpired payable intent.
- POST order: listingId,request_key,replace_intent_id?; POST claim: intent_id,bank_reference,expected_reference_revision;
  POST recheck: intent_id. Mutations return the same Intent envelope. Bound request size
  and reference attempts using existing abuse controls; define retryable vs permanent errors.
- Ingest: ok,protocol_version,receipt_id|null,receipt_state (accepted|ignored|review_pending),
  match_state (unmatched|awaiting_reference|confirmed),reason_code.
  awaiting_reference means accepted eligible bank evidence exists with no saved payer
  reference for a potentially relevant owned smoke intent; it is not attribution and
  must not return that intent as matched. unmatched covers no relevant pending test,
  unsupported or conflicting evidence; reason_code explains the distinction. Companion
  displays “Bank evidence stored; reference required,” never “your payment received.”
  These are last acknowledged snapshots, not a promise of current server state.
  An ignored/unmatched/awaiting_reference 2xx is never payment confirmation. Keep existing signed canonical fields compatible with deployed companion.
- Status vocabulary: pending,expired,confirmed,review_pending,superseded; reason codes
  distinguish awaiting_sms,reference_required,no_match,evidence_conflict,legacy_unverified.

## Phase 3 — browser resume, auth and truthful feedback

Files: smoke component/page above; new `web/src/islands/checkout/upiSmokeController.ts`;
`web/test/upi_smoke_controller.test.ts`; narrowly scoped real-component browser fixtures.

- Reuse draft controller cancellation/deadlines/auth refresh after review. Fresh token on
  each request, one 401 retry with skipCache, then visible sign-in failure; never swallow it.
- Use ?intent=<id> as canonical URL; accept previous ?intent_id for compatibility.
  No payment/reference data in localStorage. Reload resumes; opening page never creates.
  Account/session switch clears QR, reference and in-flight state immediately.
- One poll loop, AbortController, generation checks, 10s request deadline, 2.5s cadence.
  Automatic polling ends at server expires_at (remaining window, not another 30min after
  reload). Background/offline pause does not extend expiry. Hide QR exactly at expiry.
  POST recheck performs reconciliation then resumes bounded observation of the same intent;
  after expiry use a single explicit recheck rather than an endless recovery poll loop.
- Show countdown and separate transport/evidence/attribution states. Provide reference
  entry after payment, without blocking QR creation. Explain it links the receipt to this
  test. No green “your payment confirmed” for a mere matching amount or an unmatched SMS.
- Explicit replacement warning and same-intent check after timeout; no automatic recreation.
- Existing analytics only: created,resumed,auth_renewed,timeout,confirmed,review_required;
  no SMS, UTR, token, VPA or QR payload. Mask form from autocapture/session replay.

## Phase 4 — companion queue reliability, separate repository

Repo: `sms-companion` (origin upeo-sms-gateway), baseline
`371a30a162d3afe51d5c9b07fa88e476b528cced`.
Files: SmsInbox.kt/MainActivity bridge; database.dart/sms_message.dart/sms_repository.dart;
api_client.dart/sync_service.dart/background_runner.dart; focused backfill helper and UI.

- Ascending (date,_id) keyset pages, frozen upper bound and bounded work per invocation.
  Persist page+cursor atomically; provider/null-cursor/permission failure must not advance.
  Serialize foreground/background scans with a DB lease. Resume long outages from durable
  cursor; only first scan uses two-day lookback, overlap ten minutes without dropping backlog.
- Dedup stable delivery identities; reference-bearing PDU/inbox duplicates must not count
  as two transfers. Keep backend bank-reference uniqueness as authority. Network retry is
  at-least-once: acceptance promises one logical receipt, not literally one HTTP send.
- SQLCipher additive v1→v2 migration preserves queue. Split transport acknowledgement,
  receipt acceptance and match result; old synced rows become acknowledged_legacy/unknown.
  UI says last acknowledged result, not current server confirmation if no refresh occurred.
- Manual retry resets retry_count/next_attempt_at/permanent stop; preserve lifetime attempt
  evidence. Stop permanent configuration/auth failures. Fresh nonce/sent_at on each retry.
  No automatic deletion of unresolved/legacy queue rows. Defer retention policy work.
- Reuse suitable isolated draft changes; omit heartbeat protocol/version expansion and
  unrelated UI. CI tests real migration/rollback, paging ties/backlog/lease/provider errors,
  malformed/ignored/review responses and manual retry. Resolve and retain dependency lock
  through CI; do not claim an unexecuted lock/toolchain change is validated.

## Phase 5 — CI and controlled rollout

Files: worker/web tests above; `.github/workflows/hdfc-sms-verify.yml`,
`worker-deploy.yml`, `web-deploy.yml`, `hdfc-sms-production.yml`; companion verify/release
workflows; `Specs/HANDOVER-HDFC-UPI-SMS-PAYMENT.md`; `tool/ship_manifest.json` as needed.

- Worker real-SQL invariant tests and web controller/component tests must gate deployments.
  Companion has its own migration/native tests and release identity. No local verification
  commands and no build dispatch under this planning task. Record CI evidence when authorized.
- Production workflow never enables automatically. Validate secrets without printing them;
  deploy/migrate steps use wrappers and record exact SHA, environment and schema identity.
- Rollout order after separate approval: pass CI; pause creation/claims; deploy combined
  Phase 1+2 Worker with schema-readiness guards (no old matcher). Missing seed readiness
  temporarily returns retryable 503 on ingress; drain in-flight old requests, capture
  and verify frozen legacy inventory, apply schema+seed and readiness marker. Resume
  verified ingress; deploy compatible Phase 3 web and install validated companion build;
  explicitly enable for the controlled test. No standalone Phase 1 deployment. A flag
  alone cannot contain the baseline matcher, so the combined code removes it before seed.
- Fresh ₹1 test: admin creates one intent, pays once, observes evidence and supplies UTR;
  same intent confirms. Read-only D1 inspection proves one bank identity/claim and zero
  commercial order/provisioning/wallet writes. Record both repo SHAs, CI URLs and test evidence.
- Rollback: `scripts/flags.sh set hdfcSmsEnabled=false` using prod guard after authorization;
  keep evidence/schema. Never redeploy the unsafe matcher. Existing production balances,
  historical rows and staging data are not rewritten/copied.

## Acceptance criteria (12)

A1 Admin+owner gates; no commercial HDFC create/provision/picker; legacy refunds reject
without wallet or provider effects, including explicit wallet-credit and zero-amount cases.
A2 Parser boundaries, sender/account/suffix/INR validation; old SMS cannot qualify; no fabricated reference/order ID.
A3 Real SQL: one bank transfer/one intent under concurrent claims, duplicate hashes and retries;
no partial claim, no legacy eligibility, duplicate-reference legacy seed and intent-only
reservations preserve every old hash, migration rerun works and failed batch rolls back.
A4 Idempotent create and explicit owner replacement; one active QR; other admin cannot supersede.
A5 Exact-reference confirmation only; unrelated ₹1/late old-QR SMS cannot confirm automatically;
wrong/missing UTR stays unresolved; original-window receipt recovers only within expiry+24h.
A6 Flag off prevents create/claim; GETs have no side effects; receipt persists on matcher failure;
recheck finds evidence despite 50 newer unrelated rows; no-receipt stays recoverable.
A7 Fresh auth/one refresh; exhausted auth visibly fails; account switch/unmount cancels and clears.
A8 Reload resumes same intent, expiry countdown/hide and stale-response suppression work.
A9 Timeout/recheck/replacement require explicit actions; no duplicate poll or automatic new payment.
A10 500+ equal-timestamp/backlog/provider/interruption cases lose no eligible SMS; duplicate
network attempts produce one logical receipt; SQLCipher migration preserves queue/cursor.
A11 Ignored/review/legacy/malformed/awaiting_reference acknowledgement cannot display confirmed; retry resets
correctly and permanent failures stop; unresolved queue evidence is not purged.
A12 Authorized CI gates pass and one fresh ₹1 end-to-end test records matching claim, both
SHAs and no commercial effects. Until then this is source work, not a verified live fix.

## Execution ownership and draft reuse

After approval: one Astra backend worker (Phases 1–2 and Worker tests); one Astra web
worker (Phase 3 and browser tests); one Astra companion worker (Phase 4, separate repo).
Coordinator owns workflow/handover integration and actual diff review. Agree schemas/API
first; no worker redesign. One issue per explicit-path wrapper commit; no auto builds.
Reuse reviewed parser/admin/refund containment, browser lifecycle and companion queue work.
Do not carry forward draft finance routes/UI, case/audit tables, retention/backfill engine,
heartbeat nonce/device-health stores or the broad safety migration. Keep drafts for reference.
