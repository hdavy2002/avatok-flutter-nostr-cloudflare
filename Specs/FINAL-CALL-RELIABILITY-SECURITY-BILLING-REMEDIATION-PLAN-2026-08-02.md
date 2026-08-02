# Final AvaTalk Call Reliability, Security, and Billing Remediation Plan

**Date:** 2026-08-02  
**Status:** Canonical implementation plan — no production change is authorized by this document  
**Scope:** Free 1:1 P2P calls, free Cloudflare Realtime group conferences, legacy-billing retirement, ring delivery, native audio ownership, signaling, timers, network recovery, iOS readiness, and call observability  
**Supersedes:** the separate call-audit lists and proposed repair orders discussed before this plan

## 1. Outcome and non-negotiable invariants

This plan closes every issue found in the audit. A call release is not ready until all of these are true:

1. **Human calls are always free.** No human 1:1 or group audio/video call may hold escrow, settle a minute, inspect wallet balance, publish a paid-call rate, or apply a tier/minute quota. Any legacy escrow is fully refunded without another settlement.
2. **Only the two authorized participants can enter a 1:1 signaling room.** Possession or guessing of a room ID is never authorization.
3. **One terminal truth per call.** A terminal call cannot ring, reconnect, replay signaling, bill, or alter a newer call.
4. **The microphone is physically disabled for every hold condition.** UI mute state alone is not a privacy control.
5. **Every asynchronous callback belongs to a call, transport generation, and owner.** Stale sockets, timers, subscriptions, and native callbacks are harmless.
6. **Signaling is ordered by negotiation, not merely arrival time.** Stale SDP and ICE cannot be replayed into a newer negotiation or ICE restart.
7. **Relay loss is loud and measurable.** Production must not silently pretend a STUN-only response is healthy TURN service.
8. **The first media packet is measured in both directions.** `onTrack` is not accepted as proof of inbound RTP or audible playout.
9. **Group membership is checked on every admission path.** Starting a room once does not authorize arbitrary later roster reservations.
10. **Tests own the release decision.** Race, retry, crash, handover, multi-device, and timer cases are automated wherever possible and device-tested where platform behavior is involved.

## 2. Audit reconciliation

### Corrections to the earlier findings

- The **Cloudflare Realtime group SFU path already uses a signed, short-lived, one-use join ticket** and checks group membership in its HTTP guard. The zero-auth defect is specifically the **1:1 `CallRoom` WebSocket**.
- A legacy socket `decline` is currently issued as server `end_call`; before connection the FSM classifies it as `ring_timeout`, which maps to wire status **`no-answer`**. It is not recorded as a true decline.
- The accept-path terminal-poison race was fixed in commit `1a48b4fd`: accept now dismisses with accepted state. It remains in this plan as a regression and deployed-version gate, not as an open implementation task.

### Confirmed defects

