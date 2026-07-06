# AvaVerse Calling — Unified Control-Plane & SFU Plan (Production-Grade, 1M calls/day)

**Date:** 2026-07-06 · **Status:** FINAL DRAFT for owner review · **Owner:** davy
**Supersedes / merges:** `CALL-RECEPT-PREEMPT-PLAN.md` + `GROUP-CALL-SFU-ESCALATION-DRAFT.md`
**Method:** Both specs were run through 4 adversarial principal-engineer review sessions (WhatsApp/Signal-scale lens). This doc consolidates the verdicts into one buildable plan.

---

## 0. The one thesis that fixes everything

> **There is no single writer for call state.** Every recurring bug — callback busy, duplicate-join busy, receptionist voicemail-after-connect, the vanishing "user is busy" — is a symptom of **four independent components each believing they own "busy"**: the client (`callIsGenuinelyActive()`), the CallRoom DO, the receptionist lifecycle, and the push handler. At 1M calls/day this **regresses forever**, because every new code path has to remember all the others.

**Review scorecard of the current design:** Scalability 9.5/10 · Cloudflare suitability 10/10 · **Control-plane correctness 6.5/10 · Failure recovery 6/10.** The data plane (P2P/SFU) is good. All remaining engineering effort belongs in the **control plane**.

**The fix:** introduce a single per-account **`CallStateAuthorityDO`** that is the *only writer* of call ownership, busy state, receptionist state, reservations, and migration state. Everything else — client, CallRoom, push handler, GroupCall — becomes a **reader** that asks the authority and obeys. *One writer, many readers* (the model WhatsApp/Signal/FaceTime all converge on).

---

## 1. Canonical constraints preserved (the 6-point bible)

This plan is fully compatible with the project rulebook:

1. **Cloudflare-native, server-readable.** New authority is a Durable Object with DO-local SQLite; server remains the router; device stays local-first. No Nostr.
2. **Per-user DO-local SQLite**, never a central high-write D1. The authority stores **one row**.
3. **1:1 stays P2P** (CallRoom DO, 2-peer cap). **Groups escalate to an SFU** (≤32).
4. **Per-account scoping is mandatory.** The authority is keyed by **`account_uid`, never device/phone** — parent and child on one phone get separate authorities.
5. **Manual builds only.** Rollout is designed around *no forced app upgrade* (see §5).
6. **Provider-agnostic RTC.** Cloudflare Realtime SFU now; Jitsi fleet later; flip by config.

---

## 2. Part A — `CallStateAuthorityDO`: the control plane

### 2.1 What it owns (and only this)

One DO per `account_uid`, hibernatable. Owns **ownership, not media**: current call, peer, phase, receptionist state, reservation tokens, epoch, lease, active device. **Never** stores SDP, ICE, media, or WebSocket frames — so it stays tiny and millions of instances are cheap.

### 2.2 DO-local SQLite schema

```sql
-- exactly one row
CREATE TABLE call_state (
  uid                       TEXT PRIMARY KEY,
  call_id                   TEXT,
  peer_uid                  TEXT,
  phase                     TEXT,     -- see FSM
  direction                 TEXT,     -- in|out
  rtc_provider              TEXT,     -- cloudflare|jitsi|livekit
  epoch                     INTEGER,  -- uint64, monotonic, the heart of the design
  lease_expiry_ms           INTEGER,
  owner_session_id          TEXT,
  owner_device_id           TEXT,
  receptionist_target_uid   TEXT,
  callback_reserved_peer    TEXT,
  callback_reservation_until INTEGER,
  callroom_id               TEXT,
  last_transition_ms        INTEGER,
  last_mutation_uuid        TEXT,     -- idempotency
  updated_at                INTEGER
);

CREATE TABLE call_transitions (      -- 24h retention, debugging only
  epoch INTEGER, call_id TEXT, from_phase TEXT, to_phase TEXT,
  reason TEXT, mutation_uuid TEXT, timestamp INTEGER
);

CREATE TABLE reservations (          -- normally 0-1 rows
  peer_uid TEXT, reservation_type TEXT, expires_at INTEGER, epoch INTEGER
);
```

### 2.3 State machine (busy is NOT a phase)

```
IDLE → OUTGOING_RINGING / INCOMING_RINGING → CONNECTING → CONNECTED
IDLE → RECEPTIONIST_ACTIVE
     → CALLBACK_RESERVED → CONNECTING → CONNECTED
CONNECTED → MIGRATING → CONNECTED (SFU)      (see Part C)
any → RELEASING → IDLE
```

**"Busy" is a derived property:** `busy ⇔ (phase != IDLE) OR an active reservation`. It is never stored as a boolean anyone can write.

### 2.4 Epoch + lease (concurrency + liveness)

- **Epoch** = `uint64`, monotonic, `epoch++` on every successful mutation. No wall clocks, no timestamp ordering, no UUID ordering — just `43 → 44 → 45`. Every client request carries `expected_epoch`; the DO does **compare-and-swap (CAS)**. Mismatch → `409 conflict`, request rejected.
- **Lease** = the authority owns a `lease_expiry` (now + 30s), refreshed by a client heartbeat every 10s while `CONNECTED`. **If the client dies, the lease expires and the authority auto-releases to `IDLE`** — no orphaned calls.
- **Clock skew is a non-issue:** the DO is the only writer, so there is exactly one clock. Never compare clocks across components; only compare epochs.

### 2.5 API (Cloudflare DO **RPC** internally; HTTP only at public ingress)

Every mutation takes `expected_epoch` + `mutation_uuid` (idempotency). Duplicate `mutation_uuid` → return the previous result, never execute twice.

