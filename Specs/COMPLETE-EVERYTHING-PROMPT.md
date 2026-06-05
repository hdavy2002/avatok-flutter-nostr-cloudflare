# AvaTalk Backend — Complete Everything Prompt

**Purpose:** Finish ALL remaining work from the backend rebuild. No loose ends. No "Phase N" deferrals. After this session, the backend is production-complete.

**CRITICAL RULE: Do NOT rebuild, rewrite, or re-scaffold anything. The 5-phase rebuild is done and deployed. You are finishing the last 10%, not redoing the 90%.**

---

## DAVY'S DECISIONS (2026-06-05) — READ FIRST

1. **All credentials are provided. Do NOT wait on or ask for any key.** They are in `secrets/` (`credentials.local.md` = Clerk publishable+secret+issuer `clerk.avatok.ai`+JWKS, Bunny library 553793 + write/read keys, TURN key ID + token, RealtimeKit org+key+auth header; `firebase-service-account.json`; `cf_token`) plus Brevo and Clerk available via MCP. Read those files first.

2. **Skip the AvaID selfie/liveness (AWS Rekognition) for now.** Build the verified-tier gate (`requireVerified()`) and the delete cascade, but STUB the verification step so a tier can be granted manually for testing. Do NOT block on AWS, do NOT wire AWS SigV4/Rekognition, do NOT build the liveness UI yet — that comes later.

3. **Defer (build plumbing, keep OFF in production):** Play Store app-signing keystore, Stripe (payments / wallet top-up), Wise (creator payouts). Wallet/payout infrastructure can be built, but real money must stay switched off until legal review clears.

> **NOTE — verify before acting.** This prompt was written for the backend "last 10%." The repo has since advanced: email is already on **Brevo** (not Resend — Block 2 likely done), moderation already uses **Gemma 4 vision + Llama Guard + a CSAM gate** (not resnet/OpenAI — Blocks 1D/3 are superseded; do NOT reintroduce OpenAI), the **compat layer is already removed** (Block 6 likely done), and **wallet / calendar / payout / OLX / agent routes already exist in `worker/src/`**. Before executing any block, check the current code/deploy state with the Cloudflare MCP and skip anything already complete.

---

## Context for the AI

You have access to these MCPs — USE THEM:
- **Cloudflare MCP** — set Worker secrets, check dashboard state, enable products. Full permissions.
- **PostHog MCP** — wire analytics integration.
- **Clerk MCP** — get JWKS URL, issuer, verify configuration.

Governing documents (read these first, they are the source of truth):
- `AVATALK-CLOUDFLARE-RULEBOOK.md` v1.1 — architecture rules
- `BACKEND_REBUILD_PLAN.md` — locked decisions
- `BACKEND_REBUILD_HANDOFF.md` — current state, what's deployed, what's pending

Credentials are in these locations (gitignored, already in the repo):
- `secrets/credentials.local.md` — Clerk secret key, TURN key ID + token, Bunny API keys
- `secrets/firebase-service-account.json` — FCM (already set on avatok-consumers)
- `secrets/cf_token` — Cloudflare API token
- `config/google-services.json` — Firebase app config

The 4 deployed Workers:
- `avatok-api` (worker/) — API control plane + CallRoom DO
- `avatok-relay` (relay/) — Nostr relay
- `avatok-consumers` (consumers/) — Queue consumers + cron
- `avatok-calls` — pre-existing, untouched

---

## Task List — execute ALL of these in order

### BLOCK 1: Wire Every Credential

**1A. Clerk auth — activate on avatok-api**

Use the Clerk MCP to get the JWKS URL and issuer for the avatok.ai Clerk instance. The Clerk publishable key is already in `app/lib/core/config.dart`. The Clerk secret key (`sk_live_…`) is in `secrets/credentials.local.md`.

Set these secrets on `avatok-api` using the Cloudflare MCP:
- `CLERK_JWKS_URL` — the JWKS endpoint from Clerk (format: `https://<your-clerk-domain>/.well-known/jwks.json`)
- `CLERK_ISSUER` — the issuer URL from Clerk (format: `https://<your-clerk-domain>`)

The auth module in `worker/src/auth.ts` already checks for these secrets and activates automatically. No code change needed. Verify by confirming the secrets are set, then test that a request without a valid Clerk JWT gets rejected on mutation endpoints.

**1B. TURN credentials — activate on avatok-api**

Read `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` from `secrets/credentials.local.md`. Set both as secrets on `avatok-api` via Cloudflare MCP. After this, `/ice` will return TURN credentials alongside STUN, enabling calls through strict NATs.

**1C. PostHog — activate on avatok-consumers**

Use the PostHog MCP to get or confirm the project API key. Set `POSTHOG_API_KEY` as a secret on `avatok-consumers` via Cloudflare MCP. The analytics queue consumer already handles batching events to PostHog's `/capture` endpoint. Verify it's working by checking the consumer logs after setting the secret.

Also set `POSTHOG_HOST` if the PostHog instance is not `app.posthog.com` (check via PostHog MCP).

**1D. OpenAI text moderation — activate on avatok-consumers**

