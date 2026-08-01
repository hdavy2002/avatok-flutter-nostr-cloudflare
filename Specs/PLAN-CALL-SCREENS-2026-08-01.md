# Call screens — master plan (v2)

**Date:** 2026-08-01
**Supersedes:** v1 of this file, and the scope sections of
`PLAN-DECLINE-VS-RECEPTIONIST-2026-08-01.md` (its *diagnosis* remains valid)
**Companion:** `FEATURE-LIST-CALL-SCREENS-2026-08-01.md`

---

# PART 0 — EVERY ISSUE RAISED THIS SESSION

The full register, so nothing is lost. **Shipped** = in prod worker and/or build
10471.

| # | Issue | Status |
|---|---|---|
| 1 | Declined call kept ringing on the caller's end (~5.4 s), then Ava took over | **Partly shipped** — decline now commits server-side, but see P0-b: the caller can still act on its own timer |
| 2 | Callee's incoming screen never disappeared after declining | **Shipped** — `applyRingTransition()` is the single ring-surface reducer |
| 3 | "Missed call from Unknown caller" in the title, right name in the body | **Shipped** |
| 4 | Caller shown as the Gmail/Clerk name ("Davy"), not the AvaTOK profile name ("Arti Singh") | **Shipped** — `publicIdentityFor()` reads `DB_META.users` only; Clerk lookup deleted; KV prefix bumped to `ph_name4:` to evict poisoned entries |
| 5 | Caller's profile **photo** on the incoming screen | **Shipped** |
| 6 | "Davy called, Ava answered" leaked the Gmail name — should just say "Ava answered" | **Shipped** |
| 7 | Gmail address must never be shown anywhere in the product | **Shipped** for the call paths; no audit done of the rest of the app |
| 8 | New incoming-call screen from the designs | **Shipped** (7-control version); needs the 4-control rebuild |
| 9 | Report Spam → row in the DB | **Shipped** — migration applied to prod |
| 10 | Block → caller dropped immediately on the next call, never rings, no network lookup | **Shipped** — `admitCall()` runs before anything else |
| 11 | Voicemail — caller records, lands as a normal audio message | **Shipped**, but the trigger moves (D1) |
| 12 | Quick replies — pick a message, call ends both ends, caller gets it | **Shipped**, trigger moves (D2) |
| 13 | Receptionist must hand to Ava **immediately**, not after more rings | **NOT DONE** — P0-a and P0-b |
| 14 | Two Decline buttons behaving differently (top notification vs branded screen) | **NOT DONE** — P0-c |
| 15 | Receptionist showing the caller "Declined" | **NOT DONE** — P0-a |
| 16 | App icon not changing on the phone | **Diagnosed — see Part 5** |
| 17 | Cross-user call control (any user could decline a stranger's call) | **❌ OPEN — P0. I WAS WRONG TO MARK THIS SHIPPED.** See Part 7, finding A |
| 18 | Release gates 1–5 | **4 of 5 closed**; gate 3 half-open (Part 4, P1) |
| 19 | On Call screen — the icoming5 design | **This plan** |

---

# PART 1 — OWNER RULINGS

| # | Ruling | Date |
|---|---|---|
| **R1** | **Video is REMOVED.** No toggle, no mid-call conversion. `config.video` stays immutable — which all 41 read sites already assume. | 08-01 |
| **R2** | **Add call is AUDIO ONLY**, and becomes an audio conference. | 08-01 |
| **R3** | **Keypad stays visible on every call**, including AvaTOK-to-AvaTOK — menu-driven IVR is coming. *(Overrides my D3.)* | 08-01 |
| **R4** | **Quick-reply menu stays open until the user dismisses it**, with an explicit exit icon. *(Refines D2.)* | 08-01 |
| **R5** | **Up to 25 participants**, not 3 — with a live, gapless switch to a server SFU. *(Overrides my D6.)* | 08-01 |

**Control grid: Mute · Keypad · Audio · Add call · Pause · End call.**

---

# PART 2 — DECISIONS

### D1. Voicemail is an outcome, not a button *(unchanged)*
No phone asks the **callee** to press voicemail — it is what happens to the
**caller** when nobody takes the call. When the callee's ring leg ends without an
answer and the receptionist did not take it, the caller is offered *"Leave a
voice message"*. The recording, upload and delivery built today are untouched;
only the trigger moves to the server, which already owns the outcome.

### D2. Quick replies — after the decline, and they stay until dismissed *(R4)*
The Message button is gone. **The decline commits first** — the caller is
dropped instantly, nothing sits between the tap and the disconnect.

Then the reply menu opens **and stays open**, with an **✕ exit icon** top-right.
It closes on: ✕, sending a reply, or the back gesture. **No auto-dismiss timer.**

*Why the owner is right to want it persistent:* a timed strip creates a race
against the user — they read, decide, reach, and it vanishes. A menu that waits
costs nothing, because the call is already over. There is no longer any reason
for urgency in this UI, so it should not behave urgently.

Not shown after Report Spam or Block — messaging someone you just reported is
incoherent.

### D3. Keypad — DTMF, always visible *(R3)*
The keypad sends DTMF and is present on every call. The green *dial* button is
still removed: dialling mid-call is Add call, and two doors to one room is
exactly how the two-Decline-buttons bug happened.

On AvaTOK-to-AvaTOK calls today there is nothing listening for tones, so digits
go nowhere — harmless, and the surface is ready for the IVR.

**Build it right for IVR now, since that is the stated destination:** tones must
travel as RFC 4733 telephone-events, not as audio the far end has to recognise.
Doing that later means changing the media path; doing it now is free.

### D4. Contacts stays inside Add call *(unchanged)*
One reason to open contacts mid-call: to add someone. Panel title always **"Add
to call"**. The return-to-call banner ships, because the picker is full-screen.

### D5. Add call — the flow *(refined by owner)*
1. Tap **Add call** → contact list opens
2. Pick a person → their avatar appears beside the current peer, **"Ringing
   \<Name\>…"**
3. They answer → they join the conversation
4. They don't → **"\<Name\> isn't picking up"** with **"Back to the call"**;
   your original call was never interrupted

The mechanism that makes step 4 free — and step 3 gapless — is Part 3.

### D6. Up to 25 *(R5)* — see Part 3
### D7. The other people are told, not asked *(unchanged)*
No consent modal. A modal mid-conversation is unanswerable — you are talking,
phone at your ear. Everyone sees who joined and when, plus a join tone. What
protects privacy is **knowing**, not approving. Silent addition would be
indefensible; this is not that.

### D8. No call waiting in v1 *(unchanged)*
A second incoming call while you are on one goes to the receptionist, else
missed. Call waiting needs a *held incoming leg*, which the frozen model does not
have — adding one recreates the bug class this session removed.

### D9. Anyone may leave, nobody may remove *(unchanged)*
Removal needs a moderation permission model. Out of scope.

### D10. **REVISED TWICE** — continuity, hosting and paying are three things

v1 said host-leaves-ends-it. That was sized for 3 people and is wrong at 25 —
ending a 20-person call because one person's battery died is indefensible.

My v2 fix was *also* wrong, and Sol was blunt about why: it transferred **room
continuity, moderation authority and financial liability together**, as if they
were one thing. They are three, and only two of them may move.

| Concern | Rule |
|---|---|
| **Room continuity** | Survives the initiator. Ends when the **last** participant leaves. |
| **Host / moderator** | Transfers automatically to the longest-present **eligible** participant. User-level tenure, preserved across a bounded reconnect grace — otherwise reconnecting resets seniority and a second device can game the election. |
| **Financial liability** | **Does NOT transfer.** Immutable by default. |

**Why billing must not follow the host.** Sol's abuse case is unanswerable:

> A starts an expensive conference, invites a target, leaves immediately. The
> target becomes longest-present and starts being charged for a call they did
> not create and never agreed to fund.

That is a financial abuse primitive, not an edge case. And the elected host may
be structurally incapable of paying anyway — empty wallet, spending limit,
parental restriction, account under review.

**v1 rule:** the initiator remains the sponsor after leaving, for a bounded grace
(≈5 min or until their existing reserve is exhausted), then the room ends unless
someone **explicitly accepts** sponsorship. Later, we can offer *"A left.
Continue this call on your account?"* — transferring only after server-side
acceptance **and** a successful new authorization.

**Never rewrite the billing anchor in place.** Append a new segment:

```
segment 1: sponsor=A, start=t0, end_exclusive=t1
segment 2: sponsor=B, start=t1, end_exclusive=t2
```

Mutating one owner field produces double-charging across the handover, unbilled
gaps while the new sponsor's authorization clears, ambiguous refunds, and
disputes nobody can reconstruct.

**And do not use one `owner_uid` for everything.** Explicit capabilities —
`can_invite`, `can_remove_participants`, `can_end_for_all`,
`can_manage_recording`, `can_view_billing`, `can_accept_sponsorship`. Otherwise
electing a new host silently hands them access to billing details and recording
controls.

**Not in the first release:** automatic billing-anchor transfer. Sol's judgement,
which I accept — *"more dangerous than the media migration."*

### D11. Only the adder hears ringback *(unchanged)*
### D12. The added person is told what they are joining *(unchanged)*
*"\<Name\> is calling"* / *"Adding you to a call with \<Peer\>"*.
### D13. Portrait-lock the call screens *(unchanged)*

---

# PART 3 — THE GAPLESS 2→25 MIGRATION

## First, a correction to v1 of this plan

**v1 said the conference runs on LiveKit. It does not — LiveKit was removed on
2026-07-24** (`CF-CUTOVER-AND-LIVEKIT-REMOVAL-RUNBOOK-2026-07-24.md`).
`routes/conference.ts` is now a tombstone that returns a typed failure so old
clients know to update.

The real infrastructure, and it is better than what I described:

| Piece | Where | Reusable as-is? |
|---|---|---|
| Cloudflare Realtime SFU routes | `worker/src/routes/groupcall.ts` | mostly |
| Room authority DO | `worker/src/do/group_call_room.ts` | mostly |
| Client | `app/lib/features/conference/cloudflare_conference_controller.dart` | **no** — finding D |
| Flag | `cloudflareConferenceEnabled` | yes |
| Cap | `MAX_CONF_PARTICIPANTS = 25` — exactly what R5 wants | yes |
| Join security | HMAC-SHA256 tickets `{call_id, uid, session_id, generation, exp, nonce}` | **no** — nonce never consumed, finding B |
| Bounded pulls | `MAX_AUDIO_PULLS = 6` | **no** — it is a *cap*, not a *selection*, finding C |
| Conference billing | — | **does not exist**, finding E |

The SFU is Cloudflare-native, same platform as everything else, and capped at 25.
**We are not building a conference — we are building a door into one that
exists.** But the audit shows that door needs more than an address.

## The one real gap

`groupcall.ts` is addressed by **`groupId`**, and membership comes from
`groupMembers(env, groupId)` — it is scoped to AvaTalk *groups*. An ad-hoc 1:1
escalation has no group.

**Work item:** make a room addressable by an **ad-hoc room id derived from the
call id**, with membership derived from the call's participant list instead of
group membership.

> ⚠️ **I originally wrote "everything else — tickets, caps, pull limits,
> telemetry — is reused untouched." That was wrong and is retracted.** The audit
> found the tickets, the audio selection and the billing all need work before
> they can carry this feature. See Part 7, findings B, C and E.

## The technique: **subscribe early, render late** (make-before-break)

The naive migration — hang up P2P, then join the SFU — has a gap the length of
an SFU join, and it risks a healthy call for someone who may never answer.

Instead: WebRTC permits multiple PeerConnections at once, so the P2P call and the
SFU session live side by side, and the SFU path is *proven working* before
anything is torn down.

## Reviewed adversarially by GPT-5.6 Sol (Medium), 2026-08-01

Sol's verdict: **"directionally plausible but not safe enough to ship as
described."** Five of my claims were wrong. They are corrected below rather than
quietly patched, because each was wrong for a reason worth remembering.

### ✗ Correction 1 — "gapless" was a false promise

> *"You have two independent jitter buffers, clocks, network paths, decoders,
> audio sinks and client state machines. A mute flip can produce a short gap,
> duplicated speech, a delayed echo, clipping, one-way audio, or A and B
> switching at different times."*

**The target is now "bounded and usually imperceptible", not "gapless".** Saying
gapless in a spec means nobody budgets for the cases where it is not, and every
one of those cases is audible.

### ✗ Correction 2 — "same frame" switching is fiction

A and B have separate clocks, control paths and event loops. They cannot switch
together. If A switches 300 ms early that is survivable — but if A *tears down
P2P* on switching while B has not, that is **one-way audio**.

**Replaced local flips with a two-phase commit:**

```
PREPARING   A and B build SFU send+receive paths alongside live P2P
PREPARED    each reports EVIDENCE-BASED readiness (see correction 4)
COMMIT      server authorises cutover, with an epoch
COMMITTED   each crossfades output — and KEEPS P2P alive, muted
DRAIN       both confirm SFU audio is actually continuing
FINALIZE    server authorises P2P teardown
```

### ✗ Correction 3 — "there is no migrate back" is only true *before* commit

**P2P must be retained, muted, for a 2–5 s drain window after commit.** If SFU
audio dies immediately after the switch, we restore P2P without renegotiating.
Tearing down at the mute flip throws away the only cheap recovery we have.

### ✗ Correction 4 — `sfu_ready` as I defined it was meaningless

It must **not** mean session created, ICE connected, SDP complete, or track
published. It must be **evidence of media actually flowing**:

- outbound RTP packets and `bytesSent` increasing, no sender failure
- **inbound** RTP, `bytesReceived` and *decoded audio frames* increasing, with
  RTP timestamps progressing — sustained over a 300–500 ms continuity window,
  because one arrived packet may be comfort noise or stale
- audio session active, expected audio route active
- `migration_id` + generation + participant session all match

**A must prove it can hear B over the SFU. B must prove it can hear A.** Proving
both published is not the same thing and would have shipped a broken gate.

### ✗ Correction 5 — "muted" was underspecified

Merely disabling the remote track is not enough. The choice is:

- *not subscribed* — safest, but defeats the whole point: no warmed jitter
  buffer and no proof inbound media works
- *subscribed, renderer detached* — better, but some implementations only fully
  exercise the receive path once a sink exists, so readiness would be a lie
- **subscribed, renderer attached, zero gain** ← **chosen.** Closest to a warmed
  playback path, and it is the only option where readiness means what it says.

**Crossfade over 40–100 ms** at commit. Not instant (clicks), not long (the two
copies arrive at different delays, so a long crossfade produces audible comb
filtering).

## The corrected flow

```
1. A taps Add call, picks C.
   Server: verifies A may invite, checks A+B capability declarations,
           reserves ONE migration on the current call epoch,
           reserves C via CallStateAuthorityDO (so C can't be double-rung),
           allocates an ad-hoc conference_id, issues provisional tickets.

2. A and B enter PREPARING — UI says "Preparing group call…" IMMEDIATELY.
      - reuse the CALL-OWNED microphone source
      - publish with the current mute state already applied
      - subscribe to each other, renderer attached at ZERO GAIN
      - P2P stays audible and untouched

3. Both report evidence-based PREPARED within ~4 s.
   Failure: revoke tickets, close provisional sessions, release C's
            reservation, P2P completely unchanged.

4. ONLY NOW is C rung. Not before.

5. C declines / times out -> destroy the provisional conference, keep P2P.

6. C answers -> joins PROVISIONALLY and proves media readiness.
                C is NOT audible yet, and cannot hear, until commit —
                otherwise C speaks into a half-migrated room.

7. COMMIT -> A and B crossfade SFU in, P2P out, over 40-100 ms.
             P2P transport stays ALIVE and muted.

8. Server promotes CallRoom to conference: seals the old P2P generation,
   redirects reconnects, rejects late P2P signalling.

9. DRAIN confirmed (or deadline) -> close P2P.
```

**Deadlines, owned by the server — a client timeout is only a UI safeguard,
because a backgrounded client may never run cleanup at all:**
soft target 1.5–2 s · hard deadline ~4 s · cleanup watchdog ~6 s.
A late `sfu_ready` must **not** revive an aborted migration; a retry gets a new
`migration_id` and generation.

## What will bite if missed

1. **A reference-counted, call-owned audio source.** The real risk is below the
   Dart object: does `flutter_webrtc` fan one native capturer into two senders,
   or does attaching to the SFU reconfigure the source? Does removing the SFU
   sender call `track.stop()` on the track P2P still needs?
   ```
   CallMediaController   owns local_audio_track, mute state, route state
     ├── P2PTransport    attaches a sender to that track
     └── SFUTransport    attaches a sender to the SAME track
   ```
   **Invariant: no cleanup path may call `track.stop()` until every sender using
   it has been detached.** Neither transport may stop the source.
2. **Mute is call-level, not per-sender.** A muted A must not briefly publish
   audible audio because the SFU sender was built from the raw track before the
   call's mute state was applied.
3. **A microphone permission prompt during migration is a design bug**, not a
   recoverable state. B is already transmitting; the SFU must reuse the existing
   source. If a prompt appears, the SFU controller has wrongly taken ownership
   of capture.
4. **AEC instability.** Echo cancellation uses the audio actually sent to the
   speaker as its reference. If SFU audio leaks to the output for even a moment,
   A hears B twice at different delays, the canceller's reference contains both,
   adaptation destabilises, and the user gets pumping or metallic audio *after*
   the switch until it reconverges.
5. **Audio route changes are dangerous, especially Bluetooth** — the OS may tear
   down and rebuild the voice-processing unit, and iOS has **one shared
   `AVAudioSession` per app**, not one per PeerConnection. Require
   `audio_route_stable_for >= 500 ms` before commit. Abort or restart on
   speaker↔earpiece, Bluetooth connect/disconnect, headphones, or any
   interruption.
6. **Backgrounding is a state transition, not an edge case.** iOS suspension can
   deactivate the audio session and mute the mic. Bump a preparation generation
   on interruption or resume, and reject stale readiness from the old one.
7. **Network handoff invalidates readiness.** Wi-Fi→cellular may break the SFU
   path while P2P briefly survives. Readiness carries `ready_at`,
   `ready_network_fingerprint`, `ready_audio_route_generation` and expires when
   the interface, candidate pair, or route generation changes. Don't trust the OS
   "network changed" callback — re-confirm media flow.
8. **The CallRoom 2-peer cap is never raised** — but "P2P simply ends" hides a
   real ownership transition. One authoritative operation,
   `promote_to_conference(call_id, call_epoch, migration_id, conference_id)`,
   must seal the old generation so reconnects redirect, late signalling cannot
   resurrect P2P, old clients don't read closure as an ordinary hang-up, and
   telemetry doesn't record two calls.
9. **Capability gating AND runtime handling — both, not either.** Known
   unsupported → disable Add call up front with *"\<Name\>'s app version doesn't
   support adding people"*. Supported or unknown → attempt with bounded
   preparation. Never infer capability from "B is connected to P2P" — unrelated
   capabilities. An old client that ignores the migration messages must produce
   `prepare_timeout`, never assumed readiness.
10. **Never drop B to connect A to C.** The user asked to *add* C, not replace B.
    No automatic fallback.
11. **Acoustic privacy — the one I had not considered at all.** During
    preparation, A and B publish microphone audio **to Cloudflare before C has
    answered**, changing the media path from pure P2P to server-routed. Enforce a
    **provisional room state in which recording, transcription, bots and any
    other subscription are forbidden**, and decide whether existing call
    disclosures cover server publication that may never be used.

## Ad-hoc conference identity

`groupcall.ts` is keyed by `groupId` with membership from group membership. **Do
not overload a fake group.** Create a first-class `ConferenceRoomDO(conference_id)`
with an immutable origin link (`origin_call_id`, `origin_callroom_generation`,
`created_by_uid`) and membership from server-issued invitations. Bind
`conference_id`, `role`, `migration_id`, `membership_epoch` and `capabilities`
into the ticket — a group-namespace ticket must not work for ad-hoc escalation.

## Races that need explicit answers

| Race | Rule |
|---|---|
| A and B both tap Add call | One migration reservation per call epoch; loser gets `escalation_already_in_progress` |
| A leaves during preparation | Before C rung → abort. After rung, before answer → cancel C's invite. After answer, before commit → B may continue only by explicit policy, and **never** inherits billing. After commit → B and C continue |
| B leaves during preparation | Abort immediately. Do not convert A+C into a replacement call |
| C answers on two devices | First valid answer wins; other devices get invite-cancel; stale tickets revoked |
| Capacity race at 24 | `reserved + joined <= 25` enforced in the ConferenceRoom DO, with expiring reservations |
| Another call arrives mid-preparation | Reserve C's call authority *before* ringing, so Add call cannot race an ordinary inbound call |
| Preparation fails after C's push was queued | Invalidate the token, cancel the native surface, **reject late answers server-side** — push cannot be recalled. Show "Call no longer available", never a spinner |
| Replayed P2P-generation messages | Every command carries id + generation + session + command_id; cross-generation commands rejected |

## UX consequence

**Never show "Ringing C" before C is actually rung.** C's avatar appears
immediately, but the label is *"Preparing group call…"*, then *"Still
preparing…"* at 2 s, then at 4 s abort with **"Couldn't add C. Your call is
unchanged."** Reason codes are bounded and human — `unsupported_client`,
`network_unstable`, `sfu_unreachable` — never ICE jargon.

## What to measure

- `conference_switch_gap_ms` — alert above **150 ms** (target: usually imperceptible)
- `conference_prepare_ms`, and the abort rate at the 4 s deadline
- `conference_add_outcome` — `answered` / `no_answer` / `declined` /
  `prepare_timeout` / `aborted` / `rolled_back`
- `conference_rollback_used` — how often the drain window saved us
- **`conference_p2p_survived_abort` — must be 100 %.** A failed add that damages
  the original call is the one unacceptable outcome. Its own alarm.

All three parties' emails on every event, per the project telemetry rule.

---

# PART 4 — CORRECTNESS WORK (still ahead of all features)

### P0-a. `decline` and `receptionist` become separate commands
Not one command with a route flag. `call.decline` **terminates** the caller leg;
`call.route_to_receptionist` **preserves** it. Shared infrastructure — envelope,
epoch CAS, idempotency, audit — and **no shared business semantics**. This is
what stops the caller seeing "Declined" when the callee chose Ava (issue 15).

Receptionist failure terminates as `receptionist_failed`, never through
`declined`. *The caller was not declined. A service failed.*

### P0-b. Remove the caller's autonomous ring-timeout authority
**The most important fix left.** The caller still starts Ava when its own local
timer expires, so a fast decline is *racing the caller's clock* rather than
obeying the server.

> The caller may REQUEST or DISPLAY. It must not DECIDE.

Making decline faster only makes it *usually* win. This makes it always win.
Fixes issues 1 and 13.

### P0-c. One incoming-action coordinator
Native CallKit, branded screen, notification action, timeout callback and the
plugin's `ended` callback all enter through one function. The surface becomes
telemetry (`interaction_source`) and never selects behaviour. Fixes issue 14 —
that bug is duplicated *interaction ownership*, not duplicated cleanup.

### P0-d. Deterministic ring-surface teardown
Call-derived notification id (`stableHash("incoming_call:$callId")`, never the
global `8005`), exact plugin call UUID for `endCall`, never "end all calls".

### P1. Release gate 3 is half-open
No live old-client → new-worker smoke test, because staging D1 is missing the
`avatok_numbers` migration and `/api/me` 500s. **Apply it to staging** — it
blocks the only environment where compatibility can be proven.

---

# PART 5 — THE APP ICON

**The icon is correct and it did ship.**

- `232ebe06` committed the new icon at all six densities
- Build 30690875915 = run **#471** = **versionCode 10471**, from `d3f29ded`
- `232ebe06` is an ancestor of `d3f29ded` (verified, `git merge-base`)
- Prod KV `latestAppBuild = 10471` — the update flag was bumped
- Nothing in CI regenerates icons: no `flutter_launcher_icons`, and
  `postcreate.py` only adds the `roundIcon` manifest attribute

So the pipeline worked. **The phone is the remaining variable:**

1. **It never installed 10471** — check AvaTOK → About. If it does not say
   10471, the old icon is correct for the build that is running.
2. **It installed 10471 but the launcher cached the icon** — Android launchers
   cache aggressively and often skip the refresh on an in-place update. A reboot
   settles it.

Could not resolve which: **no PostHog connector is attached to this session**, so
`$app_build` for the device was unreadable. Flagging that rather than guessing
past it.

## The real bug found

**The working tree had been reverted to the OLD icon.** All 15 PNGs sat
modified-but-uncommitted with pre-`232ebe06` content and filesystem mtimes of
**Jul 31 15:43** — old files restored *with their original mtimes*, which a plain
`git checkout` does not do. The next build would have silently shipped the old
icon and looked like a recurrence.

**Restored; tree is clean.** The mtime preservation points at a file-copy or sync
process writing over the tree — worth watching, given the repo was moved off
iCloud on 07-31 for exactly that class of corruption.

**Guard:** CI should hash the committed icon against one generated from
`design/app-logo2.png` and fail on mismatch. A reverted binary asset is invisible
in a diff.

---

# PART 6 — BUILD ORDER

> **Superseded by Part 7.** The audit's wave list replaces the one below.

Sol's ordering verdict was unambiguous, and I accept it:

> **"Add call must not enter implementation rollout until that autonomy is
> removed."**

Not merely "fix it first" — Add call would **multiply the reachable states** of
the existing race. It adds many new windows in which the caller sees delayed or
unusual signalling: SFU preparation, C's reservation, C ringing, conference
commit, P2P drain, backgrounding, network handoff. A stale local timer firing in
any of them could start Ava while A and B are still talking, seize the caller leg
mid-migration, compete with conference promotion, bill for Ava *and* the
conference at once, or send contradictory terminal outcomes to B and C.

| Wave | Contents | Risk |
|---|---|---|
| **1** | **P0-b first** — remove every caller-authoritative receptionist transition. Then P0-a, P0-c, P0-d | Medium — and it gates everything below |
| **2** | Make all terminal/routing outcomes server-authoritative and epoch-guarded | Medium |
| **3** | Incoming screen: 4 controls, Report Spam sheet, persistent quick-reply menu with ✕ (R4), voicemail as an outcome (D1) | Low |
| **4** | On Call: Pause + hold overlay, DTMF keypad with RFC 4733 (R3), equaliser, toasts, portrait lock | Low |
| **5** | Freeze and test `CallRoom → conference` promotion semantics | Medium |
| **6** | Ad-hoc `ConferenceRoomDO` identity + authorization + tickets | Medium |
| **7** | Two-peer provisional SFU preparation — **without ringing C at all**. Prove PREPARING/PREPARED in isolation | High |
| **8** | **Device-lab pass**: overlap, backgrounding, Bluetooth route change, Wi-Fi→cellular, low-end Android, iPhone speaker, wired headset | High — do not skip |
| **9** | C reservation + invitation + provisional join | High |
| **10** | Commit / drain / rollback | High |
| **11** | Participants 4…25 | Medium |
| **12** | Host transfer (**not** billing transfer) | Low |
| **13** | Staging D1 migration → close release gate 3 | Low |
| *later* | Explicit billing-sponsorship continuation, with consent | — |

Waves 7–10 travel alone. If a conference migration breaks a call, that must be
the only change in the build.

**Deleted entirely:** video toggle (R1).
**Deferred as more dangerous than the media migration:** automatic billing-anchor
transfer.

---

# PART 7 — CODEBASE AUDIT, 2026-08-01

**Verdict: do not implement Add call from this plan yet.** The direction is
sound — server authority, make-before-break, two-phase commit, drain/rollback,
billing consent all survive. But the audit found release blockers in the code
this plan assumed was ready, **including one live authorization hole**.

I verified every finding below against the source myself before accepting it.

## ⛔ Finding A — cross-user call control is NOT closed. I was wrong.

**I marked issue 17 "Shipped". It is not shipped, and the hole is still open in
production.**

What I actually built: `/api/call/command`, with two proper gates — membership
derived from the persisted record, then capability.

What I failed to do: **move the client onto it.**

```
grep -rn "call/command" app/lib/     ->  NO MATCHES
app/lib/core/config.dart:37          ->  kCallStatusUrl = '.../api/call-status'
```

Every Flutter decline, accept and receptionist action still goes through the
**old** `/api/call-status`. That route calls `requireUser`, so it is
*authenticated* — but it then forwards to the DO's `/mark-terminal` with a body
of `{status, callId, terminal, commandId}` and **no `authenticatedUid`**. The
comment on `runCommand` states the rule plainly:

> *"When present, `actor` is IGNORED and derived from the persisted participants
> instead. **Every client-originated command must pass this.**"*

It is not passed. So Gate 1 — membership — is skipped, and the legacy hard-coded
actor is trusted. Worse, the FCM fan-out then goes to the **client-supplied**
recipient regardless of what the DO decided.

**Impact:** any authenticated user with a call id can terminate a stranger's call
and push a fabricated call-status to any user.

**Why my verification missed it, which is the part worth remembering.** Luna told
me *"a 401 check proves authentication, not authorization correctness"*, and
release gate 4 required authorization tests. I wrote them — 35 tests, all
passing. **They exercise `/api/call/command`, which no client uses.** The tests
guarded the secure path while every real request went down the insecure one. A
green suite over an unused code path is worse than no suite, because it produces
confidence.

`callQuickReply()` has the same membership gap, and additionally accepts
client-supplied fallback text for unknown reply ids.

**Action: P0, ahead of everything, including P0-b.**

## Finding B — join tickets are replayable

`verifyJoinTicket()` validates that a nonce is *present*; it is never consumed or
revoked. A valid ticket replayed inside its window can displace the legitimate
socket for that uid. There is also **no provisional membership state** — once
connected, a participant may publish and pull.

That kills the privacy rule I wrote in Part 3 (no recording/transcription/bots
before commit): it needs **enforceable server-side ACLs**, not a documented
promise. A provisional participant must be structurally unable to subscribe.

## Finding C — the "6 of 25" audio selection does not exist

I claimed the conference is "already smart enough not to pull all 25". **It is
not.** The client loops the roster **in roster order** and pulls each audio
track; the server accepts the first six and rejects the rest. Speaker updates
drive *video* policy, not audio rebalance.

So in a large room, **participants outside the first six may never be heard at
all.** Speaker levels are also self-reported by clients, and the DO sorts the
selected set alphabetically before naming a "dominant" speaker.

`MAX_AUDIO_PULLS = 6` is a **cap**, not a **selection**. Dynamic
loudest-speaker selection is a required wave, not a bonus.

## Finding D — the client cannot do the silent warm-up

Part 3 assumes "subscribed, renderer attached, zero gain". The conference
controller today:

- calls `getUserMedia()` **itself** — so migration would prompt for the
  microphone, which Sol correctly called a design bug
- forces the audio route toward **speaker**
- **stops its microphone tracks** on teardown — exactly the `track.stop()` hazard
  the plan forbids
- has **no per-remote-track gain control or mixer**; remote audio auto-plays on
  arrival

Its health sampler runs every **5 s**, slower than the 4 s preparation deadline
it is meant to feed, and does not produce the continuity evidence `sfu_ready`
requires.

**Zero-gain rendering is not an available switch — it needs a native audio
feasibility spike before any of this is scheduled.**

## Finding E — conference billing does not exist

The real billing ticker lives in the **two-party `CallRoom`**, which settles the
partial minute and refunds the remainder on end. `GroupCallRoom` has
`started_by` and nothing else — **zero** occurrences of sponsor, escrow, tariff,
billing segment or settle. Its client "billing beat" is telemetry only.

**So promotion as designed would end P2P billing and start nothing.** The call
becomes free and unmetered at the exact moment it becomes expensive to serve.

"The initiator keeps paying after leaving" (D10) therefore needs a **dedicated
server billing wave before promotion** — not a later host-transfer wave.

## Finding F — quick replies conflict with the state machine

D2 says Decline commits first, then the reply menu opens. But the FSM models
`send_quick_reply` as **the terminal outcome itself** — so once Decline completes
the aggregate, a later quick-reply command is rejected as already terminal. The
standalone endpoint sidesteps this, but lacks membership and durable one-use
authorization.

**Decision required, and the owner's UX implies the first:**

1. ✅ Decline is terminal; a quick reply afterwards is an **authenticated,
   idempotent, one-use post-call courtesy message** — a separate capability, not
   a call command.
2. Quick reply remains the original terminal command (contradicts R4).

## Finding G — server authority is genuinely not reached

Confirms P0-b, and adds a second half I had not written down:

- the caller still owns **12 s and 35 s** local timers in `call_session.dart`
- `authorityEnforced: false` in `config.ts` — *"verdicts NOT yet enforced"*

So the authority exists and is **switched off**. P0-b must therefore require a
**server alarm/deadline**, with client timers demoted to display and request
only.

## Also corrected

- **DTMF is a feasibility item, not free.** `flutter_webrtc` exposes DTMF
  sending, but Cloudflare's documented SFU audio codecs are Opus and G.711 —
  **not RFC 4733 telephone-event**. My "build it right now, it's free" line in D3
  is retracted; SFU and IVR behaviour must be proven separately.
- The companion `FEATURE-LIST-…` doc is **stale** — still says 6-second quick
  replies, keypad hidden on AvaTOK calls, max 3 participants, host departure ends
  the call. Reconciled.

---

# PART 8 — CORRECTED BUILD ORDER

| Wave | Contents | Why here |
|---|---|---|
| **0** | **Finding A** — move the Flutter client onto `/api/call/command`; pass `authenticatedUid` on every client-originated DO command; fix `callQuickReply` membership; stop trusting the client-supplied push recipient. **Then write tests against the path the client actually uses.** | Live authorization hole |
| **1** | Staging D1 `avatok_numbers` migration | *Moved from last to near-first — compatibility cannot be proved while `/api/me` 500s* |
| **2** | **P0-b** — server alarm/deadline owns ring timeout; delete the 12 s/35 s client authority; flip `authorityEnforced` after shadow data is clean | Gates everything |
| **3** | P0-a, P0-c, P0-d — separate decline/receptionist commands, one action coordinator, deterministic teardown | The bug class |
| **4** | Incoming screen: 4 controls, spam sheet, persistent reply menu with ✕ (R4) via **finding F option 1**, voicemail as outcome (D1) | Low risk |
| **5** | On Call: Pause + hold overlay, equaliser, toasts, portrait lock. **DTMF spike separately** | Low risk |
| **6** | **Conference authorization**: nonce consumption/revocation, provisional membership ACLs that structurally forbid publish/subscribe/record before commit | Finding B |
| **7** | **Dynamic audio selection** — real loudest-speaker rebalance, server-side, not roster order | Finding C |
| **8** | **Conference billing** — sponsor, escrow, tariff snapshot, segments, server ticker, settlement | Finding E — must precede promotion |
| **9** | **Native audio spike** — zero-gain rendering, shared capture source, route control, ≤1 s stats sampling | Finding D — go/no-go for the whole migration |
| **10** | Freeze + test `CallRoom → conference` promotion semantics | |
| **11** | Ad-hoc `ConferenceRoomDO` identity, tickets, reconnect tenure | |
| **12** | Two-peer provisional preparation — **without ringing C** | |
| **13** | Device-lab: overlap, background, Bluetooth, Wi-Fi→cellular, low-end Android, iPhone speaker, wired headset | Do not skip |
| **14** | C reservation, invitation, provisional join | |
| **15** | Commit / drain / rollback | |
| **16** | Participants 4…25 | |
| **17** | Host transfer (**not** billing transfer) | |
| *later* | Explicit billing-sponsorship continuation, with consent | |

**Wave 9 is a go/no-go.** If zero-gain rendering proves infeasible on real
devices, the whole subscribe-early/render-late design needs rethinking — and
that is far cheaper to learn at wave 9 than at wave 15.

**Nothing was built, deployed or shipped during the audit.**
