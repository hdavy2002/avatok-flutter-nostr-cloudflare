# Phase 4 — AvaStorage + AvaLibrary (Universal File Pool)

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §2, §6; also
`Specs/proposals/avalibrary-avastorage-avabrain-proposal.md` (earlier design — reuse
its schema/quota work where it matches; THIS file wins on conflicts).
Prereq: Phase 1 (Phase 2 only needed for over-quota charging).

## ⚠️ ALREADY BUILT — verified 2026-06-10. Do NOT redo.
- **The file index EXISTS:** D1 `avatok-media-meta` → `user_media` +
  `user_media_hashes` (content-addressed) per `migrations/media.sql`, EXTENDED by
  `migrations/library.sql` with `category` (image|video|document|audio|other,
  backfilled from mime), `file_name`, `folder_id`, `deleted_at` (soft delete),
  `source_kind` (sent|received), `enc_blob`, plus `library_folders`.
  **Do NOT create `files_index` — `user_media` IS the index.** "registerFile" =
  the existing media-insert path; this phase's job is to VERIFY every upload
  route writes it (chat, /upload/public, future apps) and add what's missing.
- Upload pipeline + moderation chain (CSAM hash → NSFW → pHash → strikes) exist
  in `avatok-consumers`.

**Therefore this phase = quota + AvaStorage UI + live updates:**
`storage_quota` table, 5 GB enforcement at upload, 20 coins/GB/mo billing cron
(WalletDO `spend` + ledger `storage_charge` per Phase 2 reconciliation),
read-only-never-delete state, the AvaStorage screen (graphs from a per-kind
summary over `user_media.category`), live summary push over the InboxDO socket,
and the AvaLibrary Flutter screens over the EXISTING folder/category model.

## Objective
ONE per-account storage pool. Every picture, file, PDF, video, voice note uploaded
or received in ANY app (chat today; every future app) appears in AvaLibrary.
AvaStorage shows live usage: total vs 5 GB free quota, counts and colored bars per
type, updating live as uploads happen anywhere on the platform.

## Backend

### Canonical index (D1 `avatok-media-meta` → `files_index`)
```sql
CREATE TABLE files_index (
  hash TEXT NOT NULL,            -- content address (sha256) — ONE real copy
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- image|video|audio|pdf|doc|other
  bytes INTEGER NOT NULL,
  name TEXT, mime TEXT,
  source_app TEXT NOT NULL,      -- avatok|avalive|avaconsult|explore|...
  source_ref TEXT,               -- convId/listingId/...
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, hash, source_ref)
);
CREATE TABLE storage_quota (
  user_id TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0,      -- dedup-counted: each hash once
  quota_bytes INTEGER NOT NULL DEFAULT 5368709120,  -- 5 GB
  state TEXT NOT NULL DEFAULT 'ok',           -- ok|over_quota_paying|read_only
  updated_at INTEGER
);
```
- **Dedup:** same hash added from two apps = one real R2 object, counted ONCE in
  `used_bytes`; "add to folder" is a shortcut (rulebook §3).
- **Single ingestion choke point:** every existing upload path (`/upload/public`,
  DM media upload, future apps) calls `registerFile(user, hash, …)` after store.
  This is THE hook — no app writes R2 without it.
- Quota enforcement at upload: would-exceed 5 GB ⇒
  - wallet has coins ⇒ start/continue metered billing: **20 AvaCoins/GB/month**
    (monthly cron on `avatok-consumers`, ledger type `storage_charge`),
  - wallet empty ⇒ reject upload with `413 quota_exceeded`, account `read_only`.
    **NEVER delete user files** (rulebook §3).
- APIs: `GET /api/storage/summary` (used, quota, per-kind {count, bytes}, state),
  `GET /api/library?kind=&cursor=&q=` (paginated), `DELETE /api/library/:hash`
  (soft-delete; frees quota when last reference removed).
- **Live updates:** after each `registerFile`, push `{storageSummary}` event over
  the user's InboxDO socket (system event kind) so open AvaStorage screens update
  live without polling.

## Flutter

### AvaLibrary (`app/lib/features/library/` — extend existing)
- Tabs/chips: All · Images · Videos · Audio · PDFs · Docs. Grid for media, list
  for docs. Search by name. Item → preview (reuse media viewers) + "open in source
  app" + delete.
- Sources: merges server index with on-device per-account media cache
  (`…/media/<AccountScope.id>/…`); thumbnails via `/cdn-cgi/image/...` AVIF.

### AvaStorage (new `app/lib/features/storage/`)
- Header card: donut/radial — used vs 5 GB (or paid quota), $/coins charge if over.
- Stacked color bar + legend: images / videos / audio / pdf / other — bytes + count.
- Trend mini-bars (last 6 months usage; server keeps monthly snapshot row).
- Live: subscribes to the InboxDO storage event → animates graph on any upload
  from any app. Banner states: near-quota (≥80%), over-quota-paying, read-only
  (CTA → top up wallet, Phase 2).

### Hygiene
- All caches per-account scoped; chat upload path now also writes `registerFile`.
- AvaBrain ingestion (Phase 9) reads from this same index, gated by guardrails.
- Voice mails / voice notes register here too (`kind=audio`) and are browsable/
  playable in AvaLibrary; their Whisper transcripts (Phase 9) live in Vectorize
  for search but link back to the files_index entry.

## Acceptance criteria
- [ ] Upload an image in chat ⇒ appears in AvaLibrary; AvaStorage graph updates live.
- [ ] Same file sent twice / two apps ⇒ counted once in used_bytes.
- [ ] Filling >5 GB (test with lowered quota) with empty wallet ⇒ uploads blocked,
      read-only banner, nothing deleted; topping up unblocks.
- [ ] Per-kind counts/bytes match a manual D1 query.
- [ ] Two accounts on one phone see fully separate libraries/usage.

## Definition of done
Deploy, migration applied, Graphiti episode, STATUS_REPORT.md, push.