| ID | Priority | Defect | Evidence / effect |
|---|---:|---|---|
| CALL-FIN-01 | P0 | Legacy paid billing can charge never-connected calls | `/paid/confirm` previously held funds and immediately armed `CallRoom` billing. Owner decision 2026-08-02 supersedes repair-in-place: human-call billing must be decommissioned, all entry points forced free, and legacy escrow fully reconciled/refunded. |
| CALL-SEC-01 | P0 | 1:1 signaling room has no participant authentication | `/room/:roomId` reaches `CallRoom` before user auth; the DO trusts client `?id=`, accepts/supersedes sockets, and relays SDP/ICE. Current room IDs have only about 32 bits of entropy. |
| CALL-AUD-01 | P0 | Focus/cellular “hold” does not disable the microphone track | The client changes `_muted` and sends a mute frame but does not set the local audio track disabled; resume can overwrite a user's manual mute. |
| CALL-AUD-02 | P1 | Native audio has global last-writer-wins ownership | Multiple `NativeVoiceAudio` instances share one static channel handler. A stale call/agent/receptionist teardown can clear callbacks or stop global audio/foreground service owned by another call. Native hangup handling is not consistently call-ID gated. |
| CALL-RING-01 | P1 | Expired and duplicate rings can resurrect native/Flutter ringing | Invite expiry is sent but not enforced before showing incoming UI. Socket and FCM paths use isolate-local seen/terminal maps; background FCM bypasses the foreground dedupe. |
| CALL-RING-02 | P1 | Terminal state is not one durable, cross-isolate ring claim | Late FCM, duplicate FCM, socket+push, cancel-before-ring, multi-device answer, and reconnect replay can disagree across ringtone, notification, CallKit, and Flutter route surfaces. |
| CALL-SIG-01 | P1 | 1:1 reconnect callbacks are not transport-owned | The client lacks a cancellable stream subscription and socket epoch. An old socket's `onDone` can start recovery for the replacement socket; retry counters and telemetry can be reset or double-incremented. |
| CALL-SIG-02 | P1 | Buffered SDP/ICE replay has no negotiation sequence | `CallRoom` persists/replays raw offer, answer, and candidate frames FIFO. Connection generation does not distinguish initial negotiation from a later ICE restart; candidates have no negotiation revision/ufrag guard. |
| CALL-INV-01 | P1 | “Parallel” ring delivery is still a serial setup chain | Participant/token lookups, queue send, and InboxDO delivery are awaited in sequence; FCM token fan-out is also serial. This adds avoidable ring latency. |
| CALL-FSM-01 | P1 | Socket decline is recorded as no-answer | Because the socket has no authenticated actor, decline becomes server `end_call`, producing `ring_timeout` → `no-answer`; decline analytics and user-visible outcomes are wrong. |
| CALL-CONF-01 | P2 | Conference reconnect leaves the old signaling socket active | `_joinConnectWs` replaces `_ws` without cancelling/closing the previous stream. Message handling has a generation check, but old `onError`/`onDone` does not; it can trigger a spurious rejoin and consume another one-use ticket. |
| CALL-CONF-02 | P2 | Conference migration/roster authority checks group membership only on start | `conferenceRoomRoute` authenticates the user but checks `conversation_members` only for `start`. `participant/reserve` then trusts any logged-in UID and can occupy a roster/cap slot. The separate main SFU media path remains ticket- and membership-protected. |
| CALL-ICE-01 | P2 | TURN configuration/provider failures silently return STUN-only success | Missing TURN secrets, non-2xx credential minting, malformed responses, and exceptions all return HTTP 200 with Cloudflare STUN only. Symmetric-NAT calls then fail as if setup were healthy. |
| CALL-TIME-01 | P2 | Timer ownership has holes | The outcome menu timer is not always cancelled; a delayed route pop is uncancellable and can pop a newer call; the place-call timeout's re-arm condition is unreachable in its own callback. |
| CALL-HAND-01 | P2 | Network handover recovery is delayed and incompletely proven | Wi-Fi/cellular change takes one immediate health sample. If it is healthy/unknown, recovery waits for a later watchdog. There is no captured real-device proof for Wi-Fi↔cellular continuity. |
| CALL-GEO-01 | P2 | DO placement and invite hop cost are not observable or consistently chosen | Some first accesses occur before the hinted WebSocket route; InboxDO placement is not explicitly owner-region seeded. Call-path `cf.colo` and per-hop timing are absent. |
| CALL-MEDIA-01 | P2 | “Connected” does not prove first RTP or playout | `onTrack` is used as connection evidence. There is no per-direction accept→first inbound RTP/playout metric, and the relay classification probe can remain unknown. TURN server identity telemetry is not populated reliably. |
| CALL-OBS-01 | P2 | The call flight recorder has coverage gaps | Several desired setup/recovery events are declared or described but not emitted at the authoritative transition. Reconnect counters can lose cumulative history. Actual relay percentage, startup-silence split, and DO colos cannot be answered reliably. |
| CALL-IOS-01 | P2 / platform gate | iOS audio lifecycle cannot be certified | The repository has no complete iOS host integration to verify CallKit `didActivateAudioSession`, audio-engine ordering, and `reportCallEnded` on every decline/cancel/ghost-suppression branch. |
| CALL-TEST-01 | P2 | No complete deterministic call chaos harness | The repository lacks one battery that permutes ring races, duplicate delivery, stale transport callbacks, signaling reorder, crash/restart, alarm retries, and network handover. |
| CALL-CONF-03 | P3 | Conference cap presentation is not defensively clamped | The client accepts `max_participants` directly and the grid uses a cosmetic high row clamp. Server admission remains authoritative, but display/layout should use the product cap and virtualized scrolling. |

