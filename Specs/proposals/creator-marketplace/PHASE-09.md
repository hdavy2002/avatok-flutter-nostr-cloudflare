# Phase 9 — AvaChat ⇄ AvaBrain (Personal AI + Guardrails + Voicemail Search)

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §2, §6 (AvaBrain consent). Prereq:
Phase 4 (files index). Owner direction 2026-06-10: AvaChat is a ChatGPT-like
interface to AvaBrain; AvaBrain screen = settings/guardrails; Whisper transcribes
voice mails into vectors so users can find them by content.

## ⚠️ ALREADY BUILT — verified 2026-06-10. AvaBrain has a large existing base.
- **UserBrainDO EXISTS** (`worker/src/do/user_brain.ts`) + a knowledge graph in
  D1 (`migrations/brain.sql`: brain_entities, brain_relationships, brain_facts,
  brain_daily_summaries, brain_events) + `consumers/brain.ts` ingestion consumer
  + `hooks.brainFact()` — apps ALREADY write facts into the brain.
- **Guardrails EXIST:** `migrations/brain_consent.sql` → `brain_consent` table
  + `worker/src/routes/brain.ts` (GET/POST capability toggles). **Do NOT create
  `brain_settings` — extend `brain_consent`** with the per-app toggles and make
  the AvaBrain screen render this API. Verify `consumers/brain.ts` checks
  consent before ingesting; add the check if missing.
- **Agent system EXISTS:** AgentDO (`do/agent.ts`), `agent_personas`/
  `agent_conversations`/`agent_inbox` (agent.sql), `routes/agent.ts` +
  `agent_tts.ts` (TTS), `consumers/{agent,ai}.ts`, `ai_spend` budget table.
  **AvaChat's conversation layer = the existing agent-conversation plumbing**
  with a "brain" persona — don't build a parallel chat backend; add RAG
  retrieval (Vectorize + brain_facts) to its context assembly.
- **GDPR partially EXISTS:** `deletion_requests` (avaid.sql) +
  `consumers/deletion.ts` — A1's deleteUserData EXTENDS this consumer with the
  per-store map; don't create a second deletion pipeline.
- Genuinely NEW: ChatGPT-style AvaChat UI, Whisper voicemail transcription →
  Vectorize, voicemail-search intent, source chips, retro-delete on toggle-off.

## Objective
- **AvaChat (app):** conversational UI where the user talks to THEIR AvaBrain — an
  AI aware of their own platform content: AvaTok messages, group chats, files,
  images, voice mails; later every app.
- **AvaBrain (screen):** the control room — master switch + per-app guardrail
  toggles (default ON, opt-out) that the ingestion pipeline obeys. Example: toggle
  "don't record anything from AvaWallet" ⇒ wallet data never indexed.

## Backend

### Ingestion pipeline (`avatok-consumers`, Queue `Q_BRAIN`)
- Producers: message stored (InboxDO hook), file registered (Phase 4
  `registerFile`), voice note/voicemail stored, future apps.
- Consumer steps per item:
  1. **Guardrail check** (D1 `brain_settings`): master ON? source-app toggle ON?
     If not → drop. (Rulebook: toggles registered in main Settings too.)
  2. Normalize: text as-is; images → caption via Workers AI vision model
     (optional, flag) ; **voice mail/voice note → OpenAI Whisper API transcription**
     (store transcript next to the media ref).
  3. Embed: Workers AI `@cf/baai/bge-m3` (or equivalent) → **Vectorize** index
     `avabrain-<env>`, metadata {userId, sourceApp, ref, kind, ts, snippet}.
     **Every query/upsert filtered by userId — hard tenant isolation.**
- D1 `brain_settings(user_id, master INTEGER, toggles TEXT/*JSON per app*/)`.
- Backfill job (admin-triggered) to index existing history per user, guardrails
  respected.

### Chat/answer API (`routes/avabrain.ts`)
- `POST /api/brain/chat` {message, conversationId} → RAG: embed query → Vectorize
  topK (userId-filtered) → re-rank → LLM (Workers AI Llama, or Claude API — flag
  `BRAIN_MODEL`) with system prompt "answer ONLY from this user's own content;
  cite sources" → response + source chips [{app, ref, snippet}].
- Special intents: "find my voice mail about X" → vector search restricted to
  kind=voicemail → return playable media refs.
- Chat history per user in the user's InboxDO (conversation context `system`/
  `brain`) — no new store; per-account scoped on device.
- `GET/PUT /api/brain/settings` for the guardrails screen.

## Flutter

### AvaChat (`app/lib/features/avachat/`)
- ChatGPT-style: message list, streaming responses, markdown, stop button,
  suggestion chips ("Find my voicemail about…", "What did X send me last week?").
- **Source cards** under answers: tappable → opens the message thread / file in
  AvaLibrary / plays the voicemail inline.
- New-conversation / history drawer.

### AvaBrain settings screen (`app/lib/features/avabrain/` — extend existing)
- Master switch (default ON) + per-app toggle list (AvaTok messages, Group chats,
  Files & images, Voice mails, AvaWallet, AvaCalendar/Bookings, …) each with a
  one-line description of what gets indexed; all default ON (opt-out model).
- "Delete my AvaBrain data" → wipes user's Vectorize entries + transcripts.
- Each toggle ALSO registered into the main Settings screen (rulebook §3).

### Privacy notes
- Server-readable arch (post-Nostr) permits server-side transcription/indexing;
  guardrails are the user's control surface. Toggling OFF stops new ingestion AND
  (flag `BRAIN_RETRO_DELETE`) deletes already-indexed items from that app.
- Whisper API key in secrets; transcripts count as derived data, not storage quota.

## Acceptance criteria
- [ ] Send a voice note, then ask AvaChat "find my voicemail about <topic>" ⇒
      correct voicemail surfaced and playable.
- [ ] "What did <contact> say about <thing>?" answers with source chip linking to
      the real message.
- [ ] Toggle AvaWallet OFF ⇒ wallet events never appear in Vectorize (verified);
      master OFF ⇒ pipeline drops everything.
- [ ] User A can never retrieve user B's content (tenant-isolation test).
- [ ] Delete-my-data leaves zero vectors for the user.

## Folded from audit (build in this phase)

### A1. GDPR / account-deletion map [SHOULD]
- One canonical `deleteUserData(userId)` orchestrator (worker, admin + self-serve
  from Settings → "Delete my account", double-confirm + 7-day grace period):

| Store | Action |
|---|---|
| Vectorize (avabrain) | delete all vectors for userId |
| Whisper transcripts / files_index / R2 objects | delete (last-reference rule) |
| InboxDO (messages) | purge DO storage; tombstone convs for peers |
| bookings / orders | keep rows (counterparty + finance need them), null PII fields |
| wallet_ledger | RETAIN (finance-law retention), anonymize meta names |
| listings / reviews / creator_profiles / follows | delete or anonymize ("deleted user") |
| Clerk user, push_tokens, brain_settings, gcal tokens | delete/revoke |

- Wallet balance must be zero (or withdrawn/forfeited after grace) before final
  deletion; pending escrow blocks deletion until resolved.
- `deletion_log(user_id, requested_at, completed_at, stores_json)` for audit.
- Acceptance: deleted user's data unfindable via every read API + Vectorize
  query; ledger rows remain but show anonymized counterpart; peer can still
  read their own side of old conversations.

## Definition of done
Deploy (consumers + api), OPENAI_API_KEY in secrets, Vectorize index created,
Graphiti episode, STATUS_REPORT.md, push.
