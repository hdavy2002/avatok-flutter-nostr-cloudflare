# Deterministic Core Architecture — "No More Retries As Strategy"

v1.1 — adopted 2026-07-05, amended same day after external architecture review.
Supersedes the reactive parts of PRODUCTION-HARDENING-PLAN.md; that plan's
scale/rollout/observability sections still apply.

Principle: **failures become ordinary, expected events with deterministic outcomes.**
Exactly-once user actions via client idempotency keys; Durable Objects as the sole
truth for anything ordered or stateful; leases over booleans; acknowledgements over
timeouts; checkpoints over restarts. Retries remain, but they become *harmless*
rather than the strategy.

## Launch scoping (v1.1 — the two-bucket rule)

**MUST-HAVE BEFORE LAUNCH** (Phases A + B below are both launch blockers):
1. InboxDO transactional idempotency
2. Durable outbox with echo completion
3. Sealed session registry
4. Network Brain (one network state machine, all subsystems subscribe)
5. Call DO as the sole authority (FSM + validated commands)
6. No live call state in KV (`call_answered` moves into the DO)
7. Correlation IDs end-to-end + DO diagnostics endpoints
8. Chaos test suite as a release gate

**DEFERRED UNTIL REAL SCALE JUSTIFIES** (build after observing production traffic):
full event sourcing, presence leases, chunked media uploads, sophisticated resume
tokens (basic generation-checked reconnect ships at launch; token machinery later),
multi-region optimization, detailed cost modeling.

## The recommendations, mapped to this codebase

