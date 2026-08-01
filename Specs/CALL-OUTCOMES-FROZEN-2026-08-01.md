# AvaTOK call outcomes — FROZEN ARCHITECTURE (2026-08-01)

**Status: FROZEN.** Owner ruled on the open questions on 2026-08-01. Architecture
reviewed twice with ChatGPT (browser) and once with Codex. Where any other spec,
comment or existing code conflicts with this document, **this document wins**.

If you are an agent picking this up in a later session: read this file BEFORE
touching anything on the call path. The bug class this freezes out has recurred
at least three times (2026-07-20, 2026-07-14, 2026-08-01).

---

## THE ONE RULE

> **Only the server-side call authority decides what the call now is.**
> Flutter, FCM, CallKit, notifications, the receptionist service and the
> messenger worker only *render* or *execute* an authoritative transition.

Every recurrence of this bug had the same shape: several components each
independently deciding what a call outcome meant. On 2026-08-01 terminal state
was being interpreted separately by FCM, the CallRoom DO, a Flutter event bus,
the branded incoming screen, CallKit, the receptionist handoff and push
generation — seven interpreters, no authority.

---

## OWNER RULINGS (2026-08-01) — these are product decisions, do not "improve" them

### RULING A — Decline and Receptionist are DISTINCT actions

| Action | Callee ring leg | Caller leg | Disposition |
|---|---|---|---|
| **Decline** | ends | **ends IMMEDIATELY** | `declined` |
| **Receptionist** | ends | stays alive, handed to Ava | `answered_by_receptionist` |

**Decline never starts Ava.** The previous implicit behaviour — a plain decline
auto-handing to Ava whenever the callee's receptionist lane happened to be on —
is **DELETED**, not bypassed. It is the single highest-risk trap in this work
because the logic is scattered.

Search for and remove every path equivalent to:

```
if declined && receptionist_enabled: start_receptionist
```

Known locations to check: Flutter button handlers, Worker endpoints, CallRoom
DO, CallStateAuthority DO, the FCM consumer, the receptionist start endpoint,
ring-timeout logic, retry handlers.

**Invariant to enforce in code:** `declined` may NEVER transition to
`receptionist_active`.

### RULING B — Uniform fast-fail for ALL pre-ring rejections

Blocked, callee offline, privacy mode, rate limited and no-callable-device all
terminate **quickly and identically**.

```
caller-visible outcome_code = recipient_unavailable
caller-visible copy        = "Unavailable — This person can't take calls right now."
```

Internally preserve, and NEVER serialise to the caller (not to Flutter, not to
FCM, not to caller-visible analytics, not to API error bodies, not to crash
breadcrumbs):

```
admission_decision  = denied
internal_reason     = blocked | offline | privacy_mode | rate_limited | no_callable_device
caller_visible_outcome = recipient_unavailable
```

Owner accepts the residual statistical inference (a determined caller can still
infer blocking probabilistically over many attempts). Do not re-litigate this.

Banned caller-facing copy — each leaks state: "The person is offline",
"Call rejected", "Call declined", "Could not find the person", "User unavailable".

### RULING B COROLLARY — `declined` is NOT `recipient_unavailable`

Ruling B applies **only to pre-ring admission failures**. A callee pressing
Decline is an explicit human action *after* the call was admitted and rang, so
the privacy leak has already happened. Show a distinct card.

```
recipient_unavailable = call never entered ringing
declined              = admitted call was explicitly declined
caller_cancelled      = caller ended it
ring_timeout          = admitted call was not answered
```

Caller UI on decline: **"Call declined / The person declined your call."**
(Neutral second line — avoids repeating a possibly stale or locally-overridden name.)

### RULING C — Phased delivery

- **Phase 1** — identity (profile name + photo), new incoming screen,
  Accept / Decline / Message / Receptionist, stale-ring-notification fix.
- **Phase 2** — Block + Report Spam, behind the admission authority.
- **Phase 3** — Voicemail.

---

## IDENTITY — two layers, never one

### Layer A: authoritative public identity snapshot

