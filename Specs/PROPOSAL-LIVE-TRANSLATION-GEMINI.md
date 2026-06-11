# Proposal: Live Voice Translation for AvaLive & AvaConsult
**Powered by Gemini 3.5 Live Translate (`gemini-3.5-live-translate-preview`)**
Date: 2026-06-11 · Status: DRAFT — awaiting owner approval

---

## 1. Your requirements, restated as points

### In-call experience
1. During a video call (AvaLive stream or AvaConsult consultation), both the **viewer** and the **creator** see a **"Translate"** option on screen — a transparent overlay menu on top of the video.
2. Tapping it opens a dropdown (one dropdown: "Select language").
3. Once a language is selected, the **incoming voice** is automatically translated and the listener hears it in their chosen language, near real-time.

### Billing
4. Price: **$3 per hour** of translation, per listener.
5. Before/while translating, the system checks the **AvaWallet** for enough **AvaCoins** to cover the $3/hour deduction.
6. If the wallet has **no AvaCoins** when the user tries to start translation: show on-screen message *"You don't have AvaCoins in your wallet to listen to live translation"* with a **Top up** button, usable during the call, so translation can start/continue after top-up.
7. If AvaCoins run out **mid-call** (balance consumed): pop-up *"You have utilized your AvaCoins for your voice translation, please top up your wallet to add some more coins"* — again with an in-call top-up option.
8. **Terminology rule: never use the word "credits" anywhere. Always "AvaCoins."**

### Creator listing form (AvaLive & AvaConsult)
9. When a creator creates a listing, add an option: **"Voice translation available"** plus **"Language of transmission"** (e.g., Hindi).
10. The creator can also choose to hear **his customer's voice** translated into a language of his choice — that adds $3/hour to **the creator's own bill**.

### Viewer/customer booking pipeline
11. When booking a call/event, the user is asked: **"Would you like this to be translated into the language of your choice?"**
12. If yes, the total bill shown **includes** the translation charge before payment. Example given: 1-hour consult priced $60 by the creator → with translation the user's total is **$66** *(see open question Q1 — $60 + $3×1hr = $63; $66 implies $3/hr each way or $6/hr — needs your confirmation)*.

### Revenue & refunds
13. The $3/hour translation fee is **never shared with the creator** — 100% goes to the **admin wallet**. No creator commission applies to this amount.
14. Refunds: if the show/consult doesn't conclude or any refund rule triggers, refund only the **unused translation time** — deduct whatever time was consumed (waiting time and other scenarios per existing refund rules R2–R6), refund the rest.

---

## 2. What Gemini 3.5 Live Translate gives us (from the two articles)

- Real-time **speech-to-speech** translation, 70+ languages, auto language detection, preserves speaker tone/pacing. Continuous streaming (no turn-taking), stays only seconds behind the speaker. Launched 2026-06-09, public preview via the Gemini Live API.
- Model: `gemini-3.5-live-translate-preview` over the Live API **WebSocket**. Config: `translationConfig: { targetLanguageCode, echoTargetLanguage }` + input/output transcription toggles.
- Audio: input **16-bit PCM 16 kHz mono** in 100 ms chunks; output **16-bit PCM 24 kHz mono**. Audio-only input; no tools/instructions.
- **Ephemeral tokens** (v1alpha) let the phone connect directly to Google without exposing our API key. The Worker mints the token; we can either lock `translationConfig` server-side or leave language selection unlocked for the client.
- LiveKit has a ready Gemini plugin, and Google ships a LiveKit demo — relevant for ≤25-person group conferences.
- Output audio is SynthID-watermarked.

## 3. Architecture (fits our Cloudflare-native stack)

**Principle: the listener's device taps the incoming remote audio track, streams it to Gemini via ephemeral token, and plays back the translated audio instead of (or ducked over) the original.** This one design works everywhere because in all three call types the listening device already has the remote audio:

| Surface | Media path today | Translation tap point |
|---|---|---|
| AvaConsult 1:1 | P2P WebRTC (CallRoom DO, 2-peer cap untouched) | Remote track on device → Gemini WS |
| AvaConsult/AvaTalk group ≤25 | LiveKit SFU | Remote mixed/selected track on device → Gemini WS |
| AvaLive stream | Cloudflare Stream WHEP playback | Player audio on device → Gemini WS |

