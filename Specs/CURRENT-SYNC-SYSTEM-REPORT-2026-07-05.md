# Current Sync / New-Device Restore System — As-Built Report (2026-07-05)

Scope: how a returning user's data comes back when they sign in on **another
phone / fresh install**. Sourced from the live codebase + Graphiti
(`proj_avaflutterapp`). Feeds the **v5 Sync Engine** draft.

## TL;DR

Restore is **"just sign in with Clerk."** No password, no recovery key. Three
independent data planes rebuild the device, each with its own recovery path:

1. **Messages (DMs + groups)** → replayed from the server-authoritative **InboxDO**
   by a cursor. Durable forever by default.
2. **Contacts + prefs (the vault)** → decrypted with an **Account Encryption Key
   (aek)** that is **escrowed server-side** and pulled back on the new device.
3. **Full SQLite snapshot + media** → **BackupService** to the user's **Google
   Drive (free)** or **R2 (premium)**, unlocked by a **backup passphrase (`bk`)**
   that is also escrowed.

These three are **not coordinated by a single cursor** — that's the main gap, and
exactly what the v5 Sync Engine (`conversation_id + last_server_sequence`) should
unify.

## 1. Identity / credential model

`app/lib/core/account_restore.dart`: post-Nostr, **the Clerk sign-in is the only
credential** — "signing in IS the recovery." `needsRecovery` is retired. On a
device with no local state, `AccountRestore.restoreFromServer()`:

- `GET /api/me` (Clerk JWT) → **found** → `_install()` sets the device up
  automatically → dashboard; **not found** → onboarding; **server unreachable** →
  `unavailable` retry screen (never onboarding, so an existing user can't
  accidentally fork a second account).
- A fresh local keypair is minted silently — vestigial; the server no longer
  verifies it.

## 2. Plane A — Messages (InboxDO cursor replay) — PRIMARY

**Server (`worker/src/do/inbox.ts`):** every user has a per-user **InboxDO keyed
by uid**. `POST /append` writes a message into each member's inbox; `GET
/sync?cursor=N` (or the WS `{type:'hello', cursor:N}`) **replays every row with
id > cursor** (`SYNC_LIMIT = 500` per page) then streams live. Messages are
**kept forever by default** — `INBOX_RETENTION_DAYS` unset/0 = no pruning;
optional daily-alarm prune + R2 cold-archive (`chatArchiveV2`) only when enabled.

**Client (`app/lib/sync/sync_hub.dart`):** one WebSocket to the user's InboxDO.
Holds `_cursor` = highest ingested InboxDO id, **persisted per account** on disk
(`ava_inbox_cursor`). On connect it sends `hello{cursor}`, ingests backlog since
the cursor into **local SQLite**, and fans `HubEvent`s to the UI.

- **New device:** local cursor = 0 → InboxDO replays the **full backlog** → local
  SQLite rebuilt. This is the core "my chats come back by signing in."
- `forceResync()` / `syncFromPush()` re-send the cursor to pull what a push
  hinted. `_ingestMsg` de-dupes by message id, so replays are idempotent.

**Groups:** server-backed via `conversation_members` (D1). A new device
re-materializes a group through **`/api/conversations/adopt`**
(`messaging.ts` ~L1050) so groups aren't lost (fix for the earlier
"reinstall wiped local-only groups" bug).

## 3. Plane B — Vault (aek escrow) — contacts + prefs

**`app/lib/core/account_key.dart` + `worker/src/routes/keybackup.ts`:** the vault
(contacts, prefs, private-media keys) is encrypted with a random 32-byte
**Account Encryption Key (aek)**, **escrowed server-side** at `/api/keybackup`,
**wrapped** (AES-GCM, HKDF-SHA256 from `KEY_WRAP_MASTER`) under the uid.
`ensureHex()` order: **local → server escrow (restore) → mint + escrow.** So a new
phone pulls the aek back and every uid-keyed vault blob decrypts (`key_restore_ok`
telemetry). **Server-escrow, not zero-knowledge** — deliberately consistent with
the already server-readable chats, so users never need a passphrase.

## 4. Plane C — BackupService (full SQLite + media)

**`app/lib/features/ava_backup/backup_service.dart`:** exports on-device SQLite
(the source of truth, `avatok_<scope>.sqlite`), **client-side encrypts**
(AES-256-GCM, PBKDF2-HMAC-SHA256 200k from a per-account random passphrase), ships
to one of two lanes:

- **FREE — Google Drive** ("avatok-backup" folder in the user's own Drive via
  server-mediated `DriveService`). Ungated.
- **PREMIUM — R2** (`/api/backup`, server-readable cross-device restore, gated;
  402 → top-up).

The **backup passphrase is escrowed as `kind=bk`** at `/api/keybackup`
(**first-write-wins**; the server never blindly overwrites — the client **adopts**
the escrowed value). That's what makes restore work on a new phone: the blob sits
in the user's Drive, the wrapped key in our D1 — a Clerk sign-in recovers both.
Restore overwrites the on-device SQLite **safely** via `Db.reset()` (close → swap
file → reopen). **Media** backs up **incrementally** (already-uploaded blobs
skipped, ~40 MB cap) and chat-media plaintext is re-cached on demand.

## 5. How the planes combine on a new phone

```
Clerk sign-in
  → GET /api/me → restored → _install()
  → AccountKey.ensureHex(): fetch aek escrow → decrypt vault (contacts, prefs)
  → SyncHub hello{cursor:0} → InboxDO replays full message backlog → local SQLite
  → /api/conversations/adopt → groups re-materialized
  → (optional) BackupService.restoreFromDrive()/R2 → SQLite snapshot + media
