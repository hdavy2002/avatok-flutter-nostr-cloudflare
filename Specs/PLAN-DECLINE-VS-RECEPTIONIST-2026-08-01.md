# Two decline buttons, and "Receptionist" reading as "Declined"

**Date:** 2026-08-01
**Reviewed with:** GPT-5.6 Sol (Medium)
**Status:** PLAN. Nothing here is implemented yet.
**Release impact:** BOTH ARE RELEASE BLOCKERS for build 30690875915 unless that
build is strictly internal and cannot reach production users.

---

## The owner's two reports

1. "If I decline from the TOP button the top message is still there, the caller
   still gets a ringtone, and after a few seconds the call closes. If I decline
   from the BOTTOM it disconnects on both ends quickly."
2. "If the callee hits Receptionist, it shows the caller **Declined**. Declined
   should only show if the callee actively declined. If they clicked
   Receptionist, Ava should take over immediately."

## The verdict on my own diagnosis

> Both diagnoses are largely correct, but **both proposed fixes stop one layer
> too early.**
>
> - Bug 1 is not only duplicated cleanup. It is **duplicated interaction
>   ownership**.
> - Bug 2 is not only bad copy or a bad enum name. It is a **corrupted domain
>   model where "reject" and "handoff" share command ancestry**.

---

# BUG 1 — two Decline buttons behave differently

## Where my diagnosis was incomplete

Failure to cancel notification `8005` explains the stale surface, the
contradictory UI and repeated tappable controls. It does **NOT**, by itself,
explain why the CALLER keeps ringing. That needs one or more of:

1. The native path does not actually invoke the decline in every lifecycle state.
2. It does, but **the async work is lost when the plugin callback completes or
   the isolate/app is suspended** — the likeliest cause: our native handler fires
   `unawaited(_declineRouting(extra))` from inside a plugin callback.
3. It invokes the slow HTTP-only path while the branded screen has a warmer
   execution context.
4. The decline reaches the server but the caller ignores or delays it.
5. **The caller still owns the autonomous ring-timeout-to-Ava transition.**

> Do not close Bug 1 after visually confirming both surfaces disappear. Prove
> the chain: `native tap → control command created → authority received →
> decline committed → caller applied transition`. Otherwise you fix the stale
> notification and leave the signalling race.

## Is one shared reducer enough? **Necessary, not sufficient.**

`applyRingTransition()` should stay the sole teardown reducer, but it needs a
single **event-ingress coordinator above it**:

```
Native CallKit event ─┐
Flutter screen event ─┼─> handleIncomingCallAction()
Notification action  ─┘        │
                               ├─ validate call identity
                               ├─ create one command_id
                               ├─ commit local action once
                               ├─ dispatch WS + HTTP command
                               └─ applyRingTransition()
```

NOT: *each surface → signalling → some cleanup → maybe reducer.*

**The deeper invariant:**

> A user action belongs to the CALL, not to the UI surface that emitted it.

Every surface produces the same domain command — `IncomingCallAction.decline` /
`.answer` / `.receptionist` / `.block` — with the surface recorded **only as
telemetry** (`interaction_source: native_callkit | branded_flutter |
local_notification | lock_screen`). **The source must never select different
behaviour.**

## Should a native decline behave differently? **No, not semantically.**

It may differ *operationally* — cold Flutter engine, backgrounded app, only a
background isolate running, foreground-service restrictions, different network
state. Those belong to **transport and lifecycle handling, not call semantics**.

Both must produce: same command, `expected_state = ringing`, same capability,
same authority epoch, same idempotency rules, same final disposition, same
teardown reducer. Only telemetry differs.

## Should we show two competing surfaces at all? **Long term, no.**

Two simultaneously-actionable incoming-call surfaces on Android is a design
defect. Failure classes: duplicate buttons invoking separate code paths; one
surface disappearing while the other remains; stale actions after the call
already transitioned; user taps Answer on one while the other processes Decline;
different copy and available actions; accessibility focus conflicts; lock-screen
vs foreground behaviour diverging; plugin notification lifecycle differing from
app lifecycle.

