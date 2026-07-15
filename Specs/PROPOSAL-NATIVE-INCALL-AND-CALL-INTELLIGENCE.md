# Proposal — native in-call screen + call intelligence telemetry

**Date:** 2026-07-15
**Target:** production (`.avatok-target = prod`) — ships dark behind a kill switch
**Status:** proposal, not yet built

---

## 1. What we're doing, in plain English

**Today:** when someone answers a call, the phone finishes the fast native ringing
screen and then **boots the entire AvaTOK app** — chat, marketplace, messages, Firebase,
PostHog, the lot — just to draw four buttons (mute, keypad, speaker, end). Those four
buttons don't do anything themselves; they just call native code that was already running.

So we boot a whole app to draw a remote control for functions that are already native.
On a slow phone or a cold start, the user taps Answer and stares at nothing.

**What we'll do:** draw those four buttons natively too. The call never touches Flutter.
The app becomes irrelevant to the call path — it can get as heavy as we like and the
dialer stays instant.

**The second half:** while we're in there, we make the dialer record everything it knows
about each call and ship it out after the call ends, so we can eventually build an AI
system that detects spam.

This is how Truecaller works. We already built half of it on 2026-07-14 (the ringing
screen). This finishes the job.

---

## 2. Why — the actual numbers

The Flutter app is not a small thing to start:

- `await FontScale.load()` blocks the first frame. It's commented "cheap local prefs read"
  but it hits the **Android Keystore** — the first Keystore touch of the process.
- Then PostHog → Firebase → push init, **awaited one after another**, not in parallel.
- Then `validateGates()` makes **real network calls**, bounded by a 3-second timer.
- Our own telemetry says `shell_gate_ms` p90 ≈ **2 seconds**, max **3 seconds**.
- There's a recorded race where `shellv2_landing_root` fired **1.5s after**
  `pstn_call_screen_shown` — the answer UI was hidden behind the chat list.
- **No engine caching anywhere.** `FlutterEngineCache`, `FlutterEngineGroup`,
  `cachedEngine` → zero matches in the entire android tree. Every answer is a full cold
  Dart VM boot plus `GeneratedPluginRegistrant` constructing *every* plugin in
  pubspec — WebRTC, LiveKit, Firebase, Stripe, PostHog.
- **Single process.** No `android:process=` anywhere. The Flutter boot and the call
  contend for the same main thread.

Meanwhile the call itself is already fully native. `AvaInCallService` owns the state
machine, audio routing, and Telecom integration. `AvaDialPlugin` already exposes
`answer`, `reject`, `disconnect`, `setMuted`, `setSpeaker`, `dtmf`, `callState`.
The Flutter `InCallScreen` is four proxy calls and nothing else:

```dart
await AvaDialChannel.I.setMuted(next);
await AvaDialChannel.I.setSpeaker(next);
await AvaDialChannel.I.sendDtmf(widget.callId, d);
await AvaDialChannel.I.disconnect(widget.callId);
```

**Important correction to a common assumption:** the process is *not* cold when the phone
rings. Telecom binds `AvaInCallService` the moment a call arrives — that's why the native
ring screen paints instantly. What's cold is the **Flutter engine**, not the process. So
we don't need a separate slim app; we need to stop starting the engine.

---

## 3. What changes

### New

| Thing | What it is |
|---|---|
| `InCallActivity.kt` | Native active-call screen. Mirrors `IncomingCallActivity`. |
| `CallTelemetryBuffer.kt` | Appends call events to a JSONL file on disk. |
| `CallRecord.kt` | Per-call state held in memory: UUID, timings, actions taken. |
| `identity.json` | Flutter writes it, native reads it. Who the user is, for stamping events. |
| `POST /telemetry/calls` | Worker route. Takes raw numbers, HMACs them, forwards to PostHog. |
| `nativeInCallUi` flag | Kill switch in `routes/config.ts`. **Default OFF.** |

### Changed

| Thing | Change |
|---|---|
| `AvaInCallService.kt` | Mint a real UUID per call. Add `hold`/`unhold`. Real bluetooth routing. |
| `IncomingCallActivity.kt` | Answer feedback (haptic + Connecting state). Launch `InCallActivity`, not MainActivity. |
| `AvaDialPlugin.kt` | Expose `hold`, `setAudioRoute`. Extend `drainTelemetry`. |
| `shell_v2.dart` | Keep the Flutter path alive behind the flag, for rollback. |