| Method | Purpose | Key logic |
|---|---|---|
| `acquireCall(caller,peer,call_id,dir,idem,expected_epoch)` | Claim a call | if idem exists→return prior; if epoch≠current→conflict; if `IDLE`→acquire, epoch++, `OK`; else `BUSY(reason)` |
| `transitionPhase(call_id,from,to,expected_epoch,mut)` | Move phase | CAS; epoch++; persist; return new epoch |
| `queryBusy(peer)` | **Read-only** busy check | returns `{busy, phase, peer, epoch, busy_reason, reservation}` |
| `reserveCallback(peer,call_id,ttl,expected_epoch)` | Reserve for imminent callback | set `callback_reserved_peer`, `expires=+8s`, phase `CALLBACK_RESERVED`, epoch++ |
| `preemptForCallback(caller,target,call_id,reservation,expected_epoch)` | Callback wins over Ava | if `phase==RECEPTIONIST_ACTIVE && receptionist_target==caller` → `PREEMPT`, epoch++ ; else `ALLOW`/`BUSY` |
| `abandonReceptionist(call_id,reason,mut,expected_epoch)` | Kill Ava cleanly | phase `RELEASING`, epoch++, notify ReceptionRoom, **await ACK**, phase `IDLE`, epoch++ |
| `releaseCall(call_id,expected_epoch)` | End | CAS→clear row, epoch++, `IDLE` |

### 2.6 Busy routing — nobody decides, everybody asks

- **Client:** delete "if call active → busy". Instead obey the authority's decision (delivered in the push, see §2.8).
- **Push handler:** delete `callIsGenuinelyActive()`. Instead the *server* already asked the authority and the push carries the instruction.
- **CallRoom:** delete "room full → busy". Instead `Authority.transition(CONNECTED)`; if rejected, terminate the room.

**Authority always wins over CallRoom.** If CallRoom says `CONNECTED` but authority says `IDLE`, the authority instructs the room to destroy itself — never the reverse.

### 2.7 The two canonical flows (now race-free)

