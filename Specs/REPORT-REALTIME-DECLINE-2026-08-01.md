# Why decline is not instant yet — and how to make it live

**Date:** 2026-08-01
**Trigger:** owner report — hdavy2002 called hdavy2026; hdavy2026 declined;
hdavy2002 kept hearing ringing and then Ava took over.
**Evidence:** prod call `avatok-b7741a74`, PostHog.

---

## What actually happened (measured, not inferred)

```
09:09:21.759  callee taps Decline                  business_call_incoming_decline
09:09:21.807  callee's screen closes               business_call_screen_dismissed
09:09:21.819  callee records the outcome           call_incoming_declined routed_to=decline   ✅
09:09:21.842  callee's own ring surface torn down  call_ring_transition_applied seq=-1
09:09:23.423  server relays it, socket delivered   call_status_relayed sockets_sent=1
09:09:27.028  CALLER starts the receptionist       call_cancel_sent
09:09:33.435  Ava connects                         ava_recept_call_started
                                                    activation_mode="rings" ws_connect_ms=6415
09:09:35.5    Gemini socket lost, session dies
09:09:35.575  caller gives up and hangs up         call_end_pressed
```

Three separate defects, stacked. Fixing any one alone would not have fixed the
experience.

---

## DEFECT 1 — the caller never understood the decline (FIXED, deployed)

`activation_mode: "rings"` is the whole story. Ava was started by the **caller's
own ring timeout**, not by the decline. The caller never processed the decline
at all.

The DO broadcast set `type` from the state machine's internal disposition, so
the frame said **`declined`**. Every shipped client switches on **`decline`**.
Old callers hit `default`, ignored the frame, and rang on until their ring timer
expired.

`sockets_sent=1` said *delivered*. It was delivered and completely
misunderstood. Delivery is not comprehension, and our telemetry could not tell
the difference.

**Fixed** in `[CALL-WIRE-COMPAT-1]` (prod worker `123e19f3`): `legacyWireStatus()`
maps the aggregate back to the vocabulary shipped clients actually speak, plus a
test asserting *every* reachable outcome maps to a known word.

This alone should stop "decline sends the caller to Ava".

---

## DEFECT 2 — the decline takes ~1.7s to leave the callee's phone

`21.759` (tap) → `23.423` (server relayed, socket delivered) = **1.66s**, and
essentially all of it is on the callee's device before the server ever hears
about it.

The path today:

```
tap → PushService._signalStatus → ApiAuth.postJson(/api/call-status)
      → sign the request (NIP-98-style, needs the auth token)
      → fresh TLS connection
      → Worker → CallRoom DO → socket broadcast
```

Every element of that is per-request work. The largest costs are request signing
and a **cold TLS handshake**, because this is a one-off POST from a phone that
may have been woken by a push seconds earlier and holds no warm connection to
this host.

Note the history: there *used* to be a "fast path" — a throwaway WebSocket — and
I deleted it in `[CALL-TERMINAL-BCAST-1]`, correctly, because it was worse than
useless: lazy connect, errors swallowed, no ack, no telemetry, routinely failing
inside its own 800ms budget. **Deleting it was right. Not replacing it left a
gap.**

---

## DEFECT 3 — the receptionist takes ~6.4s to speak (partially addressed)

`ws_connect_ms=6415`, measured from the first line of `ReceptionistCall.start()`,
so it covers config fetch + `/start` + WS connect + mic open.

Today's `[RECEPT-NO-RUNTIME-DDL-1]` removed 25 sequential `ALTER TABLE`
statements, three dead round-trips and serialised three independent prefetches
from that path. This call was placed **before** that shipped, so 6.4s is the
*old* number. It should be materially lower now — but it is unverified, and
"lower" is not "instant".

The Gemini session then died (`ava_recept_socket_lost`, `gemini_closed`), which
is a separate open issue.

---

## The realtime question

> "Why can't we have a live disconnect?"

We can. The callee's phone **already holds a persistent, authenticated WebSocket
to the server** — the InboxDO socket used for messaging and presence. It is warm,
it is already authenticated, and it is already how the *ring* reaches an online
callee fast (`[WS-RING-1]`, which exists precisely because FCM took 8–15s).

Sending the decline **up** that existing socket removes, in one step:

- the TLS handshake (connection is already open)
- per-request auth signing (the socket authenticated once, at connect)
- the HTTP round-trip

Realistic target: **sub-100ms** callee-tap → caller-informed, versus ~1.7s today.

### Candidate designs

**A. Decline over the existing InboxDO socket.** Callee sends a frame up its live
socket; the InboxDO forwards to the CallRoom DO, which broadcasts to the caller.
Keeps HTTP POST as the durable backstop, exactly as FCM backstops the socket
today. Symmetrical with `[WS-RING-1]`: fast path for online, durable path for
everyone.

