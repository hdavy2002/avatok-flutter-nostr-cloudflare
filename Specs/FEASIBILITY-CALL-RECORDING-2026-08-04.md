# Spec — AvaTOK on-demand call recording → Inbox

**Created:** 2026-08-04 · **Rev 11 (v2.0), 2026-08-06** · **Environment scope:** production feature
**Status:** ✅ **FINAL — all decisions settled, ready for implementation.** No code written; work starts at §9 Phase 0.

> **Rev 11 is a rewrite, not a patch.** Between rev 10 and rev 11 the codebase and the product both changed: 1:1 calling moved onto the Cloudflare SFU (`callSfuV1: true` in prod), a new call UI shipped, and the owner replaced auto-recording with **on-demand recording**, removed all transcription and summarization, and moved billing from per-use tokens to the **existing per-GB storage pool**. Roughly half the previous document is gone. §0 lists what changed and why; the superseded material is not preserved inline — see git history for revs 1–10.

---

## Decision summary

| | |
|---|---|
| **Trigger** | On-demand. A **Record** tile in the in-call UI; goes red while recording. Not automatic, not per-contact. |
| **Scope** | **Audio only, always** — including when video is on. Video is never captured. |
| **Capture** | On-device, Android only, via the Android AudioDeviceModule sample callbacks. **Transport-agnostic — works identically on SFU and on the P2P fallback.** §2 |
| **Format** | **AAC** in `.m4a`, mono (pending a Phase 1 quality check), unencrypted. Live file is ADTS, remuxed at close for crash safety. §3.3 |
| **Structure** | **One file per recording.** No segmentation, no parts. |
| **Storage** | Local copy on device **and** a server copy in the private `DIGITAL` R2 bucket via `registerArtifactMedia`. Presigned reads. **No Google Drive.** §5.1 |
| **Billing** | **No per-use charge.** Recordings count toward the existing per-account storage pool: **5 GB free, then 20 tokens/GB/month** over quota, charged by the existing monthly cron. Zero new billing code. §6 |
| **Retention** | **None — recordings persist until the user deletes them.** Over quota with an empty wallet goes read-only, never deletes. §6 |
| **Inbox card** | Date, time, duration, file size, **user-editable title and description**, play, share, delete. **No transcript, no AI summary, no AI title, no summary email.** §5.2 |
| **Consent** | Prominent recording clause in the signup ToS + persistent "Recording" indicator on **both** call screens. §4 |
| **Invariant** | ⚠️ **Recording is best-effort; the live conversation always wins.** §3.2 |
| **Plan** | 5 phases, ~6 weeks. **Phase 1 (audio mixing) is a hard gate.** §9 |

---

## 0. What changed in rev 11

| Rev 10 said | What changed | Rev 11 says |
|---|---|---|
| 1:1 calls are pure P2P; the SFU is dormant | `[CALL-SFU-1/2]` landed 2026-08-06. `callSfuV1: true` in prod, video included. P2P remains as a **sticky per-call fallback**. | §2 rewritten. **The recording design is unaffected** — the ADM sits below the transport. |
| Server-side SFU recording was the rejected alternative | Calls now *do* traverse an SFU, so the option reopened | **Still rejected, now for stronger reasons.** §2.2 |
| Auto-record / per-contact "always record" | Owner: on-demand only | Record tile in the call UI. Per-contact auto-record dropped. |
| Whisper STT + LLM title + per-part and assembled summaries + summary email | Owner: remove all of it | Deleted. User types their own title and description. |
| 30-minute segmentation, parts table, multi-part playback, seam handling | Segmentation existed to spread transcription across the call | **One file.** Parts, seam, gapless playback, share-which-part all deleted. |
| Stereo (near-end left / far-end right) for per-channel diarization | Diarization was the entire justification | **Mono by default**; stereo only if Phase 1 shows speakerphone quality demands it. §3.3 |
| 2 tokens per 30-minute part | Owner moved to storage-based billing | Storage pool only. Recording is free in practice for nearly every user — accepted knowingly. §6 |
| 90-day R2 retention sweeper | Incompatible with charging for storage | **No sweeper.** You don't delete what someone pays to keep. §6 |
| Google Drive offload, delete-local, Drive-backed playback | Owner: no Drive | Deleted. |
| Reflection via `FlutterWebRTCPlugin.sharedSingleton` | That approach **failed** (`adapter_field_null`) and was fixed 2026-08-05 | Use the engine-scoped binding. §3.1 |
| "The near-end callback is the same field, one word different" | Overstated — nothing in the repo uses it | Far-end is proven in prod; **near-end is unproven**. §3.1 |

---

## 1. Verdict

**Build it on-device. The SFU migration does not change this.**

Recording both sides of a call means tapping two callbacks on the Android audio device module: the **far-end decoded playback** stream (already consumed in production by `CallTranslationAudioPlugin`) and the **near-end microphone** stream (exposed by the same plugin object, but not yet used anywhere in this repo). Mix, encode to AAC, upload, show in the Inbox.

Everything after the audio file is existing machinery: `registerArtifactMedia` handles upload, dedup, quota and storage accounting; `InboxDO /append` and the Inbox card pattern handle presentation; `AudioPlaybackService` handles playback; `share_plus` handles sharing.

**Estimate: ~6 weeks, Android only.** The only part that can fail on technical grounds is Phase 1.

---

