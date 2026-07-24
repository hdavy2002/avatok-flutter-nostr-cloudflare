# AvaBrain Chat — Deep Audit & Token-Billing Report (2026-07-24)

Scope: the in-thread `@ava` chat (AvaBrain chat), its data access, models, token
burn, cost, and the plan for wallet deduction + the future Gemini Live voice
call. Sources: `worker/src/do/ava_agent.ts`, `lib/ava_memory.ts`,
`lib/brain_domains.ts`, `lib/brain_ingest.ts`, `feature_pricing.ts`,
`routes/config.ts`, live prod `/api/config` (cache-busted), and PostHog
(project 139917, all users).

---

## 1. Is it working?

Yes — functionally live, barely used.

- PostHog, last 90 days: **58 completed turns from 2 users** (`ava_thread_completed`).
  Last 30 days: 7 turns, 1 user. All our-keys tier; **zero BYO-key turns**.
- Reply latency: **avg 5.9s, p50 5.3s, p90 10.7s**. That is slow for a chat
  reply and argues for the model switch below (Kimi K3 via OpenRouter is the
  current primary lane).
- Prod flags (live KV, cache-busted): `aiEnabled=true`, `companionEnabled=true`,
  `dailyAvaTurnLimit=25`, `openChatUncapped=false`, `webSearchEnabled=false`,
  `fileAnalysisEnabled=false`, `generativeEnabled=false`,
  **`betaFreePremium=false`** (beta-free is OFF — charges are real when wired),
  `receptBillingLive=true`.

### Telemetry gap found
`ava_agent.ts` emits `ava_thread_turn_model` with real `input_tokens` /
`output_tokens` from OpenRouter, but **that event has never landed in PostHog**
(only `ava_thread_turn` / `ava_thread_completed` exist in the taxonomy). Either
the deployed worker predates the Kimi-gateway lane or turns are routing through
the agentic/fallback path (which reports no token counts). `$ai_generation`
(LLM Analytics) has 8 events total, all May 2026 — the receptionist lane only.
**Exact token metering is therefore not yet observable in prod; fixing this is
the prerequisite for accurate wallet deduction.**

---

## 2. What it can do for a user

One `@ava` turn routes through a single Durable Object (`AvaAgentDO.turn`):

- **Plain chat** with bounded context: last 12 messages (`WINDOW=12`), a rolling
  one-paragraph summary (refreshed every ~8 messages, off the reply path), and
  AvaBrain memory snippets.
- **Personal memory recall** (`brainSearch` → `lib/ava_memory.ts`): answers from
  the user's own notes/messages/files index (snippets capped 300 chars, answers 500).
- **Email cards** (premium + Gmail/Outlook connected via Composio): "what's in my
  inbox" returns 5 structured email cards with View/Spam/Delete + reply overlay.
- **Calendar GenUI** (premium + Google Calendar): day view as an A2UI surface
  with a working "Schedule" affordance.
- **Connected-app actions** (premium, Composio agentic loop): Gmail, Calendar,
  Docs, Drive tool calls.
- **Image generation** in-thread (flagged off in prod: `generativeEnabled=false`).
- **Attachment awareness**: file/photo/voice-note descriptors + captions are in
  context (bytes stay E2E-encrypted — the server never sees content).
- **Web search** only on the BYO-key path (Google Search grounding); our-keys
  web search is flagged off.
- **Private mode** (`ava_private` replies visible only to the asker).

Non-premium users asking for app actions get a top-up/connect guide with no
model call. Free tier is capped at 25 turns/account/day.

## 3. What access does it have?

Chat context per turn: the caller's own InboxDO window for that conversation +
rolling summary + attachment descriptors. All model inputs are wrapped as
UNTRUSTED data (prompt-injection defense); output moderation was removed by
owner decision 2026-06-24.

AvaBrain (One Brain) ingestion — all opt-out ON, per-domain consent toggles,
`account_private` scope: contacts, call history (calls + missed), voicemails,
chat **metadata** (content is `device_private` — server-side ingest hard-rejects
it), marketplace listings, wallet, files, profile, identity verification,
calendar, live sessions, AvaVerse, receptionist call summaries. `safety`
(Guardian) is a separate legal-basis store — not reachable from chat recall.
Consent checks fail closed; ingestion is idempotent per (uid, key).

So the "knows everything the user does on the platform" goal is largely already
plumbed — the brain ingests all major surfaces; chat recall reads it via
`brainSearch`.

## 4. Models in use

