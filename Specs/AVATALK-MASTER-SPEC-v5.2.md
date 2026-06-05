# AvaTalk Network — Master Specification v5.2

**Version:** 5.2 (June 2026)
**Status:** Living document. Single source of truth. Supersedes v5.1.
**Domains:** avatok.ai (product — ALL infrastructure), abertalk.ai (brand name — future marketing site only)
**Audit applied:** Builder audit 2026-06-05 (all 8 recommendations, in v5.1) + v5.2 cleanups below.

> **IF YOU ARE AN AI BUILDER:** this document is the single source of truth.
> Read it end to end before writing any code. Then build strictly in the order of
> **§26 — Phased Build Plan**, which tells you WHAT to build and HOW, phase by phase.
> §3.A = what already exists. §3.B = what you create. §26 is authoritative for order.

---

## 0. Changelog (v5.1 → v5.2)

1. **Events count reconciled.** §26 "Done" said "29 PostHog events" while §21 lists ~55. Corrected: **29 event types are wired today; ~55 is the full target** (the remaining ~26 belong to wallet/agent/OLX features not yet built). Wording fixed everywhere.
2. **Stream "71 live inputs" claim corrected.** Verified against the live account: there are 71 Stream live inputs, **but they belong to an unrelated old project ("spitube"), NOT AvaLive.** AvaLive has provisioned **zero** of its own. §3.A now states this accurately, and the 71 spitube inputs are added to the decommission list. AvaLive creates its own live inputs on demand when built (§26 Phase relevant).
3. **§26 rewritten as a Phased Build Plan** — each phase now has Goal, Gate/Prereqs, What to build, How (concrete steps), Verify, and Done-when, so a builder AI has unambiguous instructions.

---

## 1. Vision

**One verified identity. Every social format. An AI brain that remembers everything, and an AI agent that acts for you.**

AvaTalk is a network of social apps sharing one user identity (a Nostr keypair linked to a Clerk account), one media library, one AI brain, and one platform layer. One login replaces 8+ social platforms; content created in one app is reusable in any other; your personal AI remembers across all of them; one wallet, calendar, and payout system serve the ecosystem; and your AI agent represents you across the network while you sleep.

**Marketing pillars:** (1) one login, many apps; (2) cross-post in one tap; (3) every account is a verified human; (4) your AI brain remembers everything; (5) earn and spend seamlessly with AvaCoins; (6) your AI agent works while you don't.

**Primary launch market:** India. Android-first. Hindi + English.

**Domain rule:**
- `avatok.ai` — ALL infrastructure hostnames (blossom.avatok.ai, relay, API, cache rules). The deployed Cloudflare zone. **Never change. Never put infra on abertalk.ai.**
- `abertalk.ai` — brand name only; future React marketing site on Cloudflare Pages. No backend.

---

## 2. App Pack — 17 total

**12 social apps + 1 AI app (AvaBrain) + 4 platform foundation apps.**

| # | App | Replaces | Primary primitives |
|---|---|---|---|
| 1 | AvaChat | WhatsApp/Messenger | Nostr DMs (NIP-17 E2E) + Blossom + CF Calls SFU |
| 2 | AvaTok | FaceTime (1:1 video) | WebRTC P2P + NIP-100 |
| 3 | AvaTweet | Twitter/X | Nostr kind 1 + Blossom-on-R2 |
| 4 | AvaBook | Facebook | Nostr kind 1 + media + graph |
| 5 | AvaGram | Instagram | Nostr kind 20 + Bunny (reels) |
| 6 | AvaLinked | LinkedIn | Nostr kind 30023 |
| 7 | AvaTube | YouTube | Nostr kind 34235 + Bunny |
| 8 | AvaLive | Twitch | CF Stream Live + NIP-53 |
| 9 | AvaDate | Tinder | Profile matching + Vectorize |
| 10 | AvaMatri | Shaadi.com | Matrimonial UX |
| 11 | AvaLibrary | — | Cross-app media manager |
| 12 | AvaOLX | OLX/Craigslist | Classifieds + digital marketplace + agent negotiation |
| 13 | **AvaBrain** | — | Standalone AI: memory, reasoning, agent management, Agent Inbox |
| 14 | **AvaWallet** | — | AvaCoins, top-up, spend, earn |
| 15 | **AvaCalendar** | — | Bookings, events, reminders |
| 16 | **AvaPayout** | — | Creator withdrawals (Wise) |
| 17 | **AvaID** | — | Identity verification (AWS Rekognition liveness) |

> The current Flutter app is "AvaTok" doing combined messaging + calls. Under this spec, messaging becomes **AvaChat** and AvaTok shrinks to 1:1 video — a client-side rename/nav refactor, not a backend change.

**Flutter is the app framework for all apps, all platforms.** React is only for the marketing site.

---

## 3. Architecture

### 3.A — DEPLOYED (verified 2026-06-05)

**Four Workers (all LIVE):**

