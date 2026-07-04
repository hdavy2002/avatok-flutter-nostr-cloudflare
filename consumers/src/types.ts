export interface Env {
  DB_META: D1Database;
  DB_MEDIA: D1Database;
  DB_MODERATION: D1Database;
  DB_BRAIN: D1Database;               // AvaBrain knowledge graph + memory
  DB_WALLET?: D1Database;             // wallet (delete cascade; Phase 2)
  BLOBS: R2Bucket;
  VERIFICATION?: R2Bucket;            // locked selfie videos (delete cascade)
  DIGITAL?: R2Bucket;                 // OLX digital goods (delete cascade; Phase 5)
  AGENT_AUDIO?: R2Bucket;             // agent TTS cache (delete cascade; Phase 8)
  BACKUP_R2?: R2Bucket;               // avatok-backup — durable chat archive (Phase 1 ABLY-R2)
  TOKENS: KVNamespace;
  AI: Ai;
  Q_PUSH?: Queue;                     // calendar reminders re-enqueue to push (Phase 3)
  Q_ANALYTICS?: Queue;                // lifecycle events (e.g. account_deleted) → PostHog
  Q_MONEY?: Queue;                    // Phase 7 — sweep enqueues refund/settlement jobs
  CONVERSATION_DO?: DurableObjectNamespace; // cross-script → avatok-api ConversationDO (Phase 7)
  INBOX?: DurableObjectNamespace; // cross-script → avatok-api InboxDO (large-group fanout + marketplace voice card)
  PARTY?: DurableObjectNamespace; // cross-script → avatok-api PartyDO (marketplace voice deal_ready nudge)
  CALL_ROOMS?: DurableObjectNamespace; // cross-script → avatok-api CallRoom (P1 ring-ack control-plane)
  Q_MKT_AUDIO?: Queue;            // marketplace negotiation voice render (async, this consumer)
  Q_AUTO_REPLY?: Queue;           // STREAM F auto-responder job (incoming DM → away auto-reply, this consumer)
  WALLET_DO?: DurableObjectNamespace; // cross-script → avatok-api WalletDO (nightly recon reads, Phase 2)
  VECTOR_INDEX?: VectorizeIndex;      // semantic memory (brain embeddings)
  AI_SEARCH?: any;                    // sharded per-user AI Search (delete cascade per item id)
  ANALYTICS?: AnalyticsEngineDataset; // operational metrics (writeDataPoint)
  FCM_PROJECT: string;
  BRAIN_EXTRACT_MODEL?: string;
  BRAIN_EMBED_MODEL?: string;
  BRAIN_VISION_MODEL?: string;     // Gemma 4 multimodal — image caption/OCR/doc/chart/UI
  MODERATION_MODEL: string;        // image moderation model
  MODERATION_MODEL_TYPE?: string;  // "vision" (LLM, parse text) | "classifier" (label+score)
  TEXT_MODERATION_MODEL?: string;  // text safety classifier (Llama Guard default)
  POSTHOG_HOST: string;
  AI_DAILY_CALL_BUDGET?: string; // daily Workers AI call budget (default 5000); cron alarms past it
  STORAGE_COINS_PER_GB?: string; // AvaStorage over-quota price (coins/GB/month, default 20)
  ALERT_EMAIL?: string;          // ops alert recipient (default hdavy2005@gmail.com)
  RECON_DRILL_ACCOUNTS?: string; // comma-sep accounts deliberately tampered for the A2 acceptance drill; a run touching ONLY these gets a [DRILL] subject instead of a real alert
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
  // Clerk Backend API (delete cascade removes the Clerk user; Phase 5 reminder
  // emails resolve addresses from Clerk — D1 stores only hashes). Gated.
  CLERK_SECRET_KEY?: string;
  // Phase 5 — gcal inbound-sync cron fallback + reminder join links.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GCAL_TOKEN_KEY?: string;
  JOIN_LINK_SECRET?: string;
  // PostHog person deletion (delete cascade; uses personal key). Gated.
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
  // Stripe customer deletion (delete cascade; Phase 2). Gated.
  STRIPE_SECRET_KEY?: string;
  // [MONEY-SWEEP-GATE-1] Phase 7 money sweep launch gate. "1" → run the minute
  // refund/settlement sweep; unset (launch default) → skip it (Stripe is TEST,
  // wallet top-ups off, so the 6 D1 reads/min buy nothing).
  WALLET_TOPUP_ENABLED?: string;
  // Phase 9 — OpenAI Whisper voice-note transcription. Unset → voice notes are
  // simply not indexed (no transcript, no vector); everything else still works.
  OPENAI_API_KEY?: string;
  // Marketplace agent-negotiation VOICE render (Gemini multi-speaker TTS).
  // Prefers the receptionist project's key; falls back to the general one.
  RECEPTIONIST_GEMINI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

// Marketplace voice-render message (producer: avatok-api runNegotiationJob). The
// text deal card is already delivered synchronously; this renders the FULL
// transcript to a WAV async and appends the voice card to both InboxDOs.
export interface MktAudioMsg {
  conv: string; sellerUid: string; buyerUid: string; listingId: string;
  outcome: string; bubble: string; agreed: number; currency: string;
  // `transcript` is the BUYER-LANGUAGE transcript (already translated + capped by
  // avatok-api). The consumer TTS's it verbatim with a "Speak in <language>." preamble.
  transcript: Array<{ speaker: string; text: string }>;
  persona?: string;
  // MKT-LANG-4: buyer language + buyer voice + English canonical + i18n cache.
  lang?: string;               // =buyerLang (BCP-47 short code, e.g. 'es'); default 'en'
  buyerVoice?: string | null;  // buyer's chosen Gemini voice (fallback Aoede)
  transcriptEn?: Array<{ speaker: string; text: string }>;               // canonical
  transcriptI18n?: Record<string, Array<{ speaker: string; text: string }>>; // cache
  summary?: string;            // buyer-language summary line
  pendingOwnerApproval?: boolean; // deal held for the seller's approval
  enqueuedAt?: number; // when avatok-api enqueued this; consumer detects backlog delay
}

// STREAM F — auto-responder job (producer: avatok-api sendMsg hot-path hook). One
// message per incoming DM that passed the hot-path pre-filter (feature on, responder
// active, audience matched, not a stranger-gate thread, not itself an auto-reply).
// The consumer enforces the per-contact/day + global/day caps + loop protection,
// generates the reply (canned string, or AI mode = short LLM call), and appends it
// to the thread as the RECIPIENT's message with envelope auto:true.
export interface AutoReplyMsg {
  recipient: string;      // the AWAY user (whose responder fires) — reply is sent AS them
  sender: string;         // the person who messaged them (gets the auto-reply)
  conv: string;           // the DM conversation id
  incoming_text: string | null; // the incoming message text (for AI context + urgent classify)
  incoming_kind: string;  // 'text' | 'audio' | ...
  incoming_mid?: string;  // canonical id of the incoming message (telemetry only)
  enqueuedAt?: number;    // when avatok-api enqueued this (backlog detection)
}

// STREAM F — away-digest job (producer: avatok-api putAutoResponder on an
// enabled→disabled transition; also the schedule-end cron sweep). Rides the SAME
// `auto-reply` queue; discriminated by `kind:"digest"`.
export interface AutoDigestMsg { kind: "digest"; uid: string; day?: string; }

// LIVE-V2 P0 — async liveness-verify job. NOT wired to a live queue yet: avatok-api
// currently runs the checks via ctx.waitUntil (see worker/src/routes/liveness.ts
// runLivenessChecks + the LIVE-V2 NOTE there), because adding a queue producer +
// consumer binding is new infra AND runLivenessChecks can't be imported across the
// worker↔consumers package split. This type + handler exist so a future
// `liveness-verify` queue can dispatch here (see liveness_verify.ts).
export interface LivenessVerifyMsg { kind: "liveness_verify"; uid: string; session_id: string; }

// Account-deletion cascade message (producer: avatok-api /api/account/delete).
export interface DeletionMsg { uid: string; clerk_user_id?: string | null; scheduled_at?: number; pubkey_hex?: string; }

// Agent task message (producer: avatok-api /api/agent/*). 'converse' runs a
// ConversationDO turn loop; 'task' is a per-app hook (Phase 8).
export interface AgentMsg { type: "converse" | "task"; conversation_id?: string; uid: string; app: string; peer_npub?: string; kind?: string; payload?: Record<string, unknown>; }

// Wallet audit message (producer: WalletDO). Writes the D1 ledger + mirrors.
export interface WalletTxMsg {
  // Legacy audit fields (uid/type/amount) — optional for ledger-only rows
  // (e.g. escrow→platform fee rows, which touch no user account).
  uid?: string; id: string; ts?: number;
  type?: "topup" | "spend" | "earn" | "hold_release" | "refund" | "gift" | "payout";
  amount?: number; balance_after?: number; app_name?: string;
  counterparty_npub?: string | null; commission?: number; ref?: string | null; hold_until?: number;
  // Phase 2 double-entry row (id above = op_id = wallet_ledger PK).
  ledger?: { debit: string; credit: string; type: string; ref?: string | null; meta?: string | null };
}

// Queue message shapes (producers: avatok-api, avatok-relay)
// type: "image" (R2 blob scan) | "stream_recording" (Cloudflare Stream recording,
// scan is a follow-up — handler no-ops gracefully when hash is empty).
export interface ModerationMsg { type: "image" | "stream_recording"; hash: string; uid: string; media_id: string; r2_key: string; }
export interface PushMsg {
  kind: "call" | "notify" | "call-status" | "relay-event" | "fanout" | "del" | "hide" | "call_del" | "call_clear" | "group_invite";
  to?: string; to_uid?: string | null; from?: string; from_pubkey?: string;
  callType?: string; room?: string | null; status?: string;
  fromName?: string; callId?: string;
  // kind === "group_invite": the inviter added the recipient to a group. Carries
  // the group name + conv id so the app can deep-link straight to the group and
  // show the Accept/Decline prompt.
  groupName?: string;
  // kind === "notify": optional short message preview (WhatsApp-style expandable
  // banner). Omitted → content-less banner (sender name only).
  preview?: string;
  // kind === "del" (delete-for-everyone → silent realtime redaction on the device):
  conv?: string; target?: string;
  // kind === "hide" (delete-for-me / undo on another of MY devices → silent wake so
  // every device hides/un-hides the same message in realtime). hidden=true → hide.
  hidden?: boolean;
  // kind === "call_del" (one call-log entry removed on another of MY devices) /
  // "call_clear" (whole history cleared) — silent wake so an asleep device applies it.
  entry_id?: string;
  title?: string | null; body?: string | null; data?: Record<string, unknown> | null;
  event_kind?: number; event_id?: string; ts?: number;
  // kind === "fanout" (large-group delivery; router never loops >25 sync DO calls):
  recipients?: string[]; payload?: Record<string, unknown>;
}
// attachments: Brevo transactional attachment shape — content is base64 (Phase 5 ICS).
export interface EmailMsg { to: string; subject: string; html: string; from?: string; replyTo?: { email: string; name?: string }; attachments?: { name: string; content: string }[]; }
export interface AnalyticsMsg { event: string; uid?: string; props?: Record<string, unknown>; ts?: number; }

// Chat archive message (producer: avatok-api /api/msg/send). The consumer writes
// the body to R2 (BACKUP_R2, chat/<conv>/<serial>.json) + upserts D1 message_index.
export interface ArchiveMsg {
  conv: string;
  serial: string;          // canonical message id (chronologically sortable)
  sender: string;
  kind: string;
  body?: string | null;
  media_ref?: string | null;
  client_id?: string | null;   // sender's optimistic id (shared) — client dedupe key
  created_at: number;
  group?: boolean;
  // Phase 4: reaction archive (type:'reaction') rides the same queue.
  type?: "message" | "reaction";
  target?: string;         // reaction → the message serial being reacted to
  emoji?: string;          // reaction → emoji name
  op?: "add" | "remove";   // reaction → toggle direction
}
// AvaBrain: PUBLIC content only (server never gets DM plaintext). payload is JSON.
export interface BrainMsg { uid: string; event_type: string; source_app: string; payload: Record<string, unknown>; capability?: string; traceId?: string; ts?: number; }
