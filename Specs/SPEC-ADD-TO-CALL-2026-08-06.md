# Spec — Add to call (1:1 → group, seamless)

**Created:** 2026-08-06 · **Environment scope:** production feature · **Status:** planned, not started
**Companion spec:** `Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md` (recording interacts with this — §7)

> **Estimate correction.** An earlier verbal estimate of 12–18 weeks was wrong, based on two assumptions that did not survive investigation: that auto-creating a conversation would pollute users' chat lists, and that make-before-break was greenfield. Neither holds (§1). **Revised: 5–7 weeks.**

---

## Decision summary

| | |
|---|---|
| **Trigger** | An **Add to call** tile in the in-call control grid — row 3, slot 3, already reserved and empty. |
| **Who can add** | **Either party**, at any point during the call. |
| **Cap** | **10 participants**, enforced in one place. Well inside every existing cap (25/32). |
| **Room** | **Ad-hoc, invisible — the WhatsApp model** (owner decision, revised 2026-08-06). No group chat is created. The call appears in call history only. §2 |
| **Audio continuity** | **Seamless — no gap.** Make-before-break: the SFU leg comes up carrying the existing capture stream, is verified, and only then is the 1:1 leg released. §4 |
| **Billing** | **Free.** Nothing to build and nothing to disable — conferences are permanently free, enforced at three layers, and `config.ts` 409s any attempt to turn billing on. §6 |
| **Recording** | **Continues through escalation** and records the group. **Blocked on a prerequisite:** the Recording indicator must exist on the conference screen first. §7 |
| **Video** | Inherits the existing conference behaviour; not changed by this spec. |
| **Plan** | 5 phases, ~5–7 weeks. **Phase 2 (the migration) is the hard gate.** §9 |

---

## 1. Why this is cheaper than it looked

**The "hidden group" problem does not exist**, because the owner chose a reusable room — but it would not have existed anyway. Two findings:

- **The Chats tab is built from the contact book, not from conversations** (`app/lib/features/avatok/chat_list.dart:2077-2115`, with an explicit owner decision from 2026-06-28 that groups appear only in the Groups tab). A new conversation row cannot appear there.
- **The Groups tab filters on `kind == 'group'`** (`app/lib/sync/group_api.dart:172`). Membership visibility is entirely client-side.

Since the room is meant to be reusable, we simply create a **normal group** — `kind='group'` — via the path that already exists. There is no new conversation kind, no invisibility trick, no orphan-row cleanup problem, and **no migration**.

**Make-before-break is half-built.** `CloudflareConferenceController` already accepts a `sharedLocalStream` end to end, including the ownership/disposal split that is the usual failure point (`cloudflare_conference_controller.dart:82-85`, `:568-579`, `:1547`). Permission preflight is already short-circuited when a shared stream is passed. Handing a live capture stream to a second `RTCPeerConnection` is something this codebase already does in three places (video upgrade, SFU video enable, relay migration).

**The ring path is finished and shipped.** `ringGroup` (`groupcall.ts:249-316`) does WS fast-path + FCM with per-target telemetry and a 45 s TTL; `cancelRing` un-rings on call end; the client handles an incoming group ring through CallKit into `_openGroupCall` (`push_service.dart:4456-4482`).

**What is genuinely missing** is listed in §4.3 and §5 — and it is a much shorter list than the surface area suggests.

---

## 2. The room — ad-hoc and invisible (WhatsApp model)

**Owner decision, revised 2026-08-06: build the standard behaviour. No group chat is created.** Adding someone to a call turns it into a group call that lives in call history only, exactly as WhatsApp does. An earlier revision of this spec had the room persisting as a reusable group; that is superseded.

The conference stack requires a `conversation_members` row to authorize a join (`groupcall.ts:373-378`, `conference_room.ts:161-172`), so a conversation must exist. Make it **invisible** rather than absent:

**Write `kind='call'`** (not `'group'`) via a sibling of the `convCreate` group branch (`worker/src/routes/messaging.ts:1551-1588`). That single value is enough, because visibility is entirely client-side:

- **The Chats tab is built from the contact book, not from conversations at all** (`app/lib/features/avatok/chat_list.dart:2077-2115`, owner decision 2026-06-28: groups appear only in the Groups tab). A conversation row can never surface there.
- **The Groups tab filters on `kind == 'group'`** (`app/lib/sync/group_api.dart:172`), so a `kind='call'` row is skipped before it reaches `GroupStore`.
- `groupMembers` (`groupcall.ts:73-78`) and `isGroupMember` (`conference_room.ts:161-172`) both query `conversation_members` **without checking kind**, so the entire call stack works untouched.

Also required:

- **Set `context='system'`** so it is excluded from any context-filtered conversation listing.
- **Suppress `fanGroupInvites`** (`messaging.ts:1587`) — the group-call ring is the notification; the invite fan-out would double-ping.
- **Do not `GroupStore().upsert()`** on the client (`group_api.dart:68`) — `GroupApi.create` caches unconditionally today, which would put an ad-hoc room in the Groups tab regardless of what the server said. The `kind != 'group'` filter at `:172` only covers the *sync* path.
- **Keep immediate membership.** `groupInvitesEnabled` defaults to `false` (`config.ts:1099`), so invitees become members immediately rather than pending — which is what a live call needs. If that flag is ever turned on, this path must retain immediate membership or the ring reaches people the conference then refuses.
- **Decide the liveness gate.** `convCreate` calls `gatePublicAction(..., "group_create")` (`messaging.ts:1558`). Keep it, or this becomes an ungated conversation-creation path.

**Known consequences of the ad-hoc model:**

1. **Rows accumulate.** Every escalated call leaves two D1 rows and one permanent `GroupCallRoom` DO instance (`idFromName(convId)`). Nothing in the app deletes conversations today. Needs a cleanup sweep — this is the main cost of choosing ad-hoc over reusable.
2. **`kind='call'` is a new value** in a column that has only ever held `dm`/`group`. `convIsGroup` (`messaging.ts:1641-1645`) will 400 `"not a group"` on it, so member management for an ad-hoc room needs its own small route. Audit other readers of `kind` on the client before shipping.
3. **No "call those three again."** That is the trade for not cluttering the Groups tab.

---

## 3. Which durable object owns what

Today two exist with an **undefined relationship**, and this must be settled before any code:

- **`GroupCallRoom`** (`worker/src/do/group_call_room.ts`) — the **live** authority for every group call today. Addressed `idFromName(groupId)`. Owns the SFU authority record, join tickets, the roster (which *is* the set of open hibernating sockets), active-speaker fan-out, eviction and the `MAX_CONF_PARTICIPANTS = 25` cap.
- **`ConferenceRoomDO`** (`worker/src/do/conference_room.ts`) — deployed and routable but **never called by any client**. A pure HTTP control plane with a persisted participant array and a complete two-phase migration state machine: `reserve → prepare → commit → abort`, single-flight (`409 "escalation already in progress"`), stale-epoch rejection, evidence-gated commit (`409 "sfu readiness evidence required"`), and a 10-second auto-abort of a stuck `preparing` state.

**Decision: `GroupCallRoom` owns media and remains authoritative. `ConferenceRoomDO` is the migration coordinator only, and never gates a join.**

The case for using `ConferenceRoomDO` at all rather than doing this client-side: **either party can add** (§ decision summary), so two people can hit Add simultaneously. `reserveMigration`'s single-flight is exactly the right guard for that race, it is already written, and the alternative is inventing the same lock client-side where it cannot actually be enforced.

Three things must be reconciled explicitly, or the two objects will disagree in production:

1. **Addressing.** `ConferenceRoomDO` is `idFromName(<arbitrary roomId>)`; use the **1:1 `callId`** so the migration record is keyed to the call being escalated. `GroupCallRoom` is `idFromName(groupId)` — the newly created group.
2. **Caps.** Set the participant cap in **one** place (§8). `ConferenceRoomDO.MAX_PARTICIPANTS` counts `participants.filter(present)`; `GroupCallRoom` counts live sockets. Only the latter is authoritative for admission.
3. **Generations.** Both bump independently and nothing maps them. `ConferenceRoomDO`'s generation must not be used to mint or validate a `GroupCallRoom` ticket.