### Confirmed closed item that still gates release

| ID | Status | Required proof |
|---|---|---|
| CALL-RING-03 | Code fixed; deployment unverified | Regression test that accept never writes declined/terminal poison, `wasCallTerminated` never kills the accepted call, and the tested APK contains commit `1a48b4fd` or its descendant. |

### Measurement gaps, not assumptions

These cannot be truthfully answered from source alone and require instrumented Indian test calls:

- accept → first inbound RTP and accept → first audible playout, separately for caller and callee;
- percentage of calls using relay, direct host, and server-reflexive candidate pairs;
- TURN allocation latency and relay region/server identity for Jio, Airtel, Vi, and representative Wi-Fi;
- actual Worker edge `cf.colo`, CallRoom placement evidence, InboxDO placement evidence, and per-hop invite latency;
- real Wi-Fi→cellular and cellular→Wi-Fi outcomes;
- OEM/Doze ring receipt behavior on Xiaomi/Redmi, Oppo/Realme, Vivo/iQOO, Samsung, and Pixel.

## 3. Target architecture

### 3.1 Authoritative call record

`CallRoom`/the call-state authority owns a durable record keyed by a high-entropy opaque `call_id`:

```text
identity: call_id, caller_uid, callee_uid, participant devices
state: invited -> ringing -> accepted -> connected -> completed
terminal: disposition, terminal_seq, terminal_at
ring: invited_at, expires_at, presentation_claims by device
transport: participant, socket_epoch, connection_generation
negotiation: revision, offerer, ICE ufrags, highest message sequence
legacy_billing: retirement/refund status only; new human-call billing is forbidden
placement/trace: trace_id, first_edge_colo, placement_hint, hop timestamps
```

The durable state is written before fan-out. Notifications, sockets, routes, and native UI render it; they do not invent terminal state independently.

### 3.2 Authenticated 1:1 signaling capability

The server mints a short-lived, one-use signed capability bound to:

```text
call_id + uid + role(caller|callee) + device_id + session_id
+ connection_generation + nonce + issued_at + expires_at
```

`CallRoom` verifies signature, expiry, participant binding, nonce, generation, and terminal state **before** accepting a WebSocket, counting capacity, superseding another socket, or touching signaling state. A reconnect gets a fresh capability. The public route must never accept raw `?id=` identity after enforcement. New call IDs use at least 128 random bits.

### 3.3 Permanent free communication and legacy reconciliation

Human chat messaging, 1:1 audio/video calls, and group audio/video conferences up to 25 are free on every tier. Server config clamps paid-call and conference-billing flags off even when stale KV overrides say otherwise. Legacy paid endpoints cannot hold or settle funds, conference billing actions are harmless free responses for old clients, and `CallRoom` refuses new billing arms.

Any pre-transition billing state is retirement-only: refund unused escrow, record the reconciliation result, clear the state only after refund succeeds, and never settle another minute. AI agents, AI receptionist, PSTN/carrier usage, live translation, paid events, marketplace services, and other provider-backed products are outside this human-communication rule and retain their explicit pricing.

### 3.4 Ring claim and terminal suppression

Before any ringtone, notification, CallKit UI, or Flutter route is shown, the device performs one account-scoped durable claim using `call_id`, device ID, invite expiry, and terminal sequence. The operation returns one of `show`, `duplicate`, `expired`, or `terminal`.

Terminal updates are monotonic and shared across foreground/background isolates. Every terminal path stops all surfaces idempotently, including answered elsewhere, block, spam, quick reply, voicemail/receptionist handoff, cancel-before-ring, and ghost-suppression branches.

### 3.5 Transport and negotiation ownership

- Every socket listener captures `socket_epoch`; callbacks no-op unless they still own the current socket.
- Replacing a socket first detaches/cancels the old subscription, then closes it, then publishes the new owner.
- Every offer/answer/candidate carries `call_id`, sender, connection generation, negotiation revision, monotonic sender sequence, and candidate ufrag/revision.
- A new offer supersedes older incomplete negotiations. The DO never replays superseded SDP/candidates; receivers serialize application and drop duplicates, old revisions, old ufrags, and out-of-order frames.

