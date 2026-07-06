# Liveness V3 — Voice-Guided Liveness Check (PLAN DRAFT)

Date: 2026-07-06 · Status: DRAFT for owner review · Owner decision (FINAL, 2026-07-06): **ON-DEVICE guidance + pre-recorded Ava voice, permanently. NO Gemini Live** (~$300k–1.5M/month at 1M/day — rejected).

Goal: production-ready liveness verification at **1,000,000 checks/day**, with Ava's voice guiding the user via **on-device ML Kit detection + pre-recorded voice lines**, **head-and-neck video capture with randomized challenges** (owner decision 2026-07-06: no full-body), and **AWS Rekognition** doing the actual checking.

Relationship to frozen specs: `Specs/TRUST-ENGINE-ARCH.md` v1.1 stays canonical. Its hard rule is unchanged: **LLMs never make pass/fail decisions**. Coaching is pure on-device rules (no LLM anywhere in the flow) — Rekognition + deterministic rules decide. This draft is the capture/UX/scale layer that feeds the Trust Engine.

## 0-A. Constitutional & Guardian alignment (added 2026-07-06 after consulting the Engineering Bible)

Per `ENGINEERING-CONSTITUTION.md` (frozen keystone) and `GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md`:

- **Platform placement**: liveness belongs to the **Trust Platform** ("Can this entity be trusted?"). It is a capability of the frozen Trust Engine, not its own architecture. Per the freeze rule (§4), this draft's final form is an **Appendix to TRUST-ENGINE-ARCH.md** — no new architecture doc.
- **One generic entrypoint, many callers.** Liveness is invoked ONLY through the Trust Engine's Policy Engine, with a recorded `requester` context: `onboarding`, `marketplace_publish`, `guardian_require_verification`, `periodic_recheck`. Guardian's "Require Verification" button (Sentinel T1/U1) is just one caller — liveness has NO Guardian-specific code path, so it cannot break Guardian.
- **Strict boundary — liveness never touches Guardian state.** The flow's only output is an append-only verdict event into the Trust Engine. The Trust Engine folds it into `identity_confidence` TrustEvidence and the L0–L3 ladder; Guardian reads only the ladder/badge (✓ Verified Human). Liveness never writes evidence buckets, never talks to SentinelDO or mem0, never emits numbers from an LLM (there is no LLM anywhere in it).
- **Universal laws applied**: verdicts are immutable append-only operations (law 3/4), with `ruleset_version` + `provider_version` on every verdict so "why did this pass in March?" is answerable (Sentinel provenance checklist); result state reconstructs from the event log (law 5); telemetry contract is part of this spec, not an afterthought (law 8); per-account scoping on all local caches — voice packs are device-wide public assets, everything else scoped (law 9); English coaching works offline (law 10).
- **Server owns truth**: the client never declares itself verified. On-device ML Kit only coaches framing; PASS/REVIEW/FAIL is computed server-side from the uploaded video (law 2).

## 0-B. Anti-spoof hardening (goal: a real, live human — nobody fools the AI)

Layered so each cheap layer kills a class of attack before the expensive one runs:

1. **Randomized challenge order** — the flow shuffles which actions are asked and in what order (blink / turn left / turn right / step back / walk in / raise a hand), chosen server-side per session (nonce). A pre-recorded video of someone else's session cannot match the sequence.
2. **Approach geometry (phone-toward-face)** — a photo, screen replay, or paper mask can't produce a physically consistent approach: face size must grow smoothly, landmarks must move plausibly, background parallax must change as the phone comes closer. Deterministic math on ML Kit landmarks + server frame checks.
3. **Screen-replay / print detection** — Rekognition quality signals + moiré/glare/border heuristics on frames (a phone playing a video in front of the camera shows bezels, reflections, flat depth).
4. **Face consistency** — CompareFaces across all sampled frames (same person throughout) AND against the account's existing proof (no stand-ins).
5. **Exactly one person** — face/person detection on every sampled frame; a second face or person = automatic REVIEW.
6. **Device attestation** — Play Integrity / App Attest token required with the upload; blocks emulators, rooted replay rigs, and injected camera feeds at the API door.
7. **Replay/dedup** — perceptual frame hashes stored per verdict; a re-submitted or shared video collides and auto-fails.
8. **Rate limiting** — max attempts per account/device/day (Trust Engine fast-fail lane); repeated failures escalate to REVIEW with cooldown, so brute-forcing the checks is uneconomical.
9. **Audit sampling** — 1% of passes to human review, feeding ruleset tuning; deepfake countermeasures evolve by versioned ruleset updates, never silent changes.

