/** Bindings for the AvaTok API Worker. See wrangler.toml. */
export interface Env {
  // D1 — the database (Golden Rule 1)
  DB_META: D1Database;
  DB_MEDIA: D1Database;
  DB_MODERATION: D1Database;
  DB_BRAIN: D1Database;  // AvaBrain knowledge graph + memory
  DB_WALLET: D1Database; // AvaWallet audit trail (balance authority is WalletDO)

  // R2 — writes only; reads go to blossom.avatok.ai (public bucket)
  BLOBS: R2Bucket;
  VERIFICATION: R2Bucket;
  DIGITAL: R2Bucket;     // avatok-digital — PRIVATE; OLX digital goods (signed reads)
  AGENT_AUDIO: R2Bucket; // avatok-agent-audio — lazy agent-conversation TTS cache
  BACKUP_R2: R2Bucket;   // avatok-backup — Ava premium cross-device sync + gen-image store (P9/P10)

  // KV — ephemeral tokens ONLY (Golden Rule 5)
  TOKENS: KVNamespace;

  // Queues — all async work
  Q_MODERATION: Queue;
  Q_PUSH: Queue;
  Q_EMAIL: Queue;
  Q_ANALYTICS: Queue;
  Q_BRAIN: Queue;
  Q_DELETE: Queue;   // account-deletions (30-day-grace 15-store cascade, Phase 1)
  Q_WALLET: Queue;   // wallet-transactions (DO → D1 audit trail, Phase 2)
  Q_AGENT: Queue;    // agent-tasks (agent conversations + per-app hooks, Phase 7)
  Q_MONEY: Queue;    // money-settlements (refund/settlement engine, marketplace Phase 7)
  Q_ARCHIVE?: Queue; // chat-archive (Phase 1 ABLY-R2: message body → R2 + D1 index)
  Q_MKT_AUDIO?: Queue; // marketplace negotiation VOICE render (async → avatok-consumers)
  Q_AUTO_REPLY?: Queue; // STREAM F auto-responder job (incoming DM → away auto-reply, async → avatok-consumers)

  // Workers AI — image moderation (public uploads)
  AI: Ai;

  // AI Search (managed RAG) namespace binding — premium memory & file search.
  // Per-user instances created at runtime (get/create); typed loosely (the
  // platform types vary by runtime version). See routes/ava_rag.ts.
  AI_SEARCH: any;

  // Analytics Engine — operational metrics (writeDataPoint)
  ANALYTICS: AnalyticsEngineDataset;

  // Vectorize — semantic search (populated Phase 4)
  VECTOR_INDEX: VectorizeIndex;

  // Durable Object — 1:1 call signaling rooms
  CALL_ROOMS: DurableObjectNamespace;
  // Durable Object — free-tier P2P mesh group-call signaling rooms (≤5)
  MESH_ROOMS: DurableObjectNamespace;
  // Durable Object — CF Realtime SFU group-AUDIO rooms (≤32, active-speaker).
  // Roster + active-speaker fan-out over hibernatable WS; one per group id.
  // Gated by groupAudioSfuEnabled (dormant until built+CI-verified).
  GROUP_CALL_ROOMS: DurableObjectNamespace;
  // Durable Object — per-user AvaBrain reasoning
  USER_BRAIN: DurableObjectNamespace;
  // Durable Object — per-user atomic coin balance (Phase 2)
  WALLET_DO: DurableObjectNamespace;
  // Durable Object — per-stream gift aggregation (Phase 2)
  STREAM_SESSION_DO: DurableObjectNamespace;
  // Durable Object — per-user agent coordinator (rate-limit + neuron budget, Phase 7)
  AGENT_DO: DurableObjectNamespace;
  // Durable Object — per agent↔agent conversation (turn loop, Phase 7)
  CONVERSATION_DO: DurableObjectNamespace;
  // Durable Object — per-user messaging inbox (Cloudflare-native pivot; Nostr
  // deprecated). Hibernatable WS + DO-local SQLite message log. Keyed by uid.
  INBOX: DurableObjectNamespace;