```

Everything is best-effort and self-healing: a plane that fails at sign-in is
retried on the next launch (e.g. `key_restore_ok` on a later boot).

## 6. Gaps & risks (input for v5)

1. **No unified sync cursor across planes.** Messages sync by a single global
   **InboxDO id-cursor**; the SQLite/media snapshot is a *separate* periodic lane;
   the vault is a third. They aren't coordinated, so a new device can hold InboxDO
   replay **and** a possibly-staler Drive snapshot, reconciled only by client_id
   de-dupe. → v5 should make **`conversation_id + last_server_sequence`** the one
   cursor and treat the SQLite snapshot as a cache/accelerator, not a truth source.

2. **Cursor is global, not per-conversation.** `_cursor` = highest InboxDO id.
   Doesn't support per-conversation catch-up, partial sync, or multi-device fan-in.

3. **Multi-device is not first-class.** Model is "one device restores the full
   backlog." No per-device cursor or presence fan-out; two concurrently-active
   devices aren't a designed case yet (matches the v4 "multi-device matters
   later" note).

4. **Two sources of truth for the same messages.** InboxDO (authoritative + live)
   vs. the encrypted SQLite snapshot (periodic) overlap — this violates the v4
   "**only one component owns any truth**" principle. Transport/InboxDO should own
   message truth; the backup is really a cache.

5. **`/api/conversations/adopt` is a patch, not a model.** In the v4 design,
   Conversation owning participants makes a new device list its conversations by
   identity automatically — no explicit "adopt" step.

6. **Secure-storage fragility.** aek + keypair live in `flutter_secure_storage`,
   which threw `BAD_DECRYPT`/BadPadding after OS updates (boot self-heal + Android
   backup exclusion added). Escrow mitigates data loss, but it's a known sharp
   edge on the recovery path.

7. **Partial-restore windows.** Because the planes recover independently and
   best-effort, a device can be "messages back, contacts not yet" until a later
   launch completes the vault fetch.

## 7. How v3/v4 changes this

The target architecture folds these three ad-hoc planes into named owners:
**Transport/SessionDO** owns durable message truth (Plane A), the **Sync Engine
(v5)** owns cross-device catch-up by `conversation_id + last_server_sequence`
(replacing the global cursor + the snapshot-reconciliation gap), **Conversation**
owning participants removes `/api/conversations/adopt`, and the vault/backup
passphrase escrow stays as the identity-key recovery mechanism. The current system
already has the two hardest pieces right — **server-durable messages** and
**recoverable-by-sign-in keys** — which is a strong base to build the unified Sync
Engine on.

---
*Files: `account_restore.dart`, `sync_hub.dart`, `account_key.dart`,
`backup_service.dart`, `worker/src/do/inbox.ts`, `worker/src/routes/keybackup.ts`,
`worker/src/routes/messaging.ts` (adopt). Graphiti: backup-restore-pipeline-fixed-
2026-07-02, data-loss-on-reinstall-2026-06-30, local-message-cache,
secure-storage-bad-decrypt-2026-07-03.*