### Deleted

Nothing yet. `in_call_screen.dart` stays until the flag has been on in prod for a while.
`pstn_call_screen.dart` is already dead and can go whenever.

---

## 4. Two bugs we have to fix first

**Call IDs aren't real IDs.** Today: `System.identityHashCode(call).toString()`. That's a
memory address hash — it can collide, and it's meaningless across sessions. Fine for a map
key, useless as the primary key of an intelligence database. **Fix:** mint a
`UUID.randomUUID()` at `onCallAdded`, carry it for the call's life, use it everywhere.

**The spam threshold is hardcoded.** `IncomingCallActivity` has `WARN_THRESHOLD = 70`
baked in, and ignores the `warn_threshold` that's sitting right there in
`spam_snapshot.json`. So if we ever tune it server-side, the ring screen won't listen.
**Fix:** read it from the snapshot.

---

## 5. Phone numbers — the identity design

**Decision: raw numbers never reach PostHog. Ever.**

```
Native dialer
     │
     │  raw E.164, buffered on disk, sent AFTER the call ends
     ▼
AvaTOK Worker  ──┬──▶  Operational DB   (raw E.164, encrypted at rest)
                 │
                 └──▶  PostHog          (HMAC-SHA256 only)
```

**Why the Worker does the HMAC, not the device.** If the device computes the HMAC, the
device holds the key — and a key in an APK is not a secret. Anyone who unpacks the app or
roots a phone extracts it and can dictionary-attack the whole number space, which is the
exact thing HMAC was supposed to prevent. Computing it in the Worker means the secret
never leaves Cloudflare.

This costs us nothing, because **telemetry is already buffered and sent after the call
ends.** There's no latency budget to blow. The call is over.

**`phone_id` = `HMAC-SHA256(server_secret, E.164)`** is the canonical phone identifier for
all analytics, graphing, and spam detection. It's stable, so repeat callers, report counts,
unique-caller counts, and spread graphs all work exactly as they would with raw numbers.

Raw E.164 goes to the operational backend only, over TLS, and only because these features
genuinely need it: placing/returning calls, showing the incoming number, local contact
names, blocklists, contacts, our own caller lookup, and talking to the phone OS.

**Secret rotation:** rotating the HMAC key breaks continuity of `phone_id` across the
rotation boundary. Keep a `key_version` on every event so old and new can be reconciled.

### Contacts — be more conservative

For contact data we send `phone_id`, `contact_exists` (yes/no), and relationship metadata.

**`contact_name` is the single riskiest field in this whole design.** It's a third party's
personal data, collected from a device belonging to someone else, about a person who has
never heard of AvaTOK and cannot consent or opt out. This is precisely the practice
Truecaller has been fined for under GDPR.

It is listed in the requirements, so it's in the schema below — but flagged. Before it
ships:
- confirm it's genuinely needed for the AI model (vs. just `contact_exists`)
- add a user-facing disclosure
- consider sending it only for numbers the user has explicitly reported

**Recommendation: ship Phase 1–4 without `contact_name`, add it later if the model
actually needs it.** It's an easy field to add and a very hard one to un-leak.

---

## 6. How telemetry flows

```
during the call   native appends events → filesDir/avadial/call_telemetry.jsonl
                  (no network, no Flutter, no engine — the call is sacred)

call ends         native writes the final call_completed summary

drain             if Flutter is alive → drain now
                  if not → sits on disk, drains on next app boot
                  (this is exactly how drainTelemetry already works)

upload            Flutter POSTs the buffer → Worker → HMAC → PostHog + operational DB
```

**Nothing touches the network while the call is live.** That's the whole point.

The buffer needs: a size cap, a TTL, and atomic tmp+rename writes — same discipline as
`pending_call_actions.json` already uses.

### Who the user is

Native doesn't know the user's email — that lives in Flutter (Clerk, `IdentityStore`).
So Flutter writes a snapshot to disk and native reads it. **This is an established pattern
in this codebase** — `spam_snapshot.json` and `avatok_directory.json` already work exactly
this way, and `AvaMissedCallOverlay` already reads one natively with no engine.

`filesDir/avadial/identity.json`:
```json
{
  "v": 1,
  "distinct_id": "<posthog distinct id>",
  "email": "user@example.com",
  "phone_e164": "+447700900123",
  "name": "Davy H",
  "account_id": "<AccountScope.id>",
  "updated": 1752573600000
}
```
Rewritten on login, logout, and account switch. Every buffered event carries `distinct_id`
and `email` so any call is retrievable by either party's email later.

