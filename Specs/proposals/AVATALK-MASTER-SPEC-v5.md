# AvaTalk Network — Master Specification v5

**Version:** 5.0 (June 2026)
**Status:** Living document. This is the authoritative spec.
**Domain:** abertalk.ai (parent brand), avatok.ai (live product, Clerk-authenticated)

> **IF YOU ARE AN AI BUILDER:** treat this document as the single source of truth.
> If an older spec, README, or prompt contradicts something here, this document wins.
> Read end to end before writing any code.

---

## 1. Vision

**One verified identity. Every social format. An AI brain that remembers everything,
and an AI agent that acts for you.**

AvaTalk is a network of social apps sharing one user identity (a Nostr keypair
linked to a Clerk account), one media library, one AI brain, and one platform
layer. One login replaces 8+ social platforms; content created in one app is
reusable in any other; your personal AI remembers across all of them; one wallet,
calendar, and payout system serve the entire ecosystem; and your AI agent
represents you across the network — networking, negotiating, and connecting
with other users' agents while you sleep.

**Marketing pillars:**
1. One login, many apps — Facebook + Twitter + Instagram + WhatsApp + YouTube + Twitch + Tinder + OLX, one account.
2. Cross-post in one tap — post a photo to AvaGram, share on AvaBook and AvaTweet instantly.
3. Every account is a verified human — no bots, no catfish, no spam farms.
4. Your AI brain remembers everything — across all apps, all conversations, all time.
5. Earn and spend seamlessly — AvaCoins power tips, bookings, and paid content everywhere.
6. Your AI agent works while you don't — it networks, negotiates, and connects on your behalf.

**Primary launch market:** India. Android-first. Hindi + English.

---

## 2. App Pack

**12 social apps + 1 AI app (AvaBrain) + 4 platform foundation apps = 17 total.**

### 2.1 Social apps

| # | App | Replaces | Primary primitives |
|---|---|---|---|
| 1 | **AvaChat** | WhatsApp / Messenger | Nostr DMs (NIP-17 E2E) + Blossom + CF Calls SFU |
| 2 | **AvaTok** | FaceTime (1:1 video) | WebRTC P2P + NIP-100 signaling |
| 3 | **AvaTweet** | Twitter / X | Nostr kind 1 + Blossom-on-R2 |
| 4 | **AvaBook** | Facebook | Nostr kind 1 + media + graph |
| 5 | **AvaGram** | Instagram | Nostr kind 20 + Bunny (reels) |
| 6 | **AvaLinked** | LinkedIn | Nostr kind 30023 (long-form) |
| 7 | **AvaTube** | YouTube | Nostr kind 34235 + Bunny Stream |
| 8 | **AvaLive** | Twitch | CF Stream Live + NIP-53 |
| 9 | **AvaDate** | Tinder | Profile matching + Vectorize |
| 10 | **AvaMatri** | Shaadi.com | Matrimonial-specific UX |
| 11 | **AvaLibrary** | — | Cross-app media manager |
| 12 | **AvaOLX** | OLX / Craigslist | Classifieds + digital marketplace + agent negotiation |

### 2.2 AI app

| # | App | Role |
|---|---|---|
| 13 | **AvaBrain** | Standalone AI — memory, reasoning, agent management, Agent Inbox |

### 2.3 Platform foundation apps

| # | App | Role |
|---|---|---|
| 14 | **AvaWallet** | Money layer — AvaCoins, free-form top-up, spend, earn |
| 15 | **AvaCalendar** | Scheduling — bookings, events, cron reminders |
| 16 | **AvaPayout** | Creator withdrawals — Wise API direct to bank |
| 17 | **AvaID** | Identity verification — AWS Rekognition liveness + delete cascade |

**AvaBrain is a separate app**, not a tab in AvaChat. It now includes the Agent
Inbox (centralized view of all agent-to-agent conversations).

**Flutter is the app framework. All apps. All platforms.**
React is ONLY for the marketing website (abertalk.ai).

---

## 3. Architecture — What's Deployed

### 3.1 Four Workers

| Worker | Role | Status |
|---|---|---|
| `avatok-api` | Control plane — `/api/*` routes, dual auth, media upload, ICE credentials, Stream webhook, CallRoom DO, UserBrain DO, WalletDO, StreamSessionDO, AgentDO, ConversationDO | Built, verified |
| `avatok-relay` | Nostr relay — per-user inbox DOs (hibernating), events → D1, Q_BRAIN dispatch for public posts | Built, verified |
| `avatok-consumers` | Queue consumers (moderation, push, email, analytics, brain, wallet, delete, agent) + 6h cron | Built, verified |
| `avatok-calls` | RealtimeKit/Stream token mint (pre-existing, untouched) | Live |

### 3.2 Six D1 Databases (all APAC, read replication auto)

| Binding | Database | Purpose |
|---|---|---|
| DB_META | avatok-meta | Identity, profiles, follows, blocks, mutes, settings, push tokens, strikes, verification, calendar, deletion, agent personas, agent inbox |
| DB_RELAY | avatok-relay | nostr_events + nostr_tags (flattened single-letter index) |
| DB_MEDIA | avatok-media | user_media, user_media_hashes (pHash), olx_listings, olx_digital_products |
| DB_MODERATION | avatok-moderation | blocked_media_hashes, moderation_results, user_reports |
| DB_BRAIN | avatok-brain | brain_entities, brain_relationships, brain_facts, brain_daily_summaries, brain_events |
| DB_WALLET | avatok-wallet | wallet_balances, wallet_transactions, topup_records, earning_holds, payout_accounts, payout_requests, commission_rates |

### 3.3 Other Infrastructure

| Resource | Purpose |
|---|---|
| **R2 `avatok-blobs`** | Public media (Blossom), served via `blossom.avatok.ai` (30-day edge cache) |
| **R2 `avatok-verification`** | Locked — selfie videos. Permanent until account deletion. |
| **R2 `avatok-agent-audio`** | Agent conversation audio (TTS-synthesized voice recordings) |
| **KV `avatok-tokens`** | Ephemeral tokens + verification cache (`verified:{npub}`, 1h TTL) |
| **Queue `moderation-jobs`** | Image/text moderation |
| **Queue `push-notifications`** | FCM/APNs delivery |
| **Queue `email-notifications`** | Brevo email |
| **Queue `analytics-events`** | PostHog batched ingestion |
| **Queue `brain-events`** | AvaBrain fact extraction |
| **Queue `wallet-transactions`** | Wallet audit trail (DO → D1) |
| **Queue `account-deletions`** | Delete cascade |
| **Queue `agent-tasks`** | Agent task dispatch and conversation processing |
| **Vectorize `avatok-semantic`** | 384-dim cosine index (bge-small-en-v1.5), npub-scoped |
| **Analytics Engine** | Operational metrics |
| **Cloudflare Stream** | 71 live inputs (AvaLive) |
| **Zone `avatok.ai`** | DNS, cache rules, custom domains |

### 3.4 External Services

