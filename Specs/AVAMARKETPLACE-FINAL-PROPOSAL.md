# AvaMarketplace — Final Proposal (plain-English) — v1.0 FINAL

**Date:** 2026-06-30 · **Status:** Final plan, agreed. Build not started yet (owner: planning only).
This is the single source of truth. It folds in: the agent-negotiation idea, the deal-audio engine,
the marketplace UI, the safety pipeline, the **language rule**, the **talk-once rule**, multi-currency
pricing, the **3-factor identity gate**, the **no-money/connector-only** principle, and the full
**PostHog telemetry & cost-tracking plan (§9)**. Detailed engineering lives in `AVAMARKETPLACE-SPEC.md`
and `AGENTIC-NEGOTIATION-MARKETPLACE.md`.

### All locked decisions at a glance
- **Connector only** — no money/coins/escrow flow through us; platform is free.
- **Listing types:** Selling, Buying, Social (dating, matrimony, roommate, community events) + existing Service.
- **Eligibility = 3-factor identity** (video ID + email + phone OTP) via the unhidden Identity menu (source of truth).
- **Cap:** max 5 new listings/user/day (throttle, not a charge).
- **Pricing:** any currency (ISO-4217), display native + normalized base for search only.
- **Negotiation brain:** latest Claude Sonnet via OpenRouter (text — cheap).
- **Deal audio:** Gemini 2.5 multi-speaker TTS rendered for **both outcomes**, dropped into both threads,
  colour-coded — **deal = green bubble, no-deal = pale-yellow bubble** (owner change 2026-06-30).
- **Language:** agents talk in a shared language else fall back to English with owner-set accent.
- **Talk-once-per-listing-version** gating (edits reopen; new listings are fresh).
- **Image safety:** adult/NSFW now; CSAM service deferred (P8).
- **Search:** one shared Cloudflare AI Search index.
- **Telemetry:** rich PostHog events on everything, incl. per-audio cost (§9).

---

## 1. What we are building, in one breath

A marketplace inside AvaTOK where people post things — **stuff to sell, stuff they want to buy, or
social listings (dating, matrimony, roommate, community events)** — and each person has an **AI agent**
with its own virtual AvaTOK phone number. The agents quietly find each other, **negotiate on their
owners' behalf in text**, and when they reach a deal they **record the conversation as a short voice
note in both owners' chat threads**. You wake up, tap play, hear how your agent did, and if you like it
you just say hello to the other person — you're already on the same thread, with their number in front
of you.

The whole thing is built to be **safe** (no porn, no leaked phone numbers, no scams) and **cheap**
(agents don't waste effort talking about the same unchanged listing twice).

**We are only a meeting place.** No money or coins ever pass through us. We simply introduce two people
and let their agents do the talking — the buyer and seller handle payment between themselves, however
they like. The platform is free to use.

---

## 2. The story (how it feels to a user)

1. **Ravi** posts his 2018 Honda Civic for sale. He tells his agent in plain words: *"Don't go below
   $2000, aim for $3000, mention the low mileage."* He picks his agent's language (English, Punjabi
   accent). He adds photos. He hits publish.
2. Behind the scenes we **check the photos and text** — no nudity, no hidden phone numbers or emails —
   then the listing goes live and becomes **searchable**.
3. **Meena** is looking for a car. Her agent is browsing and spots Ravi's listing. She taps **"Call
   Agent"**, tells her agent her max is $2500, and her agent and Ravi's agent **start negotiating**.
4. They settle at $2500. The exact back-and-forth is turned into a **two-voice voice note** and dropped
   into **both Ravi's and Meena's chat threads**, with a phone notification.
5. Next morning both of them play it, like what they hear, and **carry on the conversation themselves**
   — by chat or by dialling the AvaTOK number shown on the listing.

If the deal doesn't suit them, they ignore it. No pressure, no spam.

---

## 2b. Who is allowed to list (trust gate)

Before anyone can post a listing they must be a **verified real person** — proven once through our
existing Identity pipeline by passing **all three** of:
1. **Video identity check** (face/liveness),
2. **Email confirmed** (already done when they signed up with an email — just shown as ticked),
3. **Phone number confirmed** by OTP.

Only when all three are green can they publish. We **unhide the Identity menu** in the sidebar and make
it the **single source of truth** — if anything is missing, the app sends them there to finish it. Each
person can post **at most 5 new listings a day** (a simple limit to keep the place tidy and our costs
sane — it is not a charge).

---

## 3. The two clever rules you asked for

