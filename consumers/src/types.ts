export interface Env {
  DB_META: D1Database;
  DB_MEDIA: D1Database;
  DB_MODERATION: D1Database;
  DB_BRAIN: D1Database;               // AvaBrain knowledge graph + memory
  DB_RELAY?: D1Database;              // nostr_events + nostr_tags (delete cascade)
  DB_WALLET?: D1Database;             // wallet (delete cascade; Phase 2)
  BLOBS: R2Bucket;
  VERIFICATION?: R2Bucket;            // locked selfie videos (delete cascade)
  DIGITAL?: R2Bucket;                 // OLX digital goods (delete cascade; Phase 5)
  AGENT_AUDIO?: R2Bucket;             // agent TTS cache (delete cascade; Phase 8)
  TOKENS: KVNamespace;
  AI: Ai;
  Q_PUSH?: Queue;                     // calendar reminders re-enqueue to push (Phase 3)
  Q_ANALYTICS?: Queue;                // lifecycle events (e.g. account_deleted) → PostHog
  CONVERSATION_DO?: DurableObjectNamespace; // cross-script → avatok-api ConversationDO (Phase 7)
  VECTOR_INDEX?: VectorizeIndex;      // semantic memory (brain embeddings)
  ANALYTICS?: AnalyticsEngineDataset; // operational metrics (writeDataPoint)
  FCM_PROJECT: string;
  BRAIN_EXTRACT_MODEL?: string;
  BRAIN_EMBED_MODEL?: string;
  BRAIN_VISION_MODEL?: string;     // Gemma 4 multimodal — image caption/OCR/doc/chart/UI
  MODERATION_MODEL: string;        // image moderation model
  MODERATION_MODEL_TYPE?: string;  // "vision" (LLM, parse text) | "classifier" (label+score)
  TEXT_MODERATION_MODEL?: string;  // text safety classifier (Llama Guard default)
  POSTHOG_HOST: string;
  // secrets
  FCM_SERVICE_ACCOUNT?: string;
  BREVO_API_KEY?: string;        // transactional email (replaces Resend)
  POSTHOG_API_KEY?: string;
  // APNs (iOS push) — gated; if unset, APNs tokens are skipped (Android-first).
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;     // p8 PEM contents
  APNS_BUNDLE_ID?: string;       // app bundle id (apns-topic); defaults below
  APNS_PRODUCTION?: string;      // "1" → api.push.apple.com, else sandbox
  // Cheap NSFW first-pass classifier (external; Sightengine/Hive/self-hosted).
  // Unset → all image scans go straight to Gemma 4. Set → classifier first,
  // Gemma only for the ambiguous middle band.
  NSFW_API_URL?: string;
  NSFW_API_KEY?: string;
  // CSAM hash-match gate (PhotoDNA / Thorn Safer / NCMEC). Unset → bypassed.
  // Set → runs before AI; fail-closed on error. See csam.ts.
  CSAM_API_URL?: string;
  CSAM_API_KEY?: string;
  CSAM_REPORT_URL?: string;      // where confirmed-CSAM reports are POSTed (NCMEC-filing service)
  CSAM_REPORT_KEY?: string;
  // Bunny.net Stream (delete cascade removes a user's video collection).
  BUNNY_API_KEY?: string;
  BUNNY_LIBRARY_ID?: string;
  // Clerk Backend API (delete cascade removes the Clerk user). Gated.
  CLERK_SECRET_KEY?: string;
  // PostHog person deletion (delete cascade; uses personal key). Gated.
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
  // Stripe customer deletion (delete cascade; Phase 2). Gated.
  STRIPE_SECRET_KEY?: string;
}

// Account-deletion cascade message (producer: avatok-api /api/account/delete).
export interface DeletionMsg { npub: string; clerk_user_id?: string | null; scheduled_at?: number; pubkey_hex?: string; }

// Agent task message (producer: avatok-api /api/agent/*). 'converse' runs a
// ConversationDO turn loop; 'task' is a per-app hook (Phase 8).
export interface AgentMsg { type: "converse" | "task"; conversation_id?: string; npub: string; app: string; peer_npub?: string; kind?: string; payload?: Record<string, unknown>; }

// Wallet audit message (producer: WalletDO). Writes the D1 ledger + mirrors.
export interface WalletTxMsg {
  npub: string; id: string; ts?: number;
  type: "topup" | "spend" | "earn" | "hold_release" | "refund" | "gift" | "payout";
  amount: number; balance_after?: number; app_name?: string;
  counterparty_npub?: string | null; commission?: number; ref?: string | null; hold_until?: number;
}

// Queue message shapes (producers: avatok-api, avatok-relay)
// type: "image" (R2 blob scan) | "stream_recording" (Cloudflare Stream recording,
// scan is a follow-up — handler no-ops gracefully when hash is empty).
export interface ModerationMsg { type: "image" | "stream_recording"; hash: string; npub: string; media_id: string; r2_key: string; uid?: string; }
export interface PushMsg {
  kind: "call" | "notify" | "call-status" | "relay-event";
  to?: string; to_npub?: string | null; from?: string; from_pubkey?: string;
  callType?: string; room?: string | null; status?: string;
  fromName?: string; callId?: string;
  title?: string | null; body?: string | null; data?: Record<string, unknown> | null;
  event_kind?: number; event_id?: string; ts?: number;
}
export interface EmailMsg { to: string; subject: string; html: string; from?: string; }
export interface AnalyticsMsg { event: string; npub?: string; props?: Record<string, unknown>; ts?: number; }
// AvaBrain: PUBLIC content only (server never gets DM plaintext). payload is JSON.
export interface BrainMsg { npub: string; event_type: string; source_app: string; payload: Record<string, unknown>; traceId?: string; ts?: number; }
