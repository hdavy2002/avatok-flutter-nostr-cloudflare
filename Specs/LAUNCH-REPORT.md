# AvaTOK Launch Readiness — Execution Report

**Generated:** 2026-07-02 · **Author:** AI agent session (Cowork) · **Plan:** `Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02.md`

This report covers a single agent session that executed Phases **0, 1, 13, 2, 5, 4, 6, 3(A), 7, 11, 12, 8, 9** and produced this Phase-10 gate document. Per Phase-10 doctrine, **this phase files/documents — it does not fix.** The owner makes the go/no-go call.

## Ground rules honored this session

- **No pushes.** Every change is a local commit (GitHub Actions builds run on the final merge only).
- **No local builds** (CI-only). All code is written to compile **by inspection**; the one uncertain API (`degradationPreference`) was verified against `webrtc_interface` source before use.
- **No prod KV/secret flips.** Behavior changes ship **dark behind flags** (default OFF), except `safetyScanEnabled` and `driveAutoBackup`, which the plan/owner specified ship ON.
- **Shared tree**: other agents committed concurrently (`AVAAPPS-*`, `BACKUP-RESTORE-*`). All commits used `git_safe_commit.py` with explicit paths.

---

## Per-phase status

Legend: 🟢 done (dark unless noted) · 🟡 partial (gaps documented) · 🔴 human-gated / not started

### 🟢 Phase 0 — Dead-code purge + flag matrix `[P0-CLEAN-3/4]` `e2a87d4` `c00dcdd`
- Wrote `Specs/LAUNCH-FLAG-MATRIX.md` covering 100% of `PlatformConfig`.
- Removed the dead `'AblyException'` string. **Nostr purge deferred**: `pubspec` is `0.1.17+27`, below the `≥0.1.18+27` compat-window threshold — re-run once a build ≥ that ships.

### 🟢 Phase 1 — Call reliability `[P1-CALL-1/2]` `f168796` `989c55d`
- Real `call_push_sent` at the FCM hand-off (`fcm.ts`) with `fcm_message_id/ok/error`.
- `receptTakeoverGuard` (OFF): CallRoom DO ring-ack control-plane + consumer relay + client ack-wait gating.
- Ring floor 12s→20s; `degradationPreference: maintain-resolution` on video senders; explicit `bye` on Ava takeover. ICE candidate-pair forensics were already present.
- **Gate to flip:** `receptTakeoverGuard` after a device test; **redeploy consumers** for the new `CALL_ROOMS` binding.

### 🟡 Phase 13 — Live sync + LTE latency + telemetry doctrine `[P13-LIVE-1/2/3]` `90c5f12` `9c1ee14` `71952bc`
- **A (measurement):** `msg_delivery_latency`, `sync_catchup`, `ttfm_ms`, `hub_connected{connect_ms,cellular}` (+ InboxDO `server_ts`).
- **B (fixes):** resume reconnect if >10s idle; zombie 60s→30s; FCM-triggered sync; PartyKit delivery-hint wired **dark**.
- **C:** `call_setup_ms` on `call_connected`.
- **Deferred:** B7 login fast-path (needs InboxDO newest-page-first sync), **PARTY_ENABLED flip** (24h soak), C9 ICE pre-warm-at-open, C10 audio-first.

### 🟢 Phase 2 — Receptionist 1-min multilingual `[P2-RECEPT-1/2]` `e678162` `b918796`
- Timeline: wrap cue at 40s (once), timed close at 60s (`time_up_wrap`, never mid-word), 90s stall backstop. Relay keeps time.
- Prompt relaxed close + language-adaptive. Telemetry `wrap_cue_injected`, `detected_lang`.

### 🟢 Phase 5 — Agent daily cap `[P5-AGENTLIMIT-1]` `2cfff57`
- Server 429 on the 11th distinct listing/UTC-day (`agentDailyCap`, KV-tunable); client warm sheet + Message-seller. Owner-DM path uncapped.

### 🟡 Phase 4 — Video liveness gate `[P4-LIVENESS-1/2]` `6220307` `34f43bb`
- **Bypass-proof server gate** on create+publish (all kinds), fail-closed, behind `listingLivenessGate` (OFF). Client explainer → existing Rekognition flow.
- **Deferred:** turn/turn/read-phrase challenge pre-roll (Rekognition already covers liveness). **Gate:** one real device liveness run before flip.