`ConferenceRoomDO.joinParticipant` currently refuses unless `migration.state === "committed"`. Since it no longer gates media, leave that check but stop treating it as an admission control — it is a coordination assertion, not a security boundary.

---

## 4. The migration (the hard part)

### 4.1 Sequence

1. Adder picks contacts → confirm.
2. Create the group (§2). Both original parties + invitees become members.
3. `ConferenceRoomDO.start(groupId)` — **the coordinator never calls this today, which is why its first `migration/reserve` always 403s** (`requireMember` searches an empty `participants[]`). This is gap #1 and it is small.
4. `reserveMigration` → single-flight acquired.
5. `prepareMigration` → both clients build a conference connection **carrying the existing capture stream** (`sharedLocalStream`).
6. Verify: connection state `connected` **and** `hasMediaEvidence`.
7. `commitMigration(sfuReady: true)`.
8. **Only then** release the 1:1 leg — emit `groupcall_release_p2p`.
9. Ring the invitees (`ringGroup`, already built).

### 4.2 Handing the group id to the other original party

The callee is already on a live 1:1 signalling socket. **Pass the new `gid` over that socket before teardown** rather than ringing them — it is a single relayed frame, gives a shorter switch, and avoids the absurdity of ringing someone you are already talking to.

`CallRoom` relays any frame with a `to` verbatim and broadcasts one without, with **no allow-list of frame types**, so this needs **zero worker changes**. Both the `callrec` and `hold` frames added this week are proven precedents for exactly this shape, including the broadcast-when-`_remoteId`-is-null fallback needed on the SFU path.

### 4.3 The three real gaps

1. **`CallSession._stream` has no public getter** (`call_session.dart:565`). The coordinator needs the live capture stream. One-line addition, but it must be a *read-only* accessor — the conference controller must not take ownership, and `_ownsLocalStream` on the controller side already handles disposal correctly.
2. **`ConferenceMigrationCoordinator` never calls `start()`** and never uses its own `groupId` field, so it 403s on first contact. Also missing: no client-side abort-on-timeout (the DO self-aborts at 10 s), no P2P teardown after commit, and no ring — its own doc says *"It never rings a new participant."*
3. **The client's one-call-at-a-time guards will block the overlap.** `CloudflareConferenceController.activeGid` and `callIsGenuinelyActive()` (`chat_thread/calls.dart:486`) both refuse a second call. During make-before-break there are deliberately two. **This is the most easily-missed blocker in the whole feature** — it will present as "Add to call does nothing" with no error, on the initiator's own device.

### 4.4 Platform risks specific to the overlap

- **Two audio sessions briefly claim the route.** `NativeVoiceAudio` manages sessions per call (`endP2pSession(callId:)`). Sequence the handover so the 1:1 session is released *after* the conference session is up but without both fighting for the route — expect this to need device iteration, not just reasoning.
- **The mic is encoded twice** for the overlap window. Acceptable for a few seconds; worth a CPU check on a low-end device, especially if a recording is also running (§7).
- **Roll back cleanly.** Every step must abort back to a working 1:1. The DO's auto-abort covers a stuck prepare; the client needs the matching path.

---

## 5. Adding someone after the group already exists

Once escalated, "add another person" is a different operation — the call is already a conference. What exists and what does not:

- `ringGroup` is **already a per-uid loop**, not a broadcast. Nothing in it is start-of-call specific.
- The start-only constraint lives entirely in its **call site**: `groupcall.ts:503` guards on `preJoin.count === 0`.

So a targeted invite costs roughly:

1. **`POST /api/groupcall/:groupId/invite {uid}`** — reuse `guard()` (which already enforces membership and caps), read the live authority, call `ringGroup` with `targets:[uid]` and the **existing** `call_id` and `generation`. ~40 lines.
2. **Add the invitee to `conversation_members`** so `guard()` will mint them a ticket.
3. **`/authority/ring_add`** on the DO — `ring_targets` is written once at `/authority/start` (`group_call_room.ts:222-229`), so a late invitee would never receive the ring *cancel* when the call ends, and their phone would keep ringing after everyone hung up.