**Our branded screen offers actions the native plugin surface cannot represent,
so the two can never be made equivalent.**

Recommended product model — ONE primary actionable surface per context:

- **Locked / backgrounded:** native CallKit-style surface is primary, with only
  Answer and Decline.
- **App foregrounded / unlocked:** branded Flutter screen is primary.
- **After opening the branded screen:** dismiss or suppress the native
  actionable surface as soon as platform rules allow.
- Advanced actions (Receptionist, Message, Block, Report Spam) belong **only**
  in the branded surface.

> Do not deliberately present two independent surfaces and call one
> "underneath". That is structurally fragile.

The native notification may still be needed to gain lock-screen/background
execution while launching the full-screen intent — but use it as a
**bootstrap/control fallback, not a co-equal UI**.

## Deterministic notification dismissal

Two surfaces, two cancellation mechanisms.

**Our own notification:** make the id call-derived and exact —
`notification_id = stableHash("incoming_call:$callId")`. Do **not** reuse the
literal `8005` globally; with concurrent, delayed or stale calls a fixed global
id lets one call cancel another's notification. Persist alongside the active
call: `active_call_id`, `full_screen_notification_id`, `native_callkit_uuid`,
`authority_epoch`.

**The plugin's notification:** do not try to guess its Android notification id.
Control it through the plugin's call identity — `FlutterCallkitIncoming.endCall(callUuid)`.
The deterministic key is the **plugin call UUID**, not the underlying
notification id. Enforce `one server call_id ⇔ one stable native CallKit UUID`,
stored durably enough to survive app backgrounding, engine restart, callback
isolate execution and process recreation. *If a new plugin UUID is generated in
different code paths, deterministic cleanup is impossible.*

**Adversarial case:** the plugin's "end all calls" method is NOT an acceptable
substitute — it can terminate an unrelated active call or another pending call.
Use exact call-UUID termination.

## The fix — P0

Create one coordinator `handleIncomingCallAction(callId, action, source,
nativeCallUuid, authorityEpoch)`, ordered:

1. Atomically claim the local action using `call_id + authority_epoch`
2. Generate or reuse one `command_id`
3. Immediately dispatch the InboxDO WS fast path
4. Immediately dispatch the HTTP backstop with the same command
5. Invoke `applyRingTransition()` locally
6. End the exact native CallKit UUID
7. Cancel the exact app notification id
8. Dismiss the branded route if mounted
9. **Await neither transport before local teardown**
10. Reconcile on the authoritative response

A second button tap or duplicate plugin callback must return the
already-existing action result.

**Reducer behaviour:** the reducer must NOT signal the server. It only projects
a known local or authoritative transition into surfaces. Otherwise:
`native decline → coordinator → reducer → plugin end event → coordinator again →
another server command`. Keep **command handling**, **surface reduction** and
**plugin lifecycle callbacks** separate. A plugin `ended` callback caused by our
own cleanup is **observational, not a second decline command**.

---

# BUG 2 — Receptionist appears as Declined

## Where my diagnosis was incomplete

The flaw is deeper than "a declined string leaked into the UI". The current
model treats receptionist as **`decline` with `route = Ava`**. That is wrong
under the frozen product behaviour. The owner defined two DISTINCT actions:

```
Decline:                    Receptionist:
  caller leg ends             callee ring leg ends
  call completes              caller leg CONTINUES
  no Ava                      AI handoff begins
  no charge
```

They differ in: command, authorization, transition, caller-leg lifecycle,
billing lifecycle, final disposition, telemetry, failure handling, UI copy and
retry policy. **They must not share a semantic parent named `decline`.**

## Is a distinct disposition enough? **No — separate COMMANDS.**

A distinct final disposition bolted on at the end still leaves dangerous shared
code earlier in the path.

```
USE:  call.decline
      call.route_to_receptionist

NOT:  call.decline routed_to=decline_ava
```

```
ringing --decline--> completed_declined
ringing --route_to_receptionist--> receptionist_starting
                                     --> receptionist_active
                                     --> receptionist_failed
```

