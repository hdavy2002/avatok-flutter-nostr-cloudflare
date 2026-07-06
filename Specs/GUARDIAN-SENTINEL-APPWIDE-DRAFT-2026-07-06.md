# Guardian Sentinel — App-Wide Trust System, Draft v3 (2026-07-06)

Owner direction: Guardian becomes a platform-wide "virus scanner" — a per-account watchdog with a mem0 memory persona, monitoring behaviour site-wide, building a trust score, and invoking face-liveness adaptively (not mandatorily). Incorporates the owner's AI-review feedback: progressive liveness, conversation-level risk, evidence buckets, decaying reputation, confidence framing, no social-credit scope creep.

**Supersedes** the P6 hard-gate section of `GUARDIAN-V2-DRAFT-PLAN-2026-07-06.md` (P0–P5 of that plan stand unchanged). **Extends — does NOT reopen —** the frozen `TRUST-ENGINE-ARCH.md` v1.1.

---

## 0. The one architectural rule: extend the frozen Trust Engine, don't fork it

We already ratified a Trust Engine (FROZEN 2026-07-05). Its two laws stay intact:

- *No single AI decides anything; verification decisions are LLM-free and deterministic.*
- *Never spend before the cheaper stage passed.*

The new app-wide system fits as three layers, one brain:

```
            EVENTS (site-wide)                      DECISIONS
 chat msgs · listings · groups · reports        ┌──────────────────┐
 uploads · profile edits · friend reqs   ──►    │  TRUST ENGINE    │──► PASS/REVIEW/FAIL
 payments · velocity · calls-metadata           │  (frozen v1.1)   │    liveness verdicts
        │                                       │  Policy Engine   │
        ▼                                       └───────▲──────────┘
 ┌─────────────────────┐   evidence buckets            │ one weighted signal
 │  GUARDIAN SENTINEL  │──── D1 scores ────────────────┘
 │  (new, this doc)    │
 │  LLM allowed here   │──── mem0 behavioural memory (per account)
 └─────────────────────┘
        │
        ▼
 GUARDIAN CHAT SHIELD (v2 plan P0–P5: inline scan, red bubbles, warnings)
```

Division of labour, stated once: **the Sentinel observes and scores (LLMs allowed — classification, pattern summarisation); the Trust Engine verifies and decides (LLM-free, unchanged).** The Sentinel's output enters the Trust Engine only as *evidence* — a weighted signal into the existing Trust Score Calculator (§8.4 already has History and Fraud buckets) and as *policy triggers* (§9 explicitly allows new policy entries with zero pipeline changes). Nothing in the frozen spec is modified.

Branding (per review): **Guardian Trust Engine** is the invisible system; users only ever see the pieces — 🛡 Guardian (chat), ✓ Verified Human (liveness), ⭐ Trusted Seller (marketplace), Safe Groups.

## 1. Guardian Sentinel — the site-wide watchdog

### 1.1 Event feed (reuse, don't build)

The platform already emits the events we need; the Sentinel is a consumer, not new instrumentation:

- **Q_BRAIN queue** — messaging.ts already enqueues `message_received` events per member (AvaBrain ingestion). Add a Sentinel consumer on the same bus (respecting AvaBrain-style guardrails; E2E/on-device-only content never leaves device — bible rule).
- **Guardian chat flags** — `ava_guardian_flags` rows (already written).
- **PostHog-tracked actions** — listings created, groups created, reports filed, blocks received, profile edits, upload moderation verdicts (`firstUnsafe` save-time validation already runs), payment/wallet ops.
- New thin hooks only where nothing exists (e.g. report-received, block-received counters).

Implementation shape: a queue consumer + a small `SentinelDO` per user (or D1-only at first — start D1-only, promote to a DO if write contention appears). Every event is scored by **versioned, deterministic rules first** (velocity counts, report counts, listing-moderation fails); the LLM is only invoked on the cost staircase (same discipline as everything else): rule hit → cheap model summarises the pattern into mem0.

### 1.2 Evidence buckets (per review — not one score)

D1 table `sentinel_evidence(uid, bucket, score 0–100, updated_at, version)` with independent buckets:

```
identity_confidence   — liveness passes, attestation, account age
behaviour_confidence  — velocity patterns, mass-messaging, automation signals
community_reputation  — reports received/upheld, blocks received, group conduct
conversation_risk     — rolling per-conv grooming/scam arc (see §1.4)
marketplace_trust     — listing moderation history, deal disputes
media_risk            — upload moderation verdicts
financial_trust       — wallet/payment anomalies (future)
ai_probability        — human-presence confidence (liveness recency, response-pattern signals)
```

Rules for the buckets, ratified from the review:

- **Decay/repair:** every bucket drifts toward neutral over time; good behaviour repairs. Negative events are half-lifed (e.g. 60–90 days), never permanent labels. People get second chances.
- **Confidence framing:** the system speaks in confidence, never accusation — "Guardian confidence 27%: this account is behaving unusually," not "scammer."
- **Scope guardrail (hard, versioned allowlist):** only safety-relevant signals may enter a bucket — scam/spam patterns, upheld reports, fake listings, mass-messaging, moderation failures, account-takeover signals. **Never** politics, religion, lawful interests, adult content between adults, or message opinions. The signal allowlist is a versioned config reviewed like the Trust Engine's rule registry — this is what keeps it defensible and not a social-credit score.
- Buckets are internal. Products consume only the L0–L3 ladder + specific badges (frozen D6 rule preserved: raw scores never exposed to product code).

### 1.3 mem0 — the per-account behavioural memory persona

mem0 gives the Sentinel what D1 counters can't: *semantic pattern memory over time*.