---

## 0-C. AI-avatar & second-phone defense layer (2026-07-06)

Added after an owner-ratified security review of the "someone points a second phone playing an AI avatar / a deepfake video / an injected virtual-camera feed at the front camera" threat. Server-side implementation: `worker/src/lib/liveness_avatar_defense.ts` (new module) wired into `runLivenessV3Checks` (`worker/src/routes/liveness_v3.ts`); ruleset stamp bumped **`LIVENESS_RULESET_V3_0` → `LIVENESS_RULESET_V3_1`**; additive migration `worker/migrations/liveness_v3_1_avatar_defense.sql` (does NOT edit the committed `liveness_v3.sql`).

### Design philosophy (obey strictly — this is the whole point of the layer)

- **Suspicion SIGNALS accumulate; no single display/forensic heuristic is a standalone pass/fail rule.** A high combined score → **REVIEW** (or policy escalation), **NEVER an automatic FAIL**. This is the Trust Engine breaker rule applied to anti-spoof: we do not FAIL a real user on a fragile forensic guess.
- **Extractors produce NUMBERS; versioned weights/thresholds combine them.** Recalibrating detection = editing `DISPLAY_WEIGHTS_V1` (and the threshold constants) — never rewriting the architecture. The scoring framework exists and combines *whatever signals are present*; signals we cannot compute yet return `null` and are documented as extractor TODOs.
- **Deterministic only. No LLM anywhere** (Trust Engine invariant preserved).
- **Rejected as fragile (do NOT build):** PRNU sensor fingerprinting, rolling-shutter analysis, frequency-domain / FFT forensics (plan §4-A Tier C — forensic-grade in papers, operationally false-positive-prone).

### Shared client↔server contract

**1. Session response gains `active_checks`** (server-randomized per session, persisted in `liveness_v3_sessions.active_checks`):

```
active_checks: {
  flash_sequence: [{ color: "white"|"red"|"blue", t_offset_ms, duration_ms }],  // 2–4 flashes, random colors/timings within the face stage
  vibrate: { t_offset_ms, duration_ms } | null,
  challenge_gaps_ms: [ /* random 700–1900 per challenge */ ]
}
```

**2. Verify POST body gains optional `capture_meta`** (stored with the session; size-capped ~32KB — an oversize payload is rejected politely with 413 `capture_meta_too_large`, and verify still runs without it, degrading the defense scores to `null`):

```
capture_meta: {
  sensor_timeline: [{ t, ax, ay, az, gx?, gy?, gz? }],   // downsampled ≤50 samples
  luma_timeline:   [{ t, luma }],                        // mean frame luminance ≤60 samples
  flash_events:    [{ color, t_actual_ms }],
  vibrate_event:   { t_actual_ms } | null,
  integrity: { rooted: bool|null, emulator: bool|null, virtual_camera: bool|null, instrumentation: bool|null, play_integrity: string|null },
  camera:    { model, resolution, fps }
}
```

### The checks (all fold into the verdict as REVIEW-class / informational — never FAIL-class)

