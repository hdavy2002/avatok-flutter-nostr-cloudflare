# AvaTOK — Ava In-Chat AI (Full Proposal)

**Status: PROPOSAL (draft 1) — 2026-06-17.** Turns AvaTOK's messaging system into
a fully AI-native chat where **Ava** (the assistant) is a *participant in the
thread*, not a separate screen. Scopes the product down to AvaTOK-first, reuses
the existing Cloudflare-native stack (InboxDO, UserBrain, AgentDO, ConversationDO,
Vectorize, llama-guard, AvaWallet), and adds a small set of new primitives.

Decision owner: davy (hdavy2005).

## Decisions locked this session

- **Ava is a thread participant**, rendered in a **feminine-colored** bubble; she
  can post into 1:1 and group threads.
- **AvaTOK-first.** Non-AvaTOK apps are hidden behind a reversible "focus mode";
  AvaTOK (Messages & calls) + account essentials only.
- **Wallet + AvaCoins stay.** Minimum top-up **$5 USD**. Core Ava chat is **free**;
  **MCP tool use** and **image/voice generation** are **paid**.
- **Premium features are visibly separated in Settings** with a **PAID badge**;
  tapping with an empty wallet opens the top-up sheet.
- **Tool layer = Klavis Strata, self-hosted** (progressive tool disclosure +
  per-user OAuth) — solves tool/context overload without a per-call SaaS bill.
- **Memory = two lanes.** Free **on-device** lane (SQLite FTS5 + ZVEC/ObjectBox +
  on-device embedder). Premium **server** lane (Vectorize + UserBrain).
- **No mem0 dependency.** UserBrain already is our "mem0"; mem0 cloud gates the
  graph behind $249/mo and bills per message — rejected.
- **Messaging is server-readable** (already canonical in `AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`),
  so cheap server-side AvaBrain is viable. A private **on-device-only** chat mode
  is offered as opt-in.
- **Backup is layered:** on-device SQLite = source of truth; **R2** = premium
  cross-device sync; **user's Google Drive** = free user-owned backup.
- **Consent is mandatory and visible:** a persistent "Ava is active in this chat"
  indicator for all participants; auto-replies are always disclosed as "Ava — for <name>".
- **AvaTOK now ships in two modes:**
  - **Plain messaging (no AI)** — a clean WhatsApp-style messenger. Chosen at onboarding
    (or by skipping the AI step). Zero AI cost.
  - **AI-enabled (Ava)** — unlocks all Ava features. Opt-in at onboarding or via a Settings
    **BYO-AI toggle**.
- **Primary AI unlock = BYO Gemini key via AI Studio (zero AI cost to us).** When a user
  enables AI, the flow is: **tap a button → opens Google AI Studio → "Get API key" →
  copy free key → paste back into AvaTOK.** Ava then runs on the user's own free Gemini
  quota. This is the encouraged path and makes per-user inference cost **$0 to us**.
- **Auto-provisioning of keys is REJECTED** (cloud-platform restricted scope → CASA audit +
  100-user lifetime cap; Cloud ToS must be accepted manually; scary broad consent). AI
  Studio already does consumer-friendly project+key creation for us.
- **Tiering is locked (anti-ChatGPT-abuse):**
  - **AI on our keys (free)** = for users who enable AI but don't BYO: task-scoped Ava,
    cheap model, bounded context, **daily cap**, **no web search, no file analysis**.
  - **AI via BYO Gemini key** = full Ava features on the user's own free quota, $0 to us.
  - **Premium (wallet)** = removes the cap; unlocks web search, file analysis, long
    open-ended chat, image/voice/MCP. The home for "discuss for hours." Stays the
    mainstream paid lane alongside our-keys.

## Open decisions (need davy's call)

1. **Guardian free-vs-paid line.** Proposed: basic scam/spam flag = free; always-on
   deep monitoring = premium. Confirm.
2. **Default embedder on device.** Proposed: bge-small (~40 MB) default, EmbeddingGemma
   (~180 MB) opt-in for multilingual. Confirm.
3. **Ava wake trigger.** Proposed: `@ava` + composer button; plain-word "Ava," as an
   optional setting. Confirm.
4. **Companion/roleplay age gate.** Proposed: verified adult (L-tier identity) only,
   llama-guard boundaries. Confirm.

---

## 1. Vision