### Rule A — Language (so agents always understand each other)
- When making a listing, the owner picks their agent's **preferred language** plus an optional
  **accent/persona** ("warm formal Hindi", "English with a Punjabi accent").
- When two agents meet: **if they share a language, they talk in it.** If they don't, they **both
  switch to English**, each keeping the accent/voice its owner described.
- The final voice note is spoken in that language (we support 24), with the accent baked in.

### Rule B — Talk only once, but only while nothing changed
The goal: stop agents re-negotiating the same unchanged listing (wastes money), **but** let them talk
again when there's a real reason to.
- Every listing has a hidden **version number** that goes up whenever the owner changes something
  important (price, description, photos, terms, agent instructions).
- Agent B may negotiate about Listing A **once per version**:
  - **First time** → allowed. Afterwards the **"Call Agent" button greys out** (only "Message Owner" stays).
  - **Owner edits the listing** → version bumps → **the door reopens**, agent B can talk again about the
    new terms.
  - **Owner posts a brand-new listing** B never saw → **allowed**, it's a different listing.
- The same check guards the automatic "my agent was passing by and it matched" path — it never
  re-pesters about a listing it already covered, unless that listing changed.

---

## 4. What we already have vs. what we build (so this is fast)

**Already in the codebase — we reuse it:**
- The marketplace browse page, the create-listing wizard, and the listing detail page.
- The listings API and categories.
- The safety brain: an NVIDIA safety model (`nvidia/nemotron-3.5-content-safety`) wired through
  OpenRouter, plus a moderation client in the app.
- Cloudflare AI Search (already our live search engine) — we use **one shared index** for the marketplace.
- OpenRouter for AI writing help (we already call Claude through it elsewhere).
- The deal-audio engine: Gemini 2.5 multi-speaker text-to-speech (proven by the car, matrimony and
  Hindi-rent voice samples) — no NotebookLM, no ElevenLabs, no voice cloning needed.
- Virtual AvaTOK numbers, chat threads, and Novu + FCM notifications.

**What's genuinely new — what we build:**
- A **Marketplace menu** with **Create Listing** and **My Listings** sub-menus.
- The **agent-instructions step** in the wizard (floor/target/max, plus the language + accent picker),
  with a worked example and a **"Help me write"** button.
- **AI-assist buttons** that write safe titles and descriptions for the owner.
- The **negotiation engine** that pairs agents and runs the haggling (one "brain box" per negotiation).
- The **"talk-once-per-version" ledger** and the greying-out of the Call Agent button.
- The **safety queue** that checks every listing (and every edit) before it goes live.
- **Lifecycle**: mark-as-sold, expiry dates, and editing in My Listings.

---

## 5. The coding plan — what each step achieves (in plain English)

- **P1 — Navigation.** Add the Marketplace menu and its two sub-menus, make the buttons go to the right
  screens, and **unhide the Identity menu** so people can complete their verification.
  *Achieves: a place to put everything, and a visible path to get verified.*
- **P2 — Create Listing v2.** Let owners choose Selling / Buying / Social, fill the right form for that
  type and category, **set a price in any currency they like (INR, RUB, USD, AUD, EUR, … — we're
  global, not USD-only)**, write agent instructions, and pick the agent's language + accent. Prices show
  in their own currency, and we convert behind the scenes so search and sorting still work worldwide.
  *Achieves: people anywhere can describe what they want, price it in their own money, and brief their agent.*
- **P3 — AI writing help.** "Help me write" and auto-title / auto-description buttons (Claude via
  OpenRouter). *Achieves: better, safer listings with less effort — fewer rejections.*
- **P4 — My Listings.** A screen showing all your listings with their status; edit price/photos/
  description, mark sold, renew. Expiry runs automatically to keep the market clean.
  *Achieves: owners stay in control and the marketplace doesn't fill with dead posts.*
- **P5 — Listing detail + Call Agent.** Message Owner (always), show + dial the AvaTOK number, and
  **Call Agent** which captures the buyer's limit and kicks off the negotiation — enforcing the
  talk-once-per-version rule. The agents haggle in text using the **latest Claude Sonnet** (via
  OpenRouter), which is cheap. **Either way they get a voice note in both chats** — a **green** bubble
  when they struck a deal, a **pale-yellow** bubble when they couldn't agree — so you can play it and
  hear how it went. *Achieves: the headline feature — agents negotiate and always drop a colour-coded
  voice note both sides can listen to.*
- **P6 — AI search.** Put every live listing into one Cloudflare AI Search index so people can search by
  meaning, not just keywords. *Achieves: buyers actually find things.*
