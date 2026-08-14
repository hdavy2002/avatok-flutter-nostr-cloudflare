# Venice AI media + uncensored chat — implementation plan (2026-08-14)

Owner decisions (2026-08-14): API key = **worker secret `VENICE_API_KEY`** (wrangler secret,
staging + prod, never in repo/client).

**REVISED SAME DAY (owner, 2026-08-14): NO NUDITY / NSFW MEDIA — EVER.** The owner does not
want a Play ban. The NSFW media lane (lustify-v8, wan-2-7-uncensored-*) is **DROPPED, not
tier-gated** — those model IDs must not ship in any lane. What the owner DOES want from
Venice is its permissiveness on **public figures**: users must be able to create **memes and
satire of politicians**, which Gemini-class models refuse outright. So the policy is:
SFW-only output, but no public-figure refusals.

Chat: the uncensored-**text** lane (Venice Uncensored, 18+ toggle AND paid balance, default
OFF) stands — text is not the Play image risk. Media generation is one safe lane for everyone.
Target environment: production feature (built on staging first, promoted code+migrations only).

## Current state (verified in code, not from memory notes)

- Image: intent forces `generate_image` tool (`worker/src/lib/composio.ts` ~L1433
  `forceImage`) → `ava_image.ts generateImage()` (L446) → OpenRouter `POST /images`,
  model from `policy.ts imageModel()` (default `x-ai/grok-imagine-image-quality`,
  env `OPENROUTER_IMAGE_MODEL`). Wallet reserve/settle already gates it via the
  `ai_media_jobs` pattern (ava_image.ts ~L924–1026).
- Chat: `policy.ts` — `AVA_REASONER` (`@cf/google/gemma-4-26b-a4b-it`) /
  `AVA_REASONER_ALT` (`google/gemini-2.5-flash-lite`).
- Video/music generation: does not exist; net-new intents.

## Venice API (context7, verify against live `GET /models` before coding)

Base `https://api.venice.ai/api/v1`, `Authorization: Bearer <VENICE_API_KEY>`.
- Image: sync `POST /image/generate` → `{ id, images: [base64] }`.
- Video: async `POST /video/queue` → `{ id }` → poll `POST /video/retrieve {queue_id}` →
  `{ status, url }`.
- Audio/music: async `POST /audio/queue` (+ `/audio/quote` for cost estimate,
  `/audio/retrieve` to poll).
- Chat: OpenAI-compatible `POST /chat/completions`.
- Docs list `venice-uncensored` (1.1) and `wan-2.5-preview-*` — the exact IDs below are
  the owner's spec and MUST be confirmed against live `/models`; do not assume.

## Routing map (single source of truth — `worker/src/lib/venice.ts`)

| Intent | Everyone (SFW only) | Paid tier |
|---|---|---|
| image | `venice-sd35` | same (may later upgrade quality, never NSFW) |
| video text→video | `ltx-2-19b-distilled-text-to-video` | same |
| video image→video | `ltx-2-19b-distilled-image-to-video` | same |
| music | `ace-step-15` (duration 60–210s, default 60) | `minimax-music-v25` (flat, no duration) |
| chat | unchanged (Gemma/Gemini ladder) | Venice Uncensored 1.2, text only (confirm ID) |

`lustify-v8` / `wan-2-7-uncensored-*` are BANNED model IDs — do not add them to the map.
One config/mapping object `(intent, tier) → { modelId, endpoint, kind }` — no scattered
if/else. i2v when the user's message carries a source image, else t2v.

## NSFW enforcement (three layers, all mandatory)

1. **Venice safe mode**: send the API-level safety param on every image/video call
   (docs show `safe_mode` / `safe_venice` on image generate — confirm exact field name in
   step-0 docs check) so adult output is blocked/blurred provider-side. Never disable it.
2. **Prompt gate (pre-call, before token reserve is settled)**: run the prompt through the
   existing moderation model (`MODERATION_MODEL` / Gemma lane already used by the AI Layer)
   with a rubric that blocks sexual/nudity requests but explicitly ALLOWS political satire,
   caricature, and memes of public figures. A refusal refunds the token and returns a clean
   "can't create that" message. The rubric must never treat "politician + ridicule" as a
   violation — that is the product feature.
3. **Output gate (post-call, before delivery)**: generated image / video keyframe goes
   through the existing image-moderation path before it is written to the thread. NSFW
   verdict → media discarded, token refunded, `venice_nsfw_blocked` telemetry with user
   email. This is the backstop for prompt-gate misses.

Hard line inside layer 2: sexual/nude content of ANY real person (deepfake porn) is an
absolute block regardless of tier or toggle. Satire yes, sexualization never.

## Real-person content policy (owner delegated the line-drawing 2026-08-14; based on
## Play's AI-Generated Content policy — the trigger is "demonstrably deceptive or false"
## plus bullying/harassment, NOT satire per se)

**ALLOWED** (this is the product feature — the rubric must not over-block it):
- Obvious satire, parody, caricature, meme-format humor of PUBLIC FIGURES (politicians,
  celebrities). Exaggerated, cartoonish, meme-captioned, clearly unreal styles.