## 2. The call stack as it stands (rev 11)

### 2.1 1:1 calls now run on the Cloudflare SFU, with P2P as a live fallback

`[CALL-SFU-1]` (2026-08-06) wired 1:1 media through Cloudflare Realtime. The new media path is `worker/src/routes/call_sfu.ts` (7 routes: `join`, `publish`, `peer`, `pull`, `renegotiate`, `heartbeat`, `close`), with seat state in `CallRoom` (`SfuSeat`, `SFU_LEASE_MS = 45_000`). Client side: `app/lib/core/calls/call_sfu_api.dart` and `call_sfu_transport.dart`.

Three properties matter here:

- **`CallRoom` is still signalling only.** Its header is unchanged — *"Pure coordination… persists nothing durable."* Ringing, accept, decline, busy, presence, receptionist handoff and billing all still run through it, and the 2-peer cap is untouched. `call_sfu.ts` says so explicitly: *"This is a MEDIA path only."*
- **Transport is elected per call and can abort mid-call.** `call_session.dart:4751` picks SFU when `RemoteConfig.callSfuV1`; any failure sets `_sfuAborted`, signals the peer, and both sides drop to P2P. The flag is **deliberately one-way** — *"one side can never return to SFU after the other side has fallen back."*
- **The media stack is unchanged.** Still `flutter_webrtc 0.12.12+hotfix.1`, still the same `RTCPeerConnection` — just pointed at Cloudflare instead of the peer.

Prod flags (cache-busted read, 2026-08-06): `callSfuV1: true`, `callSfuAudioOnly: false`, `cloudflareConferenceEnabled: true`, `groupAudioSfuEnabled: false`.

### 2.2 Why recording stays on-device, more firmly than before

The ADM sits **below** the transport, so far-end decoded PCM arrives identically whether it came from a peer or from the SFU. On-device capture is indifferent to the change. Server-side recording, meanwhile, got *worse*:

1. **P2P fallback is sticky and silent.** A server-side recorder captures nothing on any call that falls back — and the user would only find out afterwards, on a feature they expected to work.
2. **The raw SFU still has no recording.** Cloudflare shipped track recording in **RealtimeKit**, a different, higher-level product. `call_sfu.ts` talks to the raw `/v1/apps/{appId}/sessions` API. Switching would mean rewriting work that landed this week.
3. **RealtimeKit export is $0.003/min audio-only** — roughly ₹17/hour, against a feature that now generates no per-use revenue at all (§6).

---

## 3. Capture design

### 3.1 The two callbacks, and one correction

`app/android/app/src/main/java/ai/avatok/calltranslation/CallTranslationAudioPlugin.java` implements `JavaAudioDeviceModule.PlaybackSamplesReadyCallback` and consumes far-end decoded PCM in production today (`onWebRtcAudioTrackSamplesReady`, L643; adapter resolution at L1001).

**Use the engine-scoped plugin binding, not `sharedSingleton`.** Earlier revisions of this document showed:

```java
FlutterWebRTCPlugin plugin = FlutterWebRTCPlugin.sharedSingleton;   // ← DO NOT
```

That path **failed in practice** with an `adapter_field_null` probe error and was replaced on 2026-08-05 by `[CALL-TRANSLATE-BIND-1]`, which binds the plugin from the Flutter engine in `MainActivity.kt:52`:

```kotlin
ai.avatok.calltranslation.CallTranslationAudioPlugin.boundWebRtcPlugin =
    flutterEngine.plugins.get(com.cloudwebrtc.webrtc.FlutterWebRTCPlugin::class.java)
        as? com.cloudwebrtc.webrtc.FlutterWebRTCPlugin
```

The recorder must follow the same pattern. Anyone implementing from the older text would reintroduce a bug that has already been found and fixed.

**Honest statement of risk.** The far-end tap is proven in production. The **near-end tap is not** — a repo-wide grep for `RecordSamplesReady` / `onWebRtcAudioRecordSamplesReady` returns nothing. The `recordSamplesReadyCallbackAdapter` field is public on `MethodCallHandlerImpl` (verified against the bytecode built for this app), but nothing here has ever subscribed to it. **This is why Phase 1 is a hard gate and why it is 10 days.** Confirm by reading `/Users/davy/.pub-cache/hosted/pub.dev/flutter_webrtc-0.12.12+hotfix.1/android/src/main/java/com/cloudwebrtc/webrtc/MethodCallHandlerImpl.java` in Phase 0.

**Do not use flutter_webrtc's built-in `MediaRecorder`.** Verbatim strings in `MediaRecorderImpl.class`: `"Video track is null"`, `"Audio-only recording not implemented yet"`. Its `AudioChannel` enum is `INPUT` **xor** `OUTPUT` — it cannot capture both legs.

### 3.2 ⚠️ Recording must never touch the live call

**The governing constraint.** Both callbacks are invoked on **WebRTC's real-time audio threads**, inside the loop that feeds the encoder and the speaker. Anything slow done there — encoding, disk I/O, a network call, a log line, a contended lock — stalls that loop and produces glitching, dropouts or one-way audio **in the live conversation**.

**The rule: the callbacks copy PCM into a bounded ring buffer and return. Nothing else.**

