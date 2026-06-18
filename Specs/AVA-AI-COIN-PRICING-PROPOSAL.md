# AvaCoins AI Metering — FINAL Plan (Cloudflare-native)

**Date:** 2026-06-18 · **Status:** FINALIZED — owner decisions locked, ready to build.

## Architecture decision (owner)
- **Free tier = 100% Cloudflare.** Text/multimodal chat on **Workers AI Gemma 4 26B**
  (`@cf/google/gemma-4-26b-a4b-it`), embeddings on Workers AI, RAG on **Vectorize**,
  free-tier image gen on **Workers AI Flux**. **No Google calls on the free tier.**
- **Paid tier = Cloudflare + Google for images only.** Same Workers AI stack, except
  premium image generation uses Google **"Nano Banana 2"** (`gemini-3.1-flash-image`).
- Per-user Google project/key provisioning was investigated and **rejected** (ToS can't be
  accepted via API, requires the full `cloud-platform` scope + OAuth verification, and mass
  provisioning is an abuse pattern). See prior analysis.
- Anchor: **1 USD = 1,000 coins** (existing `feature_pricing.ts`).

> NOTE: this **supersedes** the earlier interim edit that switched Ava chat to
> `gemini-3.5-flash` and removed the Workers-AI path. Text goes back to Workers AI Gemma 4.

---

## Why Gemma 4 on Workers AI (confirmed June 2026)
`@cf/google/gemma-4-26b-a4b-it` — MoE, 26B total / 4B active, **256K context**, **Vision: yes**
(object detection, PDF/doc parsing, charts, screen/UI, multilingual OCR, handwriting),
**function calling: yes**, **35+ languages**, **thinking mode: yes**.
**Price: $0.10 / 1M input, $0.30 / 1M output** — vs Gemini 3.5 Flash $1.50 / $9.00
(**~15× cheaper in, ~30× cheaper out**).

