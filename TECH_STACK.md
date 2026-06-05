# AvaTok / AvaTalk — Full Technology Stack

**Date:** 2026-06-04
**Scope:** Everything the platform runs on — client, protocol, Cloudflare backend, AI, and third-party services. Companion to `BACKEND_REBUILD_HANDOFF.md` (status) and `AVATALK-CLOUDFLARE-RULEBOOK.md` (rules).

**Shape in one line:** a Flutter client over a Nostr identity/event layer, on an all-Cloudflare backend (Workers + D1 + R2 + KV + Queues + Durable Objects + Workers AI + Vectorize), with a small set of specialist third parties (Clerk, Bunny, FCM/APNs, Brevo, PostHog). One Cloudflare account does ~80% of the infrastructure.

---

## 1. Client (frontend)

| Layer | Choice |
|---|---|
| Framework | **Flutter / Dart** — single codebase for iOS, Android, Windows, macOS, Linux, Web (~85% shared, ~15% native calling shell) |
| Marketing site | **React + TypeScript on Cloudflare Pages** (static, SEO) — separate from the app, planned |
| Real-time / calls | `flutter_webrtc` (P2P), `web_socket_channel` (relay) |
| Identity / crypto | `bip340` (schnorr), `pointycastle` (NIP-44 ECDH/ChaCha), `cryptography` (AES-GCM media), `flutter_secure_storage` (nsec at rest) |
| Push / calls UI | `firebase_messaging`, `flutter_local_notifications`, `flutter_callkit_incoming` (pinned 2.5.8) |
| Media | `image_picker`, `file_picker`, `record`, `audioplayers`, `video_player` |
| Misc | `qr_flutter`, `geolocator`, `url_launcher`, `flutter_contacts`, `share_plus`, `google_fonts` |
| Account auth | Clerk (hand-rolled FAPI REST client) |

Distribution: GitHub Actions (Android `.aab`/`.apk`, Web, Linux, Windows) + Codemagic (iOS/macOS). All builds on CI — nothing on a dev machine.

---

## 2. Identity & protocol layer

- **Account identity:** Clerk (phone/email/OAuth, MFA) on the `avatok.ai` tenant.
- **Content identity:** Nostr keypair (secp256k1); `npub` is the cross-app user id. NIP-05 handles (`user@avatok.ai`).
- **Auth on the API:** every mutation requires a **NIP-98** signed request (identity derived from the signature, never the body); Clerk JWT layered on when `CLERK_JWKS_URL` is set. The relay uses **NIP-42** to gate private kinds.
- **NIPs in play:** 01, 02, 05, 09, 10, 11, 17 (DMs), 19, 25, 42, 44, 49, 59 (gift wrap), 65, 68, 71, 98, 100 (WebRTC signaling).
- **Messaging encryption:** NIP-44 today; **MLS (RFC 9420)** is the planned upgrade for forward secrecy (not yet shipped).
- **Media addressing:** Blossom (SHA-256 content-addressed) on R2.

---

## 3. Cloudflare backend — compute

Four Workers (account `fd3dbf43f8e6d8bf65bd36b02eb0abb0`):

| Worker | Role |
|---|---|
| **avatok-api** | Control plane. Hardened `/api/*` (NIP-98): profile/resolve/search, register/call/notify, contacts, communities, media upload, library, backup, account-delete, notifications, **AvaBrain** routes, ICE, Stream webhook. Hosts the `CallRoom` and `UserBrain` Durable Objects. |
| **avatok-relay** | Nostr relay. WebSocket **Hibernation** DO (`RelayRoom`), events → D1, NIP-42 private-kind gate, real-time fan-out to recipients' inbox DOs, `onEventSaved` → push + brain queues. |
| **avatok-consumers** | Async workers: consumes 5 queues (moderation, push, email, analytics, brain-events) + 6-hourly cron cleanup. |
| **avatok-calls** | Mints RealtimeKit SFU tokens (AvaConsult group calls) + Cloudflare Stream Live inputs (AvaLive). |

**Durable Objects:**
- `CallRoom` (avatok-api) — group-call signaling, hibernation.
- `UserBrain` (avatok-api) — per-user reasoning, keyed by npub, idles to nothing.
- `RelayRoom` (avatok-relay) — per-connection Nostr inbox; cross-script-bound into avatok-api for realtime in-app notifications.

---

## 4. Cloudflare backend — data

