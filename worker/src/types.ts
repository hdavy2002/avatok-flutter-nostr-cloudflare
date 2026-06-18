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

  // Browser Rendering — link previews / OG images
  BROWSER: Fetcher;

  // Durable Object — group call rooms
  CALL_ROOMS: DurableObjectNamespace;
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

  // ---- Ava in-chat AI bindings (Phase 0 — Foundations; part of the bindings
  // contract). The DO CLASSES are implemented by later phases (AvaAgentDO = P3,
  // BackupDO = P10), so the worker will not fully typecheck until those classes
  // are exported from index.ts — expected & accepted (see INTEGRATION-NOTES.md).
  // Durable Object — per-user in-thread Ava agent loop (P3).
  AVA_AGENT: DurableObjectNamespace;
  // Durable Object — per-user backup/sync coordinator (P10).
  BACKUP: DurableObjectNamespace;

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
  FCM_SERVICE_ACCOUNT?: string;
  // Bunny.net Stream (video upload path for AvaTube/AvaGram/AvaLive recordings)
  BUNNY_API_KEY?: string;
  BUNNY_LIBRARY_ID?: string;
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

  // Cloudflare AI Gateway (2026-06-18). When set, all Workers-AI + Google image
  // calls route through this gateway for cost logging, caching, and a hard spend
  // cap. AI_GATEWAY_ID = the gateway name/id; AI_GATEWAY_TOKEN = optional
  // cf-aig-authorization for authenticated gateways (Google image path).
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;   // cf-aig-authorization (authed gateway) — secret
  CF_ACCOUNT_ID?: string;      // for the gateway.ai.cloudflare.com base URL

  // Live voice translation (Gemini 3.5 Live Translate). Unset → /api/translate/*
  // returns 503. The key never leaves the Worker — clients get ephemeral tokens.
  // Also powers the AvaAffiliate v2 marketing-asset kit (Nano Banana 2 images).
  GEMINI_API_KEY?: string;

  // App-store links on the /a/:linkId web preview (AvaAffiliate). Android-only
  // launch: APP_STORE_ID stays UNSET until a real App Store listing exists —
  // unset/empty ⇒ the App Store badge is not rendered at all. PLAY_PACKAGE_ID
  // is the Android applicationId (app/android/app/build.gradle.kts).
  APP_STORE_ID?: string;
  PLAY_PACKAGE_ID?: string;

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

  // Ava tool layer — Klavis Strata (self-hosted) base URL (P5). Unset/empty ⇒
  // /api/ava/tools/* returns 503 until the self-host origin is configured.
  STRATA_URL?: string;
  // AES-GCM key material for the per-user MCP OAuth token store (P5
  // ava_tool_tokens). Read via (env as any) until now; declared here for type
  // visibility. Falls back to GCAL_TOKEN_KEY, then a dev constant.
  STRATA_TOKEN_KEY?: string;
}