| Worker | Role |
|---|---|
| `avatok-api` | Control plane: `/api/*`, dual auth, media upload, ICE, Stream webhook, CallRoom DO, UserBrain DO |
| `avatok-relay` | Nostr relay: per-user inbox DOs (hibernating), events → D1, Q_BRAIN dispatch |
| `avatok-consumers` | Queue consumers (moderation, push, email, analytics, brain) + 6h cron |
| `avatok-calls` | RealtimeKit/Stream token mint |

**Five D1 databases (APAC, read replication auto):**

| Binding | Actual name | Purpose |
|---|---|---|
| DB_META | avatok-meta | identity, profiles, follows, blocks, mutes, settings, push tokens, strikes |
| DB_RELAY | avatok-relay | nostr_events + nostr_tags |
| DB_MEDIA | **avatok-media-meta** | user_media, user_media_hashes (pHash) |
| DB_MODERATION | avatok-moderation | blocked_media_hashes, moderation_results, user_reports, csam_hashes |
| DB_BRAIN | avatok-brain | brain_entities, brain_relationships, brain_facts, brain_daily_summaries, brain_events |

**Other deployed infra:** R2 `avatok-blobs` (public, blossom.avatok.ai, 30-day cache) + `avatok-verification` (locked); KV `avatok-tokens`; Queues `moderation`, `push-notifications`, `email`, `analytics`, `brain-events`; Vectorize `avatok-semantic` (384-dim); Analytics Engine; Zone `avatok.ai`.

**Deployed DO migration tags:** v1 (CallRoom), v2 (UserBrain).

**Cloudflare Stream:** the product is **enabled** on the account, but AvaLive has provisioned **no live inputs of its own yet.** (There are 71 existing live inputs named `spitube-channel-*` — leftovers from an unrelated old project; see decommission list §26 Phase 0. Do NOT count them as AvaLive.)

**Deployed moderation pipeline (ahead of older specs — preserved):**
1. CSAM hash-match gate (`consumers/src/csam.ts`) — runs FIRST, fail-closed, bypassed until creds; `csam_hashes` table migrated.
2. Cheap external NSFW classifier first-pass — escalates only the ambiguous band to Gemma 4.
3. Gemma 4 vision — final classification.
4. pHash LSH blocklist.
5. llama-guard text moderation on public text.

### 3.B — PLANNED (does not exist; builders create per §26)

**New D1:** `DB_WALLET` → `avatok-wallet` (APAC).
**New tables** in DB_META (calendar_slots, calendar_events, verification_status, verification_attempts, deletion_requests, agent_personas, agent_conversations, agent_inbox) and DB_MEDIA (olx_listings, olx_digital_products, olx_purchases).
**New DOs:** WalletDO + StreamSessionDO (migration **v3**); AgentDO + ConversationDO (migration **v4**).
**New Queues:** `wallet-transactions`, `account-deletions`, `agent-tasks`.
**New R2 bucket:** `avatok-agent-audio`.
**Total after all builds:** 6 D1, 6 DOs (4 tags), 8 Queues, 3 R2 buckets.

### 3.C — External services

| Service | Purpose | Status |
|---|---|---|
| Clerk | Account auth | LIVE |
| Bunny.net | Video storage + HLS | LIVE |
| PostHog | Analytics, errors | LIVE |
| Brevo | Transactional email | LIVE |
| FCM/APNs | Push | LIVE |
| Stripe | AvaCoins top-up | PLANNED |
| Wise | Creator payouts | PLANNED |
| AWS Rekognition | Face Liveness (AvaID) | PLANNED |

Vendor count: 8. Cloudflare ~80% of infra incl. ALL AI inference (LLM, TTS, STT, embeddings).

---

## 4. Identity & Authentication

**Dual auth — both required on mutations; reads open.** Clerk JWT ("verified account") + NIP-98 signature ("controls this npub"). npub = universal identity. nsec ONLY on device (flutter_secure_storage), optional NIP-49 backup.

**Two tiers (AvaID gating):** Tier 1 (Clerk signup) → AvaChat, AvaTok, AvaBrain, AvaWallet, AvaCalendar, AvaOLX browse. Tier 2 (AvaID verified) → AvaDate, AvaMatri, AvaBook, AvaGram, AvaTweet, AvaLinked, AvaLive, AvaTube, AvaOLX list/sell. Tier 2 routes run `requireVerified()` (KV-cached, 1h TTL).

---

## 5. Data Layer

- 25B rows_read/month per account; Sessions API → replica reads at ~330 PoPs; writes to APAC primary; **100 bound-param limit (chunk ≤90)**; ~10 GB soft ceiling per DB.
- All hot paths indexed (see each schema section).
- **Name accuracy:** media DB is `avatok-media-meta` (binding `DB_MEDIA`). Always use binding names in code.
- Relay: per-user inbox DOs (hibernating); DMs fan out; public posts to D1; time-shard at ~5 GB (not triggered).

---

## 6. AI Layer

### 6.1 Models (all Workers AI except AWS Rekognition)