  // Durable Object — PartyKit realtime layer (ephemeral; replaces Ably). One DO
  // per ROOM (thread:<conv>, listing:<id>, neg:<negId>, user:<uid>, conf:<gid>).
  // Holds the room's hibernatable WebSockets; broadcast-only, no persistence.
  PARTY: DurableObjectNamespace;

  // ---- Ava in-chat AI bindings (Phase 0 — Foundations; part of the bindings
  // contract). The DO CLASSES are implemented by later phases (AvaAgentDO = P3,
  // BackupDO = P10), so the worker will not fully typecheck until those classes
  // are exported from index.ts — expected & accepted (see INTEGRATION-NOTES.md).
  // Durable Object — per-user in-thread Ava agent loop (P3).
  AVA_AGENT: DurableObjectNamespace;
  // Durable Object — per-user backup/sync coordinator (P10).
  BACKUP: DurableObjectNamespace;
  // Durable Object — Ava Receptionist call bridge (one per session id). Relays
  // caller audio ↔ Gemini Live (through AI Gateway) for "Ava answers after 5
  // rings". Specs/PROPOSAL-AI-RECEPTIONIST.md.
  RECEPTION_ROOM: DurableObjectNamespace;
  // Ava Receptionist — Cloudflare-native engine DO (separate from the Gemini
  // bridge above). Workers AI STT→LLM→TTS. Specs/RECEPTIONIST-CF-PIPELINE.md.
  RECEPTION_ROOM_CF: DurableObjectNamespace;

  // vars
  BLOSSOM_BASE_URL: string;
  FCM_PROJECT: string;
  // Comma-separated Clerk uids allowed to PUT /api/admin/config (Phase 1, A2).
  ADMIN_UIDS?: string;
  BRAIN_REASONER_MODEL?: string;
  BRAIN_EMBED_MODEL?: string;
  // Phase 9 — "1" → toggling a guardrail OFF also retro-deletes already-indexed
  // items from that source (vectors, transcripts, derived facts).
  BRAIN_RETRO_DELETE?: string;
  POSTHOG_QUERY_HOST?: string;
  POSTHOG_PROJECT_ID?: string;

  // secret — investigate() reads PostHog (personal key; gated)
  POSTHOG_PERSONAL_API_KEY?: string;

  // secrets (wrangler secret put)
  CLERK_JWKS_URL?: string;
  CLERK_ISSUER?: string;
  // AvaApps (PREMIUM) — Composio tool-calling for the user's Google apps
  // (Gmail/Docs/Sheets/Drive/Calendar). Unset → AvaApps routes return 503.
  COMPOSIO_API_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  // Cloudflare Realtime SFU (group AUDIO). App id + bearer token for the
  // rtc.live.cloudflare.com sessions/tracks API. Unset → /api/groupcall/* 503s,
  // so the new path is a safe no-op until these are set.
  CF_RT_SFU_APP_ID?: string;
  CF_RT_SFU_APP_TOKEN?: string;
  FCM_SERVICE_ACCOUNT?: string;
  // Cloudflare Stream webhook HMAC secret (AvaLive). Gated.
  STREAM_WEBHOOK_SECRET?: string;

  // AvaID — AWS Rekognition Face Liveness (Phase 1). Flag-gated: unset → 503.
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION?: string;

  // Clerk Backend API (account deletion cascade, Phase 1). Gated.
  CLERK_SECRET_KEY?: string;

  // Store-review login bypass (routes/review.ts). When set, the allowlisted
  // reviewer account signs in with email+password and NO email OTP. Unset →
  // the route returns 404 and the bypass is fully disabled.
  REVIEW_PASSWORD?: string;

  // Phase 5 — AvaCalendar/AvaBooking. Google Calendar OAuth (gated; unset →
  // /api/calendar/gcal/* returns 503), token-encryption key, join-link signer.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GCAL_TOKEN_KEY?: string;         // AES-GCM key material for gcal refresh tokens
  JOIN_LINK_SECRET?: string;       // HMAC for https://avatok.ai/j/<token>

  // Progressive Identity ladder (PROPOSAL-PROGRESSIVE-IDENTITY.md).
  GUEST_TOKEN_SECRET?: string;     // HMAC for L0 guest tokens (falls back to JOIN_LINK_SECRET)
  TWILIO_ACCOUNT_SID?: string;     // Twilio Lookup v2 — SIM-only phone enforcement
  TWILIO_AUTH_TOKEN?: string;      // (unset → line-type check skipped; KV denylist still applies)