If an OpenAI API key exists in `secrets/credentials.local.md`, set `OPENAI_API_KEY` on `avatok-consumers` via Cloudflare MCP. This powers text content moderation routed through Cloudflare AI Gateway. If the key doesn't exist in the secrets files, flag it — we need one.

**1E. Bunny.net video — wire on avatok-api**

Read the Bunny.net API keys from `secrets/credentials.local.md` (library ID 553793). Set `BUNNY_API_KEY` and `BUNNY_LIBRARY_ID` as secrets on `avatok-api` via Cloudflare MCP. This enables the video upload path for AvaTube/AvaGram/AvaLive post-stream recordings.

---

### BLOCK 2: Switch Email from Resend to Brevo

The email consumer in `consumers/src/` currently uses Resend. **Replace it with Brevo (formerly Sendinblue).**

- Change the email consumer to use Brevo's transactional email API (`https://api.brevo.com/v3/smtp/email`).
- The API pattern is similar: POST with JSON body containing `sender`, `to`, `subject`, `htmlContent`.
- Auth header: `api-key: <BREVO_API_KEY>`.
- Set `BREVO_API_KEY` as a secret on `avatok-consumers` via Cloudflare MCP (find the key in `secrets/credentials.local.md` or flag if missing).
- Remove any Resend-specific code/imports.
- Update the `BACKEND_REBUILD_HANDOFF.md` credentials table to show Brevo instead of Resend.

---

### BLOCK 3: Real Moderation Model

The current moderation consumer uses `@cf/microsoft/resnet-50` as a placeholder. Replace it with a proper NSFW/violence detection model.

**Action:**
- Switch the `MODERATION_MODEL` config (or hardcoded model name in consumers moderation code) to `@cf/microsoft/resnet-50` → one of these Workers AI models that actually detects NSFW content:
  - Check what NSFW/content-safety models are available on Workers AI (use Cloudflare MCP or docs).
  - Best options as of mid-2025: `@cf/jncraton/nsfw-image-detection` or the latest content-safety model available.
- Update the moderation consumer to parse the new model's output format (label names, score thresholds).
- Set a sensible threshold: reject at >0.85 confidence, flag for review at >0.60, pass below 0.60.
- Test with a real image upload through `/upload/public` and verify the moderation pipeline runs end-to-end with the new model.

---

### BLOCK 4: pHash Perceptual Hash Blocklist

The schema for `user_media_hashes` (DB_MEDIA) and `blocked_media_hashes` (DB_MODERATION) exists but no code computes perceptual hashes yet.

**Action:**
- In the moderation consumer, after the AI scan passes, compute a perceptual hash (pHash) of the uploaded image.
- Use a JavaScript pHash library that runs in Workers (no native dependencies). Options: `imghash`, or compute a simple DCT-based hash manually (images are already available as ArrayBuffer from R2).
- Store the hash in `user_media_hashes` (DB_MEDIA): `media_id`, `npub`, `frame_index=0` (for images; videos can do keyframes later), `phash`, `created_at`.
- Before passing an upload, check the hash against `blocked_media_hashes` (DB_MODERATION): `SELECT 1 FROM blocked_media_hashes WHERE hash_type='perceptual' AND hash_value=?`. If matched, reject the upload and auto-strike.
- For video uploads, extract the first frame thumbnail (if Bunny provides it via webhook) and hash that. If no thumbnail yet, skip pHash for video — sha256 blocklist still catches exact re-uploads.

---

### BLOCK 5: APNs (iOS Push)

The push consumer in `consumers/src/fcm.ts` handles FCM (Android) but APNs (iOS) is stubbed.

