/** Bindings for the AvaTok API Worker. See wrangler.toml. */
export interface Env {
  // D1 — the database (Golden Rule 1)
  DB_META: D1Database;
  DB_MEDIA: D1Database;
  DB_MODERATION: D1Database;
  DB_RELAY: D1Database;  // read-only here (/backup export)
  DB_BRAIN: D1Database;  // AvaBrain knowledge graph + memory
  DB_WALLET: D1Database; // AvaWallet audit trail (balance authority is WalletDO)

  // R2 — writes only; reads go to blossom.avatok.ai (public bucket)
  BLOBS: R2Bucket;
  VERIFICATION: R2Bucket;

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

  // Workers AI — image moderation (public uploads)
  AI: Ai;

  // Analytics Engine — operational metrics (writeDataPoint)
  ANALYTICS: AnalyticsEngineDataset;

  // Vectorize — semantic search (populated Phase 4)
  VECTOR_INDEX: VectorizeIndex;

  // Browser Rendering — link previews / OG images
  BROWSER: Fetcher;

  // Worker→Worker (free). Enabled in Phase 3 when the relay deploys.
  RELAY_SVC?: Fetcher;

  // Durable Object — group call rooms
  CALL_ROOMS: DurableObjectNamespace;
  // Durable Object — per-user AvaBrain reasoning
  USER_BRAIN: DurableObjectNamespace;
  // Durable Object — per-user atomic coin balance (Phase 2)
  WALLET_DO: DurableObjectNamespace;
  // Durable Object — per-stream gift aggregation (Phase 2)
  STREAM_SESSION_DO: DurableObjectNamespace;
  // Cross-script — relay's per-user inbox DO (realtime in-app notifications)
  RELAY: DurableObjectNamespace;

  // vars
  BLOSSOM_BASE_URL: string;
  FCM_PROJECT: string;
  BRAIN_REASONER_MODEL?: string;
  BRAIN_EMBED_MODEL?: string;
  POSTHOG_QUERY_HOST?: string;
  POSTHOG_PROJECT_ID?: string;

  // secret — investigate() reads PostHog (personal key; gated)
  POSTHOG_PERSONAL_API_KEY?: string;

  // secrets (wrangler secret put)
  CLERK_JWKS_URL?: string;
  CLERK_ISSUER?: string;
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
}
