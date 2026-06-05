# AvaTalk Network — Master Specification v5.1

**Version:** 5.1 (June 2026)
**Status:** Living document. Single source of truth.
**Domains:** avatok.ai (product, all infrastructure), abertalk.ai (brand name, future marketing site only)
**Audit applied:** Builder audit 2026-06-05 — all 8 recommendations incorporated.

> **IF YOU ARE AN AI BUILDER:** this document is the single source of truth.
> If an older spec, README, or prompt contradicts something here, this document wins.
> Read end to end before writing any code.
>
> **§3 separates DEPLOYED from PLANNED.** Do NOT bind to resources listed under
> §3.B unless you are the builder creating them. §26 is the authoritative build status.

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
1. One login, many apps.
2. Cross-post in one tap.
3. Every account is a verified human.
4. Your AI brain remembers everything.
5. Earn and spend seamlessly — AvaCoins power the ecosystem.
6. Your AI agent works while you don't.

**Primary launch market:** India. Android-first. Hindi + English.

**Domain clarification:**
- `avatok.ai` — ALL infrastructure hostnames: blossom.avatok.ai, relay, API, cache rules.
  This is the deployed Cloudflare zone. Never change.
- `abertalk.ai` — parent brand name only. Used for the future React marketing website
  (Cloudflare Pages). NO backend infrastructure on this domain. Never reference
  abertalk.ai in wrangler configs, Worker routes, or R2 custom domains.

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

> **Note:** The current Flutter app is "AvaTok" doing combined messaging + calls.
> Under this spec, messaging becomes **AvaChat** and AvaTok shrinks to 1:1 video.
> This is a client-side rename/nav refactor, not a backend change.

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

**Flutter is the app framework. All apps. All platforms.**
React is ONLY for the marketing website (abertalk.ai on Cloudflare Pages).

---

## 3. Architecture

### 3.A — DEPLOYED (verified 2026-06-05)

These resources exist, are bound, and pass `wrangler deploy --dry-run`.

**Four Workers:**

| Worker | Role | Status |
|---|---|---|
| `avatok-api` | Control plane — `/api/*` routes, dual auth, media upload, ICE credentials, Stream webhook, CallRoom DO, UserBrain DO | **LIVE** |
| `avatok-relay` | Nostr relay — per-user inbox DOs (hibernating), events → D1, Q_BRAIN dispatch | **LIVE** |
| `avatok-consumers` | Queue consumers (moderation, push, email, analytics, brain) + 6h cron | **LIVE** |
| `avatok-calls` | RealtimeKit/Stream token mint | **LIVE** |

**Five D1 Databases (all APAC):**

| Binding | Actual database name | Purpose |
|---|---|---|
| DB_META | avatok-meta | Identity, profiles, follows, blocks, mutes, settings, push tokens, strikes |
| DB_RELAY | avatok-relay | nostr_events + nostr_tags |
| DB_MEDIA | **avatok-media-meta** | user_media, user_media_hashes (pHash) |
| DB_MODERATION | avatok-moderation | blocked_media_hashes, moderation_results, user_reports, csam_hashes |
| DB_BRAIN | avatok-brain | brain_entities, brain_relationships, brain_facts, brain_daily_summaries, brain_events |

**Other deployed infra:**

| Resource | Actual name | Purpose |
|---|---|---|
| R2 | `avatok-blobs` | Public media (Blossom), blossom.avatok.ai, 30-day edge cache |
| R2 | `avatok-verification` | Locked — verification docs |
| KV | `avatok-tokens` | Ephemeral tokens |
| Queue | `moderation` | Image/text moderation |
| Queue | `push-notifications` | FCM/APNs |
| Queue | `email` | Brevo email |
| Queue | `analytics` | PostHog batched ingestion |
| Queue | `brain-events` | AvaBrain fact extraction |
| Vectorize | `avatok-semantic` | 384-dim cosine (bge-small-en-v1.5), npub-scoped |
| Analytics Engine | *(default)* | Ops metrics |
| CF Stream | 71 live inputs | AvaLive |
| Zone | `avatok.ai` | DNS, cache rules, custom domains |

**Deployed DO migration tags:**

| Tag | Classes |
|---|---|
| v1 | CallRoom |
| v2 | UserBrain |

**Deployed moderation pipeline (current > spec v5 — preserved here):**
1. CSAM hash-match gate (`consumers/src/csam.ts`) — runs FIRST, fail-closed. Bypassed until PhotoDNA/NCMEC creds provided. `csam_hashes` table migrated.
2. Cheap external NSFW classifier first-pass — only escalates ambiguous band to Gemma 4.
3. Gemma 4 vision — final classification for ambiguous images.
4. pHash LSH blocklist check.
5. llama-guard text moderation on public text.

### 3.B — PLANNED (not yet created — build per §26 order)

These resources DO NOT EXIST yet. Builders create them when building each layer.

**New D1 database (create during AvaWallet build):**

| Binding | Database to create | Purpose |
|---|---|---|
| DB_WALLET | avatok-wallet (APAC) | wallet_balances, wallet_transactions, topup_records, earning_holds, payout_accounts, payout_requests, commission_rates |

**New tables in existing D1s (create during platform/agent builds):**

| Database | New tables | When |
|---|---|---|
| DB_META | calendar_slots, calendar_events, verification_status, verification_attempts, deletion_requests, agent_personas, agent_conversations, agent_inbox | Platform + Agent builds |
| DB_MEDIA | olx_listings, olx_digital_products, olx_purchases | AvaOLX build |

**New Durable Objects:**

| Binding | Class | Migration tag | When |
|---|---|---|---|
| USER_WALLET | WalletDO | v3 | AvaWallet build |
| STREAM_SESSION | StreamSessionDO | v3 | AvaWallet build |
| USER_AGENT | AgentDO | v4 | Agentic layer build |
| CONVERSATION | ConversationDO | v4 | Agentic layer build |

**New Queues:**

| Queue to create | Purpose | When |
|---|---|---|
| `wallet-transactions` | Wallet audit trail (DO → D1) | AvaWallet build |
| `account-deletions` | Delete cascade | AvaID build |
| `agent-tasks` | Agent task dispatch + TTS synthesis | Agentic layer build |

**New R2 buckets:**

