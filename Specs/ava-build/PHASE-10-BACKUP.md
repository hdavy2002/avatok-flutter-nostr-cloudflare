# Phase 10 — Backup & Sync

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0 (R2 binding, routes registered, PaidFeature for premium sync).

## OWNED FILES
- NEW: `worker/src/routes/backup.ts` + `worker/src/do/backup.ts` — premium R2
  cross-device sync (encrypted at rest); restore.
- NEW dir `app/lib/features/ava_backup/` — Google Drive (user-owned, free) backup +
  restore (Drive, not Docs); client-side encrypt for private on-device-only chats.
- NEW: `app/lib/features/settings/sections/backup_sync_section.dart` (registered).

## DO NOT TOUCH
P0 hot files. The existing email-backup in settings stays (it's a registered section
now) — don't edit it; add a separate sync section.

## Tasks
1. **Premium R2 sync** (PaidFeature): on-device SQLite ⇄ R2, encrypted at rest;
   enables server-readable AvaBrain across devices. R2 has no egress fees.
2. **Free Google Drive backup**: user's own Drive, survives uninstall; client-side
   encrypt private/on-device-only chats so neither we nor Google can read them.
3. Source of truth stays on-device SQLite.

## Acceptance
- Premium user syncs chats across two devices via R2; free user backs up to Drive.
- Private chats are client-side encrypted before any backup.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