- **Namespace:** one mem0 `user_id` per account uid (per-account scoping, bible rule #1; parent and child on a shared phone are separate personas).
- **What gets stored — patterns, never content:** "Created 3 listings flagged for scam wording within 48h (2026-07-04)," "Sent near-identical first-messages to 40 new contacts," "Conversation arc in conv dm_x escalated from friendly → investment pitch over 12 days." Written by the cheap-model summariser on rule hits, and by the chat shield when it flags.
- **What is FORBIDDEN in mem0:** raw message text, media, biometrics, protected attributes, anything from E2E/on-device-only surfaces. Store the *shape* of behaviour, not the speech.
- **Read path:** when the deep classifier evaluates a watched chat (v2 P4 slow lane), it retrieves the sender's Sentinel memories + the conv's risk memories as context — this is how "Day 1 hello … Day 18 don't tell anyone" grooming arcs get caught when any single message looks clean.
- **Lifecycle:** memories carry event dates; the summariser consolidates (mem0 handles dedup/update natively); purge entirely on account deletion (extend the existing [LIVE-PURGE-1] deletion path); export excluded from user-facing data export or included in redacted form — legal review item.
- **Authority rule:** mem0 is context, D1 is the scoreboard. No number in mem0 is ever authoritative; the deterministic buckets in D1 are what feed the Trust Engine. (Keeps decisions replayable and audit-clean even though an LLM curates the memory.)

### 1.4 Conversation risk score (the missing piece the review called out)

Per-(conv, sender) rolling score, D1 (`sentinel_conv_risk`), updated by the chat shield on every scan in guardian-ON chats: heuristic hits, classifier verdicts, escalation velocity (new-contact → money-talk time), off-platform-move requests. The deep classifier receives the current score + mem0 arc summary as context, and its verdict updates both. This upgrades Guardian from message-by-message to relationship-arc detection — the actual shape of romance scams and grooming.

## 2. Adaptive liveness — progressive, triggered, never a wall

Replaces v2-P6's mandatory gate. Liveness is invoked by the **Policy Engine** (new policy entries, frozen mechanism) when triggers fire — and its meaning is upgraded per the review: not identity, but **proof of human presence** ("Guardian Verified Human"), which is exactly the defence against AI-driven scam personas. The dynamic random challenge scripts in the frozen Tier-0 design (random multi-step, per-step timestamps) are already the right anti-AI shape.

**Trigger table (config-versioned):**

```
T1  Sentinel risk crosses threshold (e.g. behaviour/community < 40)   → request verification
T2  Marketplace listing creation                                       → phone OTP + liveness (frozen policy §9 — already ratified, unchanged)
T3  High-value / repeat-flagged listing                                → re-verify
T4  Guardian owner taps "Require verification" on a chat peer          → request verification
T5  Report volume threshold (e.g. ≥N upheld reports / 30d)             → request verification
T6  Guardian confidence "AI probability" high (bot-like patterns)      → human-presence challenge
```

**Progressive levels in a guardian-ON chat (per review):**

- **Level 1 — Guardian ON:** scanning + warnings only. Zero friction for grandma and the cousin.
- **Level 2 — suspicion (conv risk medium, or Sentinel risk elevated):** peer sees a soft prompt — "Complete a quick face check to show there's a human here." Peer's messages meanwhile carry an **⚠ Unverified** marker in this chat. The Guardian owner gets the control the review proposed: **Allow · Require verification · Block** — user choice, not system fiat.
- **Level 3 — high confidence of threat (conv risk high / repeat flags):** messages from the peer held/blocked in this conv until verification passes. This is the old hard gate, now earned by behaviour instead of imposed at toggle-time.
- Auto-pass: anyone with a recent valid liveness (account-wide, suggest 90-day validity) skips prompts silently. Minors are never required to record a face (they gate others only) — unchanged from v2.
- Group version: same levels per member; "verified human" checkmarks in group info; only enabler/admin can lower the level.

All verification itself runs through the frozen Trust Engine pipeline (VerificationDO, tiers, budget, manifests). The Sentinel never verifies anyone; it only asks the Policy Engine to.

## 3. What users see

- 🛡 shield per chat (v2 activation rules: explicit tap or stranger-accept; header off).
- Red bubbles + private warnings (v2, now synced via InboxDO per v2-P3).
- ⚠ Unverified / ✓ Verified Human states on peers when Level ≥2 engages.
- Owner controls on a flagged peer: Allow / Require verification / Block.
- Marketplace: ⭐ Trusted Seller from the same engine (existing L0–L3 ladder).
- Nothing else. Scores, buckets, mem0, and the Sentinel are invisible infrastructure.

## 4. Revised rollout (v2 plan renumbered + Sentinel phases)

```
G0  = v2 P0+P5   premium strip + media-scan removal (deletions, do first)
G1  = v2 P1+P2   activation model (explicit/stranger-on, header off) + chat-only guard
G2  = v2 P3      safety-flag state sync in InboxDO (+ seed on /sync)
G3  = v2 P4      inline two-lane live scan (flagged: guardianInlineEnabled)
S1  Sentinel core: event consumer + D1 evidence buckets + deterministic rules
     + decay job. No LLM, no mem0 yet. Dark, telemetry-only.
S2  mem0 persona: summariser writes behavioural memories; deep classifier reads
     them + conversation risk score. (flag: sentinelMem0Enabled)
S3  Sentinel → Trust Engine wiring: buckets feed History/Fraud weights;
     trigger table live in Policy Engine config. (Depends on Trust Engine P0/P3
     landing — the frozen build plan, currently NOT started.)
S4  Progressive liveness Levels 2–3 + Verified-Human badge + owner controls
     (flag: guardianGateEnabled). This is "Guardian 2.0" — last, as the review
     recommended.
```

Dependency note: S3/S4 need Trust Engine P0 (VerificationDO, rule registry) and P3 (score/policy) built — that work is frozen-designed but not begun, and its launch FaceProvider (AWS Rekognition) still lacks AWS creds on avatok-api (2026-07-05 memory). G0–G3 and S1–S2 have **no** dependency on it and can ship first.

Kill switches (all KV-merged, per the 2026-07-04 lesson): `guardianEnabled`, `guardianInlineEnabled`, `guardianGateEnabled`, `sentinelEnabled`, `sentinelMem0Enabled`.

## 5. Open decisions for owner

1. Sentinel storage: start D1-only (simpler) and promote to per-user SentinelDO later — OK? (Recommend yes.)
2. mem0: platform (managed) vs self-hosted for production Worker use — cost + data-residency call. Also: is Sentinel memory included in user data export (redacted) or excluded?
3. Bucket decay half-life (suggest 60–90 days) and the Level-2/Level-3 risk thresholds — ship dark, tune from telemetry before enforcement.
4. Trigger T5 report threshold, and whether "unverified" markers show in *all* chats or only guardian-ON chats (recommend guardian-ON only at launch).
5. Confirm the signal allowlist review process (who approves adding a new signal — recommend: owner sign-off, versioned in the spec, mirroring the Trust Engine rule registry).
