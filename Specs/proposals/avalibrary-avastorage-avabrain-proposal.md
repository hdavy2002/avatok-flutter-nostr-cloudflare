# Proposal: AvaLibrary × AvaStorage × AvaBrain

**Project:** avaTOK-2-Flutter (AvaVerse)
**Date:** 2026-06-08
**Status:** proposal for the next build session (companion: `avalibrary-build-prompt.md`)
**Governing rules:** `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` (esp. Golden Rules 11 = per-account scoping, 12 = media caching; "brain gets PUBLIC content only, never DM plaintext").

---

## 1. Goal

Turn **AvaLibrary** into a single, cross-app file manager: **every file a user sends or receives in any AvaVerse app gets an entry in their Library**, organised as a folder tree — root folder per app (AvaTok, AvaDoc, AvaGram…), and inside each app, category folders (Images, Documents, Videos, Music, Other). Users can **create folders and move / copy / delete** files across them.

Two things hang off it:
- **AvaStorage** — the quota/usage view: coloured bars per type (Docs, Images, Video, Music…), total used, space left, tied to the user's plan.
- **AvaBrain** — the heart. Everything in AvaLibrary is **married to AvaBrain's vector/RAG**, so the AI can understand and retrieve the user's files (with a hard privacy boundary for end-to-end-encrypted DM media).

The foundations already exist; this is a wiring-up job.

---

## 2. What already exists (reuse, don't rebuild)

| Foundation | Where | Note |
|---|---|---|
| Per-user, cross-app media table | `user_media` (DB_MEDIA) | Columns: `npub, media_type, visibility (public/private), encrypted, key (sha256/bunny id), display_url, mime_type, size_bytes, original_app, created_at, moderation_status`. **Both** `/upload/public` and `/upload/private` already insert a row, tagged with `original_app`. This is the Library spine. |
| Library read API | `GET /api/library` (`getLibrary`) | Paginated by `created_at`, optional `?type=`. Returns the caller's `user_media`. |
| Upload paths | `/upload/public` (scanned) · `/upload/private` (E2E ciphertext, skipped) | Public → blossom URL; private → AES-GCM ciphertext, key travels in the DM envelope. |
| On-device media cache | `MediaService` (`…/media/<AccountScope.id>/<hash>`) | Per-account decrypted cache (Rulebook §12). |
| Public-image pipeline | `AvatarCache` / CF `/cdn-cgi/image` AVIF q60 | Standard for public image rendering. |
| Brain ingestion pipeline | `Q_BRAIN` → `consumers/src/brain.ts` | Extracts entities/relationships/facts (8B model), **embeds into Vectorize `avatok-semantic` (384-dim, bge-small)**, writes `brain_events/entities/relationships/facts` (DB_BRAIN). Public uploads already emit `upload_completed` to `Q_BRAIN`. |
| Brain retrieval | `GET/POST /api/brain/*` → `UserBrain` DO | Per-user; the DO does recall/search over the user's brain. |
| Storage prefix convention | `u/<npub>/<public|dm>/<hash>` | Per-user R2 ownership; erasure already cascades. |

### Gaps to close
1. **Receiver-side entries.** `user_media` records the *uploader*. "Sent **and received**" requires the recipient to also get a Library entry (referencing the same content-addressed blob + their decryption material) when they receive DM media.
2. **No category / folder model.** `user_media` has `media_type` (image/audio/video) but no `document`/`other` category, no `file_name`, no user folders, no soft-delete.
3. **No storage accounting API** for AvaStorage bars.
4. **Brain understands events, not file *content*.** `upload_completed` carries only `{hash, mime, size}` — not OCR/caption/transcript. Files aren't yet embedded as retrievable content.
5. **AvaLibrary UI is chat-scoped** (`media_library_screen.dart` builds from in-memory messages), not the global cross-app folder tree.

---

## 3. Target architecture

### 3.1 Data model (DB_MEDIA)