1. **Flash-response check** — during each scheduled screen flash (`active_checks.flash_sequence` vs client `flash_events`), the `luma_timeline` should show a correlated brightness RISE with plausible latency (<300ms) then decay: a real face lit by the phone screen brightens. → `flash_correlation_score` 0–100. Missing/degraded data → `null` (contributes to REVIEW escalation only under strict policy, never a FAIL).
2. **Sensor-motion correlation** — during the approach (face bbox growth across sampled frames), `sensor_timeline` should show non-trivial device motion. bbox grows while the accelerometer is flat → `sensor_mismatch` (a static injected feed / propped second phone). → `sensor_correlation_score` 0–100 (deterministic accel variance/energy over the growth window vs thresholds).
3. **Display-suspicion score** (weighted, versioned `DISPLAY_WEIGHTS_V1`) — signals + default weights: `horizontal_banding +20`, `moire +15`, `pwm_flicker +20` (periodic 50–240Hz luma oscillation aliasing in `luma_timeline`), `rgb_subpixel +25`, `flat_depth +30`, `display_reflection +10`. Computed from normalized Rekognition frame data (sharpness/brightness dynamics), luma-timeline periodicity, and inter-frame brightness dynamics. **Score ≥ 60 → reason code `DISPLAY_SUSPECTED` → verdict REVIEW (never FAIL).**
4. **Camera-path integrity** — from `capture_meta.integrity`: `rooted`/`emulator`/`virtual_camera`/`instrumentation` true → reason code `CAMERA_PATH_COMPROMISED` → REVIEW + a `policy_escalation` flag (the Policy Engine/Trust Engine decides what escalation means). `play_integrity` string recorded verbatim on the verdict for future enforcement.
5. **Timing consistency** — flash/vibrate actual-vs-scheduled offsets that are implausibly instant (<200ms reaction) or exactly machine-uniform → `timing_anomaly` → reason code `TIMING_ANOMALY` into the suspicion pool.
6. **Device-binding evidence** — at verify time compare device context (`capture_meta.camera.model`) + IP country against the account's last verdict row; new device + new country within a short (7-day) window → reason code `DEVICE_CONTEXT_CHANGED` (**informational only** — rides on the verdict + telemetry; the Trust Engine consumes it later; it does **not** block or change the verdict).

### New reason codes (`liveness_rules_v3.ts`) — all REVIEW-class or informational, none FAIL-class

`DISPLAY_SUSPECTED`, `FLASH_MISMATCH`, `SENSOR_MISMATCH`, `CAMERA_PATH_COMPROMISED`, `TIMING_ANOMALY`, `DEVICE_CONTEXT_CHANGED`.

### Verdict row + telemetry

New verdict columns (migration): `display_suspicion_score`, `flash_correlation_score`, `sensor_correlation_score`, `display_signals` (per-signal weighted breakdown), `camera_path` (integrity summary + stashed device/country context), `timing_anomaly`, `policy_escalation`, `device_context_changed`, `capture_meta` (≤32KB). The `liveness_verdict` PostHog event is extended with the three scores, the integrity summary, `defense_codes`, and `ruleset_version=LIVENESS_RULESET_V3_1`. New events (email/phone-stamped): `liveness_active_check` `{check: flash|vibrate, scheduled, actual, correlation_score}`, `liveness_display_signal` `{signal, value, weight, score_total}`, `liveness_camera_path` `{rooted, emulator, virtual_camera, instrumentation, play_integrity}`, `liveness_device_context` `{changed, new_country, new_device}`.

### Priority table (cost-effectiveness — what actually stops injection)

| Priority | Defense | Why |
|---|---|---|
| **Top** | Play Integrity / App Attest + camera-path integrity (rooted/emulator/virtual-camera/instrumentation) | Blocks injected feeds at the API door; one hard flag beats any pixel analysis |
| **Top** | Device reputation / cross-account correlation | One device verifying 80 accounts beats any image forensic (Sentinel evidence buckets) |
| High | Sensor-motion vs bbox-growth correlation | A propped second phone / static feed doesn't move when the "approach" happens |
| High | Randomized active checks (flash sequence, vibrate, timing) + flash-response luma correlation | A pre-rendered avatar can't react to a per-session random screen-flash schedule |
| Medium | Weighted display-suspicion signals (banding/moiré/PWM/sub-pixel/flat-depth/reflection) | Accumulate; combined ≥60 → REVIEW; individually weak, never decisive |
| **Rejected** | PRNU sensor fingerprinting, rolling-shutter, FFT forensics | Fragile, false-positive-prone — explicitly not built |

### Extractor TODOs (return `null` today; the weighted framework already combines everything present)

- `horizontal_banding` — per-pixel scan-line banding extractor over decoded frames (needs the frame pipeline).
- `moire` — screen pixel-grid interference detector (grid-domain, **FFT-free** per the rejected-forensics rule).
- `rgb_subpixel` — RGB sub-pixel structure detector on a high-res face crop (needs the frame pipeline).

The three computed-today display signals are `flat_depth` (from `flat_suspect` fraction + low inter-frame brightness spread), `pwm_flicker` (luma-timeline oscillation ratio), and `display_reflection` (extreme-brightness outlier proxy).

### Interim frame path (client-supplied frames — 2026-07-06)

