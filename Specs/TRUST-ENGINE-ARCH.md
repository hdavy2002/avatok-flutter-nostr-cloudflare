# Trust Engine — Canonical Architecture v1.1 (FROZEN — FINAL)

Status: **FROZEN 2026-07-05 (owner decision). Implementation is the next step, not design.**
Lineage: v0.1 (fc1f44e, staged-evidence re-arch) → v0.2 (dcabe4d, cost staircase) → v1.0 (2b4b5f4, 20 hardening additions) → **v1.1 (final freeze edits: LLM-free verification, AWS Rekognition named as launch FaceProvider/ModerationProvider implementation, quota-aware circuit breaker)**.
`Specs/TRUST-ENGINE-PLAN-DRAFT.md` is superseded by this file. The liveness code shipped 2026-07-05 ([LIVE-UI-3]/[LIVE-SCALE-1]) is P0 raw material for the strangler migration in §12.

---

## 0. What this is

Not "human verification." The **Trust Engine**: the trust substrate for the entire AvaVerse (marketplace, listings, calls, receptionist, consulting, payments). Design horizon: 100M verifications / 10 years.

**The two laws:**

1. *Never send a byte to the cloud unless the previous, cheaper stage has already passed.* A failed verification costs ~nothing; only successes may cost money.
2. *No single AI decides anything.* Every stage contributes evidence; only the Trust Score Calculator, filtered through the Policy Engine, emits a decision — and every decision maps to versioned rule IDs.

## 1. Top-level flow

```
Client (Flutter)
  │ create session
  ▼
FAST FAIL LANE (§3) ──reject──► done ($0, no capture even starts)
  │ clean
  ▼
TIER 0 — on-device, free, unlimited retries (§4)
  │ local pass
  ▼
TIER 1 — ~500 KB frames+snippet → VerificationDO, incremental early-abort (§5)
  │ clean
  ▼
TIER 2 — escalation-ladder providers, likely-pass traffic only (§6)
  │ evidence complete
  ▼
Identity Consistency ► Fraud Risk ► Trust Score Calculator (§8)
  ▼
POLICY ENGINE (§9) ─► PASS / REVIEW / FAIL  (+ rule IDs, versions, explanations)
  │ PASS only
  ▼
TIER 3 — full encrypted video archived to R2; client deletes local (§5.4)
  ▼
Evidence Manifest + verification fingerprint + audit + telemetry (§10)
```

## 2. Verification state machine (VerificationDO)

One DO per user (single active session — the InboxDO pattern). Session state is an explicit machine; **illegal transitions are impossible**, every transition is timestamped and audited:

```
NEW → CHALLENGE_SENT → CAPTURING → LOCAL_PASS → UPLOADING → VERIFYING
    → (PASSED → ARCHIVING → DONE) | (REVIEW → …) | (FAILED → DONE)
Any state → EXPIRED | ABORTED(rule_id)
```