| Bucket | Purpose | When |
|---|---|---|
| `avatok-agent-audio` | TTS-synthesized conversation audio | Agentic layer build |

**Total after all builds:** 6 D1, 6 DOs (4 migration tags), 8 Queues, 3 R2 buckets.

### 3.C — External Services

| Service | Purpose | Status |
|---|---|---|
| **Clerk** | Account auth | **LIVE** |
| **Bunny.net** | Video storage + HLS | **LIVE** |
| **Stripe** | AvaCoins top-up | PLANNED |
| **Wise** | Creator payouts | PLANNED |
| **PostHog** | Analytics, errors | **LIVE** |
| **Brevo** | Transactional email | **LIVE** |
| **FCM / APNs** | Push | **LIVE** |
| **AWS Rekognition** | Face Liveness (AvaID) | PLANNED |

**Vendor count: 8** (Cloudflare, Bunny, Clerk, Stripe, Wise, PostHog, Brevo, AWS).
Cloudflare handles ~80% of infra including ALL AI inference (LLM, TTS, STT, embeddings).

---

## 4. Identity & Authentication

### 4.1 Dual auth

| Layer | What | Purpose |
|---|---|---|
| **Clerk JWT** | Verified account | "Has a verified account" |
| **NIP-98 signature** | Nostr keypair | "Controls this npub" |

Both required on mutations. Reads open. npub = universal identity.
nsec ONLY on device (flutter_secure_storage). Optional NIP-49 backup.

### 4.2 Two-tier access (AvaID gating)

| Tier | Requires | Apps |
|---|---|---|
| **Tier 1** | Clerk signup | AvaChat, AvaTok, AvaBrain, AvaWallet, AvaCalendar, AvaOLX (browse) |
| **Tier 2** | AvaID verification | AvaDate, AvaMatri, AvaBook, AvaGram, AvaTweet, AvaLinked, AvaLive, AvaTube, AvaOLX (list/sell) |

Tier 2 routes run `requireVerified()` middleware (KV-cached, 1h TTL).

---

## 5. Data Layer

### 5.1 D1 facts
- 25B rows_read/month per account
- Sessions API → replica reads at ~330 edge PoPs
- Writes to primary (APAC)
- 100 bound params (chunk ≤90)
- ~10 GB soft ceiling per database

### 5.2 Key indexes
All hot paths indexed. See individual schema sections for full index list.

> **Name accuracy:** the media database is `avatok-media-meta` (binding `DB_MEDIA`),
> not `avatok-media` as some older docs say. Always use the binding name in code.

### 5.3 Relay sharding
Per-user inbox DOs (hibernating). DMs fan out. Public posts to D1.
Time-shard at ~5 GB documented but not triggered.

---

## 6. AI Layer

### 6.1 Models (all Workers AI except AWS Rekognition)

| Purpose | Model | Notes |
|---|---|---|
| **General intelligence** | `@cf/google/gemma-4-26b-a4b-it` | MoE 26B/4B active. Vision, reasoning, tool calling, 256K context, 35+ langs. |
| **Text moderation** | `@cf/meta/llama-guard-3-8b` | Purpose-built safety classifier. |
| **Embeddings** | `@cf/baai/bge-small-en-v1.5` | 384-dim. Matches Vectorize. |
| **Image processing** | `@cf-wasm/photon` | WASM pHash. |
| **Text-to-Speech** | `@cf/deepgram/aura-2-en` | 40 voices. Context-aware, natural pacing. Agent voice. |
| **Speech-to-Text** | `@cf/deepgram/nova-3` | Fast multilingual. Voice input transcription. |

### 6.2 External AI (one exception)

| Service | Purpose | Justification |
|---|---|---|
| **AWS Rekognition Face Liveness** | AvaID verification | Specialized security model. Free 5K/month × 12 months. |

### 6.3 TTS voice options

40 Deepgram Aura-2 voices: luna, atlas, orion, athena, zeus, apollo, aurora, iris,
hermes, perseus, hera, stella, minerva, neptune, jupiter, saturn, mars, orpheus,
pandora, ophelia, juno, callista, cordelia, delia, thalia, and more.

> **Builder prerequisite:** before building the voice selection UI, probe the
> `@cf/deepgram/aura-2-en` model to verify the exact `speaker` parameter schema
> and confirm all voice IDs. The spec's voice list is from Cloudflare docs but
> may have additions/changes. A one-hour verification task.

### 6.4 Why Gemma 4
Replaces three models (brain extraction, reasoning, image moderation).
4B active cost. Tool-calling capability powers the agentic layer.

> **Builder prerequisite:** Gemma 4 chat and vision are confirmed working on
> Workers AI. **Tool-calling (function calling) has not been verified** on the
> Workers AI runtime. Before building the agent task executor (§20), probe
> `gemma-4-26b-a4b-it` with a tool-calling input schema and confirm it returns
> structured tool_use responses. If tool-calling fails, fallback: use structured
> JSON output with a tool-selection prompt (less elegant but functional).

### 6.5 Moderation model pipeline (matches deployed code)

The moderation pipeline is MORE than "Gemma 4 vision." The deployed code
(`consumers/src/csam.ts` + moderation consumer) runs this chain:

```
Upload arrives
  → 1. CSAM hash-match gate (fail-closed, runs FIRST)
       If match → reject immediately, log, report
       If no CSAM creds yet → bypassed (fail-open until creds provided)
  → 2. Cheap external NSFW classifier (fast, low cost)
       If clearly safe → pass
       If clearly unsafe → reject
       If ambiguous (mid-confidence) → escalate to step 3
  → 3. Gemma 4 vision (expensive, accurate)
       Final NSFW/violence/hate classification
  → 4. pHash LSH blocklist (DB_MODERATION.blocked_media_hashes)
  → 5. sha256 dedupe (never re-scan identical bytes)
```

This layered approach saves ~60-80% of Gemma 4 inference costs compared to
running vision on every upload. Do NOT simplify back to Gemma-4-only.

