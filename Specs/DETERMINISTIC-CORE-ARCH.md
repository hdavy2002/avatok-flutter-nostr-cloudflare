# Deterministic Core Architecture — "No More Retries As Strategy"

Adopted 2026-07-05 (owner directive). Supersedes the reactive parts of
PRODUCTION-HARDENING-PLAN.md; that plan's scale/rollout/observability sections still apply.

Principle: **make illegal states unrepresentable, not recoverable.** Exactly-once user
actions via client idempotency keys; Durable Objects as the sole truth for anything
ordered or stateful; leases over booleans; acknowledgements over timeouts; checkpoints
over restarts. Retries remain, but they become *harmless* rather than the strategy.

## The 16 recommendations, mapped to this codebase

| # | Recommendation | Verdict | Where / Notes |
|---|---|---|---|
| 1 | InboxDO transactional idempotency (client_msg_id dedupe) | **PHASE A — ship now** | `worker/src/do/inbox.ts`. Durable UNIQUE index beats an LRU of processed_ids: it survives DO restart/migration by construction. `INSERT … ON CONFLICT DO NOTHING`; dup → return existing id + `already_processed:true`, never bump unread. client_id is already a UUID from the client ([MSG-OUTBOX-1]); add optional device_id passthrough. |
| 2 | Call state machine owned by the Call DO | **PHASE B — flag-gated `CALL-FSM-1`** | `worker/src/do/call_room.ts` becomes authoritative: NEW→INVITING→RINGING→ANSWERED→CONNECTING→CONNECTED→RECONNECTING→ENDED. Clients send *requests* (accept/reject/cancel/hangup/reconnect); DO replies accepted / ignored / already_answered / already_connected / stale_generation. Client-side [CALL-DUP-SESSION-1] guards stay as defense-in-depth, but the DO becomes the referee, which kills the whole class server-side (multi-device included). Gated behind KV `callFsmEnabled` so the release build is never hostage to it. |
| 3 | Leases instead of booleans | **PHASE B (calls) / PHASE C (presence)** | Inside CallRoom: `answered` becomes a lease {owner_device, expires, renewed by heartbeat}; crash → lease expiry → another device may resume. Presence leases in Phase C (presence is minimal today). |
| 4 | Session registry: constructors never public | **PHASE A — finish now** | [CALL-DUP-SESSION-1] added the `_byRoom` registry; now make `CallSession` non-constructible outside `CallSessionManager` (private ctor + manager-only factory) so the compiler enforces what the registry checks. |
| 5 | Generation numbers per call | **PHASE B (with #2)** | CallRoom stamps `gen` on every accepted (re)join; all signaling frames carry `{callId, gen}`; both sides drop frames with stale gen. A dead socket from gen 1 can never kill a gen 2 call. |
| 6 | Checkpoint/resume for every long operation | **PHASE A (messages — done via outbox) / PHASE C (chunked media)** | Text sends already checkpoint (durable outbox). Media: spool-to-disk ([MSG-OUTBOX-2], hardening plan 1.2) then R2 multipart chunk checkpoints in Phase C. |
| 7 | Outbox completes on ECHO, not ACK | **PHASE A — ship now** | Client: outbox entry lifecycle Queued→Sending→Acked→**Echoed=Complete**. The sender's own InboxDO already echoes every sent message ( messaging.ts appends to sender first); completion = seeing our client_id come back through cursor sync. Combined with #1, retries between ACK-loss and echo are exactly-once. |
| 8 | Event sourcing everywhere | **ADAPTED** | Full event-sourced app state is over-engineering at this stage. ADOPT the useful core: CallRoom keeps an append-only event log (INVITE_CREATED…CALL_ENDED) in DO SQLite for state reconstruction + debugging (Phase B). Messages already are an append-only log (InboxDO). Mutable UI state stays. |
| 9 | Server monotonic sequence numbers | **ALREADY SATISFIED — verify** | InboxDO `messages.id` is per-user monotonic and cursor sync orders by id, not timestamps. Action: audit that no client path sorts by wall clock for merge decisions (thread render may display by time; MERGE must be by id/client_id). |
| 10 | Lease-based presence | **PHASE C** | When presence becomes a first-class feature. Design reserved: presence lease 20s, heartbeat 5s, no manual clears. |
| 11 | Deterministic reconnect (resume tokens) | **PHASE B (with #2/#5)** | CallRoom issues resume token {callId, gen, ICE/TURN creds, expires}. Reconnect = present token; DO restores state. Replaces the client-side guess-and-retry ladder as the *primary* path (ladder stays as fallback). |
| 12 | DO never trusts clients | **PHASE B (with #2)** | Every state-changing request validated against current state + owner + gen + lease. Uses existing per-account auth (uid already verified at the Worker edge). |
| 13 | KV never for ordered/stateful data | **PHASE A audit + PHASE B fix** | Audit result: config/flags in KV = correct. **Violation found: `call_answered:<callId>` flag lives in KV** (call_room.ts writes, receptionist.ts reads, 5-min TTL) — this is call state in an eventually-consistent store and was implicated in the receptionist `start_failed` mess. Phase B moves it into CallRoom state (the FSM's ANSWERED state makes it free). |
| 14 | One Network Brain state machine | **PHASE B** | Client singleton `NetBrain` (OFFLINE→CONNECTING→CONNECTED→DEGRADED→RECOVERING) fed by connectivity_plus + hub socket + WS health. SyncHub, Outbox, CallSession, uploads *subscribe*; their private reconnect loops become reactions to one state, ending competing retry storms. (Outbox already listens to hub reconnect — interim OK.) |
| 15 | Acknowledgement-driven instead of timeout-driven | **PHASE B (calls) — partially exists** | Chain today: place ACK (`call_place_ok`) → push fanout result → device ring-ack (`call_ring_ack`, ok:false = unreachable) → accept. Phase B completes it: every leg reports, caller UI names the exact failing leg ("push delivery failed" vs "device unreachable" vs "network unavailable"). Ring-ack negative already built server-side; un-dark `receptTakeoverGuard` after device test (hardening plan 1.3-L4). |
| 16 | Call Coordinator DO | **SAME AS #2** | The upgraded CallRoom IS the coordinator: state, participants, leases, generations, resume tokens, receptionist state (from #13), timeouts, event log. Clients become thin terminals. |

## Phasing

**PHASE A — deterministic messaging core (TODAY, deploy-safe, no flags needed)**
- A1 [SRV-MSG-IDEMP-1] InboxDO idempotent append (#1) + verify #9 audit. Worker deploy.
- A2 [MSG-ECHO-COMPLETE-1] Outbox echo-completion (#7). App-side.
- A3 [CALL-REG-SEAL-1] CallSession constructor sealed to the manager (#4). App-side.
- Result: message loss/duplication becomes architecturally impossible end-to-end
  (durable outbox → idempotent server → echo-confirmed completion).

**PHASE B — deterministic call core (`CALL-FSM-1`, flag-gated, next work block)**
- B1 CallRoom FSM + validated transitions + replies (#2, #12, #16)
- B2 Generations on every frame (#5) + resume tokens (#11)
- B3 Answered/owner leases (#3-calls)
- B4 Call event log in DO (#8-adapted)
- B5 `call_answered` KV → DO state (#13)
- B6 Full ack-chain surfacing in caller UI (#15)
- B7 NetBrain client state machine (#14)
- Ships dark behind `callFsmEnabled`; device-tested with both phones + chaos script
  (kill app mid-ring, both-accept race, dual-device accept) before the flag flips.

**PHASE C — durability completions (post-launch fast-follow)**
- C1 Chunked resumable media (R2 multipart) (#6)
- C2 Presence leases (#10)
- C3 Remaining PRODUCTION-HARDENING-PLAN Phase 2/3: load tests, CI analyze gate,
  staged rollout + kill switches, dashboards/alerts, cost sheet, chaos drills.

## Invariants (the contract every future change must keep)

1. Every client-originated mutation carries a client-generated idempotency key; every
   server handler is safe to receive it twice.
2. A user-visible action is "complete" only when its durable echo returns, never on ACK.
3. Any ordered or stateful workflow lives in exactly one Durable Object; KV holds only
   configuration and caches.
4. State-changing requests are validated by the owning DO against state+gen+lease;
   clients request, they never assert.
5. Stale artifacts (sockets, pushes, sessions) are identifiable (generation) and
   droppable without side effects.
6. Every long-running operation persists a checkpoint it can resume from after a crash.
