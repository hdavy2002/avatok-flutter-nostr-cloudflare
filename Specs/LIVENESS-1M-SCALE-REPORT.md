# Liveness at 1M checks/day — Current State, Gaps, and Scaling Plan

Date: 2026-07-05 · Author: Claude (audit of worker/src/routes/liveness.ts, liveness_audit.ts, ladder.ts, app/lib/features/identity/liveness_v2/, and the new design at design/Liveliness Check Screens/)

---

## 1. What we have in place today

### 1.1 Backend (Cloudflare Worker — `worker/src/routes/liveness.ts`)

Four endpoints, flag-gated by `platform_config.workersAiLivenessEnabled`:

| Endpoint | What it does |
|---|---|
| `POST /api/id/liveness/start` | Mints a session (KV `liveness:ch:<uid>:<sid>`, 15-min TTL) with a random challenge: 2 gestures from 6 actions + a 3-word phrase from a 16-word pool. Writes `verification_status` (pending) + `verification_attempts` row to D1. |
| `POST /api/id/liveness/upload?session=&part=` | Raw-body upload to R2 `VERIFICATION` bucket at `u/<uid>/liveness/<sid>/`. Parts: `frame<n>`, `extra<n>`, `profile_left/right/up/down`, `clip`. Caps: ≤8 image parts × ≤1.5 MB each; clip 200 KB–16 MB. |
| `POST /api/id/liveness/verify` | Validates session, returns **202 immediately**, runs `runLivenessChecks` in the background via `ctx.waitUntil` (a Queue was planned but never wired — stub at `consumers/src/liveness_verify.ts`). Idempotent via the KV result key. |
| `GET /api/id/liveness/result?session=` | Poll target. Reads KV `liveness:result:<uid>:<sid>` (TTL 1 h). Client polls every 2 s, up to 90 s. |

**The verification pipeline (B1–B9)** runs on Workers AI:

- Vision: `@cf/llava-hf/llava-1.5-7b-hf`, **up to 8 calls per verify** (`MAX_LLAVA_CALLS`): B1 realness ×2 frames, B2 person count, B3 mask, B4 gesture/profile per frame, B7 eyes open.
- Audio: `@cf/openai/whisper` on the **entire clip** (up to 16 MB) for the B6 phrase check (fuzzy 2-of-3 words).
- B5 same-person uses AWS Rekognition `CompareFaces` only when `livenessUseRekognition` flag + AWS creds exist; otherwise skipped-pass.
- Verdict: ALL of B1, B2, B3, B6, B8 + ≥1 B4 gesture + B7 + profile-turn must pass.

**Storage policy (already matches your requirement):** `[LIVE-STORAGE-1]` (2026-07-04) — **fail ⇒ evidence deleted from R2; pass ⇒ evidence moved to retained audit prefix** `liveness/<uid>/<sid>/` (frame0 becomes the AvaIdentity green-tick thumbnail). A `liveness_audit` row (geo/IP/device) is written on both outcomes.

