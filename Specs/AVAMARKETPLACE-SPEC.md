# AvaMarketplace — buy/sell/social marketplace with agent negotiation

**Status:** Spec / streamlined — 2026-06-30. **PLAN ONLY — no app code yet (owner decision).**
Builds on the AvaDeal negotiation engine (`Specs/AGENTIC-NEGOTIATION-MARKETPLACE.md`) and existing
Phase-6 creator pipeline.
**Principle: reuse first.** Most pieces already exist; this is mostly extension + new safety/agent glue.

### Owner decisions locked (2026-06-30)
- **Connector only — no money/coins flow through the platform.** Free to use; no fees, escrow, or
  AvaCoin charges. We just introduce two parties; they transact themselves.
- **Social type = dating, matrimony, roommate, community events** (see §1).
- **Listing eligibility = 3-factor identity gate (see §5b).** Video ID + email-OTP + phone-OTP, all
  via the existing identity pipeline. **Unhide the Identity menu**; Identity is the **single source of
  truth** for who may list.
- **Listing cap = max 5 new listings per user per day** (technical throttle, not a charge; see §7 #4).
- **Image safety NOW = adult/NSFW blocking only.** CSAM detection service is **deferred — chosen
  later** (P8); not a launch blocker for the build, but required before a wide public open.
- Build start: **none yet — planning only.**

---

## 0. What ALREADY exists (reuse map)

| Need | Already in repo | Action |
|------|-----------------|--------|
| Marketplace browse page | `app/lib/features/explore/explore_home.dart` (+ `explore_search.dart`, `widgets.dart`) | Reuse as the Marketplace page |
| Create-listing pipeline | `app/lib/features/listings/create_listing_flow.dart` (6-step stepper) | Extend: add Buying/Selling/Social types + dynamic forms + AI-assist |
| Listing detail page | `app/lib/features/explore/listing_detail.dart` | Extend: Message Owner, Call Agent, AvaTOK number, Sold badge |
| Listings API + categories | `app/lib/core/listings_api.dart` | Extend: type, expiry, sold, edit, agent-call ledger |
| Content moderation | `worker/src/lib/ai_gate.ts` `moderate()` → `nvidia/nemotron-3.5-content-safety` via OpenRouter; client `app/lib/core/moderation_service.dart` | Reuse for listing text + PII strip |
| AI search (RAG) | Cloudflare AI Search (live RAG since 2026-06-18), `worker/src/lib/ava_search.ts`, RagService | Reuse — **ONE shared marketplace index** (per owner rule: no multiple instances) |
| Agent negotiation + deal audio | AvaDeal: NegotiationDO + Gemini 2.5 multi-speaker TTS (`agent_tts.ts`) | Reuse — "Call Agent" triggers it |
| Sidebar menu | `app/lib/shell/ava_sidebar.dart` + `app/lib/core/app_registry.dart` (`explore` entry, currently hidden tier) | Add expandable Marketplace group w/ submenus |
| Push | Novu + FCM | Reuse for deal audio + moderation-reject notices |
| KYC / identity gate | `app/lib/features/identity/identity_gate.dart` | Reuse on Publish |

---

## 1. Sidebar: Marketplace menu + submenus

Add an **expandable "Marketplace" group** to `ava_sidebar.dart` (same pattern as the collapsible
ACCOUNT section), with three destinations wired through `AvaShell._openDest`:

- **Marketplace** → browse page (`explore_home`)
- **Create Listing** → `CreateListingFlow`
- **My Listings** → new `MyListingsScreen`

Un-hide / repurpose the existing `explore` AppEntry (id `explore`, "AvaExplore / Marketplace") or
add a dedicated `marketplace` group key. Keep it behind a `marketplaceEnabled` remote-config flag.

---

## 2. Create Listing pipeline (extend the existing stepper)

**Step 1 — Type.** Buttons: **Selling**, **Buying** (want-to-buy / reverse listing), **Social**, plus
the existing creator **Service** types kept as-is. Type drives the rest of the form.

**Social** sub-types (owner decision): **Dating, Matrimony, Roommate, Community events.** These reuse
the same agent-negotiation flow as a connector/matchmaker (the matrimonial POC is exactly this — two
matchmaker agents discuss family/caste/expectations, then connect the humans). Mandate fields differ
per sub-type (e.g. Matrimony: caste/diet/location prefs; Roommate: budget/move-in/gender pref).
Note: keep distinct from the standalone AvaMatri/AvaTind apps — here they are marketplace listings, so
share models where sensible but don't duplicate those apps' full UX.

**Step 2 — Dynamic form by type + category.** Title, description, **category** (from
`ListingsApi.categories()`; Selling has many sub-categories — reuse them), **price + currency**
(Selling/Buying), condition, location, photos. Category chosen here is what AI search + filtering key on.

**Pricing is multi-currency (global, not USD-only).** A **currency picker** (full ISO-4217 list —
INR, RUB, USD, AUD, EUR, GBP, …, default from the user's locale) sits next to the amount. Store
`price_amount` + `price_currency` on the listing. Implications:
- **Display:** show each listing in its **native currency** on cards/detail; optionally show the
  buyer's local equivalent via an FX snapshot.
- **Search/sort/filter by price:** also store a **normalized `price_base` (e.g. USD)** computed from a
  daily FX-rate snapshot so range filters and sorting work across currencies.
- **Agent negotiation:** mandates (floor/target/max) are in the **listing's currency**; the buyer
  enters their max in that same currency (convert-and-prefill from their locale for convenience). The
  deal-audio speaks the listing's currency.
- **No money flows through us.** We are a **connection platform only** — no AvaCoins, no fees, no
  escrow, no charging on listings or agent calls. Currency on a listing is purely **display +
  negotiation context**. The legacy `priceCoins = usd*100` assumption in `create_listing_flow.dart` is
  **removed** (it implied a coin charge); store plain `price_amount` + `price_currency` instead. The FX
  snapshot exists **only** to normalize prices for cross-currency **search/sort/filter** — never for
  billing.

**Step 3 — Agent instructions.** A prompt box where the owner tells *their* agent how to negotiate.
- For **Selling**: floor price, target price, non-negotiables (e.g. "no offers below 2000, aim 3000, pickup only").
- For **Buying**: max price, must-haves.
- Show a **worked example** inline so users learn the format:
  > *"You represent me selling a 2018 Honda Civic. Floor 2000 USD, target 3000. Mention low
  > mileage + full service history. Don't accept pickup later than this week. Be polite, firm on price."*
- **"Help me write" button** → calls OpenRouter **Claude Sonnet** (`anthropic/claude-sonnet`) with the
  Step-2 form fields → returns a short, clean instructional prompt the user can edit. (Same OpenRouter
  plumbing already used for Guardian shield / image gen.)

**Step 3b — Agent language.** Owner picks their agent's **default/preferred negotiation language** and
an optional **accent/persona descriptor** ("speak English with a Punjabi accent", "warm formal Hindi").
At negotiation time: if **both** agents share a language → converse in it. If **not** → both fall back to
**English**, each agent keeping its owner-described accent/persona. The deal-audio render (Gemini 2.5
multi-speaker TTS) speaks the chosen language (24 supported) and steers accent via the persona prompt
prefix. Store as `agent_lang` + `agent_voice_persona` on the listing/mandate.

**Step 4 — Photos** (reuse existing cover-photo upload + `image_picker`).

**Step 5 — AI-assist + Preview.** "Write my title" / "Write my description" buttons (OpenRouter Claude
Sonnet) generate safe, compliant copy from the form → reduces junk + unsafe text at the source.
Preview-as-buyer (existing A6 step) → **Publish** → **3-factor identity gate (§5b)** → enters the
**moderation queue** (§5). Also enforce the **5-listings/day** cap here.

---

## 3. Marketplace browse page

Cards: **photo, title, price, short description**, category chip, country/flag, Sold/Expiring badges.
Filter by category. **Search = single shared Cloudflare AI Search index** (semantic + keyword) over
active listings; no per-user instance. Indexing happens on publish-approve; de-index on sold/expire.

---

## 4. Listing detail page — actions

- **Message Owner** → opens the messenger thread to the owner (call or text). Always available.
- **Show owner's AvaTOK number** → tap-to-dial inside AvaTOK.
- **Call Agent** (the negotiation button):
  - On tap, capture the **buyer's mandate** (quick sheet: "your max price / must-haves") — needed
    because the negotiation requires *both* sides' constraints.
  - Queues an **AvaDeal NegotiationDO**: buyer's agent ↔ owner's agent negotiate in text using the
    **latest Claude Sonnet via OpenRouter** (`anthropic/claude-sonnet-4.6`, slug kept in config).
    **Audio is rendered ONLY if they reach a DEAL** — the verbatim transcript becomes a 2-voice note
    (Gemini 2.5 multi-speaker) dropped into **both** chat threads + Novu/FCM push. **On IMPASSE no audio
    is generated** (TTS costs money) — at most a small text "no match" note.
  - **One negotiation per buyer per listing VERSION (not per listing).** Every listing carries a
    `content_version` that bumps whenever the owner edits a material field (price, description, photos,
    terms, mandate). The ledger row is `listing_agent_calls(buyer_user_id, listing_id, content_version)`.
    Rule:
    - First contact about listing A → no row → **allowed**; afterwards the row exists → **Call Agent
      greyed**, only Message Owner remains.
    - Owner A **edits** listing A → `content_version` bumps → no row for the new version → **green light
      again** (agent B may re-negotiate the changed listing).
    - Owner A posts a **new** listing C that B never talked to → different `listing_id` → **allowed**.
    - Same rule governs the **matchmaker auto-discovery** path: when agent B "passes by" and a listing
      matches its owner's criteria, the matchmaker checks the ledger by `(B, listing, content_version)`
      before auto-initiating — so it never re-pesters about an unchanged listing it already discussed.
    (Saves LLM + TTS cost; abuse guard; still lets genuine changes reopen a conversation.)
- **Sold:** owner marks the listing **Sold** (from My Listings or detail) → removed from browse + AI
  Search, badge shown.

---

## 5. Safety / moderation pipeline (queue)

On **Publish** and on every **Edit**, the listing enters a **moderation queue** (Cloudflare Queue +
consumer; reuse the existing consumer pattern) and stays `pending` until cleared:

1. **Text moderation** — title + description through `ai_gate.ts moderate()`
   (`nvidia/nemotron-3.5-content-safety` via OpenRouter). Reasoning model judges porn/violence/hate/scam.
2. **PII strip** — remove phone numbers and emails from the description, including **obfuscated/cunning
   formats** ("nine eight seven…", "name [at] gmail dot com", unicode look-alikes). Use Claude Sonnet via
   OpenRouter with a strict extract-and-redact prompt (LLM beats regex for obfuscation), then a regex
   backstop. Contact happens *inside* AvaTOK only.
3. **Image moderation** — every uploaded photo checked for nudity/porn/sexual content via a **vision**
   safety model (Workers AI image classifier or an OpenRouter vision model) → reject on hit.
4. **Decision** — all-clear → `active`, index in AI Search, publish. Any fail → `rejected`, listing
   hidden, owner gets a Novu/FCM + in-app notice with the **reason** ("rejected: adult content in photo 2"
   / "description didn't meet standards"). Suggest a fix.
5. **Intent helper** — Claude Sonnet reads the listing and suggests improvements / safer wording, and
   powers the Step-5 AI-assist buttons (so most listings pass first time).

---

## 5b. Listing eligibility — 3-factor identity gate (source of truth)

**No one can publish a listing until they pass all three** (reuse `features/identity/identity_gate.dart`
+ the existing identity pipeline; no new verification stack):

1. **Video identity verification** — the existing video-ID/liveness pipeline.
2. **Email OTP verified** — already satisfied for accounts created with an email; surface it as a
   **ticked** item in Identity (don't re-ask if already verified at signup).
3. **Phone OTP verified** — phone-number OTP check.

When all three are green, the account is **list-eligible**. The **Identity screen is unhidden in the
sidebar** (`app_registry.dart`: flip `avaidentity` from `hidden` → `standard`) and becomes the **single
source of truth**: the Create-Listing Publish step calls the same eligibility check, and if any factor
is missing it routes the user to Identity to complete it rather than letting them publish. Store an
`is_list_eligible` derived flag (video✓ && email✓ && phone✓) the marketplace reads. Re-check on every
publish (not cached forever) so a revoked/expired verification blocks new listings.

---

## 6. Lifecycle: expiry + sold + edit

- **Expiry date** mandatory on every listing (default e.g. 30 days). A **Cron** expires past-date
  listings → `expired`, de-indexed from AI Search, hidden from browse. Owner can **renew** from My Listings.
- **My Listings** screen: all of the owner's listings with status (active/pending/rejected/sold/expired).
  Tap one → **edit** price, photos, description, category, expiry → re-enters moderation queue. Buttons:
  Mark Sold, Renew, Delete.

---

## 7. GAPS / things to decide (you asked what we're missing)

1. **CSAM is NOT an LLM job. [DECIDED — deferred]** For now we do **adult/NSFW blocking only** (vision
   classifier rejects porn/nudity). The dedicated **CSAM hash-match + reporting service is chosen
   later** (P8) — still required before a wide public open, but not part of the current build scope.
2. **Buyer mandate source** — captured at "Call Agent" time (proposed above) vs. derived from a Buying
   listing. Confirm.
3. **"Social" listing type [DECIDED]** — Dating, Matrimony, Roommate, Community events (see §2).
   Reuses agent matchmaking; keep distinct from the AvaMatri/AvaTind standalone apps.
4. **Cost guard (our infra cost, NOT charged to users) [DECIDED].** **Max 5 new listings per user per
   day.** Plus the per-listing-version negotiation rule already bounds agent-call spend. All are
   technical throttles — **no AvaCoin charge**; the platform is free.
5. **Anti-scrape** — stop agents being abused to harvest competitors' floor prices (throttle, never
   reveal the mandate, only the transcript).
6. **Escrow/payments — never.** No money flows through the platform; the two parties transact
   entirely themselves after the agents connect them. We are the introduction, not the wallet.
7. **Re-moderate on edit** — included above; make sure edits can't bypass the queue.
8. **Per-account scoping** — all new local state (draft listings, agent-call ledger cache) must use
   `scopedKey`/`AccountScope` per the rulebook.

---

## 7b. Telemetry (PostHog) — instrument everything

Full event taxonomy + cost model lives in `AVAMARKETPLACE-FINAL-PROPOSAL.md §9`. Summary: reuse
`Analytics.capture(...)`; every event carries `user_email`, `user_phone?`, `account_id` (per-account
scoped), `app_version`, `platform`. Track identity/eligibility, listing lifecycle, moderation results,
browse/search, the full negotiation loop, and **deal-audio with per-file cost** (`char_count`,
`audio_seconds`, `audio_bytes`, `tts_cost_usd`, `r2_key`) plus `negotiation_outcome.llm_cost_usd`.
Impasse logs `tts_cost_saved_usd_est`. Dashboards: funnel, negotiation outcomes, cost tracker, safety,
per-user lookup. Add a PostHog annotation per phase ship.

---

## 8. Proposed build order (phased, one-issue-per-commit)

- **P1 — Navigation:** Marketplace group + submenus in sidebar; route Create Listing / My Listings /
  Browse. **Also unhide the Identity menu** (`app_registry.dart`: `avaidentity` hidden → standard).
- **P2 — Create Listing v2:** Buying/Selling/Social types, dynamic forms, agent-instructions step, example.
- **P3 — AI-assist:** "Help me write" + title/description buttons (OpenRouter Claude Sonnet).
- **P4 — My Listings:** list + edit + mark sold + renew + expiry cron.
- **P5 — Detail actions:** Message Owner, AvaTOK dial, Call Agent (one-time ledger) → AvaDeal queue.
- **P6 — AI search:** single Cloudflare AI Search index over active listings (index/de-index hooks).
- **P7 — Safety queue:** text + PII-strip + adult/NSFW image moderation, reject-with-reason notices.
  Also enforce the **3-factor identity gate (§5b)** and **5-listings/day** cap at Publish.
- **P8 — CSAM hardening [deferred]:** pick + integrate a dedicated hash-match + reporting service
  before a wide public open (gap #1). Not in current build scope.

Backend lives in `worker/`; Flutter UI in `app/lib/features/{listings,explore}`. No local builds
(CI only). Commits via `scripts/git_safe_commit.py` with explicit paths; do not push without ask.