| Service | Purpose |
|---|---|
| **Clerk** | Account auth (phone/email/OAuth, MFA, recovery) |
| **Bunny.net** | Video storage + transcoding + HLS delivery |
| **Stripe** | Top-up payments (AvaCoins via Checkout) |
| **Wise** | Creator payouts — direct bank transfer |
| **PostHog** | Product analytics, user journeys, error tracking (US cloud) |
| **Brevo** | Transactional email |
| **FCM / APNs** | Push delivery |
| **AWS Rekognition** | Face Liveness detection for AvaID (the ONE external AI service) |

**Total vendor count: 8** (Cloudflare, Bunny, Clerk, Stripe, Wise, PostHog, Brevo, AWS).
Cloudflare handles ~80% of infrastructure including ALL AI inference (LLM, TTS, STT, embeddings).
No OpenAI/Anthropic API calls in the backend.

---

## 4. Identity & Authentication

### 4.1 Dual auth — both required on mutations, reads open

| Layer | What | Purpose |
|---|---|---|
| **Clerk JWT** | Verified account (phone/email/OAuth) | "This person has a verified account" |
| **NIP-98 signature** | Nostr keypair ownership | "This person controls this npub" |

Every mutation requires BOTH. Reads are open.
The npub is the universal identity across all apps.

**Key storage:** nsec ONLY on device (flutter_secure_storage). Optional NIP-49 backup.

### 4.2 Two-tier access model (AvaID gating)

| Tier | Requires | Apps |
|---|---|---|
| **Tier 1** | Clerk signup | AvaChat, AvaTok, AvaBrain, AvaWallet, AvaCalendar, AvaOLX (browse only) |
| **Tier 2** | AvaID verification | AvaDate, AvaMatri, AvaBook, AvaGram, AvaTweet, AvaLinked, AvaLive, AvaTube, AvaOLX (list/sell) |

Tier 2 routes run `requireVerified()` middleware (KV-cached, 1h TTL).

---

## 5. Data Layer

### 5.1 D1 facts
- 25B rows_read/month per account
- D1 Sessions API → replica reads at ~330 edge PoPs
- Writes to primary (APAC)
- 100 bound params (chunk at ≤90)
- ~10 GB soft ceiling per database

### 5.2 Key indexes (all hot paths)
- Profiles: `(handle)`, `(email_hash)`, FTS5
- Contacts: `(phone_hash)`
- Media: `(npub, created_at)`
- Relay: `(kind, pubkey, created_at)`, `(tag, value, created_at)`
- Moderation: LSH band index on pHash
- Wallet: `(npub, created_at)`, `(reference_id)`, partial on holds
- Calendar: `(owner_npub, start_time)`, `(attendee_npub, start_time)`
- Payout: `(npub, requested_at)`, `(status)`
- Verification: `(npub, created_at)` on attempts
- Deletion: partial on `(status, scheduled_at)`
- Agent: `(npub, app_name)` on personas, `(npub, created_at)` on inbox

### 5.3 Relay sharding
Per-user inbox DOs (hibernating). DMs fan out to recipient DOs. Public posts to D1.
Time-shard at ~5 GB documented but not triggered.

---

## 6. AI Layer

### 6.1 Models (all Workers AI except AWS Rekognition)

| Purpose | Model | Notes |
|---|---|---|
| **General intelligence** | `@cf/google/gemma-4-26b-a4b-it` | MoE 26B/4B active. Vision, reasoning, tool calling, 256K context, 35+ languages. Brain extraction, reasoning, image moderation, agent conversations. |
| **Text moderation** | `@cf/meta/llama-guard-3-8b` | Purpose-built safety classifier. |
| **Embeddings** | `@cf/baai/bge-small-en-v1.5` | 384-dim. Matches Vectorize. |
| **Image processing** | `@cf-wasm/photon` | WASM pHash. |
| **Text-to-Speech** | `@cf/deepgram/aura-2-en` | 40 voices. Context-aware, natural pacing. Used for agent conversation audio synthesis. |
| **Speech-to-Text** | `@cf/deepgram/nova-3` | Fast multilingual transcription. Used for voice message input to brain/agent. |

### 6.2 External AI (one exception)

| Service | Purpose | Justification |
|---|---|---|
| **AWS Rekognition Face Liveness** | AvaID verification | Specialized security. Free 5K/month for 12 months. |

### 6.3 TTS voice options (onboarding)

Users choose their agent voice from Deepgram Aura-2's 40 voices during onboarding.
Selected voice ID stored in profile. Used whenever agent conversations are
synthesized to audio.

Available voices include: luna, atlas, orion, athena, zeus, apollo, aurora, iris,
hermes, perseus, hera, stella, minerva, neptune, jupiter, saturn, mars, orpheus,
pandora, ophelia, juno, callista, cordelia, delia, thalia, and more.

### 6.4 Why Gemma 4
Replaces three models. Brain extraction + reasoning + image moderation + agent
conversations all use one model. 4B active cost. Tool-calling capability powers
the agentic layer.

### 6.5 Model selection rules
- **Background extraction** (Q_BRAIN): `gemma-4-26b-a4b-it` — cost-efficient
- **On-demand reasoning** (ask, briefing, investigate): `gemma-4-26b-a4b-it` with thinking mode
- **Image moderation**: `gemma-4-26b-a4b-it` with vision, sha256 dedupe
- **Text moderation**: `llama-guard-3-8b`
- **Embeddings**: `bge-small-en-v1.5` (384-dim, must match Vectorize)
- **Agent conversations**: `gemma-4-26b-a4b-it` with tool calling + persona system prompt
- **Voice synthesis**: `deepgram/aura-2-en` — post-conversation TTS
- **Voice input**: `deepgram/nova-3` — voice commands to brain/agent
- **Face liveness**: AWS Rekognition

### 6.6 Cost discipline
- Workers AI: 10K neurons/day free, then $0.011/1K
- Gemma 4 at 4B active: ~4× cheaper than 8B, ~27× cheaper than 70B
- sha256 dedupe + pHash cache reduce AI calls
- TTS: charged per character (Deepgram pricing via Workers AI)
- Agent conversations: typically 10-20 turns × ~100 tokens = ~2K tokens per conversation
- Duration to Analytics Engine as cost proxy

---

## 7. AvaBrain (v2 — Knowledge + Action)

### 7.1 Concept

Every user has one AvaBrain. It evolved from a passive memory system (v1) to an
active agent (v2). The brain KNOWS things and DOES things.

| Capability | v1 (built) | v2 (new) |
|---|---|---|
| Remember facts | ✓ | ✓ |
| Answer questions | ✓ | ✓ |
| Daily briefings | ✓ | ✓ |
| Investigate problems | ✓ | ✓ |
| **Agent conversations** | — | ✓ Talk to other users' agents |
| **Task execution** | — | ✓ Browse web, post content, schedule meetings |
| **Per-app personas** | — | ✓ Different personality per app context |
| **Voice** | — | ✓ TTS-synthesized agent voice |
| **Agent Inbox** | — | ✓ Centralized conversation hub |

**Two data paths (unchanged from v1):**

| Source | Processing | Path |
|---|---|---|
| **Public content** | Server-side, automatic | Relay → Q_BRAIN → brain consumer |
| **Private/E2E content** | Client-side, opt-in | App extracts → `POST /api/brain/remember` |
| **Platform events** | Server-side, automatic | Platform app → Q_BRAIN |
| **Agent conversations** | Server-side, scoped | ConversationDO → Q_BRAIN (persona-scoped facts only) |

