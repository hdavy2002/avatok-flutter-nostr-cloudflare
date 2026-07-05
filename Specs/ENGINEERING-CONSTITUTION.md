# AvaTOK Engineering Constitution

**Status: FROZEN 2026-07-05 (owner decision) — the keystone above all platform
documents.** Every platform architecture references this file instead of restating
its principles. This document is short by design (keystone, not handbook). It changes
only by amendment or ADR (§4), never by replacement. Part of the permanent AvaTOK
Engineering Bible; future architectural work happens through amendments and ADRs, not
new foundational specs.

> **The whole of AvaTOK is built from exactly five platforms, governed by one set of
> laws. Features are assembled from platforms; platforms are governed by this
> constitution.**

---

## 1. The five platforms

AvaTOK has exactly five canonical platform documents. Each owns one foundational
question. No sixth platform may be created; new capability is assigned to whichever
existing platform owns its question.

| Platform | The question it owns |
|---|---|
| **Messaging Platform** | How does information move? |
| **State Platform** | What is state, and how does it exist, survive, and reconstruct? |
| **Trust Platform** | Can this entity be trusted? |
| **Intelligence Platform** | How does the platform think? |
| **Infrastructure Platform** | Where does everything run? |

Every feature — a wallet, a marketplace listing, a group call, a receptionist, a
dating profile, a hospital record — is built *from* these platforms. A feature is
never its own architecture.

---

## 2. The universal laws

These hold in every platform. A platform document may specialize a law but may never
contradict it.

1. **Single owner of every truth.** Exactly one component owns any piece of truth.
   Everyone else derives or caches it. No duplicated ownership, ever.
2. **Clients cache; servers own.** The client never decides where state lives or
   where information goes. It references a stream, a conversation, or a position; the
   server owns truth, ordering, and routing.
3. **Immutable operations.** State changes are expressed as immutable, append-only
   operations. Nothing overwrites the "final answer" — the final answer is
   materialized from operations.
4. **Event sourcing.** Every user-visible state must be reproducible from its
   operations. If the materialized view is lost, it can be rebuilt.
5. **Deterministic reconstruction.** Given the same operations, every device
   reconstructs the same state. Recovery is a defined, repeatable procedure — not a
   heroic one-off.
6. **Platform over feature.** Capability lives in a platform and is reused. Features
   compose platforms; they do not fork them or embed private copies of platform
   concerns.
7. **No duplicated ownership across platforms.** If two platforms seem to own the
   same thing, the boundary is wrong — fix the boundary, don't duplicate the truth.
8. **Everything observable.** Correctness is measurable. Each platform defines its
   own telemetry contract as part of its architecture, not as an implementation
   afterthought.
9. **Security by default.** Access is denied unless granted; secrets are never
   embedded; per-account isolation is mandatory wherever one device is shared by
   multiple accounts.
10. **Offline-first.** The device works from its local cache and reconciles with the
    server; connectivity is an optimization, not a precondition for basic function.

---

## 3. Boundary discipline — Purpose / Scope / Owns / Never Owns

Every platform document **must** open with the same four sections, so boundaries are
explicit and drift is visible:

- **Purpose** — the one sentence describing what the platform is for.
- **Scope** — what the document covers.
- **Owns** — the truths this platform is the single owner of.
- **Never Owns** — the truths that belong to other platforms, named explicitly.

If a change would make a platform own something in another platform's **Never Owns**,
the change is wrong by construction. This is the primary defense against architecture
drift.

---

## 4. The freeze rule (permanent)

The five platform documents plus this constitution are the **permanent engineering
bible.** Once frozen:

> **No new architecture documents may be created for any platform.** Every
> architectural change is expressed as exactly one of:
>
> 1. **Amendment** — an edit to the canonical document, preserving it as the single
>    source of truth.
> 2. **Appendix** — additive detail attached to the canonical document.
> 3. **Deprecation Notice** — a formal record that something is being removed.
> 4. **ADR (Architecture Decision Record)** — a dated, numbered record of a decision
>    and its rationale.

No v9. No v10. No v6.5. No parallel specs. The canonical documents evolve in place.

---

## 5. Vocabulary

Words shape architecture, so a few are fixed:

- **"Backup" is banned from architecture.** It is one implementation strategy, not an
  architectural concept. Use **replication, durability, recovery, reconstruction**
  instead. "Backup" may appear only in an appendix documenting migration from the old
  design.
- **"Sync" is discouraged.** The system *replicates* immutable operations; it does not
  copy-and-merge databases.
- **"AI Platform" is not used.** The platform that thinks is the **Intelligence
  Platform** — a boundary that outlives whichever technology powers it.

---

## 6. How to use this constitution

Every platform document begins by referencing this file: *"Governed by
`ENGINEERING-CONSTITUTION.md`; the universal laws are not restated here."* When a
principle applies across platforms, it lives here and is cited — never copied. That
keeps each platform document focused on its own responsibility while the whole
architecture shares one consistent foundation.
