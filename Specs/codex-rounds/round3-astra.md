**Round 3 verdict: not ready.** The simplifications reopen money and capacity failures identified in R1/R2. No files modified or builds run.

**(a) Simplification verdicts**

| Simplification | Verdict | Reason / minimal fix |
|---|---|---|
| No quarantine table; uncertain provider seat occupied until `ends_at` | **Reject + minimal fix** | The purchased deadline does not terminate OpenAI. Keep an `uncertain_provider` marker on the reservation, counting beyond `ends_at` until verified closure/provider expiry. A separate table is unnecessary. |
| No authority outbox; direct D1 writes plus end-time cron | **Reject + minimal fix** | Cron ignores pending checkouts and cannot recover lost confirmation/start handoffs. Persist checkout recovery before debit; add idempotent authority lookup and room scheduling RPCs; retry unfinished projection/finalization work. No authority outbox is required if these replacements are explicit. |
| No-show evidence: `session.started` plus 30-second lease heartbeats | **Reject + minimal fix** | Authority heartbeats prove the room can reach the authority, not that delegated reasoning or speech works. Retain one booking-specific backend/audio readiness check and bounded provider health evidence. Missing evidence means refund. |
| Existing `release()` with explicit gross; finish on 200/duplicate | **Reject + minimal fix** | Explicit gross still gets clamped; retries can calculate the fee from residual escrow. Use frozen amounts for independently replayable creator/fee legs and verify both before completion. |
| Clerk sign-in ticket retained | **Reject as security-safe; retain the chosen UX with safeguards** | R1’s account-wide credential risk remains. At minimum enforce fresh authentication for spending/admin/security changes after link-based login, alongside token-leak prevention and revocation. Merely documenting the risk does not remove it. |
| Time refresh retained; no ordinary mid-call memory refresh | **Accept** | Safe for money/capacity. Successful `remember_fact` writes must still use CAS. Forget-me invalidation and provider-context replacement are mandatory exceptions to “no memory refresh.” |

**(b) P0 blockers — exact spec amendments**

**1. Settlement can underpay, strand escrow, or falsely finish — D7, simplification 4, §9 D.**

[ledger.ts](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/ledger.ts:152) computes `min(requestedGross, visibleEscrow)`, credits the creator, then enqueues the fee.

Example: gross 100 → creator receives 80 → fee enqueue fails → creator ledger arrives → retry sees escrow 20 and computes fee **4**. The creator operation deduplicates, but the wrong fee can be emitted.

**Replace the release simplification with:**

> “D owns an agent-specific exact settlement adapter. Creator net, fee, gross and beneficiary come exclusively from the immutable decision. Replay `rel:<orderId>` and `fee:<orderId>` with identical original amounts. Never recompute from remaining escrow. Mark done only after both expected financial legs match. Refund recovery checks the existing exact refund operation before an escrow-balance precheck; an empty escrow after a lost successful response is not proof of failure.”

Assign D the required ledger/WalletDO changes explicitly.

**2. Deterministic IDs currently expire — missing WalletDO ownership.**

[wallet.ts](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/do/wallet.ts:97) retains generic dedupe records for **48 hours**. Its pruning exemption covers only `listing:%`, not `agentlive:*` or `rel:agl_*`. Durable jobs can outlive that window.

**Add:**

> “D owns `worker/src/do/wallet.ts`. Permanently retain agent hold/refund/release operation records, including `agentlive:*` and `rel:agl_*`. Store and validate immutable operation payload identity. Provide an internal operation-result lookup. A retry after any elapsed time must never debit or credit again.”

Update both the permanence predicate and actual pruning SQL.

**3. Crash-after-hold recovery was removed from the schema and sweep — §§1, 3, 4.**

There is no checkout-operation record/recovery job equivalent to R2 §2.1. The sweep only examines expired `booked|in_progress` bookings. A successful debit followed by a crash leaves `pending/hold_pending` outside recovery indefinitely.

**Add:**

> “Before any hold, durably persist the validated quote, request hash, checkout phase and recovery obligation. This may use booking columns instead of a separate checkout table. Recovery covers pending, hold_pending, held and confirm_pending operations, including expired operations and unknown RPC outcomes. Retry/query the same hold ID; never initiate a previously unattempted hold after expiry.”