### 3.6 Audio ownership

The local track enabled state is derived from independent reasons:

```text
track.enabled = !(userMuted || focusHeld || cellularHeld || privacyHeld || terminal)
```

Resume clears only the hold reason it owns and never changes `userMuted`. Native audio becomes one process-wide broker with an owner token containing call ID, mode, and generation. Start, stop, callback registration, foreground service, route changes, and notification hangup use compare-and-clear ownership.

## 4. Implementation phases and repair order

Each numbered issue is one independently reviewable commit unless two changes are inseparable for safety. Use the issue ID at the start of its commit message. Do not trigger a build or production write merely by following this plan.

### Phase 0 — Permanently retire human-call charging

1. **CALL-FIN-01:** force paid-call and conference-billing config off, make old client billing calls non-charging, reject new `CallRoom` billing arms, remove paid prompts/countdowns, and make all plan conference caps unlimited with the same 25-person product cap.
2. Add an idempotent reconciliation report for every existing human-call escrow or legacy active billing state. Produce a dry-run ledger first; actual production refunds require explicit approval.
3. Add monitoring for any human-call wallet hold/settlement, active legacy billing, failed refund, non-null conference-minute cap, or tier participant cap below 25.
4. Remove stale production KV overrides during the approved rollout. Code remains authoritative and free even before those stale keys are pruned.

### Phase 1 — Close signaling and terminal-state security holes

1. **CALL-SEC-01:** issue and enforce 1:1 signaling capabilities; replace low-entropy room names; authenticate before all DO state/capacity work.
2. **CALL-RING-01 / CALL-RING-02:** implement the durable ring claim and shared terminal store; enforce invite expiry before native UI.
3. **CALL-FSM-01:** use capability identity to issue a real `decline_call` actor transition. Preserve privacy for quick reply/spam/block while recording the correct internal disposition.
4. **CALL-RING-03:** preserve the accepted-dismiss fix and add deployment proof.

Rollout must not leave a permanent unauthenticated compatibility fallback. A short versioned transition may mint capabilities for compatible clients, followed by minimum-version enforcement and removal of raw-ID admission.

### Phase 2 — Enforce microphone privacy and native ownership

1. **CALL-AUD-01:** split user mute from focus/cellular/privacy holds and derive physical track state.
2. **CALL-AUD-02:** replace per-feature native channel handlers with the owner-token broker; call-ID gate hangup and teardown.
3. Verify ringtone release → communication focus → microphone enable ordering on locked Android devices.

### Phase 3 — Make reconnect and signaling replay deterministic

1. **CALL-SIG-01:** add subscription cancellation, socket epoch, cumulative reconnect counters, and generation-owned callbacks.
2. **CALL-SIG-02:** add negotiation revision/sequence/ufrag metadata and stale-buffer compaction; serialize client application.
3. **CALL-HAND-01:** on network identity change sample media at 0, 1, and 3 seconds; initiate bounded ICE restart when evidence fails, without waiting for the normal watchdog.
4. **CALL-TIME-01:** enumerate and owner-gate every timer; fix the place-call timeout re-arm and route-pop ownership.

### Phase 4 — Reduce invite and media startup time

1. **CALL-INV-01:** make live InboxDO delivery and high-priority FCM enqueue concurrent after one atomic call admission; perform token fan-out concurrently with a safe bound.
2. Seed CallRoom placement at the first authoritative call creation, not a later WebSocket access. Decide and document whether caller or callee region is the placement policy.
3. Pre-fetch ICE credentials during ring as today, and evaluate pre-creating the peer connection/gathering candidates during ring only after privacy, battery, expiry, and cancellation tests pass. Never capture/enable the microphone before accept.
4. **CALL-MEDIA-01 / CALL-GEO-01:** add stage and hop timestamps so optimization is driven by measured p50/p95/p99 values.

### Phase 5 — Harden conference control and TURN

