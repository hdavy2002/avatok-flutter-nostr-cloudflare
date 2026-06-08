# AI Build Prompt — AvaLibrary × AvaStorage × AvaBrain

> Paste this as the opening message of the next build session. It is self-contained.

---

You are building the **AvaLibrary** file system for the AvaVerse (repo: `avaTOK-2-Flutter`), wiring it to **AvaStorage** (quota/usage) and **AvaBrain** (the AI vector/RAG layer). Foundations already exist — this is wiring-up, not greenfield. Work end-to-end (backend Workers + Flutter client), commit per phase, and deploy via the established flow.

## Before you write any code
1. **Read the rulebook:** `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md`. Obey it — especially Golden Rule 11 (ALL per-user local state account-scoped via `scopedKey`/`AccountScope.id`), Golden Rule 12 (media caching), and the standing rule that **AvaBrain only ingests PUBLIC content server-side — DM plaintext must NEVER leave the device / be seen by the server**.
2. **Read the proposal:** `Specs/proposals/avalibrary-avastorage-avabrain-proposal.md` (full design, data model, phases, acceptance).
3. **Pull Graphiti context** (group_id `proj_avaflutterapp`): search for AvaLibrary, AvaStorage, AvaBrain, user_media, Vectorize, brain pipeline. Save durable decisions back with `add_memory(group_id="proj_avaflutterapp")`.
4. **Decisions are FINALIZED** (proposal §6 + Rulebook Golden Rules 13–15): universal per-account storage pool (5 GB free, 20 AvaCoins/GB/month from AvaWallet, read-only never-delete on empty wallet); copy = content-addressed shortcut counted once + cached on-device & Cloudflare; AvaBrain default ON (opt-out) with a master switch in the MAIN APP SETTINGS + granular per-app consent toggles (all default ON) + per-app guardrail prompts, every toggle registered into the main Settings and checked by the ingestion pipeline, private content read on-device only; received media synced with Vault-encrypted keys. Build to these — don't re-litigate.

   **Also wire AvaBrain into the app Settings screen:** add the master AvaBrain switch + per-capability toggles (default ON, account-scoped persistence) to the main Settings; gate all ingestion (server Q_BRAIN producers + on-device extractors) on them; surface per-app toggles there.

## Reuse these foundations (do NOT rebuild)
- `user_media` table (DB_MEDIA) is the cross-app Library spine — both `/upload/public` and `/upload/private` already insert rows tagged with `original_app`. Extend it; don't replace it.
- `GET /api/library` (`worker/src/routes/media.ts → getLibrary`) — extend for the folder tree.
- `Q_BRAIN` → `consumers/src/brain.ts` → **Vectorize `avatok-semantic` (384-dim, `@cf/baai/bge-small-en-v1.5`)** — extend to embed file *content*, tagging vectors with `media_id`.
- `/api/brain/*` → `UserBrain` DO — retrieval/RAG path; make Library files retrievable.
- `MediaService` per-account decrypted cache; `AvatarCache` CF-AVIF pipeline; the encrypted per-npub **Vault** (`/api/vault`) for syncing private decryption material.

## Build order (commit each phase; bump app version; push to trigger CI APK)
1. **Data model** — migrate `user_media`: add `category` (image|video|document|audio|other, from mime), `file_name`, `folder_id` (nullable), `deleted_at`, `source_kind` (sent|received); add `library_folders(id,npub,app,name,parent_id,created_at)`. Backfill `category`. Enrich the existing upload inserts (don't add a new upload path). Apply D1 migration via the REST API (sandbox can't run wrangler migrate).
2. **APIs** — `/api/library` returns the tree (group by `original_app` → `category`, plus user folders; filter by folder; paginate). `/api/library/folders` CRUD (delete reparents files to the app auto-folder). Move (`folder_id`), copy (new row, same `key` — content-addressed, count storage once), soft-delete. `POST /api/library/record` for **received** media: store blob ref + decryption material **encrypted to the recipient via Vault** (server never sees plaintext keys). All dual-auth (NIP-98 + Clerk), all npub-scoped.
3. **AvaLibrary client** — replace the chat-scoped `media_library_screen` with a global screen: app roots → category folders → user folders; create/rename/delete folders; drag-and-drop move/copy; delete; local-first cache (account-scoped). Wire AvaTok send AND receive to ensure both parties get a Library entry. Add `avalibrary` (and `avastorage`) to `app/lib/core/apps.dart` and the shell (currently a coming-soon placeholder).
4. **AvaStorage** — `GET /api/storage` → `{total_used, quota, by_category, by_app}` (SUM size over distinct `key`, non-deleted). Client: coloured per-category bars + total/space-left. Quota from plan (tie to AvaWallet; default free quota in config).
5. **AvaBrain ingestion (PUBLIC files only)** — on Library add, emit `library_file_added` to `Q_BRAIN`; in `consumers/brain.ts` extract content (images → Workers AI vision caption + OCR; docs → text extract → chunk; audio/video → Whisper, later) → embed into `avatok-semantic` with metadata `{npub, media_id, app, folder, category}`. Make `/api/brain` recall surface + deep-link files (RAG).
6. **Private opt-in** — for E2E DM files, default OFF. Opt-in = on-device extraction; send only derived, non-reversible data (summary or the embedding vector) to the brain. Never send plaintext or the AES key to the server.

## Standards & guardrails (must hold)
- **Per-account scoping** on every store, cache, folder, and API (npub). No global keys.
- **E2E boundary:** private DM media is never decrypted server-side; brain server-ingestion is public-only; private is on-device opt-in.
- **Caching:** Library lists/thumbnails load local-first; public thumbnails via CF `/cdn-cgi/image` AVIF q60; private via the per-account decrypted cache.
- **Deletion:** extend the account-deletion cascade to remove Library rows, folders, blobs, and Vectorize vectors.
- **No local Flutter toolchain** — CI builds the APK on push to `main` (paths `app/**`); deploy Workers with the isolated `/tmp` wrangler + `secrets/cf_token`; apply D1 migrations via REST.

## Acceptance (verify before calling it done)
- A file sent/received in AvaTok shows in AvaLibrary under `AvaTok → <category>` within seconds, on all the user's devices, account-scoped.
- Create folder; drag to move/copy; delete file and folder — no data loss; copies don't double-count storage.
- AvaStorage bars are correct (per category + total + space left).
- A public Library file is found via AvaBrain and the answer deep-links it.
- Private DM files are not server-embedded unless opted in; with opt-in only on-device-derived data leaves the device.
- Account deletion purges Library rows, folders, blobs, and vectors.

When done, update Graphiti (`proj_avaflutterapp`) and the rulebook if any new standard emerged.