**Decline is not implemented for group rings** and this spec does not add it. A declined ring times out at 45 s and writes a `missed` call-log entry via the existing cancel handler. That is acceptable for v1 but should be named as a known gap rather than discovered later.

---

## 6. Billing — nothing to do

Conferences are **permanently free**, enforced at three independent layers: `config.ts` 409s any write setting `conferenceBillingEnabled != false` or `conferenceVideoTokensPerHour != 0`; `routes/conference_room.ts` short-circuits every billing action before it reaches the DO; and the DO short-circuits again. `groupcall.ts` and `group_call_room.ts` contain no wallet, token, tariff or per-minute code at all.

**There is no rule to disable.** The residual `BillingSegment` / `tariffPerMinute` types in `conference_room.ts` are dead structure kept for reconciling pre-transition objects.

**One thing to check before shipping:** call translation is a separate surface with its own economics. If an escalated call inherits the translate overlay, whatever that path charges would now apply across up to 10 people instead of 2. Audit it explicitly.

---

## 7. Recording through an escalation

**Owner decision: recording continues and records the group.** This works with essentially zero extra code — the recorder taps the Android audio device module, which sits below the transport, so the far-end leg becomes the SFU's mixed remote audio automatically.

**Hard prerequisite: the Recording indicator must exist on the conference screen before this ships.** Today that pill only renders on the 1:1 call screen (`call_screen.dart`). Without it, one person records and up to nine others see nothing.

This is a materially weaker consent position than the 1:1 case and should be treated as such:
- In a 1:1, the ToS clause plus an on-screen indicator means both parties are informed. In a 10-way call, the clause is doing all the work for nine people unless the indicator is there.
- The indicator must show on the conference screen for **every** participant whenever **any** participant is recording, which means the `callrec` state frame has to be relayed through `GroupCallRoom` rather than the 1:1 `CallRoom` relay. That is new work, not a copy of the existing frame.

**Status 2026-08-06: BUILT.** `[ADDCALL-4-SRV]` relays recording state through `GroupCallRoom` — a `{t:"recording"}` frame both ways, repeated redundantly on `welcome` and on every roster row. `[ADDCALL-4-UI]` announces this device's state on every change **and** on every `welcome` (so a rejoin, and joining while already recording, both re-announce), and renders the pill for every participant whenever anyone is recording, naming them from the local contact book. Both halves are written to **fail toward showing** the indicator. Verify with matrix rows 9–14 (§13) before enabling recording on group calls.

Two smaller items:
- ~~The recording's `peer_uid` / `peer_name` metadata is 1:1-shaped. Decide what an escalated recording is titled and attributed to — probably the group.~~ **Decided and built — see §11 item 4.**
- CPU: recording + video encode + two overlapping audio sessions on a low-end device is the worst case in the app. The recorder's degradation ladder protects the call, but expect gaps in recordings made across an escalation.

---

## 8. Caps

**10 participants, enforced in one place.** Every existing cap is higher (`MAX_CONF_PARTICIPANTS = 25`, `MAX_GROUP = 32`, `ConferenceRoomDO.MAX_PARTICIPANTS = 25`, client pre-check at 25), so 10 violates nothing.

**Do not add a fourth constant to the media layer.** Both `groupcall.ts:42` and `group_call_room.ts:63` carry explicit "never weakened" / "never raised past this" comments. Enforce 10 as a **product cap** at the invite/add surface and pass it as the requested cap, which `GroupCallRoom` already clamps (`Math.max(2, Math.min(requestedCap, MAX_CONF_PARTICIPANTS))`).

**The 1:1 two-seat cap must not be raised** (CLAUDE.md is explicit). This design never touches it — escalation *moves* the call off `CallRoom` rather than widening it. Note the seat model is `"side:caller" | "side:callee"` at the **type** level, so widening it would not be a one-line change even if it were allowed.

**Stale comment to fix:** `call_room.ts:2037-2039` still says *"there are no group calls in AvaTOK (group calling lives in AvaConsult)"*. That predates the 2026-06-10 rule change and now contradicts CLAUDE.md. Correct it regardless of whether this ships.

