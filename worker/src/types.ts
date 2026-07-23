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
  // [LIVE-QUEUE-1] liveness-verify — SELF-consumed by avatok-api (see wrangler.toml
  // [[queues.consumers]] for "liveness-verify"). Optional/typed-loose because the
  // queue must be created (`wrangler queues create liveness-verify`) before this
  // binding resolves at deploy time; livenessVerify() falls back to ctx.waitUntil
  // when .send() throws (binding missing or queue not yet created).
  LIVENESS_QUEUE?: Queue;
  // Contact-book chunking (2026-07-14). Optional: the queue is not yet provisioned,
  // so scheduleChunk() falls back to ctx.waitUntil (same pattern as LIVENESS_QUEUE).
  // Bind "contacts-chunk" (producer + self-consumer) once created to move the
  // chunk job off the request lifecycle for very large books at 1M-user scale.
  Q_CONTACTS?: Queue;

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

  // Durable Object — per-account call-state control-plane authority (Phase A
  // plumbing only — dormant). Single writer for call/receptionist state
  // (epoch CAS + lease + reservations). Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md.
  // Not read/written by any route yet; gated by authorityShadowEnabled /
  // authorityReadEnabled / authorityWriteEnabled / authorityEnforced (all off).
  CALL_STATE_AUTHORITY: DurableObjectNamespace;

  // Durable Object — Guardian Sentinel per-user HOT CACHE (S1). Velocity windows,
  // last-N event-id dedup ring, per-bucket score cache. NEVER a system of record —
  // rehydrates from D1 (the append-only sentinel_evidence log). Keyed by uid. DARK
  // behind sentinelEnabled. Specs/GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md §S1.
  SENTINEL: DurableObjectNamespace;

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
  // Voicemail bot DO (WP3, plan §7 item 5 / §15.5) — carrier-style "leave a
  // 25s voicemail after the tone" bridge. Forked from RECEPTION_ROOM_CF's
  // Workers AI STT→TTS pipeline but simpler (no dialog loop). One instance
  // per session id. Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md.
  VOICEMAIL_ROOM: DurableObjectNamespace;
  // Ava AI Voice Agent DO (WP4, plan §4/§7 item 7) — one instance per call
  // session id. Bridges the caller's WebRTC audio to a Grok Voice Agent
  // realtime session (RAG via Grok Collections `file_search`, Composio tool
  // calls, booking-authority gated writes). Dark behind `voiceAgent`.
  // Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md.
  AGENT_VOICE_ROOMS: DurableObjectNamespace;
  // Durable Object — [AVA-PSTN-AGENT-1] live Gemini agent on CELL (Vobiz DID)
  // calls via bidirectional media streams. One instance per PSTN agent session
  // (`pstn-<CallUUID>`); speaks the Vobiz JSON frame protocol to the caller and
  // Gemini Live upstream. DARK behind pstnAgentEnabled (routes/config.ts).
  // Specs/PLAN-2026-07-19-vobiz-media-stream-agent.md.
  VOBIZ_AGENT_ROOM: DurableObjectNamespace;
  // [AVA-VM-SELFREC-1] Durable Object — self-recorded PSTN voicemail over a
  // Vobiz bidirectional <Stream> WebSocket (do/voicemail_stream_room.ts),
  // replacing Vobiz's billed <Record> verb. One instance per voicemail session
  // (`pstn-vm-<CallUUID>`); captures caller PCM, encodes MP3 to R2, and delivers
  // the SAME InboxDO voicemail envelope as routes/pstn.ts handleRecordCb. DARK
  // behind pstnVoicemailSelfRecord (routes/config.ts).
  VOICEMAIL_STREAM_ROOM: DurableObjectNamespace;
  // [AVA-CAMP-B1-GATE] Durable Object — per-user outbound-dial admission gate
  // for AI calling campaigns (channel pool + token-bucket rate limit + round-
  // robin fairness across a user's running campaigns). One instance per owner
  // uid. Phase B1 scaffolding — DARK, nothing calls it yet (campaignDialerEnabled
  // defaults false). Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §2, §6.3.
  DIALER_GATE: DurableObjectNamespace;
  // [AVA-CAMP-B2-WIRE] Per-campaign SQLite-backed DO (call_fsm state, pacing).
  CAMPAIGN_DO: DurableObjectNamespace;

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

  // Guardian Sentinel S2 — mem0 managed-cloud behaviour memory (derived cache).
  // `wrangler secret put MEM0_API_KEY` (also note in secrets/secret-values.env).
  // Unset → the mem0 summariser/purge code cleanly no-ops (fail-open). Everything
  // is additionally DARK behind sentinelMem0Enabled. mem0 is NEVER an owner of
  // truth — every memory carries derived_from event ids and regenerates from the
  // append-only sentinel_evidence log. Specs/GUARDIAN-SENTINEL-FINAL-PLAN §S2.
  MEM0_API_KEY?: string;

  // Ava AI Voice Agent (WP4, plan §4) — Grok Voice Agent realtime API +
  // Collections RAG. `wrangler secret put GROK_API_KEY` — set SEPARATELY per
  // environment (staging + prod each get their own x.ai key, plan §15.6 "no
  // staging data ever promotes to prod"). Unset → do/agent_voice_room.ts fails
  // fast at session start (GROK_SESSION_FAIL, refund, voicemail fallback) —
  // the constructor itself never throws, so a bare deploy with no key set is
  // safe as long as `voiceAgent` stays off in KV.
  GROK_API_KEY?: string;
  // x.ai MANAGEMENT API key (separate secret from GROK_API_KEY, separate host
  // management-api.x.ai) — needed for Collections CRUD + document add/remove
  // (lib/grok.ts). Create in the x.ai console with the "AddFileToCollection"
  // + "Collections Endpoint" permissions. `wrangler secret put
  // GROK_MANAGEMENT_KEY`. Unset → collection create/update/delete and
  // document add/remove return {ok:false, reason:"MANAGEMENT_KEY_MISSING"}
  // (never throws) — routes/agent_docs.ts still stores uploads in R2 so
  // owners can upload before the key exists, and reindexes once it's set.
  GROK_MANAGEMENT_KEY?: string;

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
  // [AVADIAL-CALL-INTEL-1] HMAC key for the call-intelligence phone identifier
  // (routes/telemetry_calls.ts). phone_id = HMAC-SHA256(this, E.164), and it is the
  // ONLY form of a caller's number that ever reaches PostHog.
  //
  // MUST stay server-side. The whole reason the Worker does the hashing instead of
  // the dialer is that a key shipped in an APK is not a key — anyone who unpacks the
  // app could hash every number in a range and reverse the ids. Set per environment
  // with `wrangler secret put CALL_ID_HMAC_SECRET`; until it is set, the ingest route
  // returns 503 (fail-loud) and devices keep their buffer and retry.
  CALL_ID_HMAC_SECRET?: string;

  // [AVA-MISSEDCALL-1] HMAC secret for the long-lived device token the missed-call
  // overlay's native receiver uses to look up AvaTOK membership while the app is dead
  // (no Clerk JWT available cold-start). Falls back to JOIN_LINK_SECRET.
  MISSEDCALL_TOKEN_SECRET?: string;

  // Progressive Identity ladder (PROPOSAL-PROGRESSIVE-IDENTITY.md).
  GUEST_TOKEN_SECRET?: string;     // HMAC for L0 guest tokens (falls back to JOIN_LINK_SECRET)
  // [M-D1 2026-07-17 / M-D11 2026-07-18] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN removed.
  // Their only consumer was the Twilio Lookup v2 line-type check inside idPhoneConfirm
  // (routes/id.ts), deleted when phone OTP was removed app-wide. Nothing else in worker/,
  // consumers/ or app/ references Twilio — AvaDial/PSTN uses a different provider
  // (routes/pstn.ts → Vobiz). The Worker SECRETS still exist in the deployed environments
  // and must be unbound separately (ops step). Do NOT reintroduce.

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
  // [TOKENS-FX-1] OPTIONAL Wise token for the FX RATES endpoint (lib/fx_rates.ts).
  // Separate from WISE_API_KEY (payout rail). Unset → free open.er-api.com is used.
  WISE_API_TOKEN?: string;
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
  OPENROUTER_SECURITY_MODEL?: string;   // LEGACY guardian model pin (honored; empty = reasoner ladder)
  OPENROUTER_STT_MODEL?: string;        // override the speech-to-text model id (default openai/whisper-large-v3)

  // AVA CORE Phase 0 (AVA-CORE-1): the ONE reasoner behind avaReason() (lib/ava_reason.ts).
  AVA_REASONER?: string;       // Workers-AI primary (default @cf/google/gemma-4-26b-a4b-it)
  AVA_REASONER_ALT?: string;   // OpenRouter fallback (default google/gemini-2.5-flash-lite)
  GUARDIAN_DEEP_MODEL?: string; // force a specific OpenRouter model for guardian deep pass (optional)

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

  // Cloud Text-to-Speech service-account JSON (project avatok-avaglobal, SA
  // ava-tts@…), used by the CF receptionist engine to voice Ava in Hindi with the
  // natural WaveNet voice (hi-IN-Wavenet-E) via lib/google_tts.ts. Cloud TTS needs
  // an OAuth principal, not an API key — the Worker mints a token from this SA.
  // Absent → cfSpeak() falls back to the Deepgram/melotts path (nothing breaks).
  GOOGLE_TTS_SA_JSON?: string;
  RECEPT_CF_GOOGLE_VOICE?: string;   // override the hi-IN Google voice (default hi-IN-Wavenet-E)

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

  // PSTN voicemail platform (Canonical Architecture v1.0, Specs/PLAN-2026-07-16-
  // ava-receptionist-guardian-FINAL.md). Long random secret Vobiz's webhook URLs
  // carry as a trailing path segment (routes/pstn.ts). Unset → falls back to a
  // fixed probe-grade constant in pstn.ts (fine for the Phase-0 wiring probe;
  // production should set this via `wrangler secret put VOBIZ_WEBHOOK_SECRET`).
  VOBIZ_WEBHOOK_SECRET?: string;
  // [WELCOME-100-1] Shared secret for the one-time welcome-bonus backfill route
  // (`POST /api/admin/welcome-backfill/<secret>` — same trailing-path-segment
  // scheme as VOBIZ_WEBHOOK_SECRET). Fails CLOSED when unset; set via
  // `wrangler secret put WELCOME_BACKFILL_SECRET`.
  WELCOME_BACKFILL_SECRET?: string;
  // [TOKENS-100-GRANT-1] Shared secret for the one-time DESTRUCTIVE token hard-reset
  // route (`POST /api/admin/token-hard-reset/<secret>` — same trailing-path-segment
  // scheme as WELCOME_BACKFILL_SECRET). Fails CLOSED when unset; set via
  // `wrangler secret put TOKEN_RESET_SECRET` only for the one-time run, then unset.
  TOKEN_RESET_SECRET?: string;
  // [ADMIN-DELETE-USER-1] Shared secret for the admin "delete ANOTHER user" route
  // (`POST /api/admin/delete-user/<secret>` — same trailing-path-segment scheme as
  // TOKEN_RESET_SECRET). Fails CLOSED when unset; set via
  // `wrangler secret put ADMIN_DELETE_SECRET`.
  ADMIN_DELETE_SECRET?: string;
  // Vobiz account API credentials — required to fetch recording files from
  // media.vobiz.ai (401 without them; verified 2026-07-16). Set via
  // `wrangler secret put VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN`.
  VOBIZ_AUTH_ID?: string;
  VOBIZ_AUTH_TOKEN?: string;
}