Created **once at call admission**, immutable for the life of the call. If the
caller renames their profile mid-ring, that call keeps the old name; the next
call uses the new one.

```
caller_identity_snapshot
  uid
  display_name
  avatar_url
  avatar_version
  phone_number_masked_or_normalized
  profile_version
  resolved_at
```

**FREEZE: the AvaTOK product profile is the ONLY server identity source.**
Clerk / Google / Gmail / Apple identity must be **removed** from every call
runtime resolution path — not merely lowered in precedence. The IdP name may
seed an AvaTOK profile name at onboarding; after that it is not a runtime
identity source.

Only **publishable / moderated** profile data may enter the snapshot, or a
banned avatar or abusive display name will keep propagating through calls.

### Layer B: recipient-local presentation override

The callee's own contact label ("Arti Office", "Plumber", "Do Not Answer") is
**private device-local presentation metadata**. It is NOT part of the shared
snapshot.

```
Incoming-call UI precedence:
  callee local contact override
  → authoritative AvaTOK identity snapshot
  → formatted phone number
  → generic "AvaTOK caller"

Receptionist greeting precedence:
  authoritative AvaTOK profile name
  → neutral greeting
```

The receptionist must NEVER say "Hi Plumber" — that is the callee's private label.

**Never write a local override back into**: the call record, the receptionist
greeting, FCM to other devices, or analytics as the caller's profile name.
Track `public_display_name`, `rendered_display_name` and `name_resolution_tier`
separately.

### Where the snapshot lives — all three, different purposes

1. **Call authority / CallRoom state** — source of truth during the call.
2. **Durable call record (D1)** — missed-call reconstruction, audit, delayed
   notification generation, call history that a later profile edit cannot rewrite.
3. **Push payload** — a **transport copy, not an authority**. Carries only what
   cold-start display needs: `call_id`, `caller_uid`, `display_name`,
   `avatar_url`, `avatar_version`, `identity_snapshot_version`.

If push and DO disagree, **the DO wins** — and log the mismatch, it means the
pipeline is broken.

---

## AVATAR ON A COLD, LOCKED PHONE

Ship URL + version, never bytes. Cache key must be **stable and versioned**,
because signed URLs / CDN query strings / transform params change while the
underlying image does not:

```
avatar_cache_key = avatar:{caller_uid}:{avatar_version}
```

**Render order — never block the incoming-call UI on an image fetch:**

1. cached avatar matching `uid + avatar_version`
2. older cached avatar for that uid (internally marked stale)
3. deterministic initials avatar from the authoritative display name
4. generic AvaTOK silhouette

…then fetch the CDN image in parallel and swap it in when it lands.

**Pre-warm** recent conversation participants, recent callers, favourites,
AvaTOK contacts, and people visible in the current inbox/contact list. Use an
LRU disk cache with a size cap and versioned entries. Do **NOT** aggressively
pre-warm an entire uploaded address book — wasteful, privacy-sensitive,
battery-heavy, and a storage-management problem.

Avatar URLs must be CDN delivery with public-profile access rules. Never put raw
private bucket paths or long-lived privileged signed URLs into a push payload.

**Realistic SLA.** On a locked, cold Android phone you cannot guarantee the real
photo renders before the first frame — OS background restrictions, OEM
behaviour and CDN latency all interfere. You CAN guarantee: no blank space, the
correct name, a deterministic fallback, and eventual photo replacement.

---

## THE CALL AGGREGATE

Do **not** ship another single `status` field and promise to split it later.
Phase 1 already contains Receptionist, which proves callee-leg termination and
caller-leg termination differ.

```
CallSession
  call_id
  epoch
  transition_sequence

  session_state
  caller_leg_state
  callee_leg_state
  service_leg_state

  disposition

  caller_identity_snapshot
  receptionist_policy_snapshot

  created_at
  updated_at
```

### Phase 1 enums

