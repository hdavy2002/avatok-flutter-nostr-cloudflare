# AvaTalk Network — Universal Cloudflare Architecture Rulebook v1.1

**MANDATORY. Embed in claude.md and memory.md for every AI builder session.**
**Where this doc and an older doc disagree, this doc wins.**

This rulebook governs ALL apps in the AvaTalk network — AvaChat, AvaTok, AvaTweet, AvaBook, AvaGram, AvaLinked, AvaTube, AvaLive, AvaDate, AvaMatri, AvaAgent, AvaVoice, AvaAI, AvaWeb, AvaNote, AvaAds, AvaExplore, AvaVerse, AvaLibrary, AvaCalendar, AvaWallet, AvaPay, AvaOffice, AvaFX, AvaMart, AvaHealth, AvaNews, and any future app.

Every app follows the same architecture. No exceptions. No app-specific infrastructure decisions.

---

## CHANGELOG

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-06-04 | Initial release. 20 services cataloged. |
| 1.1 | 2026-06-04 | Single DB_RELAY (not 16 shards — author-sharding breaks feeds + DM retrieval). 4 databases at launch (not 18 — split at 2GB). Two upload paths (public scan / private skip for E2EE media). NIP-42 AUTH scoped to private kinds only. Push tokens → D1 (spec §11.3 KV reference is stale). Phone discovery kept (spec "no phone directory" is stale). nostr_tags flattened index model. blocks/mutes tables added to DB_META. Reviewed/validated against live schema. Domain corrected to avatok.ai. |
| 1.2 | 2026-06-08 | Added CLIENT/FRONTEND STANDARDS section: (a) MANDATORY per-account scoping of ALL local user state (one phone is shared by a parent + child accounts; a global key leaks data across accounts), (b) the image/media caching pipeline (Cloudflare AVIF/q60 transform + on-device cache for public images; per-account decrypted cache for private DM media). Golden Rules 11–12 added. |
| 1.3 | 2026-06-08 | Added STORAGE, DEDUP-DISPLAY & AVABRAIN CONSENT standards (Golden Rules 13–15): one universal per-account storage pool (AvaLibrary/AvaStorage) shared by all apps — 5 GB free, then AvaCoins/GB/month from the wallet, read-only (never delete) on empty wallet; one real copy of any file (content-addressed) shown in many places via shortcuts, counted once, cached locally + Cloudflare; AvaBrain consent model + per-app guardrail toggles + on-device-only for private content. |
| 1.4 | 2026-06-08 | AvaBrain default changed to ON (opt-out): master switch in the main app Settings (default ON) + per-app/per-capability guardrail toggles (default ON); user can turn any off. The on-device-only guarantee for private/E2E content is unconditional regardless of toggle. Apps must wire their toggles into the main Settings + the ingestion pipeline. |
| 1.5 | 2026-06-08 | AvaTOK calls are 1:1 only — group calls are NOT allowed in AvaTOK (group calling lives in AvaConsult). Enforced at three layers: call buttons shown in 1:1 threads only, client `_call()` guards against groups, and the `CallRoom` DO caps a room at 2 peers (3rd peer refused with `busy`). Group chats keep full messaging/media; they just can't start a call. See Calls section. |
| 1.6 | 2026-06-10 | **RULE CHANGE (owner decision, Phase 10):** group conferences allowed in AvaTalk groups, ≤25 participants, via LiveKit. 1:1 stays P2P (CallRoom DO, 2-peer cap unchanged). Group/conference CONSULTING still lives in AvaConsult. >25-member groups: call icons disabled + notice popup. Gated by `conferenceEnabled`. Supersedes 1.5's "group calls NOT allowed". See Calls section. |

---

## THE GOLDEN RULES

