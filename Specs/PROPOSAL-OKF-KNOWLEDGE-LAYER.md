# Proposal: Open Knowledge Format (OKF) as AvaVerse's portable knowledge layer
**Make the AvaBrain knowledge/metadata layer vendor-neutral, portable, and re-indexable — without changing how user data is stored or isolated.**
Date: 2026-06-26 · Status: **DECIDED — DEFERRED to future apps (not building for AvaTOK now)**
Decision owner: davy (hdavy2005)

---

## 0. Decisions finalized (2026-06-26)

Settled in session, so the record is unambiguous:

1. **OKF is NOT adopted for AvaTOK now.** It does not speed up lookups, and it does not
   improve ChatAVA↔Messenger sharing (they already share one store). So there is no
   near-term reason to add it to the live app.
2. **OKF IS the plan for FUTURE apps.** When we build the next app (AvaVoice/AvaVision/…),
   OKF-in-R2 becomes the portable, shared knowledge format so a new app can read/write the
   same knowledge without bespoke re-integration, and so we are not locked into Cloudflare's
   proprietary store. That is OKF's real value to us: vendor-neutrality + one common format
   across apps.
3. **AvaTOK's storage/scale/isolation/deletion are solved separately, NOT by OKF** — see
   **`PROPOSAL-AI-SEARCH-SHARDING.md`** (the decided plan): pooled sharded AI Search
   instances + per-user `<uid>/` prefixes, on **built-in storage**.
4. **"OKF-in-R2 as source of truth" is explicitly deferred, for one concrete reason:**
   OKF-in-R2 implies using R2 as AI Search's *data source*, which indexes on a **schedule**.
   AvaTOK's core "share a file and `@ava` it right away" feature needs **instant** indexing,
   which only **built-in storage** gives. So AvaTOK stays on built-in storage; OKF-in-R2 is
   revisited for future apps where scheduled indexing is acceptable.

The rest of this document is the design rationale, kept for when we pick OKF up for the next
app. It is **not** a current build item.

---

## 1. TL;DR

[Open Knowledge Format (OKF)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
is a vendor-neutral spec (Google Cloud, v0.1, 2026-06-12) for representing curated
*knowledge* as **a directory of markdown files with YAML frontmatter**. Each file is one
"concept" (a table, a metric, a runbook, a file descriptor); markdown links between files
turn the directory into a graph. No SDK, no runtime, no proprietary store — "just files,
just markdown, just YAML."

**What OKF is for us:** a portable, human-readable, re-indexable representation of the
**AvaBrain knowledge/metadata layer** — the curated facts *about* a user's data (file
descriptors, conversation summaries, durable profile facts, app/table schemas), distinct
from the raw payload (encrypted message bodies, file bytes).

**What OKF is NOT for us:** it is **not** a storage layer, **not** an isolation/encryption
mechanism, and **not** a retrieval engine. R2 keys + auth + the pooled-shard `<uid>/`
folder filter (see `PROPOSAL-AI-SEARCH-SHARDING.md`) + the Vectorize hard `uid` filter
remain the isolation boundary. Cloudflare AI Search / Vectorize remain the index. OKF sits
*between* the raw store and the index as the canonical, swappable knowledge format.

**The single reason to adopt:** today our curated knowledge is locked inside Cloudflare AI
Search's proprietary store + index format. If we ever move off CF (or add a second engine),
that knowledge doesn't travel. Emitting it as OKF bundles makes the knowledge layer portable
markdown we can re-index into any engine, while keeping CF as the default index.

---

## 2. How OKF maps to the four stated goals

| Goal | Does OKF help? | Reality |
|---|---|---|
| **Vendor-neutral** | ✅ Strong | OKF bundles are portable markdown, not tied to CF AI Search's format. The knowledge survives an engine swap. This is the strongest reason to adopt. |
| **Organize user data properly** | ✅ Partial | Great fit for the *structured/curated* part (descriptors, schemas, summaries, durable facts). Poor fit for raw payload — encrypted bodies & file bytes are unstructured content, not OKF concepts. OKF is the **catalog over R2**, not a replacement for R2. |
| **Isolate users' data in R2** | ⚠️ No (not its job) | Isolation comes from R2 key namespacing + auth + the pooled-shard `<uid>/` folder filter + the Vectorize `uid` filter (see `PROPOSAL-AI-SEARCH-SHARDING.md`). OKF can give a tidy convention (`users/<uid>/...`) but adds **no** security boundary. Do not treat it as one. |
| **AI search to retrieve** | ✅ Indirect | OKF is "indexable by any search tool" but is **not** the retriever. We still embed/index the OKF markdown into AI Search/Vectorize. The win: what we index is now portable & human-readable. |

