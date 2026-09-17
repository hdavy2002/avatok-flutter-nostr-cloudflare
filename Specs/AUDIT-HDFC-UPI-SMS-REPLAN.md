# HDFC UPI SMS — Astra re-audit

Date: 2026-09-18. Scope: production-targeted source review, not a live production probe.
Baseline main: `c06a87b29c75fc0f77d786cdb6c5639637d5d76c`.
Companion baseline: `371a30a162d3afe51d5c9b07fa88e476b528cced`.
Independent reviewer: native `gpt-6-astra` subagent `astra_reaudit`; coordinator also
inspected source. DeepAstra skill applied with project's Astra-only routing override.
No implementation, local tests/builds, deployment, database/flag changes or CI dispatch
performed in this re-audit. Previous implementation drafts remain isolated, uncommitted.

## Assessment of the supplied review

**Agree with the smaller scope.** Commercial HDFC creation/provisioning should be
removed, not left as a configurable shadow gateway. The finance console, audit/case
ledger, retention system and heartbeat expansion are unnecessary for proving this
internal harness works. Queue integrity and truthful status remain necessary.

**Confirmed additional parser bug.** `worker/src/routes/hdfc_sms_payments.ts:25`
uses an unbounded negative keyword regex. `pin` rejects “Shopping” and `sapin@okhdfc`.
Use word boundaries, with regression cases for both real credit and real OTP/debit text.

**The anonymous-session claim is incorrect for this baseline.**
`web/src/islands/checkout/UpiSmokeCheckout.tsx:16` creates only after button click.
`web/src/lib/clerk.tsx:190` opens the current Clerk email/OTP flow; its header documents
that old guest HMAC tokens cannot pass requireUser. Merely loading /test/upi neither
creates a QR nor mints a usable guest session. The real defect remains serious:
any accepted authenticated user can create, and route lines 134–138 supersede all
pending smoke intents. Require server admin checks plus owner-scoped replacement.

**Do not adopt time/amount-only confirmation.** Claim uniqueness prevents reuse, not
misattribution. Create A, replace with B, pay A's saved QR: SMS arrives after B creation
and satisfies the proposed B match. An unrelated ₹1 transfer also does. A signed phone
timestamp authenticates what the device reported; it does not link the bank transfer
to a browser. Route lines 141–144 create an intent-specific QR tr, but parser lines
33–35 do not extract that merchant reference from verified evidence. Exact payer UTR
can link the bank reference; otherwise show unassigned evidence, not confirmed payment.

## Material defects in the incoming slim plan

1. **P1 — invalid migration.** Incoming plan proposed ADD COLUMN ... UNIQUE, which SQLite
   forbids. Repeated plain ADD COLUMN also needs checkpointing. Existing
   `scripts/d1_apply_alters.py:74` only selects ALTER statements, so embedded CREATE INDEX
   cannot be assumed applied. Revised plan uses two fresh v2 tables with rerunnable
   CREATE statements, keeping legacy rows isolated.
2. **P1 — partial claim.** First UPDATE in proposed batch lacks eligibility/status,
   supersession and upper-time guards; second may change zero rows. That is not a SQL
   failure, so a transaction can commit an orphan receipt claim. Revised plan makes the
   guarded receipt claim authoritative and derives confirmation by join.
3. **P1 — same transfer, different hashes.** Route `hdfc_sms_payments.ts:225` hashes
   sender/message/time, not bank transaction identity. UNIQUE claimed_intent_id does
   not prevent separately hashed deliveries claiming separate intents. Require unique
   receiving-account plus normalized bank reference and conflict handling.
4. **P1 — legacy refund remains.** `commercial_refund_rail.ts:48` matches only [a-z]+;
   `hdfc_sms-order:` falls through to wallet at line 92. Deleting new creation does not
   remove old orders. Retain a narrow early manual-reconciliation rejection and check
   direct generic admin refund (`admin_money.ts:69`), without adding a finance console.
5. **P1 — legacy evidence cannot be presumed unused.** Existing confirmation
   (`hdfc_sms_payments.ts:69`) has no receipt claim. Exclude old receipts/intents from
   new eligibility, including duplicate re-delivery after the cutover.
6. **P2 — waiting is not review.** Incoming plan sets zero candidates to review_pending,
   then permits claim only from pending/expired. First poll could strand an ordinary
   payment. Keep awaiting_sms recoverable.
7. **P2 — distinguish recovery deadline from SMS window.** Allow recovering until
   expiry+24h, but require original SMS receipt time inside creation..expiry. Signed
   received_at is an exclusion filter, never payer proof. Enforce both in SQL.
