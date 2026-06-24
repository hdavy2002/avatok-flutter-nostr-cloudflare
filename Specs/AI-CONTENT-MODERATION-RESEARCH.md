# AI Text Validation & Content Guardrails — Research + Architecture

**Status:** Research / architecture proposal (no code yet)
**Date:** 2026-06-24
**Engine:** `nvidia/nemotron-3.5-content-safety:free` via **OpenRouter**
**Scope:** App-wide AI validation of user-authored free text, with save-button gating on
client + hard enforcement on the Cloudflare Worker.

---

## 1. The problem, stated precisely

You have many fields where a user types text that is either (a) shown to other users or
(b) fed to an AI as instructions. Two distinct failure modes need to be caught:

| Failure mode | Example | What it requires |
|---|---|---|
| **Identity/format abuse** — a field that must look like a specific kind of value | First name = `Fuck Trump`; handle = a slur | Safety classification (block the abuse) + a cheap local plausibility check |
| **Free-text intent abuse** — any text is structurally valid but the *intent* is disallowed | Receptionist prompt: *"Tell callers my rate is 4000rs, contact 789448494, I will…"* | Safety classification across sexual / solicitation / harassment / PII categories |

Both are handled by the same moderation engine below. The only thing the engine does **not**
decide is "is this a syntactically plausible name?" (e.g. rejecting `xqz12345`) — that's a
trivial local regex/length check, not an AI decision, and is kept separate.

---

## 2. The engine — `nvidia/nemotron-3.5-content-safety:free`

A compact **4B-parameter multimodal guardrail model** from NVIDIA, fine-tuned from Google
**Gemma-3-4B**, served **free** on OpenRouter (`$0` input / `$0` output). Released 2026-06-04.

What it does (per the OpenRouter model card):

- Moderates **both inputs to and responses from** LLMs/VLMs.
- Accepts **text and image** input, returns text output:
  - a **safe / unsafe** classification for the user prompt and (optionally) the response,
  - **safety category labels**,
  - an optional **reasoning trace** (togglable reasoning mode).
- Covers **12 languages** — relevant for Hindi/Hinglish users.
- **128K** context window, up to 8,192 output tokens.
- Purpose-built for prompt/response moderation, content classification, and policy
  enforcement (it is a guardrail classifier, not a chat model).

Why this fits the two examples:

- `Fuck Trump` as a first name → returns **unsafe** with a profanity/harassment-type
  category → block save.
- The receptionist solicitation prompt → returns **unsafe** with sexual/solicitation
  category labels → block save. (Phone-number / contact-info policy can be added as a custom
  rule in the system prompt we send to the model, plus a cheap local regex for digits.)

**Cost:** free on OpenRouter. No GCP project, no billing setup, no per-request cost.
Reuses the `OPENROUTER_API_KEY` already in `secrets/secret-values.env`.

> Note on the existing codebase: the Worker currently runs `@cf/meta/llama-guard-3-8b`
> (Cloudflare Workers AI) in seven AI paths via the central gate `worker/src/lib/ai_gate.ts`
> plus inline copies. Per owner decision (2026-06-24) most of those are being **removed** and
> the two that stay move onto Nemotron. See §2A for the full disposition. After this change,
> **Nemotron via OpenRouter is the single moderation engine** anywhere moderation remains.

---

## 2A. Disposition of the existing llama-guard gate (owner decision, 2026-06-24)

The existing `@cf/meta/llama-guard-3-8b` gate is being retired except for two surfaces, both
of which move to Nemotron.

| Call site | What it guards | Surface | Decision |
|---|---|---|---|
| `routes/ava_gemini.ts` | ChatAva personal AI chatbot | ChatAva | **Remove** moderation — stop routing through the guard |
| `do/ava_agent.ts` | @ava assistant replies in Messenger threads | Messenger AI | **Remove** guard |
| `do/conversation.ts` | agent-to-agent matchmaking conversation turns | Agent↔agent | **Remove** guard |
| `routes/ava_guardian.ts` | scam / grooming / predator watchdog over user-to-user DMs | Messenger | **Keep** — re-engine to Nemotron; add shield-icon UI (below) |
| `routes/ava_delegate.ts` | Ava's disclosed offline auto-reply | Messenger AI | **Remove** guard (AI reply trusted) |
| `routes/ava_image.ts` | image-generation prompt | Image gen | **Remove** guard (image model self-guards) |
| `routes/agent.ts` | agent persona text on save | Form field | **Keep** — re-engine to Nemotron |