**Unrelated bug found, worth fixing separately:** `groupcall.ts:374` reads `if (mem.length > 0 && !mem.includes(u.uid))` — a group id with **zero** member rows passes the check for anyone. It is fail-*open*, opposite to `conference_room.ts`'s fail-closed lookup. Not exploitable without guessing a live opaque room id, but it is the only seam through which an unauthorised ad-hoc conference could exist, and it should not be the foundation anything is built on.

---

## 9. Plan

| Phase | Scope | Risk | Est. |
|---|---|---|---|
| **0** | Settle the DO ownership model (§3). Public read-only capture-stream accessor on `CallSession`. Recording indicator on the conference screen (§7 prerequisite). Fix the `groupcall.ts:374` fail-open and the stale `call_room.ts` comment. | Low | 3–4 d |
| **1** | Group creation on escalation (§2) + the Add-to-call tile and contact picker. Cap enforced at one surface. No migration yet — creating the group and joining cold is a valid intermediate. | Low | 5–6 d |
| **2** | **Make-before-break — hard gate.** Wire `ConferenceMigrationCoordinator`, call `start()`, relax the one-call-at-a-time guards for the overlap, verify media evidence, release the P2P leg, roll back cleanly on every failure. On a real device, on both SFU and P2P source transports. | **High** | **12–15 d** |
| **3** | Hand the gid over the 1:1 socket (§4.2), ring invitees, targeted invite-into-ongoing route + `/authority/ring_add` (§5). | Med | 6–8 d |
| **4** | Recording through escalation (§7), conference-screen indicator relay, telemetry (§10), audio-route sequencing on low-end devices, test matrix. | Med | 6–8 d |

**≈ 5–7 weeks.**

**Phase 2 is the stop point.** If the overlap cannot be made to work — two audio sessions, two publishers, the client's own busy guards — the fallback is the end-and-restart version with a 2–4 second gap, which reuses everything from Phases 1, 3 and 4 unchanged and costs about 3 more days. **That is a genuinely cheap fallback**, which is unusual and worth remembering: unlike the recording feature, failing the hard gate here does not sink the feature.

---

## 10. Telemetry

**The event catalogue already exists and has zero emit sites.** `worker/src/lib/call_telemetry_events.ts:328-358` and its Dart mirror declare: `groupcall_escalate_started/completed/failed`, `groupcall_migration_prepare_completed`, `groupcall_ready_to_switch`, `groupcall_switch_committed`, `groupcall_release_p2p`, `groupcall_invite_created/sent/received/accepted/declined/expired`, `groupcall_membership_cas_conflict`, `groupcall_full_rejected`, `sfu_audio_confirmed`.

These were written against a spec and never wired. **Wire them rather than inventing new names** — the names already encode the right decomposition, and `groupcall_release_p2p` / `sfu_audio_confirmed` are named precisely because they mark the two moments that can fail.

Per CLAUDE.md: every event carries the user's email (and phone where available); a multi-party event tags every participant so any of them retrieves the interaction; failures go through `hooks.trackException` / `Analytics.captureException`; and **`waitUntil` every worker emit on an early-return error path** — workerd drops unawaited telemetry there.

Add a shared `escalation_id` across client and worker so one escalation's whole lifecycle reconstructs as a funnel, the way `rec_id` does for recordings.

---

## 11. Open items

1. **Cleanup sweep for ad-hoc conversations** (§2) — every escalated call leaves rows behind forever. Not a launch blocker at low volume; is one at scale.
2. **Group ring decline** is unimplemented (§5) — accepted for v1, named here so it is not rediscovered as a bug.
3. **Call translation economics across 10 people** (§6) — audit before shipping.
4. ~~**What an escalated recording is titled and attributed to** (§7).~~
   **DECIDED and built, `[ADDCALL-4-UI]`.** An escalated recording is titled
   **"Group call with &lt;names&gt;"** and its `peer_name` is replaced by the same
   group label, so the Inbox card's consent line reads *"Call between Ana, Bob &
   Cara and you"* instead of naming one of five. `peer_uid` and `call_id` are
   deliberately **unchanged**: `peer_uid` is the Inbox thread key (`convKey`) and
   the `callrec_*` join key, and `call_id` is the pre-escalation 1:1 id the
   recorder never restarts from. No new wire field was added — the label rides in
   `title`/`peer_name`, which the store already re-pushes after upload, so the
   server-rendered card on the user's other devices says "group" too with no
   Worker change. `callrec_finalized` now carries `escalated_to_group`.

