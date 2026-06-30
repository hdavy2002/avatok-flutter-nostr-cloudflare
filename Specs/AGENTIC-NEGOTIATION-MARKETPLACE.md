# Agentic Negotiation Marketplace (AvaDeal)

**Status:** Proposal / streamlined design — 2026-06-30
**Owner decision captured:** audio = **verbatim negotiation**; NotebookLM **rejected**;
TTS = **Gemini 2.5 Flash multi-speaker**. POC rendered & validated (see end).

---

## 1. One-paragraph product

A seller lists an item (e.g. a car) with a public price and gives their agent a **private
mandate** (floor $2000, target $3000). A buyer gives their agent a private mandate (max $2500).
Both parties are represented by **virtual AvaTOK numbers**. In the "virtual world" a matchmaker
pairs compatible agents; the two agents **negotiate in text** under their secret constraints.
If their ranges overlap, they settle on a price, and the **verbatim transcript is rendered to a
two-voice audio note** (one voice per agent) and **dropped into both owners' chat threads** with
a Novu + FCM push. Each owner wakes up, plays the voice note, hears how their agents settled, and —
because both threads already expose the counterparty's AvaTOK number + contact card — can simply
say hello and take the deal forward themselves.

---

## 2. Make-or-break decision: how the audio is produced

### NotebookLM is REJECTED. Reasons (researched 2026-06-30):
1. **No verbatim script control** — NotebookLM re-synthesizes its own podcast from "sources" and
   decides what to say. It will not faithfully speak our exact negotiated numbers. Disqualifying
   for a deal record.
2. **Only 2 fixed voices** — no custom/per-speaker voice assignment, no gender/accent control.
3. **No real developer API** — only an org-gated Enterprise API and fragile unofficial
   Playwright browser-automation wrappers (against ToS, not production-grade).

### Chosen: Gemini 2.5 Flash multi-speaker TTS (`gemini-2.5-flash-preview-tts`)
- Takes the **exact** transcript in `Speaker: dialogue` format — verbatim control.
- Renders **both speakers in ONE API call** — no stitching, **no ElevenLabs, no Pocket container**.
- 30+ prebuilt voices; assign a distinct voice per agent.
- We already have Gemini BYOK infra + keys, and an existing `agent_tts.ts` (transcript→MP3→R2).
  This is an **engine swap**, not a new system.

### Dropped from the original idea (simplification)
- ❌ 20-second human voice onboarding recordings
- ❌ Pocket container voice cloning
- ❌ NotebookLM
- **Rationale:** the conversation is between *agents*, not the humans. Two neutral agent voices is
  cleaner and more honest than faking owners' voices saying words they never spoke.

---

## 3. Architecture (Cloudflare-native, fits existing stack)

```
Listing + seller mandate ─┐
                          ├─► Matchmaker (Cron + Queue)  ──► creates a NegotiationDO
Buy-intent + buyer mandate┘                                        │
                                                                   ▼
                                          NegotiationDO (one per negotiation)
                                          - holds both private mandates (never cross-leaked)
                                          - runs the LLM offer/counter loop to terminal state
                                          - on DEAL ─► render + deliver
                                                   │
                        ┌──────────────────────────┼───────────────────────────┐
                        ▼                           ▼                           ▼
              agent_tts.ts (Gemini 2.5     post into BOTH chat threads     Novu + FCM push
              multi-speaker) → WAV/MP3      (voice note + verbatim text     ("Your agent closed
              → R2 (content-addressed)       transcript + contact card)      a deal")
```

### Components
| # | Component | New? | Notes |
|---|-----------|------|-------|
| 1 | **Agent mandate UI** | NEW | Seller floor/target; buyer max. Stored against listing/agent, **never** exposed to counterparty. |
| 2 | **Matchmaker** | NEW | CF Cron + Queue scanning open listings vs open buy-intents for category/price overlap; spawns a NegotiationDO. |
| 3 | **NegotiationDO** | NEW | Durable Object per negotiation. Two LLM agents exchange offers under secret constraints until DEAL or IMPASSE (bounded rounds). |
| 4 | **Deal detector** | NEW | Terminal condition: buyer_max ≥ seller_floor ⇒ deal at agreed midpoint/rule; else impasse (no audio, optional "no match" note). |
| 5 | **Audio render** | EXTEND | Swap `agent_tts.ts` TTS engine to Gemini 2.5 multi-speaker; verbatim transcript in `Speaker:` format. |
| 6 | **Thread drop + push** | REUSE | `agent_conversations`/`agent_inbox`, chat voice-note playback, contact card w/ AvaTOK number, Novu + FCM. |