**The server NEVER sees DM plaintext.** Unchanged.

### 7.2 Knowledge graph (DB_BRAIN)
Five tables: brain_entities, brain_relationships, brain_facts, brain_daily_summaries, brain_events.
Entities have `scope`: `'public'` | `'private'` | `'agent:{app_name}'`.

### 7.3 UserBrain DO
Per-user DO (keyed by npub), WebSocket Hibernation. Original methods plus new agent methods:

| Method | What |
|---|---|
| `ask(question)` | Query knowledge graph + vector search |
| `briefing()` | Daily summary + upcoming calendar + agent inbox highlights |
| `investigate(complaint)` | Query PostHog events |
| `remember(facts)` | Client-synced DM facts |
| `forget(entity_id)` | Delete entity + relationships |
| `agentChat(targetNpub, appName)` | Initiate agent-to-agent conversation |
| `getInbox()` | Fetch agent inbox (all conversations across apps) |

### 7.4 Brain API routes
```
POST   /api/brain/ask          { question }
POST   /api/brain/briefing
POST   /api/brain/remember     { facts, sourceApp, sourceId, scope }
POST   /api/brain/investigate  { complaint }
DELETE /api/brain/forget       { entity_id }
GET    /api/brain/entities
GET    /api/brain/timeline
POST   /api/agent/converse     { target_npub, app_name, context }
GET    /api/agent/inbox        { app_name?, limit, offset }
GET    /api/agent/inbox/:id    (single conversation with transcript + audio URL)
POST   /api/agent/approve      { conversation_id, action }
POST   /api/agent/task         { task_description, app_name }
GET    /api/agent/personas
PUT    /api/agent/personas/:app { persona_prompt, looking_for, boundaries }
```

### 7.5 Universal brain hook (unchanged)
Every app MUST include a brain hook. Settings toggle (ON by default). Davy instructs per-app.

### 7.6 AvaBrain standalone app (updated)
Five screens (was four):
1. **Chat** — ask the brain questions, get answers with source citations
2. **Briefing** — daily summary + upcoming calendar + agent highlights
3. **Memory** — browse/search/delete entities and facts
4. **Investigate** — describe a problem, brain checks PostHog logs
5. **Agent Inbox** — centralized conversation hub (see Section 20.6)

---

## 8. Media Pipeline

### 8.1 Routing
```
Photo/audio/small → Blossom-on-R2 (sha256) → AI moderation → edge cache
Video → Bunny Stream (HLS) → frame extraction + classification
1:1 call → WebRTC P2P (NIP-100)
Group ≤5 → CF Calls SFU (CallRoom DO)
Live 1→many → CF Stream Live (RTMPS/WebRTC → HLS)
Agent audio → R2 avatok-agent-audio (TTS output, mp3/ogg)
```
Bytes NEVER through Workers except moderation scan.

### 8.2 Two upload paths
| | Public | Private |
|---|---|---|
| AI moderation | Yes (Gemma 4 vision) | No (ciphertext) |
| Edge cache | Yes | Yes |
| pHash blocklist | Yes (LSH) | No |

---

## 9. Content Moderation

### 9.1 Image (public only)
sha256 → cache check → Gemma 4 vision → pHash LSH → safe/reject.

### 9.2 Text
Public → `llama-guard-3-8b`. DMs NOT scanned (E2E).

### 9.3 Agent conversations
Agent-generated text is moderated by `llama-guard-3-8b` before delivery.
If an agent produces unsafe content, the turn is regenerated with a safety reminder.
Repeated violations pause the agent for that app.

### 9.4 Strike system
24h → 7d → permanent ban. DB_META `account_status`.

---

## 10. Platform Foundation Layer

Five platform apps form the OS layer. Every social app depends on them.

### 10.1 AvaWallet — Money Layer

**AvaCoins = platform credits. NOT real money.**
Avoids RBI PPI regulations and US money transmitter licensing.

```
1 AvaCoin = $0.01 USD (approx ₹0.85)
```

**Free-form top-up (no packages):**
User enters any coin amount. Min 100 ($1), max 50,000 ($500).
Stripe Checkout handles payment.

**Commission rates (per-app):**

| App / Feature | Platform cut | Creator receives |
|---|---|---|
| AvaLive (stream tickets/gifts) | 30% | 70% |
| AvaDate / AvaMatri (consultations) | 25% | 75% |
| AvaChat (1:1 paid sessions) | 20% | 80% |
| Gifts / emojis / reactions (all apps) | 30% | 70% |
| AvaLinked (premium features) | 20% | 80% |
| AvaTube (paid content) | 25% | 75% |
| AvaOLX (digital product sales) | 15% | 85% |

**Architecture:**

**WalletDO** — one per user (npub). Atomic balance ops on SQLite. WebSocket for
real-time. Writes to D1 async via Q_WALLET.

**StreamSessionDO** — one per stream/session. Aggregates gifts, settles to creator
WalletDO every 5s. Solves 10K-viewer contention.

**D1 schema (DB_WALLET):** wallet_balances, wallet_transactions, topup_records,
earning_holds. Full schema in PLATFORM-APPS-PROPOSAL.md.

**Flows:**
- Top-up: user enters amount → Stripe Checkout → webhook → WalletDO credits → WebSocket
- Spend: POST /api/wallet/spend → WalletDO debits → creator credited (minus commission) → 7-day hold
- Hold release: cron every 6h → move matured holds to withdrawable → push

**API:** POST topup, POST spend, GET balance, GET transactions, GET earnings, WS live.

---

### 10.2 AvaCalendar — Scheduling Layer

Central scheduling. Both host and attendee see same booking.

Creator sets slots → user browses → books (wallet debit if paid) → events for
both → push → Q_BRAIN learns. Cron reminders at 30m and 1h.

**D1 schema (DB_META):** calendar_slots, calendar_events.
Full schema in PLATFORM-APPS-PROPOSAL.md.

**API:** CRUD slots, POST book, POST cancel, GET events.

---

### 10.3 AvaPayout — Creator Withdrawals

Wise API for direct bank transfer. Minimum 1,000 coins ($10). 7-day hold.

**Wise flow:** creator links bank (IFSC + account) → Wise recipient created →
withdrawal: validate → quote → transfer → fund → push on completion.

**D1 schema (DB_WALLET):** payout_accounts, payout_requests, commission_rates.

**API:** POST setup, GET accounts, POST request, GET status, POST webhooks/wise.

---

### 10.4 AvaID — Identity Verification

Three steps: phone (Clerk), email (Clerk), selfie video (AWS Rekognition).
Confidence ≥ 90% → auto-approve. < 90% → reject (max 3 retries/24h).
No human review queue at launch.

**Video retention:** PERMANENT in locked R2 until account deletion (law enforcement).

**Tier check:** `requireVerified()` middleware, KV-cached 1h.

**D1 schema (DB_META):** verification_status, verification_attempts.

---

### 10.5 Delete Cascade