The receptionist command must PRESERVE the caller leg. The decline command must
TERMINATE it. **No shared wire ancestry beyond both being valid commands from
`ringing`.** They may share generic infrastructure — capability validation,
command envelope, epoch CAS, idempotency, audit logging, transition broadcast —
but **must not share business semantics**.

## Legacy compatibility — with a warning

Do not have the new server keep emitting `decline_ava` as canonical. Use a
structured canonical event and an explicit compatibility adapter at the protocol
boundary:

```json
{ "type": "call.transition", "schema_version": 2, "transition_seq": 14,
  "from": "ringing", "to": "receptionist_starting",
  "command": "route_to_receptionist", "disposition": "receptionist",
  "activation_mode": "callee_selected" }
```

> **Be adversarial here: if an old client only understands receptionist as a
> decline subtype and therefore shows "Declined", then it may be UNSAFE to
> enable this feature for that client version. Compatibility is not successful
> merely because the old client does not crash.**

Gate on `supports_receptionist_transition_v2=true`. For clients without support,
either hide/disable the Receptionist button, or use a legacy path **verified not
to lie to the caller**. Do not knowingly send misleading semantics for backward
compatibility.

## What the caller should see and hear

The caller experience begins when the authoritative transition commits — **not**
when Gemini becomes ready.

**Immediately after commit:** show *"Connecting you to Ava…"*; stop outbound
ringback immediately; play a **bundled local** handoff prompt ("Please hold while
Ava answers"). This audio must be local or preloaded, never generated live.

**When receptionist becomes active:** show *"Ava is taking your message"*;
transition from the local holding prompt to Ava's live greeting; avoid replaying
contradictory introductions.

**If startup takes longer:** honest progress copy — *"Ava is still connecting…"*.
**Do not resume ringing.** The callee has already chosen the handoff and their
ring leg is over.

## Should the caller ever see "Declined" if the receptionist fails? **No. Never.**

The caller was not declined. A service failed after a handoff was requested.
Using "Declined" would **falsely attribute an action to the callee**.

Use failure-specific outcomes: *"Ava couldn't connect."* Then a defined product
fallback: allow retry, allow leaving a recorded voicemail without live AI, or end
with *"Ava is unavailable right now"*, optionally offering Message or Notify Me.

Terminal disposition should be `receptionist_failed` or
`completed_receptionist_unavailable` — **not `declined`**. The failure transition
must not travel through `declined`.

```
DO NOT:  handoffToAva("decline") ... catch: endWith("declined")

DO:      startReceptionist(activationMode: calleeSelected, commandId: …)
         catch: commitReceptionistFailed(failureReason: …)
```

**Billing rule:** if Ava never becomes active, do not charge as a successful
receptionist interaction. Freeze the billable boundary explicitly — e.g. *billing
starts only after `receptionist_active` AND `first_ai_audio` emitted*.

---

# REVISED ROLLOUT ORDER

1. **Freeze the domain model and transition table.** Define `decline != receptionist`.
   Separate commands, states, dispositions, activation modes, caller copy and
   failure outcomes. *This moves to the very top, because the current vocabulary
   can still convert a successful fast handoff into a misleading outcome.*
2. **Remove autonomous caller timeout authority.** The caller must not start Ava
   solely because its local ring timer expired. (Still P0.)
3. **Add the unified incoming-action coordinator.** Route native CallKit, branded
   Flutter, local notification, timeout callback and plugin-ended callback
   through one domain ingress. *Do not merely route all callbacks directly into
   the teardown reducer.*
4. **Make all ring-surface teardown deterministic** — exact notification id,
   exact plugin UUID, branded-route dismissal.
5. Then the earlier plan: InboxDO capability + fast path, dual-submit WS+HTTP,
   transition envelopes + applied ACK, resend/FCM reconciliation, split
   receptionist telemetry, bundled local handoff audio, internal rollout, then
   roll out by client version watching applied-ACK rates.

---

# RELEASE DECISION

> Both are release blockers for the queued Android build **unless that build is
> strictly internal and cannot reach production users**.

Build 30690875915 targets the Play **internal testing** track, which reaches
named testers only — not the public. It is therefore shippable as a *test* build,
but the owner will experience both bugs on it. Neither should reach a public
track.