> “Add `getReservation` and terminal `abort` authority RPCs. Resolve unknown confirmation outcomes before refunding; an aborted reservation cannot later confirm.”

Also add deterministic job IDs or a uniqueness constraint preventing duplicate jobs for the same obligation.

**4. The room has no specified scheduling/cancellation/finalization handoff — §§3, 4, 9.**

D confirms bookings, C creates tests, E1 owns room alarms, and cron “asks” rooms to finalize. No request path, payload, acknowledgement or retry contract connects these operations. A room never contacted cannot schedule its start alarm.

**Add binding-only RPCs to A’s shared contract:**

```text
POST /schedule {bookingId}
  -> {bookingId, startsAt, endsAt, scheduled:true}
POST /cancel {bookingId, buyerUid, acceptedAt}
  -> persisted terminal decision
POST /finalize {bookingId, trigger}
  -> {terminal, decisionHash?, moneyState}
POST /forget {agentId, buyerUid, erasureGeneration}
  -> {invalidated:true}
```

> “E1 implements these RPCs. D’s booking/recovery flow and C’s test flow call `/schedule`; the room loads and validates the authoritative booking itself. Persist the scheduling obligation before returning success. Cancellation and cron finalization use the same room terminal-decision authority. Missing browser activity never prevents scheduled startup.”

The room must replay persisted terminal intent after D1 failure, rather than treating its local terminal flag as completed settlement.

**5. Seat RPCs cannot enforce the retained R2 invariants — §4.**

The simplified calls omit request identity, closure evidence and fencing on release. They also omit the instant-booking rebase contract. Keeping an expired lease “confirmed” can permit a second provider start while the first remains uncertain.

**Replace the relevant contract text with:**

> “Reservations retain request hash and immutable interval identity. `confirm` returns the authoritative interval; instant bookings rebase to confirmation time and rerun the whole-interval capacity check. D1, the room and the booking response use that returned interval.”

> “Lease TTL is explicitly longer than the 30-second heartbeat interval. Heartbeats require the current owner/fence and cannot resurrect expired ownership. Runtime release requires the current fence and closure evidence. Unconfirmed provider closure continues occupying capacity beyond the booking deadline; reacquisition cannot start a replacement provider while the previous provider remains uncertain.”

An unconditional `release {bookingId,reason}` must not be the runtime-release interface.

**6. Legacy money endpoints bypass the new authority — §9 C/D.**

[bookListing()](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/routes/listings.ts:4209) fences only `live_event|consult`. An `agent` listing falls into legacy scheduling and charges `listing.price` as a total, without agent-seat admission.

Separately, [admin_money.ts](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/routes/admin_money.ts:71) uses random refund IDs and directly releases escrow.

**Add:**

> “C makes generic listing booking reject `kind='agent'` with `409 agent_checkout_required` before calendar claims or wallet operations. Generic agent create/edit/publish paths must delegate to the dedicated agent validation and atomic listing/persona writes, or reject.”

> “D owns `worker/src/routes/admin_money.ts` and rejects direct refund/release/hold mutations of `agl_` orders with `409 agent_decision_required`; these orders may move money only through the agent decision executor.”

**7. A primary-key decision row is not the complete immutable decision protocol — §§1, 4.**

§1 omits R2’s arithmetic constraints and mutation protection. Separate `decide()` and `enqueueMoneyJob()` exports leave room for a decision without a job or a competing cancel/refund path.

**Add:**

> “One room-serialized terminal operation atomically inserts the decision, deterministic money job and booking transition in a D1 batch. Existing matching decisions replay; different hashes stop execution. No UPDATE/REPLACE of decisions is permitted.”

Required schema invariants:

```sql
CHECK (refund_amount >= 0 AND release_gross >= 0),
CHECK (refund_amount + release_gross = amount),
CHECK (fee >= 0 AND net >= 0 AND fee + net = release_gross),
CHECK (
  (refund_amount = amount AND release_gross = 0) OR
  (refund_amount = 0 AND release_gross = amount)
)
```

