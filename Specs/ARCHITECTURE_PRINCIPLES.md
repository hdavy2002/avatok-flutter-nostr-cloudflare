# AvaTOK Suite — Base Principles (Source of Truth)

> **These are the non-negotiable foundations. Every app and every feature is
> built on top of them.** Each app (AvaTok, AvaLive, AvaConsult, future apps) has
> its own UI, features, and monetization — but they all share these primitives.
> When adding anything, check it against this list first.

Last updated: 2026-06-03

---

## 1. Identity & data → Nostr
- A user's identity is a **Nostr keypair (secp256k1)**, npub = identity across all apps.
- Profiles (kind 0), follows (kind 3), public posts, etc. live as **Nostr events** on our relay (`relay.avatok.ai`) + public relays.
- Nostr is the **source of truth** for identity and social graph. Apps render views of the same event stream.

## 2. Private messages → MLS
- All **private/direct messages** are **end-to-end encrypted with MLS (RFC 9420)**, transported via NIP-17 gift-wrap.
- Never NIP-04. Never plaintext on the relay. The server can't read DMs.
- Applies to AvaTok DMs and any future private messaging.

## 3. Small media → Blossom (signed, on R2)
- Photos, audio clips, avatars, small attachments → **Blossom protocol on Cloudflare R2**.
- Content-addressed (SHA-256 = URL), signed/owned by the user, portable across Nostr clients.
- Gated by Workers AI moderation before commit.

## 4. Large media → Bunny (direct)
- **Large/video media** (AvaLive recordings, AvaTube, reels) → **Bunny Stream**, uploaded **direct** (bytes bypass our Workers).
- Workers are control-plane only (presigned creds, metadata, moderation triggers).

## 5. Real-time calling — three topologies, three cost tiers
| App | Topology | Engine | Cost | Binary |
|---|---|---|---|---|
| **AvaTok 1:1** | peer-to-peer | flutter_webrtc + **CF STUN/TURN** | **Free** | main app |
| **AvaConsult 1:20** | SFU | **RealtimeKit** | Paid | **separate** (WebRTC engine clashes with flutter_webrtc) |
| **AvaLive** | broadcast 1→many | **CF Stream Live** (WHIP in / WHEP+HLS out) | Paid | main app (WHIP reuses flutter_webrtc) |
- **Rule:** flutter_webrtc and RealtimeKit must NOT be in the same binary (dual-WebRTC native clash = crash). Free P2P and paid SFU are therefore separate apps.

## 6. Waking phones → FCM/APNs (the one unavoidable centralization)
- A sleeping/Doze phone is not subscribed to the relay, so a call/DM can't reach it.
- **FCM (Android) / APNs (iOS)** is the ONLY way to wake the device. Required for incoming **audio + video calls** and high-priority notifications.
- Push **token registry**: `npub → [device tokens]` in Workers KV. Relay/Worker hook fires a high-priority FCM **data** message → app shows a **CallStyle / full-screen-intent** incoming-call UI even in Doze.
- This is accepted centralization on the wake path only; media + content stay on the principles above.

## 7. Cost discipline (per-feature)
- **Audio-only calls send audio only** — do NOT publish a video track for voice calls (RealtimeKit/SFU bills less for audio-only; P2P saves bandwidth). Enforce in every calling surface.
- Prefer Cloudflare-native; free tiers cover real usage when architecture stays disciplined.

## 8. Moderation & trust
- Tier-2 human verification gates public broadcast. Workers AI (images) + OpenAI (text) pre-commit. pHash blocklist. Strike system.

---

## Per-app requirements (grow on the base above)
- **AvaTok** — DMs (Nostr+MLS), 1:1 P2P calls (free), incoming-call wake via FCM. Mockup = AvaChat design.
- **AvaLive** — paid broadcast (Stream Live). Needs: **Go Live** (WHIP), **Watch a stream in-app** (WHEP/HLS — NEVER a browser window), and a **Live Events discovery screen** (list of active streams; later a marketplace where creators publish streams and invite viewers). Recordings → Bunny.
- **AvaConsult** — paid 1:20 (RealtimeKit), separate binary. Audio-only mode publishes audio only (cheaper).

## Open build items (added 2026-06-03)
1. **FCM/APNs call-wake** for AvaTok audio + video calls (Doze wake, CallStyle/full-screen-intent, token registry). ← before next APK.
2. **Audio-only path** sends only audio (AvaTok voice calls + AvaConsult audio mode).
3. **AvaLive live-events screen** + **in-app stream playback** (no browser).
4. Marketplace for creator live streams (later).
