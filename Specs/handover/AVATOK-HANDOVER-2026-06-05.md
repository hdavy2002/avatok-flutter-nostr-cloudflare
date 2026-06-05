# AvaTok — Master Handover

**Date:** 2026-06-05
**Audience:** the next engineer/AI picking up this codebase.
**Status:** backend code-complete, type-checked, and `wrangler --dry-run`-verified across all Workers. **Deploys are held** until 3 secrets are provided and the APK is built (see §13). Nothing here is live in production yet except the provisioned infra (databases, queues, buckets, cache rules).

> How to use this doc: §2 is the map. §4 explains every backend component (what it does → key files → how the frontend uses it). §6 is the full API reference. §9 is "where to find what". §13 is what's left.

---

## 1. What AvaTok is (one paragraph)
A multi-app social ecosystem (chat, calls, public posts, communities, live, an AI memory layer) on a Cloudflare-only backend. Identity is a Nostr keypair (the user owns it) bound to a Clerk account. Real-time messaging runs over a Nostr relay; DMs are end-to-end encrypted. Everything is built to stay cheap and fast at 10M users: media served from the edge, DB reads from the nearest replica, async work on queues, per-user Durable Objects that hibernate when idle.

---

## 2. Architecture map

**Four Cloudflare Workers** (each a folder in the repo):

| Worker | Folder | Role |
|---|---|---|
| `avatok-api` | `worker/` | Control plane: directory, contacts, communities, media upload, ICE, backup, AvaBrain routes, notifications, account-delete, Stream webhook. Hosts the `CallRoom` + `UserBrain` Durable Objects. |
| `avatok-relay` | `relay/` | Nostr relay. **Per-user inbox Durable Object** (`RelayRoom`) over WebSocket (hibernating). Events persist to D1. Delivers DMs/mentions + realtime in-app notifications. |
| `avatok-consumers` | `consumers/` | Async layer: queue consumers (moderation, push, email, analytics, brain) + 6-hour cron. |
| `avatok-calls` | (pre-existing, untouched) | RealtimeKit/Stream token mint for group calls / AvaLive. |

**Data plane:**

| Thing | Name / ID | Used for |
|---|---|---|
| D1 `DB_META` | `avatok-meta` `c4ec8c0e-…` | identity link, profiles (+FTS), contacts (hashed), follows/blocks/mutes, settings, push tokens, communities, strikes, account status, verification, live_streams, bunny_collections, **notifications** |
| D1 `DB_MEDIA` | `avatok-media-meta` `79dc846e-…` | `user_media`, `user_media_hashes` (pHash) |
| D1 `DB_MODERATION` | `avatok-moderation` `770d5709-…` | `blocked_media_hashes`, `blocked_phash_bands` (LSH), `moderation_results`, `user_reports` |
| D1 `DB_RELAY` | `avatok-relay` `8ce3ca0d-…` | `nostr_events`, `nostr_tags` |
| D1 `DB_BRAIN` | `avatok-brain` `f5bfb712-…` | AvaBrain entities/relationships/facts/summaries/events |
| R2 `BLOBS` | `avatok-blobs` (public via `blossom.avatok.ai`) | all user media, content-addressed under per-user folders |
| R2 `VERIFICATION` | `avatok-verification` (locked) | ID/verification docs |
| KV `TOKENS` | `ab462ef0…` | ephemeral tokens only (FCM/APNs access tokens, JWKS cache) |
| Queues | `moderation`, `push-notifications`, `email`, `analytics`, `brain-events` | all async work |
| Vectorize | `avatok-semantic` (384-dim, cosine) | AvaBrain semantic memory |
| Analytics Engine | `avatok_metrics` | operational metrics (latency, queue, AI cost) |
| Durable Objects | `CallRoom`, `UserBrain` (in api), `RelayRoom` (in relay) | group calls, per-user brain, per-user relay inbox |
| Zone / Account | `avatok.ai` `ae74ddf9…` / account `fd3dbf43…` | — |

Cloudflare account: `hdavy2005@gmail.com`.

---

## 3. Auth model (read this before touching routes)

