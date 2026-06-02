# AvaTalk — Build Roadmap (execution order)

**Locked scope (2026-06-03):** Ship **AvaTok** and **AvaLive** first. All other
apps (AvaChat, AvaTweet, AvaBook, AvaGram, AvaLinked, AvaTube, AvaDate, AvaMatri)
come later. **Everything that is not an app goes in first as foundation.**

Status: ✅ calling milestone proven (P2P WebRTC over Cloudflare signaling, on-device).

---

## Stage 1 — App shell & design system  ← building now
No external credentials needed.
- Design tokens from the mockup: teal `#08C4C4`, ink `#0F1115`, Comfortaa (titles),
  Nunito (body), Pacifico (accent), rounded shapes, cards.
- App launcher home: AvaTok + AvaLive active; other apps shown locked ("soon").
- AvaTok wired in (the working call flow, restyled).
- AvaLive scaffold (camera preview + "Go Live" placeholder).
- Builds to APK on CI as before.

## Stage 2 — Identity foundation
- Nostr keypair (secp256k1), npub/nsec, NIP-19 bech32, NIP-49 backup.
- `flutter_secure_storage` for nsec. Onboarding flow.
- **Clerk** account auth (reuse existing avatok.ai tenant) — needs Clerk keys.
- `clerk_nostr_link` in D1; auth Worker (Clerk JWT + NIP-98 + tier).

## Stage 3 — Relay & realtime foundation
- Nosflare relay at `relay.avatok.ai` (fork) with NIP-42 AUTH + event allowlist.
- Migrate call signaling from the temp Worker to **NIP-100 (kind 25050)** over the relay.
- `onEventSaved` push hooks (DM + call) → push Worker.

## Stage 4 — Push foundation (Phase 1 per spec)
- **FCM/Firebase** (needs Firebase project + `google-services.json`).
- Token registry in KV; CallStyle + `USE_FULL_SCREEN_INTENT`; wake-on-call.
- Native Android calling shell (Telecom/ConnectionService).

## Stage 5 — Media foundation
- Blossom-on-R2 (presign + Workers AI moderation gate + GET-by-hash), `user_media` (AvaLibrary).
- **Bunny Stream** for video (recordings, later AvaTube) — needs Bunny key.
- TURN via Cloudflare Calls (cross-network calling).

## Stage 6 — AvaTok (full)
- Calls via NIP-100/relay + TURN, contacts/identity, opt-in recording → Bunny,
  CallKit-grade incoming UX on Android.

> **Calling/SFU note:** evaluate **Cloudflare RealtimeKit**
> (https://developers.cloudflare.com/realtime/realtimekit/) for the SFU group-call
> path and possibly AvaLive — it may replace hand-rolled Calls SFU signaling.

## Stage 7 — AvaLive
- **Cloudflare Stream Live** ingest (RTMPS/WebRTC) → HLS playback (needs Stream Live enabled).
- Go-live flow, viewer list, live moderation hook (1 frame/30s → Workers AI), recording disposition.

## Stage 8 — Moderation, AvaLibrary UI, polish
- OpenAI text moderation, strike system, reports, admin queue (web), AvaLibrary picker.

---

## Credentials needed (gate later stages)
| Stage | Needs |
|---|---|
| 2 | Clerk API keys (existing avatok.ai tenant) |
| 4 | Firebase project + `google-services.json` (FCM) |
| 5 | Bunny.net Stream API key |
| 5/8 | OpenAI Moderation API key |
| 7 | Cloudflare Stream Live enabled on the account |

Cloudflare (Workers/DO/D1/R2/KV/Calls) is already authenticated via API token.
