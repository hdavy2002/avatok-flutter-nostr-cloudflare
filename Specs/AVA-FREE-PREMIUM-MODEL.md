# AvaTOK Free vs Premium — Locked Model (2026-06-18)

Owner-confirmed. Refines `AVA-AI-COIN-PRICING-PROPOSAL.md`.

## The two states

**FREE** (no AI Studio key, no top-up):
- Ava is a **basic text chatbot only** — Workers AI Gemma 4, plain conversation.
- **Light daily cap** on messages (anti-abuse; default ~60/day, tunable via config),
  then "come back tomorrow or go premium". No coin charge for basic chat.
- **NO AI tools**: no file/image/audio ingestion, no transcription, no translation,
  no embeddings, no Vectorize, no RAG/AI-memory, **no image generation**.
- **Free Google apps** via the user's OWN Google OAuth token, called **directly over
  REST** (no Composio/Strata) → Drive, Calendar, Gmail, Docs/Sheets. $0 to us.

**PREMIUM** — unlocked by EITHER:
- **(a) Connecting an AI Studio key** (Settings already has the button + instructions).
  Premium AI runs on the user's own Google free quota → **$0 to us**. This is FULL AI unlock.
- **(b) Topping up ≥ $10.** Premium AI runs on our infra, metered in AvaCoins.

`isPremiumAI = (wallet.premium == 1 from a top-up) OR (AI Studio key connected)`.

## What premium unlocks
- File understanding ("@ava explain this file"), image/vision, audio transcription,
  translation, embeddings + Vectorize (search/RAG/memory), **image generation**.
- **Connecting non-Google apps** (Slack, Notion, … via Composio/Strata) — this one
  requires a **top-up specifically** (a BYO AI key does not cover Composio cost to us).

## The gate (the core behavior)
- Free user uploads a file/image/audio and **@ava**-mentions it, OR asks to
  translate / transcribe / summarize-a-file / search-my-stuff / generate-image →
  detected as "needs an AI tool" → Ava does NOT run it; she replies:
  > "That needs premium AI. Add your own AI Studio key (Settings → How to get a key),
  > or top up $10 to unlock premium features."
- Free user tries to connect a **non-Google app** → "That's a premium feature — top up to add it."
- Plain text question → answered free on Gemma (within the daily cap).

**"Needs an AI tool" = ** message has an attachment (file/image/audio) OR intent is
translate / transcribe / file-summarize / search-memory / image-generate.

## Free vs premium connectors
- **Free:** Google suite (Drive, Calendar, Gmail, Docs/Sheets) via direct REST + the
  user's OAuth token — no Composio credits burned.
- **Premium (top-up):** every other connector (Composio/Strata-backed).

## What changes vs what's already deployed
1. **Free chat → daily turn cap, not coins.** Revert the `ava_chat=2` coin charge;
   basic chat is free (capped). Coins are only for premium-on-our-infra usage.
2. **Define `isPremiumAI`** = topped-up OR AI-Studio-key-connected; gate all AI tools on it.
3. **Remove the free Flux image path** — image generation is premium-only now.
4. **Min top-up → $10** (10,000 coins; currently MIN_TOPUP=500).
5. **Upsell responses** added to the chat + image + tool routes for free users.
6. **Google apps via direct REST** (new workstream) replacing Composio for the Google suite.

## External dependency (cannot be done in code alone)
Serving Gmail / Docs / Sheets / Drive / Calendar free via direct REST needs the right
OAuth scopes consented AND **Google OAuth app verification** (Gmail/Drive/Docs are
sensitive/restricted scopes). Drive + Calendar are already partly wired; Gmail + Docs/Sheets
add restricted scopes that trigger Google's security review. So the free-Google-apps piece
ships only after verification clears.

## Proposed build sequence
- **Phase A (server, buildable now):** `isPremiumAI` helper; free chat → daily cap (no coin);
  gate file/image/audio/translate/RAG/vision/voice/image-gen behind premium with the upsell;
  remove free Flux; MIN_TOPUP → $10. Deploy.
- **Phase B (client):** wire the upsell prompt UI (→ Settings AI-key page / top-up sheet);
  hide premium tool affordances for free users.
- **Phase C (Google apps via REST):** scope expansion + verification, then Drive/Calendar/
  Gmail/Docs over REST with the user token; gate non-Google connectors as premium.
