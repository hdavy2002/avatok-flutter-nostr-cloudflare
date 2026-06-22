# Ava Receptionist v2 — Telemetry & Observability Spec

**Status:** Proposal / not yet built
**Date:** 2026-06-22
**Companion to:** `Specs/PROPOSAL-RECEPTIONIST-V2.md` (this replaces and expands its §8).
**Goal:** instrument **every** stage of a receptionist call — latency, blockers, guardrails,
performance, network, call quality — so a single user's issue can be pulled and root-caused in
minutes, by **email or phone**.

---

## 0. Non-negotiables (project rules)

1. **Every event carries the user's email** (and phone when known) so support can filter PostHog
   by a complainant's email/phone and see their whole call history. Server: use
   **`trackUserContact(env, uid, email, phone, …)`** (already stamps `email`/`phone` as event
   props **and** `$set` person properties). Client: `Analytics.capture` already auto-merges
   `email`/`phone`/network/screen via its envelope. **Never** use bare `track()` for a
   receptionist event.
2. **One call = one trace.** `session_id` (the receptionist `sid`) is the **`trace_id`** on every
   client *and* server event, plus the AI Gateway `cf-aig-log-id`. This stitches caller app →
   Worker → ReceptionRoom DO → Gemini into one timeline. **Also stamp `call_id`** on every event
   — it is the join key already used by the live-call (`voice_live_*`) family, so receptionist and
   normal-call timelines for the same physical call line up.
3. **Best-effort.** A telemetry failure never breaks a call (existing `try/catch` contract).
4. **Scrub free text.** Error messages/transcought snippets pass through the existing `_scrub`
   (tokens/secrets/keys removed). **Never** emit DM/transcript plaintext as a property — only
   lengths, counts, hashes, and the scrubbed error string.

---

## 1. The envelope (auto-stamped on every receptionist event)

| Field | Source | Why |
|---|---|---|
| `email`, `phone` | `trackUserContact` / client envelope | pull a user's issues by contact |
| `uid` / `account_id` | auth ctx | person bucket |
| `trace_id` = `session_id` | the call | one-call timeline |
| `role` | `caller` \| `owner` | which side emitted it |
| `app_name` = `receptionist` | const | filter |
| `app_version` / `release` (GIT_SHA) | build | tie to exact deploy |
| `service_name` / `worker` | hooks | server-truth vs client mirror |
| `net` | `wifi` \| `cell` \| `offline` | correlate quality to network |
| `region` | CF colo / locale | geo issues |
| `model`, `voice`, `language`, `persona_set` | session init | config-correlated failures |
| `via_gateway` | bool | AI Gateway vs direct fallback |
| `aig_id` = `cf-aig-log-id` | DO | join to AI Gateway usage logs |

> Both sides stamp `trace_id = session_id`, so a caller-side `first_audio_ms` and a server-side
> `gemini_connect` line sit on the **same** trace.

---

## 2. Event taxonomy (full call lifecycle)

Naming stays in the existing `ava_recept_*` family. **(EXISTING)** = already emitted in v1; keep
it and add the new props. Everything else is new.

### 2.1 Trigger & routing (the "should Ava answer?" decision)
| Event | Key props | Catches |
|---|---|---|
| `ava_recept_config_checked` | `available`, `mode` (`rings`\|`first_ring`), `reason`, `latency_ms` | config round-trip cost |
| `ava_recept_handoff` | **`activation_mode`** (`rings`\|`first_ring`\|`manual`\|`decline`), `ring_at` (which ring), `status_preset` | **how** Ava took the call |
| `ava_recept_skipped` | `reason` (`not_premium`\|`off`\|`disabled`\|`video_call`\|`no_model_key`) | why Ava *didn't* take it |
| `ava_recept_triggered` **(EXISTING)** | `owner`, `has_phone`, `call_id`, `activation_mode` | takeover started |

> `activation_mode` is also persisted on `receptionist_sessions` so analytics can split latency /
> quality / outcome by **how** the call was handed off (auto-5-rings vs first-ring vs the manual
> Agent button vs decline-to-Ava).