---

## 7. Event schema

Every event carries: `call_uuid`, `phone_id`, `distinct_id`, `email`, `ts`, plus the device
block.

### Native — on the call path

**`call_ringing`**

| Field | Source | Notes |
|---|---|---|
| `call_uuid` | new UUID | replaces identityHashCode |
| `phone_id` | HMAC, done server-side | |
| `ts` | system clock | |
| `sim_slot` | `TelephonyManager` | needs `READ_PHONE_STATE` |
| `direction` | `call.details.callDirection` | incoming / outgoing |
| `carrier` | `TelephonyManager.networkOperatorName` | |
| `country_code` | `TelephonyManager.networkCountryIso` | |
| `network_type` | `TelephonyManager.dataNetworkType` | |
| `contact_exists` | `PhoneLookup` | |
| `contact_name` | `PhoneLookup` | ⚠️ see §5 — recommend deferring |
| `spam_score` | screening stash | often absent — design for null |
| `spam_bucket` | screening stash | red / reported / unknown |

**`call_state_changed`** — `ringing`, `answered`, `missed`, `rejected`, `blocked`, `busy`,
`failed`.

> ⚠️ **`voicemail` is not detectable natively.** PSTN voicemail is carrier-side; Telecom
> never tells us. Either drop it or infer it server-side. It's in the requirements but it
> cannot come from the dialer.

**`call_completed`** — the summary row, the one that matters most:

| Field | Notes |
|---|---|
| `ring_duration_ms` | ring start → answer or end |
| `talk_duration_ms` | active → end |
| `total_duration_ms` | |
| `answer_delay_ms` | **tap Answer → STATE_ACTIVE.** This is the number that started all this. |
| `end_time` | |
| `final_state` | |

**`call_action`** — `answered`, `rejected`, `blocked_number`, `reported_spam`,
`reported_safe`, `saved_contact`, `called_back`, `sent_sms`, `copied_number`.

**Device block** (on every event): `device_model`, `android_version`, `app_version`,
`language`, `country`, `timezone`.

### Flutter — not on the call path

These are screens and syncs, not calls. They stay in Flutter and use the existing
`Analytics.capture`. No reason to move them.

- **Caller details:** `opened_caller_details`, `viewed_spam_reports`, `viewed_comments`,
  `viewed_graph`, `viewed_history`, `viewed_company`, `clicked_block`, `clicked_report`,
  `clicked_trust`, `clicked_call_back`
- **Contact actions:** `edited_contact`, `deleted_contact`, `shared_contact`,
  `opened_whatsapp`
- **Contacts sync:** `phone_id`, `company`, `labels`, `favorite`, `last_updated`, `deleted`
  (names ⚠️ per §5)
- **Community:** `spam_report`, `safe_report`, `category`, `comment`, `photo`,
  `business_verified`

### Backend — doesn't exist yet

- **Guardian:** `risk_score`, `confidence`, `decision`, `reason_codes`, `processing_time_ms`
- **History:** `times_called`, `last_call`, `first_call`, `total_duration`, `total_reports`,
  `blocked_before`, `saved_before`

**These are computed, not observed.** Guardian is the AI layer we're building *toward* —
it consumes this data, it doesn't emit it. History is an aggregate the backend derives from
the call stream. Neither belongs in the dialer. Listing them here so the schema lines up
when they arrive.

> Note: `readCallLog` already exists and is permissioned, so on-device history for the
> ring screen ("3rd call today") is available without any backend at all. Worth doing
> early — it's a visible feature for almost no work.

---

## 8. Phases

Each phase is independently shippable and independently revertable.

**Phase 0 — foundations** *(no user-visible change)*
Real UUIDs. Read `warn_threshold` from the snapshot. `identity.json` writer in Flutter +
native reader. `CallTelemetryBuffer` with cap/TTL. `nativeInCallUi` flag added, OFF.

**Phase 1 — the answer moment** *(visible, small, high value)*
Haptic + pressed state on the ring buttons. `ANSWERING` state — buttons fade, spinner,
"Connecting…". Guard re-taps.
*Ships independently of everything else. If we only ever do this, it's still worth it.*