| Lane | Model | Notes |
|---|---|---|
| Our-keys plain chat (primary) | `moonshotai/kimi-k3` via OpenRouter | `AVA_THREAD_MODEL` override; retry once |
| Our-keys plain chat (alt) | `google/gemini-2.5-flash-lite` via OpenRouter | on 429/5xx/timeout |
| Last resort | direct Gemini (`geminiRun`) | returns no token counts |
| Agentic/tool turns | Gemini via OpenRouter (composio loop) | separate lane |
| BYO key | `gemini-3-flash-preview` (user's own Google key) | + Search grounding, RAG |
| Output cap | `MAX_TOKENS=300`, 4,000-char hard cap | |

**Decision (owner 2026-07-24): switch primary to `google/gemini-2.5-flash-lite`**
— cheapest multimodal (~$0.10/M in, ~$0.40/M out list), natively handles images
(multimodal roadmap), and materially faster than the current 5.3s p50. Kimi K3
becomes the alt.

## 5. Token burn & cost

Per plain-chat turn (from code parameters):

| Component | ~Tokens |
|---|---|
| System prompt + rules | 400–700 |
| Rolling summary | ~150 |
| 12-turn window | 400–600 |
| Brain memory snippets | 300–600 |
| New user message | 30–100 |
| **Input** | **~1,300–2,100** |
| Output (capped 300) | 100–300 |
| Summary-refresh side call (amortized) | ~200 |

**≈ 2,000–2,500 tokens per turn all-in → ~$0.0005–0.003/turn** on Flash-Lite.

Current scale: ~15–20K tokens/month platform-wide (negligible). Projection: a
user doing 20 turns/month ≈ 50K tokens (~$0.02 API cost on Flash-Lite);
1,000 such users ≈ 50M tokens/month ≈ **$10–25/month API cost**.

## 6. Current billing state

**Chat charges nothing today.** `FEATURE_COSTS.ava_chat` (1 wallet token)
exists but no code path invokes it; the only chat gate is
`dailyAvaTurnLimit=25`. With `betaFreePremium=false` in prod, wiring billing
means real deductions immediately. Receptionist billing is live
(`ava_receptionist_minute: 3` wallet tokens/min, `receptBillingLive=true`,
hard cap 3:00, margin alert ₹2.20/min).

## 7. Pricing plan (owner-agreed)

Wallet economics: the wallet unit IS the **token** — 1 wallet token = 1 US cent
($0.01, 100/USD; the 2026-06-26 rename of AvaCoins → Tokens at the same value).
Integer wallet tokens only; spends via idempotent `chargeAmount` (WalletDO
op_id dedup, double-entry Q_WALLET ledger, team billing, free-tokens-first).
Terminology below: **wallet tokens** = the currency; **AI tokens** = model
input/output tokens.

- **Chat: 100 wallet tokens per 1M AI tokens ($1.00/M)** — input+output
  combined, estimated at chars/4 when the provider omits usage. ~2.5–5× margin
  over Flash-Lite list price; a typical turn (~2.3K AI tokens) costs the user
  ~¼ wallet token, i.e. **~1 wallet token per 4 turns**. Accrue per-user until
  ≥1 whole wallet token is owed, then charge (`avachat:<uid>:<seq>` op_ids).
  Config: `avaChatTokensPerMTok=100` + `avaChatBillingLive` test switch
  (mirrors `receptBillingLive`).
- **Voice calls (Gemini Live, to be built): same rate as the AI receptionist —
  `ava_receptionist_minute` = 3 wallet tokens/min.** Audio ≈ 32 AI
  tokens/sec/direction, so
  a 10-min call ≈ 25–50K tokens; per-minute billing reuses the proven
  receptionist settle path unchanged.
- **Compression: after a few turns** (`avaChatCompressAfterTurns=6`), feed only
  the last 6 turns + rolling summary instead of 12 — cuts steady-state input
  ~30–40% and speeds replies. Summary machinery already exists; this only
  tightens the window once a summary is present.
- BYO-key users: never charged (their own Google key).

## 8. Gemini Live voice call (to build)

Reuse the receptionist's Gemini Live plumbing (`do/reception_room.ts` lane) with
an AvaBrain persona + `brainSearch` context instead of the receptionist script;
bill per minute via the existing `chargeAmount`/settle machinery with
`ava_receptionist_minute`. Gate behind a new kill-switch flag declared in
`config.ts` DEFAULTS in the same change (the `inAppUpdateEnabled` fake-flag
lesson). Note the model constant references "gemini live 3.1" per owner — pin
the exact Live API model at build time.

## 9. Risks / gaps to close first

1. **Token telemetry not landing** (`ava_thread_turn_model` absent; LLM
   Analytics silent since May) — must be verified in prod before metering, else
   billing runs on estimates only.
2. `betaFreePremium=false` means the moment billing ships it charges real users
   — ship with `avaChatBillingLive`-style staged rollout anyway, flip
   deliberately.
3. Direct-Gemini fallback returns no usage counts — estimator (chars/4) needed.
4. Agentic/tool turns (Composio lane) report no token usage — meter the plain
   lane first; tool turns are already gated behind premium + per-feature costs.
5. Latency p50 5.3s — model switch + compression should bring plain turns well
   under 3s; verify with `ava_thread_completed.latency_ms` after deploy.

## 10. Status of implementation

Started then put ON HOLD (owner 2026-07-24, audit first). The partial diff
(config flags + billing table/meter in `AvaAgentDO`, model swap) is stashed at
`outputs/AVA-CHAT-TOKENBILL-1.partial.patch`; the working tree was reverted
clean. Issue ID reserved: `[AVA-CHAT-TOKENBILL-1]`. Remaining when resumed:
wire `meterChatTokens` + debt gate + compression into `turn()`, wallet-statement
labels for `ava_chat_tokens`, commit → deploy → flag verification.