### 🟢 Phase 6 — Per-message safety `[P6-SAFETY-1]` `fdad7e0`
- Always-on Nemotron scan on every peer message (fail-open), `safetyScanEnabled` **ON**. Policy: adult sexual content NOT flagged; hate/csae/grooming/trafficking/threat/scam flagged → existing red-bubble path.
- **Deferred:** per-user adult opt-out UI; dedicated `safety_flag` frame + tap-sheet.

### 🟡 Phase 3 — CF-SFU group audio `[P3-SFU-1]` `047d035`
- **Stage A (dark):** speaker hysteresis + 1.5s coalescing + adaptive level reporting + SFU telemetry.
- **🔴 Human-gated:** secrets check (`CALLS_APP_ID/SECRET`), **Stage B** 3-device staging test, **Stage C** prod flip + `conferenceEnabled:false` + **LiveKit deletion** + cancel subscription. Pull-side Opus deferred.

### 🟡 Phase 7 — AvaBrain `[P7-BRAIN-1]` `55dc631`
- **Confirmed the security invariant**: uid-filtered Vectorize retrieval (cross-uid impossible). `ava_memory_context` telemetry added.
- **🔴 Deferred:** guardrail-toggle UI; **`brainEnabled` flip** (privacy-sensitive — enables ingestion; owner decision + ingestion verification first).

### 🟡 Phase 11 — Profile vetting `[P11-PROFILE-1]` `7202dae`
- Server: `profile_complete` on `/api/me`; completeness + real-name plausibility (`gemini-2.5-flash-lite`, fail-closed) behind `profileCompletionGate` (OFF); `brainFact('profile_updated')`.
- **Deferred:** photo Rekognition moderation; client hold-state/scroll UX.

### 🟡 Phase 12 — Receptionist voice + register `[P12-STATUS-1]` `f622193`
- **One canonical voice** (`AVA_VOICE`, client voice ignored/overridden) + **always-on feminine register** in the prompt (owner decisions 5d/5e).
- **Deferred (needs DB migration + client pickers):** status notes + expiry, `answer_lang` default-from-country, and removing the voice picker from the settings *screen*.

### 🟡 Phase 8 — Backup & restore `[P8-BACKUP-1/2]` `1831a72` `a88ed9a`
- **De-premiumed:** every user auto-backs-up to their **own Google Drive** (`driveAutoBackup` ON); premium also mirrors to R2.
- **Batched R2 cold archive** (InboxDO, 100 msgs / 5 min, one PUT/batch, high-water) gated by Worker var `CHAT_ARCHIVE_V2=1`; **retention safety** (prune only ≤ high-water); **`/api/archive/page`** reader.
- **Deferred:** client scroll pager into `chat_thread.dart` (server ready, behind `restoreV2`); one-time backfill of existing history; reactions/receipts as follow-up jsonl lines.
- **⚠️ Two archive systems now coexist** — legacy per-message (`CHAT_ARCHIVE` → `/api/msg/archive`) and new batched (`CHAT_ARCHIVE_V2` → `/api/archive/page`). **Enable only one** (the batched one is cost-correct).

### 🟡 Phase 9 — Polish `[P9-POLISH-1]` `b5301d0`
- Haptics on send / call-connect / listing-publish (reactions already had them).
- **Deferred (needs a build + screenshots):** ~40-screen zine migration, `Image.network`→CF-AVIF audit (10 sites), startup/APK audit, `setState`-storm jank profiling, full error-copy pass.

---

## Flags to flip at launch (diff vs current defaults)

| Flag / var | Now | Launch | Owner action |
|---|---|---|---|
| `receptTakeoverGuard` | OFF | ON | after a call device-test |
| `listingLivenessGate` | OFF | ON | after a device liveness run |
| `profileCompletionGate` | OFF | ON | when the client hold-state UX lands |
| `groupAudioSfuEnabled` + `conferenceEnabled:false` | OFF / ON | ON / OFF | **after Stage B device test** |
| `brainEnabled` | OFF | ON | privacy review + ingestion verification |
| `PARTY_ENABLED` (secret) | unset | `1` | staging → 24h clean `party_*` → prod |
| `CHAT_ARCHIVE_V2` (var) | unset | `1` | staging first; ensure `CHAT_ARCHIVE` legacy lane is OFF |
| `safetyScanEnabled` | ON | ON | — (ships ON) |
| `driveAutoBackup` | ON | ON | — (ships ON) |

