# Guardian Sentinel — FINAL Plan v1.0 (2026-07-06)

Status: **FINAL draft for owner ratification.** Produced from the v3 draft + owner decisions + a two-round design review with ChatGPT (both AIs converged; disagreements resolved below). Supersedes `GUARDIAN-SENTINEL-APPWIDE-DRAFT-2026-07-06.md` and the P6 gate of `GUARDIAN-V2-DRAFT-PLAN-2026-07-06.md`. Extends — never reopens — `TRUST-ENGINE-ARCH.md` v1.1 (frozen) and obeys `ENGINEERING-CONSTITUTION.md` (frozen keystone).

---

## 0. Constitutional anchor

Per the Engineering Constitution's universal laws (single owner of every truth · clients cache, servers own · immutable operations · event sourcing · deterministic reconstruction · platform over feature), one sentence governs everything below:

> **Guardian Sentinel is a derived safety projection. Its entire state — evidence buckets, snapshots, SentinelDO caches, and mem0 behavioural memories — must be reproducible solely from the immutable event stream and versioned deterministic rules. No Sentinel component is a system of record.**

Platform placement: Sentinel belongs to the **Trust Platform** ("Can this entity be trusted?"). It is not a sixth platform and not a feature-private fork.

## 1. Architecture (ratified)

```
Marketplace · Messaging · Groups · Wallet · Guardian chat shield · Reports · Uploads
        │
        ▼
   Q_BRAIN / event bus  (ONE ingestion path, one ordering, one retry)
        │
        ▼
   Sentinel Consumer ──► deterministic extractors (versioned rules)
        │                        │
        │                        ▼
        │                EvidenceAdded ops  (append-only, D1)   ◄── single owner of truth:
        │                        │                                   the event/evidence log
        │                        ▼
        │                bucket = fold(evidence)  (snapshot + tail; decay computed at read)
        │
        └──► async queue ──► LLM summariser ──► mem0 (derived cache, language only)

   SentinelDO (per user) = HOT CACHE ONLY: velocity windows, last-N event ids,
   (recipient, conv, sender) risk cache, bucket cache, debounce/rate-limit.
   Crash ⇒ rehydrate from D1. Never historical, never authoritative.

   D1 = durable: evidence log, snapshots, audit, export, trigger history,
   conversation_aggregate (moderation projection, background-updated).

   Sentinel ──► TrustEvidence {bucket, value, confidence, timestamp, evidence_version}
           ──► frozen Trust Engine (Score Calculator + Policy Engine).
   The Trust Engine never knows mem0 exists. LLMs never emit numbers.
```

### 1.1 Hard rules (both reviews converged on these)

1. **LLM emits language only, never numbers.** Deterministic, versioned extractors own all numerical evidence. No LLM output ever changes a score, bucket, or decision — this also keeps the frozen Trust Engine's LLM-free law intact end to end.
2. **Evidence is append-only.** `EvidenceAdded {bucket, delta, reason, source_event, ruleset_version, ts, half_life}`. Scores are never overwritten; the current score is `fold(evidence)` over snapshot+tail (InboxDO cursor pattern keeps fold O(recent)).
3. **Decay is mathematical, not a cron.** Each evidence row carries its half-life; `effective_delta(now)` is computed at read time. Deterministic replay, no rewrites, no nightly jobs.
4. **Every derived value is versioned** (`evidence_version`, `ruleset_version`, `policy_version`) so "why was Behaviour=41?" is answerable months later — mirrors the Trust Engine rule registry.
5. **mem0 is a derived cache, never an owner of truth.** Every memory carries `derived_from: [event_ids]`, `summary_version`, `created_from_ruleset`. If mem0 vanished, all memories regenerate from the event log. mem0 writes are async (never on the message hot path). **Deletion: canonical deletion succeeds first; mem0 purge retries asynchronously until confirmed — an external SaaS can never block account deletion.**
6. **Evidence provenance checklist (mandatory on every evidence item):** which immutable event · which deterministic rule · which ruleset version · which policy version · which timestamp · replayable? · appealable? · expires?
7. **Signal allowlist:** safety-relevant signals only (scam/spam patterns, upheld reports, fake listings, mass-messaging, moderation failures, takeover signals). Never politics, religion, lawful interests, adult content between adults. **Changes require owner sign-off**, versioned in this spec's registry.

### 1.2 Resolved design points (the two debated items)