1. **CALL-CONF-02:** check current `conversation_members` membership for every conference-room participant reserve/join/migration action, or replace the parallel migration roster with the already authenticated GroupCallRoom authority. Bind room ID to group ID in durable state and reject mismatches.
2. **CALL-ICE-01:** return structured ICE health (`relay_available`, source, expiry, failure class). In production, missing secrets or invalid provider responses must fail loudly with alerting; an emergency STUN-only mode must be an explicit flag and emit a high-severity event per attempt.
3. **CALL-CONF-01:** close/cancel the prior WS before replacement and generation-gate message, error, and done callbacks. Assert exactly one ticket mint and one active signaling socket per reconnect attempt.
4. **CALL-CONF-03:** clamp A/V conference presentation to 2–25 and use scroll/virtualization for roster layout. The server remains the admission authority.

### Phase 6 — Complete observability and iOS lifecycle

1. **CALL-OBS-01:** emit stage events at authoritative transitions, not comments/declarations. Preserve one trace and cumulative reconnect/error identity across the call.
2. **CALL-MEDIA-01:** record accept time, first inbound RTP (`bytesReceived` delta), first decoded/playout evidence (`jitterBufferEmittedCount`, audio energy where supported), first outbound RTP, selected candidate pair, relay/direct type, ICE restart count, network type, and failure stage for each direction.
3. **CALL-GEO-01:** emit Worker `cf.colo`, placement hint/first-access evidence, and invite-hop durations without logging SDP, ICE credentials, tickets, phone numbers, or raw user IDs.
4. **CALL-IOS-01:** when iOS is in release scope, create/verify the host integration so the audio engine starts only after CallKit `didActivateAudioSession`; every terminal and ghost-suppression branch calls `reportCallEnded`. iOS release is blocked until device tests pass.

### Phase 7 — Chaos battery and promotion gates

Implement **CALL-TEST-01** and run the complete matrix in section 5. Promote staging to production only when there are no P0/P1 failures, no unexplained charged-never-connected rows, and the real-device media/ring thresholds pass. Production rollout should be canaried with the existing kill switches and monitored before broad enablement.

## 5. Required test matrix

### 5.1 Billing and Durable Object alarms

- every human call/message path performs zero wallet holds and zero settlements regardless of duration or outcome;
- stale paid-call confirmation and conference-billing requests cannot charge and return a stable free-policy result;
- a legacy billing arm is rejected and any existing state is moved to full-refund retirement without settling another minute;
- duplicate refund, duplicate terminal, duplicate alarm delivery, refund retry, DO hibernation/restart, and out-of-order terminal events are idempotent;
- all tiers report unlimited human conference minutes and a 25-participant cap;
- ordinary human messaging remains unlimited and has no wallet/balance gate.

### 5.2 Ring/state order permutations

For each terminal event—decline, caller cancel, timeout, answer, answered elsewhere, busy, unavailable, block, spam, quick reply—test all surfaces: native incoming UI, Flutter route, ringtone, vibration, notification, caller ringback, and other devices.

Permute at minimum:

- socket ring + duplicate FCM in both orders;
- ring then terminal, terminal then late ring, and cancel during native UI creation;
- decline/cancel at 0, 100, 500, and 2,000 ms;
- expired invite after offline delivery;
- foreground/background isolate delivery;
- answer on device A while devices B/C are ringing;
- rapid redial while the previous call's delayed callbacks still exist.

### 5.3 Signaling and reconnect

- unauthenticated, wrong-user, wrong-role, expired, replayed nonce, wrong-device, wrong-call, and stale-generation tickets are rejected before socket admission;
- old socket close/error after replacement does not reconnect, consume a ticket, change state, or increment current-attempt counters;
- duplicate/reordered offer, answer, and candidate frames; ICE restart while old candidates are buffered; ufrag mismatch; reconnect during replay; simultaneous glare;
- heartbeat half-open detection and DO hibernation wake after five minutes idle;
- Wi-Fi→cellular and cellular→Wi-Fi with packet loss before, during, and after handover.

### 5.4 Audio and platform ownership

- manual mute survives focus loss/resume and cellular hold/resume;
- physical track is disabled during every hold and after terminal state;
- stale P2P/agent/receptionist callbacks cannot stop or reconfigure a newer owner;
- notification hangup for call A cannot end call B;
- Android lock-screen answer releases ringtone focus before enabling communication audio;
- iOS engine waits for `didActivateAudioSession`; decline/cancel/expired/duplicate/answered-elsewhere paths all report ended.