**B. Pre-warm the connection at ring time.** When the incoming-call screen
appears, open/warm the connection so the decline POST is not paying for a cold
handshake. Cheaper to build than A; helps only if the socket is genuinely warm
when the tap lands.

**C. Have the callee join the CallRoom DO at ring time.** The caller is already
attached. If the callee attached too, a decline is one socket frame with no
intermediate hop. But it changes the 2-peer cap semantics and the reconnect-grace
model, which are load-bearing and have their own incident history.

**D. Optimistic caller-side timeout tightening.** Not a fix — it treats the
symptom and risks ending calls that were never declined. Listed to be rejected.

### Open questions for review

1. A vs C — is the extra InboxDO→CallRoom hop worth avoiding the 2-peer-cap
   blast radius?
2. If the socket send fails or the socket is stale, how long do we wait before
   falling back to HTTP? A fallback that fires too late is the 800ms
   throwaway-socket mistake again.
3. Ordering: a socket decline and an HTTP decline could both land. The `seq` +
   `commandId` work already makes that safe — but this needs stating explicitly
   rather than assumed.
4. Do we need a **client acknowledgement**? `sockets_sent=1` proved delivery of
   bytes and told us nothing about comprehension. That is precisely how Defect 1
   hid. An ack of "I applied transition seq N" would have surfaced it instantly.
5. The callee's own UI already closes optimistically at ~50ms. Should the CALLER
   also get an optimistic "call ending" state on first signal, reconciled by the
   authoritative transition?

---

## Recommendation going in

Ship the wire-compat fix (done), then do **A** with HTTP retained as the durable
backstop, and add a **client ack** for terminal transitions so "delivered but not
understood" can never again look like success.

Explicitly NOT proposing: another bespoke throwaway socket. That failure mode is
already documented in this repo, in this file's own history.

---
---

# FINAL PLAN — reviewed with GPT-5.6 Sol, 2026-08-01

**Verdict: use A. But my plan was incomplete in one critical way.**

## THE CORRECTION THAT MATTERS MOST

> **The caller must no longer be allowed to autonomously start Ava because its
> local ring timer expired.**

Everything I proposed only makes decline *usually* faster. It does not remove
the race that caused this incident. A delayed, dropped, stale or misunderstood
decline can still lose to the caller's own timer and incorrectly start Ava —
which is *exactly* what happened, and would happen again with a faster path.

**The caller may REQUEST or DISPLAY. It must not DECIDE.**

The authority owns the ring deadline (`ring_started_at_server`,
`ring_deadline_server`). Only the authority may commit `receptionist_active`
with `activation_mode=no_answer`, and only after checking
`state == ringing AND now >= ring_deadline`. That is what stops a caller timeout
from defeating a decline that has already committed.

```
decline            -> terminal call end
receptionist       -> immediate receptionist handoff
no_answer_deadline -> receptionist ONLY when the authoritative deadline expires
caller timer       -> UI countdown only, NEVER a state transition
```

## ANSWERS

**Q1 — A vs C: choose A.** Mobile-network work (NIP-98 signing, DNS/TLS, radio
wake-up, Worker routing, app lifecycle) dominates; an internal DO-to-DO hop is
immaterial by comparison. C would contaminate several load-bearing concepts:
what counts as a CallRoom peer, whether a ringing callee consumes the 2-peer
cap, reconnect-grace before answer, whether stale ringing sockets block the real
media participant, and whether room cleanup now depends on a callee that never
answered. Not small details — they alter the room's lifecycle and capacity
semantics.

**Important correction to A:** do NOT treat "this is an authenticated InboxDO
socket" as sufficient authority to decline a *specific* call. Every command must
carry a short-lived **call capability** minted when the RING is created:

```
call_control_capability: call_id, callee_user_id, authority_epoch,
                         allowed_actions[decline, receptionist, answer],
                         expires_at, nonce/token
```

InboxDO validates that the connected account matches the capability, then
forwards unchanged. Without this binding, a compromised or buggy authenticated
socket can attempt actions against arbitrary call IDs.

**Q2 — do NOT wait for socket-failure detection. RACE BOTH PATHS.** None of
these prove delivery: `sink.add()` returned, the frame entered the local buffer,
the socket reports "open", no exception fired, a 100ms timer did not fire. A
300–800ms "wait and see" reproduces the deleted throwaway socket's central
weakness — failure detection resting on a mobile timer and unreliable async
socket state.

```
write WS frame immediately
start HTTP immediately, in parallel
same command_id on both
authority deduplicates and returns the same committed result
```