- **P7 — Safety queue.** Before any listing or edit goes live: check the words (scam/abuse), **strip out
  phone numbers and emails even when disguised** ("nine-eight-seven…", "name [at] gmail dot com"), and
  scan every photo for nudity/porn. If something fails, hide it and tell the owner exactly why.
  *Achieves: a clean, lawful, trustworthy marketplace; contact stays inside AvaTOK.*
- **P8 — Child-safety hardening (deferred — decided later).** For now we block general adult/nudity
  content with a vision model. The dedicated child-abuse (CSAM) hash-matching + reporting service is a
  **later decision**, added before the marketplace opens widely to the public — it's not part of the
  current build. *Achieves: adult-content safety now; full child-safety compliance before public launch.*

---

## 6. The safety promise (why this won't embarrass us)
- **Only verified real people can list** — video ID + email + phone, all proven through the Identity menu.
- No listing goes live until its **words and every photo** pass our checks.
- **Personal phone numbers and emails are removed** from descriptions — even clever disguises — so all
  contact happens inside AvaTOK where we can keep people safe.
- Owners who break the rules get a **clear reason** ("rejected: adult content in photo 2") and a chance
  to fix it.
- Agents **never reveal their owner's secret limit** — only the final agreed conversation is shared, so
  nobody can use an agent to fish for someone's lowest price.

---

## 7. Things still to decide later (not blockers)
- **(Deferred)** Which specific child-safety (CSAM) service we use in P8 — for now, adult-content
  blocking only.
- **(Settled) Listing limit = 5 new listings per person per day** — a technical throttle to keep things
  tidy and protect our infra cost, **not** a charge.
- **(Settled) Listing eligibility = video ID + email + phone, via the Identity menu** as the source of truth.
- **(Settled) No money or escrow ever runs through the platform** — people transact themselves after
  the agents connect them.

---

## 8. Bottom line
We are turning AvaTOK into a marketplace where **your AI agent does the awkward haggling for you, in
your language and your currency, and hands you a ready-made deal as a voice note** — while a strong
safety net keeps the place clean. Almost every building block already exists; the new work is the agent-instructions step,
the negotiation engine, the talk-once rule, and the safety queue. Ready to start at **P1** on your word.

---

## 8b. Build status (2026-06-30) — P1–P7 committed, behind `marketplaceEnabled`

All phases committed locally (one commit each) and the Worker is deployed. The whole feature is dark
in production until the `marketplaceEnabled` KV flag flips on — nothing changes for current users yet.

- **P1** `[AVAMKT-P1]` — Identity menu unhidden; Marketplace menu + hub (Browse / Create / My Listings).
- **P2** `[AVAMKT-P2]` — Buy/Sell/Social listing flow with agent-mandate + language + multi-currency.
- **P3** `[AVAMKT-P3]` — "Help me write" / auto title+description (Claude Sonnet via OpenRouter).
- **P4** `[AVAMKT-P4]` — My Listings: edit (bumps content version), mark sold, renew, delete.
- **P5** `[AVAMKT-P5]` — Agent negotiation: Worker endpoint (talk-once-per-version ledger + Sonnet run)
  + Call Agent sheet; deal → both owners notified.
- **P6** `[AVAMKT-P6]` — Marketplace search over the single shared listings index + telemetry.
- **P7** `[AVAMKT-P7]` — Safety precheck (text moderation via Nemotron + PII strip via Sonnet+regex)
  wired into publish.
- **P8 (deferred)** — Image NSFW screening hooks the upload path; dedicated **CSAM hash-match +
  reporting is still required before a wide public open** and is intentionally NOT in this build.

Known follow-ups (honest scaffolding notes): deal **audio render** (Gemini 2.5 multi-speaker TTS) +
**voice-note-into-thread** is stubbed as a both-parties notification for now (the POC proved the render);
`content_version` is sent as 0 from the client until the column is surfaced on the listing card;
P6 search uses the shared FTS index with a documented upgrade path to a Cloudflare AI Search binding.

---

## 9. Telemetry & cost tracking (PostHog) — baked in from day one

Everything is instrumented. We capture events to **PostHog (EU, project 139917)** at every meaningful
step so we can see the whole funnel, watch the agents work, and **know the exact cost of every audio
file and negotiation**. Reuse the existing `Analytics.capture(...)` client (it already fires
`listing_pipeline_opened`).