**BLOCKED for real people, even in "satire" framing** (these are the Play tripwires):
1. Sexual/nude/sexually degrading — absolute, already above.
2. Violent, gory, or criminal depiction — a real person committing or suffering violence,
   or shown doing something criminal/harmful. Play reads this as bullying/harassment and
   defamation regardless of the satire label.
3. Deceptive realism — anything designed to be mistaken for a real event or statement:
   photorealistic "caught on camera" framing, fake news-article/broadcast screenshots,
   fabricated quotes presented as real (realistic font/attribution), fake official
   documents/seals, fake election announcements. This is Play's "demonstrably deceptive
   or false" line and the 2026 election-law line; block hard.
4. Private individuals — real-person generation is public-figures only. A user-supplied
   photo of a private person as an i2v/edit source gets the same output gate; sexual,
   violent, or humiliating output of ANY identifiable person is blocked.

**MANDATORY MITIGATION — visible AI label:** every generated image/video ships with a
visible watermark baked in server-side before delivery. Owner decision 2026-08-14: the
stamp text is **"AI-generated · avatok.ai"** — the "AI-generated" part is what carries
the Play/deepfake-law disclosure value (a brand URL alone is marketing, not disclosure);
the domain rides along for branding. Venice has a `hide_watermark` param on image
generate — NEVER set it; if Venice's own watermark is absent or insufficient, stamp our
own in the worker before the media is written to R2.
NOTE: the watermark is a mitigator, NOT a compliance pass by itself — the real-person
content blocks above are what keep us inside Play policy. A watermarked fake-news clip
is still a violation. Election seasons in target markets ⇒ no loosening; the rubric
stays constant.

## Work items

1. `[VENICE-CLIENT-1]` `worker/src/lib/venice.ts`: auth, base URL, routing map,
   thin fetch helpers (image sync; video/music queue+poll). Model IDs verified against
   live `/models` first.
2. `[VENICE-IMG-1]` Repoint `ava_image.ts generateImage()` to Venice `/image/generate`;
   add `veniceImageModel()` to `policy.ts` (env-overridable). Old OpenRouter path removed
   as default, revert path = remote-config kill switch `veniceMediaEnabled` — declared in
   `PlatformConfig` AND `DEFAULTS` in `routes/config.ts` in the same change, then proved
   flippable (`ALLOW_PROD=1 scripts/flags.sh set veniceMediaEnabled=false` must not 400).
   NO fake flags.
3. `[VENICE-TIER-1]` `veniceTier(env, uid): 'free'|'paid'` = per-account 18+ toggle
   (new, scoped storage server-side; client Settings toggle later) AND paid balance > 0.
   Default free. REVISED SCOPE: tier now only selects the music model and the
   uncensored-TEXT chat lane — it never unlocks NSFW media (that lane is deleted).
3b. `[VENICE-SAFE-1]` The three-layer NSFW enforcement above: safe-mode param, prompt
   gate (politics-allowed rubric), output moderation gate. Ships in the same change as
   [VENICE-IMG-1] — the Venice image path must never be live without it.
3c. `[VENICE-LABEL-1]` Visible "AI-generated" watermark on every generated image/video,
   stamped server-side before the media is registered/delivered (keep Venice's own
   watermark; never send hide_watermark). Ships with [VENICE-IMG-1] as well.
4. `[VENICE-VID-1]` / `[VENICE-MUS-1]` New `generate_video` / `generate_music` tools in
   `composio.ts` + `ava_agent.ts`, following the durable AiMediaJob pattern (queue on
   Venice, poll from queue consumer, deliver into thread like images). Music passes
   duration param (free tier only), clamp 60–210s.
5. `[VENICE-TOKENS-1]` Billing on the existing WalletDO reserve/settle rail (1 token = ₹1;
   never a parallel ledger): flat 1 token per generation, reserved before the Venice call,
   refunded on outright API failure, 0 spendable → "out of tokens" without calling Venice.
6. `[VENICE-CHAT-1]` Uncensored-tier chat lane → Venice Uncensored 1.2 (direct
   `/chat/completions` adapter or OpenRouter-hosted equivalent; pick after checking
   `/models`). Free lane untouched. Same kill switch.
7. Telemetry: `ava_reason_call` (provider `venice`) on every call, `$ai_generation` for
   spend, user email tagged. Ship-manifest entries with success-value assertions.
   `npx tsc --noEmit` in worker/ before every deploy; commit before deploy.

## Risks (flagged to owner 2026-08-14)

- **Google Play**: resolved by design — NSFW media lane deleted entirely; three-layer
  SFW enforcement on all generated media. Remaining watch item: uncensored TEXT chat is
  still a (lower) Play consideration; it stays 18+-gated, paid, default off.
- **Political memes**: allowed by design, but India has taken down deepfake content —
  keep the "no sexualization of real people" absolute block, and the output gate gives
  an audit trail (telemetry per generation with user email).
- **Shared family phones**: the 18+ chat toggle must be per-account (scopedKey), default
  off, never leak across accounts.
- Model IDs in the owner spec vs docs differ in style — live `/models` check is step 0.