1. **D1 is the database. Everything queryable goes in D1.**
2. **R2 public bucket serves media reads. No Worker in the read path.**
3. **Durable Objects handle all real-time WebSocket traffic. DOs are coordination, NOT storage.**
4. **Workers are thin HTTP handlers. Keep them stupid and fast (<10ms CPU).**
5. **KV is for ephemeral tokens only. 5 use cases, nothing else.**
6. **Cache API is free. Use it before reaching for KV.**
7. **Queues handle all async work. Never block a Worker on slow tasks.**
8. **Service Bindings for internal communication. Never HTTP between Workers.**
9. **Two upload paths: public media gets scanned; private DM media (ciphertext) skips the scan.**
10. **NIP-42 AUTH gates private kinds only. Public kinds stay open for federation.**
11. **ALL per-user local state is account-scoped. One phone is shared by a parent + each child — a global storage key leaks data across accounts. Scope every key.**
12. **Images & media are cached: public images via Cloudflare AVIF/q60 transform + on-device disk cache; private DM media via a per-account on-device decrypted cache. Never re-download on reopen.**
13. **One universal storage pool per account.** Every app shares the SAME AvaLibrary/AvaStorage quota — 5 GB free, then AvaCoins/GB/month deducted from the AvaWallet. Over quota with an empty wallet = read-only (view/download), NEVER delete the user's files.
14. **One real copy of any file; show it in many places via shortcuts.** Files are content-addressed → store ONE physical copy; "adding" a file to another folder is a shortcut (counted against storage ONCE). Cache it on-device AND via Cloudflare so we don't re-fetch.
15. **AvaBrain is ON by default; the user can turn it down (opt-out).** A master switch in the main app Settings (default ON) + per-app/per-capability guardrail toggles (default ON) let the user disable any capability anytime. Each app ships guardrail system prompts scoped to its function. UNCONDITIONAL guarantee regardless of toggle: private/E2E content is read ON-DEVICE only — never decrypted server-side. Wire every app's toggles into the main Settings AND the ingestion pipeline (a turned-off toggle = no ingestion).

---

## D1 TOPOLOGY (4 databases at launch)

The original Rulebook v1.0 specified 18 databases with author-based relay sharding (`npub % 16`). This was **wrong** for a Nostr relay workload:

- **Feed reads scatter:** loading a feed of 200 follows = querying all 16 shards. The hottest read path becomes a 16-way fan-out.
- **Gift-wrap DMs break:** NIP-17 kind-1059 events use random throwaway author keys. Author-sharding scatters a user's incoming DMs unfindably — you retrieve them by recipient (`#p` tag), not author.

**Corrected design: 4 databases, single relay.**

| Binding | Database | Contains | Split when |
|---|---|---|---|
| `DB_META` | avatok-meta | Identity link, profiles, phone hashes, follows, blocks, mutes, settings, push tokens, communities, strikes, verification | Any table > 2 GB |
| `DB_MEDIA` | avatok-media-meta | user_media metadata, perceptual hashes (AvaLibrary) | > 2 GB |
| `DB_MODERATION` | avatok-moderation | Blocked hashes, AI moderation result cache, user reports | > 2 GB |
| `DB_RELAY` | avatok-relay | nostr_events, nostr_tags | > 5 GB (time-shard: archive events older than N months to a second DB) |

Each database gets its own 25B reads / 50M writes / 5 GB free tier. 4 databases = 100B free reads total.

**Sharding router (`shard.ts`) is already written** so flipping DB_RELAY to multiple shards later is a config change, not a rewrite. But the shard key will be **time-based** (events before/after a cutoff date), NOT author-based.

---

## COMPLETE SERVICE CATALOG

### TIER 1 — CORE (every app uses these)

---

#### D1 — The Database

**What it is:** Serverless SQLite at Cloudflare's edge with global read replicas.

**Use for:** ALL app data. Profiles, contacts, messages metadata, posts, listings, calendar events, transactions, matches, settings, moderation records, media metadata, follows, blocks, mutes, push tokens, search indexes, analytics aggregates. Everything.

**Pricing:**
| | Free tier (included in $5 Workers Paid) | Overage |
|---|---|---|
| Rows read | **25 BILLION / month** per database | $0.001 / million |
| Rows written | **50 MILLION / month** per database | $1.00 / million |
| Storage | **5 GB per database** | $0.75 / GB |