Freeze price, beneficiary, policy and the actual persona configuration at checkout. `persona_version` alone cannot recover an old persona after its sole row is overwritten.

**8. No-show predicate can charge for an unusable service — simplification 3.**

A working voice session with an inaccessible delegation model satisfies the proposed predicate until delegation is actually exercised. No customer means that may never happen.

**Replace it with:**

> “A full-charge no-show requires startup within the disclosed allowance, successful booking-specific delegation readiness and initial output audio, maintained lease coverage, bounded provider-origin health evidence and no service failure. Authority heartbeat success alone is insufficient. Missing/late/uncertain evidence yields `refunded_platform_failure`.”

The 30-second sampling cadence can remain; the evidence must cover the service being sold.

**9. Forget-me and image callbacks lost their security boundary — §§1, 3, 4, E1/E2.**

The new image table lacks upload idempotency, session/erasure generations and analysis revision. The callback drops erasure generation. The transcript key is no longer generation-scoped. Clearing only the memory row leaves old provider context and private artifacts intact.

**Add:**

> “Sessions capture erasure generation. Image records include `client_upload_id`, `session_generation`, `erasure_generation`, `analysis_revision`, and `UNIQUE(session_id,client_upload_id)`. Tool execution keys include session generation. Image callbacks carry and validate booking/session identity, both generations and analysis revision.”

> “E1 atomically reserves the six-image session quota before E2 stores or analyses an image. E2 exposes this through an agreed internal RPC. Retain R2’s streamed-byte, decode/pixel, normalization and single-analysis limits.”

> “Forget me invalidates all active rooms and prior-generation artifacts, replaces provider context only after safe closure, and prevents the interrupted session from writing new memory. Persist cleanup work and use generation-scoped private keys. Persist transcripts before enqueueing durable summarization; `waitUntil` is acceleration, not the sole job record.”

**10. Join-link method and token protections are incomplete — §3, §6, §9 A/D/G.**

The spec says **GET**, but [JoinLink.tsx](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/join/JoinLink.tsx:82) and the existing router use **POST**. Extending only the destination union does not fix this mismatch.

**Replace the route with:**

```text
POST /api/join-link/:token/session
```

> “D owns the existing resolver; A does not remount it under `/api/agents`. Agent resolution branches before legacy bookings/entitlements, verifies exact booking/agent/buyer/hash, and rejects access on accepted cancellation/refund intent. Signing and redemption fail closed without `JOIN_LINK_SECRET`; enforce exactly two token segments and bounded finite expiry.”

The current verifier’s development-secret fallback remains in [ics.ts](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/ics.ts:98).

**11. Required privacy edits have no owner — §6 versus §9.**

`analytics.ts` is named in §6 but assigned to nobody. Existing [analytics.ts](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/lib/analytics.ts:132) enables automatic page capture and replay; [apiClient.ts](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/lib/apiClient.ts:20) does not reliably redact dotted join tokens.

**Add:**

> “G owns `web/src/lib/analytics.ts`, `web/src/lib/apiClient.ts` and necessary `/j/` page headers. Redact join tokens from URL, referrer, endpoint and exception properties before automatic capture. Disable replay on `/j/` and `/talk/` before recording starts, including navigation into those routes. Set no-store/no-referrer on redemption surfaces.”

With full-account tickets, this omission can expose account access, not merely booking metadata.

**12. DO deployment exports and cross-workstream signatures are missing — §9 A.**

A’s `worker/src/index.ts` allowance is limited to mount/cron lines. Cloudflare also requires the classes exported from the entry module, matching the existing [export pattern](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/index.ts:284).

**Add to A’s ownership:**

```ts
export { AgentSeatAuthorityDO } from "./do/agent_seat_authority";
export { AgentLiveRoom } from "./do/agent_live_room";
```

> “Before dependent work starts, A publishes exact parameter/result types for seat RPCs, room RPCs, `decide/enqueueMoneyJob/runMoneyJob`, E2 memory/vision functions and C’s `searchVectorStore`. E1 owns tool dispatch and imports these functions. F owns all shared `agentLive.ts` client exports; G consumes them without editing that file.”

Names without signatures are insufficient for the advertised parallel implementation contract.