| Stage | Thread | On overload |
|---|---|---|
| ADM callback | WebRTC audio thread | Copy and return. No allocation, no blocking, no logging, no locks shared with the encoder. |
| Ring buffer | Bounded, lock-free | **Drops oldest frames when full. Never applies backpressure.** |
| Mix + AAC encode | Recorder worker | Falls behind → dropped frames → gaps in the recording |
| Disk write, remux | Recorder IO thread | Slow storage degrades recording only |
| Upload | Deferred, post-call | Failure invisible to the call |
| Telemetry | Batched, off-thread | Never emitted from an audio callback |

**Backpressure is forbidden.** It is how a slow disk on a cheap phone becomes a broken call. Losing 200 ms of recording is a minor defect; a stuttering call is a product failure.

**Degradation ladder** — drop frames → close and finalize the recording → disable recording for the rest of the call and notify once. At no point does the call get slower.

**Precedent:** `CallTranslationAudioPlugin` already consumes the far-end callback in production with a bounded queue and a sender thread. Follow its threading structure.

**Launch gate:** induce failure deliberately — fill the disk, stall the encoder, kill the upload — and confirm the call is unaffected every time.

### 3.3 Format

- **AAC** via `MediaCodec` (`audio/mp4a-latm`), container `.m4a`, **unencrypted**. Android ships the encoder; no new dependency. *(MP3 was considered and dropped: Android has no MP3 encoder, so it would require bundling LAME via the NDK. AAC plays everywhere modern and shares to WhatsApp, Telegram and Instagram without issue.)*
- **Write ADTS, remux at close.** `MediaMuxer` writes its index (`moov`) only on `stop()`, so a process kill mid-recording leaves an unplayable file. Writing the live stream as ADTS AAC — self-framing, plays fine truncated — and remuxing at close means a crash costs about a second instead of the whole recording. On next launch, find any orphaned ADTS file, remux it, and treat it as complete. **With no segmentation, this is the only crash protection there is.**
- **Mono by default.** Rev 9 chose stereo (near-end left, far-end right) purely to enable per-channel transcription for speaker labelling. With transcription gone, that justification is gone, and stereo is ~1.5× the bytes the user's quota pays for. Mono halves it.
  **But mono requires summing the legs, which reintroduces echo doubling on speakerphone** — the mic picks up attenuated far-end audio, and summing comb-filters it. WebRTC AEC mitigates but doesn't eliminate. **Measure this in Phase 1 and decide with data**; keep the mixer capable of both. **Never attenuate the near-end leg to compensate** — that is the user's own voice, and ducking it is the worst possible failure.
- **Sample rate:** read `getSampleRate()` / `getChannelCount()` off **every** `AudioSamples` batch, never cached once. Bluetooth SCO and wired/speaker transitions can change the capture rate mid-call; a recorder that latched the rate at start will silently produce pitch-shifted audio from that moment. With no part boundaries to close at, the recorder must **resample on the fly** to a fixed output rate.

### 3.4 Route changes, video, and lifetime

