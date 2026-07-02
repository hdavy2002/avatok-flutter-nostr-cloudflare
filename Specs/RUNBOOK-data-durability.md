# Runbook — data durability & restore (Phase 3)

How user data survives reinstall / new phone, and how to recover from a bad day.

## What's durable, and where

| Data | Store | Restore path |
|------|-------|--------------|
| Account key (aek) | D1 `key_backup` (wrapped under `KEY_WRAP_MASTER`), keyed by Clerk uid | Sign in → app GETs `/api/keybackup` → decrypts vault |
| Contacts / settings / apps | D1 `user_vault` (encrypted blob, key=uid+kind) | App `Vault.get(kind)` → decrypt with aek |
| Chats (recent) | InboxDO (per-uid Durable Object, SQLite) | Live socket + `/api/msg/sync` |
| Chats (deep, forever) | R2 `avatok-backup` (body) + D1 `message_index` (metadata) | `GET /api/msg/archive?conv=…&before=…` (flag `CHAT_ARCHIVE=1`) |
| Media | R2 (content-addressed) | Download URL by content hash |

Auth is Clerk JWT only. Every uid-keyed row is recoverable from the Clerk account with **no user action and no reinstall**.

## Abuse limits (Phase 3)
- `/api/keybackup` GET 60/h, PUT 30/h per uid.
- `/api/vault` PUT 120/h per uid + 600/h per IP; GET 600/h per uid.
- Sliding-window (`rateLimit()` in `money.ts`), returns 429 + `retry-after`.

## Deep archive (flag-gated, ships dark)
- Enable: set worker var `CHAT_ARCHIVE = "1"` (prod `wrangler deploy`, staging `--env staging`).
- Path: router enqueues each sent message → `chat-archive` queue → consumer (`archiveWrite`) writes body to `BACKUP_R2` at `arch/<conv>/<serial>` + a row to `message_index` (idempotent on `serial`).
- Consumer is wired in `index.ts` `queue()`; DLQ = `chat-archive-dlq`.

## Restore-from-snapshot runbook
D1 supports Time Travel (PITR). To recover a database to an earlier point:

1. Find a bookmark/timestamp before the incident:
   `wrangler d1 time-travel info <db-name> --timestamp "<ISO8601>"`
2. Restore (in place):
   `wrangler d1 time-travel restore <db-name> --timestamp "<ISO8601>"`
   (or `--bookmark <id>`). Prod DBs: `avatok-meta`, `avatok-media-meta`, `avatok-moderation`, `avatok-brain`, `avatok-wallet`.
3. R2 objects are immutable/versioned; a bad `message_index` restore just re-points to existing R2 bodies (missing bodies degrade to `null`, never a hard failure).
4. `key_backup` is the highest-value table — never destructively migrate it without a Time Travel bookmark noted first.

## Telemetry to watch
`key_backup_ok` / `key_backup_failed`, `key_restore_ok`, plus crash-free rate. A spike in restore/backup failures should halt any rollout.