| Purpose | Model | Notes |
|---|---|---|
| General intelligence | `@cf/google/gemma-4-26b-a4b-it` | MoE 26B/4B active. Vision, reasoning, tool-calling, 256K ctx, 35+ langs. Brain + moderation + agents. |
| Text moderation | `@cf/meta/llama-guard-3-8b` | Binary safe/unsafe. |
| Embeddings | `@cf/baai/bge-small-en-v1.5` | 384-dim. Must match Vectorize. |
| Image processing | `@cf-wasm/photon` | WASM pHash. |
| Text-to-Speech | `@cf/deepgram/aura-2-en` | Agent voice (lazy synthesis). |
| Speech-to-Text | `@cf/deepgram/nova-3` | Voice input. |

All six model IDs verified present on the account 2026-06-05.

### 6.2 External AI (one exception)
AWS Rekognition Face Liveness for AvaID. Free 5K/month × 12 months.

### 6.3 Moderation pipeline (matches deployed code — do NOT simplify)
```
Upload → 1. CSAM hash gate (fail-closed; bypassed until creds)
       → 2. Cheap NSFW classifier (clear safe→pass, clear unsafe→reject, ambiguous→step 3)
       → 3. Gemma 4 vision (only the ~20-40% ambiguous band)
       → 4. pHash LSH blocklist
       → 5. result cached by sha256 (never re-scan identical bytes)
```
Saves ~60-80% of Gemma 4 calls vs vision-on-everything.

### 6.4 Cost discipline
Workers AI 10K neurons/day free then $0.011/1K. Gemma 4 ~4× cheaper than 8B. CSAM gate + cheap classifier + sha256 dedupe + pHash cache cut moderation cost. **Agent TTS is on-demand only** (§20.5). Per-user daily neuron budget circuit-breaker (§20.9).

### 6.5 Builder prerequisites (PROBE before relying on these)
- **Gemma 4 tool-calling** is NOT yet verified on Workers AI. Before building the agent executor, probe it; fallback = structured-JSON-output prompt.
- **Aura-2 `speaker` param + voice IDs** not yet verified; probe before the voice-picker UI.

---

## 7. AvaBrain (v2 — Knowledge + Action)

v1 (built): remember facts, answer questions, daily briefings, investigate. v2 (new): agent conversations, task execution, per-app personas, voice, Agent Inbox.

**Data paths:** public content → Relay → Q_BRAIN → consumer (server-side); private/E2E → app extracts client-side → `POST /api/brain/remember`; platform events → Q_BRAIN; agent conversations → ConversationDO → Q_BRAIN (persona-scoped only). **Server NEVER sees DM plaintext.**

**Knowledge graph (DB_BRAIN):** brain_entities, brain_relationships, brain_facts, brain_daily_summaries, brain_events. Scope: `public` | `private` | `agent:{app_name}`.

**UserBrain DO** (per npub, hibernating): ask, briefing, investigate, remember, forget, agentChat, getInbox. Gemma 4 thinking mode; Vectorize filtered by npub; importance decayed lazily at read.

**Brain + agent API routes** (NIP-98 + Clerk on all):
```
POST /api/brain/ask | briefing | remember | investigate ; DELETE /api/brain/forget ; GET /api/brain/entities | timeline
POST /api/agent/converse | approve | task ; GET /api/agent/inbox | inbox/:id | personas ; PUT /api/agent/personas/:app
```

**Brain learns from platform apps:** wallet spend/earn, calendar bookings, payouts, verification — all fed as facts.

**AvaBrain standalone app — five screens:** Chat, Briefing, Memory, Investigate, Agent Inbox.

---

## 8. Media Pipeline

```
Photo/audio/small → Blossom-on-R2 (sha256) → §6.3 moderation → blossom.avatok.ai (30-day cache)
Video → Bunny Stream (HLS) → frame extraction + classification
1:1 call → WebRTC P2P (NIP-100) ; Group ≤5 → CF Calls SFU (CallRoom DO) ; Live → CF Stream Live
Agent audio → R2 avatok-agent-audio (TTS, on-demand)
```
Bytes NEVER through Workers except the moderation scan.

**Two upload paths:** public (AI-moderated, edge-cached, pHash blocklist) vs private (client AES-GCM ciphertext, no scan).

**CSAM pending-publish protection (§8.3):** for first-time hashes, the public URL is gated until the scan clears (serveable only to the uploader meanwhile). Returning hashes (cache hit) skip the scan and are immediately public. ~1-3s added latency on first-time uploads only.

---

## 9. Content Moderation

**Image (public only):** the layered pipeline in §6.3. **Do NOT simplify to Gemma-4-only.**
**Text:** public → llama-guard-3-8b. DMs NOT scanned (E2E).
**Agent messages:** every one → llama-guard before storage; unsafe → regenerate; repeated → pause agent for that app; persona prompt moderated on save.
**Strikes:** 24h → 7d → permanent (DB_META account_status).

---

## 10. Platform Foundation Layer