**Rules:**
- Every query MUST use an index. No full table scans.
- Batch operations: `INSERT INTO ... VALUES (...), (...), (...)` — not loops.
- Contact matching: `WHERE phone_hash IN (?, ?, ?)` — not KV loops.
- Pagination: `WHERE created_at < ? ORDER BY created_at DESC LIMIT 20` — never `OFFSET`.
- New app-specific tables go in DB_META until any single table exceeds ~2 GB.
- Don't add an index a composite primary key already covers (a PK leads with its first column — `WHERE pk_col IN (...)` uses it). Dead indexes are write overhead.
- Read replicas are automatic and global. Reads are fast everywhere.

---

#### R2 — Blob Storage (Blossom)

**What it is:** S3-compatible object storage with zero egress fees.

**Use for:** Images, audio clips, documents, files. Content-addressed by SHA-256 hash (Blossom protocol). Both plaintext public media AND ciphertext private media live in the same bucket — ciphertext is safe to serve publicly because only the recipient holds the AES key.

**Pricing:**
| | Free tier | Overage |
|---|---|---|
| Storage | 10 GB / month | $0.015 / GB |
| Class A ops (writes) | 1M / month | $4.50 / million |
| Class B ops (reads) | 10M / month | $0.36 / million |
| Egress | **FREE. Always. Unlimited.** | $0 |

**Architecture: R2 public bucket for ALL reads.**

```
READS (99% of traffic):
  Client → blossom.avatok.ai/<hash> → CF Cache → R2 public bucket
  NO WORKER. Zero Worker invocations. Zero cost.

WRITES — two paths:

  Public media (posts, tweets, photos):
  Client → POST /upload/public → Worker (Clerk auth + Workers AI scan) → R2 PUT
  → D1 user_media row: visibility='public', encrypted=false, moderation_status='pending'→'passed'

  Private media (DM attachments):
  Client-side AES-256-GCM encrypt → POST /upload/private → Worker (Clerk auth only, NO scan)
  → R2 PUT (ciphertext) → D1 user_media row: visibility='private', encrypted=true, moderation_status='skipped'
  → AES key + IV sent inside MLS/NIP-44 encrypted DM message
```

**Why two paths:** You cannot scan ciphertext. Workers AI on encrypted bytes returns nothing. This is the Signal/WhatsApp pattern: public content is scanned aggressively; private DM media relies on recipient-reporting + strike system.

**Setup:**
1. R2 bucket `avatok-blobs` → Settings → Public Access → Connect Domain → `blossom.avatok.ai`
2. Cache Rule: `Cache Everything` for `blossom.avatok.ai/*` with 30-day edge TTL
3. Enable Smart Tiered Cache

---

#### Durable Objects — Real-Time Coordination

**What it is:** Single-threaded stateful actors with WebSocket support.

**Use for:** All real-time WebSocket connections. Nostr relay, call rooms, live streams, presence. DOs are **coordination, NOT storage** — events persist to D1, not DO SQLite.

**Pricing:**
| | Free tier | Overage |
|---|---|---|
| Requests | 1M / month | $0.15 / million |
| Duration | 400K GB-s / month | $12.50 / million GB-s |
| WebSocket incoming | **20:1 ratio** (20 msgs = 1 billed request) | Same |
| WebSocket outgoing | **FREE** | $0 |

**DO classes:**

| DO class | Purpose | State persistence |
|---|---|---|
| NostrRelay | WebSocket connections, event routing, subscriptions | Events → D1 (DB_RELAY). Connection state = memory only. |
| CallRoom | Active voice/video call state, signaling | Transient. Destroyed when call ends. |
| LiveStream | Active broadcast, viewer list, chat routing | Metadata → D1 (kind:30311). Chat = ephemeral. |
| PresenceTracker | Online/offline/typing per user | Purely transient. Never persisted. |