---

## 12. Adjacent findings — not this feature, but found while scoping it

Both were verified in code during the 2026-08-06 investigation. Neither is caused by this work; both are live today.

### 12.1 LIVE BUG: a "redirect all" user is silently unreachable by group call

The receptionist has a full-time mode — `recept_avatok_redirect_all`, *"Every AvaTOK call goes straight to Ava — she always answers first."* **It does not apply to group calls, at all.**

`groupcall.ts` never references `CALL_ROOMS`. A group ring is a WS frame plus an FCM push — no `/participants`, no `receptionistNoAnswerEligibility`, no `/no-answer-policy`, no `/receptionist-admit`, and **no server-side no-answer deadline** (`GROUP_RING_TTL_MS` is only a payload field). So a redirect-all user added to a group call gets a normal ring which CallKit expires at ≤20 s, and it becomes a plain missed call: **no Ava, no voicemail, no inbox card, no transcript.** The caller gets no decline, no busy and no no-answer signal either.

Someone who has explicitly configured "Ava always answers" is therefore unreachable by group call and will never know. Group calls are enabled in production now, so this is current behaviour, independent of add-to-call.

Three ways to resolve, cheapest first: accept it and say so in the UI ("Ava doesn't answer group calls"); tell the *adder* when an invitee has redirect-all on; or build voicemail-on-group-no-answer, which is far smaller than a full conference receptionist.

**Do not attempt to put the receptionist into a multi-party call.** She is structurally single-caller: one `client` WebSocket (`reception_room.ts:163`), a binary `who: "ava" | "caller"` dialog model with no diarization, a transcript that attributes every human turn to one name, an inbox card addressed to one DM thread, billing keyed to one caller, and exactly one `receptionist_sid` per room whose entire race-arbitration design exists to guarantee that. There is **no AI-in-conference path anywhere in this codebase** — `avaGroupCompanionEnabled` is group-chat text suggestions, `avaCapMeetingEnabled` is a copilot capability, and AvaConsult's group sessions are humans only.

### 12.2 The two SFU media paths are ~85% duplicated

`worker/src/routes/call_sfu.ts` (1:1) and `worker/src/routes/groupcall.ts` (group) speak to the same Cloudflare SFU with two byte-similar copies of the same `sfu()` helper and identical `sessions/new`, `tracks/new`, `renegotiate` and `tracks/close` request builders. Worth folding into one shared module (~120 lines, no client change, no DO change, no wire-contract change).

**This does not remove the migration in §4** — the gap comes from switching *authority* models, not media plumbing. The two differ genuinely and deliberately in pull authorization (1:1 resolves the remote session server-side from a 2-seat registry; group takes it from the client and authorizes the tuple), auth (per-side room tokens vs HMAC tickets), and liveness (heartbeat lease vs socket sweep). `call_sfu.ts:29-40` argues its own case for staying separate at the authority layer, and that argument holds.

**Considered and rejected: making every 1:1 a group room.** `CallRoom` is the call's control plane, not a seat counter. Going all-group would mean rebuilding ring receipts, the native decline token, the 20 s server ring deadline, decline, busy, no-answer timeout, glare, the 45 s reconnect grace with buffered replay, call-epoch CAS, and the legacy wire contract (whose comment records a real prod incident from one wrong word) — and it would take the receptionist with it, since the FSM's four-leg design exists precisely because *"the callee is done, the caller is very much still on the line."* It would also delete the P2P fallback outright, as `GroupCallRoom` has no offer/answer relay.

---

## 13. Test matrix — what must be exercised on real devices before this ships