  // AvaStorage (universal per-account pool). Free quota in GB (default 5);
  // over-quota metered price in AvaCoins per GB per month (default 20 — billed
  // by the consumers monthly cron, ledger type storage_charge).
  STORAGE_FREE_GB?: string;
  STORAGE_COINS_PER_GB?: string;

  // Messaging KYC gate. "1" enforces verified KYC on /api/msg/send; default OFF
  // (Stripe Identity paused) so 1:1 chat works without verification for now.
  KYC_REQUIRED?: string;
  // Stripe Identity (KYC). Gated; unset → /api/kyc/* returns 503.
  STRIPE_IDENTITY_WEBHOOK_SECRET?: string;
  // A1 compliance — current agreement-doc versions, CSV "doc_id:version,…"
  // (e.g. "creator-agreement:2,tos:1"). Unlisted docs default to "1".
  AGREEMENT_VERSIONS?: string;

  // AvaWallet (Phase 2). Real money-in flag-gated OFF pending legal (§10.1).
  WALLET_TOPUP_ENABLED?: string;   // "1" enables Stripe top-up (set ONLY after legal)
  WALLET_RETURN_URL?: string;      // Checkout success/cancel return base
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PUBLISHABLE_KEY?: string; // public pk_test/pk_live — returned to the app for the in-app PaymentSheet

  // AvaPayout (Phase 4). Production transfers flag-gated OFF pending legal (§10.3).
  PAYOUT_ENABLED?: string;         // "1" enables Wise transfers (ONLY after legal)
  WISE_API_KEY?: string;
  WISE_PROFILE_ID?: string;
  WISE_ENV?: string;               // "production" | (default sandbox)

  // AvaTalk group conferencing (Phase 10 — LiveKit, ≤25 participants). Gated:
  // unset → /api/conference/* returns 503. LIVEKIT_URL = project URL
  // (wss://<project>.livekit.cloud); key/secret via `wrangler secret put`.
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  // Self-hosted multi-region SFU (Specs/AVA-SFU-SELFHOST-PLAYBOOK.md). A single
  // JSON secret mapping region key → creds, e.g.
  //   {"eu":{"url":"wss://eu.sfu.avatok.ai","key":"…","secret":"…"},
  //    "us":{…},"ap":{…},"cloud":{…}}
  // When unset/empty the worker synthesizes a single `cloud` region from the
  // legacy LIVEKIT_URL/API_KEY/API_SECRET above (so nothing changes until you
  // populate it). Adding a region = edit this one secret. `cloud` is always the
  // default + fallback. Set via `wrangler secret put LIVEKIT_REGIONS`.
  LIVEKIT_REGIONS?: string;

  // R2-archive rollout flag (Specs/ABLY-TRANSPORT-R2-ARCHIVE-PROPOSAL.md).
  CHAT_ARCHIVE?: string;     // "1" → enqueue every sent message to R2 + D1 message_index (Phase 1)
  CHAT_ARCHIVE_V2?: string;  // "1" → InboxDO batched R2 jsonl cold archive (P8 chatArchiveV2)
  PARTY_ENABLED?: string;    // "1" → PartyKit realtime layer on (client opens party sockets); dark otherwise
  MSG_STATE_STORE?: string;  // "d1" → owner-private state (read/hide/call-log) reads+writes go to D1 (Phase 5)

  // Account key-escrow master (SECRET: `wrangler secret put KEY_WRAP_MASTER`). Wraps
  // each account's aek in key_backup so a D1 dump alone never exposes a usable key.
  KEY_WRAP_MASTER?: string;

  // Cloudflare AI Gateway (2026-06-18). When set, all Workers-AI + Google image
  // calls route through this gateway for cost logging, caching, and a hard spend
  // cap. AI_GATEWAY_ID = the gateway name/id; AI_GATEWAY_TOKEN = optional
  // cf-aig-authorization for authenticated gateways (Google image path).
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;   // cf-aig-authorization (authed gateway) — secret
  CF_ACCOUNT_ID?: string;      // for the gateway.ai.cloudflare.com base URL