**Rules:**
- Use **WebSocket Hibernation** on ALL DO classes.
- The relay router Worker is a 3-line forwarder: get DO stub → forward. No auth, no D1, no KV.
- Auth (NIP-42) happens INSIDE the DO after WebSocket upgrade.
- DO writes to D1 on meaningful state changes. Reads from D1 on wake-up.
- Hot-path filters (a user's block/mute set) are cached in DO memory / Cache API, not re-read from D1 on every broadcast.

---

#### Workers — HTTP Control Plane

**What it is:** Stateless HTTP request handlers at the edge.

**Use for:** Upload endpoints, webhook receivers, API mutations, Bunny credentials, moderation dispatch, NIP-05 DNS lookups.

**Pricing:**
| | Included | Overage |
|---|---|---|
| Requests | 10M / month | $0.30 / million |
| CPU time | 30M ms / month | $0.02 / million ms |

**Rules:**
- Workers are THIN. Auth check → D1 query → return JSON. Target <10ms CPU.
- NEVER proxy media bytes through a Worker (except moderation scan on upload).
- Use `ctx.waitUntil()` for fire-and-forget (push, analytics).
- Use Service Bindings for Worker-to-Worker calls (free).
- Cache responses with Cache API for read-heavy endpoints.
- One API Worker with route-based dispatch. Not a Worker per app.

---

#### Cache API — Free Edge Cache

**What it is:** Per-PoP HTTP cache built into every Worker.

**Pricing:** $0. Always. No limits.

**Use for:**
| What | TTL |
|---|---|
| NIP-05 lookups | 1 hour |
| Public user profiles | 5 minutes |
| Feature flags | 5 minutes |
| App config | 10 minutes |
| Trending feeds | 1 minute |

**Rule:** Before using KV, ask: "Can Cache API handle this?" If yes → Cache API.

---

#### KV — Ephemeral Token Store (RESTRICTED)

**Pricing:** Reads $0.50/million, Writes $5.00/million. **500× more expensive than D1 reads.**

**ALLOWED (only these 5):**
1. Upload tokens: TTL 15 min
2. Rate limit counters: TTL = window duration
3. NIP-05 cache (if Cache API insufficient): TTL 1 hr
4. Feature flags (if Cache API insufficient)
5. CSRF/verification tokens: TTL 10 min

**BANNED:** Profiles, contacts, settings, push tokens, follows, messages, listings, calendar events, health records, wallet data, media metadata, search results, or ANY queryable data.

---

#### Pages — Static Hosting

**Pricing:** $0. Free. Unlimited.

**Use for:**
- `avatok.ai` — marketing website (React, SSG)
- `app.avatok.ai` — Flutter Web app shell

---

### TIER 2 — ESSENTIAL SUPPORT

---

#### Queues — Async Task Processing

**Pricing:** 1M ops/month free, then $0.40/million. One message = 3 ops (write+read+delete).

**Use for ALL of these (never sync in a Worker):**

| Queue | Producer | Consumer |
|---|---|---|
| `moderation` | Upload Worker | Workers AI scan |
| `push-notifications` | Relay DO (onEventSaved) | Push Worker → FCM/APNs |
| `email` | Various | Email Worker → novu/SES |
| `video-processing` | Bunny webhook | Metadata + thumbnail Worker |
| `analytics` | Various | PostHog/Analytics Engine batch |
| `cleanup` | Cron trigger | Cleanup Worker |
| `ai-agent` | Agent trigger | LLM call Worker |

**Rule:** If a task takes >50ms, calls an external API, or can fail and needs retry → Queue.

---

#### Cron Triggers — Scheduled Jobs

**Pricing:** $0 extra. Each trigger = 1 Worker invocation.

**Use for:** Health checks (1 min), trending recalculation (5 min), digest building (1 hr), token cleanup (6 hr), storage audit (24 hr), usage reports (weekly).

**Rule:** Cron Workers dispatch to Queues. Never do heavy processing in the cron handler itself.

---

#### Workers AI — Edge Inference

**Use for:** Image classification (moderation), text embedding (search), content summarization, translation, spam detection.

**Rules:**
- ALWAYS via Queue consumer, never synchronous in upload response.
- Cache AI results in D1 `moderation_results`. Don't re-scan the same image.
- Use smallest model that works.

---

#### Calls — SFU + TURN

**Pricing:** 1,000 GB/month free, then $0.05/GB. STUN free.

**Rules:**
- 1:1 = P2P first (STUN free). TURN on NAT failure (~15%).
- Group = SFU. One CallRoom DO per active call.
- 1,000 GB covers ~12K MAU.

**AvaTOK app rule (RULE CHANGE 2026-06-10, owner decision — Phase 10):**
Group conferences ARE allowed in AvaTalk groups, **≤25 participants, via LiveKit**.
1:1 stays P2P (CallRoom DO, 2-peer cap unchanged). Group/conference CONSULTING
still lives in **AvaConsult**. Enforcement: group-thread call buttons are active
only when `memberCount <= 25` (otherwise greyed + notice popup), the Worker
`routes/conference.ts` rejects start/join when the group exceeds 25 members, and
LiveKit `max_participants=25` is the server-side backstop. The **`CallRoom` DO
keeps its 2-peer cap** — it serves 1:1 only; group conferences NEVER touch it.
Group chats keep full messaging (text, media, voice notes, stickers, polls,
location, contact cards). Everything conference is gated by the
`conferenceEnabled` kill switch (`routes/config.ts`).

---

#### Stream Live — Live Video Ingest

**Pricing:** $0.10/min input, $1.00/1000 viewer-minutes, $5.00/1000 stored-minutes.

**Use for:** AvaLive only. Pre-recorded video → Bunny (cheaper). Post-stream recording → transfer to Bunny.

---

### TIER 3 — POWER FEATURES (use when needed)

---

#### Vectorize — Vector Database

**Use for:** Semantic search across apps (AvaSearch), AI agent memory, similar product recommendations (AvaMart), compatibility matching (AvaDate), content recommendations (AvaNews).

**Rules:**
- Embeddings via Workers AI (`bge-small-en-v1.5`, 384 dims), indexed async via Queue.
- Don't use for exact-match. That's D1 `WHERE field = ?`.

---

#### AI Gateway — AI Proxy & Observability

**Pricing:** Free (logging limits apply).

**Use for:** Proxy ALL external AI calls (OpenAI, Anthropic). Enables semantic caching, rate limiting, provider fallback.

**Rule:** Never call OpenAI/Anthropic directly. Route through AI Gateway.

---

#### Workflows — Durable Execution

**Use for:** Multi-step processes: AvaAgent tasks, AvaPay payment flows, AvaMatri match workflows, onboarding flows.

---

#### Containers — Long-Running Processes

**Use for (sparingly):** AvaOffice document rendering, heavy transcoding, local LLM models.

**Rule:** Last resort. Try Workers → DO → Queues → Workers AI first. Use `lite` instance (256 MiB).

---

#### Browser Rendering — Headless Chrome

**Use for:** Link previews, OG images, screenshot/PDF generation. Cache results aggressively.

---

#### Turnstile — Bot Protection

**Pricing:** $0. Free.

**Use for:** Signup forms, public content creation forms (prevent bot accounts/spam listings).

---

#### Analytics Engine — Custom Analytics

**Use for:** High-volume product metrics that would blow PostHog's budget. API latency, per-app usage counters.

---

### TIER 4 — DO NOT USE

| Service | Why not |
|---|---|
| Hyperdrive | No external databases. D1 is our database. |
| Workers for Platforms | Not a PaaS. |
| Zaraz | Marketing scripts. Not relevant. |
| Magic Transit | Enterprise overkill. |
| Spectrum | Calls handles WebRTC. DO handles WebSocket. |

---

## NIP-42 AUTH SCOPE

**Private kinds (require signed NIP-42 challenge):**
- Kind 14/13/1059 — NIP-17 gift-wrapped DMs
- Kind 25050 — call signaling
- Kind 10050 — inbox relay list
- Kind 10443 — MLS KeyPackages

**Public kinds (open for federated reads, no AUTH):**
- Kind 0 (profile), 1 (post), 3 (follows), 6 (repost), 7 (reaction)
- Kind 20 (picture), 30023 (long-form), 34235/34236 (video)
- Kind 30311/1311 (live stream), 10002 (relay list), 10063 (blossom list)

---

## RELAY ARCHITECTURE (nostr_tags index)

The relay stores events in D1 with a flattened tag index:

```sql
-- Events table
CREATE TABLE nostr_events (
  id TEXT PRIMARY KEY,            -- 32-byte hex event id
  pubkey TEXT NOT NULL,           -- author (random for gift wraps)
  created_at INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  tags TEXT NOT NULL,             -- JSON array (full tags)
  content TEXT NOT NULL,
  sig TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_evt_kind_created ON nostr_events(kind, created_at DESC);
CREATE INDEX idx_evt_pubkey_created ON nostr_events(pubkey, created_at DESC);

-- Flattened single-letter tag index
CREATE TABLE nostr_tags (
  event_id TEXT NOT NULL,
  tag TEXT NOT NULL,              -- 'p','e','d','a',...
  value TEXT NOT NULL,
  kind INTEGER NOT NULL,          -- denormalized from event (enables filtered tag lookups)
  created_at INTEGER NOT NULL,    -- denormalized (enables time-ordered results)
  PRIMARY KEY (event_id, tag, value)
);
CREATE INDEX idx_tags_lookup ON nostr_tags(tag, value, created_at DESC);
```

**Key query patterns:**

| Query | SQL |
|---|---|
| DM delivery for user X | `WHERE tag='p' AND value=? AND kind=1059 ORDER BY created_at DESC` |
| Reply thread | `WHERE tag='e' AND value=? ORDER BY created_at DESC` |
| Replaceable event | `WHERE tag='d' AND value=? AND kind=?` |
| Live activity reference | `WHERE tag='a' AND value=?` |
| Feed (followed authors) | `SELECT * FROM nostr_events WHERE pubkey IN (?) AND kind=1 ORDER BY created_at DESC LIMIT 20` |

The `kind` column in `nostr_tags` is critical — it prevents DM recipient lookups from scanning reaction tags, mention tags, etc. Only `#p` tags on kind-1059 events are returned.

---

## UNIVERSAL DECISION TREES

### "Where does this data go?"

```
Binary file (image, audio, document)? → R2 (Blossom). Metadata → D1.
Video file? → Bunny Stream. Metadata → D1.
Real-time transient state (online, typing, in call)? → DO memory. Not persisted.
Ephemeral token (<15 min TTL)? → KV.
Read-heavy public value? → Cache API (free).
Anything else? → D1.
When in doubt → D1.
```

### "Should this be sync or async?"

```
<50ms, no external API? → Sync in Worker.
External API call (FCM, OpenAI, Bunny, novu)? → Queue.
AI inference? → Queue (200ms-30s).
Fan-out to multiple recipients? → Queue.
Can fail, needs retry? → Queue.
```

### "Does this request need a Worker?"

```
Reading a static file? → No. R2 public bucket / Bunny / Pages.
Reading a cacheable response? → Cache API first. Worker on miss only.
Nostr event? → DO WebSocket. Worker only routes initial connection.
Upload? → Yes. Auth + moderation (public) or auth-only (private).
API mutation? → Yes. Auth + D1 write.
Webhook? → Yes. Dispatch to Queue.
```

### "How do Workers communicate?"

```
Worker → Worker: Service Binding (free)
Worker → DO: DO Binding (1 request charge)
DO → Worker: Service Binding (free)
Worker → Queue: Queue Binding (1 queue op)
Cron → Worker: Automatic (1 invocation)
NEVER: fetch('https://other-worker...') — banned
```

---

## STANDARD APP TEMPLATE

Every new app follows this pattern:

**Data:** Add tables to DB_META (D1). Media → Blossom/Bunny. Nostr kind → add to event mapping. Real-time sync via relay DO WebSocket.

**API:** HTTP endpoints in the API Worker. Auth + validate on mutations. D1 reads with Cache API for public data. All external calls → Queue.

**Search:** D1 `LIKE` for simple search (<100K rows). Vectorize for semantic search beyond that. Embeddings indexed async via Queue.

---

## COST MODEL

### 10K MAU
| Service | Monthly |
|---|---|
| Workers Paid (base) | $5 |
| D1 (4 databases) | $0 |
| R2 (images) | $1-4 |
| KV (tokens only) | $0 |
| DO (relay + calls) | $0-1 |
| Cache API | $0 |
| Queues | $0 |
| Workers AI | $0-2 |
| Calls SFU+TURN | $0 |
| Stream Live | $5-8 |
| Bunny video | $20-90 |
| Clerk | $0 |
| PostHog | $0-30 |
| Fixed | $15 |
| **TOTAL** | **$46-155** |

### 100K MAU: $300-1,030
### 10M MAU: $3,865-16,550 (Bunny video = 50-60% of total)

---

## CLIENT / FRONTEND STANDARDS (all Flutter apps)

These are MANDATORY for every AvaVerse client app. They exist because **one phone
is routinely shared by multiple accounts** (a parent and each of their children),
and because re-downloading media on every screen entry is slow and expensive.

### 1. Per-account scoping (no cross-account data leaks)

- **Every** piece of per-user local state — secure storage, SharedPreferences,
  and on-disk file caches — MUST be namespaced to the active account.
- Use `scopedKey(base)` / `readScoped(...)` (`app/lib/core/account_storage.dart`)
  for key/value stores, or a per-account subdirectory using `AccountScope.id` for
  file caches. `AccountScope.id` is set on login and tracks the active Clerk account.
- **Never** read/write a raw constant key for user data. A global key = a data leak
  the moment a second account logs in on the same device.
- **Only** device-level, account-agnostic values may stay global (e.g. the Clerk
  *client* token, which represents the device's Clerk client, not a user).
- New accounts start empty and restore their own data from the per-npub server
  vault (`/api/vault`, encrypted) via `pullAndMerge` — never inherit another
  account's local data.
- Checklist when adding ANY new store: does it hold user data? → it MUST go through
  `scopedKey`/`AccountScope`. There is no "I'll scope it later."

### 2. Image & media caching pipeline

**Public images** (avatars, public posts, thumbnails):
1. Upload plaintext to `/upload/public` → canonical blossom URL
   (`https://blossom.avatok.ai/u/<npub>/public/<sha256>`).
2. **Serve** through Cloudflare Image Transformations (enabled on the zone):
   `https://blossom.avatok.ai/cdn-cgi/image/format=avif,quality=60,width=N,fit=cover/<path>`.
3. **Cache** the transformed bytes on-device (content-addressed → immutable →
   cache forever). Helper: `app/lib/core/avatar_cache.dart` (`AvatarCache`).
   The `Avatar` widget renders cached photos with an initials fallback.

**Private / E2E DM media** (images, voice, video, files): ciphertext is
content-addressed on R2 and CANNOT be CF-transformed. Instead cache the
**decrypted** bytes on-device, **per account**
(`getApplicationSupportDirectory()/media/<AccountScope.id>/<hash>`). Implemented in
`MediaService.downloadAndDecrypt`. Reopening a chat or returning from another app
must never re-download or re-decrypt.

**Text messages / contacts**: load local-first from the (account-scoped) cache so
the UI is instant, then reconcile with the relay/server in the background.

### 3. Universal storage + dedup display (AvaLibrary / AvaStorage)

- **One storage pool per account, shared by EVERY app.** A user's files from
  AvaTok, AvaDoc, AvaGram, … all count against a single quota. AvaLibrary is the
  file manager (root folder per app → category folders); AvaStorage is the
  quota/usage view (coloured bars per type, total used, space left).
- **Quota & billing:** **5 GB free** per account (configurable default), then
  **AvaCoins per GB per month** (default **20 AvaCoins/GB/month**; 1 AvaCoin =
  $0.01) deducted from the **AvaWallet**. Storage is one of several AvaCoin sinks
  (alongside dating, gifts, etc.).
- **Empty wallet over quota = READ-ONLY, never delete.** The user can still view
  and download; they just can't add more until they top up. We do not delete a
  paying-then-lapsed user's files.
- **One real copy; shortcuts everywhere.** Files are content-addressed, so identical
  content is stored ONCE. Putting a file in another folder is a **shortcut** ("Add
  to folder"), not a duplicate — it shows in both places but is **counted against
  storage only once**. A file's bytes are freed only when it's removed from ALL
  folders / emptied from trash. Editing a shared file changes it everywhere (it's
  the same file) — label the action accordingly.
- **Cache on-device AND at Cloudflare.** Public files: CF `/cdn-cgi/image` AVIF/q60
  + on-device cache. Private: per-account decrypted on-device cache. Goal: a file
  is fetched from origin at most once per device.

### 4. AvaBrain consent & guardrails (privacy-first AI)

AvaBrain is the AI memory/RAG layer. It must learn ONLY what the user has
explicitly allowed — for EVERY app, now and future.

- **Default ON (opt-out).** AvaBrain is enabled by default so it's useful out of
  the box; the user can turn it down anytime. (The privacy guarantee below holds
  regardless.)
- **Master switch (main Settings) + granular per-capability toggles.** The main
  app Settings has a master "AvaBrain" switch (default ON), plus per-app/
  per-capability toggles (default ON) — e.g. "read my AvaTok DMs", "keep a tab on
  my files", "learn from my notes". Each app defines its own toggles in terms of
  its own functionality, and **registers them into the main Settings**. A toggle
  that's off = that source is NOT ingested.
- **Per-app guardrail prompts.** Every app ships system prompts that scope what
  AvaBrain may do with that app's data (its lane), so the AI stays on-task and
  within the user's grant.
- **Wire toggles to the pipeline.** Ingestion (Q_BRAIN producers / on-device
  extractors) MUST check the relevant toggle before learning from anything.
- **Public vs private boundary (hard line):** public content may be processed
  server-side; **private/E2E content (DMs, private files) is read ON-DEVICE only**
  — the client extracts/derives, and only non-reversible derived data (a summary
  or the embedding vector) is sent to the brain. Plaintext and keys never leave
  the device. (See Golden Rule 9/10 + the E2E rule.)
- **Revocable & forgettable.** Turning a toggle off stops new ingestion; the user
  can purge what AvaBrain learned from a source. Account deletion purges brain
  vectors/facts too.

---

## BANNED PATTERNS

❌ Raw/global storage key for per-user data → `scopedKey(...)` / `AccountScope.id` (cross-account leak)
❌ Re-downloading the same image/media on every screen entry → on-device cache (CF-AVIF for public, decrypted per-account for DM)
❌ Serving raw full-size images to the client → Cloudflare `/cdn-cgi/image` AVIF/q60 transform
❌ Per-app or separate storage quotas → ONE universal per-account pool (AvaLibrary/AvaStorage)
❌ Storing a second physical copy when a file is "copied" to another folder → shortcut, counted once
❌ Deleting a user's files because their wallet is empty → read-only until top-up
❌ Feeding private/DM content to AvaBrain SERVER-SIDE → read on-device only (default-ON is fine; the processing location is not)
❌ Ingesting into AvaBrain without checking the user's toggle → gate every ingest on the (default-ON) consent toggle
❌ Per-app AvaBrain settings that don't surface in the main Settings → register every toggle in the main app Settings
❌ `KV.get()`/`KV.put()` for app data → D1
❌ Proxying R2 reads through a Worker → R2 public bucket
❌ Auth in relay router Worker → Auth in DO via NIP-42
❌ Sync AI inference in request path → Queue
❌ Sync push notification in request path → Queue
❌ `fetch('https://other-worker...')` internally → Service Binding
❌ Full table scans in D1 → Add an index
❌ `OFFSET` pagination → Cursor/keyset pagination
❌ Polling for updates → WebSocket subscription via relay DO
❌ Scanning encrypted DM media → Skipped (Signal pattern, recipient-report only)
❌ NIP-42 AUTH on public kinds → Gate private kinds only (breaks federation)
❌ Author-based relay sharding → Time-based sharding when >5 GB
❌ Storing media metadata in R2 → D1 `user_media` table
❌ Redundant index a composite PK already covers → Drop it (write overhead)
❌ Running cron jobs >30s → Dispatch to Queue
❌ Calling external AI without AI Gateway → Route through Gateway
❌ One Worker per app → One API Worker, route-based dispatch
❌ Containers for anything a Worker handles → Workers first
