# Go-live progress — autonomous session 2026-06-11

## ✅ Done this session
- **D3 Stream** — webhook repointed to prod + `STREAM_WEBHOOK_SECRET` set + verified.
- **D2 LiveKit** — confirmed (webhook → `api.avatok.ai/api/conference/webhook`, signed).
- **Stripe** — stale endpoint deleted; 4 worker endpoints verified; Identity enabled (test).
- **C5 Identity** — PASS end-to-end on staging (pending → verified).
- **C3 money pipe** — core PASS (balance 0 → 500, top-up paid). Ledger row: see #8.
- **C2 APK** — GitHub Actions Android build GREEN on latest `main`.
- **C10 Vectorize** — `avatok-semantic` has `uid` + `kind` metadata indexes.
- **Staging DB parity** — brought ALL 5 staging D1s (meta, media-meta, moderation,
  brain, wallet) to table parity with prod. Staging was badly under-migrated.
- **C11 (partial)** — LiveKit secrets copied to staging worker.
- **gcal** — `GOOGLE_CLIENT_SECRET` rotated on both workers; prod redirect URI added
  (by davy). **C7**: start endpoint returns 200 (full consent needs a human click).
- **C9** — PostHog ingestion confirmed working (client events).
- **Wise** — locked to sandbox on both workers.

## ✅ Fixed & verified (later same day)
- **#8 staging ledger — FIXED.** Root cause: `consumers/src/index.ts` dispatched on the
  exact queue name, so every `-staging` queue (wallet, analytics, moderation, push,
  email, brain, deletions, agent) fell through the switch and was silently ack'd.
  Added `batch.queue.replace(/-staging$/, "")` normalization + deployed
  `avatok-consumers-staging`. Verified: synthetic msg → `wallet_ledger` +
  `wallet_transactions` written. **Prod unaffected; the fix is backward-compatible.**
- **C9 — FIXED.** Same routing bug, plus the staging consumer had **zero secrets** —
  set `POSTHOG_API_KEY`. Verified: test event reached PostHog (project 139917).
- **C11 conference webhook — VALIDATED.** Staging key = `APIPKFJVUYWYCDV` (matches your
  dashboard). Signed `room_started` → 200; bad signature → 401.

> ⚠️ **The `consumers/src/index.ts` fix is deployed to staging but NOT committed to git.**
> Commit + push it so it persists (and prod picks it up on next deploy).
> Also: the staging consumer still lacks `BREVO_API_KEY` / `FCM_SERVICE_ACCOUNT` —
> set those before testing staging email/push.

## ❌ Blocked — need you
- **C1 assetlinks** — need the **release signing cert SHA-256** (Play Console app
  signing, or `keytool` on the release keystore). I'll then set `ASSETLINKS_SHA256`
  on the `avatok-web` Pages project + verify `https://avatok.ai/.well-known/assetlinks.json`.
- **C11 conference test** — needs a **staging** LiveKit webhook registered in the
  dashboard (→ `api-staging.avatok.ai/api/conference/webhook`).

## ⏸ Not started (deferred)
- **C4 ledger invariants** — needs an admin Clerk JWT + #8 confirmed.
- **C6 seed staging demo data** (2 creators, 4 listings, bookings).

## QA artifact
- Clerk user `user_3Ey4…` (live instance, verified, ~1000 staging coins). Keep as a
  reusable staging tester, or I delete it.