### 6.6 Cost discipline
- Workers AI: 10K neurons/day free, then $0.011/1K
- Gemma 4 at 4B active: ~4× cheaper than 8B, ~27× cheaper than 70B
- CSAM gate + cheap classifier reduce Gemma 4 calls by 60-80%
- sha256 dedupe + pHash cache on top of that
- Duration to Analytics Engine as cost proxy
- `MODERATION_MODEL_TYPE` env var for future classifier swap
- **Agent TTS is on-demand** (§20.5) — synthesized only when user taps "Listen"

---

## 7. AvaBrain (v2 — Knowledge + Action)

### 7.1 Concept

| Capability | v1 (built) | v2 (new) |
|---|---|---|
| Remember facts | ✓ | ✓ |
| Answer questions | ✓ | ✓ |
| Daily briefings | ✓ | ✓ |
| Investigate problems | ✓ | ✓ |
| **Agent conversations** | — | ✓ |
| **Task execution** | — | ✓ |
| **Per-app personas** | — | ✓ |
| **Voice** | — | ✓ |
| **Agent Inbox** | — | ✓ |

**Data paths:**

| Source | Processing | Path |
|---|---|---|
| Public content | Server-side, auto | Relay → Q_BRAIN → brain consumer |
| Private/E2E content | Client-side, opt-in | App → `POST /api/brain/remember` |
| Platform events | Server-side, auto | Platform app → Q_BRAIN |
| Agent conversations | Server-side, scoped | ConversationDO → Q_BRAIN (persona-scoped only) |

**Server NEVER sees DM plaintext.** Unchanged.

### 7.2 Knowledge graph (DB_BRAIN)
brain_entities, brain_relationships, brain_facts, brain_daily_summaries, brain_events.
Scope: `'public'` | `'private'` | `'agent:{app_name}'`.

### 7.3 UserBrain DO
Per-user DO (npub), WebSocket Hibernation:
ask, briefing, investigate, remember, forget, agentChat, getInbox.
Gemma 4 with thinking mode. Vectorize filtered by npub.
Importance decayed lazily at read (no cron full-table writes).

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
GET    /api/agent/inbox/:id
POST   /api/agent/approve      { conversation_id, action }
POST   /api/agent/task         { task_description, app_name }
GET    /api/agent/personas
PUT    /api/agent/personas/:app { persona_prompt, looking_for, boundaries }
```

### 7.5 Universal brain hook
Every app MUST include a brain hook. Toggle ON by default. Davy instructs per-app.

### 7.6 AvaBrain standalone app — five screens
1. **Chat** — ask questions, citations
2. **Briefing** — daily summary + calendar + agent highlights
3. **Memory** — browse/search/delete
4. **Investigate** — PostHog query
5. **Agent Inbox** — centralized conversation hub (§20.6)

### 7.7 Platform app brain integration
| App | Brain learns |
|---|---|
| AvaWallet | "Spent 500 coins on coaching", "Earned ₹5K from streaming" |
| AvaCalendar | "Consultation with Jeff tomorrow 10am" |
| AvaPayout | "₹15,000 payout to HDFC" |
| AvaID | "Account verified June 5" |

---

## 8. Media Pipeline

### 8.1 Routing
```
Photo/audio/small → Blossom-on-R2 (sha256)
  → Moderation pipeline (§6.5: CSAM → cheap classifier → Gemma 4 → pHash)
  → If first-time hash + public: scan completes BEFORE URL is serveable (§8.3)
  → Served via blossom.avatok.ai (30-day edge cache)

Video → Bunny Stream (HLS) → frame extraction + classification
1:1 call → WebRTC P2P (NIP-100)
Group ≤5 → CF Calls SFU (CallRoom DO)
Live 1→many → CF Stream Live
Agent audio → R2 avatok-agent-audio (TTS output, on-demand)
```
Bytes NEVER through Workers except moderation scan.

### 8.2 Two upload paths
| | Public | Private |
|---|---|---|
| AI moderation | Yes (§6.5 pipeline) | No (ciphertext) |
| Edge cache | Yes | Yes |
| pHash blocklist | Yes (LSH) | No |

### 8.3 CSAM pending-publish protection

**Problem:** public uploads are PUT to R2 with status `pending` and scanned async.
Brief window where unscanned bytes are fetchable by hash. Acceptable for
adult/violence content (rare, short-lived) but NOT acceptable for CSAM.

**Fix:** for first-time hashes (no sha256 match in moderation_results cache):
- Upload goes to R2 but is NOT added to the public URL map until scan completes
- The `pending` media is serveable ONLY to the uploader (auth-gated)
- Once scan clears: status → `approved`, URL becomes public
- Once scan rejects: blob deleted from R2, status → `rejected`

Returning hashes (sha256 hit in cache, previously approved) skip the scan
and are immediately public. This adds ~1-3s latency on first-time uploads only.

---

## 9. Content Moderation

### 9.1 Image moderation — layered pipeline (public uploads only)

**This is the deployed pipeline. Do NOT simplify to Gemma-4-only.**

```
1. CSAM hash-match (consumers/src/csam.ts)
   → Runs FIRST on every public upload
   → Compares against csam_hashes table (DB_MODERATION)
   → Fail-closed: if the gate errors, upload is rejected
   → Currently bypassed (no PhotoDNA/NCMEC creds yet)
   → When creds provided: gate activates immediately

2. Cheap NSFW classifier (first pass)
   → Fast, low-cost binary classifier
   → Clearly safe → approve (skip Gemma 4)
   → Clearly unsafe → reject (skip Gemma 4)
   → Ambiguous (mid-confidence) → escalate to Gemma 4

3. Gemma 4 vision (escalation only)
   → NSFW/violence/hate multi-label classification
   → Only runs on ~20-40% of uploads (ambiguous band)
   → sha256 dedupe: identical bytes never re-scanned

4. pHash LSH blocklist
   → Perceptual hash against blocked_media_hashes
   → Catches near-duplicates of previously blocked content

5. Result cached in moderation_results (keyed by sha256)
   → Future uploads of same bytes skip entire pipeline