**Net safety posture after the change:** the only AI moderation remaining is (1) the shield
watchdog on user-to-user chat and (2) save-time Nemotron validation of typed fields (agent
persona + the form fields in §3). All AI *output* moderation is removed.

**Implementation notes:**

- Five removals: strip the moderation step from `runGated`/`guardInput` for those callers (or
  bypass it), and remove the inline `GUARD` calls in `do/ava_agent.ts` and `do/conversation.ts`.
  `ai_gate.ts` keeps its kill-switch / intent / quota responsibilities; only the llama-guard
  moderation step is dropped for these paths.
- Two keepers (`ava_guardian.ts`, `agent.ts`) point at one shared `moderate()` helper that
  calls Nemotron via OpenRouter (replacing `isSafe`/inline `GUARD`).
- **Voice / video / audio calls were verified to have NO moderation gate** (`do/call_room.ts`,
  `do/reception_room.ts` = AI receptionist voice, `routes/conference.ts` = LiveKit groups,
  `routes/avavoice.ts`, `routes/ava_live.ts`/`live.ts` livestream — livestream "moderation" is
  creator kick/ban only). Nothing here changes; swapping the model does not affect calls.
- **Latency note:** llama-guard ran in-network on Workers AI; Nemotron is an external OpenRouter
  round-trip. Fine for low-volume save-time checks and the watchdog (which only escalates on a
  heuristic hit). Keep this in mind if any high-volume per-message path is ever re-added.

### Shield watchdog UI (new)

