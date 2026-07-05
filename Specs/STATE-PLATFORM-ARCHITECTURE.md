# State Platform — Canonical Architecture

**Status: FROZEN 2026-07-05 (owner decision).** Governed by
`ENGINEERING-CONSTITUTION.md`; the universal laws are not restated here. This is the
single source of truth for what state is and how it exists, evolves, survives
failure, and is reconstructed. It **merges and supersedes** the separate Replication
(v6), Durability (v7), and Backup framings — those are no longer distinct
architectures. The word **"backup" is banned** here (constitution §5); we speak of
replication, durability, recovery, and reconstruction. Evolves only by amendment,
appendix, deprecation notice, or ADR.

---

## Purpose

Persist and reconstruct state. AvaTOK is an event-sourced state platform that happens
to send messages.

## Scope

Philosophy, core laws, aggregate roots, streams, operations, ordering, idempotency,
replication, projection, durability (including recovery and reconstruction), the
storage *abstraction*, media, scaling, telemetry, evolution rules, and the
implementation roadmap.

## Owns

- **Operations** — the immutable units of change.
- **Streams** — the ordered logs those operations live in.
- **Aggregate roots** — the entities that own streams.
- **Replication** — moving operations to every device.
- **Projection** — materializing operations into views.
- **Durability** — retention, checkpoints, verification, corruption detection,
  recovery, disaster recovery, reconstruction.
- **The storage abstraction** — the stable interface behind which bytes live.
- **Media** and **snapshots** as state concerns.

## Never Owns

- **Routing, presence, delivery, notifications** → **Messaging Platform.** State
  *remembers*; Messaging *moves*.
- **Whether an actor may perform an operation** → **Trust Platform.** State records
  attribution; it does not adjudicate trust.
- **Reasoning over state** (agents, memory-as-cognition) → **Intelligence Platform.**
- **The concrete storage providers** (R2, Google Drive, iCloud, OneDrive, NAS) →
  **Infrastructure Platform**, behind the Part X abstraction.

---

## Part I — Philosophy

Every mature system — WhatsApp, Signal, Discord, Slack, Linear, Figma, modern ledgers
— converges on the same shape: an event-sourced state platform. AvaTOK adopts that
shape deliberately, before feature count forces it. **Replication is the core.
Durability is a property of replication. Recovery and reconstruction are facets of
durability.** They are one system described at successive depths, which is why they
live in one document.

The catastrophic-failure test every release must pass: *if the local database, app,
secure storage, and every local byte are deleted, the user signs in, waits ~60
seconds, and everything comes back.*

## Part II — Core Laws

Specializations of the constitution:

1. Every user-visible state is reproducible from immutable operations. Nothing stores
   the final answer; the final answer is materialized.
2. The client references a stream and a position; the server owns operations,
   ordering, and truth.
3. One component owns any piece of truth; everyone else derives or caches.

## Part III — Aggregate Roots

The entity that **owns exactly one stream.** Ownership is frozen *before* sequence
allocation, because "ordered within a stream" only has meaning once "a stream belongs
to one aggregate" is settled. Examples (not the definition): Conversation, Wallet,
Marketplace Listing, Identity, Trust Record. **One aggregate → one stream.**

## Part IV — Streams

Defined as a concept first:

> **A stream is an append-only, ordered sequence of immutable operations, owned by
> exactly one aggregate root, and replicated independently.**

Concrete stream classes (Conversation, Wallet, Listing, Identity, Settings,
Notification, Profile, Trust) are *examples* of this definition. This part also
freezes:

- **Stream lifecycle:** Create → Open → Append → Snapshot → Archive → Merge → Split →
  Delete? → Restore. The legal transitions are defined here; "Delete?" is answered,
  not assumed. Load-bearing for groups, marketplace listings, wallet accounts, and AI
  agents.
- **Stream relationships:** how one stream references another, whether an operation
  may touch more than one stream (default: an operation belongs to exactly one
  stream), and whether cross-stream ordering guarantees exist.