| # | Recommendation | Verdict | Where / Notes |
|---|---|---|---|
| 1 | InboxDO transactional idempotency | **PHASE A** | `worker/src/do/inbox.ts`. Durable partial UNIQUE index `(conv, client_id) WHERE client_id IS NOT NULL`; `INSERT … ON CONFLICT DO NOTHING`; dup → return existing id + `already_processed:true`, never bump unread. **LRU/processed-ids approach is explicitly REJECTED** — the index survives DO eviction/restart/migration/crash for free; an LRU survives none of them. client_id is already a client UUID ([MSG-OUTBOX-1]); add `device_id` passthrough now (multi-device ready). |
| 2 | Call state machine owned by the Call DO | **PHASE B — launch blocker, flag-gated `CALL-FSM-1`** | `worker/src/do/call_room.ts` becomes authoritative coordinator. **v1.1: formalized as Command → Validate → Event → State.** Clients send commands (`AcceptCall`, `RejectCall`, `CancelCall`, `Hangup`, `Reconnect`); the DO validates against state+gen+lease, emits an event (`CALL_ACCEPTED`, …) into its append-only log, and the event advances the FSM: NEW→INVITING→RINGING→ANSWERED→CONNECTING→CONNECTED→RECONNECTING→ENDED. Replies: accepted / ignored / already_answered / already_connected / stale_generation. Client-side [CALL-DUP-SESSION-1] guards remain as defense-in-depth. KV kill switch `callFsmEnabled`. |
| 3 | Leases instead of booleans | **PHASE B (calls) / DEFERRED (presence)** | CallRoom: `answered` becomes a lease {owner user+device, expires ~15s, heartbeat renew ~5s}; crash → expiry → resumable. Presence leases deferred. |
| 4 | Session registry, constructors never public | **PHASE A** | [CALL-DUP-SESSION-1] added the `_byRoom` registry; seal `CallSession` construction to `CallSessionManager` (private ctor/factory) so the compiler enforces it. |
| 5 | Generation numbers per call | **PHASE B — launch blocker** | CallRoom stamps `gen` on every accepted (re)join; ALL signaling frames carry `{callId, gen}`; both sides drop stale-gen frames. A gen-1 zombie socket can never kill a gen-2 call. |
| 6 | Checkpoint/resume for long operations | **PHASE A (messages) / DEFERRED (chunked media)** | Text sends checkpoint via durable outbox. Media: spool-to-disk before upload ships at launch (whole-file retry); R2 multipart chunk checkpoints deferred. |
| 7 | Outbox completes on ECHO, not ACK | **PHASE A** | Lifecycle Queued→Sending→Acked→**Echoed=Complete**. Sender's own InboxDO already echoes every send; completion = our client_id returning through cursor sync. With #1 this is exactly-once end-to-end. |
| 8 | Event sourcing | **ADAPTED** | Full event-sourced app state stays rejected (over-engineering pre-scale). The CallRoom event log from #2 IS the adopted core; messages are already an append-only log (InboxDO). |
| 9 | Server monotonic sequence numbers | **SATISFIED — audit in Phase A** | InboxDO `messages.id` is per-user monotonic; cursor sync orders by id. Audit: no merge decision may use wall clock. |
| 10 | **v1.1: Versioned mutable entities** | **PHASE B design, enforcement can trail** | Every mutable entity (message edit/delete/react state, profile, call record) carries an integer `version`; the owning DO rejects writes with stale versions. Matters the day two devices edit/react simultaneously — the schema (version column + reject rule) is cheap NOW, retrofitting isn't. Ship the columns/protocol in Phase B; multi-device conflict UX deferred. |
| 11 | Deterministic reconnect | **PHASE B basic / DEFERRED sophisticated** | Launch: reconnect = re-present {callId, gen}; the DO validates and restores from its FSM. Sophisticated resume tokens (bundled ICE/TURN creds, expiry) deferred until observed need. |
| 12 | DO never trusts clients | **PHASE B — launch blocker** | Every command validated against current state + owner (user AND device) + gen + lease. |
| 13 | KV never for ordered/stateful data | **PHASE A audit done / PHASE B fix — launch blocker** | Violation confirmed: `call_answered:<callId>` in KV (call_room.ts writes, receptionist.ts reads, 5-min TTL) — implicated in receptionist `start_failed`. Becomes the FSM's ANSWERED state. KV keeps only config/flags/caches. |
| 14 | Network Brain | **PHASE B — launch blocker** | Client singleton `NetBrain`: OFFLINE→CONNECTING→CONNECTED→DEGRADED→RECOVERING. SyncHub, Outbox, CallSession, uploads, presence SUBSCRIBE; their private reconnect loops become reactions to one state. Kills competing retry storms. |
| 15 | Acks over timeouts | **PHASE B — launch blocker** | **v1.1 rule: timers are allowed ONLY for garbage collection, lease expiry, and retry backoff — never business logic.** Every "wait N seconds then assume" in the call path is replaced by a named missing-ACK outcome decided by the DO: place ACK → push ACK → device ring-ACK → accept → RTC ACK → media ACK. Caller UI names the failing leg ("push delivery failed" vs "device unreachable" vs "network unavailable"). Ring-ack negative exists server-side; un-dark `receptTakeoverGuard` after device test. |
| 16 | Call Coordinator DO | **SAME AS #2** | **v1.1: participant model is multi-device from day one**: `call → user → {deviceA, deviceB, …}`, commands carry device_id, leases are (user, device)-scoped. Only one device ships in the UI at launch, but the coordinator never needs redesigning for tablet/desktop/web/second phone. |
| 17 | **v1.1: DO diagnostics endpoints** | **PHASE B — launch blocker** | Admin-gated `GET /debug/call/{id}` → {state, gen, participants+devices, leases, last heartbeat, outstanding ACKs, event timeline}; `GET /debug/inbox/{uid}` → {cursor, last ids, dedup hits, WS state}. "My call died" becomes one request, not a log hunt. |
| 18 | **v1.1: Correlation IDs everywhere** | **PHASE A start, PHASE B complete — launch blocker** | Every client-originated request carries `trace_id` (UUIDv7), propagated HTTP → Worker → Call DO → Inbox DO → push payload → receiving client → RTC telemetry. Every PostHog event includes it, stitching one user action across both devices and the server. Cheap to thread now, near-impossible to retrofit. |
| 19 | **v1.1: Chaos testing mandatory** | **RELEASE GATE (promoted from post-launch)** | Scripted suite run before every release: 50% packet loss, duplicate packets, ACK loss, delayed WS, delayed push, reconnect during ICE, Worker restart, DO migration/eviction, app kill mid-ring/mid-call/mid-send, airplane mode, Android process death, both-accept race, dual-device accept. Green suite = boring production. |