### 10.1 AvaWallet
> ⚠️ **LEGAL REVIEW REQUIRED — BLOCKING.** Real money in (Stripe) → stored value (AvaCoins) → withdrawable to bank (Wise) is the pattern regulators classify as a prepaid payment instrument (RBI PPI / US money transmission). "Not real money" is marketing, not legal cover. **Build the infra, but NO real money may flow in production until counsel approves.** Explore with counsel: direct B2B creator payouts, stored-value caps, escrow, or PPI/PA licensing.

`1 AvaCoin = $0.01 (~₹0.85)`. Free-form top-up (min 100 / max 50,000), Stripe Checkout. Commission per-app: AvaLive 30%, Date/Matri 25%, Chat 20%, gifts 30%, AvaLinked 20%, AvaTube 25%, AvaOLX 15%. **WalletDO** (per-user atomic SQLite balance, WebSocket); **StreamSessionDO** (per-stream, batches gifts every 5s). Q_WALLET for D1 audit trail. 7-day hold on earnings. Full schema → PLATFORM-APPS-PROPOSAL.md.

### 10.2 AvaCalendar
Central scheduling: creator slots → user books (wallet debit if paid) → events for both → push → Q_BRAIN learns. Cron reminders at 30m and 1h. Tables in DB_META.

### 10.3 AvaPayout
> ⚠️ **LEGAL REVIEW REQUIRED — BLOCKING (same as §10.1).** Build infra; do NOT enable production transfers until counsel clears.

Wise API, direct bank transfer. Min 1,000 coins ($10), 7-day hold. Creator links bank (IFSC) → Wise recipient → validate → quote → transfer → fund → push.

### 10.4 AvaID
Phone (Clerk) + email (Clerk) + selfie video (AWS Rekognition). Confidence ≥90% → auto-approve; <90% → reject (max 3 retries/24h). No human review at launch. Selfie video PERMANENT in locked R2 until account deletion; never public. `requireVerified()` KV-cached 1h. (Old Aadhaar/PAN doc columns + 90-day doc-deletion cron are moot — selfie-liveness only.)

> ⚠️ **FLUTTER LONG POLE.** AWS Face Liveness ships as Amplify's native UI (iOS/Android/JS); **no first-party Flutter SDK.** Options: (1) platform-channel bridge to native Amplify SDK [recommended], (2) WebView around Amplify JS, (3) manual capture + server session. Server side needs **AWS SigV4 signing inside the Worker** (no AWS SDK in Workers). Scope early.

### 10.5 Delete Cascade
30-day grace → Q_DELETE processes **15 stores** in order (collect R2 keys / Clerk ID / Vectorize IDs BEFORE deleting referencing rows): DB_BRAIN → DB_WALLET → DB_RELAY → DB_MEDIA → R2 blobs → R2 verification → R2 agent-audio → DB_MODERATION → DB_META → Vectorize → KV → DOs → Clerk → PostHog → Stripe.

### 10.6 AvaOLX
**Physical goods** = free classifieds (no money through AvaTalk; auto-generated 2-page listing; contact via AvaChat). **Digital products** = AvaCoins-priced; buyer pays → coins transfer → download via signed R2 URL; 15% commission. Agent negotiation for digital products (§20). Browse = Tier 1; list/sell = Tier 2. Tables `olx_listings`, `olx_digital_products`, `olx_purchases` in DB_MEDIA (schema in PLATFORM-APPS-PROPOSAL.md).

---

## 20. Agentic Layer

The agent IS the brain, scoped to a per-app persona, with Gemma 4 tool-calling.

**Per-app persona isolation (critical):** the agent has ZERO access to the full brain or to other apps' personas. It only knows/shares what the user writes in that app's persona (persona_prompt, looking_for, boundaries, auto_approve). Schema `agent_personas` in DB_META.

**Agent-to-agent protocol:** Gemma 4 compatibility pre-check (looking_for vs other persona) → match → ConversationDO → turn-by-turn (each message llama-guard-checked) → natural-conclusion check → summaries. **Inbound agent text is UNTRUSTED** — treated as user input, never injected into system context (prompt-injection defense).

**Lazy TTS (§20.5):** audio synthesized ONLY when a user taps "Listen" → Aura-2 per-message with each speaker's voice → stitched → cached in R2 avatok-agent-audio (reused for both parties). ~90% fewer TTS calls.

**Agent Inbox** = AvaBrain's 5th screen; WhatsApp-style; color-coded per app. Tables `agent_conversations` + `agent_inbox` in DB_META.

**AgentDO** (per user; coordinates, rate-limits 5 conversations/app/day) and **ConversationDO** (per conversation; generates turns; self-destructs after 30 days).

**Guardrails (§20.9):** persona isolation; boundaries as hard constraints; inbound text untrusted; llama-guard on every message; rate limit 5/app/day; **all consequential actions produce an inbox item even with auto_approve** (1-hour quick-undo); **agent CANNOT spend coins without explicit tap-to-confirm**; human takeover anytime; full persona transparency; global kill switch; 7-day expiry; no DM access; persona moderated on save; **per-user daily neuron budget circuit-breaker.**

---

## 21. Observability (three-system split)