## Part V — Operations

Defined by the **properties every operation must possess** — never by a frozen field
list (fields are implementation):

globally unique · immutable · belongs to exactly one stream · monotonically ordered
within that stream · idempotent · attributable to an actor · versioned · extensible ·
verifiable · replayable.

The serialized representation is specified far later, in implementation, and may not
weaken any property above.

## Part VI — Ordering

- **Sequence allocation: per stream.** Each stream carries its own monotonic
  sequence; no global bottleneck. Justified against global / per-conversation /
  per-user alternatives.
- **Idempotency (one formula, platform-wide):** an operation is uniquely identified
  within its stream by its actor and the actor's client-side operation identity. No
  subsystem invents its own dedup key.
- **Ordering guarantees per stream class:** guaranteed / eventually consistent / may
  reorder / cannot reorder — plus the conflict strategy per class (messages
  append-only, wallet strict-order, settings last-writer-wins, contacts merge, profile
  last-writer-wins, marketplace business-rules, trust append-only).

## Part VII — Replication

The server is the canonical owner; each device materializes a local cache by pulling
operations from a cursor. Replication guarantees, delivery of operations to devices,
and cursor management live here. Replication *moves operations*; it never redefines
what an operation is.

## Part VIII — Projection Engine

Owns every materialized view. Lifecycle contract: reset → rebuild → verify →
checksum → health. Projections are disposable — they can always be dropped and
rebuilt from operations.

## Part IX — Durability

The one question: *how does canonical state survive and come back?* Recovery is
**part of** durability, not a peer:

- **Retention** — hot / warm / cold / archive tiers per stream class.
- **Checkpoints** and **snapshots** — accelerators for reconstruction, never the
  thing that makes state survive.
- **Verification** — checksums and integrity proofs over operations and projections.
- **Corruption detection** — detecting and quarantining bad operations or views.
- **Recovery** — the ordered path from cold sign-in to ready:
  sign in → identity → streams → operations → projection → verify → ready.
- **Disaster recovery** — full reconstruction after total local loss (the
  catastrophic-failure test).
- **Reconstruction** — deterministic replay: same operations → same state on every
  device.

## Part X — Storage Abstraction

The **stable interface** through which durable bytes are read and written. The
platform depends only on this interface. Concrete providers are chosen in the
Infrastructure Platform; swapping or adding one is an implementation change, never an
architecture change.

## Part XI — Media

Media (avatars, post images, DM attachments, voice notes) as a state concern:
content-addressed (one real copy), cached on-device per account, referenced by
operations. Public vs. private media handling and the decrypted-bytes on-device cache
are defined here; the physical store is Infrastructure.

## Part XII — Scaling

How streams, operations, and projections scale: per-stream independence, sharding by
aggregate, compaction rules (when N operations may collapse into one snapshot, per
stream class), and the 1M-user growth model. Streams scale and fail independently by
design.

## Part XIII — Telemetry

Telemetry is part of **correctness**, not implementation (constitution §2.8). The
platform contract requires at minimum these events, none of them runtime-specific:
`operation_applied`, `operation_rejected`, `projection_rebuilt`, `checksum_mismatch`,
`replay_started`, `replay_completed`, `recovery_duration`, `snapshot_created`,
`verification_failed`. These define "is the system behaving correctly" before any
code is written.

## Part XIV — Evolution Rules

*(Placed before the roadmap deliberately: this document must outlive any roadmap.)*
New products join the platform by following the exact same operation-and-stream rules
— Wallet, Marketplace, Dating, Property, Hospital, Schools, the AI Marketplace, all of
them. No product gets a bespoke state model. Changes to this document are amendments,
appendices, deprecation notices, or ADRs (constitution §4) — never a new foundational
spec, never a `v9` or `v6.5`.

## Part XV — Implementation Roadmap

The (expirable) sequence for building toward the frozen architecture above. This is
the only part that ages; when it is complete or stale it is replaced, while Parts
I–XIV remain untouched. Roadmaps expire; architecture doesn't.