Extend `user_media` (additive, non-breaking):
- `category TEXT` — `image | video | document | audio | other`, derived from `mime_type` on insert.
- `file_name TEXT` — original display name.
- `folder_id TEXT NULL` — user folder placement; `NULL` = lives in its auto (system) folder.
- `deleted_at INTEGER NULL` — soft delete (storage recompute on set).
- `source_kind TEXT` — `sent | received` (default `sent`; receiver entries = `received`).

New `library_folders` (DB_MEDIA):
```
id TEXT PK, npub TEXT, app TEXT, name TEXT, parent_id TEXT NULL, created_at INTEGER
```
Index: `(npub, app, parent_id)`.

**Folder tree = system (virtual) + user (explicit):**
- **System folders** are derived, not stored: `app` (`original_app`) → `category`. Always present, auto-populated.
- **User folders** live in `library_folders`; a file with `folder_id` set appears there instead of (or in addition to, for copies) its system folder.

### 3.2 Auto-population (the "everything gets a copy" rule)

- **On every upload** (already happens): set `category` from mime and `file_name`. No new write path — just enrich the existing insert.
- **On receive of DM media:** add a recipient Library entry. The blob is content-addressed and already on R2; the entry stores the blob ref + the **decryption material encrypted to the recipient** (reuse the per-npub **Vault** pattern — server never sees plaintext keys). Recommended: `POST /api/library/record` `{ key, mime, size, name, app, source_kind:'received', enc_blob }`. (Or maintain it client-side first and sync via Vault; server entry is what makes it cross-device + brain-eligible.)
- Tag `original_app` per app (AvaTok today; AvaDoc/AvaGram later pass their own).

### 3.3 Folder operations

- **Create / rename / delete folder** → `library_folders` CRUD (`/api/library/folders`). Deleting a folder moves its files to the app's auto folder (don't orphan).
- **Move** → update `folder_id`. **Copy** → insert a new `user_media` row pointing at the **same `key`** (content-addressed → no re-upload, no extra storage charge; or count once — see §3.4). **Delete file** → set `deleted_at`; hard-delete via the existing erasure queue.
- **Drag-and-drop** in the client maps to move/copy.

### 3.4 AvaStorage (quota + usage) — FINALIZED