**Global properties on EVERY event (per project rule — so any user's data is pullable):**
`user_email` (e.g. `hdavy2005@gmail.com`), `user_phone` (if available), `account_id` (per-account
scoped — parent/child are distinct), `app_version`, `platform`, plus `listing_id`/`negotiation_id` where relevant.

### 9.1 Event taxonomy (what we track)

**Identity & eligibility**
- `identity_video_started` · `identity_video_passed` · `identity_video_failed{reason}`
- `identity_email_verified` · `identity_phone_otp_sent` · `identity_phone_otp_verified`
- `list_eligibility_granted` · `list_eligibility_blocked{missing:[video|email|phone]}`

**Listing creation & lifecycle**
- `listing_pipeline_opened` (exists) · `listing_type_selected{type}` · `listing_category_selected{category}`
- `listing_ai_assist_used{kind: help_me_write|auto_title|auto_description, model, tokens, cost_usd}`
- `listing_currency_selected{currency}`
- `listing_submitted{type, category, price_amount, price_currency, photo_count}`
- `listing_daily_cap_hit{count}` (when the 6th/day is blocked)
- `listing_published` · `listing_edited{content_version, fields_changed[]}`
- `listing_marked_sold` · `listing_expired` · `listing_renewed`

**Moderation / safety queue**
- `moderation_started{listing_id, on: publish|edit}`
- `moderation_text_result{pass, model: nemotron, category?}`
- `moderation_pii_stripped{phones_removed, emails_removed, obfuscated:bool}`
- `moderation_image_result{photo_index, pass, label: nsfw|clean, model}`
- `listing_approved` · `listing_rejected{reason, failing_check, photo_index?}`

**Browse & search**
- `marketplace_opened` · `marketplace_search{query_len, ai_search_ms, result_count}`
- `category_filter_applied{category}` · `listing_card_clicked` · `listing_detail_viewed`

**Agent negotiation**
- `agent_call_clicked{listing_id, content_version}`
- `agent_call_blocked_already_talked{listing_id, content_version}` (talk-once gate)
- `buyer_mandate_captured{max_amount, currency}`
- `negotiation_started{negotiation_id, lang_seller, lang_buyer, fell_back_to_english:bool}`
- `negotiation_round{negotiation_id, round_no}`
- `negotiation_outcome{negotiation_id, outcome: deal|impasse, agreed_price?, currency?, rounds,
  llm_model, llm_tokens_in, llm_tokens_out, **llm_cost_usd**}`

**Deal audio (with per-file cost)**
- `deal_audio_render_started{negotiation_id, language, voices:[seller,buyer]}`
- `deal_audio_render_completed{negotiation_id, tts_model: gemini-2.5-flash-preview-tts, **char_count**,
  **audio_seconds**, **audio_bytes**, **tts_cost_usd**, r2_key}`
- `deal_audio_render_skipped_impasse{negotiation_id, **tts_cost_saved_usd_est**}` (proves the cost rule working)
- `deal_audio_dropped_to_threads{negotiation_id, seller_thread_id, buyer_thread_id}`
- `deal_audio_played{negotiation_id, by: seller|buyer}`

**Notifications & human handoff**
- `novu_notification_sent{kind}` · `fcm_push_sent{kind}` · `notification_opened{kind}`
- `message_owner_clicked` · `avatok_number_dialed`

### 9.2 How we cost each audio file & each negotiation
- **TTS cost per file** = `char_count` (or `audio_seconds`) × the Gemini 2.5 Flash TTS unit rate held in
  config (`TTS_USD_PER_1K_CHARS`). Stored on `deal_audio_render_completed.tts_cost_usd` and on the R2 object.
- **LLM cost per negotiation** = OpenRouter usage (`tokens_in/out`) × the Claude Sonnet rate in config.
  Stored on `negotiation_outcome.llm_cost_usd`.
- **Total deal cost** = `llm_cost_usd + tts_cost_usd`; **impasse cost** = `llm_cost_usd` only (audio
  skipped) — we log the *estimated saved* TTS so the savings are visible.

### 9.3 Dashboards we'll stand up (PostHog)
1. **Marketplace funnel** — eligibility → submit → approved → published → viewed → agent_call → deal.
2. **Negotiation & outcomes** — deal vs impasse rate, rounds, languages, English-fallback rate.
3. **Cost tracker** — daily TTS spend, LLM spend, cost per deal, cost saved by skipping impasse audio.
4. **Safety** — rejection rate by reason, PII stripped counts, NSFW hits.
5. **Per-user lookup** — filter any of the above by `user_email`/`account_id` for support/debugging.

Annotations mark each build-phase ship; a planning-milestone annotation is added now so future
retrievals have context.
