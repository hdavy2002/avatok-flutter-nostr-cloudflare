# AvaTok Backend Rebuild — Session Handoff

**Date:** 2026-06-04
**Scope:** Full rebuild of the AvaTalk backend from the KV prototype to the Cloudflare Architecture Rulebook v1.1, plus app cutover. All 5 phases shipped.
**Governing docs:** `AVATALK-CLOUDFLARE-RULEBOOK.md` (v1.1, authoritative infra), `BACKEND_REBUILD_PLAN.md` (locked decisions), `specs-final.md` (product spec).

> **Security note:** raw secret values are NOT in this file (it's committed to git). They live in the gitignored `secrets/` folder and as Cloudflare Worker secrets. This report lists every credential by name + location + status.

---

## 1. Current state — what's live

Four Workers on the account (`hdavy2005@gmail.com`, account `fd3dbf43f8e6d8bf65bd36b02eb0abb0`):

| Worker | URL | Role | Status |
|---|---|---|---|
| `avatok-api` | https://avatok-api.getmystuffme.workers.dev | Control plane: directory, contacts, communities, media upload, push producer, ICE, /backup, call-room DO. Compat + hardened contracts. | ✅ deployed |
| `avatok-relay` | https://avatok-relay.getmystuffme.workers.dev | Nostr relay (NIP-01/09/11/25/42/100), events → D1, NIP-42 private-kind gate, onEventSaved→push queue. | ✅ deployed |
| `avatok-consumers` | https://avatok-consumers.getmystuffme.workers.dev | Queue consumers (moderation/push/email/analytics) + 6h cron. | ✅ deployed |
| `avatok-calls` | https://avatok-calls.getmystuffme.workers.dev | RealtimeKit token mint (AvaConsult SFU) + AvaLive Stream. **Pre-existing, untouched.** | ✅ (not this session) |

The old `avatok-call-signaling` Worker and its KV namespace were **deleted** (decommissioned). Code remains in `signaling/` for rollback.

---

## 2. What was done, by phase

- **Phase 1 — D1 foundation.** Schema designed for 4 databases (not the Rulebook's 18 — see decision below). Migrations in `worker/migrations/{meta,media,moderation,relay}.sql`; sharding router `worker/src/db/shard.ts`.
- **Phase 1b — Provisioning.** Created 4 D1 DBs (APAC), ran migrations, created R2 buckets + KV + 4 Queues + Vectorize index, connected `blossom.avatok.ai` public domain with Cache-Everything (30d) + Smart Tiered Cache, enabled D1 read replication (auto) on all 4.
- **Phase 2 — API Worker.** `worker/` — route dispatch, NIP-98 + Clerk auth module (`auth.ts`), D1 reads/writes, Cache API on public reads, two upload paths, `CallRoom` DO. Verified live with a real NIP-98-signed request.
- **Phase 3 — Relay re-platform.** `relay/` — events persist to `DB_RELAY` (`nostr_events` + `nostr_tags`), DO holds only connections/subs, NIP-42 challenge + private-kind gating, `onEventSaved`→`Q_PUSH`. Verified live over WebSocket.
- **Phase 4 — Async layer.** `consumers/` — moderation (Workers AI scan → status/strike/blocklist), push (FCM v1 fully; APNs deferred), email (Resend), analytics (PostHog), strike escalation, cron cleanup. Verified: real FCM Google access token + full upload→scan→`live` pipeline.
- **Phase 5 — Cutover.** Built compat layer (`worker/src/compat.ts`) reproducing the old signaling contract on D1; flipped `app/lib/core/config.dart` host → `avatok-api`; deleted old worker + KV. Verified all 11 app endpoints live via curl.

---

## 3. Resource inventory (non-secret IDs)

**D1 databases** (region APAC, read replication = auto):

| Binding | Name | ID |
|---|---|---|
| DB_META | avatok-meta | `c4ec8c0e-e1ac-4a1d-8e41-636f4007871b` |
| DB_MEDIA | avatok-media-meta | `79dc846e-8d9c-416a-8927-39c7aebdc400` |
| DB_MODERATION | avatok-moderation | `770d5709-2974-447e-b4e8-8c43f22df997` |
| DB_RELAY | avatok-relay | `8ce3ca0d-d668-4bb4-94ea-7c8a458a0667` |

**Other resources:**

- R2: `avatok-blobs` (PUBLIC via `blossom.avatok.ai`), `avatok-verification` (LOCKED — ID docs, never public)
- KV: `avatok-tokens` = `ab462ef0fdad44d08fd11263577b31f5` (ephemeral tokens only)
- Queues: `moderation`, `push-notifications`, `email`, `analytics`
- Vectorize: `avatok-semantic` (384-dim, cosine)
- Workers AI binding `AI`, Analytics Engine `avatok_metrics`, Browser Rendering `BROWSER`
- Zone: `avatok.ai` = `ae74ddf95ebf8c401d254ae3d308d4b5`
- Cron: `avatok-consumers` runs `0 */6 * * *`

---

## 4. Credentials — inventory, location, status

Raw values are in `secrets/credentials.local.md` and `secrets/cf_token` (both gitignored), or set as Worker secrets. **Nothing secret is duplicated here.**

| Credential | Where stored | Status |
|---|---|---|
| Cloudflare API token (scoped) | `secrets/cf_token` (gitignored) + session memory | ✅ active — used for all wrangler deploys |
| Clerk publishable key | `app/lib/core/config.dart` (public, ships in app) | ✅ in app |
| Clerk JWKS URL + issuer | `https://clerk.avatok.ai/.well-known/jwks.json` + `https://clerk.avatok.ai` | ✅ ENABLED in `secrets/deploy.sh` (set on deploy). The app now mints a real Clerk **session JWT** via `ClerkClient.sessionToken()` and sends it as `Authorization: Bearer`. JWKS verified live (RSA key present). Verify needs only the public JWKS — `sk_live_…` not required. Ship the new APK with this deploy. |
| FCM service account | `secrets/firebase-service-account.json` | ✅ SET as `FCM_SERVICE_ACCOUNT` on `avatok-consumers` |
| `google-services.json` (app FCM) | `config/google-services.json` (gitignored) | ✅ in repo for app build |
| Cloudflare TURN key id + token | id in `credentials.local.md` (`add95c6c…`); **token value NOT in repo** | ⏳ `TURN_KEY_ID` staged in `deploy.sh`; `TURN_KEY_API_TOKEN` must be pasted into `secrets/secret-values.env` (dash → Realtime/Calls → reveal). `/ice` returns STUN-only until set. |
| Bunny.net (lib 553793) | library id public; **API key value NOT in repo** | ⏳ `BUNNY_LIBRARY_ID` staged; `BUNNY_API_KEY` → `secret-values.env`. |
| RealtimeKit org API key | — | ⏳ NOT provided (AvaConsult SFU mint) |
| Brevo API key (email) | **NOT in repo**; Brevo account live via MCP (free, 299 credits) | ⏳ MCP can't expose the key → paste `BREVO_API_KEY` into `secret-values.env` (Brevo → SMTP & API → API Keys). Email consumer no-ops until set. |
| PostHog API key | `phc_…` retrieved via PostHog MCP (project 139917) | ✅ value known; staged in `deploy.sh` (set on `avatok-consumers` on deploy). |
| Moderation models | Workers AI: image=`@cf/meta/llama-3.2-11b-vision-instruct`, text=`@cf/meta/llama-guard-3-8b` — **no OpenAI** | ✅ wired (both on the AI binding, zero extra cost); OpenAI dropped entirely. |
| APNs auth key (iOS push) | — | ⏳ code complete + gated; leave secrets unset (Android-first). Paste `APNS_*` into `secret-values.env` to activate. |

**Action on the CF token:** it's a scoped, revocable User API Token that appeared in the chat transcript — rotate/revoke it once handoff is complete; replace `secrets/cf_token` + the memory entry with a fresh one.

---

## 5. Key architecture decisions (and why)

- **4 D1 databases, not 18.** The Rulebook's author-sharded relay backfires here (feed reads fan out across shards; NIP-17 gift wraps have random author keys). Single `DB_RELAY` + `nostr_tags` index instead; time-shard at ~5 GB. Sharding router is written so this is a config change later.
- **Two upload paths.** `/upload/public` (plaintext → Workers AI scan → R2) vs `/upload/private` (client AES-GCM ciphertext → R2, no scan). Can't moderate ciphertext; public content scanned, DM media relies on recipient-report. The app's DM media now uses `/upload/private` (NIP-98) and reads directly from `blossom.avatok.ai`.
- **NIP-42 gates private kinds only** (13/14/1059/25050/10050/10443); public kinds open for federation.
- **Push tokens in D1**, not KV (Rulebook beats stale spec §11.3).
- **Phone discovery kept**, hashed only (`phone_hash → npub`); never raw numbers.
- **Compat layer REMOVED (Session 2).** `worker/src/compat.ts` is deleted. `avatok-api` now serves a single hardened `/api/*` contract where the caller's identity is derived from the NIP-98 signature, never the body. The Flutter app signs NIP-98 on every mutation (`app/lib/core/api_auth.dart`). ⚠️ Deploy the worker and the new APK together — old installs break on the missing compat routes.

---

## 6. Verification done this session

- **avatok-api:** real NIP-98-signed `POST /profile` → D1 write → `/resolve` + `/search` read-back; unsigned mutation → 401. All 11 compat endpoints curl-verified to exact old shapes.
- **avatok-relay:** WebSocket — NIP-42 challenge, publish kind-1 → persisted to D1, REQ read-back, private kind-1059 rejected without AUTH.
- **avatok-consumers:** FCM OAuth → real Google access token; full `/media`(public)→`Q_MODERATION`→Workers AI→`user_media='live'` pipeline.

All test data was cleaned up; databases are empty/clean.

---

## 7. PENDING — before launch

All Session-2 code is written, type-checked, and bundle-verified (`wrangler deploy --dry-run` passes for all Workers). Deploys are **HELD** — run `bash secrets/deploy.sh` to go live. Remaining items:

**Must do:**
1. **Provide 3 secret values** (not in the repo) in `secrets/secret-values.env` (copy from `.env.example`): `BREVO_API_KEY` (email), `TURN_KEY_API_TOKEN` (cross-network calls), `BUNNY_API_KEY` (video). Code no-ops gracefully until each is set.
2. **Run `secrets/deploy.sh`** — applies the `live_streams` migration, sets known secrets, deploys `avatok-api` + `avatok-consumers` + `avatok-relay`. Deploy the **new APK at the same time** (compat layer is gone).
3. **CI APK build + on-device smoke test** (no Flutter toolchain in the sandbox). Test: login → set profile (`/api/profile`, NIP-98) → resolve/add a contact → send DM media (`/upload/private`) → place a 1:1 call (TURN from `/api/ice`) → confirm FCM incoming-call wake.

**Opt-in / later:**
4. **Clerk account auth — DONE & ENABLED.** Dual auth is live: NIP-98 (key ownership) + Clerk session JWT (verified account), both required on mutations; reads stay open. `deploy.sh` sets `CLERK_JWKS_URL` + `CLERK_ISSUER`. Test after deploy: valid NIP-98 + no/invalid Bearer → 401; both valid → 200.
5. **Moderation models are live-capable today.** Image = `@cf/meta/llama-3.2-11b-vision-instruct` (vision; rates NSFW + violence 0-100 → 0..1), text = `@cf/meta/llama-guard-3-8b` (binary safe/unsafe). Both confirmed runnable on the account. `classify()` still fails open on AI errors (uploads never block on a scan failure).
6. **iOS push (APNs)** — code complete + gated; add `APNS_*` to `secret-values.env` when a `.p8` key exists.
7. **Stream webhook secret** — set `STREAM_WEBHOOK_SECRET` + register the webhook → `https://avatok-api.getmystuffme.workers.dev/webhooks/stream`. Full video-recording scan is a follow-up (image scan + pHash are live).
8. **RealtimeKit** `avaglobal` / `avablobal` — confirmed old/unused; **delete in the RealtimeKit dashboard** (can't be done via API: this account's `realtime/kit/apps` list is empty and there's no app-DELETE endpoint). Keep `avatok-calls`. See `OLD_AVATOK_DECOMMISSION.md` §6.

---

## 8. How to operate

**Repo layout:**
```
worker/      → avatok-api    (src/{index,auth,util,types}.ts, src/routes/{api,media,stream}.ts, src/do/, migrations/{*,stream}.sql)
relay/       → avatok-relay  (src/{index,relay_do,nip19}.ts)
consumers/   → avatok-consumers (src/{index,fcm,apns,moderation,phash,strikes,types}.ts)
signaling/   → OLD worker (deleted from CF; kept for rollback)
app/         → Flutter app (config.dart → /api/*; core/api_auth.dart signs NIP-98)
secrets/     → deploy.sh (staged deploy), secret-values.env.example (fill the 3 missing secrets)
```

**Deploy any worker** (token must be in the shell):
```bash
export CLOUDFLARE_API_TOKEN="$(cat secrets/cf_token)"
cd worker && npx wrangler deploy        # or relay/ or consumers/
```

**Run a D1 migration / query:**
```bash
npx wrangler d1 execute avatok-meta --remote --file=worker/migrations/meta.sql
npx wrangler d1 execute avatok-meta --remote --command "SELECT count(*) FROM profiles"
```

**Set a secret:**
```bash
npx wrangler secret put CLERK_JWKS_URL          # (in worker/)
echo "$JSON" | npx wrangler secret put FCM_SERVICE_ACCOUNT   # (in consumers/)
```

**Rollback the cutover** (if the new APK misbehaves): revert `app/lib/core/config.dart` host to `avatok-call-signaling…`, then `cd signaling && npx wrangler deploy` (recreate its KV namespace first).

---

## 9. One-line status

**Session 2 complete: compat layer removed; dual auth live (NIP-98 + Clerk session JWT) on `/api/*`; email→Brevo; vision-model image + Llama-Guard text moderation + pHash + APNs + Stream webhook; D1 reads on global replicas (Sessions API) + relay DO hibernation — all coded and bundle-verified (`tsc` + `wrangler --dry-run` pass for all 3 Workers). Deploys held behind `secrets/deploy.sh`. Gates: 3 secret values (Brevo/TURN/Bunny) + CI APK build + on-device smoke test; manual RealtimeKit dashboard delete of avaglobal/avablobal.**

---

## 10. Session 2 changes (2026-06-04)

Code-only session; **all deploys held** for a coordinated worker+APK cutover. Every Worker passes `tsc --noEmit` and `wrangler deploy --dry-run`.

- **Block 1 — credentials staged.** `secrets/deploy.sh` (+ `secret-values.env.example`) sets all Worker secrets and applies migrations in one run. Known/public values hardcoded (PostHog `phc_…`, Clerk JWKS/issuer [commented], TURN key id, Bunny lib id). 3 values must be pasted in (`BREVO_API_KEY`, `TURN_KEY_API_TOKEN`, `BUNNY_API_KEY`).
- **Block 2 — email Resend→Brevo.** `consumers/src/index.ts` now POSTs `api.brevo.com/v3/smtp/email` with `api-key`; Resend removed. Env `BREVO_API_KEY`.
- **Block 3 — moderation model.** `consumers/src/moderation.ts` uses the vision model `@cf/meta/llama-3.2-11b-vision-instruct` to rate NSFW + violence (0-100 → 0..1). Thresholds: ≥0.85 reject (+strike+blocklist), ≥0.60 flag (human review), else live. `MODERATION_MODEL` var.
- **Block 3b — text moderation.** `moderateText()` uses Workers AI `@cf/meta/llama-guard-3-8b` as a binary safe/unsafe classifier (OpenAI dropped entirely, zero cost). `TEXT_MODERATION_MODEL` var.
- **Block 4 — pHash.** `consumers/src/phash.ts` (DCT pHash via `@cf-wasm/photon`). Perceptual blocklist gate before pass; stores into `user_media_hashes`; Hamming ≤6 = match.
- **Block 5 — APNs.** `consumers/src/apns.ts` (ES256 JWT, HTTP/2), gated behind `APNS_*`; push consumer branches on `platform`. Unset → skips cleanly (Android-first).
- **Block 6 — Flutter → hardened `/api/*` + NIP-98.** New `app/lib/core/api_auth.dart` (signs kind-27235 → `X-Nostr-Auth`). New worker `src/routes/api.ts` (identity from signature, not body). `compat.ts` **deleted**; `index.ts` serves only `/api/*` + `/upload/*` + media redirect + ICE. App call sites migrated: profile, register, call/call-status/notify, contacts sync, community create/join, backup, DM media upload. `config.dart` URLs → `/api/*`; DM reads → `blossom.avatok.ai`.
- **Block 7 — Stream webhook.** `src/routes/stream.ts` (`POST /webhooks/stream`, gated HMAC verify) records lifecycle to new `live_streams` table (`migrations/stream.sql`) and dispatches recordings to `Q_MODERATION`. Verified account-side: **Stream enabled (71 live inputs), Queues=4, TURN key provisioned.**
- **Block 8 — decommission.** RealtimeKit `avaglobal`/`avablobal` flagged (see `OLD_AVATOK_DECOMMISSION.md` §6).

### Pre-deploy items (added 2026-06-04)

- **Item 1 — Clerk session JWT (dual auth).** `ClerkClient.sessionToken()` mints a real RS256 session JWT (`POST /v1/client/sessions/{sid}/tokens`, cached ~50 s) and `main.dart` wires it to `ApiAuth.clerkBearer` → sent as `Authorization: Bearer` next to `X-Nostr-Auth`. `deploy.sh` now sets `CLERK_JWKS_URL` + `CLERK_ISSUER`. Worker `auth.ts` already verifies (RS256 vs JWKS, exp, issuer) — no worker code change. JWKS verified live (the Clerk MCP only exposes SDK snippets, so the endpoint was checked directly). Result: mutations require NIP-98 **and** a valid Clerk JWT; reads stay open.
- **Item 2 — RealtimeKit.** `avaglobal`/`avablobal` confirmed old test apps (live calls use Cloudflare Calls + `CallRoom` DO; AvaConsult uses the `avatok-calls` Worker). Could not delete via API (account's `realtime/kit/apps` list is empty; no DELETE endpoint) → **manual dashboard delete required**. `avatok-calls` kept.

## 12. Session 4 — AvaBrain + Observability (2026-06-05)

Built per `AVABRAIN-OBSERVABILITY-CORRECTED.md` (E2E-safe, cost-bounded). Code-complete; `tsc` + `wrangler --dry-run` green on all 3 Workers with every new binding resolved. Deploys held.

**Provisioned (live):** D1 `avatok-brain` (`f5bfb712-5151-4e9f-b47a-20d76465f205`, APAC) + queue `brain-events`; `brain.sql` applied (5 tables).

**AvaBrain**
- **Storage:** own DB (`DB_BRAIN`), not DB_META. `brain_events` is a 30-day TTL catch-up buffer (pruned by cron), not a permanent log. `scope` column separates `public` (server-derived) from `private` (client-synced) memory. Importance decays **lazily at read time** — no cron full-table writes.
- **Extraction (consumers/src/brain.ts, Q_BRAIN consumer):** 8B model (`llama-3.1-8b-instruct-fp8`, never 70B) extracts entities/relationships/facts as JSON; idempotent upsert (dedupe by npub+name+type); embeds a summary into Vectorize (`bge-small-en-v1.5`, 384-dim, `{npub}` metadata). Cost metric → Analytics Engine.
- **Reasoning (worker/src/do/user_brain.ts, USER_BRAIN DO):** per-user, keyed by npub, idles to nothing. `ask` / `briefing` (8B default; 70B only via `BRAIN_REASONER_MODEL` for premium), `remember` (client-synced private facts — the ONLY path private memory reaches the server), `investigate`, `forget`, `entities`, `timeline`.
- **investigate():** reads PostHog via **personal key** (`POSTHOG_PERSONAL_API_KEY`, gated; HogQL on project 139917). Project `phc_` key can't read — confirmed. Unset → graceful "diagnostics unavailable".
- **Routes:** `worker/src/routes/brain.ts` → `/api/brain/{ask,briefing,remember,investigate,forget,entities,timeline}`, dual-auth, npub from signature → caller's own DO. Flutter client: `app/lib/core/brain_api.dart`.
- **Hooks (PUBLIC only):** relay enqueues Q_BRAIN for kind 1 / 30023 (never DM/private kinds); API enqueues on public upload. **DMs are never sent to the server brain** — E2E preserved; DM facts come only via client `remember`.

**Observability**
- Trace IDs: `X-Trace-Id` minted in Flutter `api_auth.dart`, read in the API worker, attached to the Analytics Engine metric.
- Analytics Engine already wired across API/relay/consumers (Session 3); brain extract/reason durations added.
- PostHog stays batched through `Q_ANALYTICS` → `${POSTHOG_HOST}/batch/`. Event catalog + dashboards are a client-instrumentation follow-up.

**New secret:** `POSTHOG_PERSONAL_API_KEY` (gated). Added to `deploy.sh` + `secret-values.env.example`.

**Remaining (client-side, not buildable here):** the AvaChat "brain" UI tab, and on-device DM fact extraction that calls `BrainApi.remember`. The server side is ready.

---

## 11. Session 3 — Scale-audit fixes (2026-06-04)

All 12 SCALE_AUDIT.md items fixed; code-complete, `tsc` + `wrangler --dry-run` green on all 3 Workers; deploys held. New migrations are wired into `secrets/deploy.sh`.

- **P0-1 relay sharding.** `relay/src/index.ts` routes WS to `idFromName(pubkey)` (per-user inbox DO); `relay_do.ts` removed the global broadcast — `localDeliver()` (this user's devices) + `fanOut()` (DM/mention → recipient DOs via internal `/deliver`). App: `NostrClient.connect()` appends `?pubkey=`. Public posts are REQ→D1 (no fan-out).
- **P0-2 D1 param chunking.** `chunk()` (≤90) in `worker/src/util.ts`; applied to `matchContacts` and relay `queryFilter` (dynamic chunk size keeps total params <100, cartesian over dims, dedupe).
- **P1-3 FTS5 search.** `migrations/meta_fts.sql` (virtual table + triggers + backfill); `search()` uses prefix `MATCH`.
- **P1-4 pHash LSH.** `migrations/moderation_lsh.sql` (`blocked_phash_bands`); `matchesBlockedPerceptual()` does indexed band lookup; rejects seed the band table.
- **P1-5 AI cost.** Analytics-Engine metric per scan; verified users get a lenient flag threshold (0.90); `MODERATION_MODEL_TYPE` (`vision`|`classifier`) gives a no-code swap path to a cheap NSFW classifier.
- **P1-6 Blossom cache.** Verified live (cache-everything, 30d edge TTL, tiered + smart-tiered on).
- **P1-7 R2 re-fetch.** `migrations/moderation_phash_col.sql` adds `moderation_results.phash`; cache hit skips R2 GET + Photon decode.
- **P2-8 PostHog.** Analytics queue sent in one `/batch` POST.
- **P2-9 / P2-12.** Documented read-your-writes nuance + relay shard trigger in `db/shard.ts`.
- **P2-10 cron index.** `migrations/media_pending_index.sql` (partial index).
- **P2-11 Analytics Engine.** Wired across API (latency/route), relay (events/kind), consumers (queue ok/fail, moderation cost, cron counts).

---

### Performance fixes (post-verification, 2026-06-04)

- **D1 Sessions API (global read replicas).** Replication was `auto` on all 4 DBs but plain `prepare()` always hit the APAC primary. Added `metaSession/mediaSession/moderationSession/relaySession` (`db/shard.ts`, `withSession("first-unconstrained")`) and threaded one session per DB per request through `routes/api.ts`, `routes/media.ts`, and `auth.ts`. Reads now route to the nearest replica; writes go to primary and the session bookmark keeps read-after-write consistent within a request. (Consumers left on direct binding — background, not latency-sensitive.)
- **Relay DO hibernation.** `relay/src/relay_do.ts` switched from `server.accept()` + `addEventListener` to `state.acceptWebSocket()` + `webSocketMessage/Close/Error` handlers. Per-connection state (auth, challenge, subs) moved from an in-memory `Map` into each socket's `serializeAttachment()` so it survives eviction; `broadcast()` enumerates `state.getWebSockets()`. Idle chat connections no longer keep the DO resident/billed. All 3 Workers re-verified (`tsc` + `wrangler --dry-run`).

---

## Session 4 — AvaBrain + Observability (2026-06-05)

Built per `Specs/AVABRAIN-OBSERVABILITY-CORRECTED.md` (E2E-safe, cost-bounded). Provisioned D1 `avatok-brain` (`f5bfb712-…`) + queue `brain-events`; `brain.sql` applied.
- **Brain consumer** (`consumers/src/brain.ts`, Q_BRAIN): 8B extraction (`llama-3.1-8b-instruct-fp8`, never 70B) → idempotent upsert of entities/relationships/facts; embeds summary into Vectorize (`bge-small-en-v1.5`, npub-scoped). Raw `brain_events` is a 30-day TTL buffer.
- **UserBrain DO** (`worker/src/do/user_brain.ts`, keyed by npub): `ask`/`briefing` (8B; 70B only via `BRAIN_REASONER_MODEL`), `remember` (client-synced private facts — only path private memory reaches the server), `investigate` (PostHog read via gated `POSTHOG_PERSONAL_API_KEY`), `forget`, `entities`, `timeline`. Lazy importance decay.
- **Routes** `/api/brain/*` (dual-auth) + Flutter `app/lib/core/brain_api.dart`. **Hooks public-only:** relay enqueues kind 1/30023 (never DM); API enqueues public uploads. DMs never reach the server brain.
- **Observability:** `X-Trace-Id` minted in `api_auth.dart`, attached to the API Analytics-Engine metric; PostHog batched via `Q_ANALYTICS` → `${POSTHOG_HOST}/batch/`.

## Session 5 — Per-user storage folders + account erasure (2026-06-05)

- **R2 per-user folders + subfolders:** uploads key as `u/<npub>/<kind>/<sha256>` — `public/`, `dm/`, plus `u/<npub>/backups/…` for account exports. Everything a user owns is under `u/<npub>/`. Content sha256 still drives moderation/blocklist; `user_media.key` + the upload response carry the full key; app builds download URLs from it. Moderation consumer fetches/deletes by `r2_key`. No shared cross-user blobs → a user delete can't touch another user's files.
- **Bunny per-user collections:** `worker/src/bunny.ts` — `ensureUserCollection(npub)` files each user's videos in their own collection (mapping `bunny_collections`, DB_META). The future video-upload flow must call it. Gated on Bunny secrets.
- **Vectorize — bounded + no-orphan:** one shared index (per-user indexes aren't possible — account caps in the low hundreds). Embeddings are stored **one per ENTITY**, deterministic id `<npub>:ent:<entityId>`, updated in place — so vector count is bounded by a user's entities (not events), and ids are derivable from `brain_entities` (NO separate per-vector table). Account deletion reads the user's entity ids → `deleteByIds` (batched 1000) → **no orphaned vectors accruing cost**. Recall uses the vectors' metadata (name+summary), so no D1 round-trip.
- **Right-to-erasure:** `POST /api/account/delete` (dual-auth, own account only) cascades — R2 `u/<npub>/*`, verification bucket `u/<npub>/*` + row keys, Bunny collection+videos, **Vectorize vectors (by id map)**, relay events (+tags), AvaBrain tables (incl. brain_vectors), media metadata, all DB_META identity/social rows, the user's own moderation reports. Content-level moderation records intentionally kept. The app's Delete-account button calls this BEFORE the Clerk delete. Migrations `bunny_collections.sql` + `brain_vectors` (in brain.sql), applied. All Workers re-verified (`tsc` + `wrangler --dry-run`).
- **DB isolation note:** one D1 per user isn't viable for a social app (loses directory search / contact matching; D1 db caps) — instead every table is strictly npub-scoped and the cascade is `WHERE npub=?` only, so cross-user deletion isn't possible. The bulk data + cost (R2, Bunny, Vectorize) IS fully per-user isolated.

## Session 6 — In-app notifications (native, 2026-06-05)

Server-originated system alerts (wallet, moderation, briefings, social) — NOT chat, so no E2E / Nostr. Built native on existing infra; no Novu. `notifications` table (DB_META) applied.
- **Realtime to open app:** the relay inbox DO gained an internal `POST /notify` that pushes a `["NOTIF", …]` frame to the user's authed sockets (reuses the already-open connection). The API Worker reaches it via a **cross-script DO binding** (`RELAY` → `RelayRoom` in `avatok-relay`).
- **Producer:** `worker/src/notify.ts › notifyUser(env, npub, {type,title,body,data})` = D1 insert + realtime + `Q_PUSH` background wake. Consumers have a lighter `consumers/src/notify.ts` (D1 + push); wired to fire on moderation removal. Ready for wallet/payment producers.
- **Feed API:** `GET /api/notifications` (paged), `GET /api/notifications/unread`, `POST /api/notifications/read` (dual-auth).
- **Flutter:** `NostrClient.notifications` stream (NOTIF frames over the existing socket), `core/notifications_api.dart`, `features/notifications/notifications_screen.dart` (bell-feed). Nav/bell-badge wiring is the remaining client step.
- **Erasure:** `notifications WHERE npub` added to the account-delete cascade. Migration `notifications.sql` (applied; added to `deploy.sh`). All 3 Workers `tsc` + `wrangler --dry-run` green (cross-script binding resolves).
