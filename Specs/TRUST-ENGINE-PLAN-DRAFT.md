# Trust Engine — Discussion Draft v0.1

Status: **DRAFT for discussion — not approved, no code yet.**
Date: 2026-07-05 · Supersedes-in-spirit: the "liveness check" framing in Specs/LIVENESS-1M-SCALE-REPORT.md (that report's cost analysis still holds).
Owner input needed on the eight decision points in §6 before this becomes the canonical spec.

---

## 1. The reframe (agreed)

We stop building a "human verification" feature and build the **Trust Engine**: the trust substrate for the whole AvaVerse — listings, marketplace negotiation, calls, receptionist, payments, AvaConsult. Design horizon: 100M verifications over 10 years, not 1M/day as a stunt.

Core principles adopted from the owner's architecture, restated as build rules:

1. **No single AI decides.** Every stage emits *evidence*; only the Trust Score Calculator emits a decision.
2. **Every decision maps to a rule ID** (`VF-204`, `CS-101`, …) with confidence, source stage, provider, model version, and a user-safe explanation. "FAILED" alone is a bug.
3. **Deterministic:** same evidence + same config version ⇒ same decision. Score weights, thresholds and bands live in versioned config; every audit row records `score_model_version`.
4. **Vendor independent:** `FaceProvider`, `ModerationProvider`, `SpeechProvider`, `AttestationProvider` interfaces; AWS/Workers AI/Azure/Hive are config choices, never call-site imports.
5. **Cheap by ordering:** stages run cheapest-first and short-circuit; expensive providers only see traffic that survived the free stages.
6. **Queues, never `waitUntil`.** (Queue infra already landed in [LIVE-QUEUE-1]; the waitUntil path becomes emergency fallback only.)
7. **Privacy-aware and auditable:** evidence retention is a per-decision policy, purged on account deletion (already wired, [LIVE-PURGE-1]); every session carries a `trace_id` and the pipeline is replayable from the audit trail.

## 2. Architecture on our stack (Cloudflare-native mapping)

```
Client (Flutter)
  │  Stage 0 session + Stage 2 capture-quality gates + challenge capture (ON-DEVICE, free)
  ▼
POST /api/trust/session  ─►  VerificationDO (per user)          ← NEW Durable Object
  │   session lifecycle · nonce · challenge · upload state ·
  │   pipeline stage cursor · retries · timeout · single-active-session
  ▼
R2 staged evidence  ─►  Queue: trust-verify  ─►  Verification Worker (consumer)
                                 │
        ┌────────────────────────┼─────────────────────────┐
        ▼                        ▼                          ▼
   Device Trust            Liveness/Face               Content Safety
   (attestation,           (FaceProvider:              (ModerationProvider:
   emulator, VPN,          DetectFaces-class            nudity/violence/child/
   virtual camera)         geometry, no LLM)            occlusion policy)
        └────────────────────────┼─────────────────────────┘
                                 ▼
                  Identity Consistency (frame-to-frame, history)
                                 ▼
                  Fraud Risk Engine (signals store + velocity)
                                 ▼
                  Trust Score Calculator (weighted, versioned)
                                 ▼
                  PASS / REVIEW / FAIL  + rule-ID explanations
                                 ▼
        Audit (D1 trust_decisions + R2 evidence per policy) · PostHog telemetry
```

Concrete mapping to what exists today:

| Proposal | Our implementation |
|---|---|
| Verification Session (Stage 0) | Extends today's `/liveness/start` KV challenge → moves into **VerificationDO** (DO-local SQLite), gaining nonce, trace_id, single-active-session, stage cursor. Matches the InboxDO pattern from the Cloudflare-native pivot. |
| Identity Verification Queue | `liveness-verify` queue (shipped) → renamed/generalized `trust-verify`; consumer stays self-consumed on avatok-api. |
| Verification Orchestrator | The queue consumer walks a **stage registry** (ordered list of `Stage` functions, each returning `Evidence[]`), not a monolithic `runLivenessChecks`. Existing B1–B9 checks become the first stage implementations, each renamed to a rule ID. |
| Device Trust | `device_report` (shipped, [LIVE-DEVAUTH-1]) grows into a full signal set; Play Integrity/App Attest server verification is [LIVE-ATTEST-1]. |
| Content Safety | NEW stage. Tiered: cheap first-pass → premium provider on escalation (decision D3). Child-presence triggers a separate policy path (decision D4). |
| Face Analysis / Consistency | `FaceProvider.detectFaces()` + `compareFaces()` — Rekognition adapter exists (`aws/rekognition.ts`); add a Workers-AI/on-device adapter. **No LLM as classifier** — LLaVA gets demoted to optional audit-sample tooling, which fixes the 1M/day cost blocker identified in the scale report. |
| Audio | On-device speech scoring (shipped direction) + server sample verification of a small snippet. |
| Fraud Intelligence | NEW: `fraud_signals` store + per-user velocity counters in the VerificationDO; edge geo/IP/ASN from the request; cross-signals (device reuse, multi-account, listing removals, reports) read from existing D1 tables. |
| Trust Calculator | NEW pure function: `score(evidence[], weights@version) → {score, band, rules[]}`. Weights/bands in `platform_config` (KV, merged over code defaults — the 2026-07-04 lesson). |
| Audit | `liveness_audit` (shipped) generalizes to `trust_decisions`: trace_id, per-rule evidence rows, provider+model versions, durations, cost estimate, score breakdown. |

## 3. What I'd refine in the proposal (the discussion part)

**3.1 Keep Stage 2 and most of Stage 7 on-device.** The proposal reads server-heavy. Our biggest cost/latency win (per the scale report) is that ML Kit already does capture quality + challenge gating for free with unlimited retries. The Trust Engine should treat the device as an *evidence source with an attestation-weighted trust level*, not move that work back to the server. Server-side face geometry then *verifies claims* on 4–6 compressed frames rather than discovering everything itself.

**3.2 Per-frame premium moderation at scale is a new cost cliff.** Rekognition DetectFaces + DetectModerationLabels ≈ $0.001/image each. Naively "every frame passes moderation" at 1M sessions × 4 frames × 2 APIs ≈ **$8k/day** — we'd be re-creating the LLaVA problem with a different vendor. The provider interface is exactly what lets us tier this (D3): cheap first-pass (Workers AI classifier or on-device NSFW/person-count model) on every frame; premium provider only on escalation, REVIEW band, and an N% audit sample.

**3.3 REVIEW band is an operational commitment, not just a score range.** Someone has to review. That means a review queue, an admin console surface, SLAs, and reviewer audit. At launch we could alias REVIEW → structured auto-retry with tightened thresholds, and only open human review when volume justifies it (D1).

**3.4 Identity History (Stage 9) = storing biometric templates.** Face embeddings for "same person as last time" are regulated biometric data in several jurisdictions (BIPA-class statutes, GDPR art. 9). This is a legal/product decision (D2), not just an engineering one. Options range from "no persistent embeddings — compare against the retained pass thumbnail per session" (weaker, safer) to "encrypted embeddings with regional gating + explicit consent" (stronger, heavier).

**3.5 Child policy path needs an actual policy.** Detection is the easy half. What happens on detection — hard fail with generic message, account flag, parent-account routing (we HAVE parent/child accounts — this could integrate with AvaKids gating rather than being purely negative), evidence handling, and whether anything triggers reporting obligations — is D4.

**3.6 Trust Score should feed the Trust Ladder, not replace it.** We already have L0–L3 progressive identity. Proposal: the Trust Engine emits a continuous `trust_score` (0–100, recomputed on events, decaying signals) and the ladder consumes it as its primary input; apps keep gating on ladder levels so nothing else in the codebase needs to understand scores (D6).

**3.7 Determinism vs. fraud adaptivity tension.** Fully deterministic scoring is replayable but gameable (attacker learns weights by probing). Resolution: deterministic *within a config version*, plus the sampled deep-audit lane (already shipped at 8%) as the non-deterministic tripwire, plus weight rotation as an operational practice.

## 4. Rule registry (the explainability backbone)

Single source of truth `worker/src/trust/rules.ts`:

```
RULE:      { id: "CS-101", stage: "content_safety", severity: "hard_fail",
             user_message: "…", internal: "Explicit nudity detected",
             default_threshold: 0.9, provider_hint: "moderation" }
```

Namespaces: `DT-xxx` device trust · `CQ-xxx` capture quality · `CI-xxx` camera integrity · `CS-xxx` content safety · `FA-xxx` face analysis · `FC-xxx` consistency · `LV-xxx` liveness challenge · `AU-xxx` audio · `IH-xxx` identity history · `FR-xxx` fraud. Existing B1–B9 map 1:1 into these (e.g. b1_realness → CI-101, b2_single_person → CS-201, b6_phrase → AU-101), so client fail-message rendering keeps working through the migration.

Every decision persists: `trace_id → [ {rule_id, pass, confidence, frame_ref, provider, model_version, threshold@version, duration_ms} ]` + the score breakdown. That is the "explain any rejection months later" requirement, and it's also the threshold-tuning dataset.

## 5. Phased migration (strangler over liveness.ts — no big-bang rewrite)

- **P0 Foundation:** VerificationDO, `trace_id`, rule registry + B-check mapping, provider interfaces (Rekognition + Workers AI adapters), `trust_decisions` schema, stage-registry orchestrator wrapping the EXISTING checks unchanged. Flag: `trustEngineEnabled` (off). Zero behavior change.
- **P1 Device Trust:** real Play Integrity/App Attest verification ([LIVE-ATTEST-1]), emulator/VPN/virtual-camera signals, `device_score`.
- **P2 Content Safety + Face Analysis:** tiered moderation, DetectFaces-class geometry replaces LLaVA YES/NO prompts, frame-to-frame consistency.
- **P3 Fraud + Trust Calculator:** signals store, velocity counters, weighted score, PASS/REVIEW/FAIL bands, ladder integration.
- **P4 History + Review:** identity history (per D2), review console (per D1), threshold-tuning loop from audit data.

Each phase ships flag-gated and dark; the current pipeline keeps serving until the score-band cutover.

## 6. Decision points — need your call before this becomes canon

| # | Decision | Options (my lean in bold) |
|---|---|---|
| D1 | REVIEW band at launch | **auto-retry with tightened thresholds; human review console deferred to P4** / human review from day one / no REVIEW band (binary) |
| D2 | Identity history biometrics | **session-vs-retained-thumbnail compare only, no persistent embeddings at launch** / encrypted embeddings + consent + regional gating / skip stage 9 entirely |
| D3 | Moderation tiering | **Workers-AI/on-device first-pass on all frames; Rekognition-class only on escalation + REVIEW + sample** / premium provider on everything (cost cliff) / on-device only (weakest) |
| D4 | Child-presence policy | needs definition: fail behavior, account flag, parent/child-account integration, evidence handling, reporting posture — **I propose: hard fail w/ neutral message + route to parent-account flow + no evidence retention + internal flag** |
| D5 | Initial weights/bands | strawman: Device 22 · Liveness 30 · Content 20 · Consistency 12 · History 8 · Fraud −10; PASS ≥ 75, REVIEW 55–74, FAIL < 55 — tune from audit data |
| D6 | Score surface | **Trust Engine feeds the existing L0–L3 ladder; apps keep gating on levels** / expose raw score to apps / both |
| D7 | Naming & module | **`worker/src/trust/` + `/api/trust/*` routes, "Trust Engine" internally; user-facing copy stays "Liveness check" for now** / rename user-facing too |
| D8 | DO placement | **New VerificationDO per user (matches InboxDO pattern)** / fold session state into an existing DO / keep KV sessions (weakest: no single-active-session guarantee) |

## 7. What this kills

LLaVA as decision-maker (becomes audit tooling only) · `waitUntil` as primary path · flat pass/fail with anonymous reasons · KV-only session state · vendor lock at call sites · "liveness" as the system's identity.