**Retries:** `[LIVE-RETRY-1]` — users may retry until they pass; `MAX_ATTEMPTS_24H = 20` is an abuse/cost guard on *completed* verifies only (abandoned starts don't count). So "unlimited retries" is ~true, capped at 20 completed server verifies per day.

**On pass:** `verification_status`→verified, `kyc_status` upsert (provider `workersai_liveness` or `rekognition+challenges`), `identity_proofs` upsert, verified cache + trust-ladder level cache invalidation (user reaches L2), push notification, PostHog events (`liveness_verify_result`, `id_verified`, etc. — all email-stamped).

### 1.2 App (Flutter — `app/lib/features/identity/liveness_v2/`)

Behind `RemoteConfig.livenessV2Enabled`. Flow: intro → preflight (permissions + FlashFill screen-brightness boost) → **PositionStep** (the screen in your screenshot) → 3-2-1 → video recording starts → HeadCircle (profile turns) → Expression → Phrase → review (Retake/Submit) → upload → verify-poll → pass/fail. Pending-session resume survives app backgrounding.

Crucial point: **the device already runs real ML.** `google_mlkit_face_detection` gates every step on-device — face present, single face, in-frame, level, well-lit, eyes open, head Euler angles for turns, smile probability for expressions. But that signal is *only used for capture gating*; the server re-derives everything with LLaVA and is authoritative.

### 1.3 Why it feels like "it does nothing" (your screenshot)

1. **Layout bug:** the requirement chips (`Well lit`, `Eyes open`) render under the Android system navigation bar — no bottom `SafeArea`/padding in the PositionStep chip `Wrap`. They're informational chips, not buttons, but half-hidden UI reads as broken.
2. **Flag fragility:** the 2026-07-04 outage — KV `platform_config` missing `workersAiLivenessEnabled` silently 503'd every `/start` (`flag_off`). When start fails, the screen sits there doing nothing.
3. **Silent hangs:** if the background `waitUntil` job dies, the client polls 90 s to nothing (there's a `liveness_verify_error` breadcrumb but no user-visible recovery).
4. **Slow uploads:** worst case ~28 MB (8 frames + 16 MB clip) per attempt. On Jio-grade mobile networks that's 30–90 s of apparent freeze.
5. The V2 script UI is functional but joyless — which the new design fixes.

### 1.4 The new design (design/Liveliness Check Screens/Liveness Check.dc.html)

Six animated stages: ① face-in-oval (auto-lock) → ② record clip (2 s, progress bar) → ③ turn head left/right with animated arrows + done pills → ④ read aloud with **language picker** (EN/ES/FR/DE) + listening waveform → ⑤ "Ava is checking" (3 staged checks: face geometry / natural motion / voice) → ⑥ accepted (confetti, Verified sticker, "Create a listing" CTA, delete-mode storage card). Step pips, restart button, footer privacy line.

It maps almost 1:1 onto the existing phases: face-oval→PositionStep, record→recording, turn→HeadCircle, read→Phrase, checking→uploading+verifying (drive the 3 rows off real progress: upload done → "face geometry", poll pending → "motion", result → "voice"), accepted→passed. Two backend deltas it implies: **localized challenge phrases** (server currently issues English-only words; add per-language word pools keyed by the picker) and the expression step is absent in the design (turn-head + phrase only — fewer steps, fewer LLaVA calls: good).

---

## 2. The math at 1,000,000 checks/day

1M completed checks/day ≈ **11.6/s average, 40–60/s peak** (global traffic is lumpy). Per-check today: up to 8 LLaVA calls + 1 Whisper + ~15 R2 ops + ~6 D1 writes + ~12 KV ops + ~28 MB ingress.

| Resource | At 1M/day (current design) | Verdict |
|---|---|---|
| Workers AI — LLaVA | up to **8M vision inferences/day** (~560/s peak) | **Hard blocker.** Way beyond Workers AI account rate limits for vision models; and at even ~$0.001–0.005/call this is **$8k–$40k/day**. This is the whole ballgame. |
| Workers AI — Whisper | 1M clips × ~10 s = ~167k audio-minutes/day @ $0.0005/min ≈ **$83/day** | Fine on cost, but rate limits + 16 MB payloads make it fragile. Trim or replace. |
| Ingress/upload | up to 28 TB/day | Free to CF, but brutal on users' networks. Compress on device. |
| R2 storage (pass-only) | if ~50% pass and we keep ~5–20 MB/pass → **2.5–10 TB/day of permanent growth** ($0.015/GB-mo → +$37–150/mo *added every day*) | Unsustainable. Keep a minimal evidence set. |
| R2 ops | ~15M Class A+B/day | ~$60/day. OK, reducible. |
| KV | ~12M reads (polling) + 2M writes/day | ~$10–15/day. Fine. |
| D1 | ~4–6M writes/day (~70/s peak) on the meta shard | At/над comfort for one D1. Already sharded (`metaDb`/`metaSession`); needs write-slimming or a DO counter for attempts. |
| Worker CPU | `waitUntil` verify jobs at 60/s with multi-second AI awaits | Works, but no backpressure/retry. Move to Queues (stub already exists). |

Pricing basis: Workers AI $0.011/1k neurons; Whisper ≈ $0.0005/audio-minute ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). LLaVA has no published per-call price — **measure real neurons/call in the dashboard before trusting my range**.

**Bottom line: infrastructure (R2/KV/D1/Workers) scales to 1M/day with modest fixes. Server-side LLM inference does not — neither on rate limits nor cost. The fix is to stop using a 7B vision LLM as a YES/NO classifier 8 times per check.**

---

## 3. Recommended architecture — offload to the app, server verifies cheaply

The strategic insight: **the phone already proves the challenge in real time with ML Kit — for free, at zero latency, with unlimited retries.** The server's only irreplaceable jobs are (a) anti-spoof (is this a live camera, not a photo/screen/deepfake) and (b) being the trust anchor. So:

### 3.1 Move to the app (free, faster, removes ~90% of server cost)

1. **Challenge verification becomes device-authoritative** (B2 single-person, B3 occlusion, B4 head turns via Euler angles, B7 eyes-open — all already computed by ML Kit during capture). The app submits a signed challenge report: per-step ML Kit scores + timestamps + the random challenge nonce.
2. **Integrity attestation:** require **Play Integrity** (Android) / **App Attest** (iOS) verdict tokens with each submit. This is what makes device claims trustworthy — blocks emulators, rooted replay rigs, and API-only bots. This is the single most important new component.
3. **Phrase check on-device:** platform speech recognition (on-device `SpeechRecognizer`/`SFSpeechRecognizer`) scores the 2-of-3 words locally; upload only a **3–4 s mono audio snippet (~100 KB)** for sampled server re-checks. Bonus: on-device STT is multilingual, which the new design's language picker needs anyway — Whisper on a 16 MB clip was English-biased and slow.
4. **Client-side compression:** stills → 640 px WebP q75 (~80–150 KB, 10× smaller); clip → 480p H.264, 2–3 s, ~1 MB. Upload drops from ~28 MB to **~1.5 MB/check** (≈1.5 TB/day total). Upload time on poor networks: <5 s instead of 30–90 s — this alone kills most of the "it does nothing" feel.
5. **Unlimited retries stay on-device and cost zero.** The capture gates already prevent submitting garbage; keep retry loops local and only call `/verify` when the device says the take is good. Server sees fewer, better attempts → higher pass rate → less wasted inference. Keep `MAX_ATTEMPTS_24H=20` purely as the abuse guard.

### 3.2 Slim the server to a cheap, tiered anti-spoof check

- **Tier 0 (every check):** attestation verify + session/nonce integrity + challenge-report sanity + clip byte sanity. Zero AI calls. Microseconds.
- **Tier 1 (every check):** ONE anti-spoof pass on the neutral still. Best: a small dedicated PAD model (passive liveness, MiniFASNet-class, runs as ~1–5 ms CPU/tiny-GPU inference — can even ship as a second TFLite check on-device with server hash verification). Acceptable interim: **1× LLaVA realness call** (down from 8).
- **Tier 2 (sampled + risk-triggered, ~5–10%):** full deep audit — extra LLaVA frames, Whisper on the audio snippet, Rekognition `CompareFaces` (and optionally Rekognition Face Liveness at $0.015/check for the riskiest slice only). Triggers: new device, attestation soft-fail, VPN/datacenter IP, >N retries, geo mismatch, listing-fraud signals.

**Resulting cost per check ≈ $0.0005–0.001** (vs $0.01–0.04 naive): roughly **$500–1,000/day at 1M/day**, dominated by the Tier-1 model + Tier-2 sample — and no rate-limit wall, because average LLaVA volume drops from 8M/day to <200k/day.

### 3.3 Server plumbing changes

1. **Queues, not `waitUntil`:** wire the already-stubbed `liveness-verify` queue (`wrangler queues create liveness-verify`, consumer calls the exported `runLivenessChecks`). Gives backpressure, automatic retries, and smooths AI bursts. Dead-letter → `liveness_verify_error`.
2. **Retention diet:** on pass, keep only `neutral.jpg` + one profile still + the 2–3 s clip (~1.2 MB/user, one-time since verification is once per user). Add an R2 lifecycle rule (e.g. move clip to Infrequent Access after 30 days). Wire **account-deletion purge** of `liveness/<uid>/…` — the new design's "erased when you close your account" card promises this; verify the delete-account path actually does it today.
3. **D1 slimming:** move the 24 h attempt counter to KV or a per-user DO (it's read on every start/verify); batch `verification_attempts` result updates; keep only terminal rows.
4. **Result polling:** fine as-is at this scale (KV reads are cheap); optionally return `Retry-After` hints and back off 2 s→5 s after 20 s.
5. **Flag hygiene:** the `flag_off` 503 must render a real "temporarily unavailable" state in the new UI, and KV `platform_config` writes must always merge code defaults (the 2026-07-04 lesson).
6. **Localized phrases:** per-language word pools server-side, `start` accepts `lang`, challenge returns the localized phrase — required by the design's language chips.

---

## 4. Cost/latency comparison (per completed check)

| | Today (all-server LLaVA) | Proposed (device-authoritative + tiered) |
|---|---|---|
| Upload size | up to 28 MB | ~1.5 MB |
| User wait after submit | 10–60 s (often hangs) | 2–5 s typical |
| Server AI calls | up to 8 LLaVA + 1 Whisper | 0–1 small model (+ deep audit on 5–10%) |
| Est. cost/check | $0.01–$0.04 (unmeasured LLaVA neurons) | $0.0005–$0.001 |
| Est. cost @1M/day | $10k–40k/day + rate-limit wall | **~$0.5k–1k/day**, no wall |
| Retries | burn server budget (20/24 h) | free & unlimited on-device |
| R2 growth | 2.5–10 TB/day | ~0.6 TB/day (pass-only, dieted) |

---

## 5. Recommended build order

1. **P0 — Wire the new design** onto the existing V2 orchestrator (screens only, same backend): 6 stages, SafeArea fix, honest error/unavailable states, resume/restart. Ship behind `livenessV2Enabled`.
2. **P0 — Client compression + clip trim** (biggest UX win, zero backend risk).
3. **P1 — Queue for verify** + retention diet + account-deletion purge + localized phrases.
4. **P1 — Play Integrity / App Attest** on submit (server verdict check in `/verify`).
5. **P2 — Device-authoritative challenge report**; server drops to 1 LLaVA call/check.
6. **P2 — Tiered audit sampling + risk engine**; measure LLaVA neuron cost and, if still material, replace Tier-1 with a dedicated PAD model.

Steps 1–2 fix what users see this week. Steps 3–6 are what actually get you to a million checks a day.

---

Sources: [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · repo files cited inline.