| Service | Resource(s) | Use |
|---|---|---|
| **D1** (SQLite) | 5 DBs: `avatok-meta`, `avatok-media-meta`, `avatok-moderation`, `avatok-relay`, `avatok-brain` | All queryable data. Read replication = auto (APAC primary). |
| **R2** (object storage) | `avatok-blobs` (PUBLIC via `blossom.avatok.ai`, Cache-Everything 30d + Smart Tiered Cache), `avatok-verification` (LOCKED) | Media blobs (plaintext + ciphertext); ID docs. Reads bypass Workers. |
| **KV** | `avatok-tokens` | Ephemeral tokens only (FCM access-token cache, upload tokens, rate limits). |
| **Vectorize** | `avatok-semantic` (384-dim, cosine) | Semantic memory for AvaBrain (one vector per entity, npub-scoped). |
| **Cache API** | per-PoP | Public reads (resolve/search/ICE), free. |

D1 IDs: meta `c4ec8c0e…`, media `79dc846e…`, moderation `770d5709…`, relay `8ce3ca0d…`, brain `f5bfb712…`. Zone `avatok.ai` = `ae74ddf9…`.

---

## 5. Cloudflare backend — async & scheduled

- **Queues (5):** `moderation`, `push-notifications`, `email`, `analytics`, `brain-events`. Producers = avatok-api + avatok-relay; consumer = avatok-consumers (dispatch by queue name, ack/retry).
- **Cron:** `0 */6 * * *` — reject stale-pending media, lift expired temp-blocks, purge verification docs >90d, prune AvaBrain raw-event buffer + expired facts.

---

## 6. AI layer (all Workers AI — no OpenAI/Anthropic in the backend)

The generative/vision/reasoning roles run on **Gemma 4 26B-A4B** (`@cf/google/gemma-4-26b-a4b-it`). It's a Mixture-of-Experts model — 26B total parameters but only ~4B active per forward pass — so it runs at roughly the cost of a 4B model while delivering much higher quality, with built-in thinking mode, vision understanding, function calling, 256K context, and 35+ language support. Embeddings stay on `bge-small` (must be 384-dim to match the Vectorize index — Gemma is generative, not an embedder); text safety stays on Llama Guard (a purpose-built binary safe/unsafe classifier).

| Purpose | Model |
|---|---|
| Image moderation (vision) | **`@cf/google/gemma-4-26b-a4b-it`** (vision; prompt → NSFW+violence 0–100; classifier swap-path for lowest cost at scale) |
| AvaBrain extraction | **`@cf/google/gemma-4-26b-a4b-it`** (background, JSON) |
| AvaBrain reasoning | **`@cf/google/gemma-4-26b-a4b-it`** (thinking-mode answers) |
| Text moderation | `@cf/meta/llama-guard-3-8b` (binary safe/unsafe) |
| Embeddings | `@cf/baai/bge-small-en-v1.5` (384-dim) |
| Image processing (pHash) | `@cf-wasm/photon` (WASM, in consumers) |

Workers AI returns Gemma 4 in an OpenAI-style shape (`choices[0].message.content`, with the thinking chain in a separate `reasoning` field); a shared `aiText()` helper reads both that and the older `{response}` shape. Vision input is a base64 data URL in the chat `messages`.

Also: **Analytics Engine** (`avatok_metrics`, operational metrics), **Browser Rendering** (link previews/OG images).

---

## 7. AvaBrain (per-user memory subsystem)

A privacy-scoped knowledge graph + semantic memory per user. Public Nostr content (kinds 1, 30023) is extracted server-side via the brain-events queue (Gemma 4 26B-A4B → entities/facts/relationships in `avatok-brain` D1 + `bge-small` embeddings in Vectorize); DM-derived facts are extracted client-side and synced via `/api/brain/remember` (never server-visible). Importance decays lazily at read time. The `UserBrain` DO answers questions with Gemma 4 (thinking mode) over the user's graph + semantically-recalled memories. `scope` separates server-public from client-private facts.

---

## 8. Real-time, calling & media