```
session_state:    creating | ringing | connected | handoff | completed

caller_leg_state: pending | ringing | connected_to_callee
                | connected_to_receptionist | ended

callee_leg_state: not_started | ringing | accepted | declined
                | dismissed_for_message | dismissed_for_receptionist | ended

service_leg_state: none | starting_receptionist | receptionist_active
                 | completed | failed

disposition: none | answered_by_callee | declined | quick_reply_sent
           | answered_by_receptionist | caller_cancelled | ring_timeout
           | receptionist_failed
```

### Phase 2 adds (pure additions, no refactor)

```
callee_leg_state: + dismissed_for_spam, dismissed_for_block
disposition:      + reported_spam, blocked_by_callee, recipient_unavailable
```

### Phase 3 adds (pure additions, no refactor)

```
caller_leg_state:  + voicemail_ready, voicemail_recording
callee_leg_state:  + dismissed_for_voicemail
service_leg_state: + voicemail_ready, voicemail_recording
disposition:       + voicemail_left, voicemail_abandoned, voicemail_failed
```

### Transitions

```
Accept       callee: ringing→accepted                 caller: ringing→connected_to_callee        session: ringing→connected
Decline      callee: ringing→declined                 caller: ringing→ended                      session: ringing→completed
Message      callee: ringing→dismissed_for_message    caller: ringing→ended                      session: ringing→completed   +quick-reply side effect
Receptionist callee: ringing→dismissed_for_receptionist caller: ringing→connected_to_receptionist service: none→starting_receptionist  session: ringing→handoff
```

---

## COMMANDS (client → authority)

Phase 1 builds only:

```
accept_call | decline_call | send_quick_reply | handoff_to_receptionist
cancel_call | ring_timeout
```

Every command carries:

```
call_id | actor_uid | device_id | command_id | expected_epoch
```

`send_quick_reply` additionally carries `quick_reply_id` + `catalog_version`.
**The client never sends authoritative free text for a canned reply** — older
clients, localisation changes and modified clients would produce inconsistent
content. The server resolves the localised string from the catalog.

Commands are **authenticated, epoch-checked and idempotent by `command_id`**.

### Authorization the server MUST enforce

- only a called callee device may accept / decline / message / report / block
- only the caller may cancel or record voicemail
- stale devices cannot act
- replayed FCM actions cannot act
- quick-reply IDs must be in the allowed catalog
- a voicemail upload must belong to the correct call

---

## EVENTS (authority → consumers)

Keep the vocabulary **semantic and leg-oriented**. Do not create one event per
UI widget.

### State-transition events — these change the aggregate

```
call_admitted | callee_ringing_started | callee_accepted | callee_declined
callee_dismissed_for_message | callee_dismissed_for_receptionist
receptionist_started | receptionist_connected | receptionist_failed
caller_cancelled | ring_timed_out | call_completed
```

### Side-effect intents — these tell consumers what work to perform

```
ring_surface_cancel_requested | quick_reply_delivery_requested
receptionist_start_requested  | push_backstop_requested
```

**This separation matters.** `callee_dismissed_for_message` changes call state;
`quick_reply_delivery_requested` causes messenger delivery. If message delivery
fails, the call remains correctly ended and you retry the side effect *without*
replaying the state transition.

Every event carries:

```
event_id | call_id | epoch | transition_sequence | occurred_at
actor | previous_state | new_state | command_id
```

Events with side effects also carry an idempotency key.

### NOT authoritative events

`decline_button_tapped`, `incoming_screen_closed`, `notification_removed`,
`flutter_event_bus_fired` — these are **client telemetry**. They may exist in
PostHog. They must never drive state.

---

## THE CLIENT REDUCER — the piece that cannot be deferred

Exactly one function owns the transition from ringing to not-ringing:

```
apply_authoritative_call_transition(previous_state, event)
```

When it detects `callee_leg_state was ringing AND is now not ringing`, it runs
ONE idempotent cleanup path that owns:

```
stop ringtone | stop vibration | cancel notification | dismiss full-screen UI
update ConnectionService/CallKit | close incoming-call route
release incoming media resources
```

**No button handler may duplicate this cleanup.** Button handlers may only:

1. disable repeated input
2. send a command
3. optimistically anticipate the authoritative transition
4. let the reducer clean up

Audible ringing may stop immediately on local tap for responsiveness, but the
durable UI state must still reconcile to the server transition, and that local
stop must be idempotent and reversible where appropriate.

**Every one of these must produce the same cleanup**: accept, decline, message,
receptionist, caller_cancel, ring_timeout, answered_on_other_device.

### Notification IDs must be deterministic

```
notification_tag = incoming_call
notification_id  = stable hash of / mapping from call_id
```

Random notification IDs will recreate the stale-notification bug. Every terminal
callee-leg event must carry enough information to cancel the exact notification.

### Native and Flutter surfaces must not diverge

Android ConnectionService / full-screen intent / notification actions and
Flutter may each believe they own the call. They must all dispatch commands into
the **same authority** and consume the **same ordered transitions**. Native
Decline must not have its own code path.

---

## MULTI-DEVICE

First valid callee command wins via epoch/CAS. A stale command receives the
current authoritative state rather than inventing a new outcome.

Example: phone A accepts; tablet B tries to decline 80 ms later; the decline is
rejected as stale and tablet B renders "answered on another device".

---

## RECEPTIONIST HANDOFF — stop orchestrating on the client

**Wrong** (what exists today, ~7 s):

```
stop UI → send bye → stop media → await peer close → POST cancel
        → GET config → POST start → connect socket → open mic
```

**Right** — the callee action is ONE server command:

```
handoff_to_receptionist
```

The authority transitions immediately and tells the caller:

```
callee_leg_ended | receptionist_handoff_accepted | handoff_token
```

…**before** every cleanup action has finished. These then run concurrently:
close callee leg, cancel ring push, stop ring notification, release peer media,
start receptionist, prefetch config, validate entitlement, init service connection.

**Do NOT require `peerConnection.close()` to finish before the server starts
receptionist admission.** Media cleanup must never delay the user-visible
transition.

Do not retain client `POST cancel` / `GET config` / `POST start`. The client must
not orchestrate the server workflow, and must not fetch configuration and then
tell the server which configuration to use — that is drift plus a tampering surface.

### Other latency causes to fix

- **Runtime DDL on the hot path is a production defect.** ~14 sequential
  `ALTER TABLE` statements run on a cold isolate inside receptionist start.
  Schema migration is a deployment responsibility. At runtime: verify a schema
  version cheaply, degrade or reject if incompatible, never execute DDL on a
  user-facing path. **Remove all DDL before Phase 1 rollout** or you will "fix"
  the UI and still see random multi-second handoffs.
- **Wallet/entitlement checks are too late.** Resolve or reserve eligibility at
  call creation or during ringing, or via a short-lived cached entitlement
  snapshot; then merely confirm/consume on handoff. Do not charge until the
  service actually starts, but precompute admission readiness.
- **Receptionist start must be idempotent.** Key on
  `receptionist_session_key = call_id + epoch`; a retry must return the existing
  session, not start a second one.

---

## BLOCK (Phase 2)

The check belongs in the **callee-scoped admission authority**
(`CallStateAuthorityDO`), evaluated BEFORE CallRoom creation, device lookup, FCM
fan-out, callee socket discovery or ring state creation.

```
Worker authenticates and routes
  → CallStateAuthorityDO admits or suppresses
    → CallRoom exists only after admission
Push fan-out NEVER decides permission.
```

Admission verdicts: `allowed | busy | silently_suppressed | rate_limited |
no_callable_device | receptionist_only`.

**Storage:** D1 is the durable canonical blocklist; the callee authority DO holds
the hot read path; use monotonic blocklist versioning with explicit invalidation
on block/unblock. **Do not use KV as the sole source of truth** — eventual
consistency is unacceptable for an unblock decision.

**Failure policy must be explicit.** If block policy cannot be loaded: use a
sufficiently recent cached policy, else return a conservative
temporary-unavailable, and emit `admission_policy_load_failed`. Never silently
treat the caller as allowed indefinitely.