Cloudflare Workers cannot decode H.264/MP4 in-process, and the long-term server-side `MEDIA_EXTRACT` service binding **does not exist yet**. Consequence: every verify hit `extractFrames()` → `media_extract_unbound` → `EXTRACTION_FAILED` → `REVIEW`, so **no PASS was ever producible**. Interim fix: the **client** captures still JPEG frames from the same ML Kit camera stream the coach already decodes, at the session's server-designated `capture_offsets` (fractions of the face stage), and uploads them in the verify body.

- **Contract.** Verify body gains `frames: [{t_offset_ms:int, jpeg_b64:string}]`. Caps: **≤6 frames**, **≤200 KB each**, **<~1 MB total** (base64), each JPEG **≤640 px** long edge, **quality ~80**. Encoding is a pure-Dart YUV/NV21/BGRA → RGB → JPEG in `app/lib/features/identity/liveness_v3/frame_capture.dart` (no `takePicture`, so it never interrupts the active video recording). The video clip is still uploaded to R2 as before; the video becomes optional when frames are present.
- **Server behaviour** (`worker/src/routes/liveness_v3.ts`, `runLivenessV3Checks` §3a). If `frames[]` is present it is the frame set and **MEDIA_EXTRACT is skipped**; if absent, the existing extractor path runs unchanged (`extractFrames` + its TODO stay intact as the **long-term hardened path**). Verdicts carry `frame_source` ∈ {`client`, `server_extract`, `none`} in the `liveness_v3_verdicts` row (additive migration `liveness_v3_2_frame_source.sql`) and on every `liveness_verify_start` / `liveness_verdict` / `liveness_frames_uploaded` telemetry event.
- **Security — this is an interim trust tradeoff.** Client frames are **attacker-controllable pre-attestation** (the client can send any JPEGs). `frame_source:"client"` is load-bearing for fraud analytics: PASS rates must be segmentable by provenance. Mitigations already in place: **per-frame content-hash dedupe** (a set of byte-identical stills = one image copied N times = replay/2D tell; collapsed, and <2 unique frames → `EXTRACTION_FAILED`/REVIEW), **CompareFaces consistency** across frames + vs the account's existing proof, the **avatar-defense display/timing/sensor/integrity signals**, and the replay content-hash (hashes the frame set when no video is present). **Future hardening:** Play Integrity attestation enforcement, and cutting back to server-side `MEDIA_EXTRACT` decode once the binding ships (at which point client frames can be demoted to a corroborating signal or dropped).

---

## 0. Why the current screen is dead (root causes — already confirmed via Graphiti/memory)

| Symptom | Root cause | Fix owner |
|---|---|---|
| Phone number entered, no OTP asked | Firebase **Phone provider DISABLED** on `avatok-e19ef` (`operation-not-allowed`). Client silently falls through to camera stage. | **Owner**: Firebase console → Authentication → Sign-in method → enable Phone |
| Camera screen inert, face never detected | Device is on the **old build** — Liveness V2 client (LIVE-UI-3/4) was never shipped (manual-build-only policy; build not run). Server side is deployed and waiting. | **Owner**: run `android.yml` manually |
| Server-side face check would 503 anyway | avatok-api has **no AWS secrets** (`aws_unconfigured`) | **Owner**: provide AWS creds → `wrangler secret put` |

P0 rule from this incident: **the client must never show a silent dead screen.** Every stage gets a watchdog — if nothing progresses in 10s, show a plain-English error + retry/skip, and fire a telemetry event.

---

## 1. New capture flow (what the user experiences)

One continuous session, Ava talking the whole way. **How coaching works**: Google ML Kit face detection + pose detection run locally on the phone (free, offline, ~30 fps). Deterministic rules map detection state → one of ~15 pre-recorded Ava voice clips (face too small → "come closer"; no feet in frame → "step back so I can see all of you"; framed and stable 2s → "perfect, hold still" + start recording). Zero per-check cost, zero latency, works with no signal.

### Voice language packs (owner decision 2026-07-06)