**Action:**
- Add an APNs HTTP/2 sender alongside FCM in the push consumer.
- APNs uses JWT-based auth: Team ID + Key ID + p8 private key → sign a JWT → POST to `api.push.apple.com`.
- The `push_tokens` table already has `platform` column (`'fcm'`|`'apns'`). The consumer should branch on platform: FCM tokens → Google, APNs tokens → Apple.
- Since we're Android-first and may not have an APNs p8 key yet: implement the code path fully, but gate it behind the `APNS_KEY_ID` + `APNS_TEAM_ID` + `APNS_PRIVATE_KEY` secrets. If those secrets aren't set, skip APNs tokens with a log warning (don't error/crash). Same pattern as the existing Clerk auth gating.
- If an APNs key file exists in `secrets/`, set the three secrets via Cloudflare MCP. If not, leave the secrets unset — the code will gracefully skip.

---

### BLOCK 6: Remove Compat Layer → Migrate Flutter to Hardened Routes

The compat layer (`worker/src/compat.ts`) reproduces the old KV monolith's API contract on D1. The hardened routes (with NIP-98 auth, correct field names, async patterns) already exist alongside it.

**Action:**
- In the Flutter app (`app/lib/`), find every HTTP call that hits the compat endpoints and update them to use the hardened route equivalents.
- The mapping (from `BACKEND_REBUILD_HANDOFF.md` and the compat file):

  | Old compat route | New hardened route | Key difference |
  |---|---|---|
  | `POST /profile` (compat) | `POST /api/profile` | NIP-98 required, field names may differ |
  | `GET /resolve` (compat) | `GET /api/resolve` | Same |
  | `GET /search` (compat) | `GET /api/search` | Same |
  | `POST /register` (compat) | `POST /api/register` | NIP-98 required |
  | `POST /contacts/*` (compat) | `POST /api/contacts/*` | NIP-98, batch phone_hash |
  | `GET /community*` (compat) | `GET /api/community*` | Same |
  | `POST /media` (compat, legacy) | `POST /upload/public` or `/upload/private` | Two paths, NIP-98 |
  | `GET /ice` | `GET /api/ice` | Same |
  | `POST /call` | `POST /api/call` | NIP-98 |
  | `GET /room/:id` | `GET /api/room/:id` | Same |
  | `POST /backup` (if exists) | `POST /api/backup` | NIP-98 |

- Make the Flutter app sign NIP-98 headers on ALL mutation endpoints. The Nostr client code is in `app/lib/nostr/` — it already knows how to sign events. NIP-98 is a kind-27235 event with `method`, `url`, and `payload` (sha256 of body) tags. Add a helper that creates this event and passes it as `Authorization: Nostr <base64-event>` header.
- After migrating all calls, remove `compat.ts` from `worker/src/` and remove the compat route registrations from `worker/src/index.ts`.
- Redeploy `avatok-api`.
- The `/media/:hash` → `blossom.avatok.ai/<hash>` 301 redirect should STAY (it's a permanent redirect for any cached/shared URLs, not part of the compat layer).

---

### BLOCK 7: Enable Cloudflare Calls + Stream

Use the Cloudflare MCP to verify these are enabled at the account level:

- **Cloudflare Calls** — needed for SFU (group calls) and TURN (NAT traversal). Check if it's active; if not, enable it.
- **Cloudflare Stream** — needed for AvaLive (live video ingest). Check if Stream Live Input exists; if not, create one. Set up the webhook endpoint at `avatok-api` (`/webhooks/stream`) to fire on stream events (connected/disconnected/recording-ready). If the webhook route doesn't exist in the API Worker, add it — it should dispatch to `Q_MODERATION` for post-stream content scan and update the NIP-53 kind:30311 event status via D1.

---

### BLOCK 8: Decommission Old RealtimeKit Apps

The handoff mentions old RealtimeKit apps `avaglobal` / `avablobal`. Check `OLD_AVATOK_DECOMMISSION.md` if it exists. If these apps are confirmed unused, remove/archive them. If unsure, leave them but flag clearly.

---

### BLOCK 9: Build + Smoke Test

After all code changes:

1. Build the Flutter APK. If no Flutter toolchain available, prepare the build so CI can run it — ensure `app/lib/core/config.dart` points at `avatok-api`, all new API calls compile, NIP-98 signing is wired.
2. If you CAN build: install on a device/emulator and test:
   - Login (Clerk)
   - Set profile → verify D1 write via `/api/resolve`
   - Search contacts → verify phone_hash batch query
   - Upload a photo (public path) → verify moderation pipeline + pHash
   - Send a DM with attachment (private path) → verify ciphertext upload, no scan
   - Place a 1:1 call → verify TURN credentials return from `/api/ice`
   - Receive a call → verify push notification wakes the phone (FCM)
3. If you CANNOT build: list every file changed and the exact smoke-test steps for me to run manually.

---

### BLOCK 10: Update Handoff Doc

Update `BACKEND_REBUILD_HANDOFF.md`:
- Move all ⏳ credentials to ✅ (or note which ones are still missing with why).
- Update email from Resend → Brevo.
- Remove compat layer from the architecture description.
- Update §7 PENDING — mark everything completed, list any genuine remaining items (should be near-zero).
- Add a §10 "Session 2 Changes" section documenting what was done in this session.

---

## Rules for this session

1. **Do NOT rebuild Workers, re-scaffold schemas, or re-provision D1/R2/KV/Queues.** Everything is deployed and working. You are wiring credentials, swapping one email provider, upgrading one AI model, adding one hash computation, adding one push provider, migrating one Flutter app to better endpoints, and removing one compatibility shim.

2. **Use MCPs.** Cloudflare MCP for setting secrets and checking dashboard state. PostHog MCP for getting the API key and verifying the project. Clerk MCP for getting JWKS URL and issuer.

3. **Read `secrets/credentials.local.md` first** — most credentials are already there. Don't ask me for values that are in that file.

4. **Test after each block.** Don't batch all changes and deploy once. Wire Clerk → verify. Wire TURN → verify `/ice`. Swap email → verify. Etc.

5. **If a credential is genuinely missing** (not in any secrets file, not available via MCP), say so clearly with exactly what I need to provide and where to get it. Don't skip it silently.

6. **Every code change must preserve the existing contract** unless you're explicitly migrating away from it (Block 6). The Flutter app is live — don't break it mid-session.

7. **Commit message discipline.** Each block gets its own deploy. Label clearly: "Wire Clerk auth", "Switch Resend→Brevo", "Upgrade moderation model", etc.