### 5.5 Conference and capacity

- non-member reserve/join/migration requests return 403 and do not change roster/cap;
- member removed mid-call cannot create a fresh reservation or ticket;
- 25 participants admitted, 26th rejected; reconnect of an existing participant does not consume a second slot;
- repeated WS failures maintain exactly one live socket and one fresh ticket per accepted reconnect;
- missing TURN secrets, provider 401/429/500, malformed JSON, empty ICE list, and timeout produce a visible degraded/failure state and alert.

### 5.6 Indian real-device matrix

Run caller and callee combinations on Jio, Airtel, Vi, and Wi-Fi, including one symmetric-NAT/CGNAT path and Xiaomi/Redmi, Oppo/Realme, Vivo/iQOO, Samsung, and Pixel background restrictions. Record at least:

- tap→server admission, queue enqueue, Inbox delivery, FCM receipt, UI shown;
- accept→first outbound RTP, first inbound RTP, and first playout per direction;
- candidate pair type, TURN allocation time, relay region identity, ICE restarts;
- Worker colo and durable placement evidence;
- result through both handover directions and app background/foreground.

## 6. Telemetry and alert contract

All events carry `call_id`, `trace_id`, call direction, app/build version, platform, connection generation, and privacy-safe account/device hashes. Server events also carry Worker colo and state sequence.

Required events/metrics:

- `legacy_call_billing_detected`, `legacy_call_refund_requested`, `legacy_call_refund_completed`, `legacy_call_refund_failed`, and `free_communication_charge_blocked`;
- `ring_invite_created`, `ring_delivery_attempt`, `ring_claim_result`, `ring_surface_shown`, `ring_surface_stopped`;
- `call_ws_admission`, `call_ws_replaced`, `call_ws_stale_callback_dropped`, `signaling_frame_dropped` with reason;
- `ice_credentials_result`, `candidate_pair_selected`, `ice_restart_started/completed/failed`;
- `first_outbound_rtp`, `first_inbound_rtp`, `first_audio_playout` per direction;
- `call_terminal` with internal disposition and separately privacy-safe wire disposition;
- `conference_membership_denied`, `conference_ticket_issued/consumed/rejected`, `conference_socket_count`.

Page immediately on:

- any human chat/call wallet hold or settlement after the free-policy rollout;
- any CallRoom or conference room with active legacy billing after its reconciliation window;
- production TURN unavailable/misconfigured;
- unauthorized signaling admission or conference roster mutation;
- duplicate live transport for the same participant generation above the allowed replacement window.

## 7. Release and data-safety procedure

1. Implement and test on staging first, one issue per commit.
2. Do not copy staging D1, DO SQLite, R2, or the full KV flag blob to production.
3. Before production rollout, generate a dry-run reconciliation ledger with call ID, amount previously settled, refundable amount, and idempotency key. Actual refunds require explicit approval.
4. Production deployment, feature-flag writes, refund execution, and APK/AAB build dispatch each require the owner's explicit confirmation under the repository production rules.
5. Canary auth/billing/ring changes, watch the alerts and funnel metrics, then widen. Keep a rollback flag for protocol enforcement only during the bounded rollout; never retain unauthenticated signaling as a steady-state fallback.

## 8. Definition of done

This remediation is complete only when:

- every confirmed defect ID above has a merged implementation or an explicitly documented platform-not-in-scope decision;
- CALL-RING-03's existing fix is covered by regression and verified in the tested build;
- deterministic tests pass under duplicate, reorder, retry, crash, hibernation, and fake-clock alarm conditions;
- the Indian device/network matrix has measured results, not inferred results;
- dashboards can answer relay percentage, accept→first RTP/playout by direction, ring delivery p50/p95/p99, DO colos/hops, handover success, and charged-never-connected count;
- human communication charge count is zero and the legacy reconciliation ledger has been resolved;
- there are no unauthenticated 1:1 signaling or non-member conference roster paths;
- every timer/socket/native callback proves call and generation ownership before acting;
- all production actions were separately approved and recorded.
