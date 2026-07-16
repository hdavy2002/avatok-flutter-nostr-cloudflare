# PLAN — Vobiz PSTN Voicemail v1 (+ community spam reports)

> **⛔ SUPERSEDED 2026-07-16 (same day):** owner reversed the voicemail-only scope — AI conversation is back in v1, plus an AvaDial inbox and the Ava Guardian signal-harvesting system. The binding plan is now **`PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md`**. Kept for the Phase 0 details and audit facts referenced there.
**Date:** 2026-07-16 · **Target:** production feature, built dark on staging first · **Research basis:** `Specs/RESEARCH-2026-07-16-vobiz-ai-receptionist-unknown-calls.md` (§5d is the binding scope)

**Scope (owner-confirmed):** v1 is a **voicemail system only** — no AI conversation. Incoming call rings normally with **Accept / Decline / Send to voicemail**. Send-to-voicemail, no-answer, and hidden-caller-ID calls are carrier-forwarded to a shared **Vobiz DID pool** → Cloudflare DO plays "You are being transferred to a voicemail box, please leave a message", records, and drops a playable card into the callee's inbox. Community spam reports (with **category**) ship in the same release. AI receptionist = v2 behind identical plumbing.

**Issue-ID prefix:** `AVA-VMPSTN-*` (one issue per commit, committed via `scripts/git_safe_commit.py` with explicit paths; **no builds triggered** — owner starts builds).

---

## ⚡ 2026-07-16 UPDATE — account live + two doc findings that simplify v1

**Account:** owner purchased DID **+912271264209** (Mumbai, voice-only, ₹500/mo, active, verified via API; auth = `X-Auth-ID`/`X-Auth-Token` headers, base `api.vobiz.ai/api/v1/Account/MA_SLQKWRUQ/`). Credentials live in chat only — store as Worker secrets (`VOBIZ_AUTH_ID`/`VOBIZ_AUTH_TOKEN` via wrangler secret) when building; **never commit them**; consider rotating the token. Zero Applications configured yet. Note: recycled number (released by prior owner 2026-05-31) — expect a few stray calls early on.