8. **P2 — nonce collision acknowledgement.** Legacy receipt nonce is UNIQUE
   (`2026-09-17-hdfc-sms-payments.sql:8`); INSERT OR IGNORE can skip a new hash for a
   reused nonce. Verify exact stored row before acknowledging or creating v2 metadata.
9. **P2 — rollout leaves unsafe matching live.** Incoming Phase 1 says flag stays on,
   while phase 2 owns the claim fix. Baseline status mutates and ingest ignores flag
   state. Pause create/claim and remove unsafe matcher before partial rollout.

## Web and companion findings retained

- Current browser reuses captured token, swallows poll errors and abandons at 120 polls
  (`UpiSmokeCheckout.tsx:33–42`). It lacks cancellation and resume. Retain focused
  controller, account-switch clearing, URL resume, explicit recheck and expiry display.
- Current native inbox reads newest-first capped rows and returns an empty/partial result
  after provider errors (`SmsInbox.kt:20–55`). Retain durable ascending date/id pagination
  with atomic page/cursor progress and serialized scanners.
- Companion `api_client.dart:103–106` accepts any 2xx as accepted. Separate transport,
  receipt and match state; legacy/ignored/review results must not show confirmed.
- A10's “double-sends none” is impossible under lost HTTP responses. Test at-least-once
  delivery with one logical receipt/claim, not exactly-once networking.
- Literal search found no HDFC path in main Flutter app/lib. This remains web-only;
  the Android companion transports evidence and is not an app checkout integration.

## Evidence limits and decision

No current production deployment SHA, bank receipt, live migration state or fresh ₹1
result was checked in this turn. Source baseline is not proof of deployed behavior.
Graphiti tools were unavailable; no project memory or telemetry was fabricated.
Project Graphify was consulted and source files read directly where needed.

Proposed revision: five phases, 12 acceptance criteria, two dedicated smoke-state tables,
no new operations console. Exact-reference confirmation is intentionally retained; the
user should approve that material decision before implementation resumes.

Primary SQL references:
- [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html): ADD COLUMN cannot introduce UNIQUE.
- [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/): batch statements are transactional;
  rollback on statement failure does not make a zero-row UPDATE a failure.

## Second Astra review of revised plan

The independent reviewer accepted the two-table authoritative-claim design, subject to
legacy bank-reference exclusion across changed hashes, canonical duplicate/conflict
persistence, reference-edit concurrency and updated_at. These are now explicit in the
plan. The reference correction uses a revision compare-and-set before any claim; raw
references remain out of responses and telemetry. No runtime validation was performed.

## Follow-up: production evidence and plan amendments

Read-only production D1 queries on 2026-09-18, through `scripts/cf.sh`, after checking
Wrangler account identity. Queried all two stored receipts and eight smoke intents;
no database, flag, deployment or build writes. Raw bodies were inspected in process
memory, not saved into repository/artifacts; output was redacted.

- Neither SMS contains an AV merchant reference, exact stored intent QR reference,
  or the AvaTOK smoke note. This sample supports UTR-based attribution for the current
  observed format; it does not prove that every future HDFC format omits these fields.
- Both contain a distinct 12-digit reference in `(UPI <12 digits>)`. The existing regex
  misses this bare-UPI form. The previous plan needs an explicit fixture/parser for it.
- One historical intent contains a random `sms:` reference, zero have a supported
  stored 12-digit reference. It must not be treated as a valid bank identity.
- Stored received_at strings end in +03:00, matching
  `sms-companion/lib/src/core/time_utils.dart:14`. Formatting derives from epoch millis,
  applies EAT and truncates to seconds. It is not offset-free device time. Parser tests
  must cover timezone equivalence and second-resolution boundary quantization.

Accepted amendments: seed legacy exclusions once during migration, ship containment
and claim authority as one Worker release, and add awaiting_reference to acknowledgement
state. An Astra reviewer checked the seed design. Duplicate legacy references need one
canonical reservation plus preserved sibling hashes; a naive all-rows insert conflicts
with the unique bank-reference index. A small migration-time parser is required because
legacy rows have no parsed bank-reference column. No runtime legacy scan/config subsystem.

Kept reference revision compare-and-set: it is one field and a conditional write, useful
for stale browser retries even with one tester. It does not add a service or worker.
Reference-less/unsupported formats remain an explicit harness limitation. The revised
plan remains proposed; this follow-up did not resume implementation or release anything.