Per-chat **shield icon**: tap to toggle. **Green = on** → "Ava is watching this chat and will
alert you if someone tries to scam, groom, or harm you." When on, `ava_guardian` runs its cheap
string heuristics on each message AND — because the chat is being watched — runs the AI security
classifier on **every** incoming message (not just on a keyword hit); a confident
predator/scam verdict posts a PRIVATE warning (the model's tailored heads-up) to the at-risk
user only. Off = no AI scanning.

**Security engine (owner decision 2026-06-24): `anthropic/claude-opus-4.8` via OpenRouter.**
Security matters (grooming / luring / sextortion / scam detection) use the strongest reasoner,
not the lightweight content-safety model — a content-safety label alone missed nuanced
grooming like *"don't tell your mom, meet me secretly tonight."* Nemotron
(`nvidia/nemotron-3.5-content-safety:free`) remains the engine for save-time FIELD validation
(names, bios, listings, persona prompts); Opus 4.8 is reserved for the live shield watchdog.

> Fix history: the first cut only ran the model under PREMIUM "deep monitoring" or to confirm
> a cheap keyword hit, so a FREE secure-chat user got keyword matching only — the grooming
> test message above slipped through. Secure-chat ON now always invokes `classifyThreat`.

---

## 3. Where guardrails are needed — full input inventory

Audited across `app/lib/` (Flutter) and `worker/src/routes/` (Worker).

### 3.1 Tier A — Identity / format (Nemotron safety + cheap local plausibility check)

| Field | Client | Worker route |
|---|---|---|
| Sign-up name | `features/auth/sign_in_screen.dart` | `POST /profile` |
| Display name | `features/profile/profile_screen.dart`, onboarding | `POST /profile` `display_name` |
| @Handle | `profile_screen.dart`, `onboarding_flow.dart` | `POST /profile` `handle` |
| Receptionist "how Ava refers to you" / persona name | `features/settings/sections/receptionist_section.dart` | `PUT /api/receptionist/settings` `display_name`, `persona_name` |
| AvaVoice / AvaVision agent name, role | `features/avavoice|avavision/studio/agent_form_flow.dart` | `POST/PUT /api/avavoice/agents` `name`, `role` |
| Listing title | `features/listings/create_listing_flow.dart` | `POST/PUT /api/listings` `title` |
| Community name | `features/communities/communities_tab.dart` | — |
| Payout label / account-holder name | `features/payout/payout_screen.dart` | payout route |

### 3.2 Tier B — Free-text intent abuse (full Nemotron safety classification)

Highest risk. Shown to others or used as AI instructions.

| Field | Client | Worker route | Why high-risk |
|---|---|---|---|
| **Receptionist instructions** (max 2000) | `receptionist_section.dart` `_instr` | `PUT /api/receptionist/settings` `instructions_text` | User-written AI behavior; injection + solicitation |
| **Receptionist advanced custom prompt** (max 1000) | `_custom` | `custom_prompt` | Can override safety scaffold — treat as untrusted |
| Receptionist greeting (200) / custom status (120) | `_greeting`, `_statusCustom` | `greeting_text`, `status_custom` | Caller-heard; contact-info / solicitation |
| **AvaVoice/AvaVision system profile** (max 8000) | `agent_form_flow.dart` `_profile` | `system_profile` | Largest free-text AI-instruction field |
| **Listing description** (max 8000) | `create_listing_flow.dart` `_desc` | `description` | Top spam / solicitation / contact-leak vector |
| Profile **bio** | `profile_screen.dart` `_bio` | `POST /profile` `bio` | Public text, no max enforced |
| Agent persona: `persona_prompt`, `looking_for`, `boundaries` | persona editor | `PUT /api/agent/personas/:app` | AI-instruction text |
| **Chat / messages** | `live_viewer_screen.dart`, `consult_room_screen.dart`, community chat | `POST /api/msg/send` `body` | Real-time harassment/spam |
| Image-gen prompt | `features/ava_generative/image_request.dart` | image route | NSFW / injection |
| "Ask Ava" prompt | `features/avaapps/avaapps_screen.dart` `_ask` | AvaApps route | Jailbreak vector |
| Community "about" | `communities_tab.dart` | — | Group description |
| Calendar event/slot title | `features/calendar/avacalendar_screen.dart` | calendar route | Shown to bookers |
| Admin manual-payment "reason" | `features/wallet/admin_money_screen.dart` | admin route | Free-text, unmoderated |

### 3.3 Tier C — No AI moderation (format/validation only)

Prices, rates, dates, country codes, category enums, bank/IFSC/tax IDs, verification codes,
passwords. Keep existing format validators; never send sensitive financial fields to any
external model.

---

## 4. Proposed architecture

### 4.1 Flow (client → Worker → OpenRouter/Nemotron)

```
User types
   │  (debounce 600–800ms after typing stops; skip if unchanged / below min length)
   ▼
Flutter calls  POST /api/moderate  { field_type, text, locale }
   │            Save button held DISABLED while a check is pending or last verdict ≠ safe
   ▼
Worker /api/moderate
   ├─ 0. hash(text) → KV cache lookup  (identical text ⇒ return cached verdict)
   ├─ 1. Tier A only: cheap local plausibility regex (length, char set) for names/handles
   ├─ 2. call OpenRouter → nvidia/nemotron-3.5-content-safety:free
   │        system prompt = our policy (per field_type: stricter categories for Tier B,
   │        explicit "no contact info / solicitation" rule, reasoning mode on)
   ├─ 3. parse { safe|unsafe, categories[], reason } → apply per-field policy
   └─ 4. cache verdict in KV (TTL), log to PostHog with user email
   ▼
Returns { verdict: allow | block, categories:[…], reason, suggestion }
   ▼
Client: allow ⇒ enable Save.  block ⇒ keep Save disabled + inline reason + fix hint.
```

### 4.2 Hard rule: the client gate is UX, the Worker gate is security

The disabled Save button is only convenience. **Every write route must re-run Nemotron
moderation server-side before persisting** and reject on its own authority — a scripted
client can skip the `/api/moderate` call. Bake the same check into `POST /profile`,
`PUT /api/receptionist/settings`, `POST/PUT /api/listings`, `POST/PUT /api/avavoice/agents`,
`POST /api/msg/send`, and `PUT /api/agent/personas/:app`.

### 4.3 Per-field policy (all powered by Nemotron)

| Field type | Block when Nemotron returns | On block, tell user |
|---|---|---|
| Name / handle / persona name | `unsafe` (any category) **or** fails local plausibility regex | "That doesn't look like a real name. Please use your name." |
| Bio / listing title+desc / greeting / status | `unsafe` in sexual, harassment, profanity, drugs/weapons, or solicitation; or local PII regex hits a phone/email where disallowed | Specific reason, e.g. "Remove the phone number and explicit language." |
| Receptionist / AvaVoice persona & custom prompt | `unsafe` in any category, or injection/jailbreak-type label | "Your AI instructions can't include contact details, explicit content, or attempts to override safety rules." |
| Chat messages | `unsafe` in harassment / threat / sexual | Soft warning + block send |

Tune the exact category set against real PostHog data after launch. Because the model is
free, you can run it on every Tier-A/B field without cost concern.

### 4.4 Cost & latency

- **Cost: $0** — the model is free on OpenRouter. No GCP, no per-request billing.
- **Latency** is the only real budget. Mitigate with: debounce, min-length skip, and a **KV
  verdict cache** keyed by `hash(normalized_text)` so identical resubmits (common for names)
  return instantly. Enable Nemotron's reasoning mode only where you need the explanation.
- Watch OpenRouter free-tier **rate limits**; if hit, queue server-side and/or self-host the
  open weights later (`huggingface.co/nvidia/Nemotron-3.5-Content-Safety`).

### 4.5 Failure & abuse handling

- **OpenRouter outage / rate-limit:** fail-**open** for low-risk identity fields (allow +
  queue async re-check), fail-**closed** for Tier-B prompt/persona fields (block save with a
  "try again shortly" message).
- **Rate-limit** `/api/moderate` per account; repeated blocked attempts → flag account for
  review.
- **Telemetry (per project rule):** log every block with category, field, and the user's
  email to PostHog so abuse patterns and false-positives are reviewable.
- **Privacy:** never send Tier-C sensitive fields (bank, tax ID, password) to OpenRouter.

---

## 5. Suggested build phases (for a later session)

1. **Worker `/api/moderate` endpoint** — OpenRouter call to
   `nvidia/nemotron-3.5-content-safety:free` using `env.OPENROUTER_API_KEY`, per-field system
   prompt, KV verdict cache, PostHog logging. Wire receptionist instructions end-to-end as
   the reference.
2. **Reusable Flutter widget** — a `ModeratedTextField` wrapper: debounce, pending state,
   Save-button binding, inline error/fix-hint. Drop-in for every Tier A/B field.
3. **Server-side enforcement** baked into every write route (security backstop).
4. **Roll out** to remaining Tier A/B fields; add local plausibility + PII regex helpers.
5. **Tune** category thresholds from PostHog; add per-account abuse escalation.

---

## 6. Open items to confirm before building

- **OpenRouter key:** `OPENROUTER_API_KEY` is present in `secrets/secret-values.env`.
  Confirm it's also set as a Worker secret (it's already used by `genui_planner.ts`), so
  `/api/moderate` can read `env.OPENROUTER_API_KEY` in production.
- **Exact response schema:** confirm the model's JSON shape (safe/unsafe field name, category
  label list, reasoning field) from a live test call so the Worker parser matches it.
- **Free-tier rate limits:** verify OpenRouter's free-tier QPS is enough for expected
  validation volume; plan self-hosting the open weights as the scale fallback.
- **Hindi/Hinglish quality:** spot-check the 12-language coverage on real local-language
  abuse samples.

---

## Sources

- [Nemotron 3.5 Content Safety (free) — OpenRouter model card](https://openrouter.ai/nvidia/nemotron-3.5-content-safety:free)
- [Nemotron 3.5 Content Safety — model weights (Hugging Face)](https://huggingface.co/nvidia/Nemotron-3.5-Content-Safety)
- [OpenRouter API reference](https://openrouter.ai/docs/api/reference)