Today AI lives on a separate screen. In AvaTOK, **Ava sits inside the conversation**.
Two people are chatting; one types `@ava find the file we discussed` and Ava replies
in her own colored bubble — *"Sure, one sec…"* — shows a live **"Ava is working…"**
chip while the humans keep talking, then drops the file in when ready. She can find
things, fetch/send email and files (via the user's own connected accounts), translate
live, generate images, reply on your behalf when you're offline, and quietly watch
for scams and grooming — warning the target privately. This in-thread, async,
everyone-sees-her-working presence is the core thing WhatsApp's bolt-on sidebar AI
cannot copy.

## 2. What already exists (reuse map)

~60% of the hard parts are built. New work is mostly wiring + a few primitives.

| Capability | Already in repo | Reuse for |
|---|---|---|
| Transport | `InboxDO` (per-user WS + SQLite), `broadcast()`, system frames | In-thread Ava turns + "working…" chips |
| Brain / RAG | `UserBrain` DO, Vectorize (uid-scoped), `DB_BRAIN` graph, importance decay | Memory recall, "catch me up", `/api/brain/chat` |
| Agents | `AgentDO` + `ConversationDO`, per-app personas, prompt-injection defense, budget circuit-breaker | Auto-reply on your behalf, companion personas |
| Safety | `llama-guard-3-8b` (persona + convo moderation) | Guardian gate, content moderation |
| Money | AvaWallet ↔ AvaBrain metering | Paid features, top-up gating |
| Reasoner | Gemma 4 26B-A4B on Workers AI | The in-thread agent loop |
| Voice | ElevenLabs MCP | Ava's voice (toggle in Settings) |
| Image | Gemini Nano Banana 2 (3.1 Flash Image) | In-chat generation |

## 3. Architecture — the spine

Every feature inherits the same four-part spine. Build it once.

### 3.1 Ava-in-thread runtime
- New message **kinds**: `ava` (feminine bubble, visible to thread) and `ava_private`
  (delivered to one recipient only — powers Guardian warnings & "just-for-me" answers).
- New **visibility scope** on InboxDO append: `thread` vs `to:<uid>`. A private warning
  must *never* route to the other party — enforced at the DO, not the client.
- Server-side **agent loop** posts into the *existing* conversation (not a new thread),
  emitting a live `ava_status` system frame ("Ava is working…") via `broadcast()`,
  then the result message when done. Fully async / non-blocking.

### 3.2 The gate (cheapest model, runs first)
- A small Workers-AI classifier decides per message: *does this turn need Ava / a tool /
  a safety check at all?* Default answer is **no** — most messages are human↔human and
  never touch an LLM.
- Fires on: explicit summon (`@ava`/button), enabled features (Guardian, mention
  auto-reply), or a safety signal. This is the single biggest cost lever.

### 3.3 Tool layer — Klavis Strata (self-hosted)
- Progressive disclosure: Ava calls `discover_…` → `get_category_actions` →
  `get_action_details` → `execute_action`, so she only loads the *one* action's schema
  she's about to run — never the full catalog. Solves Tool Overload + Context Overload.
- Per-user OAuth handled by Strata (`handle_auth_failure` → connect flow). Users connect
  **their own** Gmail/Drive/etc.; tokens are user-scoped, never shared across accounts.
- **Always-on core tools (~5–7):** `brain.search`, `library.fetch`, `image.generate`,
  `translate`, `schedule`, `send_to`. Everything else is discovered on demand.
- Free-bundled vs subscription tools enforced at the broker before `execute_action`.

### 3.4 Context budget (the Context-Overload fix)
- Never send the whole thread. Send **recent window + rolling summary** (summary kept
  by the cheap model, stored in the conversation). Same artifact powers "catch me up".
- **Selective RAG:** retrieve top 3–5 vectors only when intent needs memory; embed-retrieve
  then **Gemma re-rank** the candidates.
- Persona/system prompt kept small + stable (caches well); thread + tool output wrapped
  as **untrusted quoted data** (prompt-injection defense, as `ConversationDO` already does).
- Hard token caps per section (persona / window / RAG / tools).

### 3.5 Two-lane memory
| Lane | Store | Embedder | Cost | Use |
|---|---|---|---|---|
| **Free / private** | SQLite FTS5 + ZVEC or ObjectBox (on-device) | on-device (see §4) | ~0 to us | "find my messages/files", private-chat memory |
| **Premium / server** | Vectorize + UserBrain | Workers-AI bge-m3 | metered | cross-device recall, heavy agentic RAG |

Keyword FTS5 answers most "find that message" with no AI. Vector search only on miss.
Index **lazily & selectively** (skip trivia like "ok 👍").

## 4. Embedding models

- **On-device free lane:** **bge-small-en-v1.5** (~30–45 MB) default; **EmbeddingGemma
  300m** (~150–200 MB, 100+ languages, Matryoshka 768→256→128, <200 MB RAM) as an opt-in
  multilingual upgrade. Store vectors at **256-D** to keep on-device storage small.
- **Server premium lane:** Cloudflare **Workers AI bge** (bge-m3 multilingual) — no model
  shipped, billed per-neuron.
- **What it does:** converts each message/file-chunk into a meaning vector; query is
  embedded and nearest-neighbor-searched → top-k ids pulled from SQLite/Vectorize. Powers
  search, recall/RAG, "catch me up", dedup, and Guardian pattern-matching.

### App-size impact
- Vector engine + inference runtime (bundled): **~10 MB** added to base app.
- Embedding model is **downloaded on first use**, not in the APK (Play Asset Delivery /
  iOS on-demand resources): one-time **~40 MB** (bge-small) or **~180 MB** (EmbeddingGemma).
- Vectors are runtime data (~25 MB per 100k messages at 256-D), prunable — not app size.
- **Casual free users who never enable on-device Ava carry zero extra weight.**

## 5. Tech stack

| Layer | Choice |
|---|---|
| Client | Flutter (existing AvaTOK app), Drift/SQLite, FTS5, ZVEC/ObjectBox |
| On-device inference | LiteRT / ONNX Runtime Mobile |
| Transport | InboxDO (Durable Object, hibernatable WS + SQLite) |
| Reasoner | Gemma 4 26B-A4B (Workers AI) |
| Gate / classifier | small Workers-AI model + llama-guard-3-8b |
| Memory | UserBrain DO + Vectorize + DB_BRAIN (server); ZVEC + FTS5 (device) |
| Tools / connectors | **Klavis Strata (self-hosted)**, per-user OAuth |
| Image gen | Gemini **Nano Banana 2** (3.1 Flash Image) — premium |
| Voice | **ElevenLabs** (Settings toggle) — premium |
| Money | AvaWallet (AvaCoins), $5 min top-up |
| Backup/sync | SQLite (truth) → R2 (premium sync) / Google Drive (free backup) |
| Push | existing `notifications.ts` / push_service |

## 6. Feature list

Tags: **[Free]** included · **[Paid]** wallet/subscription.

### A. Assistant in chat
- Find a file/message you discussed (semantic search) **[Free]**
- Summarize / "catch me up on this thread" **[Free]**
- Live translation — everyone reads in their own language **[Free]**
- Voice-note transcription + translation **[Free]**
- "Send this to my email" / "pull yesterday's attachment from Jeff and post it" (MCP) **[Paid]**
- Set a reminder / booking / calendar event **[Free core, MCP targets Paid]**
- Draft / tone-rewrite my reply **[Free]**

### B. Companion (new blank Ava chat)
- "New chat with Ava" — brainstorm, vent, language practice **[Free]**
- Custom personas + roleplay (adult-gated, llama-guard boundaries) **[Free chat / Paid voice]**
- Ava voice via ElevenLabs **[Paid]**

### C. Delegate / autopilot
- Reply on my behalf when offline / when `@mentioned`, disclosed as "Ava — for <name>" **[Free]**
- Alert me on mentions (push) **[Free]**
- "Tell them I'm busy" / book on my behalf **[Free core, MCP Paid]**

### D. Guardian / safety
- Scam & spam flag **[Free]**
- Grooming/luring detection with **private** warning to the at-risk person **[Paid: always-on]**
- "Is this stranger trustworthy?" check **[Free on-demand]**
- Deepfake / AI-image detection on incoming media **[Paid]**
- Weekly safety digest to the **parent** account for child users **[Free]**

### E. Group co-pilot
- Missed-message summary, action items, decisions log **[Free]**
- Suggested polls, light moderation **[Free]**
- Meeting notes from a group call (LiveKit + ElevenLabs STT) **[Paid]**

### F. Generative (premium)
- "Ava, make me a logo/image about X" → async generate (Nano Banana 2), group sees
  "Ava is generating…", she drops it in when ready **[Paid]**
- Edit an image ("make it blue"), stickers/memes from the convo **[Paid]**
- Short AI video clips (Higgsfield), AI voice notes **[Paid]**

### G. Verse concierge
- "Book me with this creator", "top up my wallet", "what did I earn this week" — wired to
  existing booking/wallet/insights routes **[Free core, actions vary]**

### H. Accessibility
- Voice-note↔text, text→voice, image descriptions **[Free]**

## 7. Free vs Premium & wallet

- **Free core:** Ava chat, summaries, translate, memory recall (server lane allowance +
  unlimited on-device lane), basic scam/spam flag, smart replies, accessibility.
- **Paid (deduct AvaCoins / subscription):** MCP tool execution (some connectors bundled
  free, others monthly sub), image/video generation, ElevenLabs voice, always-on Guardian.
- **UX:** Settings → Ava page with two sections — *Included* and *Premium (top up to use)*;
  every premium row shows a **PAID** badge. A `PaidFeature` wrapper checks balance at point
  of use and either runs (with a cost preview, e.g. "Generate image — 20 coins") or opens
  the **$5** top-up sheet.
- Even though users aren't charged for free features, the **gate** (§3.2) still protects
  *our* bill — the LLM stays asleep by default.

## 7.1 AI vs non-AI modes, onboarding & BYO key (LOCKED)

AvaTOK is now **two products in one app**, chosen by the user:

### Two modes
- **Plain messaging (no AI):** a clean, fast messenger (text, media, voice notes, calls,
  groups). No Ava surfaces, no AI cost. This is the default for anyone who skips the AI step.
- **AI-enabled (Ava):** unlocks every Ava feature in §6. Turned on at onboarding or later
  via the Settings **BYO-AI toggle**.

### Onboarding flow
1. After account creation, show an **"Add AI to your chats?"** step.
2. **Skip** → plain messaging mode (can enable later in Settings).
3. **Add AI** → run the **BYO Gemini key** flow (below), then all Ava features light up.

### Settings
- **Settings → Ava → "Use my own AI (BYO key)"** toggle. Toggling on runs the same key
  flow; toggling off reverts to plain messaging (key stored, reusable).
- Premium features keep their **PAID badge** and top-up gating (§7) regardless of mode.

### BYO Gemini key flow (primary AI unlock — $0 inference cost to us)
The non-technical path, using Google's own consumer tooling:
1. Tap **"Connect free Gemini AI."**
2. App opens **Google AI Studio** → user taps **"Get API key" → "Create in new project."**
   Google auto-creates the project + free-tier key (no billing, no Cloud Console).
3. User copies the key, returns to AvaTOK, **pastes it**.
4. Key stored **encrypted, per-account-scoped, revocable**; **all calls routed through our
   worker** so **llama-guard + the gate still apply** (our platform, our policy). Never
   called from the client; never returned to the client.
5. Ava now runs on the **user's own free Gemini quota** → inference cost to us = **$0**.

Caveats surfaced to the user: Gemini free-tier requests **may be used by Google to improve
their products** (steer sensitive chats to the private on-device lane / paid lane); free
tier is **rate-limited** (~10 RPM); **one key per user — no pooling**.

### Why NOT auto-create the key for them (rejected)
A "sign in → we create the project → call with your OAuth token" flow is **not viable**:
- `cloud-platform` is a **restricted scope** → requires Google **CASA** audit; until passed
  the app is **capped at 100 users for the project's lifetime (non-resettable)** + shows an
  "unverified app" warning.
- **Google Cloud ToS must be accepted manually** by the user — cannot be done programmatically.
- The broad consent screen tanks consumer conversion.
AI Studio already does the consumer-friendly project+key creation, so we lean on it instead.
(If Google ever ships a true "use my plan" consumer sign-in, adopt it then.)

### Anti-abuse tiering (server-side, before any model call)
Ava is a **doer** (find, fetch, translate, generate, protect), not an open-ended ChatGPT.
- **AI on our keys (free, for non-BYO users):** cheap model (Gemma/Workers AI), bounded
  context, **daily cap** (~20–30 turns/account/day), **no web search, no file analysis**.
  Feature flags: `webSearchEnabled`, `fileAnalysisEnabled`, `openChatUncapped`,
  `dailyAvaTurnLimit`.
- **AI via BYO Gemini key:** full features on the user's quota; we still moderate + gate.
- **Premium (wallet):** removes the cap; unlocks web search, file analysis, long open chat,
  image/voice/MCP. The home for "discuss for hours."
- **Other BYOK (OpenAI/Anthropic/OpenRouter, paid keys):** still supported for power users;
  consumer subscriptions (ChatGPT Plus, Google AI Pro) are **not** API-accessible — do not
  pursue.

## 8. Backup & sync

- **Source of truth:** on-device SQLite (always, free).
- **Premium cross-device sync + full AvaBrain:** **R2** (no egress fees; we hold it,
  encrypted at rest). A premium selling point: "your chats on every device, with Ava's
  full memory."
- **Free user-owned backup:** optional encrypted backup to the **user's Google Drive**
  (their account, their cost, survives uninstall — the WhatsApp model). Note: target Drive
  (storage), not Google Docs.
- **Private on-device-only chats:** client-side-encrypt before any backup so neither we
  nor Google can read them.

## 9. Safety, consent, child protection

- **Persistent "Ava is active in this chat" indicator** for *all* participants whenever any
  AI feature touches the thread. Non-negotiable (trust + app-store review).
- **Auto-replies always disclosed** as "Ava — for <name>"; never impersonate the human.
- **Guardian private warnings** use the `ava_private` scope — airtight, enforced at the DO.
- **Generative moderation:** llama-guard on prompts *and* outputs (deepfake/abuse risk),
  especially with parent+child sharing a device.
- **Companion/roleplay** age-gated to verified adults (L-tier identity).
- **Per-account scoping** (existing rulebook): all Ava state namespaced via
  `scopedKey`/`AccountScope` — no leakage across parent/child accounts on one phone.

## 10. Menu focus mode

- `AppRegistry` already has `standard` vs `hidden` tiers. A `focusMode` flag (in
  `routes/config.ts` kill-switches) flips non-AvaTOK apps to hidden so the drawer shows
  **AvaTOK + account essentials** only. Fully reversible. Wallet stays visible (paid features).

## 11. Cost model (our bill)

Ordered by spend: premium generation (covered by wallet) > reasoner turns (only when
summoned/triggered) > Guardian classifier (only on enabled chats) > embeddings/recall
(cheap, lazy) > everything else (free, local). Every expensive path is tied to an explicit
user action or a feature they switched on — which is exactly what the wallet bills against.

## 12. Phased rollout

| Phase | Deliverable |
|---|---|
| **0** | Menu focus mode (flag flip) + PaidFeature badge scaffold + AI/non-AI mode switch, onboarding "Add AI?" step, BYO Gemini key flow (AI Studio → paste → encrypted store) |
| **1** | Spine: `ava`/`ava_private` message kinds, "working…" chip, the gate, manual `@ava` in 1:1 over UserBrain |
| **2** | Strata self-host + tool broker; core tools + first paid MCP (Gmail/Drive); image gen (Nano Banana 2) |
| **3** | Two-lane memory: on-device FTS5 + ZVEC + embedder download; server lane wired to Vectorize |
| **4** | Companion / blank Ava chat + personas + ElevenLabs voice toggle |
| **5** | Delegate: group monitoring, `@mention` auto-reply (disclosed), push alerts |
| **6** | Guardian: live classifier, private warnings, deepfake detection, parent digest |
| **7** | Backup/sync: R2 premium sync + Google Drive free backup |

## 13. Primary touchpoints (existing files)

- Transport/runtime: `worker/src/do/inbox.ts`, `worker/src/routes/messaging.ts`
- Brain: `worker/src/do/user_brain.ts`, `worker/src/routes/brain.ts`
- Agents: `worker/src/do/agent.ts`, `worker/src/do/conversation.ts`, `worker/src/routes/agent.ts`
- Config/flags: `worker/src/routes/config.ts`
- Client chat: `app/lib/features/avatok/chat_thread.dart`, `chat_list.dart`
- Menu: `app/lib/shell/ava_sidebar.dart`, `app/lib/core/app_registry.dart`
- Notifications: `worker/src/routes/notifications.ts`

---

*Draft 1 — pending davy's call on the four open decisions in the header.*