## Phasing

**PHASE A — deterministic messaging core (deploy-safe, no flags)**
- A1 [SRV-MSG-IDEMP-1] InboxDO idempotent append (#1) + device_id passthrough + #9 audit
- A2 [MSG-ECHO-COMPLETE-1] Outbox echo-completion (#7)
- A3 [CALL-REG-SEAL-1] CallSession construction sealed to the manager (#4)
- A4 [TRACE-ID-1] trace_id minted client-side on every mutation; Worker + DOs log it; PostHog events carry it (#18 start)
- Result: message loss/duplication architecturally impossible end-to-end.

**PHASE B — deterministic call core (`CALL-FSM-1`, flag-gated) — LAUNCH BLOCKER**
- B1 CallRoom Command→Validate→Event→State FSM + replies (#2, #12, #16 multi-device model)
- B2 Generations on every frame (#5) + gen-validated reconnect (#11 basic)
- B3 (user, device) answered/owner leases (#3)
- B4 Append-only call event log (#8 adapted) feeding B7
- B5 `call_answered` KV → DO state (#13)
- B6 Ack-chain with named failure legs; timers only for GC/leases/backoff (#15)
- B7 Diagnostics endpoints `/debug/call/{id}`, `/debug/inbox/{uid}` (#17)
- B8 NetBrain client state machine (#14)
- B9 Version columns + stale-write rejection protocol on mutable entities (#10)
- B10 trace_id completed through push→client→RTC (#18)
- Ships dark behind `callFsmEnabled`; flag flips only after the chaos suite (#19) and
  the two-phone device checklist pass.

**RELEASE GATES (every release, from now on)**
- Chaos suite (#19) green
- CI static gate (flutter analyze + tsc + DO unit tests: 2-peer cap, dedupe, FSM transitions, cursor sync)
- Two-phone device checklist with telemetry assertions
- Staged rollout 5%→20%→100% on the release-health dashboard (hardening plan §2.3-2.4)

**DEFERRED (revisit with production data)**
- Full event sourcing beyond the call log; presence leases; chunked/multipart media
  (R2) with chunk checkpoints; sophisticated resume tokens; multi-region placement
  tuning; per-1000-DAU cost modeling (keep the rough sheet, skip the depth).

## Invariants (the contract every future change must keep)

1. Every client-originated mutation carries a client-generated idempotency key AND a
   trace_id; every server handler is safe to receive the same key twice.
2. A user-visible action is "complete" only when its durable echo returns, never on ACK.
3. Any ordered or stateful workflow lives in exactly one Durable Object; KV holds only
   configuration and caches. State transitions happen only as Command→Validate→Event.
4. State-changing requests are validated by the owning DO against state + owner
   (user, device) + generation + lease + version; clients request, they never assert.
5. Stale artifacts (sockets, pushes, sessions, writes) are identifiable (generation /
   version) and droppable without side effects.
6. Every long-running operation persists a checkpoint it can resume from after a crash.
7. Timers exist only for garbage collection, lease expiry, and retry backoff — never
   as business logic. Business outcomes are decided by ACKs or their absence, by the DO.
8. Every DO exposes a diagnostics view sufficient to answer "why did this die?" in one
   request.

## Changelog
- v1.1 (2026-07-05): external review incorporated — LRU explicitly rejected;
  Command/Event formalization; entity versioning; multi-device participant model from
  day one; timers-only-for-GC/leases/backoff rule; chaos testing promoted to release
  gate; DO diagnostics endpoints; end-to-end trace_ids; two-bucket launch scoping
  (Phase B promoted to launch blocker; presence/chunked-media/resume-tokens/cost-depth
  deferred).
- v1.0 (2026-07-05): initial 16-point mapping and Phase A/B/C plan.
