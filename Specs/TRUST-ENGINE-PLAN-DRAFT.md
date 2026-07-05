# Trust Engine — Discussion Draft v0.2

Status: **DRAFT v0.2 — re-architected around progressive cost escalation (owner review 2026-07-05).**
Supersedes v0.1 (fc1f44e). The v0.1 stage taxonomy, rule registry, provider interfaces, VerificationDO, and phased migration all stand; what changed is the **shape of the pipeline**: it is now a cost staircase, and the optimization philosophy is a hard rule:

> **Never send a byte to the cloud unless the previous, cheaper stage has already passed.**
> A failed verification must cost ~nothing. Only successful verifications may cost money.

---

## 1. The cost staircase (the new core)

```
TIER 0 — FREE (on-device, unlimited retries, no server contact)
   blur · brightness · pose · face-in-oval · one face · eyes/blink ·
   smile/expressions · head turns · phrase (on-device STT) · camera FPS ·
   capture quality · frame dedupe (perceptual hash) · challenge choreography
        │  all local gates green?
        ▼
TIER 1 — ALMOST FREE (~500 KB up; no premium providers)
   upload 4–10 deduped JPEGs (640px, ~80 KB each, adaptive count) + ~100 KB
   audio snippet, sequentially with early-abort.
   Server (VerificationDO): challenge correctness · nonce/signature ·
   timestamps monotonic & in-window · frame-order consistency · device
   attestation verdict (cached) · device_score · fraud pre-screen
        │  Tier-1 evidence clean?
        ▼
TIER 2 — CHEAP → MODERATE (escalation ladder, only likely-pass traffic)
   moderation + face analysis on the escalation ladder (§3):
   on-device verdict ▸ Workers AI ▸ premium (Rekognition-class) ONLY on
   uncertainty. DetectFaces geometry · CompareFaces consistency ·
   DetectModerationLabels — never for blur/pose/smile/quality (ML Kit owns those).
        │  Trust Score ≥ PASS band?
        ▼
TIER 3 — EXPENSIVE, PASS-ONLY (archive)
   client uploads the FULL encrypted video to R2 → server confirms receipt →
   client deletes local copy. Failures never upload video. Retained evidence =
   Tier-1 frames + snippet + archived video, per retention policy.
```

Decision evidence vs. archive evidence: the PASS/REVIEW/FAIL decision is made **entirely from Tier 1–2 evidence** (frames + snippet + signals). The Tier-3 video is archival/audit material only — it arrives after the decision and can never change it. Audit rows record this distinction explicitly.

## 2. Client-side mechanics (Tier 0/1)

