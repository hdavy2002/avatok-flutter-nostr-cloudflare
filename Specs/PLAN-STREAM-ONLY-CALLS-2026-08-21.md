# Master fix plan — Stream-only calling

**Date:** 2026-08-21 · **Environment:** production · **Status:** proposed, nothing executed
**Incident:** build 10612 fails 100% of calls (`getUserMedia(): unknown factoryId null`).
Full diagnosis: `Specs/AUDIT-2026-08-21-build-10612-getusermedia-factoryid.md`.

---

## 0. The product decision (owner, 2026-08-21)

> Stream only. Cloudflare must not handle audio or video calls.
> No rollback to Cloudflare, no repair of its calling engine.
> Cloudflare continues to serve every non-call app service.

Everything below serves that decision. Where this plan and the older
`Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` "group conferences via Cloudflare Realtime"
rule conflict, **this plan wins** and the rulebook needs the same kind of amendment
the 2026-06-09 Nostr pivot got.

---

## 1. Scope — what is actually broken, and what is already dark

The engine swap (`9a4a7267`) moved **16 files** onto `stream_webrtc_flutter`. Every
one that calls `getUserMedia` is broken on 10612. But most of those surfaces are
already switched off in prod, which shrinks the urgent work considerably.

**Verified against live KV, not `DEFAULTS`** (`GET /api/config`, cache-busted):

| surface | files | prod flag | live? |
|---|---|---|---|
| 1:1 calls (chat + dialer) | `call_session`, `call_screen`, `call_prewarm`, `call_pip_thumbnail`, `call_telemetry` | — | **YES — broken** |
| Group conference | `mesh_call_screen`, `cloudflare_conference_screen`, `cloudflare_conference_controller`, `conference_migration_coordinator` | `conferenceEnabled=true`, `cloudflareConferenceEnabled=true` | **YES — broken** |
| Call translation overlay | `call_translate_overlay` | `callTranslationEnabled=true` | rides on a call — moot until calls work |
| AvaChat voice | `live_voice_controller` | `avaStreamPlainEnabled=true` | **check before shipping** |
| 1:1 SFU transport | `call_sfu_transport` | `callSfuV1=false` | no |
| AvaLive host/viewer | `live_host_screen`, `live_viewer_screen` | `liveEnabled=false` | no |
| AvaConsult | `prejoin_screen`, `consult_room_screen` | `consultEnabled=false` | no |

So the real blast radius is **1:1 calls and group conferences**. AvaLive and
AvaConsult are already dark and can be migrated later without pressure — but they
must not be re-enabled until they are, or they will fail identically.

---

## 2. The two hard problems

Neither is a coding problem, and both need a decision before code starts.

### 2.1 Cross-version interop

A phone on the new Stream build calling a phone on 10603 or earlier **will not
connect** — different engines, different signalling, no common ground. The fleet is
currently spread across a dozen builds.

Three options, pick one:

| option | consequence |
|---|---|
| **A. Hard cutover** | Everyone must update before calls work again. Simplest code, honest, no Cloudflare left. Requires getting all testers onto the build. |
| **B. Receive-only compatibility window** | New build places Stream calls but can still *answer* a legacy Cloudflare ring. Keeps a Cloudflare call path alive — **contradicts the decision**. |
| **C. Server-side refusal** | Worker rejects a legacy `POST /api/call` from a build below the cutover and returns "please update". No Cloudflare media path, and the caller gets a real explanation instead of silence. |

**Recommended: A + C.** Hard cutover, with the Worker turning legacy dial attempts
into an honest "update required" instead of a dead call. C is a Worker change only,
no client media path.

### 2.2 Group conferences

`conferenceEnabled=true` + `cloudflareConferenceEnabled=true` in prod today. Group
calls are Cloudflare Realtime, which the decision forbids. Two choices:

- **Dark it now** — set `conferenceEnabled=false`, migrate groups to Stream later.
  Groups keep full messaging; only the call icons go.
- **Migrate in the same release** — larger, and the Stream lane has never placed a
  1:1 call yet, let alone a 25-way conference.

**Recommended: dark it now.** Do not migrate a conference surface on the same build
that first proves 1:1.

---

## 3. Phases

### Phase 0 — Stop the bleeding (today, no build)

- **P0.1** ~~Move prod `latestAppBuild` 10612 → 10603.~~ **DECIDED 2026-08-21: leave
  it at 10612.** Owner's call. Consequence to accept knowingly: testers who update
  land on a build where no call works, until the Phase 2 build replaces it. That
  makes Phase 1 time-sensitive.
- **P0.2** Set `streamCallPilotEnabled=false`. The old hand-rolled pilot
  (`core/calls/rtc/`) and the new SDK lane (`streamlane/`) are **both true in prod
  right now**, which `remote_config.dart:167-169` states must never happen.
- **P0.3** Set `conferenceEnabled=false` (per 2.2).
- Build #613 already cancelled. No build runs until Phase 2.

### Phase 1 — Make Stream the only call path (code)

- **P1.1** Route every human 1:1 A/V entry point through `StreamCallService`.
  Today only `place_1to1_call.dart:68` honours `streamCallsEnabled`; the other
  **8** `CallScreen(` mount sites bypass it — `chat_thread/calls.dart` (×4),
  `calls_screen.dart`, `call_overlay.dart`, `team_inbox.dart`,
  `team_ivr_screen.dart`, `push_service.dart`. The chat-thread one is what the owner
  actually hit.