**(c) P1 should-fix**

- **NOT NULL/default traps and admin payloads.** §3 never defines admin create/PATCH bodies or response envelopes. `listings.category` is required in [listings.sql](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/migrations/listings.sql:34), alongside title/creator/timestamps. Specify these fields and defaults. Define complete test-booking inserts, including unique synthetic `order_id`, zero amount, three-minute duration and no money job. Do not apply paid-duration constraints to tests.

- **Acceptance #5 contradicts test isolation.** Replace it with: “Admin test reserves capacity and exercises audio/images but performs no hold, settlement or persistent memory write.” Move `remember_fact`, summarization and Forget-me assertions into a separate customer booking.

- **Acceptance #7 breaks active reconnects.** “New prejoin gets 503” includes customers reconnecting to an already-running paid session. Specify that ordinary `agentTalkEnabled=false` blocks provider starts while allowing reattachment within the existing grace window. `agentEmergencyStop` terminates/refunds; neither gate disables receipts, refunds or erasure.

- **Schema recovery indexes.** Add `(status,ends_at)` for the sweep and an index covering checkout recovery. Define reclaiming expired `running` money-job locks and completion guarded by the current lock token. Add unique active KB content hashes and deletion generation/retry state so retries cannot reindex deleted material.

- **Cap policy changes need an interface.** Retain authority-owned versioned cap policy and reject stale revisions. Bound configured concurrency by the verified provider allocation, including staging/tests. Reject ordinary reductions that invalidate confirmed commitments.

- **Shared-file audit result.** No file is explicitly assigned to two WS rows. Repeated references to `AudioPipeline.ts`, join files, taxonomy files, config and `worker/src/index.ts` retain single owners. The actual hazards are **unowned required edits** above and **unspecified shared exports**, not duplicate ownership. Route dispatch must also put literal `/admin/voices`, `/admin/list` and `/bookings/mine` before parameter routes.

**OpenAI Live re-verification:** no new wire-shape blocker in inherited R2 §3.

| Contract | Verified result |
|---|---|
| Startup/audio | `session.start`; `session.audio.format={type:"audio/pcm",rate:24000}`; voice under `audio.output`; wait for `session.started`. Browser binary audio must become upstream base64 JSON. [WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets?api=live) |
| Delegation/update | `delegation.responses` supports the specified model, instructions, function tools and output limit. Sparse updates preserve omitted settings; startup voice/audio/frontend instructions are immutable. [Delegation guide](https://developers.openai.com/api/docs/guides/live-delegation) |
| Function calls | Read `response.event.event` → `response.output_item.done` → `item.type="function_call"`; submit outputs, then explicitly continue after all required results. [Delegation guide](https://developers.openai.com/api/docs/guides/live-delegation) |
| Close/transcripts | Send `session.close`, drain `session.closed`; retain uncertain closure separately. Caller/assistant captions use `session.input_transcript.delta` / `session.output_transcript.delta`, with no transcript-done event. [Live reference](https://developers.openai.com/api/reference/resources/live/primary-websocket) |

**Add these money/security acceptance cases to §10:**

1. Crash/lost response after hold, confirmation, decision persistence and refund; recovery without the browser.
2. Creator credited, fee enqueue fails; retry produces exactly the original net/fee and zero residual escrow.
3. Retry after **48 hours**, with delayed queue delivery: no second wallet effect.
4. Cancellation, provider failure and cron race: one decision and one financial outcome.
5. Generic listing checkout and generic admin escrow routes cannot move agent money.
6. Provider closure remains uncertain across `ends_at`; no replacement seat/provider is admitted prematurely.
7. Live startup succeeds but delegation fails: no-show receives a full refund.
8. Parallel/replayed image uploads respect six total; stale image/tool/summary results cannot survive Forget me.
9. Cross-account booking/image access, replaced sockets, revoked join tokens and token-bearing telemetry are rejected.
10. Active reconnect during ordinary shutdown succeeds; emergency stop refunds; admin tests never settle.

**Ready to build: no.**

Automatic approval review rejected Graphify querying and Desktop Commander shell execution because approvals are unavailable. Direct file reads and official documentation supported this audit.