PostHog = user/product/agent events + errors (free to 1M/mo). Analytics Engine = ops metrics ($0.25/M). Workers Logs = raw/debug (7-day). Every request carries `X-Trace-Id` through the pipeline.

**PostHog events:** **29 wired today; ~55 is the full target** (the extra ~26 are wallet/calendar/payout/identity/lifecycle/agent/OLX events added as those features ship). Categories: Auth(4), Messaging(4), Calls(4), Uploads(2), Brain(5), Push(2), Journey(7) → these ~28-29 are the built set; Wallet(4), Calendar(3), Payout(3), Identity(2), Lifecycle(2), Agent(8), OLX(5), Errors(1) → target additions. Every event carries: trace_id, user_id, app_name, app_version, service_name. Batched via Q_ANALYTICS.

**13 dashboards:** System Health, Auth, User Journey, Messaging, AI/Brain, Mobile Stability, Cross-App, Wallet, Payout, Verification, Calendar, Agent, OLX.

---

## 22. Privacy Non-Negotiables

nsec never leaves device / never logged; npub safe to log; no Session Replay; DM content never to analytics/logging/server; brain stores derived facts only, toggle ON by default, user can see+delete all; calls never recorded without consent; payments via Stripe Elements only; PII in Clerk only; verification video permanent in locked R2 until deletion, never public; PostHog carries no message content; wallet descriptions no PII; deletion cascade wipes all 15 stores after 30-day grace; agent personas user-controlled + transparent; agent has no DM/full-brain/cross-persona access; agent can't spend without confirmation; agent audio in separate R2 bucket; **inbound agent text treated as untrusted.**

---

## 23. Real-Time Pipeline

1:1 call → WebRTC P2P/NIP-100; group ≤5 → CF Calls SFU/CallRoom DO; live → CF Stream Live; wallet balance → WalletDO WebSocket; stream gifts → StreamSessionDO (5s batches); agent conversations → ConversationDO async + push; agent TTS → on-demand via Q_AGENT.

---

## 24. Cost Model (10M users)

Levers: Workers-AI moderation (cut 60-80% by CSAM gate + cheap classifier + dedupe + pHash); D1 rows_read (indexes/FTS5/replicas); R2 (cache rules); DOs (hibernation ≈ 0 for inactive); Bunny $0.005/GB; Stripe 2.9%+$0.30; Wise ~$1-2/India transfer; AWS Rekognition $0.025/call after free tier (one-time/user); **agent TTS on-demand (~10% of conversations listened); agent inference ~15 Gemma calls/conversation × 4B active, capped by per-user neuron budget.** Free tiers: D1 25B reads, Workers AI 10K neurons/day, R2 10GB, Workers 10M req, PostHog 1M events, AE 10M points, Rekognition 5K/mo (12mo).

---

## 25. Nostr Protocol

Kinds: 0 profile, 1 note, 3 follows, 6 repost, 7 reaction, 14 DM(inner), 1059 gift-wrap, 10002 relay list, 10050 inbox list, 10063 blossom list, 20 picture, 25050 WebRTC, 30023 long-form, 30311 live activity, 1311 live chat, 34235 video, 34236 short video. NIPs: 01,02,05,10,17,19,25,42,44,49,53,59,65,68,71,100. No NIP-04.

---

## 26. Phased Build Plan (AUTHORITATIVE — build in this order)

> **How to read this:** build **one phase at a time, top to bottom.** Do not start a
> phase until its **Gate** passes. Each phase lists exactly **what to create** and
> **how**. Treat every box's **Verify** + **Done-when** as the exit test. The global
> rules in §27 apply to every phase. Never bind to §3.B resources you haven't created.

### Global build rules (apply to every phase)
- **One Worker, route-based dispatch.** Add routes to `avatok-api`; new queue handling to `avatok-consumers`. Don't spawn a Worker per app.
- **Every new mutation route:** `requireAuth()` (NIP-98 + Clerk) first; Tier-2 routes also `requireVerified()`. Identity comes from the signature, never the body.
- **Every D1 change is a migration file** in `worker/migrations/*.sql`, applied with `wrangler d1 execute <db> --remote --file=...`. Index every hot query. Chunk IN-lists ≤90 params.
- **Every new resource** (D1/queue/DO/R2) is declared in the relevant `wrangler.toml`, then `wrangler deploy --dry-run` must pass before real deploy.
- **Every consequential code path emits:** a PostHog event (via Q_ANALYTICS) + an Analytics Engine data point + a brain hook where the spec says so.
- **Verify with a real signed request** (NIP-98) via curl/Node before marking done, then clean up test rows. Typecheck (`tsc --noEmit`) + `dry-run` + deploy + smoke test, in that order.

---

### PHASE 0 — Pre-build verification & cleanup (GATE for everything)

**Goal:** remove unknowns and dead infra before writing feature code.
**Gate:** none (start here).

