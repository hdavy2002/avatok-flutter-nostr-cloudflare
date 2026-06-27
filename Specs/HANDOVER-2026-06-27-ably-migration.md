# Handover — Ably messaging migration (2026-06-27)

Replaces the unreliable Cloudflare **InboxDO** realtime layer (slow delivery, flaky
typing/online/receipts) with **Ably** on iOS + Android. Built phase-by-phase, each
phase a local commit (NOT pushed). Plan: `Specs/AVAVERSE-ABLY-MIGRATION-PLAN.md`.

## Decision locked
- **Ably runs on iOS + Android only.** `ably_flutter` wraps the native cocoa/java
  SDKs — no desktop/macOS/web. Those platforms stay on the legacy InboxDO socket.
  Enforced by `useAblyTransport()` (platform + provider check).
- **Hybrid, server-readable design.** Sending still POSTs the Worker
  (`/api/msg/send`) so moderation / blocks / AvaBrain / offline-FCM are untouched;
  the Worker then publishes the moderated message to Ably for instant live receive.
  Typing / online / receipts go client↔Ably directly (the layer that was broken).
- **Local drift SQLite stays** the on-device source of truth. Calls (CallRoom +
  LiveKit conference + call_log) are **out of scope** and untouched.

## Commits (local only — DO NOT push without explicit ask)
- `[ABLY-1]` Phase 1 — `AvaTransport` seam + `kMessagingProvider` flag + platform gate + `ably_flutter` dep.
- `[ABLY-2]` Phase 2 — `AblyTransport` (live msg subscribe, direct typing/presence/receipts, JWT authCallback).
- `[ABLY-3]` Phase 3 — `/api/ably/token` (Clerk-gated, clientId-pinned, room-scoped HS256 JWT) + `ablyPublish` + `ABLY_API_KEY` binding.
- `[ABLY-4]` Phase 4 — server-publish moderated messages to Ably `msg:<conv>` after moderation/brain/append.
- `[ABLY-5]` Phase 5 — wire Ably into `SyncHub` (receive bridge + provider switch) + `PresenceChannel` adapter + call sites.
- `[ABLY-6]` Phase 6 — realtime telemetry (`ably_send_roundtrip`, `ably_receipt_lag`).

## Files
**App:** `app/lib/sync/transport/ava_transport.dart` (new, seam+selector),
`app/lib/sync/transport/ably_transport.dart` (new, impl),
`app/lib/sync/sync_hub.dart` (provider switch + bridge),
`app/lib/sync/presence.dart` (Ably adapter),
`app/lib/core/feature_flags.dart`, `app/lib/core/config.dart`, `app/pubspec.yaml`,
`app/lib/features/avatok/chat_thread.dart`, `app/lib/features/avatok/chat_list.dart`.
**Worker:** `worker/src/routes/ably.ts` (new), `worker/src/routes/messaging.ts`,
`worker/src/index.ts`, `worker/src/types.ts`.

## Telemetry — PostHog dashboard "AvaTOK — Ably Messaging Health" (id 778258)
Insights: live connection events, send→echo roundtrip p50/p95, token mint p95 +
failures, receipt lag p50/p95, Ably-vs-InboxDO adoption, send failures (30d). All
events auto-tagged with the user's email via `Analytics._base`. Populates on rollout.

## To go live (ops — not done here, gated/dark by default)
1. Create ONE Ably app + API key. `wrangler secret put ABLY_API_KEY` =
   `"<keyName>:<keySecret>"` on `avatok-api` (prod + staging). Until set,
   `/api/ably/token` returns 503 and the server-publish is a no-op — safe to ship dark.
2. Build with `--dart-define=AVATOK_MSG_PROVIDER=ably` (or add a server kill switch
   `PlatformConfig.messagingProvider` and have the app fetch it into
   `RuntimeMessagingProvider.value` — preferred, no rebuild to flip back).
3. Dogfood on a mobile build with `hdavy2005@gmail.com`; watch dashboard 778258
   vs the legacy InboxDO baseline.
4. Flip for all; monitor a week; then tear down `inbox.ts` WS/message paths,
   `messaging.ts` transport, `relay_hub`/SyncHub legacy socket (keep `call_log`).

## Known follow-ups / risk
- **`ably_flutter` API surface must be validated by a CI APK build** (this repo can't
  compile headless). Verify: `ClientOptions.authCallback` returning `TokenDetails`,
  `channels.get().subscribe(name:)`, `presence.enter/leave/subscribe`,
  `connection.on()` state enum. Adjust the thin `AblyTransport` wrapper if the 1.2.x
  API differs.
- History backfill for a brand-new device currently relies on local drift + existing
  `/api/msg/sync`; Ably `history()` rewind can be added to `subscribeConversation` if
  needed.
- Live-location frames are dropped in Ably mode (were on the signaling WS); re-add on
  a dedicated Ably channel if the feature is required on mobile.
- Pricing: sign up on **MAU billing ($0.05/MAU)**, not per-connection-minute.
