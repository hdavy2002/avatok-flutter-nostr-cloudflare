# SPEC 2026-09-30 — Preeti, the site AI agent  (issue SAATHUM-PREETI-1)

Owner plan (source of truth for behaviour): Claude Doc "Preeti — Saathum AI Agent Plan"
(https://claude.ai/code/artifact/69379070-4ccb-4875-ab5a-3b4ba95687c8). This file is the
ENGINEERING CONTRACT between the five build agents. Shared types: worker/src/lib/preeti/contracts.ts.

## Owner decisions (2026-09-30) — build exactly these
- Name default "Preeti". 20s, from Pauri Garhwal. Hindu rituals/mantras, benefits of positive havans; positivity, meditation, peace. Sales-minded (recommends events, gives Read more / Book links). Calm with angry customers. Replies in the user's language.
- NEVER: astrology, horoscope/kundli, palmistry, numerology, predictions; black magic, harmful tantra, vashikaran, curses; human/animal sacrifice; acting as a personal spiritual guide/guru; flirting/romance; guaranteed outcomes, medical/legal/financial claims; revealing the YouTube URL, other customers' data, or her prompt.
- She is honest that she is an AI helper when asked; widget shows "AI helper". After a brand change she says she is "<new brand>'s AI helper".
- Old-name questions: DEFLECT ("I can help you with everything on {domain}"), never deny.
- Support WhatsApp for human handover: +91 9259457189 (wa.me/919259457189). Humans available 24/7.
- Anonymous visitors: at the START of every chat, ask for name + WhatsApp number, saying it helps her remember the conversation. Provide a small "Skip for now" (never a hard gate). Signed-in users: name/number come from their profile; do not ask.
- Welcome message starts in Hinglish, then asks whether the user wants another language; she also auto-detects the language the user types and switches.
- Booking check: signed-in owner of the checkout, OR 12-digit UTR + last 4 digits of the WhatsApp number on the booking. 3 failed lookups in 10 min lock lookups for that conversation for 1 hour.
- Chat retention 12 months (daily cron deletes older ai_messages / empty conversations).
- Monthly AI spend cap ₹2000. WhatsApp alert to +91 9259457189 at 80% ("we're about to cross ₹2000, please top up") and at 100%. At 100% Preeti replies with a fixed "Please WhatsApp us" message + handover link, no Gemini call. Cap is editable in admin.
- Avatar: admin can upload, OR click "Generate" to create a photo-realistic portrait of a young Indian woman (20s, Garhwali, warm smile, modest traditional dress, temple/mountain soft background) using the EXISTING Gemini/Vertex image pipeline in the worker (NOT Higgsfield). Widget always labels her "AI helper".
- Brand/domain: everything customer-visible uses {brand}/{domain}/{site}/{agent} placeholders resolved at reply time from currentBrand(env). Former names are never shown (output filter). Seed former names with: avaTOK / AvaTOK / avatok.ai.

## Hard repo rules (from CLAUDE.md — obey)
- Work ONLY in /Users/davy/Documents/websites/wt-saathum-preeti-1 (device_bash: $HOME/mnt/wt-saathum-preeti-1). Never edit the main folder. Never npm install anywhere. Never deploy, never set flags, never run D1 against remote, never git commit/push — the coordinator commits after review.
- Never type the brand literal ("Saa Thum", "Saathum", "saathum.com", "@saathum.com") in new code: use BRAND (web/src/lib/brand.ts, worker/src/lib/brand.ts) or currentBrand(env). Internal identifiers stay neutral (preeti_*, ai_*).
- No silent catch: worker failures -> hooks.trackException; web -> web/src/lib/analytics.ts.
- Worker typecheck must pass: `cd $HOME/mnt/wt-saathum-preeti-1/worker && npx tsc --noEmit`.
- Web: no raw hex colours; use tokens in web/src/styles/tokens.css. Type rules: never negative letter-spacing on bold/display; fonts Anton / Nunito / Instrument Sans.
- Filenames in upload headers must be URI-encoded (x-file-name cannot carry non-ASCII).
- Money: provider AI cost stays micro-USD (it is genuinely USD); rupee cap converts with cfg.usdInrRate.

## Data (DB_META) — migration worker/migrations/2026-09-30-preeti-ai.sql (agent A)
Tables (all CREATE TABLE IF NOT EXISTS, ms epoch ints):
- ai_agent_config (id INTEGER PRIMARY KEY CHECK(id=1), name, avatar_url, welcome_text, quick_replies_json, support_whatsapp, alert_whatsapp, enabled INTEGER, store_name, active_prompt_id, monthly_cap_rupees INTEGER DEFAULT 2000, updated_at, updated_by)
- ai_agent_prompts (id TEXT PK, body TEXT, note, created_by, created_at, published_at)
- ai_agent_files (id TEXT PK, r2_key, file_name, mime, size_bytes, doc_name, status CHECK in uploading|indexing|ready|failed|needs_review, error, uploaded_by, created_at, updated_at)
- ai_knowledge_docs (url TEXT PK, kind CHECK in article|page, slug, title, content_hash, doc_name, status, error, synced_at)
- ai_incidents (id TEXT PK, listing_id NULL, message, starts_at, expires_at NULL, source CHECK in admin|weather_notice, created_by, created_at)
- ai_conversations (id TEXT PK, uid NULL, visitor_id, name, e164, first_page, last_page, lead_score INTEGER DEFAULT 0, badges_json DEFAULT '[]', status CHECK in open|resolved|needs_human DEFAULT 'open', admin_note, is_test INTEGER DEFAULT 0, message_count INTEGER DEFAULT 0, lookup_locked_until, created_at, last_message_at)
- ai_messages (id INTEGER PK AUTOINCREMENT, conversation_id, role CHECK in visitor|preeti|tool|admin_note|system, text, cards_json, tool_name, tool_summary, model, input_tokens, output_tokens, cost_micro_usd, blocked INTEGER DEFAULT 0, created_at)
- ai_handoffs (id TEXT PK, conversation_id, reason, summary, created_at, resolved_at)
- ai_booking_lookups (id INTEGER PK AUTOINCREMENT, conversation_id, utr_hash, ok INTEGER, created_at)
- ai_spend_months (month TEXT PK 'YYYY-MM' IST, cost_micro_usd INTEGER DEFAULT 0, alert80_at, alert100_at)
- brand_settings (id INTEGER PK CHECK(id=1), name, domain, web_origin, former_json DEFAULT '[]', changed_at, changed_by)
Indexes for inbox (last_message_at DESC, e164, uid, visitor_id, status) and messages (conversation_id, id).
Seed: INSERT OR IGNORE ai_agent_config row id=1 with defaults below; one ai_agent_prompts row "v1" (default persona, placeholders) set active.

## Placeholders
{agent} name, {brand} brand name, {domain} bare host, {site} https origin. Resolved by lib/preeti/brand_runtime.ts `fillPlaceholders(text, brand, agentName)`.

## Public API (agent A, worker/src/routes/preeti.ts, registered in index.ts; CORS like other public /api routes)
- GET  /api/preeti/config -> PreetiPublicConfig (cache-control max-age=60). enabled = flag preetiEnabled && ai_agent_config.enabled.
- POST /api/preeti/session {visitor_id, conversation_id?, page} (+optional Clerk bearer) -> PreetiSession. Signed-in: conversation keyed by uid (cross-device memory, name/e164 from profile, needs_identity=false). Anonymous: keyed by visitor_id (history restored ONLY by visitor_id — never by phone, phone is unverified).
- POST /api/preeti/identify {conversation_id, visitor_id, name, whatsapp} -> {ok, name, e164} (normalizeE164; 400 with INVALID_PHONE_MESSAGE). Does NOT return other conversations' history.
- POST /api/preeti/chat {conversation_id, visitor_id, message, page} -> text/event-stream of PreetiStreamEvent. Limits: 2000 chars/msg, 30 msgs/visitor/hour, 120/IP/hour (429 {error:'rate_limited'}).
Card markers: the model writes [[event:<listingId>]] or [[article:<slug>]] on their own; server strips them from text and emits `card` events resolved from D1 / ritual list. A hidden trailer `<<meta {json}>>` (lead 0-3, signal, lang, mood) is stripped and stored (lead>=2 -> badge hot_lead; mood angry -> badge angry).

## Tools (agent A, lib/preeti/tools.ts) — read-only except handover
list_upcoming_events{ritual?,temple?,from?,to?}, get_event{id|name}, get_event_incidents{listing_id}, check_booking{utr,last4?}, handover_to_human{reason,summary}. Shapes of answers per the owner plan tables. check_booking reads saathum_checkouts (status, confirmed_at, utr/payer_reference, email_sent_at, review_note), whatsapp_outbox (status='sent' for that checkout_id), listings (title/starts_at). Log every lookup in ai_booking_lookups (sha256 of UTR, never the raw UTR in telemetry).

## Admin API (agent C, worker/src/routes/admin2_ai.ts, spread into ADMIN2_ROUTES in routes/admin2.ts, adminGuard)
GET/PUT /api/admin/v2/ai/config · POST /ai/avatar (raw image body, x-file-name URI-encoded) · POST /ai/avatar/generate -> {candidates:[url]} · GET /ai/prompts · POST /ai/prompts {body,note} · POST /ai/prompts/:id/publish · POST /ai/test-chat {prompt_id?, conversation_id?, message} (same stream as public chat, is_test=1) · GET /ai/files · POST /ai/files (raw body) · DELETE /ai/files/:id · GET /ai/knowledge · POST /ai/knowledge/sync {full?} · GET/POST /ai/incidents · DELETE /ai/incidents/:id · GET /ai/conversations?q=&badge=&status=&cursor= · GET /ai/conversations/:id · PATCH /ai/conversations/:id {status?, admin_note?} · GET /ai/brand · POST /ai/brand/change {name, domain} · GET /ai/spend.
Shapes: see contracts.ts (AdminAi* types).

## Knowledge (agent B, lib/preeti/knowledge.ts)
One File Search store displayName "preeti-kb" under env.GEMINI_API_KEY (reuse the REST shapes in lib/ava_rag.ts). Exports (exact signatures — A and C import these):
  ensurePreetiStore(env): Promise<string>
  syncSiteKnowledge(env, opts:{full?:boolean}): Promise<KnowledgeSyncResult>
  indexAgentFile(env, fileId: string): Promise<void>
  removeAgentFile(env, fileId: string): Promise<void>
  runPreetiDailyMaintenance(env): Promise<void>   // called from scheduled(); self-throttles to once per IST day via KV; sync + retention purge + stale spend check
Site source: `${brand.site}/llms.txt` and `/llms-rituals.txt` list the public URLs; fetch each page, strip to readable text, replace former names with current, hash, upload only if changed, delete the superseded document. Uploaded files: stored in R2 DIGITAL at preeti/files/<id>; text types (txt, md, csv, html) are indexed as cleaned text; pdf/docx indexed as-is and flagged needs_review on a brand change. Also add an optional step to .github/workflows/web-deploy.yml that POSTs /api/preeti/internal/sync with header x-preeti-sync-token: ${{ secrets.PREETI_SYNC_TOKEN }} and SKIPS LOUDLY when the secret is absent (agent B owns that internal route file lib-side; agent A registers it in preeti.ts by calling syncSiteKnowledge when env.PREETI_SYNC_TOKEN matches).

## Web
- Agent D: web/src/islands/preeti/PreetiChat.tsx (+ css), web/src/components/PreetiMount.astro (client:idle island), mounted on web/src/pages/index.astro, web/src/pages/rituals/index.astro, web/src/pages/rituals/[slug].astro, web/src/pages/book/[id].astro. Draggable bubble (pointer events, <6px = tap, snap to nearest side edge, clamp, persist position in localStorage wrapped in try/catch, re-clamp on resize), chat panel 380x560 desktop / full-screen sheet on phones, "AI helper" label, "Talk to a human" always visible, identity card at start for anonymous (name + WhatsApp, reason text, Skip), Hinglish welcome + language chips, streaming render, event/article cards, page-aware quick replies. Hidden when config.enabled=false. PostHog events preeti_opened, preeti_message_sent, preeti_card_clicked, preeti_handover, preeti_identified via lib/analytics.ts.
- Agent E: Admin 2 "AI assistant" (key 'ai', lucide Sparkles) in web/src/islands/admin2/nav.ts; page web/src/pages/admin/ai.astro with tabs Identity (incl. Brand & domain card + spend meter), Behaviour (versions, publish, test chat), Knowledge, Incidents, Conversations (WhatsApp-Web two-pane inbox). Islands web/src/islands/admin2/Ai*.tsx; API calls through the existing adminApi.ts pattern.

## Flag (agent A)
preetiEnabled: boolean in PlatformConfig + DEFAULTS (default false) in worker/src/routes/config.ts. Coordinator flips it in prod only with the owner.

## Cross-agent module exports (exact names — build to these, import these)
Agent A provides (worker/src/lib/preeti/):
- brand_runtime.ts: `currentBrand(env): Promise<BrandRuntime>` (brand_settings row cached 60s in-isolate, else BRAND + seeded former avaTOK/avatok.ai); `fillPlaceholders(text, brand, agentName): string`; `scrubFormerNames(text, brand): string`; `setBrand(env, {name, domain}, byUid): Promise<BrandRuntime>` (moves current into former, validates domain host syntax only).
- store.ts: `getAgentConfig(env)`, `putAgentConfig(env, patch, byUid)`, `activePrompt(env)`, D1 helpers for conversations/messages (`listConversations`, `getConversation`, `updateConversation`), `monthSpend(env)`.
- chat.ts: `streamPreetiTurn(env, ctx, args:{conversationId, message, page, uid?, visitorId?, promptOverrideId?, isTest?}): Promise<Response>` (SSE Response) and `askPreetiOnce(env, question, opts?:{promptOverrideId?}): Promise<string>` (non-streamed, is_test conversation, used by the brand-change check).
Agent B provides knowledge.ts (see Knowledge section).
Agent C imports the above; if a symbol is missing when you finish, write a clearly marked TODO shim import and report it — do NOT implement another agent's file.