```

### 9.2 Text moderation
Public text → `llama-guard-3-8b`. DMs NOT scanned (E2E).

### 9.3 Agent conversation moderation
Every agent-generated message → `llama-guard-3-8b` before storage.
Unsafe → regenerate with safety reminder. Repeated violations → pause agent for that app.
User's persona prompt also moderated on save (reject harmful instructions).

### 9.4 Strike system
24h → 7d → permanent ban. DB_META `account_status`.

---

## 10. Platform Foundation Layer

### 10.1 AvaWallet — Money Layer

> ⚠️ **LEGAL REVIEW REQUIRED — BLOCKING**
> Real money in (Stripe) → stored value (AvaCoins) → withdrawable to bank (Wise)
> is the pattern regulators classify as a prepaid payment instrument (RBI PPI
> in India) or stored-value / money transmission (US FinCEN). Calling credits
> "not real money" is marketing, not legal protection. **Engineering can proceed
> with building the wallet infrastructure, but NO real money may flow in production
> until legal counsel has reviewed and approved the structure.** Possible structural
> mitigations to explore with counsel: treating creator earnings as direct B2B
> payouts, capping stored value, escrow arrangements, or obtaining PPI/PA licensing.

**AvaCoins = platform credits.**
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
WalletDO (per-user, atomic SQLite balance, WebSocket). StreamSessionDO (per-stream,
batches gifts every 5s). Q_WALLET for D1 audit trail.

**Flows:**
- Top-up: user enters amount → Stripe Checkout → webhook → WalletDO credits
- Spend: POST /api/wallet/spend → WalletDO debits → creator credited minus commission → 7-day hold
- Hold release: cron every 6h → move matured holds → push

**API:** POST topup, POST spend, GET balance, GET transactions, GET earnings, WS live.
Full D1 schema in PLATFORM-APPS-PROPOSAL.md.

---

### 10.2 AvaCalendar — Scheduling Layer

Central scheduling. Both host and attendee see same booking.
Creator sets slots → user browses → books (wallet debit if paid) → events for
both → push → Q_BRAIN learns. Cron reminders at 30m and 1h.

**API:** CRUD slots, POST book, POST cancel, GET events.
Full D1 schema in PLATFORM-APPS-PROPOSAL.md.

---

### 10.3 AvaPayout — Creator Withdrawals

> ⚠️ **LEGAL REVIEW REQUIRED — BLOCKING (same as §10.1)**
> Payout is the money-out leg. Same regulatory concerns as AvaWallet.
> Build the infrastructure, do NOT enable production transfers until counsel clears.

Wise API for direct bank transfer. Minimum 1,000 coins ($10). 7-day hold.

**Wise flow:** creator links bank (IFSC + account for India) → Wise recipient →
withdrawal: validate → quote → transfer → fund → push.

Full D1 schema in PLATFORM-APPS-PROPOSAL.md.

---

### 10.4 AvaID — Identity Verification

Three steps: phone (Clerk), email (Clerk), selfie video (AWS Rekognition).
Confidence ≥ 90% → auto-approve. < 90% → reject (max 3 retries/24h).
No human review at launch.

**Video retention:** PERMANENT in locked R2 until account deletion (law enforcement).
Never publicly accessible. Never served through any API.

> **The older spec's document-upload columns (Aadhaar/PAN) and 90-day doc-deletion
> cron are now moot.** v5.1 is selfie-liveness only (less PII, simpler). If those
> old columns exist in DB_META, they can be ignored or dropped in a migration.
> The `avatok-verification` R2 bucket now holds selfie videos permanently (not
> documents with 90-day TTL).

**Tier check:** `requireVerified()` middleware, KV-cached 1h.

> ⚠️ **FLUTTER ENGINEERING NOTE — AvaID is the client-side long pole.**
> AWS Face Liveness ships as Amplify's native UI SDK (iOS/Android/JS).
> **There is no first-party Flutter SDK.** Implementation options:
> 1. Platform channel bridge to native Android/iOS Amplify SDK (recommended)
> 2. WebView wrapper around Amplify JS Liveness component
> 3. Manual video capture + server-side liveness session (less guided UX)
>
> Server side also requires **AWS SigV4 signing inside the Worker** (no AWS SDK
> in Workers — use a lightweight SigV4 library or hand-roll the signing).
> Budget real Flutter + Worker time for AvaID. Scope this early.

---

### 10.5 Delete Cascade

30-day grace → Q_DELETE processes **15 stores** sequentially:

| # | Store | What's deleted |
|---|---|---|
| 1 | DB_BRAIN | entities, relationships, facts, summaries, events |
| 2 | DB_WALLET | balances, transactions, topups, holds, payout accounts/requests |
| 3 | DB_RELAY | nostr_events + nostr_tags by pubkey |
| 4 | DB_MEDIA | user_media, hashes, olx_listings, olx_purchases |
| 5 | R2 avatok-blobs | Media files (keys from DB_MEDIA before step 4) |
| 6 | R2 avatok-verification | Selfie video |
| 7 | R2 avatok-agent-audio | Agent conversation audio |
| 8 | DB_MODERATION | user_reports by reporter |
| 9 | DB_META | Profile, settings, follows, blocks, mutes, push, calendar, verification, agent personas, agent inbox, deletion request |
| 10 | Vectorize | Brain vectors (IDs collected before step 1) |
| 11 | KV | Cached tokens, verification status |
| 12 | DOs | WalletDO, UserBrain, AgentDO, relay inbox (storage clear) |
| 13 | Clerk | Account deletion |
| 14 | PostHog | GDPR person deletion |
| 15 | Stripe | Customer deletion |

**Order matters:** collect R2 keys, Clerk ID, Vectorize IDs BEFORE deleting DB rows.

---

### 10.6 AvaOLX — Marketplace

**Physical goods (free classifieds):**
Cars, property, furniture — anything physical. FREE listings. No money through
AvaTalk. User fills simple form → system auto-generates beautiful 2-page listing UI.
Page 1: hero image, title, price, description. Page 2: more photos, seller info,
AvaChat contact button. Deal happens offline.

**Digital products (wallet-powered):**
Designs, templates, ebooks, code — anything downloadable. Priced in AvaCoins.
Buyer pays → coins transfer → download unlocked via signed R2 URL.
Platform commission: 15%. "Downloads" section shows purchased products.

**Listing auto-generation:**
Simple input → clean presentable page. Think Carousell meets Notion.

**Agent negotiation (digital products only):**
Buyer's agent can negotiate price with seller's agent within guardrails (§20).

**Tier gating:** Browse = Tier 1. List/sell = Tier 2.

Full D1 schema (olx_listings, olx_digital_products, olx_purchases) in DB_MEDIA.

---

## 20. Agentic Layer

### 20.1 Concept

Every user's AvaBrain can operate as an AI agent — a representative that talks
to other users' agents, executes tasks, and reports back. The agent IS the brain,
scoped to a specific app context via per-app personas.

```
AvaBrain v1:  KNOWS things (memory)
AvaBrain v2:  KNOWS things + DOES things (agent)
```

Gemma 4 tool-calling: persona + scoped knowledge + tools + guardrails.

### 20.2 Agent Setup (onboarding)

1. **Choose a voice** — 40 Deepgram Aura-2 voices. Stored as `agent_voice_id`.
2. **Global bio** — pulled from brain entities, user editable.
3. **Per-app personas** — set within each app's settings (§20.3).

### 20.3 Per-App Persona System

**Critical: the agent does NOT have free access to the full brain.** Each app
gets its own isolated persona. The agent only knows and shares what the user
explicitly puts in that app's persona settings.

```
AvaDate persona:
  Persona: "I'm Davy, 32, Dehradun. Love hiking, cooking, conversation."
  Looking for: "Women 25-35, non-smoker, outdoors, adventure"
  Boundaries: "Don't share work details. Don't discuss salary. No meetups without approval."
  Auto-approve: false