- **One universal pool per account, shared by all apps.**
- **Free: 5 GB** per account (configurable). **Over quota: 20 AvaCoins/GB/month** (configurable; 1 AvaCoin = $0.01) deducted from the **AvaWallet** — storage is one of several AvaCoin sinks.
- **Empty wallet over quota → READ-ONLY** (view/download only, can't add more) until top-up. **Never delete** the user's files for non-payment.
- `GET /api/storage` → `{ total_used, quota, by_category: {image, video, document, audio, other}, by_app: {...}, state: 'ok'|'read_only' }`, computed as `SUM(size_bytes)` over non-deleted, **distinct `key`** rows per npub (shortcuts/copies don't double-count).
- UI: coloured bars per category, total used / space left, and a clear "top up" prompt when read-only.
- AvaStorage is a thin reader over `user_media`; no separate store of truth. Monthly AvaCoin deduction handled by a scheduled job against the wallet.

### 3.5 AvaBrain marriage (vector / RAG) — with the privacy boundary

Extend the **existing** `Q_BRAIN` → `consumers/brain.ts` pipeline to ingest **file content**, embedding into the existing **Vectorize `avatok-semantic`** with metadata `{ npub, media_id, app, folder, category }` so retrieval can cite/open the exact file.

**PUBLIC files (visibility=public): server-side extraction is allowed.**
- Images → Workers AI vision caption + OCR.
- Documents (pdf/txt/docx/md) → text extract → chunk → embed (bge-small 384).
- Audio/video → Whisper transcription (later phase).
- Emit `library_file_added` to `Q_BRAIN`; the consumer extracts → embeds → links the vector to `media_id`.

**PRIVATE / E2E DM files: server must NEVER see plaintext (Rulebook + Golden Rule).**
- Default **OFF**. The server cannot decrypt; brain server-side ingestion is not permitted for these.
- Opt-in path: **on-device extraction** — the client (which holds the key) extracts text/caption locally and sends only derived, non-reversible material (a summary or the embedding vector itself) to the brain, tagged private-scope. Per-file or per-folder toggle ("Let AvaBrain read this").
- This keeps the "AvaBrain knows everything" promise for the user's *public* and *opted-in* content without weakening E2E.

**Retrieval:** `/api/brain` recall/search already routes to the UserBrain DO; file vectors carry `media_id`, so the brain can surface and deep-link Library files in answers (RAG).

### 3.6 Standards (non-negotiable)
- **Per-account scoping** everywhere (npub) — Library, folders, storage, caches (Golden Rule 11).
- **Caching** — list/thumbnails local-first; public thumbnails via CF AVIF; private via the per-account decrypted cache (Golden Rule 12).
- **Deletion/erasure** — Library + folders + vectors must be covered by the account-deletion cascade.

---

## 4. Phases

1. **Library data model** — migrate `user_media` (category/file_name/folder_id/deleted_at/source_kind) + `library_folders`; backfill `category` from mime. Enrich upload inserts. *(backend)*
2. **Library + folder APIs** — `/api/library` (tree by app→category, folder filter), `/api/library/folders` CRUD, move/copy/delete, `/api/library/record` (received entries via Vault-encrypted keys). *(backend)*
3. **AvaLibrary client** — global screen: app roots → category folders → user folders; create/rename/delete folders; drag/move/copy/delete; local-first cache. Wire AvaTok send/receive to record entries. *(client)*
4. **AvaStorage** — `/api/storage` + the bars UI. *(backend + client)*
5. **AvaBrain ingestion (public)** — `library_file_added` → vision/OCR/text-extract → embed into Vectorize with `media_id`; RAG retrieval cites files. *(backend, extends consumers/brain.ts)*
6. **Private opt-in** — on-device extraction + derived-only embedding for E2E files. *(client + backend)*

## 5. Acceptance criteria
- A file sent or received in AvaTok appears in AvaLibrary under `AvaTok → <category>` within seconds, on all the user's devices, scoped to the account.
- User can create a folder, move/copy/delete files (drag-and-drop), delete folders without losing files.
- AvaStorage shows correct per-category bars + total/space-left; copies don't double-count.
- A **public** Library file is retrievable via AvaBrain ("find my invoice from June") and the answer deep-links the file.
- **Private** DM files are NOT server-embedded unless the user opts in; with opt-in, only on-device-derived data leaves the device.
- Account deletion removes Library rows, folders, blobs, and vectors.

## 6. Decisions (FINALIZED 2026-06-08)
- **Storage:** one universal per-account pool for all apps. **5 GB free**, then **20 AvaCoins/GB/month** from the AvaWallet. Empty wallet over quota → **read-only, never delete**. (Numbers are config defaults, adjustable.)
- **Copy = shortcut.** One real (content-addressed) copy; "Add to folder" shows it in many places but counts against storage **once**. Bytes freed only when removed from all folders/trash. Editing a shared file changes it everywhere (label accordingly). Cache on-device + Cloudflare.
- **AvaBrain consent:** **default ON (opt-out)**. A **master switch in the main app Settings** (default ON) **plus granular per-app/per-capability toggles** (default ON; e.g. "read my AvaTok DMs", "keep a tab on my files"). Each app **registers its toggles into the main Settings** and ships **guardrail system prompts** scoped to its function. The ingestion pipeline must **check the toggle before learning** from any source. Unconditional guarantee: private/E2E content is read **on-device only** — only non-reversible derived data (summary/embedding) is sent. Revocable + purgeable; account deletion purges brain data.
- **Wire AvaBrain into the app Settings:** build the master switch + per-capability toggles into the main Settings screen, persisted per-account, and have both the server (`Q_BRAIN` producers) and on-device extractors gate on them.
- **Received media:** server-synced from day one — store the blob ref + decryption material **Vault-encrypted to the recipient** (server never sees plaintext keys).

All of the above is now codified in `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` (Golden Rules 13–15) and `CLAUDE.md`, so every current and future app follows it.
