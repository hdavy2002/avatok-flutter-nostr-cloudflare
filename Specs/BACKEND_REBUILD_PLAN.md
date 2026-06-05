# AvaTok — Backend Rebuild Plan (locked)

**Date:** 2026-06-04
**Decision:** Rebuild the backend from the Rulebook on day one. Do **not** migrate the KV monolith.
**Why:** Current backend (`signaling/src/index.ts`, ~900 lines, all KV) is a prototype with no production core worth preserving. The Flutter app is endpoint-agnostic — if the new backend returns the same JSON from the same URLs, the app works unchanged.

> Supersedes the stale lines in `specs-final.md`: §11.3 "KV for push tokens" (→ D1) and `AVATOK_SPEC.md` "no phone directory" (→ keep, hashed in D1). Where this doc and an older doc disagree, this doc wins.

---

## Locked decisions

| # | Decision | Resolution |
|---|---|---|
| 1 | Migrate vs. rebuild | **Rebuild.** Fresh D1, fresh Worker, point app at new endpoints. |
| 2 | Data store | **D1** for everything queryable. KV = ephemeral tokens only (5 uses). |
| 3 | Media moderation vs. E2EE | **Two upload paths** (below). Can't scan ciphertext; don't try. |
| 4 | Push tokens | **D1** (`push_tokens`). Rulebook is MANDATORY + newer; spec §11.3 is stale. |
| 5 | Relay | **Fork Nosflare.** Persist to D1, add NIP-42 (private kinds), `onEventSaved` push hook. |
| 6 | Relay sharding | **Single `DB_RELAY`** now (feed reads span authors; gift wraps have random author keys → index `#p`). Router built to shard later. |
| 7 | Phone discovery | **Keep** (India adoption). Store `phone_hash → npub` only; never raw numbers. |
| 8 | Data state | **Pre-launch, clean slate.** No backfill, no dual-write. Phase 5 = delete old KV. |
| 9 | NIP-42 AUTH scope | **Private kinds only** (below). Public kinds stay open for federated reads. |

---

## D1 topology (4 databases at launch)

| Binding | DB | Holds |
|---|---|---|
| `DB_META` | avatok-meta | identity link, profiles, phone/email hashes, follows, blocks, mutes, settings, **push tokens**, communities, strikes, account status, verification requests |
| `DB_MEDIA` | avatok-media-meta | `user_media` (AvaLibrary), `user_media_hashes` (pHash) |
| `DB_MODERATION` | avatok-moderation | blocked hashes, AI-result cache, user reports |
| `DB_RELAY` | avatok-relay | `nostr_events`, `nostr_tags` |

Schema in `worker/migrations/*.sql`. Sharding router in `worker/src/db/shard.ts`. The Rulebook's "18 databases" is a scale target; its own rule is "start in DB_META, split a table at ~2 GB." We start at 4 and the router makes splitting a config change.

## Two upload paths (decision #3)

| Media | Endpoint | Auth | AI scan | Encrypted | Stored |
|---|---|---|---|---|---|
| Public post (AvaTweet/Gram/Book/Tube) | `POST /upload/public` | ✅ | ✅ Workers AI | ✗ plaintext | R2 public bucket, key=sha256 |
| Private DM attachment (AvaChat) | `POST /upload/private` | ✅ | ✗ (impossible) | ✅ client AES-256-GCM | same R2 public bucket (ciphertext is safe to serve) |

AES key + IV travel **inside** the MLS/NIP-44-encrypted DM. R2 holds random bytes. This is the Signal/WhatsApp pattern: server-side moderation of E2EE media is impossible, so DMs rely on recipient-reporting + the strike system; public content is scanned aggressively. Flutter client picks the path by context (composing a post → public; DM attachment → private).

## NIP-42 AUTH scope (decision #9)

- **Gated (require signed NIP-42 challenge):** kind 14/13/1059 (NIP-17 DMs), 25050 (call signaling), 10050 (inbox relay list), 10443 (MLS KeyPackages).
- **Open (federated reads, no AUTH):** 0, 1, 3, 6, 7, 20, 30023, 34235/34236, 30311/1311, 10002, 10063.

Public content stays readable by Amethyst/Damus/Nostrudel; private content requires proving you own the npub.

---

## Phases

- **Phase 1 — Foundation (this commit):** D1 topology, schema migrations, sharding router, `wrangler.toml` bindings (D1×4, R2 public+private, KV tokens-only, Queues, AI, DO). *Configs-first / reviewable.*
- **Phase 1b — Provision:** `wrangler d1 create` ×4 → run migrations → R2 public bucket + `blossom.avatok.ai` custom domain + Cache Everything + Smart Tiered Cache → KV namespace → Queues. Fill `database_id`s. (Cloudflare MCP.)
- **Phase 2 — API Worker:** route dispatch (same URL shapes), Clerk JWT + NIP-98 + tier middleware on mutations, reads/writes to D1 (Cache API for public reads), two upload paths, contact match via `phone_hash IN (…)`, Service Binding to push Worker.
- **Phase 3 — Relay:** Nosflare fork → D1 (`nostr_events`/`nostr_tags`); DO holds only WS + sub state; NIP-42 (private kinds); `onEventSaved` → push Queue; thin router.
- **Phase 4 — Async + moderation:** Queues + consumer Workers; Workers AI image scan; OpenAI text via AI Gateway; pHash blocklist; strike auto-escalation; Cron (cleanup/trending/audit).
- **Phase 5 — Cutover:** point app at new endpoints (media URL → `blossom.avatok.ai/<hash>`); delete old `avatok-call-signaling` Worker + KV namespace.

## Do NOT touch

Flutter app (except endpoint URL strings) · Nostr client (`app/lib/nostr/`) · NIP-44/NIP-17 encryption · P2P calling (`flutter_webrtc`) · RealtimeKit SFU (AvaConsult) · Stream Live (AvaLive) · MLS (deferred, not blocking).