- **Bluetooth is a first-class route**, not an edge case — SCO startup delay and rate changes both bite. It belongs in the Phase 2 test matrix alongside earpiece, speakerphone, wired and car audio.
- **Recording is audio-only and independent of video state.** Turning the camera on mid-call does not stop, pause or alter recording. On the SFU path camera-on is a *second publish* (`CallSfuTransport.publishVideo`), which does not disturb the audio track or the ADM. Video frames are never captured.
- **Lifetime is free.** `ai.avatok.avavoiceaudio.CallForegroundService` already runs for exactly the call's duration with `foregroundServiceType="phoneCall|microphone|camera"`.
- **Permissions are free.** `RECORD_AUDIO`, `FOREGROUND_SERVICE_MICROPHONE`, `MODIFY_AUDIO_SETTINGS` are already declared. No `MediaProjection`, no screen-capture prompt, no storage permission.
- **ICE restarts, relay migration and SFU→P2P fallback are all invisible to the recorder.** The ADM is process-wide and survives them, which makes a native recorder *more* robust than any per-PeerConnection Dart hook. (Verify the ADM isn't rebuilt on SFU fallback — a 5-minute check in Phase 1.)

### 3.5 The required build change

R8 minification is on in release, so `app/tool/postcreate.py` (~line 462) must gain, alongside the existing `[CALL-TRANSLATE-1]` keep block:

```
-keepclassmembers class com.cloudwebrtc.webrtc.MethodCallHandlerImpl { *** recordSamplesReadyCallbackAdapter; }
-keep class ai.avatok.callrecord.** { *; }
```

**Omitting this produces a build that works in debug and silently records silence in release.** Verify on a release build, never a debug one.

### 3.6 iOS

No `app/ios/` directory, no iOS CI workflow, and `CallTranslationAudioPlugin` is Android-only. flutter_webrtc's iOS side exposes no equivalent public samples callback. Android-only is not a regression — there is no iOS call code to diverge from. Budget iOS separately; do not let it hold up Android.

---

## 4. Consent

**On-demand recording makes the on-screen indicator more important, not less** — the other party gets no warning at all until something tells them.

1. **A recording clause in the signup ToS**, accepted by every user — not only by those who record. This is what closes the all-party-consent gap. **It must be prominent, not buried:** the twelve all-party states require *informed* consent, and a clause the user provably never read is a weak thing to rest the compliance story on. Surface it as its own highlighted line or checkbox.
2. **A persistent "Recording" indicator on both call screens** while recording is active. ~1 day of work; it is what every enterprise conferencing product does.
3. **A one-time consent dialog** the first time a user taps Record, covering what is captured and that it counts toward their storage.

**Why the ToS clause is the load-bearing piece.** Participant recording is lawful under US federal law, in 38 states, and generally in India — but **twelve states are all-party consent** (California, Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Montana, New Hampshire, Oregon, Pennsylvania, Washington), where being a participant is not sufficient. Consent does not have to be verbal at the start of the call: prior, informed, affirmative agreement counts. If both parties accepted a ToS saying calls between AvaTOK users may be recorded by either participant, both have consented, all-party states included.

Google Play's 2022 ban targeted the **Accessibility API** and *"remote call audio recording… where the person on the other end is unaware."* Recording your own VoIP call in your own app is a different fact pattern — but the listing text will need updating regardless.

Not legal advice. The ToS wording is worth twenty minutes of counsel's time.

---

## 5. Server and client design

### 5.1 Server — no new storage route needed

**Register through the existing artifact helper**, `registerArtifactMedia` (`worker/src/routes/media.ts:243`):

```ts
registerArtifactMedia(env, {
  uid, bytes, mimeType: "audio/mp4",
  sensitivity: "private",        // → DIGITAL bucket, presigned reads
  app: "avacall",
  category: "call_recording",    // own bar in the AvaStorage usage graph
})
```

That single call gives you, already built: content-addressing to `u/<uid>/private/<sha256>` with dedup against `user_media`; `checkUploadAllowed()` quota enforcement (413 `quota_exceeded` when over quota with an empty wallet); the `DIGITAL.put`; the `user_media` row; and `afterRegisterFile()` → storage recompute → live WebSocket push to the client.

**There is no new playback route.** Reads presign via `presignDigitalReadUrl` on every access — never persist a URL. (Earlier revisions specified a `BLOBS` prefix-auth route cloned from voicemail; that is obsolete.)

**Upload happens after the call ends**, from the local file, deferred and retryable under `workmanager` (already in `pubspec.yaml`). A long recording is tens of MB, so use a resumable/chunked upload — a single-shot POST of a 3-hour file on mobile will fail often enough to matter.

**Inbox row** via `InboxDO POST /append` (`worker/src/do/inbox.ts:640`):

```jsonc
{ "conv": "callrec_<ownerUid>__<peerKey>",
  "sender": "<peerUid>", "kind": "call_recording",
  "media_ref": "<user_media id or key>", "scope": "to:<ownerUid>",
  "body": "{\"t\":\"callrec\",\"title\":\"\",\"description\":\"\",\"call_id\":\"…\",\"started_at\":1754…,\"duration_s\":612,\"bytes\":6800000,\"peer_uid\":\"…\",\"peer_name\":\"…\",\"peer_avatar\":\"…\",\"direction\":\"outgoing\"}" }
```

`title` and `description` start empty and are user-supplied. Editing them patches the row in place — the same mechanism `InboxCardMetaStore` already uses for voicemail titles and tags.

**New flags** — must land in the `PlatformConfig` interface **and** `DEFAULTS` in the same change, or `putConfig` 400s `unknown key` (`worker/src/routes/config.ts`):

```ts
callRecordingEnabled: false,          // master kill switch, ships OFF
callRecordingIndicatorEnabled: true,  // peer-visible "Recording" pill — §4
callRecordingMinFreeMb: 500,          // numeric → numericKeys; device storage floor
```

Prove each: `ALLOW_PROD=1 scripts/flags.sh set <key>=false` must not 400, and a cache-busted `/api/config` must reflect it.

### 5.2 Client

**Record tile in the call UI.** `_CallTile` (`app/lib/features/avatok/call_screen.dart:1479`) is the only control primitive on the screen, and its own comment calls the three-column geometry load-bearing. The 2×3 grid is **fully occupied** — Speaker/Video/Mute, More/Translate/End. Two options:

- **Third row** (recommended, since an on-demand feature buried in a submenu won't get used): add a row and bump `controlPanelHeight` from `250.0` (`call_screen.dart:688` — the arithmetic is spelled out in the comment there).
- **More sheet** (`_showMoreSheet`, L1413): the `Row` is `spaceEvenly` and already renders a conditional third child, so a fourth is a one-widget insert with no layout maths.

The tile is **stateful** — idle / recording (red) / finalizing. `CallTranslateOverlay` (`app/lib/features/translation/call_translate_overlay.dart`, `tile: true`) is the established precedent for a control that owns its own per-session state and builds its own copy of the `_CallTile` geometry.

**Inbox card.** New `kind: 'call_recording'` accepted in `InboxCard.fromRow` (`app/lib/features/avadial/inbox/inbox_api.dart`); the `'callrec_'` prefix added to **both** `InboxApi._kPrefixes` **and** the `SyncHub` filter (`inbox_list_screen.dart:122`); add to `AppDb.kCountableKinds` if it should badge. Render alongside `buildCampaignCard`, the established precedent for a visually distinct card type.

Card: overlapping avatar pair → title (or `Call with <peer>` when untitled) → small green `Call between {peer} and you` → date · time · duration · size.

**Detail screen:** player (reuse `_VoicemailCard`'s `AudioPlaybackService` integration), editable title and description, date/time/duration/size, **share** (`Share.shareXFiles`, `inbox_thread_screen.dart:887` — the OS chooser covers WhatsApp and every other social target), download, delete.

**New drift table**, `schemaVersion` 9 → 10 (`app/lib/core/db.dart`):

```
callRecordings:
  callId TEXT PK, convKey TEXT, peerUid TEXT, peerName TEXT, peerAvatar TEXT,
  direction TEXT, startedAt INT, durationS INT, bytes INT,
  title TEXT, description TEXT,
  blobKey TEXT,          -- local file, MediaService blob
  mediaId TEXT NULL,     -- user_media id once uploaded
  uploadedAt INT NULL
```

Metadata in sqlite, audio bytes as a `MediaService` blob under `getApplicationSupportDirectory()/media/<AccountScope.id>/`. The DB file is already per-account, so scoping is free. Never put multi-megabyte audio in a sqlite BLOB column.

**Device storage floor.** Check free space against `callRecordingMinFreeMb` before arming; if below, don't arm and say why. Watch it during recording; if crossed, finalize cleanly, keep what was captured, notify once.

---

## 6. Billing — the existing storage pool, and what that means

**No per-use charge. Zero new billing code.**

Recordings count toward the per-account storage pool that already exists and runs end to end:

- **Usage** is tracked in D1 (`storage_quota`, summed from `user_media` with dedup by key), recomputed after every upload by `afterRegisterFile()`, and pushed live to the client over the InboxDO socket. **No R2 `list()` is involved.**
- **Charging** is `storageBilling()` (`consumers/src/storage.ts:29`), run by the consumers cron on the 1st of each month: `gbOver = ceil((used − quota)/GB)`, `amount = gbOver × STORAGE_COINS_PER_GB`, spent from WalletDO with `op_id: storage:<uid>:<month>` (idempotent — one charge per month), double-entry ledgered `user:<uid>` → `platform:storage`.
- **Over quota with an empty wallet → `read_only`.** Uploads are refused; **existing files are never deleted.**
- **Rate: 20 tokens/GB/month over a 5 GB free tier.** Unchanged from what is already deployed.

### 6.1 Accepted consequence: recording is free in practice

At mono AAC (~11 MB/hour), **5 GB is roughly 450 hours of recordings**. A one-hour call consumes 0.2% of the free quota. Under the previous per-30-minute model that call earned 2 tokens; under storage billing it earns **zero**, and will for all but a handful of extreme users.

**This is a deliberate owner decision (2026-08-06), not an oversight.** Recording is a retention and utility feature, not a revenue line. Do not "fix" the zero by adding a per-use charge later without an explicit decision — and do not be alarmed by a flat revenue line for this feature.

### 6.2 No retention sweeper

Earlier revisions specified a 90-day R2 sweeper. **Removed.** You do not auto-delete files a user's quota is paying to hold, and the storage rulebook is explicit that over-quota goes read-only and never deletes. Recordings persist until the user deletes them, which also deletes the `user_media` row and frees the quota.

### 6.3 Two pre-existing defects found while specifying this

Neither is caused by this feature; both are worth fixing while someone is in the area, and **neither should be changed without the owner saying so** since they affect live billing:

1. **`STORAGE_FREE_GB` is inconsistent.** `worker/src/storage.ts:33` computes new quota rows at `10` GB; line 145 reports `5` GB to the client; `worker/migrations/marketplace_storage.sql:16` defaults the column to 5 GB. Users are told 5 and may get 10.
2. **`STORAGE_COINS_PER_GB` and `STORAGE_FREE_GB` are not declared in any `wrangler.toml`**, despite CLAUDE.md describing them as env bindings. Both run on hardcoded `|| "20"` / `|| "5"` fallbacks in code. Adding them to `[vars]` would make the price explicit and tunable instead of buried.

---

## 7. Telemetry — the shipped event catalogue (`[CALLREC-TELEM-1]`, 2026-08-06)

This feature ships having **never been compiled or run**, and it will be diagnosed
entirely from PostHog. These events are written to be read *instead of* a debugger.

**Universal properties.** Every client event carries the owner's **email + phone**
automatically (`Analytics._base`); every server event carries them via
`trackUserContact`. Every event carries **`call_id`** and **`rec_id`**, and
`peer_uid` wherever the event has a peer — so either side of a two-sided
interaction retrieves it.

> **`rec_id` = `callrec:<call_id>`.** Byte-identical on the client
> (`CallRecordingStore.recIdFor`), on the Worker (`clientIdFor`) and as the Inbox
> row's `client_id`. **This is the join key**: filter `rec_id = callrec:<id>` and
> one recording's entire lifecycle — arm → capture → finalize → upload → Inbox row
> → playback — replays as a single funnel across client *and* server.

### 7.1 ⭐ READ THIS FIRST: did the microphone tap work?

The near-end mic tap has never fired in this app (§3.1). Three events answer it, in
this order:

| # | Event | The question it answers |
|---|---|---|
| 1 | **`callrec_adapter_probe`** | Did the adapter field resolve and subscribe? |
| 2 | **`callrec_leg_first_sample`** (`leg=near`) | Did audio actually arrive? |
| 3 | **`callrec_leg_silent`** (`leg=near`) | It bound and then never fired. |

**The diagnostic pair:** `callrec_adapter_probe {near_ok: true}` **with no**
`callrec_leg_first_sample {leg: "near"}` = *bound but dead* — the exact silent
failure that produces a plausible file containing only the other person. Neither
event alone can say this; you need both.

- `callrec_adapter_probe` — `ok`, `near_ok`, `far_ok`, `near`, `far`
  (exact resolver tokens: `none` = bound · `adapter_field_null` = R8 stripped it or
  flutter_webrtc renamed it · `method_call_handler_null` · `webrtc_plugin_null` ·
  `exception:<Class>`), `adapter_source` (`engine_bound` = correct ·
  `shared_singleton` = the fallback behind the 2026-08-05 bug ·
  `engine_bound_singleton_mismatch`), **`manufacturer`, `model`, `device_name`,
  `api_level`, `hw_aec`**, `out_rate`, `stereo`.
  The device block is what turns *"it didn't work on his phone"* into *"it doesn't
  work on this SoC family."* `hw_aec=false` is also the §9 pre-APM tell: echo in the
  recording but a clean call correlates with this, not with the mixer.
- `callrec_leg_first_sample` — `leg`, `first_sample_ms` (from arm or last resume),
  **`input_rate`, `input_channels`** (the ADM's own per-leg truth — where a
  pitch-shift complaint is traced to), `out_rate`, `rejected_batches`,
  `adapter_source`.
- `callrec_leg_silent` — `leg`, `adapter_source`, `detail`.
- `callrec_started` — `ok`, `error`, **`failure`** (`near_tap` | `far_tap` |
  `subscribe` | `encoder` — a breakdown dimension, not a string to match on),
  `near_tap_failure`, `direction`, `stereo`.

### 7.2 Was the recording healthy?

- **`callrec_drift`** — one rich row per 5 s. **`leg_delta_ms` is the Phase 1 gate**
  (<40 ms over 30 min). Also `near/far_drift_ms`, `_corrected_ms`, `_gap_ms`
  (leg was behind → silence written), `_stale_ms` (leg was ahead → audio discarded),
  `_dropped_ms` (ring overflow), `_stalls`, `_rate`, `_channels`, `_batches`,
  `_rejected`, `elapsed_ms`, `paused_total_ms`, `paused`.
  *(Renamed from `callrec_drift_corrected`: it fires every 5 s whether or not a
  correction was applied. All numerics are now real ints — they were interpolated
  strings, which silently blocked every average/p95 and made "9" sort above "40".)*
- `callrec_leg_stalled` — `leg`, `gap_ms`, `stall_events`. Both callbacks are
  clock-driven, so a gap is never "nobody spoke"; it is stopped delivery.
- `callrec_leg_resumed` — `leg`, `stalled_ms`, `stall_events`. Without this every
  Bluetooth SCO transition reads as a permanently broken recording.
- `callrec_rate_change` — `leg`, `from`, `to`, `channels`.
- **`callrec_degraded`** — the whole degradation ladder, `reason` ∈ `ring_overflow` |
  `encoder_failed` | `low_storage` | `near_leg_stalled` | `far_leg_stalled` |
  `detached`; plus `free_mb`, `dropped_ms`, `duration_ms`, `bytes`, `pause_count`,
  `paused_total_ms`.
- `callrec_storage_stop` — device-storage refusals only. `stage` = `arm`
  (pre-flight, with `min_free_mb`) or `mid_call` (with `free_mb`).
- `callrec_hold` — `held`, `ok`, `duration_ms`, `pause_count`, `paused_total_ms`.
  Held time is **spliced out** of the file, so this is what answers "why is my
  recording shorter than my call".
- `callrec_native_error` — anything else native raised. Every one of the above also
  raises `Analytics.captureException` so it forms a PostHog Issue.

### 7.3 Did it produce a file?

- **`callrec_finalized`** (client — the file exists on disk) — `duration_s`, `bytes`,
  `bytes_per_s`, `direction`, `paused_total_ms`, `pause_count`, `sample_rate`,
  `channels`, `stereo`, and the **closing per-leg summary**: `near/far_started`,
  `_batches`, `_rate`, `_channels`, `_gap_ms`, `_dropped_ms`, `_stalls`,
  `_rejected`. **`near_batches: 0` on a finalized recording is a silent near tap**,
  visible on this one row without joining anything.
  `reason` = `stop` | `recovered` | `ring_overflow` | `encoder_failed` |
  `low_storage` | `near_leg_stalled` | `far_leg_stalled` | `detached`.
- `callrec_recovered` — orphaned ADTS remuxed on launch. `duration_s` is what
  *survived*; `had_meta` says whether the real call id was recoverable.
- `ui_interaction {name: "callrec_finalize"}` — how long the user waited on the
  remux after tapping stop. Standard helper, not a bespoke `*_ms` event.

### 7.4 Did it reach the server and the Inbox?

- `callrec_upload` (client) — `ok`, `ms`, `bytes`, `transport` (`inline`|`chunked`),
  `retries`, `parts`, `resumed_from`, `dedup`, `source`, `issue`, `http`.
- `callrec_upload_begin` (server) — `bytes`, `parts`, `dedup`, `ok`. A begin with no
  matching finalize is an abandoned large upload — invisible from either alone.
- `callrec_upload_part_failed` (server) — `part_number`, `bytes`, `code`. A cluster
  at part 1 is a dead `upload_id`; a cluster near the end is a client giving up.
- `callrec_quota_blocked` (both sides) — `bytes`, `stage`, `transport`.
- **`callrec_finalized {side: "server"}`** — `transport`, `dedup`, `appended`,
  `conv`, `media_id`, `presigned`, `mime`. **A client finalize with no server
  finalize for the same `rec_id` = a recording that exists only on the phone.**
- **`callrec_inbox_append_failed`** — `conv`, `status`, `bytes`, `media_id`. The
  Inbox row is the record of truth, so this means the bytes are safe in R2 and the
  user will never see them: the worst silent outcome on the server side.

### 7.5 Did the user get it?

- `callrec_playback` — `ok`, `surface` (`inbox_card` | `callrec_detail` | `server`),
  **`source`** (`local` blob | `remote` presign+download | `unavailable` |
  `download_failed` | `error`), `bytes`, `load_ms`. `source=remote` for a recording
  made on *this* phone means the local blob was evicted — a real defect wearing a
  latency costume.
- `callrec_shared` / `callrec_downloaded` — `ok`, `stage` (`load` vs
  `chooser`/`mediastore`), `bytes`, `source`. The OS share chooser does not report
  which app was picked, so no share *target* is claimed.
- `callrec_heard_marked`, `callrec_title_edited` (`source: local|server`,
  `title_len`, `description_len`), `callrec_meta_synced`, `callrec_deleted`
  (`surface`, `ok`, `stage`, `quota_released`, `was_uploaded`),
  `callrec_notif_open`, `cache_event {store: "call_recording"}`.

### 7.6 Consent and controls

- `callrec_consent_shown` → `callrec_consent_accepted` (`persisted`) |
  `callrec_consent_declined` (`dismissed`). All three, so the funnel has a
  denominator; previously only the accept existed, making a decline
  indistinguishable from a dialog that never appeared.
- `callrec_armed`, `callrec_stop_tapped`.
- **`callrec_peer_indicator`** — `dir` (`sent` | `received`), `on`, `forced`,
  `addressed`, `connected`, `changed`. **This is the consent proof.** Delivery of
  the peer's "Recording" indicator used to be purely inferred. Both ends now emit,
  each tagged with its own device's email: matching `dir=sent` on one tester's
  timeline against `dir=received` on the other's, by `call_id`, is what turns the
  consent claim into an observation.
- `call_controls_toggled` (panel collapse) and `call_hold_toggled` (carries
  `recording`) are pre-existing call-screen events and were not duplicated.

### 7.7 Rules that must hold for any event added later

- **No silent `catch {}`.** `Analytics.captureException` (client) /
  `hooks.trackException` (worker).
- **A native signal that matters gets a NAMED event, not only an exception.**
  `$exception` cannot be put in a funnel, and "what fraction of recordings had a
  stalled leg" is a funnel question. Raise both.
- **`waitUntil` every worker emit on an early-return error path** — workerd drops
  unawaited telemetry there. Every emit in `routes/callrec.ts` is inside one.
- **Never emit from an ADM audio callback** (§3.2). Native raises everything from the
  mixer thread or the platform thread; the callbacks copy PCM and return.
- **Send numbers as numbers.** An interpolated `'${x}'` lands in PostHog as a string
  and silently disables every numeric aggregation on it.

---

## 8. Risks, in order

1. **Mixing the two legs** — the near-end callback is unproven in this repo (§3.1), and clock drift between the legs is the one thing that can fail outright. Phase 1 gate.
2. **Real-time isolation** (§3.2) — get this wrong and the feature degrades calls.
3. **The R8 keep rule** (§3.5) — release builds record silence, debug builds work fine.
4. **Crash recovery depends on the ADTS choice** (§3.3) — with a plain `MediaMuxer` file and no segmentation, a process kill loses the entire recording.
5. **Mid-call sample-rate changes** on Bluetooth/route switches (§3.3).
6. **Speakerphone echo doubling** if mono wins the Phase 1 measurement (§3.3).
7. **Upload reliability** for long files on mobile (§5.1).
8. **Play listing text** needs updating for a recording feature.
9. **`pubspec.lock` is stale at posthog_flutter 4.11** while pubspec pins ^5.30.0 — telemetry won't fully land until `flutter pub get` bumps it.

---

## 9. Plan

| Phase | Scope | Risk | Est. |
|---|---|---|---|
| **0** | ToS clause + counsel review (§4). Three flags into `PlatformConfig` + `DEFAULTS` + `numericKeys`, proven via `flags.sh`. R8 keep rule in `postcreate.py`. Read `MethodCallHandlerImpl.java` to confirm the near-end adapter is wired unconditionally (§3.1). | Low | 2–3 d |
| **1** | **Capture spike — hard gate.** Subscribe both ADM callbacks via the engine-scoped binding; align and mix; WAV output; on a real device over a real call, on **both** SFU and P2P transports. Measure drift over 60 minutes **and** measure speakerphone quality mono vs stereo to settle §3.3. **Do the pre-APM check below FIRST.** Ship nothing. | **Med** | **10 d** |
| **2** | Productionise capture: AAC + ADTS-and-remux, on-the-fly resampling, real-time isolation (§3.2), route/Bluetooth handling, device storage floor, foreground-service lifetime, orphan recovery on launch, release-build verification, telemetry. | Med | 8–10 d |
| **3** | Post-call upload via `registerArtifactMedia` (resumable) → `InboxDO /append` → Inbox card → playback → share → delete-with-quota-release. | Low | 5–6 d |
| **4** | Record tile in the call UI (§5.2), recording indicator on both screens, first-use consent dialog, editable title/description, detail screen, settings toggle, storage usage visibility. | Low | 5–6 d |

**≈ 6 weeks, Android only.** Down from rev 10's 8–9 — segmentation, transcription, summarization, Drive and per-use billing all came out; the SFU migration added nothing.

**Phase 1's first task: confirm whether the near-end tap is pre- or post-APM.** In libwebrtc's `WebRtcAudioRecord.java` the `SamplesReadyCallback` appears to fire immediately after `audioRecord.read(...)` — i.e. **before** the buffer reaches the audio processing module. If so, the near leg receives **raw mic PCM with no software AEC, noise suppression, AGC or high-pass** — precisely the processing `avaMicConstraints()` (`app/lib/core/audio_tuning.dart:9-20`) enables for the call itself. Consequence: on speakerphone, on a device without hardware AEC, the near leg carries un-cancelled far-end leakage, and mono summing comb-filters it — **the call sounds clean while the recording sounds badly echoed, and only the recording is affected.** §3.3 currently assumes "WebRTC AEC mitigates but does not eliminate"; if the tap is pre-APM there is no mitigation at all, and that argues **for** stereo as the default rather than against it. Verify this before running the mono-vs-stereo measurement — it changes the expected result.

**Interaction with the live call media profile (`[CALL-MEDIA-540P-1]`) — audited 2026-08-06, no conflicts.** RED, in-band FEC, the 40/32/24 kbps Opus ladder and `usedtx=0` are all resolved *below* the tap: the recorder receives post-NetEq PCM, so none of them are visible to it. Mid-call camera-on does not touch the audio track, the ADM or the audio sender parameters. Two things worth carrying forward: **do not enable DTX** (the far leg would record NetEq comfort noise and speech-onset artefacts permanently into the file), and the worst thermal case is **recording during a 540p30 video call on a low-end device**, where software AV1/VP9 encoding competes with the AAC encoder — the degradation ladder protects the call but reports `ring_overflow`, which reads as a bug rather than as throttling.

**Phase 1 is a real stop point.** If the legs cannot be held in sync, the answer is to stop and reconsider, not to push into Phase 2 and hope. Note the fallback is genuinely poor now: server-side SFU recording would silently capture nothing whenever a call drops to P2P (§2.2), so there is no cheap plan B. Find out in week two.

**Test matrix (Phase 2):** 2-hour call across WiFi↔cellular handovers and at least one SFU→P2P fallback; Bluetooth connect/disconnect mid-call; wired headset; speakerphone throughout; earpiece; forced low device storage; force-kill mid-recording with orphan recovery confirmed; camera toggled on and off mid-recording; incoming PSTN call, alarm, screen lock, backgrounding; low battery and thermal throttling.

---

## 10. Handoff notes

**Status: final. No product decisions open.** Work starts at §9 Phase 0.

Three things a reader picking this up cold should know:

1. **This document reversed itself more than once.** Rev 1 recommended Cloudflare SFU capture; revs 2–10 built out an on-device design against a pure-P2P call stack; rev 11 rewrote it after the SFU shipped and the product scope changed. The current text is authoritative — earlier revisions live in git history, not inline.
2. **Two claims in earlier revisions were wrong and are corrected here:** the `sharedSingleton` reflection path (§3.1) had already failed in production before this document recommended it, and the near-end callback was described as proven when nothing in the repo has ever used it.
3. **One thing is deliberately zero.** Recording generates no per-use revenue and almost never triggers a storage charge (§6.1). That is the owner's decision, not a bug.

---

## Sources

- Repo: `worker/src/routes/call_sfu.ts`, `worker/src/do/call_room.ts`, `worker/src/routes/media.ts`, `worker/src/storage.ts`, `worker/src/routes/config.ts`, `worker/src/do/inbox.ts`, `worker/migrations/marketplace_storage.sql`, `consumers/src/storage.ts`, `consumers/src/index.ts`; `app/lib/core/calls/call_session.dart`, `call_sfu_transport.dart`, `app/lib/features/avatok/call_screen.dart`, `app/lib/features/avadial/inbox/*`, `app/lib/core/db.dart`; `app/android/.../calltranslation/CallTranslationAudioPlugin.java`, `.../avatok_call/MainActivity.kt`, `.../avavoiceaudio/AvaVoiceAudioPlugin.kt`; `app/tool/postcreate.py`; flutter_webrtc `0.12.12+hotfix.1` bytecode under `app/build/flutter_webrtc/`
- Commits `2701fd52`, `3e9645ee`, `9ea9d387` (`[CALL-SFU-1/2]`), `5c49e25b` (`[CALL-UI-GRID-1]`), `[CALL-TRANSLATE-BIND-1]`
- Live prod config, cache-busted read 2026-08-06: `callSfuV1: true`, `callSfuAudioOnly: false`
- [Cloudflare Realtime SFU docs](https://developers.cloudflare.com/realtime/sfu/introduction/) and [RealtimeKit](https://blog.cloudflare.com/introducing-cloudflare-realtime-and-realtimekit/) — recording is a RealtimeKit feature, not raw SFU (§2.2)
- [Recording Law — two-party consent states (2026)](https://www.recordinglaw.com/party-two-party-consent-states/) — the 12-state list in §4
- [Engadget — Google bans third-party call recording apps](https://www.engadget.com/google-is-banning-third-party-call-recording-apps-from-the-play-store-093201443.html) (Accessibility-API scope)