- **English is default and ships inside the APK** — a check always works out of the box, even offline.
- **Post-install background download**: after first launch/installation completes, the app quietly downloads the language pack for the device locale (~1 MB: 15 clips) from R2 via the CDN and caches it on-device (per-account cache pipeline; packs are public assets so cache device-wide).
- **Packs generated once**: one nice female voice via multilingual TTS (same voice = same "Ava" in every language), 15 phrases × N launch languages. One-time cost, a few dollars.
- **Language picker in the flow**: the liveness flow OPENS with a language dropdown (pre-selected to device locale). User confirms → coaching + on-screen text switch to that language → flow begins. If the chosen pack isn't cached yet, fetch it during the intro (~1 MB, a second or two); if download fails → system TTS in that language → else English clips + localized on-screen text. Never block the check on a voice pack.
- On-screen strings localize through normal Flutter localization independent of voice.

1. **Language picker** — dropdown pre-selected to device locale; user confirms. Voice + text switch to that language (see Voice language packs above).
2. **Phone + OTP** — user enters number, gets SMS code (works once Firebase provider is on). Fast-fail lane: no OTP pass → no camera ever opens.
3. **Ava intro** — "Hi, I'm Ava. I'll guide you — please prop your phone up so I can see all of you."
4. **Face + neck stage (owner decision 2026-07-06: head-and-neck only, NO full-body)** — face fills the randomized overlay; Ava runs randomized challenges: "come a bit closer… blink… turn left… look up." User brings the phone closer mid-stage so face-growth geometry checks still run. Continuous recording throughout.
5. **Done** — "That's it! I'm checking now — you'll get a green tick in a minute." Upload happens in the background; user is NOT held hostage on the screen.

The coaching layer emits structured guidance events only (framing OK, body visible, face visible) — these are hints for telemetry, never verdicts.