---

## 4. What already exists vs. net-new

**Already built (the legwork):**
- Virtual AvaTOK↔AvaTOK numbers + dashboard
- `agent_conversations` / `agent_inbox` + API routes
- `agent_tts.ts`: transcript → MP3 → cached in R2 (content-addressed)
- Listings/marketplace w/ price + details, KYC, wallet
- Chat threads w/ voice-note playback + contact cards exposing the AvaTOK number
- Novu + FCM push ("wake up to a notification")

**Net-new = items 1–4 above.** The negotiation engine (2–4) is the real engineering.
The audio piece — the part feared as make-or-break — is the easiest once NotebookLM is gone.

---

## 5. Negotiation loop design (DO)

- **Engine (the agents' brain):** **latest Claude Sonnet via OpenRouter** (currently
  `anthropic/claude-sonnet-4.6` — keep the slug in config so it tracks "latest"). Both agent turns run
  on Claude Sonnet; reuse the existing OpenRouter plumbing (same path as the Guardian shield). Text only
  — this stage is cheap.
- **Inputs (private):** seller {floor, target, listing facts}, buyer {max, preferences}.
- **Protocol:** alternating offers, each agent prompted with ONLY its own mandate + the public
  listing + the visible offers so far. Hard cap on rounds (e.g. 8) to bound LLM cost.
- **Terminal:** DEAL (overlap found) or IMPASSE (cap hit / ranges never overlap).
- **AUDIO RULE (owner change 2026-06-30) — render in BOTH outcomes, colour-coded.** The Gemini
  multi-speaker TTS render runs on **every** completed negotiation and the voice note is dropped into
  **both** chat threads. The audio bubble is colour-coded by outcome: **DEAL → green** (go),
  **IMPASSE → pale yellow** (no-go). (This supersedes the earlier "audio only on a deal" cost rule — TTS
  now costs on every negotiation; the per-listing-version talk-once gate is what bounds the spend.)
- **Settlement rule (configurable):** midpoint of last bracket, or seller-favoured, or
  first-acceptable. Default: midpoint, clamped to [seller_floor, buyer_max].
- **Output:** structured `{outcome, agreed_price, transcript[]}` where each line is
  `{speaker: "Seller"|"Buyer", text}` — ready for the TTS `Speaker:` format with no reshaping.
- **Guardrails:** mandates never appear in the other agent's prompt; transcript is the only
  shared artifact.

---

## 6. TTS render contract (Gemini 2.5 multi-speaker)

- Model: `gemini-2.5-flash-preview-tts`
- Endpoint: `POST /v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=…`
- `generationConfig.responseModalities = ["AUDIO"]`
- `speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs = [{speaker:"Seller",voice:Charon}, {speaker:"Buyer",voice:Aoede}]`
- Returns base64 PCM (`audio/L16; rate=24000`, mono 16-bit). Wrap to WAV (or transcode to MP3
  for smaller chat payloads) → store in R2 content-addressed → reference from the chat voice note.
- **Speaker labels in the script MUST exactly match the `speaker` names** or the model falls back
  to a default voice.
- Cache by transcript hash (reuse the existing R2 content-addressing) so re-opens never re-render.

### Key hygiene (action item)
- The **POC ran on `RECEPTIONIST_GEMINI_API_KEY` (AQ. format, project avatok-live-receptionist-2026).**
- **`GEMINI_API_KEY` (AIzaSy, project avatok-e19ef) was rejected as INVALID** on the TTS endpoint —
  needs re-check/rotation or API-restriction fix before this ships on the main key.

---

## 7. Open product questions (next pass)
- Settlement rule default (midpoint vs seller-favoured)?
- Do agents negotiate non-price terms (pickup, warranty) or price-only for v1?
- Throttling: how many auto-negotiations per listing/day before a human must approve?
- Anti-abuse: prevent agents being used to scrape competitor floor prices.

---

## 8. POC result (2026-06-30)
Rendered a 7-line verbatim car negotiation (seller floor $2000/target $3000, buyer max $2500,
settled $2500) via `gemini-2.5-flash-preview-tts`, two distinct voices (Charon/Aoede), single API
call, ~31s of clean 24kHz audio, no stitching. Output: `car_deal_poc.wav`. Quality validated as
production-viable for the "drop a deal voice note into the thread" flow.