**What to do & how:**
1. **Probe Gemma 4 tool-calling.** `POST /accounts/{acct}/ai/run/@cf/google/gemma-4-26b-a4b-it` with a `tools` array; confirm it returns structured `tool_calls`. If not, record the fallback: structured-JSON-output via a tool-selection prompt. (Blocks Phase 7.)
2. **Probe Aura-2 voices.** Run `@cf/deepgram/aura-2-en` with `{ text, speaker }`; confirm the param name and capture the real list of valid voice IDs. (Blocks the voice-picker in Phase 8.)
3. **Prove AWS SigV4 in a Worker.** Write a tiny signer (or vet a lightweight lib) and make one signed Rekognition call (`CreateFaceLivenessSession`). (Blocks Phase 1.)
4. **Decide the AvaID Flutter bridge** (native Amplify channel vs WebView). Document the choice. (Blocks Phase 1 client.)
5. **Decommission dead infra:** delete the **71 `spitube-channel-*` Stream live inputs** (not ours), and the **avaglobal/avablobal** RealtimeKit apps. Verify with `stream/live_inputs` returning 0 of ours.
6. **Secrets + token:** set BREVO/TURN_KEY/BUNNY secrets; run `secrets/deploy.sh`; **rotate the CF API token** (it appeared in chat logs) and update `secrets/cf_token`.
7. **Kick off legal** review for AvaCoins/payout (§10.1/§10.3) — runs in parallel; it gates Phase 2's money-on and Phase 4 production.

**Verify:** each probe has a recorded yes/no + schema note; `stream/live_inputs` shows our inputs only; dry-run of all three Workers still passes.
**Done-when:** all four probes answered, dead infra gone, secrets set, token rotated, legal engaged.

---

### PHASE 1 — AvaID (verification + tier gate + delete cascade)

**Goal:** unlock Tier-2 gating (every social app depends on it) and the deletion cascade.
**Gate:** Phase 0 items 3 & 4.

**Create:**
- DB_META tables: `verification_status`, `verification_attempts`, `deletion_requests` (migration).
- R2: reuse `avatok-verification` (locked) for selfie videos.
- New queue `account-deletions`; consumer in `avatok-consumers`.
- `avatok-api` routes: `POST /api/id/session` (start Rekognition liveness), `POST /api/id/result` (fetch+store result, set tier), `GET /api/id/status`; `requireVerified()` middleware (KV `verified:{npub}`, 1h TTL); `POST /api/account/delete` enqueues `account-deletions`.

**How:** Worker calls Rekognition via SigV4 (Phase 0.3); confidence ≥90% → `verification_status='verified'` + KV cache + brain hook ("verified June 5"); <90% → reject (cap 3/24h). Delete consumer runs the 15-store cascade (§10.5), collecting keys before row deletes.

**Verify:** signed `/api/id/session`→`/api/id/result` flow flips tier; a Tier-2 route 403s until verified; a test account delete wipes all stores (check each).
**Done-when:** verified accounts pass `requireVerified()`; delete cascade green on a throwaway account.

---

### PHASE 2 — AvaWallet (WalletDO, StreamSessionDO, Stripe, spend/earn)

**Goal:** the money layer that AvaOLX, AvaLive gifting, and agent negotiation depend on.
**Gate:** Phase 1. **Production money-on gated by legal (Phase 0.7).**

**Create:**
- D1 `avatok-wallet` (`DB_WALLET`) + tables: wallet_balances, wallet_transactions, topup_records, earning_holds, commission_rates (migration).
- DOs `WalletDO` + `StreamSessionDO` (wrangler **migration tag v3**).
- Queue `wallet-transactions` (DO → D1 audit) + consumer.
- `avatok-api` routes: `POST /api/wallet/topup` (Stripe Checkout), `POST /webhooks/stripe` (credit on payment), `POST /api/wallet/spend`, `GET /api/wallet/balance|transactions|earnings`, `WS /api/wallet/live`.
- Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.

**How:** all balance math is atomic inside WalletDO SQLite; D1 is the async audit trail via Q_WALLET. Spend debits buyer, credits creator minus commission, opens a 7-day hold; cron (6h) releases matured holds. StreamSessionDO aggregates gifts and settles to creator WalletDO every 5s. Brain hook on spend/earn. **Keep top-up disabled in prod until legal clears** (flag-gate it).

**Verify:** Stripe test-mode top-up credits the balance via webhook; spend moves coins and opens a hold; hold releases on cron; WebSocket pushes balance.
**Done-when:** end-to-end top-up→spend→earn→hold-release works in Stripe test mode; prod money-on remains flag-off pending legal.

---

### PHASE 3 — AvaCalendar (slots, bookings, reminders)

**Goal:** scheduling for consultations + the agent's calendar coordination.
**Gate:** Phase 2 (paid bookings need the wallet).

**Create:** DB_META `calendar_slots`, `calendar_events` (migration); `avatok-api` routes (CRUD slots, `POST /api/calendar/book`, `POST /api/calendar/cancel`, `GET /api/calendar/events`); cron reminders at 30m + 1h (dispatch to Q_PUSH).
**How:** booking debits wallet if paid (Phase 2), writes mirrored events for host + attendee, pushes both, brain hook. Conflict-check before commit.
**Verify:** book a paid slot → wallet debit + two events + push; reminder fires.
**Done-when:** host and attendee see the same booking; reminders deliver.

