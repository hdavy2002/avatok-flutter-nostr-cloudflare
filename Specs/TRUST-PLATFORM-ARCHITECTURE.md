# Trust Platform — Canonical Architecture

**Status: FROZEN 2026-07-05 (owner decision) — boundaries frozen; body deepens via
amendments/appendices against `TRUST-ENGINE-ARCH.md` v1.1 FROZEN.**
Governed by `ENGINEERING-CONSTITUTION.md`; the universal laws are not restated here.
This document elevates the frozen Trust Engine (`TRUST-ENGINE-ARCH.md` v1.1) from a
verification engine into the platform that owns *whether any entity can be trusted*
across the whole AvaVerse. The Trust Engine's detailed verification flow is an
appendix/implementation of this platform. Evolves only by amendment, appendix,
deprecation notice, or ADR.

---

## Purpose

Establish whether an entity — a human, an organization, a device, or an agent — can
be trusted, and to what degree.

## Scope

Human verification, organization verification, the trust graph, reputation,
credentials, permissions, moderation, abuse detection, and identity lifecycle. Design
horizon: 100M verifications over 10 years.

## Owns

- **Human verification** — liveness, document, and identity-consistency checks.
- **Organization verification** — business/entity legitimacy.
- **Trust graph** — the relationships and edges that propagate trust.
- **Reputation** — accumulated standing derived from behavior.
- **Credentials** — issued, verifiable claims about an entity.
- **Permissions** — what a verified entity is allowed to do.
- **Moderation & abuse detection** — identifying and acting on bad actors and content.
- **Identity lifecycle** — enrollment, re-verification, suspension, revocation.

## Never Owns

- **The device↔account connection at runtime** → **Messaging Platform** (Identity).
  Messaging knows *who is connected*; Trust decides *whether they can be trusted*.
- **Persistence of trust records** → **State Platform.** A trust decision is an
  operation on a Trust Stream (append-only); Trust owns the *meaning*, State owns the
  *survival*, of that record.
- **The AI/vision models used to score** as cognition → **Intelligence Platform**
  provides model execution; Trust owns the *policy* that turns evidence into a
  decision.
- **Where verification bytes are stored / the runtime** → **State/Infrastructure.**

---

## 1. The two laws (from the frozen Trust Engine)

1. **Cost staircase.** Never send a byte to the cloud unless the previous, cheaper
   stage has already passed. A failed verification costs ~nothing; only successes may
   cost money.
2. **No single AI decides anything.** Every stage contributes evidence; only the Trust
   Score Calculator, filtered through the Policy Engine, emits a decision — and every
   decision maps to versioned rule IDs. **Verification is LLM-free** by law.

## 2. Verification tiers (fast-fail → escalation ladder)

Fast-fail lane → Tier 0 (on-device, free, unlimited retries) → Tier 1 (small
frames+snippet to a per-session verification object, early-abort) → Tier 2
(escalation-ladder providers, likely-pass traffic only) → Identity Consistency →
Fraud Risk → Trust Score Calculator → **Policy Engine → PASS / REVIEW / FAIL** with
rule IDs, versions, and explanations. Face/moderation providers sit behind generic
`FaceProvider` / `ModerationProvider` interfaces (launch implementation: AWS
Rekognition), with a quota-aware circuit breaker (429 → fallback → REVIEW, never a
silent FAIL).

## 3. Trust graph & reputation

Trust is not a single boolean. The trust graph propagates standing across entities
(who vouches for whom, organization membership, transaction history), and reputation
accumulates from observed behavior. Both are read by Permissions.

## 4. Credentials & permissions

Verified attributes become **credentials** (verifiable claims). **Permissions** map an
entity's trust level, credentials, and reputation to what it may do (list on the
marketplace, take payments, run a receptionist, join a conference). Every other
platform *asks* Trust for a permission; none computes trust itself.

## 5. Moderation, abuse detection & identity lifecycle

Because AvaTOK is a closed, KYC-gated, server-readable community, moderation and abuse
detection are first-class here (scam/CSAM detection, lawful reporting). Identity
lifecycle governs enrollment, periodic re-verification, suspension, and revocation —
a trust decision is never permanent.

## 6. Telemetry contract

At minimum: `verification_started`, `verification_stage_passed`,
`verification_stage_rejected`, `trust_score_computed`, `policy_decision`
(pass/review/fail + rule IDs), `provider_quota_breaker_tripped`, `reputation_updated`,
`moderation_action`. Correctness of trust is measurable.

## 7. Evolution rules

Trust decisions are **operations on Trust Streams** in the State Platform
(append-only). The detailed Trust Engine flow (`TRUST-ENGINE-ARCH.md`) becomes an
implementation appendix of this platform. Changes are amendments, appendices,
deprecation notices, or ADRs — never a new foundational spec.