No media ever flows through our Worker (Workers can't process realtime audio anyway); the Worker only does **tokens + billing**. Server-side LiveKit agents (per-language dubbed tracks) are a possible later optimization for big AvaLive audiences — Phase 7, optional.

### New Worker surface: `worker/src/routes/translate.ts`
- `POST /translate/session/start` — auth → check listing has translation enabled (or it's an ad-hoc in-call start) → **wallet check** (min balance: 15 minutes' worth) → create `translation_sessions` row → mint Gemini **ephemeral token** (language unlocked so the dropdown works client-side, or locked when chosen at booking) → return token + session id.
- `POST /translate/session/heartbeat` — every 5 min the client renews; Worker debits the elapsed slice from WalletDO (idempotent op_ids, same money middleware: idempotency-key + rate limits) into the **admin/platform wallet** — bypasses creator escrow and commission entirely.
- `POST /translate/session/stop` — final pro-rata debit, close session.
- If a debit fails (insufficient AvaCoins) → heartbeat response tells client `INSUFFICIENT_AVACOINS` → client pauses translation, shows the top-up pop-up (point 7 wording); after top-up, heartbeat resumes.
- Kill switch `translationEnabled` in `routes/config.ts`, same pattern as `conferenceEnabled`.

### Billing model (recommended)
- Headline price **$3/hour**, metered **per minute (pro-rata)** = $0.05/min equivalent in AvaCoins, billed in 5-minute heartbeat slices. This makes mid-call stop/start, top-ups, and refunds exact — no hour-block arguments.
- Pre-booked translation (booking pipeline): charged upfront for the booked duration, held in **platform escrow** (separate from the creator's escrow), settled per minute consumed, **unused minutes auto-refund** via the existing refund engine.
- All translation ledger entries carry `kind=translation_fee`, `beneficiary=platform` → reporting, zero creator commission by construction.
- Per-account scoping: language preference and any cached state stored via `scopedKey(...)` per the rulebook.

### Flutter: `app/lib/features/translation/`
- `TranslationEngine` — taps remote audio (resample to 16 kHz PCM, 100 ms chunks) → Gemini Live WS (ephemeral token) → jitter-buffer plays 24 kHz output; ducks original audio. Reconnect logic; degrades gracefully to original audio on failure (and billing pauses).
- `TranslateOverlay` — transparent top menu: "Translate" button → language dropdown (70+ languages list, searchable) → status chip (active language, AvaCoins burn rate "3 AvaCoins-equiv/hr" — exact coin display per wallet conversion) → stop.
- Pop-ups: no-balance and balance-exhausted (exact wordings from points 6–7), each with an in-call **Top up** sheet reusing the existing Stripe top-up flow.

## 4. Phased implementation plan

**Phase 0 — Foundation & spike (½ week)**
GCP project check, enable Gemini API billing on the recovered key, quota review. Throwaway Flutter spike: tap a remote WebRTC track → Gemini → play translated audio; measure latency & cost/hour. Decision gate on Q1–Q4 below.

**Phase 1 — Backend translation service (1 week)**
`routes/translate.ts` (start/heartbeat/stop), ephemeral token minting, `translation_sessions` D1 table, WalletDO debit ops to platform wallet, `translationEnabled` kill switch, money-middleware idempotency. Unit tests incl. insufficient-balance and double-debit cases.

**Phase 2 — In-call client, AvaConsult 1:1 first (1–1.5 weeks)**
`TranslationEngine` + `TranslateOverlay` in the consult call screen, both sides (viewer hears creator translated; creator can independently enable translation of the customer — billed to creator). Both pop-ups + in-call top-up. Per-account scoped prefs.

**Phase 3 — AvaLive + group conferences (1 week)**
Same overlay on the AvaLive player (WHEP audio tap) and the LiveKit conference screen. Group caveat: model voice-tracking across rapid multi-speaker switching is imperfect (documented limitation) — ship behind sub-flag `translationGroupEnabled`.

**Phase 4 — Listing form & booking pipeline (1 week)**
Creator form: "Voice translation available" toggle + "Language of transmission" picker (+ creator's own listen-language option). Booking flow: translation question, language picker, **itemized total** ("Consultation $60 + Voice translation $3 × 1 hr = $63" — pending Q1) before payment. Listing cards show a 🌐 translation badge.

**Phase 5 — Refunds, settlement & admin (1 week)**
Hook `translation_fee` into refund engine R2–R6: pro-rata refund of unused minutes in every cancellation scenario; consumed waiting time deducted per existing rules. Admin wallet reporting line for translation revenue. Reconciliation job comparing session minutes vs. debits.

**Phase 6 — Hardening & rollout (½–1 week)**
Load/latency testing, Google cost vs. $3/hr margin check, PostHog events (start/stop/top-up/abandon), staged rollout via kill switches, docs.

**Phase 7 (optional, later)** — Server-side LiveKit translation agent publishing per-language dubbed tracks for large AvaLive audiences (one Gemini session per language instead of per listener — big cost saver at scale).

## 5. Open questions for you

- **Q1 — The $66 example.** $60 + $3 × 1 hr = $63. Did you mean $6/hour total (e.g., $3 each direction), or is $66 a typo for $63?
- **Q2 — Billing granularity.** OK to meter per-minute pro-rata at the $3/hr rate (recommended), or strict 1-hour blocks?
- **Q3 — Ad-hoc vs. pre-booked only.** Should the in-call Translate menu work even if translation wasn't chosen at booking (pay-as-you-go from wallet)? Proposal assumes **yes**.
- **Q4 — Creator's listen-translation in AvaLive** (creator hearing audience): AvaLive audience audio is limited — apply this only to AvaConsult/calls?
- **Q5 — AvaCoins↔USD rate** to display "$3/hr" in coins — confirm the conversion used by the wallet.

## 6. Google Developer Console — what I found & what I need

Found in the old project (`~/Documents/websites/avatok/.env.local`):
- `GOOGLE_GEMINI_API_KEY` — an `AIza…` Gemini API key (ends `…uA7Z4`) ✅ usable for the Live API
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (OAuth — not needed for this feature)

What I need from you / the console:
1. Confirm the project behind that key has **billing enabled** (Live Translate preview requires the paid tier) and check **Live API quota** (concurrent sessions — one per active listener).
2. If you prefer a fresh key scoped to this app, create one at AI Studio → API keys; I'll store it in `secrets/secret-values.env` and as a Worker secret (`GEMINI_API_KEY` on avatok-api).
3. Nothing else — ephemeral tokens mean the key lives only in the Worker.

## 7. Cost sanity (validate in Phase 0)
One listener-hour ≈ 60 min audio in + ~60 min audio out on `gemini-3.5-live-translate-preview`. Phase 0 spike must measure the real per-hour Google cost to confirm margin under the $3/hr price before we commit.
