# AvaTalk — Non-secret configuration

Public identifiers and endpoints. **Secrets** (Clerk secret key, Bunny API key,
RealtimeKit org key) live only in Cloudflare Worker secrets / the gitignored
`secrets/` folder — never here.

## Cloudflare
- Account ID: `fd3dbf43f8e6d8bf65bd36b02eb0abb0` (hdavy2005@gmail.com)
- Signaling Worker (temp, calls): `https://avatok-call-signaling.getmystuffme.workers.dev`
- **Nostr relay (NIP-01):** `wss://avatok-relay.getmystuffme.workers.dev` → maps to `relay.avatok.ai` later
- RealtimeKit app `avatok-flutter`: `7e5b20c0-da74-4848-9884-73af53bb3fb0` (for SFU group calls / AvaLive)

## Clerk (existing avatok.ai tenant)
- Publishable key (public): `pk_live_Y2xlcmsuYXZhdG9rLmFpJA`

## Firebase / FCM
- Project: `avatok-e19ef` · Android package: `ai.avatok.avatok_call`

## Bunny.net Stream
- Library ID: `553793` · CDN: `vz-837d504e-6a8.b-cdn.net` · Pull zone: `vz-837d504e-6a8`

## App
- Android applicationId: `ai.avatok.avatok_call`
- Direct test APK: GitHub release `calltest-latest`