Two proofs, checked in `worker/src/auth.ts › authenticate()`:
- **NIP-98** (always required on mutations): the client signs a kind-27235 Nostr event (method + URL + body hash) and sends it base64 in the `X-Nostr-Auth` header. Proves the caller owns the npub. The server derives identity from the signature — **never from the request body**.
- **Clerk JWT** (required once `CLERK_JWKS_URL` is set, which `deploy.sh` does): a short-lived session JWT in `Authorization: Bearer`, verified against Clerk's public JWKS. Proves the verified account.

Public reads (`/api/resolve`, `/api/search`, `/api/communities`, `/api/ice`, `/health`) are unauthenticated and cached. Everything else is dual-auth. The Flutter side that produces these headers is `app/lib/core/api_auth.dart` (NIP-98 signer + `clerkBearer` hook + `X-Trace-Id`).

---

## 4. Backend components in detail

For each: **what it does → key files → how the frontend uses it.**

### 4.1 Identity & directory
- **What:** profiles keyed by npub; resolve by @handle / email / phone / npub; fuzzy people search via SQLite **FTS5**.
- **Files:** `worker/src/routes/api.ts` (`profileUpsert`, `resolve`, `search`); migrations `meta.sql`, `meta_fts.sql`. Hashing in `worker/src/util.ts` (email/phone are stored hashed, never raw).
- **Frontend:** `app/lib/features/avatok/contacts.dart` (`Directory.resolve/search/registerProfile`). Profile upsert is signed (npub from sig); resolve/search are public GETs.