**Honest verdict:** OKF is genuinely useful, but for a narrower slice than "vendor-neutral +
organize + isolate + search" implies. Adopt it as the *knowledge interchange format*; keep
the existing storage, isolation, and search layers exactly as they are.

---

## 3. Where this fits in the current pipeline (verified in code 2026-06-26)

- **`worker/src/routes/ava_rag.ts`** — each premium user gets a private Cloudflare AI Search
  instance `ava-<uid>` (built-in storage + vector index). `POST /api/ava/rag/ingest` indexes
  text or base64 files; `POST /api/ava/rag/search` queries. Hard isolation per uid.
- **`worker/src/lib/ava_memory.ts`** — `brainSearch()` queries Vectorize with a hard `uid`
  filter; the AI Search lane is the primary one the client `RagService` writes to.
- **`worker/src/do/ava_agent.ts`** — in-thread `#ava`/`@ava` agent; `files` intent recalls
  from the user's own store and grounds the answer.
- **`worker/src/do/user_brain.ts`** — the AvaBrain ingestion/recall ("our mem0").
- **R2** — `avatok-blobs` (media), `avatok-verification` (KYC). Bytes for E2E content are
  never server-readable; the server sees only descriptors.

OKF slots in as a **new producer/consumer pair around the existing stores** — it does not
replace any of the above.

```
 raw payload            knowledge layer (NEW: OKF)         index                retrieval
 ──────────             ─────────────────────────         ─────                ─────────
 R2 blobs       ──►   producer emits per-user OKF    ──►   AI Search /    ──►   #ava / ChatAVA
 InboxDO msgs         bundle (md + YAML frontmatter)       Vectorize            (files intent)
 user_media           in R2: okf/<uid>/...md               (swappable)
```

---

## 4. Design

### 4.1 Bundle layout (one per user, in R2)

```
okf/<uid>/
├── index.md                      # progressive-disclosure root (OKF convention)
├── log.md                        # chronological change history (OKF convention)
├── profile/
│   └── facts.md                  # durable AvaBrain profile facts
├── files/
│   ├── index.md
│   └── <media_id>.md             # one descriptor per library file
├── conversations/
│   ├── index.md
│   └── <conv>.md                 # summary + metadata per conversation (NO E2E plaintext)
└── apps/
    └── <toolkit>.md              # connected-app schema/capability notes
```

The **file path is the concept identity** (OKF rule). Concepts cross-link with normal
markdown links → the directory becomes a knowledge graph richer than the folder tree.

### 4.2 Concept document shape (OKF v0.1)

OKF requires exactly one field: `type`. We standardize a small frontmatter set
(`type, title, description, resource, tags, timestamp`) plus a markdown body. Example file
descriptor (`okf/<uid>/files/<media_id>.md`):

```markdown
---
type: LibraryFile
title: Q2 Board Deck.pdf
description: 14-page board deck; revenue, churn, hiring plan.
resource: r2://avatok-blobs/<key>
tags: [finance, board, pdf]
timestamp: 2026-06-26T10:00:00Z
---

# Summary
One-paragraph extracted summary for grounding.

# Links
Referenced in [conversations/g_abc123](/conversations/g_abc123.md).
```

### 4.3 Privacy invariant (non-negotiable)

- **No E2E plaintext in OKF.** 1:1 DM bodies are end-to-end encrypted and must never be
  written into a server-side OKF bundle. Conversation concept files carry **metadata +
  on-device-produced summaries only**, consistent with `DISCUSS-THIS-CHAT-WITH-AVA.md`.
- **AvaBrain consent gates production.** A concept is only emitted for content the user's
  AvaBrain toggles permit (opt-out, default ON; private/on-device-only content excluded by
  construction, same as `ava_memory.ts`).
