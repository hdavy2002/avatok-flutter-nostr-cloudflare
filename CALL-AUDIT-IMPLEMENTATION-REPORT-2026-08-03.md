# Call Failure-Scenario Audit — Implementation Report

**Date:** 2026-08-03
**Commit:** `909e27d9` on `main`, pushed to origin
**Target:** production (`.avatok-target` = `prod`)
**Scale:** 14 files, +1588 / −67
**Not deployed.** Nothing has been pushed to the Cloudflare Worker or built. Code
only, awaiting your go-ahead.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` (worker) | No new errors. 5 pre-existing `api.ts` errors remain (lines 353/526/529/536/539, `b.callId` is `string \| undefined`) — verified identical on `HEAD` before this work. |
| `npx tsc --noEmit` (consumers) | Clean, exit 0. |
| `npx vitest run` (worker) | **262 passed**, 19 files. Includes the 40 pre-existing `call_release_gates` tests and **32 new tests**. |
| `flutter analyze` (4 changed Dart files) | **Zero errors.** Only pre-existing lints/warnings. |
| Independent code review | Subagent review of the `alarm()` restructure — brace balance, fall-through, variable scope, and the `runCommand` reordering all confirmed correct. One nit it found (`answeredAt` unhydrated before its telemetry read) was fixed. |

New test file: `worker/test/call_failure_audit.test.ts` — one `describe` per finding.

---

## The eight consolidated items

### 1. A1 — unauthenticated WebSocket room joins `[CALL-WS-AUTH-1]`

`index.ts` matches `/(api/)?room/<id>` **before any auth** and forwards straight
to the DO, which took `peerId` from a query string with no identity check. Call
ids are `avatok-` + 8 hex chars (~32 bits) and travel through pushes, telemetry
and logs. A leaked id was enough to take the second seat (setting `answeredAt`,
so the real callee's accept became a busy-reject), read and inject SDP, or simply
occupy the room so neither party could connect.

**Fix.** Two tokens, one per seat — not one shared call token, which would prove
membership but not *which side*, letting one party take both seats. Minted in
`routes/api.ts` where both identities are already authenticated; the caller's
comes back on the `/api/call` response, the callee's rides the ring push (FCM
*and* the InboxDO WS ring, because accepting a call goes straight to the socket
with no authenticated round-trip in between). Presented as `?t=`. The socket also
gets a second tag recording the proven side.

**Rollout — this is the one you need to hold.** Enforcement sits behind a new
`callRoomAuthEnforced` flag, declared in the `PlatformConfig` interface **and**
`DEFAULTS` in the same change per the fake-flag rule, **default `false`**. While
off it only observes: every un-credentialed join emits `invariant_protected` with
`kind: "call_ws_join_unauthenticated"`. **Do not flip it until a build carrying
the client half is in the field and that event has gone quiet** — every installed
app would otherwise be refused at admission and lose calling.

### 2. H1 — fail-closed FSM persistence `[CALL-FAILCLOSED-1]`

The DO advanced the aggregate in memory, told both phones and the HTTP caller,
and *then* swallowed a failed `storage.put("fsm")`. Broadcast was reliable;
persistence was not; the two disagreed and the unreliable one was the one nobody
was told about. After the next eviction the call silently rewound to a state
every participant had been told was over.

Removed the catch — Cloudflare's output gate exists for exactly this: it resets
the DO, discards the in-memory advance and *holds* outgoing messages. The catch
was what defeated the platform guarantee. `this.session = r.state` moved to after
the put. Same treatment for `markTerminal`'s puts, whose loss fails the FCM
ring-suppression probe **open** (a cancelled call rings anyway).

**Also fixed, and unaddressed through two prior review rounds:** `loadSession`'s
`.catch(() => undefined)`. A storage *read* failure was indistinguishable from
"this call has no aggregate yet", so the DO fabricated a brand-new `ringing`
session for a call that may already have been declined. Absent state and
unreadable state are different facts.

**Deliberately left best-effort** (converting these would be worse): the `cmd:`
idempotency record — failing a transition that already durably succeeded because
its replay record could not be written is a net loss; plus `gens`, the
`answeredAt` dual-write, and telemetry.

### 3. S4-a — the alarm could kill a live call `[CALL-ALARM-ANSWERED-1]`

The ring branch consulted nothing but the clock. The FSM only learned of an
answer from the client POSTing `accept_call`, and there are ordinary ways that
never lands — an old build, a lost request, or the client's own 1500 ms claim
timeout, which **fails open** to WS admission by design. Two people talking, the
aggregate still saying `ringing`, and at 20 s the alarm broadcasts `no-answer`
over the conversation or drops Ava into the middle of it.

**Guard:** skip when `session_state === "connected"` **or** ≥2 **distinct peer
tags** hold sockets.

Two deliberate departures from the patch set you were given:

- **`answeredAt` is excluded from the predicate.** The supplied patch used it.
  It is sticky — set the instant a second socket ever attached, never cleared —
  so a zombie join on an offline callee leaves it true forever. That exact
  staleness already vetoed the unreachable→Ava handoff with `409 call_answered`
  in prod (`avatok-8caef3ce`). Trusting it here would mean a phantom-answered
  call never times out and never reaches Ava. Live sockets are evidence; a sticky
  historical flag is not.
- **Distinct tags, not `getWebSockets().length`.** Adopt-and-close for a
  duplicate socket on the same peer can transiently show two entries for one
  participant; counting those would suppress no-answer for a callee who never
  picked up.

The guard skips the **ring branch only** and falls through — `alarm()` is
multiplexed, and an early `return` would silently kill away-peer grace expiry and
the billing refund retry on every connected call. On a trip it issues a new
server-only `mark_connected` command so the aggregate stops disagreeing with the
sockets (without it a later `end_call` mislabels the disposition, since
`wasConnected` reads the FSM, not the room).

### 4. A3 — duplicate receptionist sessions `[RECEPT-DO-OWNERSHIP-1]`

Two independent holes. The KV "claim" was read-then-put while the comment above
it described a write-then-read-back protocol the code did not implement — and
even that would not have worked, because KV is eventually consistent: two
concurrent `/start`s in different colos both read null and both write. And the DO
admit gate did not dedupe either: both requests send the same `commandId`, so the
idempotency cache replayed the original `ok:true` to the second one. **Both
callers were told they had won** — two greetings, two recordings, double billing,
the exact `avatok-14739b84` incident the lock cites.

Ownership moved into the DO, where check-then-put is genuinely atomic. `sid` is
now minted *before* the admit and rides along with it, so the latency-sensitive
automatic path still pays one DO hop; a new `/receptionist-claim` endpoint serves
the decline/busy lanes. The claim deliberately sits **outside** the idempotency
cache — "have I performed this command?" and "who owns the session?" are
different questions, and the second still needs a real answer when the first was
a replay. KV is now a cache in front of it, with a comment saying so.

### 5. A4 — receptionist lifecycle never reached the FSM `[RECEPT-FSM-LIFECYCLE-1]`

`receptionist_connected` and `receptionist_failed` were defined and issued by
nobody. New internal `/service-outcome` endpoint (an allowlist, not a general
command proxy — a route that could issue *any* command with server authority
would reintroduce the hole `[CALL-AUTHZ-1]` closed). `reception_room_cf.ts` posts
`receptionist_connected` on engine start and `receptionist_failed` in `failHard`,
both via `state.waitUntil` rather than a bare `void` — the failure path is
dropped exactly when it matters most, since `finalize()` tears the DO down in the
same tick.

`receptionist_connected` now also stamps `disposition = answered_by_receptionist`.
Without that it was unreachable dead code: a successful Ava session ends when the
*caller* hangs up, so teardown arrived as `end_call`, found no disposition, saw
`wasConnected` false, and filed it as `caller_cancelled`. **Every call Ava
successfully answered was recorded as the caller giving up on it.**

### 6. A5 — handoff committed before the scenario toggle `[RECEPT-GATE-ORDER-1]`

`avatokHandoffAllowed` moved from ~140 lines *after* `receptionist-admit` to
immediately *before* it. The comment justifying the old position — "Nothing has
been persisted for this session yet at this point" — was simply false; the FSM
handoff had already been persisted. The result was the worst combination: no Ava
session, but the human room permanently closed (`humanRoomAcceptsNewPeer` is
false in `handoff`) so a late Accept could not join either, and the caller's leg
reading `connected_to_receptionist` with nobody there. A toggle meaning "don't
hand off" instead destroyed the call.

Also added a `rollbackHandoff` helper (issues `receptionist_failed`) wired to the
D1 session-insert failure, so the *class* is closed and a future early return
cannot silently recreate the shape.

### 7. H5 + H3 + H4 — the keepalive was already broken `[CALL-KEEPALIVE-1]` / `[CALL-DEADPEER-1]`

**H5 first, because H3 is unsafe without it.** `_send` stamps `gen` on every
frame once `welcome` arrives (CALL-GEN-1), and `setWebSocketAutoResponse` is an
**exact string match**. So from the moment any call connected the wire carried
`{"type":"ping","gen":N}` and never matched. On every connected call: **no pong
was ever returned**; every ping **woke the DO**, defeating the hibernation this
was designed to preserve; and every ping was **broadcast to the peer as noise**.
The code comment claiming "the DO answers without waking" documented behaviour
that had stopped happening.

A missed-pong counter layered on top of that would have seen zero pongs on every
*healthy* call and forced a reconnect every 30 s, everywhere — a P0 regression
dressed as a reliability fix. Client now sends the keepalive **raw**, bypassing
`_send` (works against every already-deployed server, no worker change needed);
the DO additionally answers and absorbs `ping`/`pong` in `webSocketMessage` for
the builds already in the field, which will never send the raw form.

**H3** then adds `_missedPongs`, reset on **any** inbound frame at the top of
`_onSignal` (any traffic proves the socket alive) — a complement to the pong, not
a substitute, since mid-call the signalling WS is otherwise silent. Two misses
(~30 s) triggers **phase-correct** recovery: `_beginReconnect` post-connect,
`_reconnectSignaling` pre-connect. The two machines are not interchangeable;
calling the post-connect one during ringing would drive a call that has not
started into a state machine built to end it.

**H4** `RECONNECT_GRACE_MS` 30 s → 45 s. Client give-up stays 30 s — the margin
is added on one side only, on purpose; moving both would just re-create the tight
coupling in the other direction.

### 8. A2 — calls could resurrect after grace expiry `[CALL-GRACE-ENDCALL-1]`

Grace expiry called `markEnded()` only. The aggregate was never advanced, and WS
admission consults the FSM *and only the FSM* — where `connected` still accepts
new peers. A device reconnecting a moment after expiry was admitted into a room
the server had already declared over: `peer-left` sent, sockets closed, the other
party gone. It also meant a graced-out call never recorded a disposition at all.

Now issues `end_call` as `server`, so the session is terminal and the reducer
picks the honest disposition from the evidence. Belt: admission also refuses when
`ended === true`.

### 9. H2 — away-buffer could exceed the DO value cap `[CALL-AWAYBUF-BYTES-1]`

A DO storage value is capped at 128 KiB and the whole buffer is written as one
value; SDP offers are multi-kilobyte, so 100 frames blow past it. The put then
threw **out of `webSocketMessage`** and killed the relay — a buffering
optimisation taking down live signalling.

Now byte-bounded at 110 KiB with a running counter and drop-oldest-until-it-fits
(not a fixed `splice(0, 5)` — the frames differ in size by orders of magnitude, so
any fixed count either over-drops or still leaves the buffer over budget).

**The migration bug was the subtle one.** Records persisted before this change
have no `bufferedBytes`; `undefined + n` is `NaN`, and `NaN > MAX` is `false`, so
the drop loop never runs and the buffer is unbounded again — *silently, with the
guard apparently present in the source*. `loadAway()` now hydrates the counter.
And the `setAway` persist at the call site is wrapped: that unguarded put was the
actual crash vector, and fail-open is correct **there** (a lost buffer costs a
peer some replayed candidates) while fail-closed is correct for `fsm` (a lost
write means everyone was told an outcome the server has forgotten).

---

## Bonus items from the audit's secondary list

- **M6** `apns-expiration` on iOS call pushes, plus `apns-collapse-id`. Android
  had ring-lifetime TTL and per-call collapse; iOS had **no expiry at all**, so
  APNs would store an undelivered ring and deliver it whenever the device next
  came online — a phone ringing for a call that ended minutes ago. Note
  `apns-expiration` is an absolute unix time, not a duration.
- **M3** 8 s timeout on `getUserMedia`, with a distinct `media_timeout` code. A
  *refusal* was already handled well; a **hang** was not handled at all. On
  Android 12+ a background mic acquisition can simply never return, and the only
  thing that ended the call was a generic connect watchdog reporting "could not
  connect" — the wrong diagnosis, sending the user to look at their network
  instead of a microphone the OS refused to open.
- **M4** Guarded `jsonDecode` in `_onSignal`. It was bare inside an async handler,
  so a malformed frame was an *unhandled async error* with no catch frame above
  it. The `as Map<String, dynamic>` cast was part of the hazard too — a
  well-formed JSON scalar parses fine and then throws on the cast. Both covered.
  The server half of this same relay has been guarded since it was written.
- **M1 (answerer half)** New `relay-fallback-request`. `_forceRelayRestart`
  returns early unless `_weOffered`, so only the offerer could ever escalate to a
  relay — half a fix on a symmetric-NAT pair. The answerer cannot simply escalate
  itself (that is glare, which is why the offerer-only rule exists), so it now
  *asks*, reusing the request/initiator pattern already established for mid-call
  relay migration.

---

## Deliberately NOT done

- **M1's baked-in TURN fallback.** `kIceServers` is still STUN-only. Baking
  long-lived TURN credentials into the app binary is a security and cost decision
  that is yours, not mine — tell me how you want it and I will wire it.
- **`voicemail_stored` from the server side.** Still uninvoked. It requires actor
  `caller`, so it needs the voicemail path's authenticated context rather than the
  server-lifecycle endpoint I added. Smaller than the rest but not free.
- **The full M5 `waitUntil` sweep.** Left alone except the two new
  `reception_room_cf` sites. It is telemetry-only today, as the audit says.
- **DO-level integration tests** (real storage-failure injection, eviction
  round-trips, live WS admission). The 32 new tests cover the pure reducer
  directly and mirror the three non-pure decision points (the alarm predicate,
  the buffer eviction arithmetic, the ownership claim contract). Mirroring is a
  compromise and I am flagging it as one — it pins the arithmetic and the
  ordering, which is where all three went wrong, but it cannot catch a future
  edit that changes the DO without changing the mirror.

---

## Three things to know before deploying

1. **The commit carries 3 lines that are not mine.** Another agent has in-flight
   `[CALL-TRANSLATE-1]` work, and their `callTranslationEnabled` addition
   (interface + `DEFAULTS`) is in `worker/src/routes/config.ts` — the same file
   where my flag has to be declared. `git_safe_commit.py` isolates by *file*, not
   by hunk, so it came along. Their `worker/src/index.ts` routes did **not**.
2. **`tsc` is not clean on `main` and was not before this.** Five `api.ts` errors
   plus `workflows/deletion.ts` and `lib/dynw/host.ts`. Per your own rule that a
   green deploy is not a green typecheck, these are worth a separate pass — they
   are exactly the shape that let a 3-arg `track()` reach prod on 2026-08-01.
3. **`alarm()` can now throw.** That is the intended consequence of fail-closed
   persistence: `loadSession` and the `fsm` put both propagate, and Cloudflare
   retries the alarm. If retries exhaust, the room loses its next scheduled alarm.
   I judged this the right trade — a lost alarm is recoverable, a fabricated call
   state is not — but you should know it is a real behaviour change.

**Suggested next step:** deploy the worker to **staging** first and watch
`call_ws_join_unauthenticated` and `ring_timeout_suppressed_call_live` before
touching prod. Say the word and I will run it.

---

## Independent follow-up repair — 2026-08-03

A source-level audit after commit `909e27d9` found additional rollout blockers.
They were fixed in the follow-up production-source change set. Deployment and
build remain separate release actions:

- Room credentials now have a separate 24-hour admission lifetime; the short
  ring/native-action lease no longer invalidates a normal reconnect after 20s.
  Terminal CallRoom state remains immediate revocation.
- WebSocket ownership is enforced by authenticated `caller`/`callee` side, not
  by the client-supplied peer id. Same-side socket replacement cannot occupy the
  opposite seat, inflate the live-peer count, or create a false answer.
- Glare now keeps the already-proceeding reciprocal call. The old lexical rule
  could nominate the second request's room even though that request returned
  before initializing it. The pair DO also returns the winning call's callee
  credential directly, removing the push/HTTP token race.
- Client room credentials are persisted in account-scoped secure storage and
  restored before the first socket after process death.
- Gemini now reports `receptionist_connected` and `receptionist_failed`, matching
  the CF engine. A Gemini close before any turn/audio is a start failure.
- Failure to store the receptionist RTC init blob now completes the FSM and
  closes the session row instead of stranding the caller in handoff.
- A media stream that arrives after `getUserMedia` times out is stopped and
  disposed, so the mic/camera cannot remain open after the call ends.
- Keepalive recovery now waits for two pings that were actually sent and went
  unanswered; the not-yet-sent second ping is no longer counted as a miss.

New coverage exercises the extracted admission policy, the real CallRoom token
classifier and persisted receptionist claim, glare winner/credential behavior,
and both receptionist engines' service-outcome calls. Per repository policy,
these tests have not been run locally; GitHub CI is the verification authority.

The old “baked-in TURN fallback” item is intentionally closed without embedding
credentials: the app already fetches short-lived Cloudflare TURN credentials
from `/ice`, and the Worker already falls back to Cloudflare STUN when TURN is
not configured. Production still needs `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`
configured for relay availability; a read-only production check confirmed both
secret names are present. Their values were not read. Secrets must never ship in
the app binary.

`voicemail_stored` remains dead code because the dedicated VoicemailRoom and its
HTTP/WebSocket routes are retired with authoritative `410` responses. It is not
on any live calling path. If that product is restored later, its authenticated
caller transition must be restored with it rather than widening the internal
server lifecycle allowlist today.
