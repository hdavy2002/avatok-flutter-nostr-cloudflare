# Handover — 2026-06-09 — Cloudflare-Native Pivot (Nostr deprecated)

**Read these three in order before doing anything:**
1. Graphiti — search `group_ids: ["proj_avaflutterapp"]` for the episode
   "AvaVerse Cloudflare-native pivot" (records that the Nostr arch is nulled).
2. `Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md` — the canonical proposal.
3. This handover.

---

## TL;DR of the decision
We are **removing Nostr** from AvaVerse. It added per-message crypto cost and
prevented moderation, with none of the decentralization/privacy benefits we want
(closed, KYC-gated, centralized marketplace + public social apps that must moderate
and report to authorities). Going forward: **server-readable messaging on a per-user
Durable Object (`InboxDO`) with DO-local SQLite, server as router, device local-first
SQLite cache.** Locked decisions: **clean rip-and-replace** (no dual-run, no data
migration — only 2 test phones, reinstall as new) and **server-readable DMs** (no
default E2E).

Do **not** re-introduce Nostr. Do **not** make a single central D1 the high-write
message store (use DO-local SQLite per user; D1 is for global query surfaces only).

---

## What is already shipped (keep — do not redo)
- **Device local-first layer** on branch `feat/avachat-ui`:
  - `app/lib/core/db.dart` — drift SQLite; `Messages`/`Contacts`/`Chats` tables;
    `Chats.json` projection column (schemaVersion 2 migration); `chatsOnce()` +
    `replaceChatList()`.
  - `app/lib/features/avatok/chat_list.dart` — cold start paints from ONE indexed
    SQLite query (`_paintFromProjection`); `_bootstrap` rewrites the projection;
    `_authoritativeLoaded` guards the race.
  - `app/lib/core/chat_list_snapshot.dart` — tiny in-session navigate-back cache;
    `warm()` removed (no in-memory pre-warm — would not scale to many apps).
  - Last commit: `48476b9` on `feat/avachat-ui`. CI build `27222627137` reached
    "Build release APK — success" (blocking compile gate passed).
  - This layer is **transport-agnostic and stays.** `RelayHub` will be reshaped into
    a `SyncHub` (same single-socket shape) that stores plaintext instead of decrypting.

## What to remove (Phase 2 of the plan)
- Client: `app/lib/nostr/` (nip17/44/59, gift-wrap, relay bits), keypair identity in
  `app/lib/identity/`, NIP-42 + NIP-98 signing.
- Backend: `relay/` Worker (`avatok-relay`) + D1 `avatok-relay` (delete post-cutover).

---

## Next session — Phase 1 (server messaging backend) first
1. Add `InboxDO` to `avatok-api` (`worker/src/do/`): hibernatable WebSocket
   (`acceptWebSocket` + hibernation handlers), DO-local SQLite for `messages` /
   `receipts` / `conv_meta`, presence = socket open.
2. Add `messaging` routes to `avatok-api`: `send`, `sync?cursor=`, `receipt`. Validate
   Clerk JWT + `account_status.kyc == verified` + block/mute at the edge.
3. Routing: write to sender InboxDO log → push to recipient InboxDO if online → else
   enqueue `Q_PUSH` (existing consumers/fcm.ts already does high-priority FCM).
4. `conversations` + `conversation_members` tables in D1 `avatok-meta` for routing.
5. Deploy + verify over WSS (connect → sync → send → live delivery → offline FCM).

Then Phase 2 (client SyncHub + rip Nostr), Phase 3 (receipts/presence/typing),
Phase 4 (video KYC gate), Phase 5 (housekeeping: update CLAUDE.md, delete relay).

---

## Infra facts (non-secret)
- **Cloudflare account:** `fd3dbf43f8e6d8bf65bd36b02eb0abb0` (hdavy2005@gmail.com),
  region APAC. Zone `avatok.ai` = `ae74ddf95ebf8c401d254ae3d308d4b5`.
- **Live Workers:** `avatok-api` (router — extend here), `avatok-consumers`
  (Queues: moderation/push/email/analytics + cron), `avatok-relay` (Nostr — DELETE
  after cutover), `avatok-calls` (RealtimeKit/AvaLive — untouched).
- **D1:** DB_META `avatok-meta` `c4ec8c0e-e1ac-4a1d-8e41-636f4007871b` (identity,
  profiles, hashes, follows, blocks, mutes, settings, push_tokens, communities,
  strikes, **account_status**, **verification_requests**); DB_MEDIA `avatok-media-meta`
  `79dc846e-8d9c-416a-8927-39c7aebdc400`; DB_MODERATION `avatok-moderation`
  `770d5709-2974-447e-b4e8-8c43f22df997` (blocked_media_hashes, moderation_results,
  user_reports); DB_RELAY `avatok-relay` `8ce3ca0d-d668-4bb4-94ea-7c8a458a0667`
  (nostr_events/tags — **deprecated, delete after cutover**).
- **R2:** `avatok-blobs` (PUBLIC via blossom.avatok.ai + CF image transform + 30-day
  edge cache), `avatok-verification` (LOCKED — KYC/ID docs, never public).
- **KV:** `avatok-tokens` `ab462ef0fdad44d08fd11263577b31f5`.
- **Queues:** moderation, push-notifications (Q_PUSH), email, analytics.
- **Vectorize:** `avatok-semantic` (384 dims, cosine).
- **Stream + Calls** products: enable in dashboard when AvaTube / calls phases need them.

## Build / deploy / git
- **APK:** built ONLY by GitHub Actions (`.github/workflows/android.yml`, "Android
  build"). No local Flutter toolchain — do not run `flutter build`/`analyze` locally.
  Trigger: `gh workflow run "Android build" --ref feat/avachat-ui`. Release =
  split-per-ABI arm64 (~30-50MB); debug fallback. Published to release tag
  `calltest-latest`. CI runs build_runner before the build, so editing `db.dart`
  regenerates `db.g.dart` in CI; analyze is non-blocking, the release APK build is the
  real compile gate.
- **Worker deploy from sandbox:** install `wrangler@^4` in `/tmp` (NOT the repo's macOS
  node_modules), run with `CLOUDFLARE_API_TOKEN` from `secrets/cf_token`. D1 migrations
  via REST API also work.
- **Secrets:** recoverable source of truth = `secrets/secret-values.env` (gitignored).
  Worker/Pages secrets are write-only. FCM_SERVICE_ACCOUNT, BREVO_API_KEY,
  POSTHOG_API_KEY already set. Never write secret values into repo docs.
- **Git:** run git on the user's machine via Desktop Commander (the sandbox `.git` has
  a permission issue — `index.lock` unlink fails). A pre-commit hook rebuilds graphify
  and auto-logs a Graphiti push episode.
- **Graphiti:** ALWAYS pass `group_id="proj_avaflutterapp"` on every call (reads and
  writes). **Graphify** (`graphify-avatok-2-flutter` MCP) before grep for structural
  code questions.
- **PostHog:** project 139917 (EU), `diag_logs` keyed by npub today — will re-key to
  the Clerk account id once Nostr identity is removed.

## What NOT to do
- Do not re-add Nostr / NIP anything.
- Do not centralize messages in one D1 (use DO-local SQLite per user).
- Do not hardcode anything per phone model.
- Do not pre-load app data into memory on boot (does not scale across apps).
- Do not build the APK locally; use CI.
