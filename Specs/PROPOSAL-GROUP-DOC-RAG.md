# Proposal: Group Document RAG — "Share a PDF, the whole group can @ava it"
**Powered by Cloudflare AI Search (managed RAG) + the existing In-Thread Ava Spine**
Date: 2026-06-23 · Status: **DRAFT — awaiting owner approval**
Decision owner: davy (hdavy2005)

---

## 1. Your requirement, restated

In an AvaTOK **group chat**, a member uploads a **PDF** (or DOCX/PPTX/XLSX/TXT/image).
Ava ingests/"dissects" it, and then **any member of the group can discuss that
document with `@ava` in the thread** — Ava answers grounded in the shared file, and the
answer is visible to everyone.

Three design decisions you locked on 2026-06-23:

1. **Billing — uploader pays (premium).** The store that holds the group's documents is
   funded by the premium member who shares the file. Free members can still *ask* `@ava`
   about it; they just can't be the one who seeds it.
2. **No auto-dissect.** Sharing a doc indexes it **silently**. Ava does **not** auto-post
   a summary. Members get grounded answers only when they explicitly type `@ava`.
3. **Deliverable** = this spec in `Specs/`.

---

## 2. What exists today (the gap this closes)

Already shipped (verified in code 2026-06-23):

- **Per-user cloud RAG.** `worker/src/routes/ava_rag.ts` gives each *premium* user a
  private Cloudflare AI Search instance (`env.AI_SEARCH`, id `ava-<uid>`), with
  `POST /api/ava/rag/ingest` (text or base64 file) and `POST /api/ava/rag/search`.
  Hard isolation: *"one user can never search another's files."*
- **Doc upload already ingests — but only for the sharer.** In `chat_thread.dart`,
  `_sendMedia` fires `RagService.I.ingestFileBytes(...)` for any `MediaKind.file`/`image`
  (File Search accepts PDF/Office/text/PNG/JPEG). It indexes into **the sharer's own
  private store**.
- **`@ava` in a group already fans out to everyone.** `routes/ava_thread.ts` →
  `AvaAgentDO.turn()` (`do/ava_agent.ts:506`) accepts a `store` param and queries it;
  a non-private answer is `postAvaMessage`'d to every participant.

**The three things missing for your ask:**

1. The shared store is the **uploader's private instance** — recipients' `@ava` turns
   query *their own* (empty) store, so only the uploader gets grounded answers.
2. Recipients never index a **received** file — `chat_thread.dart:488` skips media on the
   incoming path (`media == null`), so a shared PDF never lands in anyone else's store.
3. There is **no group-scoped store** that every member's `@ava` turn can point at.

We deliberately will **not** "just share the uploader's personal instance" — that
instance also holds their private notes and chat history, so handing it to other members
would leak private content. We create a **dedicated group store** instead.

---

## 3. Design

### 3.1 One dedicated store per group

For a group conversation `g_<uuid>`, create a **group-scoped AI Search instance**, id
`grp-<gid-slug>` (lowercase alnum + hyphens, ≤50 chars — same scheme as `instanceId()`).
This instance contains **only** documents shared into that group. It is separate from
every member's personal `ava-<uid>` instance, so personal RAG stays private and the
group store is safe for all members to query.

A KV pointer records ownership and existence:

```
group_docstore:<gid>  →  { store: "grp-<slug>", sponsorUid, createdAt, docCount }
group_doc:<gid>:<docId> → { name, mime, byUid, ts }   // per-doc index, for listing/telemetry
```

### 3.2 Ingest path (silent, uploader-pays)

When a member shares a supported file in a group thread:

1. Client calls a new endpoint **`POST /api/ava/group/doc/ingest`** with
   `{ gid, name, mime, contentB64 }` (replaces the personal `ingestFileBytes` call on the
   group path; DM path is unchanged).
2. Server: **require the sharer to be premium** (`isPremiumAI`). If not premium →
   `premiumUpsell` (the file still sends as normal chat media; it's just not indexed).
3. Get-or-create `grp-<slug>`; if the pointer is new, set `sponsorUid = sharer`.
4. `inst.items.uploadAndPoll(name, bytes)` → index. `chargeFeature(... "ava_memory" ...)`
   billed to the **sharer** (uploader pays).
5. Write `group_doc:<gid>:<docId>` and bump `docCount`. **No message is posted** — silent.

The file still goes through the normal encrypted media pipeline
(`MediaService.encryptAndUpload` → R2) for chat display. The **plaintext** copy that AI
Search indexes is consistent with the **server-readable** Cloudflare-native architecture
(`AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`) — group docs are explicitly *not* E2E content.

### 3.3 Query path (any member, on `@ava`)

When **any** member types `@ava` in a group thread:

1. `chat_thread.dart` already routes to `POST /api/ava/thread/turn`.
2. `routes/ava_thread.ts` resolves the conv. **New:** if `conv.startsWith("g_")`, look up
   `group_docstore:<gid>` and, if present, set `store` to the **group** store
   (`grp-<slug>`) instead of the caller's personal store.
3. `AvaAgentDO.turn()` already queries `store` via File Search and answers. The non-private
   answer fans out to the whole group — exactly today's behavior, now grounded in the
   shared doc.

Net change to the hot path: **one KV read** in `ava_thread.ts`. The agent DO is untouched.

### 3.4 Personal + group store together (stretch, Phase 2)

`turn()` takes a single `store` today. A small extension lets a turn search **both** the
caller's personal store *and* the group store (File Search accepts multiple
`file_search_store_names`). Phase 1 ships group-store-only on the group path to keep the
change minimal; Phase 2 merges both arrays.

