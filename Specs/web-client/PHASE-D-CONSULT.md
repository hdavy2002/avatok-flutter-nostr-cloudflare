# PHASE D — 1:1 consult room (Cloudflare Realtime SFU, native WebRTC) (PARALLEL)

> Carry `MASTER-PROMPT.md`. Runs **simultaneously** with A, B, C, E **after** Phase 0. You build the fan's side of a paid 1:1 consult in the browser. **No commit.**

## Critical correction (read this twice)
Consult uses the **Cloudflare Realtime SFU** via the Worker as a thin authed proxy at `ANY /api/consult/:bookingId/sfu/*`. The browser is a **native `RTCPeerConnection`** client — **no LiveKit, no Dyte, no RealtimeKit SDK** (the app deliberately avoids them for the perf budget). Source of truth: `worker/src/routes/consult.ts` (read its header comment — it spells out the SFU-proxy design).

## Your goal
`/consult/<booking>` lets the fan join their booked 1:1 session: two-way audio/video against the SFU, an attendance/chat/countdown side-channel, and clean handling of the gate states (too early, not your session, ended).

## Files you own (create ONLY these)
```
web/src/pages/consult/[booking].astro   # consult room shell
web/src/islands/consult/                # ConsultRoom.tsx, SfuClient.ts, RoomSocket.ts, Countdown.tsx, MediaControls.tsx, PreJoin.tsx
```
Do **not** touch the shared kit, layout, nav, config, or other phases' files. Import `lib/apiClient.ts` + `lib/clerk.tsx` from Phase 0 read-only.

## Endpoints you use (MASTER-PROMPT §4)
- `GET /api/consult/:bookingId/join` → gate + identity (errors: `too early` **425** with `opens_at`, `not your session` **403**, `session not active` **409**, `live_event` **409** → must use `/api/live`)
- `GET /api/consult/:bookingId/room` → **WebSocket**: attendance, chat, countdown
- `ANY /api/consult/:bookingId/sfu/*` → authed proxy to Cloudflare Realtime SFU (you make WHATWG `fetch` calls here for the SFU session/track API; pass the Clerk JWT)
- `POST /api/consult/:bookingId/complete` | `/cancel` | `/extend`

> Read `worker/src/routes/consult.ts` **(read only)** to learn the exact `/sfu/*` sub-paths it forwards (session create, track add/answer, renegotiate) and the `/room` WS message shapes. The SFU HTTP API is Cloudflare Realtime's — follow whatever the proxy forwards. **Do not edit the worker.**

## Steps
1. **`/consult/[booking]` shell**: hydrates `ConsultRoom` (`client:load`); fully client-side (no SSR of media).
2. **PreJoin:** `PreJoin.tsx` requests camera+mic permission, shows a local preview + device pickers, then ensures a session via `requireGuestAuth()` (Phase 0 — opens the email→OTP `GuestGate` only if not already signed in; gating model MASTER-PROMPT §4b) and calls `/api/consult/:booking/join` with that JWT.
   - **425 too early** → show `Countdown` to `opens_at`, retry join automatically when it opens.
   - **403 not your session** → "this isn't your booking" + link to `/dashboard`.
   - **409 session not active** → show status; if `live_event`, redirect to `/watch/<listing_id>`.
3. **SFU client (`SfuClient.ts`)** — native WebRTC against Cloudflare Realtime via the `/sfu/*` proxy:
   - Create the SFU session (proxied `POST .../sfu/...`), create a local `RTCPeerConnection`, publish local audio+video tracks (add tracks via the SFU track API the proxy forwards), then subscribe to the remote peer's tracks and attach to a `<video>`.
   - Handle renegotiation/ICE exactly as Cloudflare Realtime's API requires (the proxy passes these through). Keep it to native browser WebRTC APIs — no SDK.
4. **RoomSocket (`RoomSocket.ts`)**: open `/api/consult/:booking/room` WS for attendance ("creator joined"), in-call chat, and the authoritative countdown. Reconnect with backoff.
5. **MediaControls:** mute/unmute, camera on/off, leave. On leave or when the countdown hits zero, tear down the PC + socket. The creator (app side) drives `/complete`; the fan side should handle the room ending gracefully and may call `/cancel` if they back out before it starts (refund engine handles the money — you just call the endpoint).
6. **`/extend`:** if the UI offers "add 5 minutes", call `POST /api/consult/:booking/extend` (this touches the money/refund engine server-side — just call it; don't compute money client-side).
7. **Smoothness:** show connection state clearly (connecting / connected / reconnecting), pre-warm permissions in PreJoin, and keep the island lean.

## Acceptance checklist
- [ ] A fan with a confirmed booking joins and gets two-way audio/video with the creator via the SFU.
- [ ] Gate states 425 / 403 / 409 are handled with the right UX (countdown / dashboard link / redirect).
- [ ] `/room` WS delivers attendance + chat + countdown; reconnects on drop.
- [ ] No LiveKit / Dyte / RealtimeKit SDK — native `RTCPeerConnection` only.
- [ ] `/complete` is creator-driven; fan-side handles end/leave/extend correctly; money is server-side only.
- [ ] `zine` look; responsive; `cd web && npm run build` compiles. No commit.

## Graphiti (then STOP)
`add_memory(group_id="proj_avaflutterapp", name="web-client PHASE-D complete — consult room (SFU)", ...)` — files, the exact `/sfu/*` sub-paths and `/room` WS messages you used, gate-state handling, and confirm native-WebRTC-only. **Do not commit.**