**30-day grace period** then full deletion. 14 stores processed by Q_DELETE:
DB_BRAIN → DB_WALLET → DB_RELAY → DB_MEDIA → R2 blobs → R2 verification →
R2 agent-audio → DB_MODERATION → DB_META → Vectorize → KV → DOs → Clerk →
PostHog → Stripe.

Order matters: collect keys BEFORE deleting rows that reference them.

---

### 10.6 AvaOLX — Marketplace

Two types of listings:

**Physical goods (free classifieds):**
- Cars, property, furniture, electronics — anything physical
- Listing is FREE. No financial transaction through AvaTalk.
- User fills simple form → system auto-generates a beautiful 2-page listing UI
- Page 1: hero image, title, price, description, key details
- Page 2: more photos, seller info, contact button (routes to AvaChat)
- Seller and buyer communicate via AvaChat. Deal happens offline.

**Digital products (wallet-powered):**
- Designs, templates, ebooks, courses, digital art, code — anything downloadable
- Priced in AvaCoins. Buyer pays → coins transfer → download unlocked
- Products stored in R2, delivered via signed URL after purchase
- Platform commission: 15% (lowest rate — encouraging digital commerce)
- "Downloads" section in the AvaOLX app shows purchased digital products

**Listing auto-generation:**
User provides: title, category, price, 1-5 photos, description (plain text).
System generates a clean, presentable 2-page listing using templates. No design
skill needed. Think Carousell meets Notion — simple input, beautiful output.

**Agent negotiation (digital products only):**
For digital products, buyer's agent can negotiate price with seller's agent
within the guardrails set by both parties. See Section 20 (Agentic Layer).

**Tier gating:** Browse = Tier 1. List/sell = Tier 2 (verified identity).

**D1 schema (DB_MEDIA — extending existing media database):**

```sql
CREATE TABLE olx_listings (
  id              TEXT PRIMARY KEY,
  seller_npub     TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL,
  listing_type    TEXT NOT NULL,       -- 'physical' | 'digital'
  price_coins     INTEGER,            -- null for physical (display only), set for digital
  price_display   TEXT,               -- "₹85,000" for physical, "500 coins" for digital
  currency        TEXT DEFAULT 'INR',
  condition       TEXT,               -- 'new' | 'like_new' | 'used' | 'na'
  location        TEXT,               -- city/area for physical
  images          TEXT NOT NULL,       -- JSON array of R2 keys
  status          TEXT DEFAULT 'active',
  view_count      INTEGER DEFAULT 0,
  trace_id        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_olx_seller ON olx_listings(seller_npub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_olx_category ON olx_listings(category, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_olx_type ON olx_listings(listing_type, status);

CREATE TABLE olx_digital_products (
  id              TEXT PRIMARY KEY,
  listing_id      TEXT NOT NULL REFERENCES olx_listings(id),
  r2_key          TEXT NOT NULL,       -- file in R2
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  download_count  INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE olx_purchases (
  id              TEXT PRIMARY KEY,
  listing_id      TEXT NOT NULL,
  buyer_npub      TEXT NOT NULL,
  seller_npub     TEXT NOT NULL,
  amount_coins    INTEGER NOT NULL,
  commission      INTEGER NOT NULL,
  wallet_tx_id    TEXT NOT NULL,
  downloaded      INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_olx_purchases_buyer ON olx_purchases(buyer_npub, created_at DESC);
```

**API routes:**
```
POST   /api/olx/listings          { listing data }
GET    /api/olx/listings          { category, type, search, limit, offset }
GET    /api/olx/listings/:id
PUT    /api/olx/listings/:id
DELETE /api/olx/listings/:id
POST   /api/olx/buy               { listing_id }     → wallet debit + unlock download
GET    /api/olx/downloads                             → my purchased digital products
GET    /api/olx/downloads/:id/file                    → signed R2 URL (time-limited)
```

---

## 20. Agentic Layer

This is the defining feature of AvaTalk v2. The brain (Section 7) gains hands.

### 20.1 Concept

Every user's AvaBrain can operate as an **AI agent** — a representative that
talks to other users' agents, executes tasks, and reports back. The agent is
NOT a separate entity. It IS the brain, scoped to a specific app context.

```
AvaBrain v1:  KNOWS things (memory, facts, entities)
AvaBrain v2:  KNOWS things + DOES things (agent conversations, tasks, actions)
```