**Nothing in this feature can be proved in CI.** There is no local toolchain, no
emulator with two microphones, and every genuinely risky part of it — the audio
route across the handover, two encoders on one SoC, Bluetooth SCO, FCM ring
delivery — is a property of real hardware on a real network. This matrix is the
gate.

**How to run it.** Two testers minimum, on two different physical Android
phones, each on a build you can name (`$app_build` — resolve it in PostHog
BEFORE diagnosing anything, per the recorded lesson). At least one pass must use
a **low-end device** (2–3 GB RAM) and at least one must be on **cellular, not
WiFi**. Every row below names its telemetry evidence: a row does not pass on
"it looked fine", it passes on the observable behaviour **and** the events
landing on both testers' timelines.

**Blocking vs non-blocking.** Rows 1–8 are blocking: a failure means the feature
does not ship. Rows 9–14 are the consent surface and are blocking for
**recording through an escalation** specifically — recording may be left off
(`callRecordingEnabled=false`) and the rest shipped if one of them fails.

| # | Scenario | Pass means |
|---|---|---|
| 1 | **Audio route across the handover** (audio-only 1:1 on **earpiece**, escalate) | Audio is continuous by ear — no silence, no click, no drop-out longer than a syllable — **and** the call stays on the **earpiece** on both devices. It must NOT jump to loudspeaker. `groupcall_release_p2p` present with `overlap_ms` between ~500 and ~8000; `cloudflare_route_state` reports `active_route=earpiece, route_confirmed=true` on both. |
| 2 | **Bluetooth SCO during an escalation** (headset connected and in use, escalate) | Audio stays in the headset throughout. No route flap to phone speaker and back. If it does flap, it must recover within ~2 s and never end silent. A `callrec_rate_change` (if recording) is expected and is not a failure; a `callrec_leg_stalled` with no matching `callrec_leg_resumed` is. |
| 3 | **Two encoders on a low-end device** (2–3 GB phone, video 1:1 → escalate, recording ON) | The call survives. No ANR, no OOM kill, no `$exception`. Some audio degradation during the overlap window is acceptable; a dropped call is not. `ui_frame_stats` must not show a freeze longer than 1 s on either screen. The recording may contain a gap across the overlap (spec §7 predicts this) — the file must still be playable end to end. |
| 4 | **Escalating while recording** (arm Record on the 1:1, then Add) | The recorder is never restarted: `callrec_started` fires once, `callrec_finalized` once, with the **same `call_id`** as before the escalation and `escalated_to_group=true`. The pill stays visible across the screen change. The saved file contains BOTH original voices AND the added participant. |
| 5 | **Escalating while on speakerphone** | The conference comes up **on speaker** — the route is carried across, not reset. `initialSpeakerOn` is doing its job. The mirror of row 1; both must pass, because one default would satisfy either alone. |
| 6 | **Peer on an un-upgraded build** (peer on a build with no `addcall` handler) | The adder's Add fails **cleanly** after ~15 s with *"They may need to update AvaTOK"*, and **both people are still on the original 1:1 with working audio**. `groupcall_escalate_failed` with `reason=peer_never_joined` or `peer_never_acked`. No group call is left running, and the peer's phone never rings. |
| 7 | **Both parties tap Add simultaneously** | Exactly ONE escalation proceeds. The loser sees *"The other person is already adding someone to this call."* and stays on the call, which then becomes the conference the winner built. `groupcall_escalate_failed` with `reason=single_flight` on exactly one device; never two conferences, never two `groupcall_switch_committed` for one `call_id`. |
| 8 | **Failed migration rolls back** (force it: aeroplane mode on the peer at the moment of prepare, or kill the peer app) | The adder returns to a **working, audible** 1:1 — verified by both parties speaking after the failure, not by the screen looking right. The 1:1's audio session is restored (this is the `reassertAudioSession` path; a silent-but-alive call is the specific failure). `groupcall_migrate_rollback_completed` present, and NO `groupcall_release_p2p`. |
| 9 | **Peer sees the recording indicator in a conference** (A records, B and C do not) | B and C both see **"A is recording"** (their contact-book name for A, not a uid) within ~2 s. Evidence: `callrec_peer_indicator {dir:"sent"}` on A's timeline and `{dir:"received", on:true}` on **B's and C's**. A `sent` with no matching `received` is a failure even if the pill happened to appear. |
| 10 | **Late joiner learns about an in-progress recording** (A is recording; D is added afterwards) | D's screen shows the indicator **from the moment the conference screen appears** — D must never see a clean screen and then the pill. This is the `welcome`-nested path, so D's `callrec_peer_indicator {dir:"received"}` must be within ~1 s of `groupcall_connected`. |
| 11 | **Both people recording** | Each sees **"You and <other> are recording"**; a third participant sees **"2 people are recording"**. Counts are per-viewer and must never include the viewer themself. |
| 12 | **Recording stops, indicator clears** (A stops, or the degradation ladder self-finalizes) | Every other participant's pill disappears within ~2 s. `{dir:"received", on:false}` on each. A stuck-ON indicator is a smaller failure than a missing one but is still a fail — it trains people to ignore it. |
| 13 | **Recorder reconnects mid-call** (A recording, toggle A's WiFi so the conference socket rejoins) | The indicator does NOT drop on B and C, or drops for under ~3 s and returns. This is the force-announce-on-`welcome` path; without it the DO's flag is left on a dead socket. |
| 14 | **Escalated recording's attribution** (row 4's file, opened afterwards in the Inbox) | The card reads **"Group call with <names>"** and the green line names the group, NOT one person. It must not say *"Call between <one peer> and you"* for a file with three voices. Verify on the **other** device too (the server-rendered envelope), not just the one that recorded — that path only works if the post-upload meta push landed. |
| 15 | **Ring delivery, WS path** (invitee has the app in the foreground) | The invitee's phone rings within ~2 s of the adder's commit. `groupcall_invite_sent` → `groupcall_invite_received` on the invitee's timeline. |
| 16 | **Ring delivery, FCM path** (invitee's app killed / phone locked, screen off) | The invitee gets a full-screen CallKit ring within ~5 s and can answer into the conference. This is the path that breaks silently, and it must be tested on a **locked, screen-off** phone — a foreground test proves nothing about it. If the invitee never rings, check `$app_build` before touching call code. |
| 17 | **Cap** (try to exceed 10) | The picker refuses the tap that would break 10 and says why. The server also refuses if the client is bypassed. Nobody is rung for a call they cannot join. |
| 18 | **A "redirect-all" receptionist user is invited** | Known-broken (§12.1) — record the behaviour, do not treat it as a regression of this feature. The invitee gets a plain missed call and no Ava. It must not break the call for anyone else. |

**Two rows that look redundant and are not.** 1 and 5 (earpiece and speaker) both
have to run, because a hard-coded default would pass either one alone. 9 and 10
(indicator on change, indicator on join) exercise two different server paths —
the change frame and the `welcome` copy — and only one of them fires in each
scenario.

**What this matrix cannot cover, and what to do instead.** iOS (there is no
`app/ios/`), a genuinely congested cell, and a 10-person call with ten real
phones. For the last one, rely on the per-viewer counting proved in row 11 and on
the server-side cap; do not claim a 10-way call has been tested if it has not.

## Sources

- `worker/migrations/cfnative.sql`, `phase8_verse.sql`; `worker/src/routes/messaging.ts`, `groupcall.ts`, `conference_room.ts`, `config.ts`; `worker/src/do/group_call_room.ts`, `conference_room.ts`, `call_room.ts`; `worker/src/lib/call_room_auth.ts`, `call_telemetry_events.ts`
- `app/lib/features/conference/conference_migration_coordinator.dart`, `cloudflare_conference_controller.dart`, `cloudflare_conference_api.dart`; `app/lib/core/calls/call_session.dart`; `app/lib/features/avatok/chat_list.dart`, `chat_thread/calls.dart`; `app/lib/sync/group_api.dart`; `app/lib/push/push_service.dart`
- `CLAUDE.md` (2-peer cap, conference rules, telemetry and git protocol)
- Live prod config, cache-busted 2026-08-06: `conferenceEnabled: true`, `cloudflareConferenceEnabled: true`, `groupAudioSfuEnabled: false`, `callSfuV1: true`
