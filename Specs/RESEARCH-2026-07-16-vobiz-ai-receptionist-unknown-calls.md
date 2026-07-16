# RESEARCH — Unknown-number calls → Vobiz → AI Receptionist → in-app inbox
**Date:** 2026-07-16 · **Target:** production feature (research only, nothing built) · **Owner ask:** AvaDialer intercepts unknown numbers, forwards them to Vobiz, our AI receptionist answers, and the call lands in a chat thread / inbox inside the app.

---

## TL;DR

**Most of this already exists in our codebase.** The AI receptionist (Gemini Live over a Durable Object, recording → R2, transcript + summary, card posted into the caller's chat thread via InboxDO, push notification) is fully built in `worker/src/do/reception_room.ts` — today it just runs over the app's own WebRTC path instead of a real phone line.

Only two pieces are new:

1. **Getting the call off the phone.** No Android app can forward a ringing call in software — the mechanism is **carrier conditional call forwarding** (an MMI code like `*67*<number>#` for forward-when-busy). Our `AvaCallScreeningService` already classifies unknown numbers; change it to silently **reject** unknown callers, and the carrier's forward-on-busy rule diverts them to a Vobiz number. Known contacts ring normally. This is exactly how every commercial AI call-screening app works.
2. **Bridging Vobiz audio into the receptionist.** Vobiz's **WebSocket voice integration** is a near-perfect fit for our Cloudflare-native stack: their cloud answers the DID, POSTs a webhook to our Worker, we reply with `<Stream>` XML, and Vobiz opens a **bidirectional WebSocket** streaming G.711 μ-law audio (8 kHz, 20 ms frames) straight to a Durable Object. No SIP stack needed on our side at all. The DO transcodes μ-law ↔ PCM and speaks to Gemini Live exactly the way `reception_room.ts` already does, then finalizes through the existing `postMessage()` → InboxDO path.

Estimated new code: one Kotlin change (screening verdict → reject), one MMI-code setup flow in the dialer UI, one new worker route + DO (`pstn_reception`), a Vobiz account with DIDs, and one new feature flag.

---

## 1. What Vobiz actually is and offers

[Vobiz](https://www.vobiz.ai/) is an AI-first SIP trunking / DID / voice-API provider (self-serve, 130+ countries, carrier-grade trunks with Airtel/Jio/VIL in India, pay-as-you-go).

Relevant capabilities, from their docs:

- **DIDs attached to trunks or applications** — buy a number, point it at your platform ([Phone Numbers](https://docs.vobiz.ai/account-phone-number)).
- **SIP trunks** with auto-provisioned domains (`trunkId.sip.vobiz.ai`), origination URIs with priority failover, webhooks on call start/end with duration, cost, and quality metrics ([Trunks](https://docs.vobiz.ai/trunks)).
- **Two ways to hand a call to an AI agent** ([Integrations](https://docs.vobiz.ai/integrations)):
  - **SIP INVITE to a platform** — LiveKit, Vapi, Retell, ElevenLabs, Pipecat, OpenAI Realtime. (LiveKit is interesting since we already run LiveKit for conferences, but it would need LiveKit's SIP service deployed — extra infra.)
  - **Raw WebSocket audio streaming** ([WebSockets guide](https://docs.vobiz.ai/integrations/websockets)) — **the recommended path for us**:
    1. Call hits our Vobiz number → Vobiz POSTs to our `/answer` webhook URL.
    2. We return `<Stream>` XML pointing at a WSS URL.
    3. Vobiz opens the WebSocket and exchanges JSON frames: `start`, `media` (every 20 ms), `playedStream`, `stop` inbound; `playAudio`, `clearAudio` (barge-in), `checkpoint` outbound.
    4. Audio is G.711 μ-law, 8 kHz, 8-bit, 160-byte/20 ms chunks — trivial to transcode to/from 16-bit PCM in a Worker.
    5. Hangup webhook fires at call end.
- Reference implementation: [Vobiz-Python-Voice-API-Example](https://github.com/vobiz-ai/Vobiz-Python-Voice-API-Example).

**Why WebSockets over SIP-to-LiveKit:** a Cloudflare Durable Object can terminate the Vobiz WebSocket directly — same hibernatable-WS pattern as InboxDO and ReceptionRoom. Zero new infrastructure, and it matches the "custom AI pipeline" row in Vobiz's own platform-selection table.

## 2. Getting the call off the phone (the Android reality)

Hard constraint: **Android provides no API to forward a specific ringing call to another number.** `CallScreeningService` can only allow, reject, silence, or skip-log a call ([Android docs](https://developer.android.com/develop/connectivity/telecom/dialer-app/screen-calls), [API reference](https://developer.android.com/reference/android/telecom/CallScreeningService)). Forwarding happens in the **carrier network**, controlled by MMI/USSD codes.

The industry-standard pattern (used by OsmO, Rosie, and every third-party AI screening app — [how AI call screening works](https://getosmo.app/blog/how-ai-call-screening-works.html)):

1. **One-time setup:** the app dials a conditional-forwarding MMI code so the carrier forwards *busy* (and optionally *unanswered*) calls to the AI's number:
   - `*67*<vobiz-DID>#` — forward when busy (GSM; this is the one triggered by a rejected call)
   - `*61*<vobiz-DID>#` — forward when unanswered (bonus: missed calls also get the receptionist)
   - `*62*<vobiz-DID>#` — forward when unreachable (phone off / no signal)
   - Verizon/CDMA-style carriers use `*71`/`*72` star codes instead; codes must be carrier-aware.
2. **Per-call:** `AvaCallScreeningService.onScreenCall()` fires for numbers **not in the user's contacts** (that's literally the API's trigger condition). For an unknown/spam-flagged number, respond with `setDisallowCall(true) + setRejectCall(true)`. The network sees UDUB ("user determined user busy") → the **forward-on-busy rule kicks in** → the caller is seamlessly diverted to our Vobiz DID. They hear ringing the whole time; the phone never visibly rings.
3. Known contacts → `setDisallowCall(false)` → ring normally. Untouched.

What we already have: `AvaCallScreeningService.kt` holds the call-screening role and classifies against the spam snapshot — today it is deliberately **label-only, fail-open**. The change is adding a reject path (flag-gated), plus a settings flow that dials/clears the MMI codes and verifies state (`*#67#` queries current CFB status).

**Risks to test on real SIMs:**
- CallScreeningService rejection → CFB behavior is carrier-dependent; some carriers route rejects to carrier voicemail regardless. Must verify per-carrier (and document a `##67#` disable path).
- Dual-SIM: forwarding codes apply per-SIM; setup flow must target the active voice SIM.
- Carrier voicemail conflicts: forward-on-busy replaces the carrier's voicemail-on-busy — actually a feature for us (the receptionist *is* the voicemail), but users should be told.
- Some carriers charge for forwarded-leg minutes (the forwarded leg is an outbound call from the user's number to the Vobiz DID at carrier rates).

## 3. The AI receptionist — what exists vs. what the owner chose

Owner picked **build on Cloudflare** rather than a hosted agent platform. Good news: we already did.

**Already built (production-shaped, per codebase audit):**
- `worker/src/do/reception_room.ts` — Gemini Live (via Cloudflare AI Gateway) conversational receptionist; two-way WAV recording → R2; transcript; summary; D1 persistence.
- `postMessage()` (~lines 914–1004) — resolves the right thread (deterministic DM `dm_<lo>__<hi>` if the caller is a known AvaTOK uid, else `recept_<owner>__tel:<phone>`), builds a `{t:"recept", caller_name, caller_phone, summary, transcript, has_recording, …}` envelope, appends via `InboxDO POST /append` with `kind:"receptionist"` and `media_ref` = R2 recording key, then pushes "Ava took a message" via `Q_PUSH`.
- `app/lib/features/avatok/chat_thread.dart` already renders the receptionist card (summary + transcript + play button). **The "dump the call in a chat thread" requirement is 100% done.**
- Fallback: `voicemail_room.ts` (no-LLM voicemail bot) if we want a cheap tier.

**New piece — `PstnReceptionRoom` DO (or a transport adapter on ReceptionRoom):**
- Terminates Vobiz's WebSocket (hibernatable WS, same as everything else).
- Transcodes G.711 μ-law 8 kHz ↔ 16-bit PCM (μ-law codec is ~40 lines; Gemini Live takes 16 kHz PCM in, returns 24 kHz PCM out → downsample + compand to 8 kHz μ-law, 160-byte/20 ms frames).
- Sends `clearAudio` on barge-in.
- On `stop`/hangup webhook → runs the existing finalize path (recording → R2, transcript, summary, `postMessage()` → InboxDO → push).
- If Workers-AI voices are ever preferred over Gemini, Cloudflare's new [`@cloudflare/voice`](https://developers.cloudflare.com/agents/communication-channels/voice/) Agents SDK (beta) gives STT (Deepgram Flux/Nova-3), LLM, and TTS (Aura-1) pipelines on Durable Objects — but its telephony adapter is Twilio-only today, so we'd still write the Vobiz WS adapter ourselves. Sticking with the proven Gemini Live path in `reception_room.ts` is the lower-risk call.

## 4. Caller → owner mapping (the one real design question)

When the forwarded call arrives at Vobiz, our `/answer` webhook must know **whose receptionist** should answer. The SIP-standard way is the **Diversion / History-Info header** — carriers add it on forwarded calls, carrying the user's own number (the forwarded-from number), while `From` keeps the original caller's ID ([Diversion header primer](https://andrewjprokop.wordpress.com/2014/09/22/an-introduction-to-the-sip-diversion-header/), [TransNexus SIP INVITE fields](https://transnexus.com/whitepapers/sip-invite-header-fields/)).

- **Option A — shared DID pool + Diversion header (cheap, elegant):** one (or a few) Vobiz DIDs for everyone; webhook reads the diverted-from number → lookup owner. **UNVERIFIED:** whether Vobiz surfaces Diversion/History-Info in its answer-webhook payload is not stated in their public docs, and not all carriers send it. **Must confirm with Vobiz support and test with real carriers before committing.**
- **Option B — one DID per user (robust, costs per-number/month):** the DID itself identifies the owner; `To` number → owner lookup. This is what most commercial AI-receptionist products do. Works on every carrier regardless of Diversion support.
- Pragmatic plan: pilot with Option B (a handful of testers, one DID each), test Diversion in parallel, move to A if it proves reliable on target carriers.
- **SUPERSEDED by owner decision 2026-07-16 — see §5b:** shared DID pool from day one, with rejection pre-registration as the primary mapping mechanism and Diversion as secondary.

## 5. Recommended end-to-end architecture

```
Unknown caller ──► User's phone (carrier)
                    │  AvaCallScreeningService: not in contacts / spam-flagged
                    │  → setDisallowCall + setRejectCall  (known contacts ring normally)
                    ▼
             Carrier CFB rule (*67*<vobiz DID>#, set once at onboarding)
                    ▼
             Vobiz DID  ──POST /api/pstn/answer──►  Worker (maps DID/Diversion → owner uid)
                    ◄──── <Stream wss://api.avatok.ai/pstn/stream/<session>> ────
                    ▼
             Bidirectional WS, G.711 μ-law 20ms frames
                    ▼
             PstnReceptionRoom DO ── μ-law↔PCM ── Gemini Live (existing receptionist brain)
                    ▼ (hangup webhook / stop event)
             Existing finalize: recording→R2, transcript, summary
                    ▼
             postMessage() → InboxDO /append (kind:"receptionist") → push "Ava took a message"
                    ▼
             Card in chat thread / receptionist inbox in AvaTOK  ✅ already renders
```

**Feature flags (all default OFF, declared in `PlatformConfig` + `DEFAULTS` in the same change, per the fake-flag rule):** `pstnReceptionist` (server), client mirror on `RemoteConfig`, plus a native-mirror JSON file for the screening service (which runs without the Flutter engine) — same pattern as `missedCallOverlay`.

## 5b. OWNER DECISIONS — 2026-07-16 (cost control)

DIDs cost ~₹600/number/month plus inbound/outbound per-minute, on top of Gemini cost and our margin — per-user DIDs don't scale. Decisions:

1. **Shared DID pool** — a small pool of Vobiz numbers serves all users. No per-user DID.
2. **Hard 3-minute cap on the AI leg.** The DO enforces it: polite wrap-up cue to Gemini at ~2:30 ("ask for name, number, and reason, then close"), hard hangup at 3:00. Cap goes in config as a **numeric** flag (`receptionistMaxSeconds`, default 180 — remember `numericKeys` entry in `config.ts`, unlike booleans).
3. **Recording + summary card lands in the user's inbox in AvaDial** — the existing `postMessage()` → InboxDO card, surfaced in the AvaDial shell (receptionist inbox), not only the AvaTok chat thread.

**Making the shared pool work — caller→owner mapping without per-user DIDs.** Two mechanisms, layered:

- **Primary — rejection pre-registration:** the moment `AvaCallScreeningService` rejects an unknown call, the app fires `POST /api/pstn/expect {owner_uid, caller_number}` to the worker (native code, fire-and-forget, ~100 bytes). The forwarded call reaches Vobiz 1–3 s later; the `/answer` webhook matches the incoming caller number against expectations from the last ~30 s → owner resolved. Works on any carrier, no SIP header dependency. KV/DO map with short TTL. Failure mode: phone has no data at that instant (rare — it just interacted with the network) → fall through to secondary.
- **Secondary — SIP Diversion/History-Info header:** if Vobiz surfaces the diverted-from number in the webhook, that alone identifies the owner. Still worth confirming with Vobiz support; if reliable, it becomes primary and the pre-registration becomes the fallback.
- **Unmatched calls** (neither mechanism resolves): generic greeting, take a message, hold it under the caller number for later claim — or simply reject to keep costs at zero. Decide during build.

Pool sizing: DIDs only need to cover *concurrent* screened calls, not users — a pool of 5–10 numbers covers thousands of users; grow with concurrency metrics from Vobiz's call-start/end webhooks.

**Cost per screened call (shape):** Vobiz inbound leg (≤3 min) + Gemini Live (≤3 min) + amortized pool rental (₹600 × pool size / calls per month). The 3-min cap bounds the two per-minute items; pool amortization shrinks with volume.

## 5c. PRODUCT MODEL — 2026-07-16 (triage, not conversation)

**Ava is a triage receptionist, not a chatbot.** Script shape: *"Hi, Davy isn't available right now — may I ask who's calling and what it's about?"* → caller answers → one or two probing follow-ups max → *"I'll let Davy know. Thanks for calling."* → hang up. Typical call 30–60 s, well under the 3-min cap (the cap becomes a safety net, not the norm). The owner's display name is resolved from the DID/expectation → owner mapping and injected into the system prompt.

**The loop that makes it self-improving:** every screened call yields `{caller_number, stated_name, stated_intent, category}`. Davy hears the recording, recognizes his ex, adds her to contacts → next time she rings straight through. Screening is **only ever for unknowns**, and every screen either converts the number to a contact or enriches its profile.

**Reputation harvesting (network effect):** classify each screened call (sales / scam / delivery / personal / business / robocall) and aggregate **label-level data only** per number across all users → global rapport score per number, feeding back into the existing spam snapshot (`spam_snapshot.json` already ships SHA-256(E.164)→score — same pipe, new source). Privacy: transcripts and recordings stay per-owner (scoped, per rulebook); only the category label and number hash are pooled. AvaBrain consent toggles apply.

### The Amazon/pizza problem — cold-start "who's who"

Legit transactional callers (delivery riders, couriers, banks) will get frustrated if Ava screens them. Layered mitigations, in order of leverage:

1. **India regulatory prefixes (free, day-one signal):** TRAI mandates number series — **`140xxxxx` = telemarketing** (screen or reject outright), **`160xxxxx` = transactional/service calls** (banks, Amazon, official notifications → **patch straight through**). For the Indian market this solves a large slice of the problem before we have any of our own data. (Verify current TRAI series rules at build time.)
2. **Outgoing-call reciprocity:** if the owner *dialed* this number recently (call log lookback, e.g. 30 days), treat it as a pseudo-contact and ring through. Delivery riders usually call the number you ordered with or that you called first; this plus (1) covers most delivery flows. Cheap: `CallScreeningService` can check the device call log natively.
3. **Live patch-through (the real fix):** Ava doesn't have to be a dead end. If the caller states a patch-worthy intent ("I'm outside with your order"), Ava says "one moment" and **bridges the owner in live**: the DO pushes a high-priority FCM → the app rings as an AvaVoice call → owner accepts → DO mixes the two audio legs (it already terminates the caller's audio; the owner joins as a second WS/WebRTC leg). Caller experience: a 15-second receptionist detour, not a wall. Alternative mechanic: Vobiz-side transfer/dial-out to the owner's number (an outbound Vobiz leg — costs minutes; check Vobiz XML for a transfer/dial verb). Also give callers an escape hatch: "say 'urgent' or press 0 to ring through."
4. **Expected-delivery mode:** one-tap "expecting a call" toggle in AvaDial that pauses screening for N hours (or auto-suggested when an OTP/delivery SMS just arrived — we own AvaSms).
5. **Reputation scores** ((above)) take over as the dataset grows — numbers repeatedly classified "delivery" get auto-patch treatment globally.

**Hidden/withheld caller ID:** always route to Ava (can't be in contacts, can't pre-register a number match — the expectation entry is matched by owner + "anonymous" marker instead of caller number).

## 5d. V1 SCOPE REVISION — 2026-07-16 (owner decision: voicemail first, AI later)

The auto-screening model (§5c) risks frustrating genuine callers and needs heavy plumbing. **V1 drops the AI conversation entirely and puts the callee in control.** *(Reconfirmed by owner 2026-07-16: v1 is a voicemail system only.)*

### V1 flow

1. **Call comes in → phone rings normally.** The incoming-call UI shows **three options: Accept · Decline · Send to voicemail agent.** The callee decides per call — no automatic screening of unknowns.
2. **"Send to voicemail agent"** (and also **no-answer timeout**, and **hidden/withheld caller ID which auto-routes without ringing**): the call is rejected/unanswered → carrier conditional forwarding (`*67`/`*61` to a pool DID) → Vobiz → our Worker/DO plays a recorded prompt — *"You are being transferred to a voicemail box, please leave a message."* — records the message, hangs up.
3. **Recording lands as a card in the callee's inbox** (existing `postMessage()` → InboxDO path; play button already renders).
4. **No Gemini, no conversation, no 3-min AI cost.** The Vobiz leg is the only per-minute cost, and voicemails are short. Cap recordings at ~60–90 s.

**Existing code advantage:** `worker/src/do/voicemail_room.ts` + `routes/voicemail_routes.ts` (the no-LLM voicemail bot, gated by `voicemailBot`) already implement exactly this brain — v1 is essentially *voicemail_room fed by a Vobiz WebSocket leg* instead of the in-app path. The AI receptionist (§5c, `reception_room.ts`) becomes a v2 upgrade behind the same plumbing: same forwarding, same Vobiz bridge, same inbox delivery — just swap the DO that answers.

### Community spam database (the data layer, still in v1)

CNAP context (owner insight): India's CNAP shows the **Aadhaar-registered private name**. Companies' official numbers show company names, but ~90% of delivery/sales people call from personal numbers — so CNAP shows "Monika", not "Monika – sales agent". CNAP alone can't classify callers; only crowd data can.

- After any call from a non-contact, the after-call screen (we already have the missed-call overlay surface) offers **"Report spam & block"**.
- Reports go to the worker keyed by number hash. At a **threshold of 5–10 distinct reporters**, the number is marked spam globally, tracked/studied, and pushed into the existing `spam_snapshot.json` pipe.
- Next time that number calls **any** AvaTOK subscriber, the incoming-call UI shows a spam warning (`AvaCallScreeningService` verdict → red banner — this surface already exists and is label-only today, which is exactly right for this).
- Report metadata to capture: reporter uid (for distinct-count + abuse prevention), **category (sales/scam/robocall/delivery/other — CONFIRMED by owner 2026-07-16)**, timestamp. Guard against brigading: distinct accounts, rate limits, maybe SIM-verified accounts only. Categories double as training data for the v2 reputation scores.

### What moves to v2+

AI triage conversation (§5c), live patch-through, TRAI-prefix routing, reputation auto-actions. All sit behind the same forwarding + Vobiz + inbox plumbing built in v1, so nothing in v1 is throwaway.

## 6. Costs & open items

- **Vobiz:** pay-as-you-go; need account + balance, DID monthly fees, and inbound per-minute rates (get a quote — pricing page didn't publish per-country inbound rates). Each screened call = one Vobiz inbound leg + Gemini Live minutes (already the receptionist's cost profile) + the user's carrier forwarded-leg charge if their plan bills it.
- **Verify with Vobiz support:** Diversion/History-Info in webhook payload (§4); webhook retry semantics; India-DID KYC requirements if targeting Indian testers; recording on their side vs. ours (we already record in the DO — keep ours).
- **Verify on devices:** reject→CFB behavior on the testers' actual carriers (the single biggest go/no-go); dual-SIM handling; MMI code variants per carrier.
- **Privacy/consent:** the receptionist records callers; check recording-consent rules per market before prod flip (some jurisdictions require an announcement — easy to add as the agent's first line).
- **Prior art in repo:** `Specs/PROPOSAL-AI-RECEPTIONIST.md`, `Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md` — the PSTN bridge should be written as an extension of those, not a parallel system.

## Sources

- [Vobiz — SIP Trunking API](https://docs.vobiz.ai/trunks) · [Integrations & SDKs](https://docs.vobiz.ai/integrations) · [WebSocket voice agents](https://docs.vobiz.ai/integrations/websockets) · [vobiz.ai](https://www.vobiz.ai/)
- [Android — Screen calls](https://developer.android.com/develop/connectivity/telecom/dialer-app/screen-calls) · [CallScreeningService reference](https://developer.android.com/reference/android/telecom/CallScreeningService)
- [How AI call screening works (conditional forwarding pattern)](https://getosmo.app/blog/how-ai-call-screening-works.html)
- [Cloudflare — Voice agents (Agents SDK)](https://developers.cloudflare.com/agents/communication-channels/voice/) · [Cloudflare Realtime voice AI blog](https://blog.cloudflare.com/cloudflare-realtime-voice-ai/) · [Add voice to your agent](https://blog.cloudflare.com/voice-agents/)
- [SIP Diversion header primer](https://andrewjprokop.wordpress.com/2014/09/22/an-introduction-to-the-sip-diversion-header/) · [TransNexus — SIP INVITE header fields](https://transnexus.com/whitepapers/sip-invite-header-fields/)