AvaLinked persona:
  Persona: "Tech entrepreneur building social apps on Nostr."
  Looking for: "CTOs, investors, Nostr devs, AI engineers"
  Boundaries: "No personal details. No meeting commitments. Professional only."
  Auto-approve: true (but see §20.9 — still produces undo-able inbox item)
```

The dating agent knows NOTHING about the LinkedIn persona. Complete isolation.

**D1 schema (DB_META):**
```sql
CREATE TABLE agent_personas (
  id              TEXT PRIMARY KEY,
  npub            TEXT NOT NULL,
  app_name        TEXT NOT NULL,
  persona_prompt  TEXT NOT NULL,
  looking_for     TEXT,
  boundaries      TEXT,
  auto_approve    INTEGER DEFAULT 0,
  active          INTEGER DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(npub, app_name)
);
```

### 20.4 Agent-to-Agent Protocol

**Matching:** Agent A's `looking_for` vs Agent B's `persona_prompt` → Gemma 4
compatibility check (one inference). Match → ConversationDO. No match → silent.

**Conversation flow:**
1. ConversationDO created (keyed by conversation_id)
2. Turn-by-turn: Agent A message → llama-guard check → Agent B response → check
3. N turns (default 10-15), Gemma 4 evaluates natural conclusion
4. On completion: summaries generated, transcript saved

**Inbound text is UNTRUSTED.** The other user's agent output is attacker-controllable
(prompt injection via persona). All inbound agent text is treated as user input,
not system context. Boundaries are enforced via system prompt isolation, not
by trusting the other agent's output.

### 20.5 TTS Voice Synthesis — ON DEMAND (lazy)

> **Audit fix:** v5 synthesized audio for every conversation automatically.
> This is wasteful — most conversations are read as text or dismissed.
> v5.1 changes to **lazy TTS**: audio synthesized only when user taps "Listen."

```
Conversation completes → transcript stored as JSON → notification sent
User opens inbox → sees text transcript
User taps "▶ Listen" → triggers TTS synthesis:
  For each message:
    1. Determine speaker (agent_a or agent_b)
    2. Get speaker's voice_id
    3. Call @cf/deepgram/aura-2-en { text, speaker: voice_id }
    4. Receive audio chunk
    5. Add 0.5s silence between turns
  Stitch → store in R2 avatok-agent-audio/{conversation_id}.ogg
  Return audio URL to client → playback starts
  Cache: once synthesized, audio is reused for both users
```

**Cost impact:** reduces TTS calls by ~90% (most conversations never listened to).
Audio is generated once and cached in R2 for both parties.

### 20.6 Agent Inbox

Centralized hub in AvaBrain (5th screen). WhatsApp-style layout.

```
┌────────────────────────┬──────────────────────────────────────┐
│  CONNECTIONS (left)    │  CONVERSATION (right)                │
│                        │                                      │
│  🔴 AvaDate           │  AvaDate — Your agent × Priya's      │
│  ├─ Priya's agent     │                                      │
│  └─ Meera's agent     │  [Text transcript]                   │
│                        │  Agent: "Hi! I noticed we both..."   │
│  🔵 AvaLinked         │  Priya: "Yes! I love hiking too..."  │
│  └─ Raj's agent       │                                      │
│                        │  [▶ Listen] (lazy TTS — on tap)     │
│  🟢 AvaOLX            │                                      │
│  └─ Buyer (MacBook)   │  [Summary] "Both enjoy hiking..."    │
│                        │                                      │
│                        │  [✓ Connect] [✗ Dismiss] [↩ Undo]  │
└────────────────────────┴──────────────────────────────────────┘
```

**Color coding:** 🔴 AvaDate, 🟣 AvaMatri, 🔵 AvaLinked, 🟢 AvaOLX, 🟡 AvaCalendar, ⚪ AvaChat.

**D1 schema (DB_META):**
```sql
CREATE TABLE agent_conversations (
  id                TEXT PRIMARY KEY,
  app_name          TEXT NOT NULL,
  agent_a_npub      TEXT NOT NULL,
  agent_b_npub      TEXT NOT NULL,
  status            TEXT DEFAULT 'active',
  match_reason      TEXT,
  summary_for_a     TEXT,
  summary_for_b     TEXT,
  transcript        TEXT,              -- JSON array
  audio_r2_key      TEXT,              -- null until user taps Listen
  turn_count        INTEGER DEFAULT 0,
  outcome           TEXT,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  expires_at        INTEGER
);
CREATE INDEX idx_conv_a ON agent_conversations(agent_a_npub, created_at DESC);
CREATE INDEX idx_conv_b ON agent_conversations(agent_b_npub, created_at DESC);