Privacy/consent: explicit consent screen before camera (face/neck video, what it's used for, retention). Clips auto-delete per §4-A retention (pass 24h / fail 7d / appeal open); deleted immediately on account close — matches existing copy.

## 2. Verification (LLM-free, Rekognition)

The recorded video is verified **asynchronously** server-side via the existing `liveness-verify` queue:

1. **Frame extraction** — sample ~6 frames across the face/neck stage at randomized offsets (early / mid-approach / close-up, covering the challenge moments).
2. **Cheap pre-checks first (cost staircase)** — Workers AI / heuristics: is there a face at all, blur check, brightness. Garbage fails free, before we pay AWS.
3. **Rekognition image APIs** (owner already rejected the paid Face Liveness streaming product — we use the ~$1/1000-image APIs):
   - `DetectFaces` — real face present, eyes open, pose plausible, quality.
   - `CompareFaces` — face frames match each other AND match the account's existing selfie/proof.
   - `DetectLabels` / person detection on sampled frames — exactly one person, no phone-showing-a-photo in frame.
   - `DetectModerationLabels` — flag inappropriate content in the clip.
4. **Motion consistency** — face grows across the approach frames in a physically plausible way as the phone comes closer (deterministic math, no LLM).
5. **Policy engine decides** — PASS / REVIEW / FAIL per Trust Engine rules. Quota breaker unchanged: Rekognition 429 → Workers AI fallback → REVIEW, **never FAIL** on our infrastructure problems.
6. **Result push** — verdict written to D1 (`identity_proofs`, invalidate level cache), pushed to device; green tick appears via existing `/api/identity/level` wiring.

## 3. Scale plan — 1M checks/day

1M/day ≈ 12/sec average, plan for **100/sec peak**.

- **Coaching scales for free**: all guidance is on-device, so 1M/day of coaching costs $0 and adds zero server load. No Google quota, no coaching outage mode — the coach ships inside the APK.
- **Upload path**: client → presigned R2 upload (never through the Worker body), queue message with R2 key. Video capped ~15 MB (720p, ~20s).
- **Verify workers**: queue consumers scale horizontally; frame extraction in a Cloudflare Container/Workers; Rekognition default quota is ~5–50 TPS per API — **needs AWS service-quota raise to ~100 TPS** (6 frames × several calls per check).
- **Storage lifecycle**: R2 rule deletes clips at 30 days; verdict + frame hashes kept, raw video not.
- **Cost at 1M/day (rough)**: Rekognition ~6M images ≈ $6k/day; R2 ~15 TB/day transient (30-day lifecycle); Workers/queue small; coaching $0. **Total ballpark ~$6k–8k/day** (vs $16k–56k/day with Gemini Live — savings ~$300k–1.5M/month, the reason Gemini was dropped).
- **Backpressure**: if queue depth passes threshold, new checks queue with honest ETA in-app ("high demand — result in ~10 min"), never a dead screen.

## 4. Telemetry & ops (PostHog) — aligned with GUARDIAN-TELEMETRY-SPEC / Sentinel O1

All events carry user email (+phone when available), `session_id`, `requester` (who invoked the check — onboarding / marketplace / guardian_require_verification), `ruleset_version`, `app_build`, `language`.

- Flow: `liveness_flow_start` (requester, language chosen), `liveness_stage_start/complete/fail` (stage, fail_reason, ms), `liveness_coach_hint` (which voice line fired — where users struggle), `liveness_pack_download` (lang, ms, ok), watchdog `liveness_dead_screen` (10s inactivity — the bug that started all this).
- Capture quality: `liveness_capture_metrics` (blur score, brightness, face-frame ratio, retries).
- Verify: `liveness_upload` (bytes, ms), `liveness_verify_start/verdict` (pass/review/fail, per-rule pass map, provider, provider_version, cost_usd, queue_wait_ms), `liveness_spoof_signal` (which anti-spoof layer fired — screen_replay / dedup_hash / attestation_fail / multi_person / sequence_mismatch).
- Guardian hand-off: `guardian_verification_requested` → `liveness_flow_start(requester=guardian)` → `liveness_verdict` → `guardian_verification_resolved` (badge granted or not) — a joinable funnel so Guardian's Require-Verification loop is measurable end to end.
- Dashboards: stage funnel + drop-off, verdict mix by requester, cost/check, hint frequency by language (bad translations show up as struggle), spoof-signal mix, queue depth, dead-screen rate (target 0).
- Audit-sample lane: 1% of passes to human review (V2 pattern), results fed back as ruleset tuning.

## 4-A. ChatGPT design review (2026-07-06, two rounds) — adopted changes

External review scored the architecture 9.5–10/10 on separation of concerns, Guardian integration, and cost; it validated the on-device coaching decision ("Gemini Vision would be financially insane") and the Guardian boundary ("Guardian should never know Rekognition/selfies/scores exist — it just re-evaluates the ladder"). Adopted into this plan:

1. **Policy-driven entrypoint** — callers pass a `policy_id` (`guardian_high_risk`, `marketplace_high_value`, `account_recovery`, `random_audit`, `accessibility_*` …); each policy defines required stages, attempt limits, freshness, and confidence needed. Liveness never knows WHY it was called.
2. **Provider normalization layer** — Rekognition output is normalized to `{face_found, face_count, sharpness, brightness, spoof_detected, confidence}` before the rules engine; deterministic rules consume only normalized fields (provider swap = adapter change, matches Trust Engine generic-interface rule).
3. **Machine-readable reason codes** on every verdict AND every pass: `FACE_NOT_FOUND / LOW_BRIGHTNESS / MULTIPLE_PEOPLE / FACE_TOO_SMALL / BLUR / PHONE_SCREEN / REPLAY_ATTACK / SEQUENCE_MISMATCH …` — gold for analytics, appeals, provider migration.
4. **Instruction-state model for voice packs** — clips are keyed by instruction enum (`MOVE_CLOSER, MOVE_BACK, FACE_LEFT, LOOK_UP, GOOD, HOLD_STILL, LOW_LIGHT, REMOVE_GLASSES, ONLY_ONE_PERSON, CAMERA_BLOCKED …`), language pack = map(instruction → audio file). No hardcoded filenames.
5. **Freshness decay** — a pass doesn't count forever: `identity_confidence` contribution decays (~180 days), re-verify prompts for marketplace sellers; expiry gets ±30-day randomized jitter at issuance so millions never expire the same day.
6. **R2 retention by verdict** — pass: delete in 24h; fail: 7 days; under appeal: keep until closed. (Tightens our earlier flat 30 days.)
7. **Randomized capture session** — beyond challenge order: randomize overlay shape/position/size ("fit your face in the blue circle, top-left"), countdown timing, and which frames are sampled. Kills universal replay recordings at zero infra cost.

### Injection/deepfake defense — cost-effectiveness ranking (review's honest framing: on a fully compromised device, no deterministic method is perfect; the goal is to make injection expensive)

- **Tier A (do these)**: Play Integrity/App Attest; randomized capture timing; randomized visual challenges; **device reputation** (one device verifying 80 accounts beats any image analysis).
- **Tier B (do these too)**: accelerometer/gyro vs camera-motion correlation during walk-in (bounding box grows but phone "never moved" = flag); camera-capability consistency (claims Pixel, looks like OBS Virtual Camera); frame-timing jitter (real cameras drift, injected streams tick perfectly).
- **Tier C (skip)**: PRNU sensor fingerprinting and rolling-shutter analysis — forensic-grade in papers, operationally false-positive-prone; not worth it.
- Residual risk accepted: sophisticated rooted-device attacks can pass — which is WHY liveness is only one evidence input to the Trust Engine, never the whole story.

### Verification farms (the bigger real-world threat — "a human was there" ≠ "the owner is the human")

Fraud-ring signals to compute in the Trust/Sentinel layer (all deterministic, cheap): device-hash reuse across accounts; IP + ASN clustering (42 accounts, one residential IP, 2 hours); geo hopping (verify in Delhi, login from elsewhere 20 min later); **background-similarity hash** (mask the face, hash the room — farms verify 50 people in one chair); time-of-day batching; device-fingerprint reuse; SIM/number churn on a stable device. These feed Sentinel's existing evidence buckets — no new system needed.

**PostHog properties to capture NOW** (hashed/bucketed, not raw PII) so correlation is possible later: `device_hash, device_model, os_version, app_version, play_integrity_level, camera_id, fps, ip_hash, asn, country/region/colo, gps_grid, network_type, background_hash, frame_hash, face_box_area, motion_score, sensor_motion_score, sensor_camera_correlation, policy_id, requester, reason_code, retry_count, trust_before/after, verification_age` — added to the §4 event schema.

### Capture scope — OWNER DECISION (2026-07-06, FINAL): head-and-neck / face only. NO full-body stage.

Review pushed back hard on full-body: little gain against modern face swaps, big UX cost (elderly, disabled, small rooms). Owner ruled: **capture is face + neck only — full-body and walk-in stages are dropped entirely, all policies.** The approach/distance-change idea survives in miniature: the user leans/moves the phone closer during the face stage, so face-growth geometry checks still apply without anyone standing up. Randomized challenges (blink, turns, look up, overlay position/timing) carry the anti-replay load. Accessibility becomes **first-class policy variants**, not fallbacks: blind (voice-only guidance), limited neck mobility (blink/smile/eyebrows instead of turns), bedridden/wheelchair (works as-is — no standing or walking anywhere in the flow).

### Failure-mode runbook at 1M/day (detection → mitigation)

Poison-pill video: same object crashing decoder repeatedly → quarantine after first failure. Retry storms double-charging AWS: retry-count spike → idempotency key + content-hash dedupe table before any Rekognition call. AWS regional outage: latency/error spike → circuit breaker, queue pause, alternate region (breaker policy already ratified: never FAIL on our problems). R2 egress in audits: thumbnails/derived assets reviewed first, originals fetched only when needed. SMS OTP costs: sends-per-success ratio monitored → rate-limit, session reuse, OTP only when policy demands. Expiry herd: jittered expiries (above). Queue backlog: age-based backpressure with honest in-app ETA. D1 hot partitions: shard by user/verification id, no sequential keys. Oversized/malformed uploads: strict size+duration caps enforced at edge before enqueue. Freshness clock skew: server timestamps only, never device time.

## 5. Rollout

1. P0 fixes (Firebase toggle, AWS secrets, manual build) — makes TODAY's flow work.
2. Build V3 behind `livenessV3Enabled` (KV — remember: patch KV, readers don't fall back to code defaults).
3. Generate the ~15 Ava voice clips once per launch language (multilingual TTS, one female voice); bundle English in the APK, upload other packs to R2.
4. Internal devices → 5% → 25% → 100%.
5. Load test the queue path at 100/sec synthetic before any ramp past 5%.

## 6. Owner action items (blockers)

1. Enable Phone provider in Firebase console (`avatok-e19ef`).
2. Provide AWS access keys (Rekognition) → Worker secrets; later file quota raise (~100 TPS).
3. Voice: any nice female voice (owner: "use any female voice that sounds nice") — engineering picks a multilingual one and pins it.
   Decide launch language list for packs.
4. Run the manual Android build so users get the working client.