---

### PHASE 4 — AvaPayout (Wise withdrawals)

**Goal:** creators cash out earnings.
**Gate:** Phase 2 + **legal clearance (BLOCKING).**

**Create:** DB_WALLET `payout_accounts`, `payout_requests` (migration); routes `POST /api/payout/setup`, `GET /api/payout/accounts`, `POST /api/payout/request`, `GET /api/payout/status`, `POST /webhooks/wise`; secrets WISE_API_KEY, WISE_PROFILE_ID.
**How:** min 1,000 coins, withdrawable only after 7-day hold; Wise recipient → quote → transfer → fund → webhook → push + brain hook. **Do not enable production transfers until counsel approves.**
**Verify:** Wise sandbox transfer completes; status route + webhook update correctly.
**Done-when:** sandbox payout round-trips; prod gated off pending legal.

---

### PHASE 5 — AvaOLX (marketplace)

**Goal:** classifieds + digital marketplace (and the surface for agent negotiation).
**Gate:** Phase 2 (digital sales use the wallet).

**Create:** DB_MEDIA `olx_listings`, `olx_digital_products`, `olx_purchases` (migration); routes per §10.6 (`POST/GET/PUT/DELETE /api/olx/listings*`, `POST /api/olx/buy`, `GET /api/olx/downloads`, `GET /api/olx/downloads/:id/file` → signed R2 URL).
**How:** physical = free, contact via AvaChat, no money. Digital = `requireVerified()` to list; buy → wallet spend (15% commission) → unlock download via time-limited signed R2 URL; 24h refund if not downloaded. Auto-generate the 2-page listing from simple input.
**Verify:** create digital listing → buy with test wallet → download URL works once → refund path.
**Done-when:** both listing types work; digital purchase + signed download verified.

---

### PHASE 6 — Platform wiring

**Goal:** make the platform apps observable + brain-aware.
**Gate:** Phases 1-5.
**Create/Do:** add the wallet/calendar/payout/identity/lifecycle PostHog events (moves the count from 29 toward ~55); add brain hooks (§7 table); build the matching dashboards (8-11).
**Verify:** events land in PostHog with all 5 required fields; brain learns platform facts.
**Done-when:** platform events + dashboards live; brain reflects platform activity.

---

### PHASE 7 — Agentic infrastructure

**Goal:** agent-to-agent conversations + per-app personas.
**Gate:** Phase 0.1 (tool-calling probe) + Phase 6.

**Create:** DB_META `agent_personas`, `agent_conversations`, `agent_inbox` (migration); DOs `AgentDO` + `ConversationDO` (wrangler **migration tag v4**); queue `agent-tasks` + consumer; routes `/api/agent/*` (§7). 
**How:** matching pre-check (Gemma 4), ConversationDO turn loop with **llama-guard on every message** + untrusted-inbound handling, natural-conclusion check, summaries, persona moderation on save, rate-limit 5/app/day in AgentDO, per-user neuron-budget circuit-breaker. **No consequential action auto-commits** — always an inbox item (1h undo); **no coin spend without tap-to-confirm.**
**Verify:** two test personas match → a bounded conversation generates → summaries written → unsafe content regenerates → rate limit + neuron budget trip correctly.
**Done-when:** a full agent conversation completes safely with summaries and inbox items, guardrails proven.

---

### PHASE 8 — Agent Inbox + lazy TTS + per-app agent hooks

**Goal:** the user-facing agent surface + voice.
**Gate:** Phase 7 + Phase 0.2 (voice probe).
**Create:** AvaBrain 5th screen (Agent Inbox UI); lazy TTS pipeline (on tap → Aura-2 per message → stitch → cache in R2 `avatok-agent-audio`); agent hooks per app (dating, LinkedIn, OLX, calendar, chat, live, content).
**How:** TTS synthesized only on "Listen," cached for both parties; inbox shows transcript + summary + actions (Connect/Dismiss/Undo).
**Verify:** tap Listen synthesizes once and caches; second open reuses audio; each app's hook initiates the right scoped agent flow.
**Done-when:** inbox usable end-to-end; audio lazy + cached; agent events in PostHog.

---

### PHASE 9 — Social apps (Flutter)

**Goal:** the actual products on the proven backend.
**Gate:** Phases 1-8 (each app uses the relevant pieces).
**Do:** AvaBrain standalone app (5 screens); **AvaChat/AvaTok rename refactor** (messaging→AvaChat, AvaTok→1:1 video); then AvaTweet, AvaBook, AvaGram, AvaLinked, AvaTube, AvaLive (create its OWN Stream live inputs on demand), AvaDate, AvaMatri (agent-powered), AvaOLX. Brain hook + agent hook in every app.
**Verify:** per app — CI builds the APK, on-device smoke test of the core flow.
**Done-when:** each app ships an APK that passes its smoke test.

---