**Finding 1 — `ForwardedFrom` webhook parameter ([XML request docs](https://vobiz.ai/docs/xml/request)).** Vobiz's answer webhook includes `ForwardedFrom` — "original forwarding number when the carrier provides it," present only for forwarded calls. This is the Diversion answer from §0a: **owner mapping = `ForwardedFrom` → `phone_hash` lookup as PRIMARY**, expectation pre-registration (AVA-VMPSTN-4) demoted to fallback for carriers that omit it. Phase 0b must record per-carrier whether `ForwardedFrom` arrives.

**Finding 2 — `<Speak>` + `<Record>` XML makes the v1 DO unnecessary.** Vobiz XML natively does the whole voicemail flow: answer webhook returns `<Speak>greeting</Speak><Record maxLength=90 timeout=10 playBeep callbackUrl=…/><Speak>Thank you</Speak><Hangup/>`; Vobiz records and POSTs `RecordStop` with `RecordUrl` + duration to our callback. **v1 needs NO WebSocket audio bridge, NO PstnVoicemailRoom DO, NO μ-law transcode, NO TTS synthesis.** Revised AVA-VMPSTN-3: a plain worker callback route fetches the recording file, stores to R2 under the existing `voicemail/<owner>/<caller>/<sid>.wav` key scheme (convert/keep format as needed — request `fileFormat=wav`), runs Whisper, and posts the existing `kind:"voicemail"` InboxDO card. The WS/DO bridge (original AVA-VMPSTN-3) moves to **v2** where live AI audio actually requires it. (Vobiz also offers `transcriptionType` at extra cost — skip it; Whisper on Workers AI is already paid for.)

**Execution model (owner decision):** plumbing is done by parallel Sonnet subagents (worker lane, Kotlin lane, Flutter lane), orchestrated and then **verified against this plan + research spec** by the lead session before commit. **ON HOLD — owner has more product discussion before any code.**

## Phase 0 — Go/no-go verification (no code merged to main until these pass)

**AVA-VMPSTN-0a — Vobiz account + DID pool + webhook probe.**
Create the Vobiz account, top up, buy 2–3 DIDs (pool grows later with concurrency metrics). Create a voice Application pointing `answer_url`/`hangup_url` at a throwaway staging worker route that just logs payloads. Verify empirically: (1) full answer-webhook payload — does it carry the **forwarded-from number** (Diversion/History-Info)? (2) `<Stream>` XML → WSS handshake against a Worker (Cloudflare must accept Vobiz's WSS upgrade); (3) audio frame shape (base64 μ-law in JSON `media` events, 20 ms/160 bytes); (4) webhook signing/auth options (if none, use a secret in the URL path). Ask Vobiz support about Diversion support in writing.

**AVA-VMPSTN-0b — Carrier device test matrix (THE go/no-go).**
On each tester SIM (Jio, Airtel, VI at minimum; note dual-SIM): set `*67*<DID>#` (forward-on-busy) and `*61*<DID>#` (forward-on-no-answer), then verify (a) `Call.reject()` from `AvaInCallService` actually triggers CFB → call arrives at the Vobiz DID; (b) `**61*<DID>*11*<sec>#` no-answer delay tuning works; (c) `*#67#` status query and `##67#` teardown work; (d) what the caller hears during the divert. If reject routes to carrier voicemail instead of CFB on a major carrier, that carrier gets no-answer-forwarding only (button falls back to "silence + let it time out") — document per carrier.
**Deliverable:** a results table appended to this plan. **Phases 1–3 can be built dark in parallel, but nothing is flag-flipped until 0b passes.**

---

## Phase 1 — Worker: PSTN ingress + voicemail DO (dark)

**AVA-VMPSTN-1 — Flags.**
`worker/src/routes/config.ts`: add to `PlatformConfig` **and** `DEFAULTS` in the same commit (fake-flag rule): `pstnVoicemail: false` (master kill switch, server), `pstnVoicemailRecordSec: 90` (**numeric → add to `numericKeys`**), `spamReportsToServer: false` (Phase 3 gate). Client mirrors in `app/lib/core/remote_config.dart` (`_b`/`_n`). Prove each flips: `scripts/flags.sh set pstnVoicemail=false` on staging must not 400.

**AVA-VMPSTN-2 — `/api/pstn/*` ingress routes** (new `worker/src/routes/pstn.ts`, registered in `index.ts` flat dispatch):
- `POST /api/pstn/answer/<secret>` — Vobiz answer webhook. Validate secret; extract caller E.164, called DID, Diversion number if present. Resolve **owner**: (1) expectation match (see -4), (2) Diversion → `phone_hash` lookup (the §8 lookup in `api.ts:1076` — note the `phone_discoverable` privacy lock; this feature needs its own carve-out or explicit opt-in recorded at forwarding setup, NOT a blanket unlock), (3) unmatched → return `<Hangup>` (v1 takes no orphan messages). On match: mint `sid`, write the DO init blob to KV (mirroring `voicemail_rtc:` token pattern), return `<Stream url="wss://api.avatok.ai/api/pstn/stream?session=<sid>&t=<token>">`.
- `POST /api/pstn/hangup/<secret>` — forward to the DO (finalize safety net) + store Vobiz duration/cost metrics for pool-sizing telemetry.
- WS `GET /api/pstn/stream` — route to `PSTN_VOICEMAIL_ROOM` DO by sid with `continentHint` (copy voicemail WS block, `index.ts:348`).
- **DID pool registry:** D1 table `pstn_dids (did TEXT PK, status, added_ms)` in `DB_META`, migration `worker/migrations/2026-07-16-pstn-voicemail.sql` (also: `pstn_expectations` if not KV, and `pstn_forwarding (uid, sim_slot, carrier, cfb_set, cfnry_set, did, updated_ms)` for setup-state). **DIDs are a separate namespace from AvaTOK virtual numbers** — never fed into `numbering.ts` logic (§8 invariant: a minted AvaTOK number may collide digit-for-digit with a real DID; keep the two worlds apart).

**AVA-VMPSTN-3 — `PstnVoicemailRoom` DO** (new `worker/src/do/pstn_voicemail_room.ts`; wrangler.toml binding + `new_sqlite_classes` migration in **both prod and `[env.staging]`** sections; export from `index.ts`):
Fork of `voicemail_room.ts` with a Vobiz transport adapter — do NOT bend `VoicemailRoom` itself (its PCM16 16k-in/24k-out contract serves the in-app path):
- Parse Vobiz JSON events (`start`/`media`/`stop`); decode base64 → **G.711 μ-law 8 kHz** → PCM16 (≈40-line codec table) → buffer for recording; upsample to 16 kHz before WAV/Whisper (or record 8 kHz WAV and let Whisper cope — decide by quality test).
- Greeting: reuse the Aura-2 TTS + R2 greeting cache (`tts-cache/` pattern), downsample 24 kHz → 8 kHz μ-law, send as `playAudio` in 160-byte/20 ms frames; then tone; then record `pstnVoicemailRecordSec` (90 s) + grace. Send `clearAudio` unused in v1 (no barge-in needed).
- **Finalize = lift, don't rewrite:** extract `postVoicemail` + WAV/Whisper/R2 steps from `voicemail_room.ts` into a shared helper (`worker/src/lib/voicemail_core.ts`) used by both DOs. R2 key stays `voicemail/<owner_uid>/<callerKey>/<sid>.wav` so `voicemailRecording` route authorization works unchanged; InboxDO envelope keeps `kind:"voicemail"` (embed `media_ref` in body — GAP-3) so the **existing client card renders with zero client work**; same `Q_PUSH` notify.
- All entry points 503 unless `pstnVoicemail` is true.

**AVA-VMPSTN-4 — Expectation pre-registration.**
`POST /api/pstn/expect {caller_e164_hash | "anonymous", ts}` → short-TTL KV/DO map keyed by hash → owner uid, matched by `/answer`. **Auth:** native code fires this with the Flutter engine possibly dead → reuse the **HMAC device-token pattern from `routes/missedcall.ts`** (token already provisioned into `missedcall_config.json`; either share it or mint a sibling `pstn_config.json` token). Fire-and-forget from Kotlin, ~100 bytes.

## Phase 2 — Device: third button, hidden-ID routing, forwarding setup (dark)

**AVA-VMPSTN-5 — "Send to voicemail" action.**
- Native: `IncomingCallActivity.kt` button row (~line 603) + new verb in `AvaInCallService.action()` — `"send_voicemail"` = POST `/api/pstn/expect` (HMAC token) **then** `Call.reject(false,null)` (CFB does the rest). Falls back to plain decline if the native flag mirror is off.
- Flutter: `pstn_call_screen.dart` `_actions()` (line 220) — same sequence via `avadial_channel.dart`.
- **Plain Decline is unchanged** (it will *also* divert to voicemail once CFB is set — that's correct behavior; the dedicated button exists for clarity and for pre-registration).

**AVA-VMPSTN-6 — Hidden caller-ID auto-route.**
`AvaCallScreeningService.onScreenCall()`: the `raw.isNullOrEmpty()` branch (line ~102, currently fail-open allow) → when the native flag mirror enables it: fire `/api/pstn/expect {"anonymous"}` and `setDisallowCall(true)+setRejectCall(true)`. This is the ONLY auto-reject in v1; everything else stays label-only. Flag mirror: new `<filesDir>/avadial/pstn_config.json` `{enabled, expect_token, base, did}` written via a new `AvaDialChannel` method from `shell_v2.dart` (follow the `setMissedCallEnabled` pattern, lines 314/387), atomic write via `writeFileAtomic`.

**AVA-VMPSTN-7 — Forwarding setup flow (AvaDial settings).**
New settings screen: explains the feature → dials `*67*<DID>#` and `*61*<DID>#` (per-carrier code table from Phase 0b; `TelephonyManager.sendUssdRequest` or `ACTION_CALL` MMI, per-SIM aware) → verifies via `*#67#` → records state server-side (`pstn_forwarding` table) and locally. Must include a one-tap **disable** (`##67#`, `##61#`) and plain-language notes: replaces carrier voicemail; forwarded leg may be billed by the carrier. Assign the user's pool DID here (round-robin from `pstn_dids`), and record the phone→uid consent for the Diversion lookup carve-out (AVA-VMPSTN-2).

## Phase 3 — Community spam reports with category (dark behind `spamReportsToServer`)

Server (`routes/spam.ts`, D1 tables, scoring) **already exists**; this phase closes the client gap:
**AVA-VMPSTN-8 —** Wire `BlockList.reportSpam()` (`block_list.dart:118`, currently local-only per its own "Phase 2a" comment) to `POST /api/spam/report` — copy the working call from `sms_threads_screen.dart:195`. Add **category** to the payload (`sales | scam | robocall | delivery | other`) and thread it through `spam.ts` → `spam_number_reports` (column exists? if not, add in the -2 migration) → let `classifyReason`/scoring consume the explicit category instead of free-text keywords. Drain path from native (`pending_call_actions.json` → `shell_v2.dart:326`) already reaches `BlockList.reportSpam` — it inherits the server hop for free.
**AVA-VMPSTN-9 —** After-call surfaces: add "Report spam & block" (with category picker) to `AvaMissedCallOverlay.kt` and the after-call screen for non-contact calls (stash `report_spam:<category>` pending action; native UI only, logic drains through -8).
**AVA-VMPSTN-10 —** Close the loop to devices: pull community scores into the on-device snapshot — extend `writeScreeningSnapshot` (`avadial_channel.dart:794`) to merge `/api/spam/lookup` results (or the bloom manifest) for recent-caller numbers. **Fix the hash bug found in audit:** Dart writes keys as `hashE164(normalized)`, but `AvaCallScreeningService.lookup` hashes the raw `tel:` value — normalize to E.164 in Kotlin before hashing or lookups silently miss. Threshold 5–10 distinct reporters → `red` label → existing red banner on the incoming-call UI (already rendered from the verdict stash; zero new UI).
**AVA-VMPSTN-11 —** Schedule `runSpamScoring` (currently manual, `spam.ts:222`) — cron trigger in wrangler.toml (both env sections).

## Phase 4 — Telemetry, rollout, docs

**AVA-VMPSTN-12 — Telemetry (PostHog, per session workflow):** events tagged with the owner's **email** (+ phone) — `pstn_forwarding_setup {carrier, codes_ok}`, `pstn_vm_session {sid, owner_email, caller_hash, match_method: expect|diversion, duration, bytes}`, `pstn_vm_delivered`, `pstn_vm_orphan` (unmatched → hangup; watch this rate), `spam_report {category}`, `vm_card_played`. Two-sided tagging N/A (caller is not a user), but include `caller_hash` so a number's history is pullable.
**Rollout:** flip `pstnVoicemail` + mirrors on **staging**, testers from the 0b matrix run end-to-end (button → Vobiz → card → playback; hidden-ID; no-answer). Watch orphan rate and Vobiz webhook errors. Prod: merge staging→main, deploy with `ALLOW_PROD=1` (committed first — shared-tree rule), apply the D1 migration to prod deliberately, flip prod flags one at a time on owner's word. Update Graphiti after each landed phase.

---

## Decisions locked / open

| Item | State |
| --- | --- |
| v1 = voicemail only, no AI | **Locked** (owner 2026-07-16) |
| Shared DID pool, 2–3 to start | **Locked**; grow on concurrency telemetry |
| Record cap | 90 s (`pstnVoicemailRecordSec`, numeric flag) |
| Spam report categories | **Locked**: sales/scam/robocall/delivery/other |
| Owner mapping | Expectation-first, Diversion-second (pending 0a verification) |
| Unmatched inbound calls | Hangup, no orphan voicemail (revisit in v2) |
| Reject→CFB per carrier | **Open — Phase 0b decides** |
| Vobiz webhook auth | Open — 0a (secret-in-URL fallback) |
| 8 kHz vs upsampled WAV for Whisper | Open — quality test in -3 |

**Explicit non-goals for v1:** AI conversation (Gemini), live patch-through, TRAI 140/160 prefix routing, auto-reject of known-spam (label/banner only), voicemail for orphan calls, iOS (Android-first; iOS has no CallScreening equivalent — carrier forwarding still works but setup UX differs).