- **No ConversationRiskDO.** Conversation risk is user-scoped, not conversation-scoped — it answers "how risky is sender X *to recipient Y* in conv Z." It lives in each **recipient's** SentinelDO: a spammer messaging 600 people spreads across 600 DOs (no contention); the sender's own DO takes only cheap velocity increments. Matches the InboxDO ownership model. For moderation dashboards, a **D1 `conversation_aggregate` projection** (conv_id, unique_reporters, messages_flagged, participants_flagged) is updated by a background projector from events — nobody writes it synchronously, and cross-user queries never touch SentinelDOs.
- **Manual before automatic — "Guardian Detect" ships before "Guardian Act."** v1 ships detection + advice + *manual* controls (owner taps Require Verification → existing Trust Engine liveness → badge: no thresholds, no tuning, no false positives, and it satisfies the owner's "her vibes say I don't know this person" requirement). *Automatic* Level-2/3 threshold escalation — which needs weights, decay, hysteresis, cooldowns, and appeal UX all tuned — is deferred to v2. Users trust systems that advise before they trust systems that act.

### 1.3 Evidence buckets (v1 set — trimmed)

`identity_confidence · behaviour_confidence · community_reputation · conversation_risk · marketplace_trust · media_risk`. **Cut from v1:** `ai_probability` (hard to validate, false-positive-prone; liveness triggers already cover the value) and `financial_trust` (no bucket until wallet telemetry exists). Buckets are internal; products consume only the L0–L3 ladder + badges (frozen D6 preserved).

## 2. Owner decisions ratified (2026-07-06)

1. **SentinelDO per user from day one** (1M-user target) — with the hot-cache/durable-D1 split above.
2. **mem0 = managed cloud**, owner supplies API key (Worker secret `MEM0_API_KEY`, add to `secrets/secret-values.env`).
3. **Data export:** two artifacts. (A) Canonical export — events, bucket history, verification history, appeals, reports, policy actions (everything legally relevant). (B) Sentinel summaries — **redacted**: user sees *that* behavioural summaries exist, created-when, and a category-level reason ("repeated marketplace behaviour"); never the prompt, LLM text, weights, thresholds, internal confidence, or rule ids (fraud-prevention exemption). Satisfies GDPR access without tipping off scammers.
4. **Decay half-life + thresholds ship dark**, tuned from telemetry before any enforcement.
5. **T5 report threshold + ⚠ Unverified markers: guardian-ON chats only at launch.**
6. **Allowlist changes: owner sign-off only.**

## 3. Frozen build order

Each phase flag-gated and dark; KV-merged flags (`guardianEnabled`, `guardianInlineEnabled`, `sentinelEnabled`, `sentinelMem0Enabled`, `guardianGateEnabled`) — remember the 2026-07-04 lesson: patch KV, code defaults don't win.

| Phase | Scope (one line) |
|---|---|
| **G0 — Cleanup** | Strip all premium plumbing (isEntitled, 402 path, PaidFeature, deep_monitor collapse), delete media/deepfake scanning, consolidate kill switches. Pure deletions. |
| **G1 — Activation** | Guardian ON only via explicit shield tap or stranger-accept auto-on; header off-switch; chat-only scope (1:1 + group, never calls); minors force-ON. |
| **G2 — State sync** | Safety flags + dismissals persisted in InboxDO SQLite, seeded on /sync, live frames become store-and-forward. Fixes the confirmed cross-device gap. |
| **G3 — Inline detection** | Two-lane scan in guardian-ON chats: fast lane (regex + Nemotron, 400–600 ms budget, fail-open) before fan-out; deep classifier async; red bubbles + private warnings; deterministic evidence emission from every verdict. |
| **S1 — Sentinel core** | Q_BRAIN consumer · deterministic extractors · append-only EvidenceAdded + provenance · snapshot+tail fold · mathematical decay · D1 buckets + conversation_aggregate projector · SentinelDO hot caches. No LLM, no mem0, telemetry-only. |
| **S2 — Behaviour memory** | Async mem0 summariser (derived-only, derived_from ids, regenerable, deletion-retry). Written, not yet read on any hot path. |
| **T1 — Trust wiring** | TrustEvidence interface into the frozen Trust Engine; manual T4 "Require verification" trigger via Policy Engine; marketplace policy (phone OTP + liveness) unchanged. *Depends on Trust Engine P0/P3 being built (currently not started; AWS creds pending).* |
| **U1 — User experience** | ✓ Verified Human badge, ⚠ Unverified marker (guardian-ON chats only), Allow / Require verification / Block owner controls, group member verification states. |
| **O1 — Observability** | PostHog telemetry per stage, replay validation (rebuild buckets from events, diff against live), evidence audit views, export artifacts, threshold dashboards. |

**V2 (explicitly deferred):** automatic Level-2/3 escalation (Guardian Act) · conversation-level mem0 retrieval into the deep classifier · semantic grooming-arc summarisation (v1 keeps deterministic rolling counters for conversation_risk) · adaptive thresholds · ai_probability + financial buckets · advanced moderation analytics · voice-note transcript scanning.

## 4. What v1 delivers to users (Guardian Detect)

A free shield on every chat you choose to protect (or that protects you automatically when a stranger appears): live scanning before messages reach you, red-flagged bubbles that follow you across devices, private warnings only you see, one-tap Block/Report, and a "Require verification" button that makes the other side prove a live human face through the Trust Engine — with everything the system believes about anyone traceable, replayable, appealable, and impossible to turn into a social-credit score.

## 5. Remaining owner items before build starts

1. Ratify this document (freeze as v1.0).
2. Provide mem0 API key when S2 approaches.
3. AWS creds for the Trust Engine launch providers (still blocking Trust Engine P0+, hence T1/U1).
4. Confirm G0 can start immediately (it's deletions on guardian files only — safe for the shared tree, one issue per commit via `git_safe_commit.py`).