### 2.2 Connection & setup latency (cold-start cost)
| Event | Key props | Catches |
|---|---|---|
| `ava_recept_start_requested` | `latency_ms` (HTTP `/start`) | API latency |
| `ava_recept_ws_connect` | `latency_ms`, `attempt` | client→DO WS setup |
| `ava_recept_gemini_connect` | `latency_ms`, `via_gateway`, `aig_id` | DO→Gemini setup |
| `ava_recept_gemini_connect_failed` | `error_scrubbed`, `via_gateway` | model unreachable |
| `ava_recept_session_started` **(EXISTING)** | `setup_latency_ms` | session live |
| `ava_recept_first_audio_ms` | `ms` (trigger→Ava's first audible word) | **perceived** wait — the headline UX metric |

### 2.3 In-call performance & call quality
| Event | Key props | Catches |
|---|---|---|
| `ava_recept_turn_latency` | `ms` (caller stops → Ava starts), `turn_idx` | conversational lag (p50/p95) |
| `ava_recept_audio_underrun` | `gap_ms`, `queue_depth` | choppy playback |
| `ava_recept_net_quality` | `rtt_ms`, `loss_pct`, `jitter_ms`, `net` | network-driven quality |
| `ava_recept_barge_in` | `route` | full-duplex interrupt worked |
| `ava_recept_mic_paused` | `tail_ms` | half-duplex-on-speaker engaged |
| `ava_recept_audio_route` | `route` (`speaker`\|`earpiece`\|`bt`\|`wired`), `changed` | which path → echo issues |
| `ava_recept_stt_error` **(EXISTING)** | `error_scrubbed` | transcription drop |
| `ava_recept_model_error` **(EXISTING)** | `error_scrubbed`, `code` | Gemini mid-call error |
| `ava_recept_transcription_progress` | `in_chars`, `out_chars` | empty/garbled-transcript debugging (counts only) |

### 2.3a Native audio engine — adopt the proven `voice_live_*` schema (BINDING)

The v2 native full-duplex engine (`PROPOSAL-RECEPTIONIST-V2.md` §3) is the previously-untested
piece. The live-call path already instruments the identical engine; the receptionist **reuses the
same event family verbatim** (same engine → same telemetry → one query covers both). All stitched
by `call_id` + `trace_id`.

| Event | Key props | Catches |
|---|---|---|
| `voice_live_native` (on start) | `aec_available`, **`aec_enabled`**, `ns_available`/`ns_enabled`, `agc_available`/`agc_enabled`, `record_state`, `track_state`, `session_id`, `buffer_size_in`/`buffer_size_out`, `sample_rate_in`/`sample_rate_out` | engine actually initialised the way we think — `aec_enabled:false` is the **smoking gun for "echo not cancelled."** |
| `voice_live_native_event` (runtime) | `kind` (`capture_error`\|`play_error`), `error_scrubbed` | native faults pushed up from the platform layer mid-call |
| `voice_live_native_end` (final counters) | `frames_captured`, `bytes_played`, `capture_errors`, `play_errors` | post-mortem: did capture/playback actually run |

**Throughput counters on `voice_live_end`** (the engine session close), with engine/route/lang
context: `mic_frames`, `mic_bytes`, `ava_chunks`, `ava_bytes`, `echo_suppressed`, plus `native`
(bool), `speaker` (bool), `lang`, `voice`, `voice_live_engine`.

> The receptionist call is a `voice_live` session: it emits the **full live event arc** —
> `dial → token → start → ready → first_audio → turn/bargein → pause/resume →
> ws_closed/error → end`, plus `engine` / `native` / `native_event` / `native_end` / `speaker` /
> `route_change`, and the call screen's `segment` events. The `ava_recept_*` events in §2.1–2.6
> sit **alongside** these (receptionist-specific routing, guardrails, delivery); they do not
> replace them.

#### Failure-mode triage from PostHog alone (no repro needed)
| Symptom | Signature |
|---|---|
| **No mic / Ava heard nothing** | `voice_live_end.mic_frames = 0` (or `mic_bytes = 0`) |
| **Caller heard nothing but Ava did respond** | `ava_chunks > 0` **and** a `track_state` problem or `play_errors > 0` (`voice_live_native_end`) |
| **Echo — Ava answered herself** | `voice_live_native.aec_enabled = false` (and on speaker: check `echo_suppressed` / `mic_paused`) |
| **Which engine actually ran** | `voice_live_engine` / `native` on `voice_live_end` |
| **Capture/playback crashed mid-call** | `voice_live_native_event` with `capture_error` / `play_error` + `error_scrubbed` |

### 2.4 Guardrails & safety
| Event | Key props | Catches |
|---|---|---|
| `ava_recept_guardrail_hit` | `type` (`prompt_injection`\|`illegal`\|`adult`\|`impersonation_attempt`\|`out_of_scope`), `action` (`refused`\|`deflected`) | abuse / jailbreak attempts |
| `ava_recept_recording_disclosed` | `region`, `two_party` | consent compliance |
| `ava_recept_consent_declined` | `fallback` (`text_only`) | caller refused recording |
| `ava_recept_softcap` **(EXISTING)** | `at_ms` | 1:20 wrap nudge fired |
| `ava_recept_hardcap` **(EXISTING)** | `at_ms` | 2:00 force-cut |
| `ava_recept_premium_block` | `uid` | gate hit |
| `ava_recept_killswitch_block` | — | `receptionistEnabled` off mid-flow |

### 2.5 Wrap-up & delivery
| Event | Key props | Catches |
|---|---|---|
| `ava_recept_session_ended` | `cutoff_reason`, `duration_s` | how it ended |
| `ava_recept_summary_generated` | `latency_ms`, `ok`, `urgency` | summarizer health |
| `ava_recept_recording_stored` | `bytes`, `ok`, `latency_ms` | R2 write health |
| `ava_recept_delivered_inthread` | `resolved_contact` (bool), `conv_kind` (`dm`\|`recept_fallback`) | did it reach the real thread |
| `ava_recept_message_posted` **(EXISTING)** | `has_recording`, `has_transcript` | inbox append |
| `ava_recept_push_sent` | `ok` | owner notified |
| `ava_recept_delivery_failed` | `stage` (`summary`\|`r2`\|`inbox`\|`push`), `error_scrubbed` | broken hand-off |
| `ava_recept_owner_played` | `pct_listened` | owner engaged with the voicemail |
| `ava_recept_owner_opened_transcript` | — | owner engagement |

### 2.6 Errors / blockers (catch-all)
| Event | Key props |
|---|---|
| `ava_recept_session_failed` **(EXISTING)** | `reason`, `stage`, `error_scrubbed` |
| `ava_recept_error` | `stage`, `code`, `error_scrubbed`, `fatal` (bool) |

Every error event carries the full envelope (email/phone/trace_id/release/net), so a single
PostHog filter `email = X AND event ~ ava_recept_` returns that user's entire receptionist
history with the failing stage and deploy SHA.

---

## 3. Operational metrics (Analytics Engine via `metric()`)

For dashboards/alerts (cheap, high-volume; complements PostHog events). `metric(env, name,
[doubles], [blobs])`:

| Metric | doubles | blobs |
|---|---|---|
| `recept_trigger` | `[1]` | `[reason]` |
| `recept_connect_latency` | `[gemini_ms, ws_ms]` | `[via_gateway]` |
| `recept_first_audio_latency` | `[ms]` | `[net]` |
| `recept_turn_latency` | `[ms]` | `[turn_idx]` |
| `recept_call` | `[1, duration_s]` | `[cutoff_reason]` |
| `recept_quality` | `[rtt_ms, loss_pct, jitter_ms]` | `[net, route]` |
| `recept_guardrail` | `[1]` | `[type]` |
| `recept_delivery` | `[1]` | `[stage, ok]` |
| `recept_error` | `[1]` | `[stage, code]` |

---

## 4. Performance budgets & alert thresholds

Targets to alert on (PostHog insights / AE queries). Tune after dogfood.

| Signal | Target | Alert |
|---|---|---|
| `/start` API latency | p95 < 400 ms | p95 > 1 s |
| Gemini connect | p95 < 800 ms | p95 > 1.5 s |
| **First audio (perceived)** | p50 < 1.5 s, p95 < 2.5 s | p95 > 4 s |
| Turn latency | p50 < 1.2 s, p95 < 2.5 s | p95 > 3.5 s |
| Audio underruns / call | < 1 | > 3 |
| Hard-cap rate | < 15 % of calls | > 30 % (Ava rambling/looping) |
| Delivery success (msg+push) | > 99 % | < 97 % |
| Session error rate | < 2 % | > 5 % |
| Guardrail hits | monitor | spike = abuse campaign |

Each alert links the offending `release` SHA so a regression points at the deploy.

---

## 5. Dashboards (PostHog saved insights)

1. **Call funnel** — `miss_counted → threshold_reached → triggered → session_started →
   first_audio → session_ended → delivered_inthread → push_sent`. Drop-off pinpoints the broken stage.
2. **Latency distributions** — first-audio, turn-latency, connect, broken down by `net`,
   `via_gateway`, `release`, `region`.
3. **Error breakdown** — `ava_recept_error` / `_failed` by `stage` × `release` × `net`.
4. **Call quality** — rtt/loss/jitter/underruns by `route` (proves the half-duplex/AEC fix works:
   barge-in rate up, underruns down on speaker).
4a. **Native engine health** — `aec_enabled` true-rate by device/OS/`release`; `capture_errors` /
   `play_errors` rate; `mic_frames = 0` rate (dead-mic detector); `echo_suppressed` distribution
   on speaker. This is the dashboard that closes out the "untested native engine" risk.
5. **Guardrails** — `guardrail_hit` by `type` over time.
6. **Support lookup (the key one)** — filter by `email` or `phone` → that user's every receptionist
   event in order, with `cutoff_reason`, failing `stage`, latencies, and `release`.

---

## 6. Support workflow ("a user complains")

1. Filter PostHog: `email = user@x.com AND event ~ ava_recept_` (or by `phone`).
2. Group by `trace_id` (= `session_id`) → each call as a timeline.
3. Read the funnel + first error event's `stage` / `error_scrubbed` / `release`.
4. If a model/usage question: copy `aig_id` → AI Gateway logs for token/upstream-Gemini detail.
5. Cross-check the in-app **diagnostics view** (existing `diag_logs`), which surfaces the same
   `ava_recept_*` lines on-device for that account.

---

## 7. Implementation notes (where each event fires)

- **Client (`receptionist_call.dart`, `call_screen.dart`)** via `Analytics.capture` — trigger,
  ws_connect, first_audio_ms, turn_latency, audio_underrun, net_quality, audio_route, barge_in,
  mic_paused, owner_played. Set `trace_id = session_id` **and `call_id`** on each.
- **Native audio engine (the shared `voice_live_*` plugin)** — emits `voice_live_native` (start),
  `voice_live_native_event` (runtime faults), `voice_live_native_end` (counters), and the
  throughput counters on `voice_live_end`. Already implemented for live calls; the receptionist
  inherits it for free by running on the same engine — just confirm `call_id`/`session_id` are
  passed through when the receptionist opens the engine.
- **Server routes (`receptionist.ts`)** via `trackUserContact` — config_checked, skipped,
  start_requested, miss_counted, threshold_reached, premium/killswitch blocks. Resolve the
  owner's + caller's email/phone before emitting.
- **DO (`reception_room.ts`)** via `trackUserContact` + `metric` — gemini_connect(+failed),
  session_started, model/stt errors, softcap/hardcap, guardrail_hit, summary_generated,
  recording_stored, delivered_inthread, push_sent, delivery_failed, session_ended/failed.
  Stamp `aig_id` from `cf-aig-log-id` and `trace_id = sid`.
- **Email/phone resolution:** the DO knows `owner_uid` + `caller_phone`; look up the owner's email
  (and caller's, if a known user) once at session start and pass to `trackUserContact` for every
  emitted event so even mid-call errors carry contact info — this is the "the 502 had no email"
  fix applied to the receptionist.

---

## 8. Privacy

- Only **counts, lengths, hashes, latencies, scrubbed errors** as properties — never transcript
  or DM plaintext.
- `caller_key` is **hashed** in events (`caller_key_hash`) unless it's the owner's own number.
- Honour **AvaBrain consent** — telemetry is operational only; it never feeds private transcript
  content into the brain pipeline (`brainFact` stays public/platform facts only).
- Email/phone on events is the **account contact** for support retrieval (existing product
  decision), not third-party PII.

---

## 9. TL;DR

Instrument the whole call as one trace (`trace_id = session_id`, joined by `call_id`), emit
`ava_recept_*` events at every stage — trigger, connect, first-audio, per-turn latency,
network/quality, guardrails, cutoff, delivery — each through **`trackUserContact`** so **email +
phone ride on every event** (plus `metric()` points for dashboards). Reuse the proven
**`voice_live_*` native-engine schema verbatim** (`voice_live_native` / `_event` / `_end` +
`voice_live_end` throughput counters) so the once-untested AEC engine is now fully diagnosable —
`aec_enabled:false` = echo bug, `mic_frames:0` = dead mic, `ava_chunks>0` + `play_errors` =
playback bug, all from PostHog with no repro. Add latency budgets + `release`-tagged alerts, seven
saved dashboards (incl. native-engine health), and a one-filter support lookup by email/phone.
Result: any user's complaint resolves to the exact failing stage, latency, network, device, and
deploy in minutes.