The socket usually wins under 100ms; HTTP remains available when it is stale;
app suspension after the UI closes cannot kill a delayed timer because there
isn't one. Cost is duplicate traffic for dispositions — trivial next to call
signalling volume. Correct detection mechanism is a **server commit
acknowledgement**, not transport state.

**Q3 — necessary but NOT sufficient.** Sequence + idempotency handles duplicate
copies of the *same* decline, but not *competing* commands: decline vs
receptionist, decline vs answer, decline vs no-answer takeover, two callee
devices choosing differently, commands from an earlier epoch. Need all four:
(a) command idempotency, (b) authority-epoch validation, (c) expected-state/CAS
(`allowed_from = [ringing]` for every disposition — once anything leaves
`ringing` the rest become no-ops with an authoritative rejection), (d) an
explicit race policy resolved by **authoritative serialization**, never by
`client_tapped_at` — phone clocks drift and lie.

**Q4 — yes, and there are TWO distinct ACKs.**
`call_command_committed` (authority → command sender: your decline reached and
committed) and **`call_transition_applied`** (caller → server: I *understood*
and applied transition N). The second is the one that detects the Defect 1
class. `sockets_sent=1` only means bytes were offered to a socket.

When the caller ACK never arrives: do NOT undo or delay the transition — server
state stays authoritative. Bounded ladder: broadcast → await ~250ms → resend
same `transition_seq`/`event_id` → still absent at ~750–1000ms send a
high-priority FCM "call state changed" → caller fetches authoritative state →
record `call_transition_ack_timeout`. Two bounded attempts plus reconciliation.

**Protocol handling must fail loudly.** Never `default: break; // silently
ignore` again — use `sendProtocolNack(reason, receivedType, protocolVersion)`
then fetch authoritative state. Prefer ONE stable event name plus an enum field
(`call.disposition_changed` + `disposition`) over generating wire names from
internal state names.

**Q5 — do NOT show an optimistic FINAL disposition.** The caller cannot know the
callee tapped Decline merely because ringing stopped, a frame began arriving,
timers changed or the connection hiccupped — that reintroduces guessed state.
BUT once a valid authoritative transition arrives, update **immediately** without
waiting for media teardown, UI animation, FCM, HTTP refresh or the ACK
round-trip. `ending` may be a short mechanical teardown state, but its *reason*
must come from an authoritative transition.

## HIGHEST RISK

> Not the InboxDO hop. It is **retaining two authorities** — the server state
> machine and the caller's local ring timer.

## IS INSTANT RECEPTIONIST POSSIBLE?

**Immediate state handoff: yes. Immediate live AI speech: no**, not without
prewarming or masking startup. Achievable: ringing stops almost immediately,
"Connecting to Ava" appears almost immediately, a bundled greeting begins almost
immediately. Not guaranteeable: a fresh Gemini session + socket + audio route +
first generated audio inside 100ms.

Two-stage experience: `receptionist_starting` commits → stop ring immediately →
play a **local bundled** deterministic prompt ("Please hold while I connect you
to Ava") → connect AI in parallel → crossfade when ready. Do not keep ringing
while the AI stack warms.

## ROLLOUT ORDER

1. **Disable autonomous caller timeout takeover** ← first change
2. Shared idempotent authority command handler
3. InboxDO call-control capability + fast path
4. Dual-submit WS + HTTP, same command id
5. Authoritative transition envelopes + caller applied-ACK
6. Resend, FCM reconciliation, snapshot fetch
7. Split receptionist startup telemetry
8. Bundled local handoff audio
9. Enable for internal accounts
10. Roll out by caller client version, watching applied-ACK rates

> Do not enable the fast path globally until unknown-event handling and
> applied-ACK telemetry are shipping — otherwise another vocabulary mismatch
> becomes invisible again.

## SUCCESS METRIC

`caller_applied_transition / committed_transitions`, **segmented by client
version**. Retain `sockets_sent` only as transport diagnostics — never as a
success metric. That single substitution is what would have surfaced Defect 1
in minutes rather than hours.

## TESTS THAT MUST BLOCK RELEASE

Decline over WS only; over HTTP only; both simultaneously; HTTP first then WS;
WS first then HTTP; same command ten times; decline races receptionist; races
answer; races no-answer deadline; old-epoch command; same callee on two devices;
caller receives duplicate transition; sequence gap; unknown disposition;
transition never ACKed; socket appears open but server dropped it; app closes
immediately after tap; caller reconnects after commit; explicit Receptionist
never reports `activation_mode=no_answer`; **decline can never transition to any
receptionist state**.

Property test: *once `disposition=declined` commits, no later command, timer,
retry or client action may enter `receptionist_starting`/`receptionist_active`
for that authority epoch.*