The agent uses Gemma 4's tool-calling capability. It receives:
1. A persona (per-app system prompt created by the user)
2. Scoped knowledge (only what's in the persona, NOT the full brain)
3. Tools (send message, check calendar, browse listings, negotiate price)
4. Guardrails (what it can and cannot do, set by the user per app)

### 20.2 Agent Setup (onboarding)

During initial app onboarding (or later in settings):

1. **Choose a voice** — user picks from 40 Deepgram Aura-2 voices (luna, atlas,
   orion, athena, etc.). This voice represents them in all agent audio playback.
   Stored in profile: `agent_voice_id`.

2. **Set global bio** — basic info fed to all app personas as context. Name,
   profession, city, interests. Pulled from AvaBrain entities automatically,
   user can edit.

3. **Per-app personas** are set within each app's settings (see 20.3).

### 20.3 Per-App Persona System

**Critical design principle:** the agent does NOT have free access to the full
brain. Each app gets its own isolated persona. The agent only knows and shares
what the user explicitly puts in that app's persona settings.

```
Example — AvaDate persona:
  Persona prompt: "I'm Davy, 32, based in Dehradun. I love hiking, cooking,
                   and good conversation. I'm looking for someone genuine."
  Looking for:    "Women 25-35, non-smoker, likes outdoors, open to adventure"
  Boundaries:     "Don't share my work details. Don't discuss salary.
                   Don't agree to meet without my approval."
  Auto-approve:   false (all connections need my confirmation)

Example — AvaLinked persona:
  Persona prompt: "I'm a tech entrepreneur building social apps on Nostr.
                   Interested in decentralized identity and AI agents."
  Looking for:    "CTOs, investors, Nostr developers, AI engineers"
  Boundaries:     "Don't share personal details. Don't commit to meetings.
                   Keep it professional."
  Auto-approve:   true (agent can schedule intro calls without asking)
```

The dating agent has NO IDEA about the user's LinkedIn persona. The LinkedIn
agent has NO IDEA about the user's dating preferences. They are isolated.

**D1 schema (DB_META):**

```sql
CREATE TABLE agent_personas (
  id              TEXT PRIMARY KEY,
  npub            TEXT NOT NULL,
  app_name        TEXT NOT NULL,        -- 'avadate' | 'avalinked' | 'avaolx' | ...
  persona_prompt  TEXT NOT NULL,        -- free-text system prompt
  looking_for     TEXT,                 -- what to match/seek
  boundaries      TEXT,                 -- what NOT to share/do
  auto_approve    INTEGER DEFAULT 0,    -- 0 = manual, 1 = agent acts freely
  active          INTEGER DEFAULT 1,    -- toggle agent on/off per app
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(npub, app_name)
);
CREATE INDEX IF NOT EXISTS idx_persona_user ON agent_personas(npub, app_name);
```

### 20.4 Agent-to-Agent Protocol

**Matching (before conversation starts):**

When Agent A wants to talk to Agent B, the system first checks compatibility:
1. Both users must have active personas for that app
2. Agent A's `looking_for` is compared against Agent B's `persona_prompt`
3. Gemma 4 runs a quick compatibility check (one inference):
   "Given persona A looking for X, and persona B describing Y, is there a
    reasonable match? Return yes/no with one-sentence reason."
4. If no match → no conversation. Silent. Neither user notified.
5. If match → ConversationDO created.

**This prevents noise.** An IT professional on AvaLinked won't waste time talking
to a construction worker's agent if neither is looking for the other.

**Conversation flow:**

```
1. Match found → ConversationDO created (keyed by conversation_id)
2. ConversationDO stores:
   - agent_a: { npub, persona_prompt, boundaries, voice_id }
   - agent_b: { npub, persona_prompt, boundaries, voice_id }
   - context: { app_name, match_reason }
   - messages: []
   - status: 'active'

3. Turn-by-turn generation:
   a. Agent A generates opening message (Gemma 4 + persona A system prompt)
   b. llama-guard checks message → safe? continue. unsafe? regenerate.
   c. Message stored in ConversationDO
   d. Agent B generates response (Gemma 4 + persona B system prompt)
   e. Safety check → store
   f. Repeat for N turns (configurable, default 10-15 turns)
   g. Gemma 4 evaluates: "Has this conversation reached a natural conclusion
      or should it continue?" → stop or continue

4. Conversation concludes:
   a. Gemma 4 generates summary for each user:
      "Your agent talked to Priya's agent about hiking in Uttarakhand
       and Tibetan cooking. Her agent mentioned she's a vegetarian who
       loves trail running. Compatibility: high."
   b. Full text transcript saved
   c. TTS synthesis: each message voiced by the speaker's chosen voice
      → stitched into a single audio file → stored in R2 avatok-agent-audio
   d. Both users notified via push: "Your agent had a conversation on AvaDate"
   e. Conversation appears in Agent Inbox
```

### 20.5 TTS Voice Stitching

After a text conversation concludes, the system synthesizes audio:

```
For each message in conversation:
  1. Determine speaker (agent_a or agent_b)
  2. Get speaker's voice_id from persona
  3. Call @cf/deepgram/aura-2-en with { text: message, speaker: voice_id }
  4. Receive audio chunk (mp3/ogg)
  5. Add 0.5s silence between turns

Stitch all chunks into one audio file
Store in R2 avatok-agent-audio/{conversation_id}.ogg
Link in conversation record
```

The user opens their Agent Inbox, sees the conversation, and can:
- **Read** the text transcript
- **Listen** to the synthesized voice conversation
- **Act** on the outcome (connect, schedule meeting, approve deal, dismiss)

### 20.6 Agent Inbox

The Agent Inbox is a new screen in AvaBrain. It is the centralized hub for
all agent activity across all apps.

**Layout (WhatsApp-style):**

```
┌─────────────────────────────┬──────────────────────────────────────┐
│  CONNECTIONS (left panel)   │  CONVERSATION (right panel)          │
│                             │                                      │
│  🔴 AvaDate                │  AvaDate — Your agent × Priya's agent│
│  ├─ Priya's agent           │                                      │
│  └─ Meera's agent           │  [Text transcript]                   │
│                             │  Agent A: "Hi! I noticed we both..." │
│  🔵 AvaLinked              │  Agent B: "Yes! I love hiking too..." │
│  ├─ Raj's agent             │  Agent A: "Have you tried the..."    │
│  └─ TechCorp's agent        │  ...                                 │
│                             │                                      │
│  🟢 AvaOLX                 │  [▶ Listen to voice conversation]    │
│  └─ Buyer agent (MacBook)   │                                      │
│                             │  [Summary]                           │
│  🟡 AvaCalendar            │  "Both enjoy hiking and cooking.      │
│  └─ Jeff scheduling         │   Priya is vegetarian. High match."  │
│                             │                                      │
│                             │  [✓ Connect] [✗ Dismiss] [💬 Reply] │
└─────────────────────────────┴──────────────────────────────────────┘
```

**Color coding by app:**

| App | Color | Icon |
|---|---|---|
| AvaDate | 🔴 Red/Pink | Heart |
| AvaMatri | 🟣 Purple | Ring |
| AvaLinked | 🔵 Blue | Briefcase |
| AvaOLX | 🟢 Green | Tag |
| AvaCalendar | 🟡 Yellow | Calendar |
| AvaChat | ⚪ Gray | Chat bubble |

**D1 schema (DB_META):**

```sql
CREATE TABLE agent_conversations (
  id                TEXT PRIMARY KEY,
  app_name          TEXT NOT NULL,
  agent_a_npub      TEXT NOT NULL,
  agent_b_npub      TEXT NOT NULL,
  status            TEXT DEFAULT 'active',  -- active|completed|dismissed|connected
  match_reason      TEXT,
  summary_for_a     TEXT,
  summary_for_b     TEXT,
  transcript        TEXT,                   -- JSON array of { speaker, text, timestamp }
  audio_r2_key      TEXT,                   -- R2 key for stitched audio
  turn_count        INTEGER DEFAULT 0,
  outcome           TEXT,                   -- 'connected'|'dismissed_a'|'dismissed_b'|'expired'
  outcome_action    TEXT,                   -- what happened after (meeting scheduled, etc.)
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  expires_at        INTEGER                 -- auto-dismiss if not acted on
);
CREATE INDEX IF NOT EXISTS idx_conv_a ON agent_conversations(agent_a_npub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_b ON agent_conversations(agent_b_npub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_app ON agent_conversations(app_name, status);

-- Inbox items (denormalized for fast inbox queries)
CREATE TABLE agent_inbox (
  id                TEXT PRIMARY KEY,
  npub              TEXT NOT NULL,          -- inbox owner
  conversation_id   TEXT NOT NULL,
  app_name          TEXT NOT NULL,
  other_npub        TEXT NOT NULL,          -- the other party
  other_display_name TEXT,
  summary           TEXT,
  status            TEXT DEFAULT 'unread',  -- unread|read|acted
  action_taken      TEXT,                   -- connect|dismiss|reply|schedule
  has_audio         INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_user ON agent_inbox(npub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_unread ON agent_inbox(npub, status)
  WHERE status = 'unread';
```

### 20.7 Use Cases by App

**AvaDate / AvaMatri — matchmaker + icebreaker:**
Agent reviews profiles surfaced by matching algorithm. Filters using persona
preferences. Compatible agents have a conversation (10-15 turns about shared
interests). Users get summary + audio. Both approve → connected for real chat.

**AvaLinked — professional networking:**
Agent identifies interesting profiles in topic feeds or conferences. Initiates
conversation: "I represent Davy, a tech entrepreneur. He noticed your work on
decentralized identity." Other agent responds professionally. If both see value,
schedules an intro call via AvaCalendar.

**AvaOLX — digital product negotiation:**
Buyer's agent sees a listing, knows buyer's budget (from OLX persona guardrails).
Opens negotiation with seller's agent (seller has min price in guardrails).
Agents discuss features, price, terms. Agreement → both users confirm →
AvaWallet processes payment → download unlocked.

**AvaCalendar — scheduling coordination:**
"Find a time for coffee with Priya." User's agent talks to Priya's agent.
They compare availability (from calendar), agree on a time, create a booking
for both. Push: "Agent scheduled coffee with Priya, Thursday 3pm."

**AvaChat — smart presence (when user is away):**
Agent handles messages when user is offline. Responds based on context using
the AvaChat persona (NOT the full brain). Marks responses as "agent-handled"
so user can review. Can triage urgent vs non-urgent.

**AvaLive — stream co-host:**
During live streams, agent answers repetitive viewer questions in chat.
"What mic does he use?" → agent checks brain → answers. Creator focuses on
content. Agent-answered messages tagged with a bot icon.

**AvaTube / AvaGram — content assistant:**
"Post my latest photo with a caption." Agent writes caption in user's voice
(from persona), picks hashtags based on what worked before. Posts draft →
user reviews in Agent Inbox → approve/edit/discard.

### 20.8 AgentDO and ConversationDO

**AgentDO** — one per user (keyed by npub). Manages agent state across all apps.

```
AgentDO SQLite:
  voice_id          TEXT     — chosen Aura-2 voice
  global_bio        TEXT     — base context for all personas
  active_tasks      INTEGER  — count of in-progress tasks
  last_active_at    INTEGER
```

The AgentDO coordinates:
- Initiating new conversations (checks if personas exist + active)
- Managing the task queue (pending/active/completed)
- Rate limiting (max 5 agent conversations per app per day to prevent spam)
- Invoking Gemma 4 for turn generation

**ConversationDO** — one per agent-to-agent conversation (keyed by conversation_id).

```
ConversationDO SQLite:
  agent_a           JSON     — { npub, persona, boundaries, voice_id }
  agent_b           JSON     — { npub, persona, boundaries, voice_id }
  app_name          TEXT
  messages          JSON[]   — turn-by-turn transcript
  status            TEXT     — active|generating|completed|paused
  turn_count        INTEGER
  max_turns         INTEGER  — default 15
```

The ConversationDO:
- Generates turns sequentially (Agent A → safety check → Agent B → safety check)
- Checks natural conclusion after each turn
- On completion: generates summaries, triggers TTS synthesis, notifies both users
- Self-destructs after 30 days if neither user acts

### 20.9 Guardrails & Safety

1. **Persona isolation:** Agent for App X has ZERO access to persona/data from App Y.
2. **Boundary enforcement:** User's `boundaries` text is injected into every agent prompt as hard constraints.
3. **Content moderation:** Every agent-generated message runs through `llama-guard-3-8b`. Unsafe → regenerate.
4. **Rate limiting:** Max 5 new agent conversations per app per day. Prevents spam.
5. **No financial commitment without approval:** Agent can negotiate but CANNOT spend AvaCoins or approve payments without user confirmation (regardless of auto_approve setting). Auto-approve only applies to social connections and scheduling.
6. **Human takeover:** User can jump into any active conversation and take over from the agent at any point.
7. **Transparency:** User can see the FULL persona prompt their agent uses. No hidden instructions.
8. **Kill switch:** Global agent toggle in AvaBrain settings (OFF = all agents stop immediately across all apps).
9. **Expiry:** Conversations not acted on within 7 days auto-dismiss.
10. **No DM access:** Agent NEVER reads E2E encrypted DMs. It only knows what's in the persona.

---

## 21. Observability (three-system split)

| Destination | What | Cost |
|---|---|---|
| **PostHog** | User events, platform events, agent events, errors | Free to 1M/month |
| **Analytics Engine** | Ops metrics (latency, throughput, queue health) | $0.25/million |
| **Workers Logs** | Raw requests, stack traces, debugging | Free, 7-day retention |

### 21.1 Trace IDs
Every request gets `X-Trace-Id`. Flows through entire pipeline.

### 21.2 PostHog events (~55 types)

**Auth (4):** login_success, login_failed, session_expired, logout
**Messaging (4):** message_sent, message_delivered, message_failed, message_read
**Calls/Streaming (4):** call_started, call_ended, stream_started, stream_ended
**Uploads (2):** upload_completed, upload_failed
**AI/Brain (5):** brain_query, brain_response, brain_memory_created, brain_briefing_opened, brain_investigate
**Push (2):** push_sent, push_failed
**Journey (7):** signup_completed, phone_verified, profile_completed, first_message_sent, first_reply_received, first_stream_started, first_match_received

**Wallet (4):** wallet_topup, wallet_spend, wallet_earn, wallet_insufficient
**Calendar (3):** booking_created, booking_cancelled, booking_reminder_sent
**Payout (3):** payout_requested, payout_completed, payout_failed
**Identity (2):** id_verified, id_rejected
**Lifecycle (2):** account_deletion_requested, account_deleted

**Agent (8):** agent_conversation_started, agent_conversation_completed, agent_match_found, agent_match_rejected, agent_action_approved, agent_action_dismissed, agent_human_takeover, agent_task_completed
**OLX (5):** olx_listing_created, olx_listing_viewed, olx_digital_purchased, olx_negotiation_started, olx_negotiation_completed

**Errors (1):** system_error (severity, service, stack_trace, trace_id)

All batched via Q_ANALYTICS. Every event carries: trace_id, user_id, app_name,
app_version, service_name.

### 21.3 Dashboards (13)

| # | Dashboard | Key metrics |
|---|---|---|
| 1 | System Health | Error rates by severity/service |
| 2 | Auth Health | Login success/fail, failure reasons |
| 3 | User Journey Funnel | Signup → verify → profile → first message → first reply |
| 4 | Messaging Health | Send/deliver/fail rates, latency |
| 5 | AI / Brain Health | Query latency, memory hit rate, briefing opens |
| 6 | Mobile Stability | Errors by app version/device |
| 7 | Cross-App Intelligence | Events by app, multi-app users |
| 8 | Wallet Health | Top-up rate, spend/earn balance, commission revenue |
| 9 | Payout Health | Withdrawal volume, Wise success/fail |
| 10 | Verification Health | Approval rate, rejection reasons, AWS errors |
| 11 | Calendar Health | Booking rate, cancellations, reminder delivery |
| 12 | Agent Health | Conversations/day, match rate, completion rate, TTS latency |
| 13 | OLX Health | Listings created, digital sales, negotiation outcomes |

---

## 22. Privacy Non-Negotiables

1. nsec NEVER leaves device. Optional NIP-49 backup.
2. nsec NEVER in logs, telemetry, error reports.
3. npub safe to log.
4. No Session Replay in PostHog.
5. DM content NEVER sent to analytics, logging, or server-side processing.
6. Brain stores derived facts only.
7. Brain toggle ON by default, user can turn OFF.
8. User can see and delete everything the brain knows.
9. Call audio/video never recorded without consent.
10. Payment data via Stripe Elements only.
11. PII in Clerk only; never replicated.
12. Verification video: permanent in locked R2 until deletion. Never public.
13. PostHog events carry NO message content.
14. Wallet descriptions carry no PII.
15. Deletion cascade removes ALL data from ALL stores after 30-day grace.
16. **Agent personas are user-controlled.** User writes every word the agent shares.
17. **Agent conversations are transparent.** User sees full transcript.
18. **Agent has NO access to DMs, full brain, or other app personas.**
19. **Agent cannot spend money without explicit user approval.**
20. **Agent audio is stored in separate R2 bucket, deleted in cascade.**

---

## 23. Real-Time Pipeline

### 23.1 Calls
| Scenario | Tech |
|---|---|
| 1:1 | WebRTC P2P, NIP-100 |
| Group ≤5 | CF Calls SFU, CallRoom DO |
| Live | CF Stream Live |

### 23.2 Relay
Per-user inbox DOs, hibernation. Public kinds → Q_BRAIN. Kind 1059 NEVER dispatched.

### 23.3 Wallet
WalletDO WebSocket for balance. StreamSessionDO batches every 5s.

### 23.4 Agent
ConversationDO generates turns asynchronously. Push on completion.
TTS synthesis is async (Q_AGENT dispatches after text conversation completes).

---

## 24. Cost Model (at 10M users)

### 24.1 Cost levers
1. **Workers AI** — #1. Mitigated by dedupe, Gemma 4 4B active, model swap path.
2. **D1 rows_read** — #2. Mitigated by indexes, FTS5, replicas.
3. **R2** — cheap with cache rules.
4. **DOs** — hibernation keeps costs near zero for inactive users.
5. **Bunny** — $0.005/GB.
6. **Stripe fees** — 2.9% + $0.30 per top-up. Min 100-coin floor.
7. **Wise fees** — ~$1-2 per India transfer.
8. **AWS Rekognition** — $0.025/call after free tier. One-time per user.
9. **TTS (Deepgram Aura-2)** — per-character pricing via Workers AI. Agent conversations ~500 chars/turn × 15 turns = ~7,500 chars per conversation.
10. **Agent AI inference** — ~15 Gemma 4 calls per conversation (2 per turn + matching + summary). ~4B active per call.

### 24.2 Free tiers
- D1: 25B rows_read/month
- Workers AI: 10K neurons/day
- R2: 10M Class A, 1B Class B, 10 GB
- Workers: 10M requests/month
- PostHog: 1M events/month
- Analytics Engine: 10M data points
- AWS Rekognition: 5K Face Liveness/month (12 months)
- Stripe/Wise: no monthly fees

---

## 25. Nostr Protocol

### 25.1 Event kinds
| Kind | Purpose | App |
|---|---|---|
| 0 | Profile metadata | All |
| 1 | Short text note | AvaTweet, AvaBook |
| 3 | Follow list | All |
| 6 | Repost | AvaTweet |
| 7 | Reaction | All |
| 14 | DM (inner) | AvaChat |
| 1059 | Gift wrap (DM outer) | AvaChat |
| 10002 | Relay list | All |
| 10050 | Inbox relay list | AvaChat |
| 10063 | Blossom server list | All |
| 20 | Picture event | AvaGram |
| 25050 | WebRTC signaling | AvaTok, AvaChat |
| 30023 | Long-form article | AvaLinked |
| 30311 | Live activity | AvaLive |
| 1311 | Live chat message | AvaLive |
| 34235 | Video event | AvaTube |
| 34236 | Short video event | AvaGram |

### 25.2 NIPs
NIP-01, 02, 05, 10, 17, 19, 25, 42, 44, 49, 53, 59, 65, 68, 71, 100.
No NIP-04.

---

## 26. Build Status

### 26.1 Done
- [x] Backend rebuild (4 Workers, 5 D1, all infra)
- [x] Dual auth (NIP-98 + Clerk JWT)
- [x] Relay inbox DOs with hibernation
- [x] Media pipeline (R2 + Blossom + moderation + pHash)
- [x] Queue consumers (moderation, push, email, analytics, brain)
- [x] Scale audit (12 fixes)
- [x] AvaBrain v1 (knowledge graph, brain consumer, UserBrain DO)
- [x] Observability (PostHog 29 events, Analytics Engine, traces)

### 26.2 Pending (Davy's side)
- [ ] Provide 3 secrets (BREVO, TURN_KEY, BUNNY)
- [ ] Run secrets/deploy.sh
- [ ] Flutter APK + smoke test
- [ ] Ship APK with Workers deploy
- [ ] Delete avaglobal + avablobal in RealtimeKit
- [ ] Rotate CF API token

### 26.3 Next: platform foundation (in order)
- [ ] AvaID — verification, tier middleware, delete cascade
- [ ] AvaWallet — WalletDO, StreamSessionDO, Stripe, spend/earn
- [ ] AvaCalendar — slots, bookings, cron reminders
- [ ] AvaPayout — Wise integration, withdrawal
- [ ] AvaOLX — listings, digital products, purchase flow
- [ ] Wire PostHog events + brain hooks across platform apps

### 26.4 Next: agentic layer (after platform)
- [ ] AgentDO + ConversationDO infrastructure
- [ ] Per-app persona system (DB schema, API, settings UI)
- [ ] Agent-to-agent matching + conversation engine
- [ ] TTS synthesis pipeline (Deepgram Aura-2 stitching)
- [ ] Agent Inbox (AvaBrain 5th screen)
- [ ] Agent hooks per app (dating, LinkedIn, OLX, calendar, chat)
- [ ] Agent moderation (llama-guard on generated text)
- [ ] Wire agent PostHog events

### 26.5 Next: social apps
- [ ] AvaBrain standalone Flutter app (5 screens now)
- [ ] AvaChat brain + agent hooks
- [ ] AvaTok, AvaTweet, AvaBook, AvaGram, AvaLinked, AvaTube, AvaLive
- [ ] AvaDate, AvaMatri (agent-powered matching)
- [ ] AvaOLX Flutter app
- [ ] Marketing website (React on CF Pages)

---

## 27. Rules for AI Builders

1. **Flutter is the app.** React = marketing site only.
2. **Cloudflare is the backend.** Exception: AWS Rekognition for AvaID.
3. **Gemma 4 is the default model.** llama-guard for moderation. bge-small for embeddings. Deepgram Aura-2 for TTS. Deepgram Nova-3 for STT.
4. **E2E is sacred.** Server never sees DM plaintext. Brain/agent DM access = client-side only.
5. **Dual auth on every mutation.** NIP-98 + Clerk JWT.
6. **Bytes never through Workers** except moderation.
7. **No full-table scans.** Every hot query indexed.
8. **D1 param limit 100.** Chunk ≤90.
9. **Brain toggle ON by default.**
10. **Three observability systems.** PostHog = user. AE = ops. Logs = debug. Never mix.
11. **Every PostHog event carries:** trace_id, user_id, app_name, app_version, service_name.
12. **Never log:** nsec, JWTs, phones, emails, DM content, payments, verification docs.
13. **Brain hook in every app.** Davy instructs per-app.
14. **Tier 2 routes require `requireVerified()`.** No bypass.
15. **Wallet ops are atomic.** Always through WalletDO.
16. **AvaCoins are credits, not money.** Language matters in UI.
17. **7-day hold on earnings.** No bypass.
18. **Free-form top-up.** Min 100, max 50,000. No packages.
19. **Delete cascade is non-negotiable.** All 14+ stores wiped after 30 days.
20. **Use third-party services for specialized problems.** Don't reinvent face liveness or payments.
21. **Agent personas are per-app isolated.** Agent for App X cannot read App Y persona.
22. **Agent cannot spend coins without human approval.** Even with auto_approve on.
23. **Every agent message is safety-checked.** llama-guard before delivery.
24. **Agent conversations are text-first, audio-second.** TTS synthesis happens post-conversation.
25. **Max 5 agent conversations per app per day.** Rate limit to prevent spam.
26. **Agent Inbox is the single source for all agent activity.** Apps don't maintain their own agent UIs.

---

## 28. Secrets Inventory

| Secret | Where | Purpose |
|---|---|---|
| CLERK_JWKS_ENDPOINT | All Workers | JWT verification |
| CLERK_ISSUER | All Workers | JWT issuer |
| CLERK_SECRET_KEY | avatok-consumers | Account deletion |
| CLOUDFLARE_CALLS_APP_ID | avatok-api | Calls SFU |
| CLOUDFLARE_CALLS_APP_SECRET | avatok-api | Calls SFU |
| TURN_KEY_API_TOKEN | avatok-api | TURN credentials |
| BUNNY_API_KEY | avatok-api | Bunny Stream |
| BREVO_API_KEY | avatok-consumers | Email |
| POSTHOG_API_KEY | avatok-consumers | Event ingestion (phc_) |
| POSTHOG_PERSONAL_API_KEY | avatok-api | Event reading (phx_) |
| STRIPE_SECRET_KEY | avatok-api | Coin top-up |
| STRIPE_WEBHOOK_SECRET | avatok-api | Stripe webhook |
| WISE_API_KEY | avatok-api/consumers | Payouts |
| WISE_PROFILE_ID | avatok-api/consumers | Wise profile |
| AWS_ACCESS_KEY_ID | avatok-api | Rekognition |
| AWS_SECRET_ACCESS_KEY | avatok-api | Rekognition |
| AWS_REGION | avatok-api | Rekognition region |
| APNS_KEY_ID | avatok-consumers | iOS push (gated) |
| APNS_TEAM_ID | avatok-consumers | iOS push (gated) |

---

## 29. Conflict Analysis (for AI builders)

Before building any new feature, check these known interaction points:

### 29.1 Agent ↔ Brain
- Agent reads brain entities but ONLY through the per-app persona scope
- Agent conversations produce NEW brain facts (scope: `agent:{app_name}`)
- If brain toggle is OFF for an app, agent for that app is also disabled
- UserBrain DO and AgentDO are separate DOs but share the same npub key

### 29.2 Agent ↔ Wallet
- Agent can VIEW balance (to inform negotiation) but CANNOT debit
- Any purchase triggered by agent negotiation requires human approval
- The approval flow: agent proposes → inbox item → user confirms → wallet debits
- StreamSessionDO (live gifting) is independent of agent — agents don't send gifts

### 29.3 Agent ↔ Calendar
- Agent CAN create calendar events IF the persona has auto_approve = true
- Agent-created events are tagged as `source: 'agent'` in metadata
- Calendar conflicts are checked before agent commits a time slot
- User can cancel any agent-created event with full refund

### 29.4 Agent ↔ E2E encryption
- Agent has ZERO access to kind 1059 (DM) content
- Agent conversations are NOT E2E encrypted (they're server-generated)
- Agent transcripts are stored in plain text in D1 (not user-generated content)
- If a user takes over an agent conversation and switches to direct DM, the
  conversation moves to AvaChat and becomes E2E encrypted from that point

### 29.5 Agent ↔ Moderation
- Every agent-generated message passes through llama-guard before storage
- Repeated safety violations pause the agent for that app (not the user)
- User's persona prompt is also moderated on save (reject harmful instructions)
- Agent rate limits (5/day/app) are separate from user rate limits

### 29.6 Agent ↔ Delete cascade
- Account deletion deletes: all personas, all conversations, all inbox items,
  all agent audio in R2, AgentDO storage, ConversationDO storage
- Add to Q_DELETE consumer: R2 avatok-agent-audio cleanup, agent_personas,
  agent_conversations, agent_inbox tables

### 29.7 Agent ↔ PostHog
- Agent events are distinct from user events (different event names)
- Agent conversations carry their own trace_ids
- Agent cost (Gemma 4 inference count) tracked separately in Analytics Engine

### 29.8 AvaOLX ↔ Wallet
- Physical listings: no wallet interaction
- Digital listings: wallet_spend on purchase, wallet_earn on sale (minus 15%)
- Download unlocked only after wallet transaction confirmed
- Refund policy: 24h window for digital products if not downloaded

### 29.9 New infrastructure (no conflicts with existing)
- DB_WALLET is a new D1 (isolated from DB_META)
- Q_AGENT is a new queue (isolated from Q_BRAIN)
- R2 avatok-agent-audio is a new bucket (isolated from avatok-blobs)
- AgentDO and ConversationDO are new DO classes (migration tag v4)
- No existing Workers need code changes for agent — all new routes

### 29.10 DO migration tags

| Tag | Classes | When |
|---|---|---|
| v1 | CallRoom | Original deploy |
| v2 | UserBrain | AvaBrain build |
| v3 | WalletDO, StreamSessionDO | Platform apps build |
| v4 | AgentDO, ConversationDO | Agentic layer build |

---

## 30. Glossary

- **npub** — Nostr public key. Universal identity.
- **nsec** — Nostr secret key. Device only.
- **NIP** — Nostr Implementation Possibility.
- **Blossom** — Hash-addressed media on R2.
- **DO** — Durable Object.
- **D1** — Cloudflare serverless SQLite.
- **Workers AI** — Cloudflare edge AI inference.
- **Gemma 4** — Google MoE model (26B/4B active). Primary AI.
- **Deepgram Aura-2** — TTS model with 40 voices. Agent voice synthesis.
- **Deepgram Nova-3** — STT model. Voice input transcription.
- **AvaCoins** — Platform credits. 1 coin = $0.01. NOT money.
- **WalletDO** — Per-user atomic wallet balance.
- **StreamSessionDO** — Per-stream gift aggregator.
- **AgentDO** — Per-user agent state manager.
- **ConversationDO** — Per-conversation turn generator.
- **Q_BRAIN** — Brain fact extraction queue.
- **Q_WALLET** — Wallet audit trail queue.
- **Q_DELETE** — Account deletion queue.
- **Q_AGENT** — Agent task dispatch queue.
- **UserBrain** — Per-user reasoning DO.
- **AvaBrain** — Standalone AI app (memory + agent inbox).
- **Agent Persona** — Per-app personality + boundaries + looking_for.
- **Agent Inbox** — Centralized hub for all agent conversations.
- **AWS Rekognition** — Face liveness. The one external AI service.
- **Wise** — Cross-border payouts to creator bank accounts.
- **Tier 1** — Basic (Clerk signup). Chat, calls, brain, wallet, calendar.
- **Tier 2** — Verified (AvaID). All social + posting + dating + streaming.