**Phase 2 — native InCallActivity** *(the main event)*
Build it. Mute, keypad, speaker, timer, end. Parity with today's Flutter screen.
`IncomingCallActivity` launches it instead of MainActivity. **Behind the flag** — off means
the old Flutter path runs, unchanged.

**Phase 3 — new capability**
`hold` / `unhold` (doesn't exist today). Real bluetooth/headset routing (today
`setSpeaker` only toggles speaker↔earpiece, so a bluetooth call looks identical to
earpiece).

**Phase 4 — telemetry**
Native emits the full schema into the buffer. Worker route with HMAC. Drain path. Flutter
events for the non-call surfaces.

**Phase 5 — unify the design**
The palettes don't match (`#141416` vs `#0B0B0D`, and every accent differs). Once both
screens are native this becomes trivial — one palette file. See
`DESIGN-BRIEF-PSTN-CALL-SCREENS.md`.

**Phase 6 — cleanup**
Delete `pstn_call_screen.dart` (already dead). Delete `in_call_screen.dart` once the flag
has been on in prod long enough to trust.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **We break answering calls in prod.** This is the path that broke testers on 2026-07-14. | `nativeInCallUi` OFF by default. Flutter path stays intact. Flip per-environment, revert instantly. |
| Native UI is slower to build than Flutter — no hot reload, no XML, all programmatic views. | Accept it. It's one screen. The plumbing is done. |
| We lose PostHog's automatic client context (session, autocapture, device props). | We're stamping device props manually anyway. Session context doesn't apply to a call. |
| Telemetry buffer grows unbounded if the app never opens. | Size cap + TTL + drop-oldest. Same as `pending_call_actions.json`. |
| GDPR exposure on `contact_name`. | Recommend deferring it (§5). HMAC everything else. |
| HMAC key rotation orphans history. | `key_version` on every event. |
| Two UIs to maintain while the flag exists. | Time-box it. Delete the Flutter path once the flag is trusted. |

---

## 10. What we're explicitly not doing

- **Not building a separate slim app.** Unnecessary — the process is already warm when the
  phone rings (Telecom binds `AvaInCallService`). Also only one app can hold `ROLE_DIALER`.
- **Not pre-warming a FlutterEngine.** Real lever, wrong fix — costs memory permanently,
  dies with the process, and still drags Firebase/PostHog/gates into the call path. It's a
  patch over the architecture instead of a fix to it.
- **Not touching the AvaTOK VoIP path or group conference.** PSTN only.
- **Not sending raw numbers to PostHog.**
- **Not building Guardian.** This proposal produces the data Guardian will eventually eat.

---

## 11. Open questions

1. **`contact_name`** — do we need it, or is `contact_exists` enough for v1? (Recommend:
   `contact_exists` only.)
2. **`voicemail`** — drop it, or infer server-side? It can't come from the dialer.
3. **Operational DB** — D1? Where does raw E.164 actually land, and what's the retention?
4. **Buffer cap** — how many calls do we hold if the app is never opened? Suggest 500
   events / 7 days.
5. **Outgoing calls** — this proposal is incoming-led. `OutgoingCallScreen` is still
   Flutter. Same treatment later?

---

## 12. Files

| Path | Change |
|---|---|
| `app/android/.../avadial/IncomingCallActivity.kt` | answer feedback, launch InCallActivity |
| `app/android/.../avadial/InCallActivity.kt` | **new** |
| `app/android/.../avadial/AvaInCallService.kt` | UUID, hold, bluetooth |
| `app/android/.../avadial/CallTelemetryBuffer.kt` | **new** |
| `app/android/.../avadial/CallRecord.kt` | **new** |
| `app/android/.../avadial/AvaDialPlugin.kt` | hold, audio route, drain |
| `app/android/app/src/main/AndroidManifest.xml` | declare InCallActivity |
| `app/lib/features/avadial/avadial_channel.dart` | identity.json writer, drain |
| `app/lib/shell/shell_v2.dart` | flag-gate the Flutter path |
| `worker/src/routes/telemetry.ts` | **new** — HMAC + forward |
| `worker/src/routes/config.ts` | `nativeInCallUi` default false |

---

## 13. Related

- `Specs/DESIGN-BRIEF-PSTN-CALL-SCREENS.md` — the visual design brief
- `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` — per-account scoping rules
- Commit `[AVADIAL-NATIVE-RING-1]` (2026-07-14) — when the ring screen went native