---

## 4. Money rules (AvaTOK terminology — "AvaCoins", never "credits")

- **Ingest is gated on the sharer being premium and billed to them** (uploader pays).
  Reuses the existing `ava_memory` feature charge.
- **Queries are billed to the store `sponsorUid`** (the funding premium member), *not* the
  asker — so a **free** member can still `@ava` the shared doc. This is what "uploader pays"
  buys the group.
- **Guardrail cap.** To bound the sponsor's exposure, a **monthly group-doc query cap** per
  group store (default TBD — see Q1). Over the cap, the group store goes **read-only**:
  `@ava` answers fall back to chat-only (no doc grounding) until the next cycle or a top-up.
  Mirrors the AvaStorage rule: *"empty wallet over quota = read-only, never delete."*
- **Sponsor departure.** If the `sponsorUid` leaves the group, sponsorship **transfers to
  the next premium member who shares a doc**; until then the store is read-only. Documents
  are **never auto-deleted**.

---

## 5. Privacy, consent & scoping (rulebook compliance)

- **AvaBrain consent.** Add a **per-group "Discuss documents with Ava"** guardrail toggle,
  registered into the main Settings and gated by the master AvaBrain switch (ON by default,
  opt-out — per the rulebook). The ingest endpoint checks it; OFF → no indexing.
- **Per-account scoping.** All new local state — the cached group-doc list, "indexed ✓"
  markers, the toggle value — is namespaced with `scopedKey(...)` / `AccountScope.id`
  (parent + child share a phone). No raw global keys.
- **Server-readable by design.** Group docs are indexed in plaintext in the group store.
  This is intentional and consistent with the Cloudflare-native pivot; it is **not** for
  private DM / E2E media, which stays on-device-only regardless of any toggle.
- **Member-only access** is enforced by the fact that only a group thread's `@ava` turn can
  resolve that group's store pointer; the store id is never returned to clients.

---

## 6. Backend changes (worker)

| File | Change |
|---|---|
| `routes/ava_group_doc.ts` *(new)* | `POST /api/ava/group/doc/ingest`, `GET /api/ava/group/doc/list?gid=`, optional `DELETE`. Premium-gate, get-or-create `grp-<slug>`, write KV pointers, charge sharer. |
| `routes/ava_thread.ts` | On `conv.startsWith("g_")`, read `group_docstore:<gid>` and prefer the group store for `store`. |
| `index.ts` | Wire the new routes. |
| `lib/ava_rag.ts` (stale) | The unused Gemini-File-Search helpers (`ingestBytes`/`ingestText`) stay deprecated — Cloudflare AI Search is canonical. |
| Query-cap + sponsor logic | Small helper module reading/writing the KV pointer + a monthly counter key. |

## 7. Client changes (Flutter)

| File | Change |
|---|---|
| `core/rag_service.dart` | Add `ingestGroupDoc(gid, bytes, mime, name)` → new endpoint; keep `ingestFileBytes` for DMs/personal. |
| `features/avatok/chat_thread.dart` | On the **group** media path, call `ingestGroupDoc(...)` instead of personal ingest. Show a subtle **"Ava can discuss this ✓"** affordance on the bubble when indexing succeeds (no chat message). |
| Group info / settings | "Discuss documents with Ava" toggle + a small **"Shared documents"** list (from `GET .../list`). |
| Non-premium UX | If the sharer isn't premium, the file still sends; show a one-line upsell ("Go premium to let the group ask Ava about this"). |

## 8. Telemetry (PostHog — must carry email + phone)

New events, each with `user_email` + `user_phone` for support pulls (per project rule):
`group_docstore_create`, `group_doc_ingest` (gid, name, mime, bytes, sponsor),
`group_doc_query` (gid, grounded:true/false, over_cap:bool), `group_doc_ingest_blocked`
(reason: not_premium | toggle_off | over_cap). Leave existing telemetry intact; add only.

---

## 9. Phased build plan

- **Phase 1 — Core loop.** New ingest endpoint + KV pointer; `ava_thread.ts` group-store
  resolution; client group-ingest call. Result: premium member shares a PDF → any member
  `@ava`s it → grounded answer to the whole group.
- **Phase 2 — Controls.** Per-group AvaBrain toggle, "Shared documents" list, sponsor
  transfer + monthly query cap + read-only fallback.
- **Phase 3 — Personal+group merge.** `turn()` searches both stores; "indexed ✓" bubble
  affordance; non-premium upsell polish.

---

## 10. Open questions for owner sign-off

- **Q1 — Query cap.** What's the monthly group-doc query cap per store before read-only
  (e.g. 200 / 500 / unlimited)? Drives the sponsor's cost ceiling.
- **Q2 — Query cost attribution.** Confirm queries bill the **sponsor**, not the asker, so
  free members can use it. (This spec assumes yes — it's what "uploader pays" implies.)
- **Q3 — Multi-uploader stores.** One store per group with the **first premium sharer** as
  sponsor and later docs from any premium member added to it (this spec's assumption) — or
  one store *per sharer* within the group? Single shared store is simpler and matches the
  "group discusses the document" goal.
- **Q4 — Retention.** Keep group docs indefinitely (never auto-delete, per AvaStorage
  rule), or expire after N days of group inactivity to reclaim index space?
- **Q5 — Supported types.** Confirm the indexed set = PDF, DOCX, PPTX, XLSX, TXT/MD/CSV,
  PNG/JPEG (File Search multimodal). Audio/video are excluded.