Full matrix + per-phase status notes: `Specs/LAUNCH-FLAG-MATRIX.md`.

## Human-in-the-loop gates (the only moments you're required)

1. **Phase 1** — one test call; confirm `call_push_sent` + `call_ring_ack` in PostHog; flip `receptTakeoverGuard`.
2. **Phase 3 Stage B** — 3+ device SFU call in staging; review `sfu_*` events. **Stage C** — approve LiveKit deletion + cancel the LiveKit Cloud subscription.
3. **Phase 4** — one real on-device liveness run; flip `listingLivenessGate`.
4. **Phase 8** — one real wipe-and-restore run.
5. **Phase 13** — a two-phone <1s delivery check; the 24h staging soak before the `PARTY_ENABLED` prod flip.
6. **Phase 12** — one test call in Hindi or Spanish to hear the feminine forms.
7. **Phase 7** — privacy sign-off before `brainEnabled`.

## Owner E2E script (run on 2 phones)

Signup → profile (try **"Midnight Rod"** → rejected; a real name → passes; empty About → blocked when `profileCompletionGate` ON) → contact add → DM text/media/voice-note → reaction (haptic) → group create (3) → group audio call (2 speakers clear, after Stage B) → 1:1 call ring ≥20s → decline → Ava takes a message with a ~40s wrap + clean goodbye by ~60s → **Hindi/Spanish call** (feminine forms) → voicemail appears in thread → marketplace: browse free → attempt listing (**liveness gate 403** when ON) → verify → publish (haptic) → other phone talks to agent → **11th distinct listing → daily-limit sheet** → Message seller → send a grooming-style test message (**red bubble** on recipient; an adult-but-legal message is NOT flagged) → ChatAva "what did <contact> and I agree about X" (sourced answer) → **wipe phone A → login → full restore** (contacts, groups, call log, hot messages; older pages lazily when the client pager lands).

## Cost snapshot (to confirm on live data)

- **OpenRouter** — Nemotron `:free` per message (P6), Claude Sonnet on marketplace negotiation.
- **Gemini** — Live (receptionist), `gemini-2.5-flash-lite` (name vetting P11), embeddings (AvaBrain).
- **AWS Rekognition** — ~$0.02–0.03 per liveness session.
- **Cloudflare** — DO requests/duration; **R2 ops** now bounded by P8 batching (~≤30 ops/user/day target); TURN egress.
- **Confirm CANCELLED:** Ably (already removed) and **LiveKit** (after Stage C).

## Top risks / notes for go/no-go

1. **Unverified builds** — nothing was compiled; the first CI build after merge may surface type errors. Treat the merge build as the real gate.
2. **Two backup archive systems** — enable only `CHAT_ARCHIVE_V2` **or** the legacy `CHAT_ARCHIVE`, never both.
3. **Deferred client UX** across P4/P7/P11/P12/P8/P9 — server gates are bypass-proof, but several user-facing flows (hold states, pickers, scroll pagers, toggles) still need building + a device.
4. **Concurrent-agent history** — interleaved commits from other sessions; verify the merge is coherent.
5. **PostHog "Launch Health" dashboard** (P10 step 3) not created this session — build it from the events this plan added (`call_push_sent`, `call_ring_ack`, `sfu_*`, `safety_scan*`, `liveness_gate_shown`, `agent_daily_limit_hit`, `restore_result`/`drive_auto_backup`, `chat_archive_flush`, `msg_delivery_latency`, `ttfm_ms`).

## Go/no-go

The evidence is per-phase above. The **launch-critical safety/trust gates are in place server-side** (safety scanning ON, liveness gate bypass-proof, agent cap, profile vetting) though several ship dark pending device tests. The **owner makes the call** after the human-in-the-loop gates and a green CI build.