**Timeout rules (anti-replay):** challenge unclaimed 30 s after issue → EXPIRED. Inter-frame upload gap > 10 s → ABORT. CAPTURING wall-clock cap ~120 s (device retries are local; the *session* isn't immortal). VERIFYING cap 90 s → REVIEW-or-retry, never a silent hang. All values in versioned config.

DO responsibilities: session lifecycle + state machine · nonce (single-use) · challenge issue/verify · incremental upload contract (`continue | abort{rule_id}` per chunk) · budget ledger (§7) · retry/cooldown counters · attestation verdict cache (§3) · manifest assembly (§10).

## 3. Fast Fail lane (pre-Tier-0, invisible, $0)

Runs at session creation, before the client spends CPU/battery on capture. Instant reject when: device fingerprint on ban list · account/phone revoked · attestation verdict already-failed (cached) · IP reputation floor (known-bad ASN/Tor exit w/ prior abuse) · stolen/expired session or nonce reuse · active cooldown · fraud-velocity throttle tripped (§8.2). Emits `FF-xxx` rules. Cache sources: KV ban lists + DO-local counters. This lane is also where **attestation caching** lives: Play Integrity / App Attest verdicts cached per device for a few hours, invalidated on app-version change, account switch, or fraud spike.

## 4. Tier 0 — on-device (free, unlimited retries)

ML Kit + on-device STT own: blur · brightness · pose · face-in-oval · exactly-one-face · eyes/blink · expressions · head turns · phrase scoring · FPS/quality · frame dedupe (dHash 64-bit, Hamming-threshold) · challenge choreography. Server is never contacted for any of this. Premium providers are **never** used for blur/brightness/pose/FPS/smile/blink/countdown/quality.

**Challenges:** server-issued random multi-step scripts (3–5 steps: smile → turn left → blink ×2 → read phrase → look up …), order randomized, per-step timestamps captured. Every challenge carries **`challenge_version`** so future app versions can still verify (and audit can replay) old sessions.

## 5. Tier 1–3 — the paid staircase

**5.1 Tier 1 (~500 KB, no premium providers).** Adaptive frame count from session risk (easy 4 · default 6 · suspicious 10 — triggers: weak/absent attestation, prior fails, fraud pre-screen, D10 list in config). Frames 640 px JPEG ~80 KB, deduped, uploaded sequentially to the DO with early-abort; ~100 KB audio snippet. Server checks: challenge correctness · signatures · timestamp monotonicity/window · frame-order consistency · device attestation verdict · device_score · fraud pre-screen.

**5.2 Tier 2.** Escalation ladder (§6) for moderation + face analysis: face analysis (AWS Rekognition `DetectFaces`), face consistency (`CompareFaces`), content moderation (`DetectModerationLabels`), and person count (exactly one visible person, via face bounding boxes). Only sessions that survived Tier 1. **No LLM ever participates in a verification decision** — the Trust Engine is deterministic; LLM-based verification is banned by design.

**5.3 Decision.** Made **entirely from Tier 1–2 evidence**. Archived material can never influence a decision (decision evidence ≠ archive evidence — enforced by ordering: the decision is final before Tier 3 begins).

**5.4 Tier 3 (PASS only).** Full encrypted video → R2 → receipt confirmed → client deletes local copy. Failures never upload video. Retention: manifest + frames + snippet + video per policy; purged on account deletion (shipped, [LIVE-PURGE-1]).

## 6. Providers

**Uniform provider contract** — every adapter (AWS, Workers AI, Azure, Hive, on-device, future) returns exactly:

```
{ verdict, confidence_raw, confidence: 0–100 normalized, latency_ms,
  cost_usd, provider, model_version, evidence_ref }
```

Confidence normalization happens **in the adapter**; everything downstream is provider-independent. Interfaces: `FaceProvider` · `ModerationProvider` · `SpeechProvider` · `AttestationProvider`. Selection by config, never call-site imports. Code never names a vendor at a call site — there is no `RekognitionProvider` type in pipeline code, only `FaceProvider`.

**Initial implementations (frozen):** **AWS Rekognition is the launch implementation of both `FaceProvider`** (`DetectFaces`: geometry, eye openness, quality, pose, confidence; `CompareFaces`: same-person consistency; face count/bounding boxes for exactly-one-person) **and `ModerationProvider`** (`DetectModerationLabels`: nudity, explicit, violence, graphic, suggestive). Alternates behind the same interfaces: Azure Face / Google Vision / future (`FaceProvider`); Hive / Google Vision / Workers AI (`ModerationProvider`). AWS is today's implementation, not a dependency. Rekognition is used ONLY for what it excels at — blur, brightness, head tracking, smile, blink, countdown, FPS, face-oval and challenge choreography stay on-device with ML Kit (faster and free).

**Escalation ladder:** on-device verdict (free; ≥.95 confident → done) ▸ Workers AI (~$0.0002/frame; confident → done) ▸ premium (~$0.001/frame, decisive). Premium is reserved for uncertainty, REVIEW band, and the N% audit sample.

**Circuit breaker (hard invariant: a user is NEVER failed solely because a cloud provider is unavailable).** Per-provider health tracks rolling error rate, latency, AND quota signals — Rekognition `429 Too Many Requests` / `ThrottlingException` / `ProvisionedThroughputExceeded` and regional outages open the breaker exactly like errors do (with per-second TPS budgeting *below* the AWS account quota so we self-throttle before AWS does). Open breaker ⇒ degrade gracefully: `AWS unavailable → Workers AI only → REVIEW → retry later` — the session parks in REVIEW with an automatic re-verify when the breaker half-opens; the user sees "still checking," never a rejection. Workers AI down → premium direct (budget-checked) or REVIEW. Breaker state changes are audited + alerted. The system never fully blocks — and never fails a user — on any single vendor's bad day.

**Feature flags:** every expensive capability individually flagged (`trust.moderation`, `trust.faceCompare`, `trust.historyCompare`, `trust.workersAi`, `trust.premiumAi`, `trust.tier3Archive`…), KV-merged over code defaults (the 2026-07-04 flag lesson), enabling gradual rollout and instant kill.

## 7. Budget (multi-dimensional)

Per-session ledger held by the DO:

```
budget = { caps: { usd: 0.015, latency_ms: 8000, cpu_ms, egress_kb },
           spent: {…}, ledger: [{stage, provider, units, usd, latency_ms}] }
```

Money AND latency (and CPU/bandwidth) are budgeted — sometimes Workers AI is cheaper but slower; the ladder consults both caps when escalating. Exceeding a cap escalates to REVIEW, never silently overspends. Unit costs in versioned config. Finalize emits `verification_cost` (total + per-stage + provider mix + tier reached) so "why did average cost rise 40% yesterday?" is a group-by.

## 8. Signals, fraud, scoring

**8.1 Cheap ambient signals (score, don't block):** geo anomalies (impossible travel: India → 10 min → Brazil ⇒ fraud weight) · **clock integrity** (device time vs server time; large skew = fraud signal) · **network integrity** (carrier/WiFi/VPN/Tor/ASN — scored, not blocked) · device/phone reuse across accounts · time-of-day patterns.

**8.2 Formalized fraud velocity (per user + per device + per IP):** attempts/hour, attempts/day, pass %, abort %, avg duration, REVIEW %, **provider spend/hour**. Hard rule: burning ≥ $5 of provider spend in an hour ⇒ automatic throttle (Fast Fail lane enforces). Counters live DO-local; aggregates flow to the fraud store.

**8.3 Retries:** Tier 0 unlimited & free (preserves LIVE-RETRY-1 for honest users). Server tiers: **3 attempts/session**, then session dies; escalating cooldown (5 min → 1 h) on repeated 3-strike sessions; 20 sessions/24 h guard stays.

**8.4 Trust Score Calculator:** pure, deterministic function `score(evidence[], weights@version) → {score 0–100, band, rules[]}`. Launch weights: Device 22 · Liveness 30 · Content Safety 20 · Consistency 12 · History 8 · Fraud −10. Bands: PASS ≥ 75 · REVIEW 55–74 · FAIL < 55. Weights/bands/thresholds in versioned config; every decision records `score_model_version`. Deterministic *within a config version*; the sampled deep-audit lane (8%) + periodic weight rotation are the anti-gaming tripwires.

**8.5 Identity history (launch posture):** compare against the retained pass thumbnail per session only — **no persistent biometric embeddings at launch** (BIPA/GDPR-art.9 exposure). Revisit with legal review as a config-versioned upgrade, not an architecture change.

## 9. Policy Engine (verification stays generic; products decide requirements)

Between the score and the decision sits a declarative policy layer:

```
policy(context) → { required_proofs[], min_trust_score, extra_stages[], retention_profile }

marketplace_listing: phone + liveness, score ≥ 75
dating:              phone + liveness, score ≥ 80
jobs:                phone + liveness + education_docs
property:            phone + liveness + ownership_docs
teachers/kids-adjacent: phone + liveness + enhanced review, score ≥ 85
```

Policies are config (KV-versioned, per-app), evaluated by the engine, audited with `policy_id@version` on every decision. New verticals = new policy entries, **zero pipeline changes**. Trust Engine output feeds the existing L0–L3 Trust Ladder; apps keep gating on ladder levels (raw scores are not exposed to product code).

**Second-person / child policy:** the user-facing rule is neutral and general — *"Verification cannot continue because another person appears in the verification session"* (covers children, adults, crowds, mirrors; never exposes which). Internally: child-presence signal routes to a separate policy path (no identity verification through that session, no evidence retention, internal flag, parent-account routing hook). If age estimation is ever added it is **one weighted signal, never absolute truth**.

## 10. Explainability, audit, integrity

**Rule registry** (`worker/src/trust/rules.ts`): namespaces FF/DT/CQ/CI/CS/FA/FC/LV/AU/IH/FR; B1–B9 map 1:1 (b1_realness→CI-101, b2_single_person→CS-201, b6_phrase→AU-101 …). Every rule carries **`rule_version`** — thresholds will change; old decisions must name the rule version that produced them.

**Evidence Manifest** — one object per verification (R2, immutable), the single source of truth:

```
manifest: { verification_id, trace_id, session, challenge@version,
  frames[{key, dhash, sha256, ts}], audio{…}, video?{…},
  provider_results[uniform objects], rules[{id, version, pass, confidence, frame_ref}],
  score{breakdown, model_version}, policy{id, version}, budget_ledger,
  state_transitions[], timings, geo/net/clock signals }
```

**Verification fingerprint:** `fingerprint = sha256(challenge ‖ frame_hashes ‖ device_fp ‖ provider_versions ‖ rule_versions ‖ score_model_version)` stored in the manifest + D1 `trust_decisions` row — cryptographic proof of exactly what was verified, months later.

**Security invariants:** every request signed · every upload hashed (hash in manifest) · every frame timestamped · nonce single-use · sessions expire · challenges random+versioned · APIs idempotent · manifests immutable.

**Telemetry (PostHog), per stage:** START/SUCCESS/FAIL, duration, cost, provider, normalized confidence — all under `trace_id` (full pipeline replay). KPIs: **False Reject Rate** (user retries → eventually passes ⇒ we rejected a legitimate user; the #1 tuning metric), pass rate by tier, cost/verification, provider spend mix, REVIEW rate, breaker trips, FF-lane hit rate.

## 11. Decisions ratified at freeze (config-tunable, not architectural)

D1 REVIEW = auto-retry with tightened thresholds at launch; human review console in P4. · D2 no persistent embeddings; thumbnail-compare only. · D3 escalation ladder. · D4 second-person neutral-wording policy (§9). · D5 weights/bands/budget per §7–8. · D6 score feeds L0–L3 ladder only. · D7 module `worker/src/trust/`, routes `/api/trust/*`, user copy stays "Liveness check". · D8 new VerificationDO. · D9 3/session + 5min→1h cooldown + 20/24h. · D10 suspicious triggers = weak/absent attestation, prior fails, fraud pre-screen flags (list in config).

## 12. Build plan (strangler over liveness.ts; every phase flag-gated & dark)

- **P0 Foundation:** VerificationDO (state machine, timeouts, nonce, incremental-upload contract, budget ledger, manifest assembly) · rule registry w/ versions + B1–B9 mapping · uniform provider adapters (Rekognition, Workers AI, on-device) w/ confidence normalization · `trust_decisions` schema + fingerprint · Fast Fail lane skeleton · flags. Zero behavior change.
- **P1 Staircase cutover:** Tier-3 pass-only video replaces upload-before-verify · Tier-1 incremental frames · attestation verify + cache ([LIVE-ATTEST-1]) · circuit breakers.
- **P2 Content Safety + Face Analysis:** Rekognition-based `FaceProvider` and `ModerationProvider` become the authoritative cloud verification providers. On-device ML Kit continues to own capture quality, pose guidance, blink detection, smile detection, and challenge execution. Premium cloud verification is limited to face analysis, face consistency, and moderation through the provider abstraction layer. All legacy LLaVA code paths deleted.
- **P3 Fraud + Score + Policy Engine:** velocity counters, geo/clock/network signals, Trust Score, policy configs, ladder integration, `verification_cost` + FRR dashboards.
- **P4 History + Review:** thumbnail-compare history, human review console, threshold-tuning loop from manifest data.

## 13. What this kills

Any LLM as a verification decision-maker · `waitUntil` as primary path · anonymous failures · KV-only sessions · vendor lock at call sites · pre-verify video upload · full-clip Whisper · fixed frame counts · duplicate uploads · premium moderation as first resort · unmetered spend · implicit session states · unversioned rules/challenges · provider-specific confidences downstream · hard dependence on any single vendor · product requirements hard-coded in the pipeline.