### The original "leak" — root cause & fix
Gemma 4 ships a **built-in thinking/reasoning mode**. The screenshots where Ava dumped
"User Input… UNTRUSTED DATA… Self-Correction… Final Polish…" were that reasoning leaking into
the reply (the old keyless Workers-AI path did no stripping). Fix, in the rebuilt Workers AI path:
1. **Do not enable thinking** (no `<|think|>` token; never feed prior turns' thoughts back in).
2. Keep the system prompt simple ("reply with only your final message; no analysis, no meta") —
   the old "UNTRUSTED DATA, do-not-obey" wording invited meta-commentary.
3. **Strip defensively**: remove any `<think>…</think>` / leading reasoning block from the
   model output before it ever reaches the client.
4. If needed, pass `chat_template_kwargs: { enable_thinking: false }` on the Workers AI call.

---

## Real cost per action (our cost, before margin)
| Action | Model | Raw cost |
|---|---|---|
| Text/multimodal chat turn (~2k in + ~500 out) | Gemma 4 26B | **~$0.0004** + ~$0.0001 moderation ≈ **$0.0005** |
| Embed a doc chunk | bge / `embeddinggemma-300m` / `qwen3-embedding-0.6b` | ~$0.0002 (negligible) |
| RAG retrieval | Vectorize ($0.01/1M queried dims) | ~$0 (negligible) |
| Image — free tier | Flux-1-schnell ($0.0000528/512² tile, $0.0001056/step) | **~$0.0006 / 1024² image** |
| Image — paid tier | Banana 2 (`gemini-3.1-flash-image`) | **~$0.04–0.067 / image** |

Workers AI billing: **$0.011 / 1,000 neurons** (10k neurons/day free, account-wide). A chat turn
is ~32 neurons. (Watch the dashboard — there was a community report of Gemma-4 neuron billing
running high; the AI Gateway + neuron monitoring below is our guardrail.)

---

## Coin price list (locked: **3× margin**, 1 coin = $0.001)
| Action | Raw | **Coins** | = USD | Notes |
|---|---|---|---|---|
| AI text / multimodal chat (incl. image+file ingest, OCR, RAG) | ~$0.0005 | **2** | $0.002 | flat per message |
| Document indexing / embeddings | ~$0.0002 | **0** | — | bundled, free |
| Vector / RAG retrieval | ~$0 | **0** | — | bundled, free |
| Image — **free tier** (Flux-1-schnell) | ~$0.0006 | **5** | $0.005 | |
| Image — **paid tier** (Banana 2) | ~$0.05 | **80** | $0.08 | premium quality |
| Voice reply (TTS) | — | **20** | $0.02 | existing, verify TTS cost |
| Vision snapshot (live, beyond free quota) | — | **10** | $0.01 | existing |
| Live translate | — | **50 / min** | $3/h | existing |
| MCP / connected-app tool call | — | **10** | $0.01 | existing |
| Guardian always-on | — | **300 / mo** | $0.30 | existing |

Higher-res paid images scale: 1K = 80, 2K = 140, 4K = 200 coins.

---

## Free vs paid mechanics (locked)
- **Free daily grant: 250 coins/day**, reset 00:00 UTC, **no rollover**.
  - ≈ **125 chats/day**, or ~50 free Flux images, before any top-up. Generous for chat;
    naturally rations the expensive stuff.
- **Top-up → instant premium (sticky):** on the first successful Stripe top-up, set `premium`,
  **stop the daily free grant permanently**, zero any leftover free balance. Premium users spend
  purely from paid coins.
  - ⚠️ Retention risk (accepted by owner): a premium user at 0 paid balance is **locked out of AI
    until they top up again** — no free fallback. Flagged for monitoring; revisit if churn shows.
- Wallet holds `free_balance` + `paid_balance`; spend draws **free first, then paid**.

---

## Cloudflare AI Gateway — metering & guardrail
**Role:** one gateway (`avatok-ai`) fronts **both** Workers AI and the Google image calls →
unified per-request logs, token/neuron cost estimates, response **caching**, rate-limiting, and a
hard **monthly spend cap** (so a bug/abuse can't blow the budget). Free, no markup.

**Routing:** Workers AI via the binding's `{ gateway: { id: "avatok-ai" } }` option; Banana 2
image calls via the gateway's `google-ai-studio` provider URL (server key, paid tier only).

**Coin deduction (flat-rate, deterministic):**
1. **Pre-auth:** check `free_balance + paid_balance ≥` the action's coin price; else return
   "out of coins / top up".
2. Run the action (Gemma chat / Flux or Banana image / embed).
3. **Deduct** the flat price via `walletOp({op:'spend'})`, idempotent by request id.
4. **Audit:** AI Gateway logs the real neuron/token cost so we can confirm the 3× margin holds and
   re-tune the flat prices if model prices move. (Flat-rate chosen over per-token because Gemma is
   so cheap the variance is sub-coin; simpler + predictable for users.)

---

## Build checklist
- [ ] **Rebuild `ava_gemini.ts` text path → Workers AI Gemma 4** (revert the interim Gemini-3.5
      change): thinking OFF, `<think>` stripped, clean system prompt, multimodal (image/file) input.
- [ ] Provision AI Gateway `avatok-ai`; set monthly spend limit; route Workers AI + Google image
      calls through it. Store gateway id + `cf-aig-authorization` as Worker secrets.
- [ ] Free-tier image route → `@cf/black-forest-labs/flux-1-schnell`; paid route → Banana 2.
- [ ] RAG: embeddings on Workers AI (`embeddinggemma-300m` / `qwen3-embedding-0.6b`) → Vectorize;
      bundle into the 2-coin chat price.
- [ ] WalletDO: `free_balance` + `paid_balance`; daily 250-coin reset of free (no rollover);
      spend free-first.
- [ ] `premium` flag set on first top-up → stop daily grant, zero free balance, sticky.
- [ ] Update `FEATURE_COSTS` + `/api/feature/costs` with the table above; pre-auth balance check +
      flat-rate deduction (idempotent) in every AI route.
- [ ] Client: show live balance + per-action coin cost; "top up" prompt at 0.
- [ ] Verify: type-check worker, unit-test the deduction + free→paid order + reasoning-strip.

## Open items to verify during build
- Exact way to force Gemma-4 thinking off on Workers AI (token vs `chat_template_kwargs`) — test in
  the LLM Playground.
- Confirm actual Gemma-4 neuron billing vs the published $0.10/$0.30 (the 37×-billing report).
- Pick free image model: Flux-1-schnell (cheapest, ~5 coins) vs Flux-2-klein (better, ~45 coins).