**Block must be atomic enough for future calls.** On tap: (1) current call
transition succeeds, (2) blocklist mutation durably commits, (3) authority
cache/version updates, (4) future admission uses the new version. If termination
succeeds but persistence fails, surface internally and retry — do not tell the
user "blocked" unless the durable write succeeded or is queued with guaranteed
retry.

Blocking the CURRENT call may end it immediately: the caller already knows they
reached the callee. Silent semantics apply only to FUTURE calls.

---

## REPORT SPAM (Phase 2)

Report and Block are **different actions**. Do not silently make Report Spam
equal Block. A user may report a suspicious caller but still want future calls
screened rather than dropped.

A row saying "A reported B" is not enough. Capture:

```
reporter_uid | reported_uid | call_id | report_category
call_started_at | report_created_at | identity_snapshot_version
prior_relationship | whether_contacts_match | client_device_id
authority_transition_sequence
```

Do not store live audio or content merely because a report occurred.

Recommend Report Spam ends the call (`callee: ringing→dismissed_for_spam`,
`caller: ringing→ended`, disposition `reported_spam`).

---

## VOICEMAIL (Phase 3)

Preserve the **logical call session and signalling socket** — NOT the WebRTC
media transport. A peer connection whose peer is gone buys you nothing.

```
Phase 1: ring        caller ↔ signalling authority, caller ringback, callee ringing
Phase 2: transition  callee leg ends → ring media closes
                     → caller signalling socket STAYS attached
                     → session enters voicemail_ready
                     → caller UI switches to recorder
```

The caller records **locally on-device**, then uploads via a normal HTTPS
operation. Do not multiplex audio through the call WebSocket.

Upload uses a scoped capability tied to call id, caller uid, callee uid,
voicemail asset id, expiry and max size/duration. Finalisation verifies asset
ownership, duration, MIME/container, size, call state, and a one-time finalize token.

**The result is a NORMAL messenger message**, not a voicemail silo:

```
message_type = audio ; subtype = call_voicemail
conversation_id | sender_uid | recipient_uid | call_id | asset_id
duration_ms | waveform_or_preview | created_at
```

That gives unread counts, delivery, thread ordering, retention, deletion,
notifications, moderation hooks and attachment auth for free.

Finalisation must be idempotent — `unique(call_id, voicemail_asset_id,
message_subtype)` or a dedicated idempotency key. A retry must not create three
voicemails.

Outcomes to define: `voicemail_offered`, `voicemail_recording_started`,
`voicemail_upload_started`, `voicemail_uploaded`, `voicemail_message_created`,
`voicemail_abandoned`, `voicemail_failed`. If the caller closes the app before
recording, the call completes as `voicemail_abandoned` — never leave the session
parked in `handoff`.

---

## QUICK REPLIES

Versioned catalog, server-resolved text, client sends only an ID.

**The owner's original 7-item list is a product risk** — "Wife is around",
"Husband is here", "In hospital", "Potty time" create accidental sensitive
disclosure, lock-screen embarrassment, localisation problems, screenshots that
make the product look unserious, and abuse potential in professional contexts.

v1 catalog (`catalog_version = 1`):

```
will_call_back  "Will call back"
busy_now        "Busy right now"
in_meeting      "In a meeting"
travelling      "Travelling"
cant_talk       "Can't talk"
```

The playful replies can ship later as an optional user-configurable pack.

**Delivery is decoupled from termination.** The call must end even if messenger
delivery is temporarily unavailable: commit state first, enqueue idempotent
delivery second. The caller UI shows the reply only after authoritative delivery
or a server-confirmed queued status.

---

## OBSERVABILITY

`sockets_sent=1` proves a frame was handed to one socket. It does **not** prove
Flutter received, processed or rendered it. Measure the legs separately:

```
server_transition_committed | socket_frame_written | client_transition_received
client_reducer_applied | ring_notification_cancelled | incoming_surface_dismissed
push_enqueued | push_sent | push_received | ui_rendered
```