- **P1.2** Remove the legacy media path rather than leaving it reachable. No
  `getUserMedia` call may remain on a live surface outside the Stream lane.
- **P1.3** Mount the call screen **before** `join()`, both outgoing
  (`stream_call_service.dart:54`) and on accept (`:95`). A join failure must render
  an error **inside** a visible screen, never a vanished screen. This is the second
  audit's finding and it is correct — it just wasn't this bug.
- **P1.4** Pop only on genuinely terminal states. `stream_call_screen.dart:55`
  currently closes on every `CallStatusDisconnected`, including recoverable
  reconnects.
- **P1.5** Explicit mic/camera preflight before join, with a denial explanation and
  a route into Settings. The Stream lane has none today.
- **P1.6** Fix the error classification. `call_session.dart:4542` labels *every*
  non-timeout media exception `media_denied` and shows "Microphone permission is
  needed to make a call". A permission denial, an engine fault and a hardware fault
  are three different messages. **This misdiagnosis cost hours of this incident.**
- **P1.7** Repair the Stream lane defects the second audit found: `_initStarted` set
  before the account check with no retry (`stream_lane.dart:65`); uncancelled
  incoming/per-call subscriptions; background recovery picking the first stored
  account on a shared device (`stream_push_glue.dart:156` — also a per-account
  scoping violation).
- **P1.8** Worker: reject legacy dial attempts from pre-cutover builds with an
  "update required" response (per 2.1 option C).
- **P1.9** Add `stream_lane_*` telemetry coverage for the whole flow, tagged with
  **both** parties' emails so either side retrieves the interaction.
- **P1.10** Regenerate and commit `app/pubspec.lock` — last touched 2026-08-19
  (`5d28a893`), still pins `flutter_webrtc` with no `stream_webrtc_flutter` or
  `stream_video*` entries. Not load-bearing (CI runs plain `flutter pub get`, not
  `--enforce-lockfile`) but the lock currently lies about what ships.

### Phase 2 — Verify before anyone calls it shipped

- **P2.1** `tool/ship_manifest.json` entry declaring `two_sided: true`,
  `min_devices_on_build: 2`, and the success assertions in §4.
- **P2.2** Green `typecheck.yml` — including `design-guard` and `ship-gate`.
  Reminder: **a green deploy is not a green typecheck**; run `npx tsc --noEmit` in
  `worker/` before any Worker deploy.
- **P2.3** Build to Closed Alpha, both testers on the new build, then read §4.

### Phase 3 — Afterwards, unhurried

- Migrate AvaLive, AvaConsult and group conferences to Stream. **Each stays dark
  until migrated** — re-enabling any of them on the current code reproduces this
  exact failure.
- Amend `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` so the Cloudflare-Realtime-for-calls
  rule no longer contradicts the decision in §0.

---

## 4. Success criteria — write these down before the build (ship-gate rule 3)

Not "events are flowing." These exact values, or it did not work:

| assertion | why |
|---|---|
| `stream_lane_call_placed` count **> 0** | zero all-time today. First proof the lane runs at all. |
| `stream_lane_call_connected` on **2 distinct persons**, both on the new `$app_build` | rule 2 — a call needs two phones; one device is untestable by construction. |
| `rtc_error` where `stage='get_user_media_failed'` count **= 0** on the new build | the actual regression. |
| `call_started` where `provider='cloudflare'` count **= 0** on the new build | proves no hidden Cloudflare route survived. |
| `call_ended` where `reason='media-denied'` count **= 0** on the new build | proves the screen no longer vanishes. |

---

## 4b. Owner decisions — SETTLED 2026-08-21

1. **Cutover:** hard cutover (§2.1 option A). Every user must update.
2. **Legacy dial from an old build:** show **"Update required"** (§2.1 option C).
   Worker-side refusal; no Cloudflare media path.
3. **Group calls:** switch the group-call **buttons off** now. Group **messaging keeps
   working normally** (text, media, voice notes, stickers, polls, location, contact
   cards — unchanged). Groups move to Stream in a later stage.
4. **Legacy Cloudflare call code:** leave it **compiled but unreachable** for the
   first Stream release, as an emergency backup. **Delete it once Stream is proven
   reliable** — this is a debt with an expiry, not a permanent fork.
5. **`latestAppBuild`:** leave at 10612.
6. **Release gate:** one real call between **two phones** must succeed before the
   release is called good.

Sequence: make 1:1 Stream calls reliable first, then move group calls to Stream.
Cloudflare carries no calls at either stage.

## 5. Open decisions for the owner

1. ~~**P0.1** — roll `latestAppBuild` back?~~ **Decided: leave at 10612.**
2. **§2.1** — confirm hard cutover (A) plus Worker "update required" (C)?
3. **§2.2** — confirm group conferences go dark now rather than migrating in the
   same release?
4. **P1.2** — delete the legacy call engine, or leave it compiled but unreachable?
   Deleting is truer to the decision; leaving it makes the diff smaller and the
   revert easier if Stream disappoints.

---

## 6. Standing risk

The Stream lane has **never placed a single call in production** —
`stream_lane_call_placed` is zero, all-time, across every user. This plan makes an
entirely unexercised path the only path. That is the right destination, but it means
Phase 2 is not a formality: treat the first Stream call as unproven until §4 reads
back clean on two devices.