CREATE TABLE agent_inbox (
  id                TEXT PRIMARY KEY,
  npub              TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  app_name          TEXT NOT NULL,
  other_npub        TEXT NOT NULL,
  other_display     TEXT,
  summary           TEXT,
  status            TEXT DEFAULT 'unread',
  action_taken      TEXT,
  undoable_until    INTEGER,           -- epoch ms, null if not auto-approved
  has_audio         INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_inbox_user ON agent_inbox(npub, created_at DESC);
CREATE INDEX idx_inbox_unread ON agent_inbox(npub, status) WHERE status = 'unread';
```

### 20.7 Use Cases by App

**AvaDate/AvaMatri:** Agent matchmaker + icebreaker. 10-15 turns on shared interests. Summary + audio. Both approve → connected.

**AvaLinked:** Professional networking. Agent identifies interesting profiles, initiates conversations, schedules intro calls via AvaCalendar.

**AvaOLX:** Digital product negotiation. Buyer agent knows budget (from persona guardrails), seller agent has min price. Agents negotiate. Agreement → both confirm → wallet processes.

**AvaCalendar:** Schedule coordination. Agents compare availability, agree on time, create bookings.

**AvaChat:** Smart presence when offline. Agent responds using AvaChat persona (NOT full brain). Responses tagged "agent-handled" for user review.

**AvaLive:** Stream co-host. Agent answers viewer questions from brain knowledge. Tagged with bot icon.

**AvaTube/AvaGram:** Content assistant. Drafts captions/descriptions in user's voice. User reviews in inbox.

### 20.8 AgentDO and ConversationDO

**AgentDO** — per user (npub). Coordinates all agent activity.
Rate limiting: max 5 agent conversations per app per day.

**ConversationDO** — per conversation. Generates turns, checks conclusion,
triggers summary generation. Self-destructs after 30 days if neither user acts.

### 20.9 Guardrails & Safety (hardened per audit)

1. **Persona isolation:** Agent for App X has ZERO access to App Y persona/data.
2. **Boundary enforcement:** Boundaries injected as system-prompt hard constraints.
3. **Inbound text is UNTRUSTED:** All agent-generated text from the other party is
   treated as user input, never injected into system context. This mitigates
   prompt injection attacks where a malicious persona tries to extract information.
4. **Content moderation:** Every message → `llama-guard-3-8b`. Unsafe → regenerate.
5. **Rate limiting:** Max 5 new conversations per app per day.
6. **ALL consequential actions require inbox approval — even with auto_approve.**
   - `auto_approve = false`: action waits in inbox for user confirmation.
   - `auto_approve = true`: action executes BUT produces a **quick-undo inbox item**
     with a 1-hour window. User can reverse any auto-approved action within 1 hour.
   - This prevents silent commits. Every action is visible and reversible.
7. **Agent CANNOT spend AvaCoins without explicit confirmation** regardless of
   auto_approve. Financial actions always require tap-to-confirm.
8. **Human takeover:** User can jump into any active conversation at any point.
9. **Transparency:** Full persona prompt visible to user. No hidden instructions.
10. **Kill switch:** Global agent toggle in AvaBrain settings (OFF = all agents stop).
11. **Expiry:** Conversations not acted on within 7 days auto-dismiss.
12. **No DM access:** Agent NEVER reads E2E encrypted DMs.
13. **Persona moderation:** User's persona prompt is moderated by llama-guard on save.
    Harmful/manipulative instructions are rejected.
14. **Per-user daily neuron budget:** circuit-breaker that pauses agent activity if
    a user's AI inference cost exceeds a configurable daily threshold. Prevents
    runaway costs from adversarial or buggy agent loops.

---

## 21. Observability (three-system split)

| Destination | What | Cost |
|---|---|---|
| **PostHog** | User events, platform events, agent events, errors | Free to 1M/month |
| **Analytics Engine** | Ops metrics (latency, throughput, queue health, AI cost) | $0.25/million |
| **Workers Logs** | Raw requests, stack traces | Free, 7-day retention |

### 21.1 Trace IDs
Every request gets `X-Trace-Id`. Flows through entire pipeline.

### 21.2 PostHog events (~55 types)

**Auth (4):** login_success, login_failed, session_expired, logout
**Messaging (4):** message_sent, message_delivered, message_failed, message_read
**Calls (4):** call_started, call_ended, stream_started, stream_ended
**Uploads (2):** upload_completed, upload_failed
**Brain (5):** brain_query, brain_response, brain_memory_created, brain_briefing_opened, brain_investigate
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

All batched via Q_ANALYTICS. Every event carries: trace_id, user_id, app_name, app_version, service_name.

### 21.3 Dashboards (13)

| # | Dashboard | Key metrics |
|---|---|---|
| 1 | System Health | Error rates by severity/service |
| 2 | Auth Health | Login success/fail, reasons |
| 3 | User Journey | Signup → verify → profile → message → reply |
| 4 | Messaging Health | Send/deliver/fail, latency |
| 5 | AI / Brain | Query latency, memory hit rate |
| 6 | Mobile Stability | Errors by version/device |
| 7 | Cross-App | Events by app, multi-app users |
| 8 | Wallet Health | Top-up rate, spend/earn, commission |
| 9 | Payout Health | Volume, Wise success/fail |
| 10 | Verification | Approval rate, rejection reasons |
| 11 | Calendar Health | Booking rate, cancellations |
| 12 | Agent Health | Conversations/day, match rate, TTS latency, neuron budget usage |
| 13 | OLX Health | Listings, digital sales, negotiation outcomes |

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
15. Deletion cascade removes ALL data from ALL 15 stores after 30-day grace.
16. Agent personas are user-controlled — user writes every word the agent shares.
17. Agent conversations are transparent — full transcript visible.
18. Agent has NO access to DMs, full brain, or other app personas.
19. Agent cannot spend money without explicit user confirmation.
20. Agent audio stored in separate R2 bucket, deleted in cascade.
21. Inbound agent text treated as untrusted — never injected into system context.

---

## 23. Real-Time Pipeline

| Scenario | Tech |
|---|---|
| 1:1 call | WebRTC P2P, NIP-100 |
| Group ≤5 | CF Calls SFU, CallRoom DO |
| Live broadcast | CF Stream Live |
| Wallet balance | WalletDO WebSocket |
| Stream gifts | StreamSessionDO batches every 5s |
| Agent conversations | ConversationDO async turns, push on completion |
| Agent TTS | On-demand via Q_AGENT when user taps "Listen" |

---

## 24. Cost Model (at 10M users)

### 24.1 Cost levers
1. **Workers AI moderation** — mitigated by CSAM gate + cheap classifier first-pass (60-80% reduction), sha256 dedupe, pHash cache
2. **D1 rows_read** — mitigated by indexes, FTS5, replicas
3. **R2** — cheap with cache rules
4. **DOs** — hibernation keeps inactive users near zero
5. **Bunny** — $0.005/GB
6. **Stripe fees** — 2.9% + $0.30 per top-up
7. **Wise fees** — ~$1-2 per India transfer
8. **AWS Rekognition** — $0.025/call after free tier (one-time per user)
9. **Agent TTS** — **on-demand only** (~7,500 chars/conversation, but only ~10% of conversations listened to)
10. **Agent AI inference** — ~15 Gemma 4 calls per conversation × 4B active. **Per-user daily neuron budget** caps runaway costs.

### 24.2 Free tiers
- D1: 25B rows_read/month
- Workers AI: 10K neurons/day
- R2: 10M Class A, 1B Class B, 10 GB
- Workers: 10M requests/month
- PostHog: 1M events/month
- Analytics Engine: 10M data points
- AWS Rekognition: 5K/month (12 months)

---

## 25. Nostr Protocol

| Kind | Purpose | App |
|---|---|---|
| 0 | Profile metadata | All |
| 1 | Short text note | AvaTweet, AvaBook |
| 3 | Follow list | All |
| 6 | Repost | AvaTweet |
| 7 | Reaction | All |
| 14 | DM (inner) | AvaChat |
| 1059 | Gift wrap (DM) | AvaChat |
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

NIPs: 01, 02, 05, 10, 17, 19, 25, 42, 44, 49, 53, 59, 65, 68, 71, 100. No NIP-04.

---

## 26. Build Status

### 26.1 Done (deployed, verified)
- [x] Backend rebuild (4 Workers, 5 D1, all §3.A infra)
- [x] Dual auth (NIP-98 + Clerk JWT)
- [x] Relay inbox DOs with hibernation
- [x] Media pipeline (R2 + Blossom + CSAM gate + cheap classifier + Gemma 4 + pHash)
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
- [ ] **Engage legal counsel for AvaCoins/payout structure (BLOCKING for §10.1/§10.3)**

### 26.3 Pre-build verification tasks (before coding starts)
- [ ] **Probe Gemma 4 tool-calling** on Workers AI (1 hour). Confirm structured tool_use response format. Fallback: structured JSON output.
- [ ] **Probe Deepgram Aura-2 `speaker` param** — verify all 40 voice IDs (1 hour)
- [ ] **Scope AvaID Flutter bridge** for AWS Rekognition Face Liveness (no Flutter SDK; needs platform channel to native Amplify SDK)
- [ ] **Scope AWS SigV4 signing** in Worker for Rekognition API calls (no AWS SDK in Workers)

### 26.4 Next: platform foundation (in order)
- [ ] AvaID — verification, tier middleware, delete cascade (note: Flutter bridge is long pole)
- [ ] AvaWallet — WalletDO, StreamSessionDO, Stripe top-up, spend/earn
- [ ] AvaCalendar — slots, bookings, cron reminders
- [ ] AvaPayout — Wise integration, withdrawal (BLOCKED by legal review)
- [ ] AvaOLX — listings, digital products, purchase flow
- [ ] Wire PostHog events + brain hooks across platform apps

### 26.5 Next: agentic layer (after platform)
- [ ] AgentDO + ConversationDO (migration tag v4)
- [ ] Per-app persona system (schema, API, settings UI)
- [ ] Agent-to-agent matching + conversation engine
- [ ] Agent moderation (llama-guard on every generated message + persona save)
- [ ] Agent Inbox (AvaBrain 5th screen)
- [ ] Lazy TTS pipeline (on-demand Aura-2 synthesis + R2 cache)
- [ ] Agent hooks per app
- [ ] Neuron budget circuit-breaker
- [ ] Wire agent PostHog events

### 26.6 Next: social apps
- [ ] AvaBrain standalone Flutter app (5 screens)
- [ ] AvaChat brain + agent hooks (note: AvaChat/AvaTok rename refactor)
- [ ] AvaTok, AvaTweet, AvaBook, AvaGram, AvaLinked, AvaTube, AvaLive
- [ ] AvaDate, AvaMatri (agent-powered matching)
- [ ] AvaOLX Flutter app
- [ ] Marketing website (React on CF Pages → abertalk.ai)

---

## 27. Rules for AI Builders

1. **Flutter is the app.** React = marketing site (abertalk.ai) only.
2. **Cloudflare is the backend.** Exception: AWS Rekognition for AvaID.
3. **Gemma 4 is the default model.** llama-guard for moderation. bge-small for embeddings. Aura-2 for TTS. Nova-3 for STT.
4. **E2E is sacred.** Server never sees DM plaintext.
5. **Dual auth on every mutation.**
6. **Bytes never through Workers** except moderation.
7. **No full-table scans.** Every hot query indexed.
8. **D1 param limit 100.** Chunk ≤90.
9. **Brain toggle ON by default.**
10. **Three observability systems.** PostHog = user. AE = ops. Logs = debug.
11. **Every PostHog event carries:** trace_id, user_id, app_name, app_version, service_name.
12. **Never log:** nsec, JWTs, phones, emails, DM content, payments, verification docs.
13. **Brain hook in every app.** Davy instructs per-app.
14. **Tier 2 requires `requireVerified()`.**
15. **Wallet ops are atomic** through WalletDO.
16. **AvaCoins are credits, not money** in UI language.
17. **7-day hold on earnings.**
18. **Free-form top-up.** Min 100, max 50,000.
19. **Delete cascade is non-negotiable.** All 15 stores.
20. **Use third-party services for specialized problems.**
21. **Agent personas are per-app isolated.**
22. **Agent cannot spend coins without explicit human confirmation.**
23. **Every agent message is safety-checked** by llama-guard.
24. **Agent TTS is lazy** — synthesized on-demand when user taps "Listen."
25. **Max 5 agent conversations per app per day.**
26. **Agent Inbox is the single source** for all agent activity.
27. **All consequential agent actions produce an inbox item** — even with auto_approve (quick-undo window).
28. **Inbound agent text is UNTRUSTED.** Never inject into system context.
29. **Per-user daily neuron budget.** Circuit-breaker on agent AI costs.
30. **Moderation pipeline is layered** (CSAM → cheap classifier → Gemma 4). Do NOT simplify to Gemma-4-only.
31. **§3.A is reality. §3.B is planned.** Do not bind to §3.B resources unless you're creating them.
32. **All infra hostnames on avatok.ai.** Never abertalk.ai in configs.
33. **DB_MEDIA binding = avatok-media-meta** (not avatok-media). Use binding names in code.
34. **Actual queue names:** `moderation`, `push-notifications`, `email`, `analytics`, `brain-events`. Match these in wrangler config.

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
| STRIPE_SECRET_KEY | avatok-api | Coin top-up (PLANNED) |
| STRIPE_WEBHOOK_SECRET | avatok-api | Stripe webhook (PLANNED) |
| WISE_API_KEY | avatok-api/consumers | Payouts (PLANNED) |
| WISE_PROFILE_ID | avatok-api/consumers | Wise profile (PLANNED) |
| AWS_ACCESS_KEY_ID | avatok-api | Rekognition (PLANNED) |
| AWS_SECRET_ACCESS_KEY | avatok-api | Rekognition (PLANNED) |
| AWS_REGION | avatok-api | Rekognition region (PLANNED) |
| APNS_KEY_ID | avatok-consumers | iOS push (gated) |
| APNS_TEAM_ID | avatok-consumers | iOS push (gated) |

---

## 29. Conflict Analysis (for AI builders)

### 29.1 Agent ↔ Brain
- Agent reads brain via per-app persona scope ONLY
- Agent conversations produce facts scoped `agent:{app_name}`
- Brain toggle OFF for an app → agent for that app also disabled
- UserBrain DO and AgentDO are separate DOs, same npub key

### 29.2 Agent ↔ Wallet
- Agent can VIEW balance but CANNOT debit
- Purchases from agent negotiation → inbox approval → wallet debit
- StreamSessionDO is independent of agent

### 29.3 Agent ↔ Calendar
- Agent CAN create events IF auto_approve = true (produces undo-able item)
- Events tagged `source: 'agent'`
- Conflict check before commit

### 29.4 Agent ↔ E2E encryption
- Agent has ZERO access to kind 1059 DM content
- Agent conversations are NOT E2E (server-generated)
- Human takeover → conversation moves to AvaChat E2E from that point

### 29.5 Agent ↔ Moderation
- Every generated message → llama-guard
- Persona prompt moderated on save
- Repeated violations pause agent per app (not user account)
- Rate limits (5/day/app) separate from user limits

### 29.6 Agent ↔ Delete cascade
- Deletion covers: personas, conversations, inbox items, R2 agent-audio, AgentDO, ConversationDOs

### 29.7 Agent ↔ PostHog
- Agent events distinct from user events
- Agent conversations carry own trace_ids
- Neuron budget tracked in Analytics Engine

### 29.8 AvaOLX ↔ Wallet
- Physical: no wallet. Digital: spend/earn minus 15%
- Download unlocked after wallet tx confirmed
- 24h refund window for undownloaded digital products

### 29.9 CSAM ↔ Upload pipeline
- CSAM gate runs FIRST (before cheap classifier or Gemma 4)
- Fail-closed: if gate errors, upload rejected
- First-time hashes: public URL gated until scan completes (§8.3)

### 29.10 Naming accuracy
- DB_MEDIA → actual database: `avatok-media-meta`
- Queues: `moderation`, `push-notifications`, `email`, `analytics`, `brain-events`
- All new queues (wallet-transactions, account-deletions, agent-tasks) use these exact names in wrangler

### 29.11 DO migration tags

| Tag | Classes | Build phase |
|---|---|---|
| v1 | CallRoom | Original deploy (done) |
| v2 | UserBrain | AvaBrain build (done) |
| v3 | WalletDO, StreamSessionDO | Platform apps (planned) |
| v4 | AgentDO, ConversationDO | Agentic layer (planned) |

### 29.12 Pre-build verification (before agent coding)
- [ ] Gemma 4 tool-calling on Workers AI — probe and confirm
- [ ] Aura-2 voice IDs — probe and list all valid `speaker` values
- [ ] AWS SigV4 in Worker — test signing with lightweight lib
- [ ] Flutter Amplify Liveness — determine bridge strategy

---

## 30. Glossary

- **npub** — Nostr public key. Universal identity.
- **nsec** — Nostr secret key. Device only.
- **NIP** — Nostr Implementation Possibility.
- **Blossom** — Hash-addressed media on R2.
- **DO** — Durable Object.
- **D1** — Cloudflare serverless SQLite.
- **Workers AI** — Cloudflare edge AI inference.
- **Gemma 4** — Google MoE (26B/4B active). Primary AI.
- **Deepgram Aura-2** — TTS, 40 voices. Agent voice.
- **Deepgram Nova-3** — STT. Voice input.
- **AvaCoins** — Platform credits. 1 coin = $0.01. Not money (pending legal review).
- **WalletDO** — Per-user atomic wallet.
- **StreamSessionDO** — Per-stream gift aggregator.
- **AgentDO** — Per-user agent state manager.
- **ConversationDO** — Per-conversation turn generator.
- **Q_BRAIN** — Brain fact extraction queue.
- **Q_WALLET** — Wallet audit trail queue.
- **Q_DELETE** — Account deletion queue.
- **Q_AGENT** — Agent task dispatch + TTS queue.
- **UserBrain** — Per-user reasoning DO.
- **AvaBrain** — Standalone AI app (memory + agent inbox).
- **Agent Persona** — Per-app personality + boundaries + looking_for.
- **Agent Inbox** — Centralized conversation hub in AvaBrain.
- **Lazy TTS** — Audio synthesized on-demand, not automatically.
- **CSAM gate** — First-stage hash-match moderation, fail-closed.
- **AWS Rekognition** — Face liveness. One external AI service.
- **Wise** — Cross-border payouts.
- **Tier 1** — Basic (Clerk). Chat, calls, brain, wallet, calendar, OLX browse.
- **Tier 2** — Verified (AvaID). All social, dating, streaming, OLX sell.