- **Frame dedupe:** perceptual hash (dHash, 64-bit) computed on-device per candidate frame; drop frames within Hamming distance ≤ threshold of an already-selected frame. Never upload duplicates.
- **Adaptive frame count:** target count set by the server in the session challenge based on prior risk: easy session 4 · default 6 · suspicious (fraud pre-screen, prior fails, weak attestation) 10.
- **Aggressive compression:** 640 px long edge, JPEG q≈75 (shipped in [LIVE-COMPRESS-1]); never 1080p for verification frames.
- **Incremental upload with early-abort:** frames POST sequentially to the VerificationDO; the DO runs its free checks (signature, timestamp, order, dedupe-server-side re-check) as each arrives and returns `continue | abort{rule_id}`. A frame-2 hard fail means frames 3–8 never leave the phone. (Refinement vs. the raw proposal: batching stays possible on good networks — the DO contract is per-chunk, not per-frame-roundtrip-mandatory, so latency doesn't balloon on high-RTT links.)
- **Harder challenges:** random multi-step scripts per session (e.g. smile → turn left → blink ×2 → read phrase → look up), 3–5 steps drawn from the pool, order randomized, all still gated on-device via ML Kit; the challenge script + per-step timestamps are part of Tier-1 evidence.
- **Phrase:** on-device STT scores the phrase locally (Tier 0); Tier 1 uploads only a short audio snippet for sampled/risk-triggered server verification. Full-clip Whisper is dead.

## 3. Moderation & face-analysis escalation ladder (resolves D3)

```
on-device model verdict (free)
   confident-reject (≥.95)  → reject locally, rule-ID'd, $0
   confident-pass  (≥.95)   → accept signal, $0
   uncertain                → Workers AI classifier (~$0.0002/frame)
        confident either way → done
        still uncertain      → premium provider (~$0.001/frame), decisive
```

Premium (Rekognition-class) is reserved for: uncertainty escalation, the REVIEW band, the N% audit sample, and CompareFaces/DetectFaces/DetectModerationLabels — the three things it is excellent at. It is never used for blur, brightness, pose guidance, FPS, smile prompts, blink, countdowns, or quality (ML Kit owns those for free).

## 4. Cost Budget (adopted — new stage-zero primitive)

Every session carries a budget object (generalization of the shipped `LlavaBudget`):

```
budget = { cap_usd: 0.015, spent_usd: 0, ledger: [{stage, provider, units, usd}] }
```

Unit costs live in versioned config (KV over code defaults). Every provider call debits the ledger; a stage that would exceed the cap escalates to REVIEW instead of silently overspending. On finalize, PostHog gets `verification_cost` (total + per-stage breakdown + provider mix + tier reached). Dashboard question this must answer: *"why did yesterday's average verification cost rise 40%?"* — the ledger makes that a group-by, not an investigation.

## 5. Retries, abuse, and caching

- **Retry model (reconciles LIVE-RETRY-1 with the new cap):** Tier 0 retries are unlimited and free — a legit user fixing lighting never touches the server. **Server-tier attempts: max 3 per session**, then the session dies; session creation stays under the existing 20/24h guard, with an escalating cooldown (e.g. 5 min → 1 h) after repeated 3-strike sessions. Net effect: honest users keep effectively unlimited tries; attackers can't get infinite *server* tries.
- **Attestation caching:** Play Integrity / App Attest / device-trust verdicts cached per device for a few hours (KV or DO-local), invalidated on app version change, account switch, or fraud-signal spike. Cuts external attestation calls and latency on retry-heavy sessions.
- **Signals:** every request signed, every upload hashed (hash recorded in audit), every frame timestamped, nonce single-use, sessions expire, APIs idempotent, evidence immutable once written.

## 6. What carries over from v0.1 unchanged

Rule registry + namespaces (DT/CQ/CI/CS/FA/FC/LV/AU/IH/FR) with B1–B9 mapping · provider interfaces (Face/Moderation/Speech/Attestation) · VerificationDO per user (session lifecycle, stage cursor, single active session — now also the incremental-upload early-abort brain and the budget ledger holder) · queue-only execution (`trust-verify`) · Fraud Risk Engine + Identity Consistency · Trust Score Calculator with versioned weights/bands · explainable decisions (trace_id → per-rule evidence) · privacy/purge posture · Cloudflare-native mapping · strangler migration.

Phasing update: the cost staircase pulls two items forward — **P0 now includes the budget ledger and incremental-upload contract in the VerificationDO** (they shape every later stage), and **Tier-3 pass-only video upload replaces the current "upload clip before verify" flow in P1** (biggest bandwidth win, purely client+DO work).

## 7. Open decision points (updated)

| # | Decision | Status |
|---|---|---|
| D1 | REVIEW band at launch | open — my lean: auto-retry w/ tightened thresholds, humans in P4 |
| D2 | Identity-history biometrics | open — my lean: thumbnail-compare only at launch, no persistent embeddings |
| D3 | Moderation tiering | **RESOLVED: escalation ladder (§3)** |
| D4 | Child-presence policy | open — proposal stands: hard fail, neutral message, parent-account routing, no evidence retention, internal flag |
| D5 | Weights/bands | strawman stands (Device 22 · Liveness 30 · Content 20 · Consistency 12 · History 8 · Fraud −10; PASS ≥75, REVIEW 55–74) — now also budget cap $0.015 to ratify |
| D6 | Score surface | open — my lean: feeds the L0–L3 ladder only |
| D7 | Naming | open — `worker/src/trust/`, user copy stays "Liveness check" |
| D8 | DO placement | open — my lean: new VerificationDO, now strongly reinforced (it's the early-abort + ledger brain) |
| D9 | **NEW** — Tier-1 attempt cap & cooldown values | 3/session + 5min→1h escalating cooldown + 20 sessions/24h — ratify or adjust |
| D10 | **NEW** — adaptive-frame risk tiers | what promotes a session to "suspicious/10-frame": weak attestation, prior fails, fraud pre-screen — define the trigger list |

## 8. What this kills (v0.2 additions in bold)

LLaVA as decision-maker · `waitUntil` as primary path · anonymous failures · KV-only sessions · vendor lock at call sites · "liveness" as system identity · **pre-verify full-video upload** · **full-clip Whisper** · **fixed frame counts** · **duplicate-frame uploads** · **premium moderation as first resort** · **unmetered provider spend**.
