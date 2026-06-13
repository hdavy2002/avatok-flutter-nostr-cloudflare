# PHASE C — Live-stream viewer (WHEP / LL-HLS) (PARALLEL)

> Carry `MASTER-PROMPT.md`. Runs **simultaneously** with A, B, D, E **after** Phase 0. You build the browser viewer for a live stream. **No commit.**

## Critical correction (read this twice)
Live streaming uses **Cloudflare Stream Live**, NOT LiveKit. The creator publishes from the phone via **WHIP**; viewers play the **WHEP** (low-latency WebRTC) or **LL-HLS** URL returned by the Worker. **Do not add LiveKit. Do not add any large media SDK.** The only dependency you may use is **`hls.js`** (for the LL-HLS fallback). The WHEP player is a hand-rolled `RTCPeerConnection` (~100 lines). Source of truth: `worker/src/routes/live.ts`.

## Your goal
`/watch/<id>` plays the live stream in a `<video>` element with the lowest latency the browser supports (WHEP first, LL-HLS fallback), shows live viewer count + chat, and lets the viewer send a donation — all for a holder of a valid ticket.

## Files you own (create ONLY these)
```
web/src/pages/watch/[id].astro       # viewer page shell
web/src/islands/live/                # LiveViewer.tsx, WhepPlayer.ts, HlsFallback.ts, LiveChat.tsx, DonateButton.tsx, ViewerCount.tsx
```
Do **not** touch the shared kit, layout, nav, config, or other phases' files. Import `lib/apiClient.ts` + `lib/clerk.tsx` from Phase 0 read-only.

## Endpoints you use (MASTER-PROMPT §4)
- `GET /api/live/:listingId/join` → `{ whep, hls, room_token, starts_at, ends_at }` (requires a ticket; auth via Clerk JWT)
- `GET /api/live/:listingId/state` → `{ whep, hls, state, started_at, ... }`
- `GET /api/live/:listingId/room` → **WebSocket** (signed `?token=` = `room_token` from join): chat + viewer count
- `POST /api/live/:listingId/donate`

> Read `worker/src/routes/live.ts` **(read only)** to confirm the WS message shapes and the join response before coding. Do not edit it.

## Steps
1. **`/watch/[id]` shell**: minimal Astro page that hydrates `LiveViewer` (`client:load`). It may server-render a poster/teaser from `getListing` for the loading state, but the stream itself is client-only.
2. **Gate + join:** the `/watch/<id>` page itself may load ungated (show poster + "Join" button). On Join, call `requireGuestAuth()` (Phase 0) to ensure a session (opens the email→OTP `GuestGate` only if needed), then call `/api/live/:id/join` with that JWT. If the user has no ticket the Worker returns an error → show a "Book to watch" CTA linking to `/book/<id>` (Phase B). If `state` shows the stream hasn't started, poll `/state` and show a countdown to `starts_at`. (Gating model: MASTER-PROMPT §4b.)
3. **WHEP player (`WhepPlayer.ts`)** — primary path, lowest latency:
   - Create `RTCPeerConnection`, add a recvonly transceiver, `createOffer`, `POST` the SDP to the `whep` URL with `Content-Type: application/sdp`, set the answer. Handle ICE per the WHEP spec (`PATCH`/`DELETE` for trickle/teardown if the endpoint advertises it).
   - Attach the remote `MediaStream` to the `<video>` element. Autoplay muted, then unmute on user gesture (browser autoplay policy).
4. **LL-HLS fallback (`HlsFallback.ts`)** — if WHEP fails (no WebRTC, Safari quirks, connection error), load the `hls` URL with `hls.js` (or native HLS on Safari via `video.src`). Switch automatically; show a tiny "low-latency unavailable, using HLS" note.
5. **`LiveChat` + `ViewerCount`:** open the `/room` WebSocket with `?token=room_token`. Render incoming chat, show the viewer count, and send chat messages per the WS protocol in `live.ts`. Reconnect with backoff on socket drop.
6. **`DonateButton`:** `POST /api/live/:id/donate` (amount from a small `zine` sheet). Show a sticker animation on success. (Wallet/funding is Phase B's domain — if the donor needs funds, link to the existing top-up.)
7. **Lifecycle:** when `state` flips to ended, tear down the `RTCPeerConnection` and socket, show an "ended" card with a link back to the creator (`/c/<handle>`).
8. **Performance & smoothness (the whole point):** WHEP first for sub-second latency; preconnect to the media origin; keep the player island tiny; don't ship `hls.js` until the fallback actually triggers (dynamic `import()`).

## Acceptance checklist
- [ ] With a valid ticket, `/watch/<id>` plays the live WHEP stream; latency is visibly low.
- [ ] WHEP failure auto-falls back to LL-HLS without a manual step.
- [ ] No ticket → graceful "Book to watch" CTA to `/book/<id>`.
- [ ] Chat + viewer count work over the `/room` WebSocket; donate posts succeed.
- [ ] `hls.js` is loaded lazily (only on fallback); no LiveKit anywhere; no other heavy media SDK.
- [ ] `zine` look; responsive (full-bleed video on phone, sidebar chat on desktop); `cd web && npm run build` compiles. No commit.

## Graphiti (then STOP)
`add_memory(group_id="proj_avaflutterapp", name="web-client PHASE-C complete — live viewer (WHEP/HLS)", ...)` — files, the WHEP negotiation approach, the WS protocol you used, fallback logic, and confirm no LiveKit was added. **Do not commit.**