| Capability | Tech |
|---|---|
| 1:1 calls (AvaTok) | WebRTC **P2P**, NIP-100 signaling, Cloudflare STUN + **Realtime TURN** (`rtc.live.cloudflare.com`) — free media path |
| Group calls (AvaConsult) | **RealtimeKit SFU** (separate app/binary — clashes with flutter_webrtc) |
| Live broadcast (AvaLive) | **Cloudflare Stream Live** (WHIP ingest → HLS/WHEP), webhook → moderation |
| Mobile wake | **FCM** (Android, `fcm.googleapis.com` via service-account JWT) + **APNs** (iOS, `api.push.apple.com`, gated) |
| Photos/audio/small media | **Blossom-on-R2**, two upload paths: `/upload/public` (scanned) vs `/upload/private` (client AES-GCM ciphertext, unscanned) |
| Video | **Bunny.net Stream** (`video.bunnycdn.com`, library 553793) |

---

## 9. Trust & safety

Defense-in-depth, in pipeline order per image upload:

1. **CSAM hash-match gate** (`consumers/src/csam.ts`) — runs first, before any AI. Exact-hash check against a `csam_hashes` list (NCMEC/PhotoDNA, in DB_MODERATION) + an optional external matcher (PhotoDNA/Thorn via `CSAM_API_URL`). **Config-gated: bypassed while the list is empty and no API is set** (current state — no creds yet); **fail-closed** (quarantine) when the matcher is configured but errors. On match: stop serving, perm-ban, P1 report row, report hook. Not a model decision; a legal/compliance flow (NCMEC §2258A, India POCSO) — evidence-preservation + filing to be finalized with counsel.
2. **NSFW/violence scan** — a cheap external classifier first pass (`NSFW_API_URL`, e.g. Sightengine/Hive) decides the clear-clean and clear-reject cases; only the ambiguous middle band escalates to **Gemma 4 26B-A4B** vision. While `NSFW_API_URL` is unset, all scans go straight to Gemma 4.
3. **Perceptual-hash / LSH blocklist** — catches re-uploads of confirmed-bad content (resize/recompress survive).
4. **Text safety** — Llama Guard on post text/bios/community descriptions.
5. **Tier-2 human verification** (identity gate, upstream) + **strike system** (1=24h, 2=7d, 3=perm, in D1) + **user reports + admin review** for the flagged middle band.

NCII hash-matching (StopNCII) planned alongside the CSAM source.

---

## 10. Third-party services (the non-Cloudflare set)

| Service | Use | Status |
|---|---|---|
| **Clerk** | Account auth (phone/email/OAuth, MFA) | tenant live; JWKS gating opt-in |
| **Bunny.net Stream** | All video storage/transcode/HLS | keys pending wiring |
| **Firebase FCM** | Android push | wired (service account set) |
| **APNs** | iOS push | gated (key pending) |
| **Brevo** (Sendinblue) | Transactional email (replaced Resend) | key pending |
| **PostHog** | Product analytics + `investigate()` reads | key pending |
| **RealtimeKit** | Group-call SFU (AvaConsult) | app exists; org key pending |
| **GitHub Actions / Codemagic** | CI builds | in use |

Vendor count is deliberately small; Cloudflare carries the rest.

---

## 11. Explicitly NOT in the stack (by decision)

Vercel, Supabase, Upstash Redis, Hyperdrive (no external DB — D1 is the database); OpenAI/Anthropic in the backend (moderation + brain run on Workers AI/Llama); Resend (→ Brevo); React/Vite/Next/Capacitor for the app (Flutter only — React is marketing-site only).

---

## 12. Observability

Workers Logs (7-day, all Workers) + **Analytics Engine** `avatok_metrics` (per-route latency/status, queue throughput, relay events/kind, AI scan cost, cron deltas) + **PostHog** (product analytics, npub-keyed, no PII, no session replay).

---

## 13. One-paragraph summary

The app is **Flutter**; identity and the social graph are **Nostr** (npub, signed events, NIP-98/42 auth); the backend is **all Cloudflare** — four Workers (`avatok-api`, `avatok-relay`, `avatok-consumers`, `avatok-calls`) over **5× D1**, **R2** (public Blossom + locked verification), **KV**, **5× Queues**, **Durable Objects** (CallRoom, UserBrain, RelayRoom), **Workers AI** (Gemma 4 26B-A4B for moderation/brain + Llama Guard text safety + bge embeddings), **Vectorize**, **Analytics Engine**, and **Browser Rendering** — with **Clerk, Bunny, FCM/APNs, Brevo, PostHog, and RealtimeKit** as the only outside dependencies. Calls are P2P (free) with SFU for groups and Stream Live for broadcast; media is content-addressed on R2 (small) and Bunny (video); everything async runs through Queues; and a per-user AvaBrain layer turns public activity into a private, queryable memory.
