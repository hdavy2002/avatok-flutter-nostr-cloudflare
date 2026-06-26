# AvaTalk — Non-secret configuration

Public identifiers and endpoints. **Secrets** (Clerk secret key, Bunny API key,
RealtimeKit org key) live only in Cloudflare Worker secrets / the gitignored
`secrets/` folder — never here.

## Cloudflare
- Account ID: `fd3dbf43f8e6d8bf65bd36b02eb0abb0` (hdavy2005@gmail.com)
- Signaling Worker (temp, calls): `https://avatok-call-signaling.getmystuffme.workers.dev`
- **Nostr relay (NIP-01):** `wss://avatok-relay.getmystuffme.workers.dev` → maps to `relay.avatok.ai` later
- **"Cloudflare Realtime" = three separate products:** **(1) Realtime TURN** (per-GB relay for 1:1/mesh
  calls), **(2) Realtime SFU / "Calls"** (per-GB media hub for paid AvaConsult/AvaVision group sessions),
  **(3) RealtimeKit** (ready-made SDK — *legacy/unwired*). None of these carry chat presence.
- **ICE (STUN+TURN) for 1:1 & free mesh (≤5):** `https://avatok-call-signaling.getmystuffme.workers.dev/ice`
  (Cloudflare **Realtime TURN**, key `add95c6c…`, token in Worker secrets). TURN keys in account:
  `avatok-turn-prod`, `avaflutter` (`add95c6c…`), `empty-hall-65c1`.
- **Group sessions (AvaConsult / AvaVision, paid) — Realtime SFU / "Calls":** proxied by avatok-api
  `routes/consult.ts` → `rtc.live.cloudflare.com/v1/apps/{CALLS_APP_ID}`. Live Calls app: `shiny-thunder-2e45`
  (`5bda30a75bbaf90578422dbb429e8cbd`). Gated by `CALLS_APP_ID`/`CALLS_APP_SECRET` (503 if unset).
- **Group calls (AvaTalk, ≤25, paid) — LiveKit, *not* Cloudflare:** avatok-api `routes/conference.ts`
  (secrets `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`).
- **RealtimeKit (legacy/unwired):** old `avatok-calls` worker `…/join` + standalone `avaconsult/` app.
  App `avatok-flutter`: `7e5b20c0-da74-4848-9884-73af53bb3fb0` (presets `group_call_host/participant/guest`,
  `livestream_host/viewer`; auth via Worker secret `CF_API_TOKEN`). **Superseded — kept as dead code only.**

## Clerk (existing avatok.ai tenant)
- Publishable key (public): `pk_live_Y2xlcmsuYXZhdG9rLmFpJA`

## Firebase / FCM
- Project: `avatok-e19ef` · Android package: `ai.avatok.avatok_call`

## Bunny.net Stream
- Library ID: `553793` · CDN: `vz-837d504e-6a8.b-cdn.net` · Pull zone: `vz-837d504e-6a8`

## App
- Android applicationId: `ai.avatok.avatok_call`
- Direct test APK: GitHub release `calltest-latest`
