# PHASE E — AI voice agent call (Gemini Live, browser WebSocket) (PARALLEL)

> Carry `MASTER-PROMPT.md`. Runs **simultaneously** with A, B, C, D **after** Phase 0. You build the browser caller side of an AvaVoice AI agent. **No commit.**

## Critical facts (read this twice)
AvaVoice agents run on **Google Gemini Live** — voice model `gemini-live-2.5-flash-native-audio`, vision model `gemini-3.1-flash-live-preview`. The Worker mints a **short-lived ephemeral Gemini auth token**; the **browser** opens the Gemini Live WebSocket directly with that token. **No Google secret ever touches the browser. No ElevenLabs — it is not used anywhere.** Source of truth: `worker/src/routes/avavoice.ts` and `app/lib/core/avavoice_api.dart` (the app's reference implementation of this exact flow).

## Your goal
`/agent/<id>` lets a fan talk to an AI voice agent in the browser: tap to start → mic streams up, agent audio streams back in real time. Vision agents additionally send camera/screen frames. Plus the shareable creator web-call link.

## Files you own (create ONLY these)
```
web/src/pages/agent/[id].astro       # agent call page shell
web/src/islands/agent/               # AgentCall.tsx, GeminiLiveClient.ts, AudioPipeline.ts, VisionSender.ts, CallControls.tsx
```
Do **not** touch the shared kit, layout, nav, config, or other phases' files. Import `lib/apiClient.ts` + `lib/clerk.tsx` from Phase 0 read-only.

## Endpoints you use (MASTER-PROMPT §4)
- `GET /api/avavoice/agents/:id` (agent metadata: name, voice, vision?, price) and `GET /api/avavoice/marketplace`
- `POST /api/avavoice/sessions/start` → `{ ephemeral Gemini token, sessionId, model, ... }`
- `POST /api/avavoice/sessions/heartbeat` (keepalive) , `POST /api/avavoice/sessions/stop`
- (booking, if the agent requires it) `POST /api/avavoice/bookings` — but the live call is `sessions/start` + `calls/now` (`POST /api/avavoice/calls/now`)

> Read `worker/src/routes/avavoice.ts` and `app/lib/core/avavoice_api.dart` **(read only)** to copy the **exact** session-start request fields, the token field name, and the Gemini Live setup message shape the app already uses. Mirror the app — do not improvise the protocol. **Do not edit either file.**

## Steps
1. **`/agent/[id]` shell is PUBLIC and ungated** — server-render the agent card (name, avatar, description, price) from `getAgent`/listing for instant context + good link preview. The shared URL must open for anyone with **no auth prompt on load**. Hydrate `AgentCall` (`client:load`). Show a clear "Talk now" button.
2. **Gate at "Talk now", not on load:** when the user taps Talk now, call `requireGuestAuth()` (Phase 0 `lib/clerk.tsx`) — if no session, it opens the `GuestGate` (email → OTP → `identity/guest`) and resolves a JWT; if already signed in, it returns immediately. Then call `POST /api/avavoice/sessions/start` **with that JWT** (the endpoint requires `requireUser`; a guest JWT satisfies it). Receive the **ephemeral Gemini token** + `sessionId` + `model`. Handle **"Agent Busy"/concurrency** and the **hard time cap** errors exactly as returned — the Worker enforces billing/concurrency/caps; you just react. (See MASTER-PROMPT §4b for the gating model.)
3. **GeminiLiveClient.ts:** open the Gemini Live **WebSocket** to `generativelanguage.googleapis.com` (v1alpha live endpoint) authenticated with the ephemeral token. Send the **setup message** with the right `model` (voice vs vision) — copy the shape from the app's `avavoice_api.dart`. Handle server `setupComplete`, audio chunks, and turn events.
4. **AudioPipeline.ts (Web Audio API):**
   - Mic up: `getUserMedia({audio})` → capture PCM (AudioWorklet or ScriptProcessor) at the sample rate Gemini expects → send as audio chunks over the WS.
   - Agent down: receive audio chunks → decode/queue → play through an `AudioContext` with a jitter buffer so it sounds smooth. Show a simple talking indicator.
   - Echo/half-duplex: respect Gemini's turn-taking; mute mic capture during agent speech if the app does.
5. **VisionSender.ts (vision agents only):** if `model` is the vision model, also capture camera (or screen-share via `getDisplayMedia`) frames at a low FPS and send per the app's format. Gate behind the agent's `vision` flag.
6. **Heartbeat + stop:** post `sessions/heartbeat` on the Worker's interval; on hang-up or cap reached, post `sessions/stop`, close the WS, and tear down audio. Show a clean "call ended / time used" card.
7. **Shareable creator web-call link:** the same `/agent/<id>` URL is the shareable link; ensure it works for a fresh visitor (server-rendered card + start flow). If the agent is "creator-pays", the Worker handles billing — the visitor just talks.
8. **Smoothness (critical):** minimize mic→agent→speaker latency; small jitter buffer; lazy-load the audio worklet; never block the UI thread with audio processing.

## Acceptance checklist
- [ ] `/agent/<id>` opens for a fresh visitor with **no auth prompt on load** and renders the agent card with valid link-preview meta.
- [ ] Tapping "Talk now" fires the `GuestGate` (email → OTP → guest) only if not already signed in, then mints an ephemeral token via `sessions/start` with the guest JWT and opens the Gemini Live WS directly from the browser (no Google secret client-side).
- [ ] Two-way audio works and sounds smooth; vision agents send frames when flagged.
- [ ] Heartbeat keeps the session alive; stop/cap/busy states handled per the Worker's responses.
- [ ] Protocol matches the app's `avavoice_api.dart` (same fields/setup) — no improvised endpoints. No ElevenLabs.
- [ ] `zine` look; responsive; `cd web && npm run build` compiles. No commit.

## Graphiti (then STOP)
`add_memory(group_id="proj_avaflutterapp", name="web-client PHASE-E complete — AI agent call (Gemini Live)", ...)` — files, the exact session-start fields + Gemini setup message you mirrored from the app, audio pipeline approach, vision handling, heartbeat/stop logic. **Do not commit.**