- **Isolation stays where it is.** `okf/<uid>/` lives behind the same R2 auth + key
  namespacing as everything else. The path convention is organizational, not a boundary.

### 4.4 Producer (new, additive)

A worker library `worker/src/lib/okf.ts` with:

- `emitFileConcept(env, uid, media)` — write/update `files/<media_id>.md` on upload, reusing
  the descriptor `RagService.ingestFileBytes` already produces.
- `emitConversationConcept(env, uid, conv, summary)` — write `conversations/<conv>.md` from
  the rolling summary `ava_agent.ts` already keeps (metadata + summary only).
- `emitProfileFacts(env, uid, facts)` — mirror durable `user_brain.ts` facts into
  `profile/facts.md`.
- `rebuildIndexes(env, uid)` — regenerate `index.md` / `log.md`.

These are called from the **existing** ingest/turn paths — no new public route (keeps
`index.ts` frozen, per Phase 0).

### 4.5 Consumer (re-index, unchanged retrieval UX)

- An indexer reads `okf/<uid>/**.md` and feeds each concept into the **existing** AI Search
  ingest (`/api/ava/rag/ingest`) / Vectorize. Retrieval (`files` intent, ChatAVA) is
  untouched — it just now indexes portable source-of-truth markdown.
- Optional: ship Google's reference **static HTML visualizer** (single self-contained file,
  no backend) for internal debugging of a user's knowledge graph.

---

## 5. Synergy with two pending specs

- **`PROPOSAL-GROUP-DOC-RAG.md`** — a group's shared docs become a **group OKF bundle**
  (`okf/groups/<gid>/files/...md`) instead of being stranded in the uploader's private
  instance. OKF gives the shared store a clean, portable home; uploader-pays billing is
  unchanged.
- **`DISCUSS-THIS-CHAT-WITH-AVA.md`** — conversation concept files are a natural place to
  persist the cross-thread, on-device-produced context that feature needs, without indexing
  E2E plaintext server-side.

---

## 6. Scope & phasing

| Phase | Deliverable | Touches |
|---|---|---|
| **0** | This spec + OKF concept-schema doc (`type`s, frontmatter, filenames) | `Specs/` |
| **1** | `lib/okf.ts` producer; emit file + profile concepts on existing ingest paths | worker |
| **2** | Re-index OKF → AI Search/Vectorize (consumer); verify `files` intent unchanged | worker |
| **3** | Conversation concepts (metadata/summary only) + index/log rebuild | worker |
| **4** | Group OKF bundles (ties into Group-Doc-RAG) | worker |
| **5** | Static HTML visualizer for internal debugging (optional) | tooling |

**Out of scope:** replacing AI Search/Vectorize; changing R2 isolation; indexing any E2E
plaintext; any new public route.

---

## 7. Risks & non-goals

- **Risk: scope creep into "OKF as the database."** Mitigation: OKF is the *catalog*, raw
  payload stays in R2/InboxDO. Enforced by the privacy invariant (§4.3).
- **Risk: double-writing (AI Search store + OKF bundle) drifts.** Mitigation: make the OKF
  bundle the **source of truth** and AI Search a derived index rebuilt from it.
- **Non-goal: security via format.** OKF adds no isolation; do not market or rely on it as
  such.
- **Spec maturity:** OKF is v0.1 (explicitly "a starting point"). We pin to v0.1 conventions
  and treat extensions as additive.

---

## 8. Recommendation

Approve **Phases 0–2** as a low-effort, high-leverage win: it makes the AvaBrain knowledge
layer vendor-neutral and cleanly organized while leaving storage, isolation, and search
exactly as they are today. Defer Phases 3–5 to land alongside the Group-Doc-RAG and
Discuss-with-Ava features they reinforce.

---

*Sources: code verified 2026-06-26 — `worker/src/routes/ava_rag.ts`, `worker/src/lib/ava_memory.ts`, `worker/src/do/ava_agent.ts`, `worker/src/do/user_brain.ts`, `Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`, `Specs/PROPOSAL-GROUP-DOC-RAG.md`, `Specs/DISCUSS-THIS-CHAT-WITH-AVA.md`; OKF v0.1 — Google Cloud Blog, 2026-06-12.*