  // OpenRouter — content-safety moderation (nvidia/nemotron-3.5-content-safety:free)
  // and the GenUI planner. Secret; set in secrets/secret-values.env.
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MOD_MODEL?: string;        // override the field-moderation model id (Nemotron)
  OPENROUTER_SECURITY_MODEL?: string;   // override the shield/guardian model id (Claude Opus 4.8)
  OPENROUTER_STT_MODEL?: string;        // override the speech-to-text model id (default openai/whisper-large-v3)

  // InboxDO retention (cost control). Days to keep messages in the per-user inbox
  // DO before pruning (the device keeps history locally + in Drive/R2 backup, so
  // the DO is a relay + offline buffer, not a permanent archive). UNSET/0 =
  // disabled (keep forever). Enable (e.g. "90") ONLY after confirming backups run.
  INBOX_RETENTION_DAYS?: string;

  // Live voice translation (Gemini 3.5 Live Translate). Unset → /api/translate/*
  // returns 503. The key never leaves the Worker — clients get ephemeral tokens.
  // Also powers the AvaAffiliate v2 marketing-asset kit (Nano Banana 2 images).
  GEMINI_API_KEY?: string;

  // Dedicated Gemini key for the AI Receptionist Live (speech-to-speech) calls +
  // its summary call, so receptionist spend is isolated to its own Google Cloud
  // project (avatok-live-receptionist-2026, project #7456307191, owner
  // hdavy2005@gmail.com). Falls back to GEMINI_API_KEY when unset. The key never
  // leaves the Worker (the caller only gets a DO WebSocket URL).
  RECEPTIONIST_GEMINI_API_KEY?: string;

  // GenUI global template cache (Upstash Redis REST). URL is a [var]; TOKEN is a
  // secret. Absent → cache no-ops (compose every time; nothing breaks).
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  // GenUI kill-switch: "1" disables generative in-chat UI for everyone (else ON
  // for premium users with a connected app).
  GENUI_OFF?: string;

  // Ava Receptionist — override the Gemini Live model.
  // Defaults to gemini-3.1-flash-live-preview (verified on the Developer API).
  RECEPTIONIST_MODEL?: string;

  // App-store links on the /a/:linkId web preview (AvaAffiliate). Android-only
  // launch: APP_STORE_ID stays UNSET until a real App Store listing exists —
  // unset/empty ⇒ the App Store badge is not rendered at all. PLAY_PACKAGE_ID
  // is the Android applicationId (app/android/app/build.gradle.kts).
  APP_STORE_ID?: string;
  PLAY_PACKAGE_ID?: string;

  // Google Play Billing — server-side purchase-token verification (routes/
  // subscribe.ts → play.ts). PLAY_SERVICE_ACCOUNT_JSON is the full service-account
  // key JSON (secret). Unset → /api/subscribe/android/verify fails CLOSED (503,
  // reason:"play_unconfigured") so a forged token can never grant a tier. The
  // package the token is checked against is PLAY_PACKAGE_ID (above).
  PLAY_SERVICE_ACCOUNT_JSON?: string;

  // R2 S3 API creds for presigned digital-download URLs (Phase 5). Unset → the
  // OLX download route streams bytes through the Worker as a fallback.
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // Marketplace Phase 7 — AvaLive (Cloudflare Stream Live) + AvaConsult group
  // (Cloudflare Realtime SFU). All gated: unset → 503.
  STREAM_ACCOUNT_ID?: string;      // Cloudflare account id for Stream Live Inputs
  STREAM_API_TOKEN?: string;       // API token with Stream:Edit (secret)
  CALLS_APP_ID?: string;           // Cloudflare Realtime (Calls) SFU app
  CALLS_APP_SECRET?: string;       // (secret)
  // Refund-engine test clock (A2). TEST_CLOCK_ALLOWED="1" ONLY in staging vars;
  // production hard-refuses any offset.
  TEST_CLOCK_ALLOWED?: string;
  TEST_CLOCK_OFFSET_MS?: string;
  // DLQ alert recipient (defaults to hdavy2005@gmail.com).
  ALERT_EMAIL?: string;
}