Add a **client acknowledgement for critical transitions**. Without it, the next
stale-UI bug will again look like a server delivery problem.

Every state broadcast and push carries `call_epoch`, `transition_sequence`,
`state_version`; clients ignore older transitions. This protects against late
FCM, socket reconnect replay, duplicate queue processing, multi-device races and
reordered notification intents.

---

## PHASE 1 TRAPS, IN PRIORITY ORDER

1. **Keeping the old implicit Decline→Receptionist branch.** Highest risk.
   Delete it everywhere; do not merely bypass it in the new screen. Add the
   invariant `declined may never transition to receptionist_active`.
2. **Treating the push payload as identity authority.** The push is a copy — it
   may be stale, delayed, duplicated or absent. Render from it immediately, then
   reconcile against authoritative call state via `call_id` +
   `identity_snapshot_version`. Never re-resolve from Clerk during reconciliation.
3. **Mixing local contact names into the public snapshot.** Display the override;
   never write it back into the call record, the receptionist greeting, FCM to
   other devices, or analytics as the caller's profile name.
4. **Races between Accept / Decline / Message / Receptionist.** Multiple taps,
   multiple devices, delayed native actions and FCM action buttons all race. Use
   `expected_epoch` + `command_id`; first valid transition wins; a stale command
   receives current state.
5. **Optimistic cleanup becoming authoritative state.** Stopping ringing locally
   is fine. Declaring the call *completed* locally is not. The client must not
   create final dispositions before authority confirmation.
6. **Notification IDs that cannot be cancelled deterministically.**
7. **Native and Flutter call surfaces diverging.**
8. **Waiting for media cleanup before the state transition.**
9. **Quick-reply delivery coupled transactionally to call termination.**
10. **Receptionist side effects starting twice.**
11. **Runtime migrations remaining on the hot path.**
12. **Missing client acknowledgement.**

---

## FINAL PHASE 1 FREEZE

**Build now:**

```
multi-leg CallSession aggregate
epoch + monotonic transition sequence
single command endpoint / authority interface
single authoritative client reducer
immutable caller identity snapshot
versioned avatar cache + deterministic fallback
Accept | Decline | Message | Receptionist
central ring-surface cancellation
idempotent receptionist start
idempotent quick-reply delivery
ordered socket path with FCM backstop
```

**Do NOT build now** (but reserve the enum and aggregate structure so these
become pure additions):

```
block admission | spam reporting | voicemail recording
voicemail service states | silent-block policy
report evidence schema | voicemail upload pipeline
```

**Screen for v1** — display profile name, avatar or deterministic fallback, and
the "Call cost: Free" chip; ship only Accept / Decline / Message / Receptionist.
Do not visually reserve empty controls for Phase 2/3 unless the owner explicitly
wants disabled placeholders.

ChatGPT's closing note, which is the reason this document exists:

> **Phase 1 is not merely a new screen. It is the migration from independent
> call handlers to one authoritative transition pipeline.** Shipping the screen
> without that migration would preserve the exact bug class you are trying to
> freeze out.

---

## THE 15 FREEZE DECISIONS

1. `CallStateAuthorityDO` is the admission and transition authority.
2. `CallRoom` transports live session state; it does not invent outcomes.
3. D1 stores durable call history, identity snapshots, reports and blocks.
4. FCM is transport/backstop only, never a state authority.
5. Flutter renders ordered transitions through ONE reducer.
6. The public AvaTOK profile is the only server identity source.
7. Local contacts are a private presentation overlay, not part of the shared snapshot.
8. Blocked future calls are suppressed before CallRoom creation or device discovery.
9. Uniform fast-fail `recipient_unavailable` for all pre-ring denials (owner ruling B).
10. Callee-leg termination and caller-session termination are modelled independently.
11. Receptionist and voicemail are handoffs, not terminal call outcomes.
12. All commands are authenticated, epoch-checked and idempotent.
13. All state messages carry a monotonic transition sequence.
14. No runtime DDL on any call path.
15. Notification and call-surface cleanup are projections of authoritative
    transitions, not per-button code.