### PHASE 10 — Marketing site
**Goal:** public landing + downloads. **Gate:** none (parallelizable).
**Do:** React on Cloudflare Pages at `abertalk.ai` (brand domain only; no backend). Download links, FAQ, legal.

---

## 27. Rules for AI Builders

1. Flutter is the app; React = marketing only. 2. Cloudflare is the backend (exception: AWS Rekognition). 3. Gemma 4 default; llama-guard moderation; bge-small embeddings; Aura-2 TTS; Nova-3 STT. 4. E2E sacred — server never sees DM plaintext. 5. Dual auth on every mutation. 6. Bytes never through Workers except moderation. 7. No full-table scans. 8. D1 param limit 100, chunk ≤90. 9. Brain toggle ON by default. 10. Three observability systems, never mixed. 11. Every PostHog event carries trace_id, user_id, app_name, app_version, service_name. 12. Never log nsec/JWT/phone/email/DM/payment/verification. 13. Brain hook in every app. 14. Tier 2 requires `requireVerified()`. 15. Wallet ops atomic through WalletDO. 16. AvaCoins = credits in UI language. 17. 7-day earnings hold. 18. Free-form top-up 100-50,000. 19. Delete cascade non-negotiable (15 stores). 20. Use specialists for specialist problems. 21. Personas per-app isolated. 22. Agent can't spend without explicit confirmation. 23. Every agent message safety-checked. 24. **Agent TTS is lazy** (synthesize on "Listen"). 25. Max 5 agent conversations/app/day. 26. Agent Inbox is the single agent surface. 27. All consequential agent actions produce an inbox item (auto_approve → 1h undo). 28. **Inbound agent text is UNTRUSTED** — never inject into system context. 29. Per-user daily neuron budget. 30. Moderation pipeline is layered (CSAM → cheap classifier → Gemma 4); do NOT simplify. 31. §3.A = real, §3.B = planned; don't bind to §3.B unless creating it. 32. All infra hostnames on avatok.ai; never abertalk.ai in configs. 33. DB_MEDIA binding = `avatok-media-meta`. 34. Real queue names: `moderation`, `push-notifications`, `email`, `analytics`, `brain-events`; new queues `wallet-transactions`, `account-deletions`, `agent-tasks`. 35. Build strictly in §26 phase order; pass each Gate before starting a phase.

---

## 28. Secrets Inventory

LIVE: CLERK_JWKS_ENDPOINT, CLERK_ISSUER (all Workers); CLERK_SECRET_KEY, BREVO_API_KEY, POSTHOG_API_KEY (consumers); POSTHOG_PERSONAL_API_KEY, TURN_KEY_API_TOKEN, BUNNY_API_KEY, CLOUDFLARE_CALLS_APP_ID/SECRET (api); APNS_KEY_ID/TEAM_ID (consumers, gated).
PLANNED (set during their phase): STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Phase 2), WISE_API_KEY + WISE_PROFILE_ID (Phase 4), AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION (Phase 1).

---

## 29. Conflict Analysis (interaction points)

Agent↔Brain: agent reads brain only via per-app persona scope; agent facts scoped `agent:{app}`; brain-off → agent-off; UserBrain DO ≠ AgentDO (same npub key). Agent↔Wallet: view balance, never debit; purchases need inbox approval. Agent↔Calendar: can create events only if auto_approve (undo-able), tagged `source:'agent'`, conflict-checked. Agent↔E2E: zero DM access; agent convos not E2E; takeover → moves to AvaChat E2E. Agent↔Moderation: llama-guard every message + persona-on-save; repeated → pause agent per app. Agent↔Delete: deletes personas/conversations/inbox/agent-audio/AgentDO/ConversationDOs. Agent↔PostHog: distinct events + own trace_ids; neuron budget in AE. OLX↔Wallet: physical none, digital spend/earn −15%, unlock after tx, 24h refund. CSAM↔Upload: gate runs FIRST, fail-closed, first-time hashes URL-gated until scan clears. Naming: DB_MEDIA=`avatok-media-meta`; exact queue names. DO tags: v1 CallRoom (done), v2 UserBrain (done), v3 WalletDO+StreamSessionDO (Phase 2), v4 AgentDO+ConversationDO (Phase 7).

---

## 30. Glossary

npub/nsec (Nostr public/secret key); NIP; Blossom (hash-addressed R2 media); DO (Durable Object); D1 (CF SQLite); Workers AI (CF edge inference); Gemma 4 (MoE 26B/4B, primary AI); Deepgram Aura-2 (TTS) / Nova-3 (STT); AvaCoins (credits, 1=$0.01, not money — pending legal); WalletDO/StreamSessionDO/AgentDO/ConversationDO; Q_BRAIN/Q_WALLET/Q_DELETE/Q_AGENT; UserBrain; AvaBrain (standalone AI app); Agent Persona (per-app personality+boundaries+looking_for); Agent Inbox (central agent hub); Lazy TTS (on-demand audio); CSAM gate (first-stage hash-match, fail-closed); AWS Rekognition (face liveness, the one external AI); Wise (payouts); Tier 1 (Clerk) / Tier 2 (AvaID verified).