**Callback preempts Ava (A calls B, B misses, A on B's Ava, B calls back):**
```
A→Authority(B).acquireCall → OUTGOING_RINGING (epoch 81) → push → B rings → miss
Authority(B): OUTGOING_RINGING → IDLE (epoch 82)
A starts Ava:  Authority(A) → RECEPTIONIST_ACTIVE target=B (epoch 144)
               ReceptionRoom linked with authority_epoch=144
B calls back:  Authority(A).preemptForCallback(B)
               sees phase=RECEPTIONIST_ACTIVE, target=B → PREEMPT, CALLBACK_RESERVED (epoch 145)
               RPC → ReceptionRoom.abort() → ACK → Authority → CONNECTING (epoch 146)
               push (instruction: "ring", carries epoch) → Connected (epoch 147)
```
**No voicemail** — ReceptionRoom finalizes *only* if the authority epoch it holds (144) is still current. It changed to 145+, so finalize is suppressed.

**Third caller C during Ava:** `C→Authority(A).acquireCall` sees `phase=RECEPTIONIST_ACTIVE, target=B` → returns `BUSY reason=RECEPTIONIST`. Worker immediately redirects C to A's own Ava. **No client involvement.**

**Deterministic tie-break (callback vs third caller within 100ms):** the reservation on `peer=B` means C loses with `busy_reason=RESERVED`. Without the reservation both could ring — this is why reservations are mandatory.

### 2.8 The critical latency optimization

**Never make the client query the authority after the push.** By the time the push reaches the device, the server has already (a) made the preemption decision, (b) aborted the receptionist, (c) committed the new authority state. The push carries an **instruction** ("ring this call", + current `authority_epoch`), not a question.

**Callback-preempt latency budget (target < 2s = one ring):**

| Step | Budget |
|---|---|
| Callback request → Authority RPC | 40 ms |
| Preempt mutation | 5 ms |
| ReceptionRoom RPC (abort) | 40 ms |
| Abort ACK | 20 ms |
| Authority commit | 5 ms |
| Push enqueue | 50 ms |
| FCM/APNS delivery | 300–1200 ms |
| Client wake | 150–400 ms |
| Ring | 100 ms |
| **Typical / worst-normal** | **~700–1100 ms / ~1.6 s** |

**Reservation token:** `preemptForCallback()` returns `{reservation_id, authority_epoch, expires_at, peer_uid}`. The subsequent CallRoom creation and incoming push **must present it**; any duplicate/delayed/concurrent signaling path arriving without the current reservation or with an older epoch is rejected. This turns callback-preemption into **one atomic server-side transaction** instead of loosely coupled events.

### 2.9 Split-brain & hibernation

- **Stale events:** every push, WebSocket frame, and REST mutation carries `authority_epoch`. Clients store the highest epoch seen and **discard anything lower**. An old WebSocket sending a transition at epoch 81 when current is 85 → rejected. Nothing stale can mutate state.
- **Hibernation wake:** on wake the DO first checks `lease_expired?` → if yes, `CONNECTED → IDLE`. Otherwise it reconciles: `CallRoom.status(call_id)` returns `{alive, participants, connected}`; on mismatch **the authority wins or repairs**.

---

## 3. Part B — Receptionist preemption (maps the old 6-phase plan onto the authority)

The original `CALL-RECEPT-PREEMPT-PLAN.md` phases survive, but the *decision* moves server-side into the authority:

1. **Receptionist state machine (server-authoritative):** replace the single "abandon" with
   `ACTIVE → PREEMPTING → ABANDONED → FINALIZED`.
   During **PREEMPTING**: STT stops, LLM is cancelled, transcript is frozen, finalizer is blocked. This is the atomic transition that prevents "LLM already running → abandon → LLM finishes → message posted anyway."
2. **`busy_reason` is a closed enum**, never a free-form string:
   `ACTIVE_CALL · RECEPTIONIST · GROUP_LIMIT · CALL_MIGRATION · ACCOUNT_SWITCH · DEVICE_HANDOFF · RINGING_OTHER_DEVICE · RESERVED · UNKNOWN`. Reason codes are analytics gold.
3. **Busy is a terminal call state, not a UI state.** Model `CallSession: … → ENDING_BUSY → ENDED_BUSY`; the navigator merely *observes*. Teardown must never own the UI — that is the real cause of the "appears then disappears" busy screen. No auto-dismiss/auto-pop timers.
4. **Server timeout, never wait forever.** Some Android OEMs deliver push in 10–20s. If the reservation expires before the callback connects, fall back to voicemail deterministically.

---

## 4. Part C — Group SFU escalation (P2P → SFU), integrated with the authority

### 4.1 The one architectural change

> **`GroupCallDO` must never commit a migration. Only each participant's own `CallStateAuthorityDO` may commit its own migration.** GroupCallDO *coordinates*; each authority *commits*; CallRoom dies last. This eliminates nearly every partial-migration failure.

Migration is a **distributed transaction (N independent commits coordinated by GroupCallDO)**, not a "move everyone" room migration. The naive `create SFU → join → tear down P2P` has the classic two-phase-commit hole: A tears down P2P while B is still joining → silence.

### 4.2 State machines

**Per-participant (in each `CallStateAuthorityDO`):**
```
CONNECTED_P2P → MIGRATION_PREPARING → SFU_JOINING → SFU_VALIDATING
              → READY_TO_SWITCH → CONNECTED_SFU → RELEASE_P2P
Rollback:     MIGRATION_FAILED → CONNECTED_P2P
```
No participant reaches `CONNECTED_SFU` until its **own** authority commits.

**Coordinator (`GroupCallDO`):**
```
IDLE → CREATING_ROOM → INVITING → WAITING_FOR_EXISTING → READY → COMMITTED → ENDED
```
`READY` = **every** participant authority has reported `READY_TO_SWITCH`; only then `commit()`.

### 4.3 "SFU audio confirmed" — a media condition, not a signaling one

Do **not** trust "joined room" / "first RTP packet" / "WebRTC connected" (all too weak). Require, per participant:
- ICE connected **and**
- DTLS established **and**
- local audio published **and**
- **≥1 remote audio RTP stream received AND decoded with actual audio energy** (silent RTP does not count) **and**
- roster synchronized.

For rooms > 2, **do not** require N−1 streams (scales poorly). Require **≥1 remote audio + roster sync** — the SFU guarantees routing.

**Rollback timeout (20s) belongs to the authority, not GroupCallDO** (a participant may reconnect independently). On timeout: authority → `CONNECTED_P2P`; GroupCallDO merely observes.

### 4.4 Cloudflare Realtime SFU — scaling realism

- **DO/control plane is NOT the bottleneck.** Per-call DO, per-user authority — no hotspot even at 100k concurrent rooms. Roster fan-out is tiny (10 updates/s × 32 sockets = 320 msg/s).
- **The first bottleneck is always SFU uplink → egress.** 32-way **video** is economically impractical: each active speaker fans out 31 downstream copies × thousands of rooms. **Audio at 32 is fine; video is the cost driver.**
- **Treat `provider_capacity_exhausted` as a normal control-plane outcome**, not an exception — authority retries another region. Never assume infinite capacity or a fixed `32`.
- The provider adapter must expose `maxParticipants`, `maxPublishedTracks`, `maxSubscriptions` — otherwise the abstraction leaks.

### 4.5 Invites, allowlist, revocation (anti-storm)

Signed HMAC ticket = `{call_id, participant_uid, generation, role, expiry, nonce, signature}`.
- **Replay** blocked by `nonce + generation + authority epoch`.
- **Revocation** via `membership_version` in GroupCallDO: removing anyone does `version++`; old tickets become invalid (`generation mismatch → reject`). A removed member's old ticket can't rejoin.
- **Invite storms** ("anyone can add up to 32"): `invite_lock(uid)` in GroupCallDO with a 30s TTL pending-invite. A second inviter targeting the same uid gets `already_invited` — no duplicate pushes.

### 4.6 Video > 6 → audio-locked (server-enforced, race-free)

- Server-authoritative `mode = VIDEO | AUDIO_LOCKED` is necessary **but not sufficient on its own** — client honor-system is not enough. **Enforce at the SFU via the provider adapter:** `publishTrack(video)` while `AUDIO_LOCKED` → provider returns `403`, track rejected. A late camera track arriving after the lock is rejected by the SFU, not the client.
- **The "two people add the 7th simultaneously" race** is solved with CAS: both requests carry `expected membership_version`; only one succeeds, the second gets `409` and reloads the roster. Same `membership_version`/`migration_generation` CAS covers duplicate "Add" taps.
- Degrade is **one-way** (audio-locked for the rest of the call, per owner decision D7); new calls start fresh in video if n ≤ videoMax.

### 4.7 Provider-agnostic `RtcProvider` — the minimum viable contract

To make Cloudflare → Jitsi → LiveKit a true config flip, standardize:
- **Events:** `CONNECTED · RECONNECTING · DISCONNECTED · REMOTE_JOIN · REMOTE_LEAVE · TRACK_ADDED · TRACK_REMOVED · QUALITY_CHANGED · MODE_CHANGED · ERROR`.
- **Normalized stats:** `rtt · packet_loss · jitter · mos · available_bitrate · audio_level · encode_latency · decode_latency · publish_state · subscribe_state · ice_state · candidate_type(relay|direct)`.
- **Capability flags:** `supportsSimulcast · supportsDynacast · supportsServerMute · supportsRecording · supportsScreenshare` — so client code never checks provider *names*.
- **Where it leaks (accept and wrap):** simulcast/SVC/adaptive-stream and speaker detection. Enforce server-side policy (e.g., audio-lock camera rejection) **through the adapter**, not the client.
- **Never migrate an active room across providers** — provider change applies to *new* rooms only.

### 4.8 Geo telemetry → Jitsi placement

`request.cf` (colo/country/city) is helpful but **not sufficient** — two users in one country can differ 200ms. Also capture: **join latency, ICE latency, RTP RTT, packet loss, carrier, ASN, relay-vs-direct, network type (wifi/5G/LTE), CGNAT/Starlink/corporate ASN.** The decisive metric for placement is **RTT to the selected SFU**, not geography — the placement engine should optimize measured RTT.

---

## 5. Part D — Rollout without a half-migrated control plane

> **Highest-risk item overall:** replacing the control plane while phones run old builds. At WhatsApp/Signal scale, most outages come from *migration*, not the new architecture. The failure mode to design against is **two authorities at once** (new DO live while legacy client paths still decide "just in case").

### 5.1 Backward-compatibility rule

**The server may become *stricter*, never *looser*.** A legacy client that self-declares busy is trusted about *itself*; a legacy client that declares idle can still be *overridden* to busy by the authority. Never infer client capability from app version — use an explicit **`protocol_version`** on every request (`v1 = legacy`, `v2 = authority-aware`). Compatibility is gated on `minimumProtocolVersion`, **not** `minimumAppVersion`.

### 5.2 Phase order (infrastructure first, behavior second, UI last)

| Phase | Scope | Behavior change |
|---|---|---|
| **A** | Ship `CallStateAuthorityDO` (schema, RPC, epochs, leases, transition logging, PostHog). Nothing reads it. | none |
| **B** | Dual-write: every legacy lifecycle mutation also RPCs `Authority.transition(...)` (accept, receptionist start/stop, busy, hangup, migrate, rollback). Authority still passive. | none |
| **C** | **Divergence measurement**: authority computes `would_allow/busy/preempt/redirect`; log `{authority_decision, legacy_decision, match, reason, epoch}` to PostHog. | none |
| **D** | **Read-before-write (advisory)**: server consults authority but still honors legacy; logs disagreements. | none |
| **E** | **Protocol v2 clients obey the authority** (stop self-deciding busy); v1 clients keep legacy behavior. | v2 only |
| **F** | **Receptionist migration**: enable authority callback-preempt / abandon / busy routing (Part B). | v2 only |
| **G** | **SFU migration**: authority `MIGRATING` + GroupCallDO distributed commit (Part C). | v2 only |
| **H** | **Cleanup**: delete `callIsGenuinelyActive()`, legacy autobusy, legacy push decisions — only after divergence ≈ 0 and legacy client usage is very low. | remove legacy |

### 5.3 Four independent rollout flags + kill switch (per-account, no deploy)

`authorityShadow` (log only) → `authorityRead` (server consults) → `authorityWrite` (authority transitions canonical, legacy still compared) → `authorityEnforced` (legacy ignored).
**Kill switch:** flip `authorityEnforced=false` → instantly back to legacy, no redeploy, no app update.
Keep group flags independent too: `groupMigration · sfuEnabled · providerSelection · providerOverride · audioLock · inviteCAS`. **Never one giant flag.**

### 5.4 Canary by account, not by device or percentage

`internal team → test users → employees → known beta → 1% → 10% → 100%`, keyed by `account_uid`. Only flip `authorityEnforced` once shadow **decision divergence < 0.1%** (target 99.99% agreement). Build **one** dashboard — "Authority Shadow Accuracy": Busy Match %, Busy False Positive/Negative, Receptionist Match, Callback Match, Epoch Conflict Rate, Shadow Latency.

---

## 6. Part E — Top 10 production-readiness gaps still open

1. **DO cold-start storms.** Morning commute = 100k simultaneous wakes. Keep the authority *tiny* (one SQLite row, no caches, no heavy init); measure a wake-latency histogram.
2. **Authority DO = per-user SPOF.** If unreachable, calls fail. Define: RPC timeout → retry (idempotent) → fail *closed* for writes; reads may use a cached lease for a very short interval (<2–3s) only if provably correct.
3. **SQLite durability / DR.** Authority state must be **reconstructable** from CallRoom + ReceptionRoom + leases after storage loss/corruption. Never a permanent loss.
4. **Shared parent/child phones.** Authority keyed by `account_uid` only. Every RPC, WebSocket, push, and cache key scoped by account — one account's busy state must never leak to another on the same device.
5. **RPC policy.** Every RPC has an explicit **deadline, retry budget, backoff, idempotency key.** No blind/infinite retries.
6. **Call spam / abuse.** Per-account rate limits, fan-out limits, daily quotas, reputation weighting, cooldowns, challenge hooks — enforced at the authority **before room allocation**.
7. **TURN / relay (big omission).** P2P needs TURN for NAT traversal: allocation strategy, relay budgeting, regional placement, abuse prevention. Without it, many calls silently fall back to SFU (cost) or fail.
8. **End-to-end trace ID.** One `call_trace_id` propagated across client → push → Authority DO → CallRoom → GroupCall DO → ReceptionRoom → RTC provider. Without it, prod debugging is miserable.
9. **Load + soak testing.** Prove 1M calls/day: peak-hour simulation incl. cold starts, migration, callback, receptionist; 24–72h soak with no memory growth, lease leaks, or orphaned authorities; exercise the 32-participant limit.
10. **Regional outage.** If a Cloudflare colo fails: authority retries a different colo under the same durable identity — explicitly tested.

---

## 7. Part F — SLOs and the 5 required alerts

**SLOs (define before building more features):**
- Call setup (caller press → ringing): **P95 < 2.5s**
- Callback preemption: **P99 < 2s** (one ring)
- Authority RPC: **P99 < 75ms**
- Migration success **> 99.5%**; rollback automatic **100%**
- False-busy rate **< 0.01%**

**The 5 alerts that must exist before we call this production-grade:**
1. **Authority divergence > 0.1%** (immediate) — shadow decision parity regressed.
2. **`ava_recept_message_posted` within 120s AFTER `call_connected` for the same pair > 0** — voicemail-after-connect must effectively never happen.
3. **Migration rollback rate > 2%** — investigate SFU/network.
4. **Authority RPC P99 > 150ms** — control plane latency.
5. **Split-brain: `authority_epoch != callroom_epoch` > 0.05%** — reconciliation failing.

(Reuse the pattern of existing PostHog dashboards 775372 / 778575; every event carries the base envelope `call_id, provider, mode, participant_count, role, app_version, build, account_id` + email for the test user per project rule.)

---

## 8. Part G — Definition of Done

**Architecture**
- `CallStateAuthorityDO` is the *only* writer of call ownership, busy, receptionist, reservations, migration.
- CallRoomDO owns only signaling/media; GroupCallDO owns only roster/invites/migration coordination.
- Every mutation uses epoch CAS + idempotency key; every RPC has deadline/retry/backoff.

**Compatibility**
- Protocol v1 (legacy) and v2 (authority-aware) clients interoperate.
- Shadow mode ran long enough to show stable decision parity; divergence < threshold before enforcement.
- A single kill switch disables enforcement without redeploy.

**Reliability**
- Callback preemption never produces a voicemail after a connected callback.
- Every migration commits or rolls back cleanly to P2P; no stale epoch can mutate state.
- Authority state reconstructable after storage loss; cold-start latency measured under peak load.

**Scale**
- Peak-hour load tests representative of 1M calls/day pass; 24–72h soak clean (no leaks/orphans); 32-participant fan-out/invite/migration exercised.

**Operations**
- End-to-end trace IDs across all components; SLO dashboards live and monitored; all 5 alerts configured and verified.
- Manual deploy + rollback procedures documented and rehearsed.
- **Build number verified on both test devices before any "it's fixed" claim** (past recurrences were partly stale builds).

---

## 8B. PostHog Telemetry Contract (full event catalog — "track everything")

This is the canonical telemetry schema for both the Flutter client and the Cloudflare backend. Every engineer emits exactly these `snake_case` names. It is the reference the 5 alerts in §7 and the shadow-mode rollout in §5 depend on.

### 8B.1 Naming standard

Events are `lowercase snake_case`, shaped `<domain>_<action>` (e.g. `authority_state_transition`, `groupcall_join`, `rtc_quality_tick`). Properties are `snake_case`, no abbreviations. **Units are suffixed:** time `_ms`, bytes `_bytes`, bitrate `_kbps`, percent `_pct`, count `_count`, version = integer, booleans `true/false`. IDs are UUIDv7: `call_id, call_trace_id, room_id, authority_id, session_id, device_session_id, mutation_id, reservation_id, invite_id, push_id`. **`call_trace_id` never changes for the lifetime of a call** and is propagated client → push → Authority → CallRoom → GroupCall → SFU → PostHog. Every event carries `schema_version`.

### 8B.2 Base event envelope (on EVERY event)

`event_time_ms, schema_version, call_trace_id` (required); `call_id, authority_epoch, authority_phase` (call-scoped); `account_id` (required), `account_email` (**test users only**, per project rule), `device_session_id, device_id, owner_device, app_version, build, protocol_version` (required); `rtc_provider, rtc_mode (p2p|sfu), media_mode (audio|video|audio_locked), participant_count`; `role` (caller|callee|invitee|adder…, required); `network_type, carrier, device_model, os, os_version, locale` (device); `country, colo` (from `request.cf`, server events); `request_id, authority_id, room_id, mutation_id`; `retry_count, sampled, sample_rate` (required).

### 8B.3 Global enums (never send free-form strings)

- `busy_reason`: `active_call · receptionist · callback_reserved · group_full · migration · ringing_other_device · account_switch · device_handoff · rate_limited · blocked · do_not_disturb · provider_failure · unknown`
- `authority_phase`: `idle · incoming_ringing · outgoing_ringing · connecting · connected · receptionist_active · callback_reserved · migrating · releasing`
- `ended_reason`: `completed · declined · busy · missed · cancelled · timeout · network · ice_failure · provider_failure · rtc_error · migration_failed · preempted · duplicate_session · authority_rejected · abandoned · voicemail · rate_limited · unknown`
- `rtc_error_stage`: `token · authority_rpc · callroom_rpc · groupcall_rpc · websocket · push · ice · dtls · publish · subscribe · renegotiation · turn · relay · track · codec · provider · network · permission · timeout · unknown`
- `rtc_provider`: `cloudflare · jitsi · livekit · mock · unknown`
- `rtc_mode`: `p2p · sfu` · `media_mode`: `audio · video · audio_locked`
- `authority_decision`: `allow · busy · preempt · redirect_receptionist · reject · retry · conflict`

### 8B.4 Authority event catalog (control plane)

| event | producer | trigger | key properties | sample |
|---|---|---|---|---|
| `authority_acquire_call` | AuthorityDO | `acquireCall()` | caller_uid, callee_uid, authority_epoch_before/after, decision, idempotency_key, latency_ms | 1.0 |
| `authority_query_busy` | AuthorityDO | `queryBusy()` | queried_uid, busy, busy_reason, authority_phase | 1.0 |
| `authority_state_transition` | AuthorityDO | phase change | from_phase, to_phase, authority_epoch_before/after, transition_reason | 1.0 |
| `authority_transition_rejected` | AuthorityDO | CAS failure | expected_epoch, actual_epoch, transition_reason | 1.0 |
| `authority_epoch_conflict` | AuthorityDO | stale mutation | expected_epoch, actual_epoch, mutation_id | 1.0 |
| `authority_preempt_callback` | AuthorityDO | callback reservation succeeds | receptionist_target_uid, reservation_id, latency_ms | 1.0 |
| `authority_callback_reservation_created/expired/consumed` | AuthorityDO | reservation lifecycle | reservation_id, peer_uid, ttl_ms / consuming_call_id | 1.0 |
| `authority_receptionist_abandon_requested` | AuthorityDO | `abandonReceptionist()` | abandon_reason, receptionist_session_id | 1.0 |
| `authority_release_call` | AuthorityDO | `releaseCall()` | ended_reason, duration_ms | 1.0 |
| `authority_lease_renewed` | AuthorityDO | heartbeat | lease_expiry_ms, heartbeat_interval_ms | 0.10 |
| `authority_lease_expired` | AuthorityDO | lease timeout | last_owner_device, lease_duration_ms | 1.0 |
| `authority_recovered_after_wake` | AuthorityDO | cold-wake reconcile | recovered_phase, recovered_epoch, reconciliation_ms | 1.0 |
| `authority_callroom_reconciliation` | AuthorityDO | compared w/ CallRoom | authority_phase, room_phase, match, repaired | 1.0 |
| `authority_split_brain_detected` | AuthorityDO | disagreement | authority_phase, callroom_phase, client_phase, repaired | 1.0 |
| `authority_rpc_started/completed/failed` | Caller Worker | outgoing RPC | rpc_name, destination_do, latency_ms, retry_count, error | 0.10 / 0.10 / 1.0 |
| `authority_shadow_decision` | Worker | shadow comparison | legacy_decision, authority_decision, match, legacy_busy_reason, authority_busy_reason | 1.0 |
| `authority_shadow_divergence` | Worker | mismatch | legacy_decision, authority_decision, divergence_reason | 1.0 |
| `authority_duplicate_mutation` | AuthorityDO | repeated mutation_id | mutation_id, first_seen_ms, duplicate_count | 1.0 |
| `authority_owner_changed` | AuthorityDO | device owner change | old/new_device_session_id | 1.0 |
| `authority_protocol_fallback` | Worker | legacy path taken | client_protocol_version, fallback_reason | 1.0 |

### 8B.5 Receptionist event catalog

`receptionist_session_started` (receptionist_session_id, target_uid, caller_uid) · `receptionist_session_connected` (connect_latency_ms) · `receptionist_stt_started/stopped` (provider, language, reason) · `receptionist_llm_started/completed` (model, tokens_in, tokens_out, latency_ms) · `receptionist_session_ended` (duration_ms, ended_reason) · `receptionist_abandon_requested/received/completed` (abandon_reason, latency_ms, total_latency_ms) · `receptionist_preempt_requested/completed/failed` (peer_uid, reservation_id, abort_latency_ms, failure_reason) · `receptionist_voicemail_generated` (audio_duration_ms) · **`receptionist_voicemail_suppressed`** (suppression_reason, callback_call_id) · `receptionist_summary_generated/suppressed` · `receptionist_delivery_started/completed/failed` (delivery_latency_ms, error) · `receptionist_audio_uploaded/deleted` · **`receptionist_callback_preempt_funnel`** (callback_detected, authority_preempt_ms, abandon_completed_ms, ring_started_ms, connected_ms, voicemail_suppressed) · **`receptionist_false_delivery`** (connected_within_ms — voicemail delivered after a connected call; must be zero). All 1.0.

### 8B.6 Busy event catalog

`busy_decision` (busy_reason, authority_phase, authority_decision) · `busy_shown` (busy_reason, authority_epoch) · `busy_tone_started/completed` (duration_ms) · `busy_redirect_receptionist` (redirect_reason, receptionist_session_id) · `busy_terminal_screen_shown/closed` (manual_leave_message_available, visible_duration_ms) · **`busy_false_positive`** (reconnect_delay_ms, original_busy_reason — connected within 10s after busy) · `busy_false_negative` (legacy_reason, authority_reason) · `busy_shadow_match/mismatch` (legacy_busy, authority_busy, match) · `busy_ignored_duplicate` (duplicate_source, authority_epoch) · `busy_override_by_authority` (client_decision, authority_decision) · `busy_retry_after_timeout` (retry_after_ms) · `busy_rate_limited` (rate_limit_bucket, retry_after_ms). All 1.0.

### 8B.7 P2P / CallRoom event catalog

Setup funnel (all 1.0, Client unless noted): `call_dial_started` (target_uid, dial_type, source, is_redial) · `call_request_sent` (Worker; destination_uid, request_latency_ms) · `call_request_received` (signaling_latency_ms) · `call_incoming_shown` (display_latency_ms) · `call_ring_started/stopped` (ring_source, stop_reason) · `call_answered` (answer_latency_ms) · `call_declined/cancelled` (decline_reason/cancel_reason) · `call_connect_started` (rtc_provider, rtc_mode) · `call_connected` (connect_latency_ms, authority_epoch, relay_used) · `call_ended` (ended_reason, duration_ms).
CallRoom DO: `callroom_duplicate_session_detected` (device_session_id, participant_uid) · **`callroom_duplicate_session_blocked`** (duplicate_reason, existing_session_id) · `callroom_duplicate_session_adopted` (previous/new_session_id) · `callroom_state_reconciled` (authority_epoch, repaired).
WebRTC internals (0.10–0.25): `rtc_offer_created/answer_created` (sdp_size_bytes) · `rtc_offer_sent/answer_sent` (Worker) · `rtc_ice_gathering_started/completed` (ice_policy, gathering_duration_ms, candidate_count) · `rtc_ice_connection_state_changed`/`rtc_dtls_state_changed` (previous_state, current_state) · **`rtc_selected_candidate_pair`** (local_candidate_type, remote_candidate_type, protocol, relay_used) · **`rtc_turn_relay_used`** (turn_region, relay_reason, candidate_pair) · `rtc_direct_p2p_established` (candidate_pair) · `rtc_reconnect_started/completed/failed` (reconnect_reason, reconnect_duration_ms, failure_reason) · `rtc_track_added` (track_kind, participant_uid).

### 8B.8 Push event catalog (all 1.0 unless noted)

`push_sent`/`push_send_failed` (Worker; provider, error_code) · `push_received` (push_type, receive_latency_ms) · `push_opened` (wake_latency_ms) · `push_processed`/`push_processing_failed` (processing_latency_ms, failure_reason) · `push_duplicate_received` (push_id, duplicate_count) · `push_out_of_order` (received_epoch, current_epoch) · **`push_ignored_stale_epoch`** (received_epoch, authority_epoch) · `push_authority_query_started/completed/failed` (0.25; authority_latency_ms, failure_reason) · `push_routed_to_receptionist` (Worker; busy_reason, receptionist_session_id) · **`push_callback_preempt_received`** (authority_epoch, reservation_id) · `push_notification_displayed/tapped` (notification_latency_ms, tap_delay_ms) · `push_expired` (Worker; ttl_ms) · `push_delivery_timeout` (Worker; timeout_ms) · `push_retry_scheduled` (Worker; retry_delay_ms, retry_count).

### 8B.9 GroupCall / SFU event catalog (all 1.0 unless noted)

Escalation & migration: `groupcall_escalate_started/completed/failed` · `groupcall_migration_prepare_completed` (preparation_ms) · `groupcall_sfu_room_created/creation_failed` (Provider Adapter; provider_room_id, creation_latency_ms, provider_error) · `groupcall_join_started/completed/failed` (provider, media_mode, join_latency_ms, participant_count, failure_reason, provider_code) · `groupcall_leave` (leave_reason, connected_duration_ms) · **`groupcall_migrate_timeout`** (GroupCallDO; timeout_ms, rollback_completed) · `groupcall_migrate_rollback_started/completed` (rollback_reason, rollback_duration_ms) · **`sfu_audio_confirmed`** (ice_connected, dtls_connected, local_audio_published, remote_audio_received, audio_energy_detected, confirmation_latency_ms) · `groupcall_ready_to_switch` (validation_latency_ms) · `groupcall_switch_committed` (AuthorityDO; authority_epoch_before/after) · `groupcall_release_p2p` (release_latency_ms).
Invites: `groupcall_invite_created` (invite_id, invitee_uid, membership_version) · `groupcall_invite_sent/received/accepted/declined/expired` (latency fields, decline_reason).
Membership & mode: **`groupcall_membership_cas_conflict`** (…prevented) · `groupcall_full_rejected` (participant_count, max_participants) · `groupcall_degrade_warning_shown/confirmed/cancelled` (participant_count_before/after, confirmation_latency_ms) · **`groupcall_mode_degraded`** (previous_mode, current_mode) · **`groupcall_audio_lock_enforced`** (Provider Adapter; participant_uid, rejected_track_id) · `groupcall_video_publish_rejected` (rejection_reason) · `groupcall_roster_updated` (0.25; participant_count, update_reason) · `groupcall_provider_capacity_rejected` (provider_limit, participant_count).

### 8B.10 RTC quality event catalog

**`rtc_quality_tick`** — Client, every 10s while connected, **1.0 during beta → 0.25 after launch → configurable to 0.10** (highest-volume event). Fields: `rtt_ms, jitter_ms, packet_loss_in_pct, packet_loss_out_pct, packets_sent, packets_received, packets_lost_in, packets_lost_out, audio_bitrate_kbps, video_bitrate_kbps, available_send_bandwidth_kbps, available_receive_bandwidth_kbps, audio_codec, video_codec, encode_time_ms, decode_time_ms, frame_width, frame_height, frames_per_second, audio_level_in, audio_level_out, cpu_usage_pct, memory_usage_mb, thermal_state, ice_connection_state, dtls_state, selected_candidate_pair, local_candidate_type, remote_candidate_type, relay_used, turn_region, reconnect_count, active_speaker, published_audio_tracks, subscribed_audio_tracks, published_video_tracks, subscribed_video_tracks, participant_count`.

**`rtc_quality_summary`** — Client, on leave, 1.0. Fields: `call_duration_ms, connected_duration_ms, average_rtt_ms, p50_rtt_ms, p95_rtt_ms, max_rtt_ms, average_jitter_ms, max_jitter_ms, average_packet_loss_in_pct, average_packet_loss_out_pct, max_packet_loss_pct, average_audio_bitrate_kbps, average_video_bitrate_kbps, average_available_send_bandwidth_kbps, average_available_receive_bandwidth_kbps, relay_used, turn_region, reconnect_count, reconnect_total_duration_ms, ice_restart_count, audio_dropouts_count, video_freezes_count, frames_sent, frames_received, average_frames_per_second, average_encode_time_ms, average_decode_time_ms, mos_estimate, provider_error_count, fatal_error_count, network_switch_count, participant_count, media_mode, rtc_provider, ended_reason`.

Operational: `rtc_network_changed` (previous/current_network_type, carrier, dns_probe_result) · `rtc_bandwidth_estimate_changed` (0.10) · `rtc_active_speaker_changed` (0.05) · `rtc_track_muted/unmuted` · `rtc_camera_enabled/disabled` · `rtc_microphone_enabled/disabled` · **`rtc_error`** (Client/Worker/Adapter; stage, provider_code, provider_message, fatal, recoverable, retry_count, latency_ms) · `rtc_provider_warning/recovered` · `rtc_media_permission_denied` (permission, permanently_denied) · `rtc_device_changed` · `rtc_codec_negotiated/changed` (0.25).

### 8B.11 Abuse / rate-limit catalog (all 1.0)

`abuse_call_rate_limit_triggered` (Worker; rate_limit_bucket, retry_after_ms, calls_last_1m, calls_last_10m, calls_last_24h) · `abuse_invite_rate_limit_triggered` (invites_last_10m) · `abuse_receptionist_rate_limit_triggered` (sessions_last_24h) · `abuse_callback_rate_limit_triggered` (callback_attempts_last_10m) · `abuse_duplicate_call_detected` (duplicate_window_ms, duplicate_target_uid) · `abuse_ring_flood_detected` (ring_count, unique_targets) · `abuse_group_invite_storm_detected` (invite_count, unique_invitees) · `abuse_group_creation_rate_limit` (groups_created_last_24h) · `abuse_blocked_user_call_attempt` (blocked_by) · `abuse_invalid_invite_signature` (invite_id, failure_reason) · `abuse_replayed_invite_detected` (invite_generation, membership_version) · `abuse_invalid_mutation_id` (mutation_id) · `abuse_protocol_version_rejected` (protocol_version) · `abuse_turn_credential_failure` (auth_failure_reason).

### 8B.12 Geo / placement dataset (drives Jitsi placement)

**`server_geo_snapshot`** — Cloudflare Worker, once per call/session, 1.0. Fields from `request.cf`: `cf_colo, cf_country, cf_region, cf_region_code, cf_city, cf_timezone, cf_continent, cf_asn, cf_as_organization, cf_postal_code, cf_latitude, cf_longitude, cf_metro_code, cf_http_protocol, cf_tls_version, cf_tls_cipher, cf_bot_score, cf_host, cf_client_tcp_rtt_ms, cf_edge_request_keepalive, cf_cache_status, cf_ray_id, worker_region, authority_region, rtc_provider`.

**`client_sfu_latency_snapshot`** — Client, on SFU join + on leave, 1.0: `provider, provider_region, provider_pop, measured_rtt_ms, measured_jitter_ms, packet_loss_pct, relay_used, turn_region, network_type, carrier, wifi_ssid_hash(optional), estimated_bandwidth_kbps, reconnect_count, participant_count`.

**`geo_route_decision`** — records which provider/region was chosen and why. **The decisive placement metric is measured `rtt_ms` to the selected SFU, not country.**

### 8B.13 Person vs event properties

**Person profile** (slowly-changing, keyed by `account_id`): `os_version, device_model, locale, home_country` (majority activity), `preferred_network_type, default_rtc_provider, call_capability_audio/video/group, last_seen_colo, trust_score_bucket (low|medium|high), beta_program, employee, internal_tester, first_build_seen, latest_build_seen, install_date, last_active_at, total_calls, total_group_calls, total_receptionist_sessions`. **Everything transient goes on the event**, never the person.

### 8B.14 Sampling strategy (at 1M calls/day)

Keep at **1.0**: all control-plane/authority correctness events, `busy_*`, `call_*` lifecycle, `callroom_*`, `push_*` (needed for latency), `groupcall_*` (low relative volume), `rtc_quality_summary`, `rtc_error`, `abuse_*` (security), `geo_*` (capacity planning), `authority_epoch_conflict`, `authority_split_brain_detected`. **`authority_shadow_decision`: 1.0 until rollout complete, then 0.10.** High-volume/noisy downsample: `rtc_quality_tick` 1.0→0.25→0.10, `rtc_track_added/removed` 0.25, `rtc_codec_changed` 0.25, `rtc_bandwidth_estimate_changed` 0.10, `rtc_active_speaker_changed` 0.05. Always emit `sampled` + `sample_rate` so counts can be reweighted.

### 8B.15 Dashboards

- **Control Plane Health** — authority acquire success rate, shadow match %, busy false positive/negative, epoch conflict rate, split-brain count, authority RPC p99. (`authority_*`, `busy_*`)
- **Receptionist** — sessions started, avg session duration, callback preempt funnel, voicemail suppressed %, abandon latency p95, false deliveries. (`receptionist_*`)
- **Call Funnel** — dial→ring→connected→ended, connect success %, connect p95, missed calls, busy redirect rate. (`call_*`, `busy_redirect_receptionist`)
- **WebRTC Quality** — avg RTT, packet loss, jitter, MOS, relay ratio, reconnect rate. (`rtc_quality_tick/summary`)
- **Group/SFU** — escalate success, migrate rollback rate, sfu_audio_confirmed rate, membership CAS conflicts, mode-degrade funnel, full_rejected. (`groupcall_*`, `sfu_audio_confirmed`)
- **Push Performance** — sent/received/opened, processing latency, delivery timeout, callback push latency. (`push_*`)
- **Geo / Capacity** — calls by colo/ASN/region, RTT by SFU region, provider selection distribution, relay usage by country. (`server_geo_snapshot`, `client_sfu_latency_snapshot`, `geo_route_decision`)

### 8B.16 The 5 alerts as concrete queries

1. **Authority divergence** — `authority_shadow_divergence`, `divergence_rate > 0.10%` for 15 min → Critical.
2. **Callback preemption failure** — `receptionist_false_delivery`, `count() > 0` over 5 min → Critical (expected value: zero forever).
3. **Group migration rollback spike** — `groupcall_migrate_rollback_completed / groupcall_escalate_started > 0.05` over 15 min → investigate.
4. **Authority RPC latency** — `authority_rpc_completed` p99 `> 150 ms` (warn) / `> 100 ms` sustained → alert.
5. **Split-brain / epoch conflict spike** — `authority_split_brain_detected` `count() > 5 within 5 min` (and `authority_epoch != callroom_epoch` divergence > 0.05%) → Critical.

### 8B.17 Retention & cost controls

Retention: control-plane lifecycle 365d · abuse 730d · authority transitions 365d · shadow rollout events 180d after rollout · rtc_quality_summary 365d · **rtc_quality_tick 30d** · active-speaker/bandwidth-estimate 7d · track add/remove 14d · debug-only 7d · internal-employee telemetry 365d. Cost controls: compress high-cardinality strings into enums; hash correlation-only values (device, Wi-Fi SSID); **never send SDP blobs, ICE candidates, per-frame audio levels, IP addresses, or user-generated content**.

### 8B.18 Schema versioning

Consumers MUST ignore unknown properties; dashboards/alerts pin a minimum supported `schema_version`. Event lifecycle: `draft → experimental → stable → deprecated → removed`, tracked via `event_status, introduced_in_schema, deprecated_in_schema, removed_in_schema`. **Never reuse an event name with different semantics** — create a new name (e.g. `authority_shadow_decision_v2`); maintain compatibility across ≥2 client protocol versions during manual rollout; validate schema changes against a central event registry before release.

---

## 9. Recommended build order (bottom line)

**Fix the highest risk first: the control-plane migration.** Ship the authority in **shadow mode (Phase A–C)** and prove divergence ≈ 0 in PostHog *before* changing a single user-visible behavior. Then, in order: **D → E (protocol v2 obeys authority) → F (receptionist preempt/abandon) → G (SFU distributed-commit migration) → H (delete legacy).** Everything is per-account flagged, kill-switchable, and requires no forced app update.

---

*Provenance: consolidated from 5 principal-engineer review sessions (4 architecture + 1 full PostHog telemetry contract, §8B) over `CALL-RECEPT-PREEMPT-PLAN.md` and `GROUP-CALL-SFU-ESCALATION-DRAFT.md`, reconciled against the AvaVerse canonical rulebook. Graphiti was unreachable during authoring (timeouts) — constraints were sourced from `CLAUDE.md` + project memory; re-sync this doc into Graphiti (`group_id=proj_avaflutterapp`) once it is back up.*