### 4.2 Contacts ("who's on AvaTok")
- **What:** stateless phone/email matching — the server **does not store** your address book; it hashes the contacts you send and returns matches. Queries are **chunked to ≤90 params** (D1's 100-param cap).
- **Files:** `worker/src/routes/api.ts` (`contactsSync`, `contactsMatch`, `matchContacts`); `worker/src/util.ts › chunk()`.
- **Frontend:** `app/lib/core/device_contacts.dart`.

### 4.3 Communities
- **Files:** `worker/src/routes/api.ts` (`communityUpsert`, `communityJoin`, `communities`); tables in `meta.sql`.
- **Frontend:** `app/lib/core/community_store.dart`, `app/lib/features/communities/*`.

### 4.4 Media upload + storage (per-user folders)
- **What:** two paths — `/upload/public` (plaintext posts → AI moderation) and `/upload/private` (client-encrypted DM ciphertext, no scan). **Every object lives under a per-user folder:** `u/<npub>/public/<sha256>` or `u/<npub>/dm/<sha256>`. Reads are served straight from `blossom.avatok.ai` (public R2 + 30-day edge cache + tiered cache) — never through the Worker. The content sha256 still drives moderation/blocklist/dedup.
- **Files:** `worker/src/routes/media.ts` (`uploadPublic`, `uploadPrivate`, `getLibrary`, `mediaRedirect`, `userKey()`). Tables `media.sql` (+ `media_pending_index.sql`).
- **Frontend:** `app/lib/features/avatok/media.dart` (`MediaService.encryptAndUpload` / `downloadAndDecrypt`). The upload response returns `{hash, key, url}`; the app stores the full `key`/`url` so downloads hit Blossom directly.

### 4.5 Moderation (image + text + perceptual blocklist)
- **What:** public uploads are scanned async before going live. Image model `@cf/meta/llama-3.2-11b-vision-instruct` rates NSFW+violence (0..1); text model `@cf/meta/llama-guard-3-8b` (safe/unsafe). Thresholds: **≥0.85 reject** (+strike+blocklist+notify), **≥0.60 flag** (human review; verified users 0.90), else live. Identical bytes are never re-scanned (sha256 cache). A **DCT perceptual hash** (Photon WASM) + **LSH band index** catches resized/recompressed re-uploads via an indexed lookup (not a full scan). Model is swappable via `MODERATION_MODEL` / `MODERATION_MODEL_TYPE` (`vision`|`classifier`) — flip to a cheap NSFW classifier when one is in the catalog. **No OpenAI anywhere.**
- **Files:** `consumers/src/moderation.ts`, `consumers/src/phash.ts`; tables `moderation.sql`, `moderation_lsh.sql`, `moderation_phash_col.sql`. Producer side: `worker/src/routes/media.ts` enqueues `Q_MODERATION`.
- **Frontend:** transparent — the app uploads; status flips server-side. A removal sends the user a notification (§4.12).

### 4.6 Relay (real-time chat) — per-user inbox DO
- **What:** a Nostr relay (NIP-01/09/11/17/25/42/100). **Each user connects to their own Durable Object** (`idFromName(pubkey)`), which **hibernates** when idle (no bill for idle connections). DMs are NIP-17 gift-wrapped (E2E — server only sees ciphertext). Publishing fans a DM/mention out to the recipient's inbox DO over an internal `/deliver`; public posts persist to D1 and are read via `REQ`→D1. NIP-42 gates private kinds. REQ filter arrays are **chunked** to respect D1's param cap.
- **Files:** `relay/src/index.ts` (router, `?pubkey=` routing), `relay/src/relay_do.ts` (DO: hibernation handlers, `localDeliver`, `fanOut`, `queryFilter`, `/notify`), `relay/src/nip19.ts`. Tables `relay.sql`.
- **Frontend:** `app/lib/nostr/nostr_client.dart` (connects with `?pubkey=`, exposes `events`, `eose`, **`notifications`** streams), `app/lib/nostr/*` (nip17, ava_dm, etc.).

### 4.7 Calls (1:1 P2P + group)
- **What:** `/api/ice` mints short-lived STUN+TURN creds (Cloudflare Realtime TURN) so calls connect off-Wi-Fi. Group call signaling via the `CallRoom` DO. Call ring/decline/busy go through `/api/call`, `/api/call-status`, `/api/notify` → `Q_PUSH` (FCM/APNs wake).
- **Files:** `worker/src/routes/media.ts › getIce`, `worker/src/do/call_room.ts`, `worker/src/routes/api.ts` (call/callStatus/notify).
- **Frontend:** `app/lib/features/avatok/call_screen.dart`, `app/lib/features/avatok/chat_thread.dart › _call`, `app/lib/push/push_service.dart`.

### 4.8 Push notifications (FCM + APNs)
- **What:** `Q_PUSH` consumer resolves a user's device tokens and delivers. **FCM** (Android) fully wired; **APNs** (iOS) code-complete but **gated** behind `APNS_*` secrets (Android-first → skips cleanly if unset). Stale tokens are pruned on 404/410.
- **Files:** `consumers/src/fcm.ts`, `consumers/src/apns.ts`. Tokens table in `meta.sql`; registered via `/api/register`.
- **Frontend:** `app/lib/push/push_service.dart` (registers the FCM token, handles incoming call/CallKit).

### 4.9 Email (Brevo)
- **What:** `Q_EMAIL` consumer sends transactional email via Brevo (`api.brevo.com/v3/smtp/email`). Gated on `BREVO_API_KEY` (no-ops if unset). Resend removed.
- **Files:** `consumers/src/index.ts › sendEmail`.

### 4.10 AvaBrain (per-user AI memory)
- **What:** every user has a private knowledge graph (entities, relationships, facts, daily summaries) + semantic memory. **Learns from PUBLIC content only on the server** (kind-1/30023 via `Q_BRAIN`, public uploads); **DM-derived memory is client-side** and synced via `/api/brain/remember` (E2E preserved). Background extraction uses the **8B** model (`llama-3.1-8b-instruct-fp8`, never 70B on the hot path). Reasoning (`ask`/`briefing`) runs in the per-user `UserBrain` DO. `investigate` reads the user's PostHog event log (gated personal key) and explains issues.
- **Vectorize is bounded:** one vector **per entity** (deterministic id `<npub>:ent:<entityId>`, updated in place), embedded with `bge-small-en-v1.5` (384-dim), npub-filtered. No per-vector D1 table; vector count is bounded by entities, and deletion derives ids from `brain_entities`. Importance decays **lazily at read time** (no cron full-table writes).
- **Files:** `consumers/src/brain.ts` (extraction), `worker/src/do/user_brain.ts` (reasoning), `worker/src/routes/brain.ts` (routes), table `brain.sql`. Relay hook: `relay/src/relay_do.ts › enqueueBrain`.
- **Frontend:** `app/lib/core/brain_api.dart` (`ask/briefing/remember/investigate/entities/timeline`). **Remaining client work:** the AvaChat brain tab UI + on-device DM fact extraction → `BrainApi.remember`.

### 4.11 AvaLive / Stream webhook
- **What:** `POST /webhooks/stream` (HMAC-verified, gated) records live-stream lifecycle to `live_streams` and dispatches recordings to `Q_MODERATION`. Stream is enabled on the account.
- **Files:** `worker/src/routes/stream.ts`, table `stream.sql`.

### 4.12 In-app notifications (system alerts)
- **What:** server-originated alerts (wallet, moderation, briefings, social) — **not chat, no E2E**. Three deliveries: realtime to an open app (relay DO `/notify` → `["NOTIF",…]` over the existing socket, reached from the API via a **cross-script DO binding**), persistent feed in D1, and background push (`Q_PUSH`). Producer: `notifyUser(env, npub, {type,title,body,data})`.
- **Files:** `worker/src/notify.ts` (full: feed+realtime+push), `consumers/src/notify.ts` (feed+push), `worker/src/routes/notifications.ts` (list/unread/read), `relay/src/relay_do.ts › /notify`, table `notifications.sql`. Already fires on moderation removal.
- **Frontend:** `app/lib/core/notifications_api.dart`, `app/lib/features/notifications/notifications_screen.dart`, realtime via `NostrClient.notifications`. **Remaining client work:** bell badge + nav entry; wire a wallet/payment producer when that exists.

### 4.13 Account erasure (right-to-erasure)
- **What:** `POST /api/account/delete` (dual-auth, own account only) cascades: R2 `u/<npub>/*` (+ verification bucket), Bunny collection+videos, Vectorize vectors (by entity ids), relay events (+tags), all AvaBrain tables, media metadata, every DB_META identity/social/notifications row, the user's own moderation reports. Content-level moderation records are intentionally kept. The app calls this **before** the Clerk delete.
- **Files:** `worker/src/routes/account.ts`, `worker/src/bunny.ts`. Frontend: `app/lib/features/settings/settings_screen.dart › _delete`.

### 4.14 Observability
- **What:** three-way split — **PostHog** (user/product events, batched via `Q_ANALYTICS` → `${POSTHOG_HOST}/batch/`), **Analytics Engine** (`avatok_metrics`: API latency/route/status+trace, relay events/kind, queue ok/fail, AI scan/reason duration, cron counts), **Workers Logs** (raw). `X-Trace-Id` is minted client-side and threaded to the API metric.
- **Files:** `worker/src/index.ts` (latency+trace), `relay/src/relay_do.ts`, `consumers/src/*`. Client: `app/lib/core/api_auth.dart`.

---

## 5. Data store reference (key tables)

- **DB_META** (`meta.sql`, `meta_fts.sql`, `stream.sql`, `bunny_collections.sql`, `notifications.sql`): `clerk_nostr_link`, `profiles` (+`profiles_fts`), `contact_phone_index`, `follows`, `blocks`, `mutes`, `user_settings`, `push_tokens`, `communities`, `community_members`, `account_strikes`, `account_status`, `verification_requests`, `live_streams`, `bunny_collections`, `notifications`.
- **DB_MEDIA** (`media.sql`): `user_media` (key = R2 path `u/<npub>/…`), `user_media_hashes` (pHash).
- **DB_MODERATION** (`moderation.sql`, `moderation_lsh.sql`, `moderation_phash_col.sql`): `blocked_media_hashes`, `blocked_phash_bands`, `moderation_results` (+`phash` col), `user_reports`.
- **DB_RELAY** (`relay.sql`): `nostr_events`, `nostr_tags`.
- **DB_BRAIN** (`brain.sql`): `brain_entities`, `brain_relationships`, `brain_facts`, `brain_daily_summaries`, `brain_events` (30-day TTL).
- **R2 layout:** `u/<npub>/public/<sha256>`, `u/<npub>/dm/<sha256>`, `u/<npub>/backups/<ts>.json`; verification bucket `u/<npub>/…`.

D1 reads use the **Sessions API** (`db/shard.ts › metaSession/mediaSession/moderationSession/relaySession`) → nearest replica with read-your-writes within a request.

---

## 6. API reference (`avatok-api`)

Auth: ✦ = NIP-98 (+Clerk when enabled); ○ = public.

| Method | Path | Auth | Body / query | Returns |
|---|---|---|---|---|
| GET | `/health` | ○ | — | `{ok}` |
| POST | `/api/profile` | ✦ | `{handle,name,email,phone}` | `{ok,profile}` |
| GET | `/api/resolve?q=` | ○ | — | `{npub,profile}` |
| GET | `/api/search?q=` | ○ | — | `{results[]}` (FTS5) |
| POST | `/api/register` | ✦ | `{token,platform}` | `{ok,devices}` |
| POST | `/api/call` | ✦ | `{to,callId,kind,fromName}` | `{sent}` |
| POST | `/api/call-status` | ✦ | `{to,callId,status}` | `{sent}` |
| POST | `/api/notify` | ✦ | `{to[],fromName}` | `{sent}` |
| POST | `/api/contacts/sync` | ✦ | `{contacts[]}` | `{stored,matched[]}` |
| POST | `/api/contacts/match` | ✦ | `{contacts[]}` | `{matched[]}` |
| GET | `/api/contacts/list` | ✦ | — | `{contacts[]}` (stateless) |
| POST | `/api/community` | ✦ | `{name,about,members[]}` | `{community}` |
| POST | `/api/community/join` | ✦ | `{id}` | `{community}` |
| GET | `/api/communities?member=|id=` | ○ | — | `{communities[]}` |
| POST | `/upload/public` | ✦ | raw bytes + `x-content-type` | `{hash,key,url,status}` |
| POST | `/upload/private` | ✦ | raw ciphertext | `{hash,key,url,status}` |
| GET | `/api/library?type=&cursor=` | ✦ | — | `{items[],cursor}` |
| POST | `/api/backup` | ✦ | — | `{url,count}` |
| GET | `/api/ice` (or `/ice`) | ○ | — | `{iceServers[]}` |
| POST | `/webhooks/stream` | HMAC | Stream event | `{ok}` |
| GET | `/media/<sha256>` | ○ | — | 301 → Blossom |
| POST | `/api/brain/ask` | ✦ | `{question}` | `{answer}` |
| POST | `/api/brain/briefing` | ✦ | — | `{briefing}` |
| POST | `/api/brain/remember` | ✦ | `{facts[],entities[]}` | `{stored}` |
| POST | `/api/brain/investigate` | ✦ | `{complaint}` | `{diagnosis}` |
| DELETE | `/api/brain/forget` | ✦ | `{entity_id}` | `{ok}` |
| GET | `/api/brain/entities` | ✦ | — | `{entities[]}` |
| GET | `/api/brain/timeline` | ✦ | — | `{events[]}` |
| POST/DELETE | `/api/account/delete` | ✦ | — | `{deleted,counts}` |
| GET | `/api/notifications?cursor=` | ✦ | — | `{items[],cursor}` |
| GET | `/api/notifications/unread` | ✦ | — | `{unread}` |
| POST | `/api/notifications/read` | ✦ | `{ids[]|all}` | `{ok}` |

**Relay** (`avatok-relay`, `wss://avatok-relay.getmystuffme.workers.dev/?pubkey=<hex>`): Nostr `EVENT`/`REQ`/`CLOSE`/`AUTH` + server-pushed `["NOTIF",{…}]`. `GET /export?pubkey=`. Internal (DO-only): `/deliver`, `/notify`.

---

## 7. Frontend integration guide

The app talks to the backend through a few central helpers — start here:
- **`app/lib/core/api_auth.dart`** — the only thing that signs requests. `ApiAuth.postJson/getSigned/postBytes` attach NIP-98 + Clerk Bearer + trace id. `ApiAuth.identity` is the current Nostr identity (set in `IdentityStore`); `ApiAuth.clerkBearer` is wired in `main.dart`.
- **`app/lib/core/config.dart`** — every backend URL constant. Add new endpoints here.
- Feature clients: `brain_api.dart`, `notifications_api.dart`, `community_store.dart`, `device_contacts.dart`, `features/avatok/contacts.dart` (Directory), `features/avatok/media.dart` (MediaService).
- Real-time: `app/lib/nostr/nostr_client.dart` — `events`/`eose` (chat) and `notifications` (system alerts) streams over one socket.

**To add a new authenticated feature:** add a URL to `config.dart` → call via `ApiAuth.postJson/getSigned` → (server) add a handler in `worker/src/routes/*` and register it in `worker/src/index.ts`.

---

## 8. Config, vars & secrets

**Vars** (in `wrangler.toml`, non-secret): `BLOSSOM_BASE_URL`, `FCM_PROJECT`, `BRAIN_REASONER_MODEL`, `BRAIN_EMBED_MODEL`, `POSTHOG_QUERY_HOST`, `POSTHOG_PROJECT_ID` (api); `MODERATION_MODEL(_TYPE)`, `TEXT_MODERATION_MODEL`, `BRAIN_EXTRACT_MODEL`, `BRAIN_EMBED_MODEL`, `POSTHOG_HOST` (consumers).

**Secrets** (set by `secrets/deploy.sh` from `secrets/secret-values.env`):
- Known/auto: `POSTHOG_API_KEY` (phc_, public ingestion), `CLERK_JWKS_URL`, `CLERK_ISSUER`, `TURN_KEY_ID`, `BUNNY_LIBRARY_ID`.
- **You must provide** (`secret-values.env`): `BREVO_API_KEY`, `TURN_KEY_API_TOKEN`, `BUNNY_API_KEY`.
- Optional/gated: `POSTHOG_PERSONAL_API_KEY` (brain investigate reads), `STREAM_WEBHOOK_SECRET`, `APNS_KEY_ID/TEAM_ID/PRIVATE_KEY/BUNDLE_ID/PRODUCTION`.
- Already set: `FCM_SERVICE_ACCOUNT` (consumers).

Credentials live in the gitignored `secrets/` folder. Clerk JWT verification needs only the **public JWKS** — the `sk_live_…` key is not used by the backend.

---

## 9. Repo map (where to find what)

```
worker/                      → avatok-api
  src/index.ts               route dispatch + trace/latency wrapper; exports CallRoom, UserBrain
  src/auth.ts                NIP-98 + Clerk verification (authenticate())
  src/util.ts                json/CORS, sha256, hex, bech32 npub<->hex, chunk()
  src/db/shard.ts            D1 Sessions API helpers + decay/shard docs
  src/routes/api.ts          directory, contacts, communities, push/call, backup  (LIVE router)
  src/routes/media.ts        upload public/private, library, ICE, per-user keys
  src/routes/brain.ts        /api/brain/* → UserBrain DO
  src/routes/notifications.ts feed list/unread/read
  src/routes/account.ts      erasure cascade
  src/routes/stream.ts       Stream webhook
  src/routes/{identity,push,social}.ts   LEGACY scaffolds — NOT imported (safe to delete)
  src/do/call_room.ts        group-call signaling DO
  src/do/user_brain.ts       per-user AI reasoning DO
  src/notify.ts              notifyUser() producer (feed+realtime+push)
  src/bunny.ts               per-user Bunny collections + deletion
  migrations/*.sql           all schema (see §5)
relay/                       → avatok-relay
  src/index.ts               router (?pubkey routing), Env
  src/relay_do.ts            RelayRoom DO (hibernation, deliver, fanOut, queryFilter, /notify, brain hook)
  src/nip19.ts               bech32
consumers/                   → avatok-consumers
  src/index.ts               queue dispatch + cron; email; analytics batch
  src/moderation.ts          image scan, thresholds, pHash, LSH, notify-on-removal
  src/phash.ts               DCT perceptual hash (Photon WASM) + bands + hamming
  src/fcm.ts / apns.ts       push senders
  src/brain.ts               Q_BRAIN consumer (8B extract + entity embed)
  src/notify.ts              consumer-side notifyUser (feed+push)
  src/strikes.ts             strike escalation
app/lib/                     → Flutter app
  core/api_auth.dart         signed HTTP (NIP-98 + Clerk + trace)
  core/config.dart           all backend URLs
  core/{brain_api,notifications_api,community_store,device_contacts}.dart
  nostr/nostr_client.dart    relay WS (events/eose/notifications)
  features/…                 UI (avatok chat, communities, settings, notifications, …)
secrets/deploy.sh            one-command go-live (migrations + secrets + deploy)
secrets/secret-values.env.example   fill the 3 missing secrets here
Specs/                       all design/spec/handoff docs (incl. this folder)
```

---

## 10. Deploy / migrations runbook

1. `cp secrets/secret-values.env.example secrets/secret-values.env` and fill `BREVO_API_KEY`, `TURN_KEY_API_TOKEN`, `BUNNY_API_KEY` (+ optional ones).
2. `bash secrets/deploy.sh` — applies all D1 migrations, sets secrets (incl. Clerk JWKS/issuer), deploys `avatok-api` + `avatok-consumers` + `avatok-relay`.
3. ⚠️ Deploy **with** a fresh APK build — the compat layer is gone; the app must be the NIP-98/`/api/*` version.
4. Manual: delete old RealtimeKit apps `avaglobal`/`avablobal` in the dashboard (keep `avatok-calls`).

Provisioned infra already created live: all 5 D1 DBs (+ schemas), R2 buckets, KV, 5 queues, Vectorize, Blossom cache rule + tiered cache. Single-Worker deploy: `export CLOUDFLARE_API_TOKEN="$(cat secrets/cf_token)"; cd <dir> && npx wrangler deploy`.

---

## 11. Pending / not yet built
- **3 secrets** + `deploy.sh` + **CI APK build** + on-device smoke test.
- **iOS push (APNs):** code ready; needs an Apple `.p8` key.
- **Stream recording content-scan:** stubbed (image scan + pHash live).
- **Client UI follow-ups:** AvaChat brain tab + on-device DM fact extraction (`BrainApi.remember`); notifications bell badge + nav; a wallet/payment producer calling `notifyUser`.
- **Cheaper NSFW image model:** flip `MODERATION_MODEL`→classifier when one is in the catalog.
- **PostHog dashboards:** build once events flow.
- **Legacy cleanup:** `worker/src/routes/{identity,push,social}.ts` are unused.

---

## 12. Cost & scale posture (10M-user lens)
- **Media:** edge-cached, content-addressed, per-user folders — reads bypass the Worker; deletes are one prefix wipe.
- **D1:** every hot path indexed; reads on replicas; `IN()` chunked to ≤90; FTS5 for search; partial index for cron. Relay time-shard trigger documented in `db/shard.ts`.
- **AI:** moderation deduped by sha256 + pHash-cache; brain extraction on 8B; **vectors bounded per entity** (no per-event growth, no orphans on delete). Cost metered to Analytics Engine.
- **DOs:** per-user relay + brain DOs hibernate when idle.
- **No external vendors** beyond Clerk (auth), Brevo (email), Bunny (video), PostHog (analytics) — notifications and AI memory are native.

---

## 13. One-line state
Backend complete and verified; deploys held on 3 secrets + APK. After go-live the only non-backend gaps are client UI polish (brain tab, notif bell) and provider keys (APNs, cheaper NSFW model).

---

## 14. Doc index (in `Specs/`)
- `FINAL_AUDIT_REPORT.md` — technical audit + cost.
- `SCALE_AUDIT.md` — the 12 scale fixes.
- `BACKEND_REBUILD_HANDOFF.md` — session-by-session log (Sessions 1–6).
- `AVABRAIN-OBSERVABILITY-CORRECTED.md` — AI-layer design.
- `handover/AVATOK-HANDOVER-2026-06-05.md` — this file.
