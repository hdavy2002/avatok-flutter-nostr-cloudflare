# AvaTok — Architecture Gap Report: Current Build vs. Cloudflare Rulebook

**Date:** 2026-06-04
**Compares:** what is actually in this repo today (`app/`, `signaling/`, `relay/`, `calls/`) against the proposed **AvaTalk Network — Universal Cloudflare Architecture Rulebook v1.0** (`AVATALK-CLOUDFLARE-RULEBOOK.md`), cross-checked with `specs-final.md` v2.0.

---

## 1. Verdict

The Rulebook is **not a refactor — it's a backend re-platform.** The Flutter app, the Nostr/NIP-44/NIP-17 client, the calling stack (P2P + RealtimeKit + Stream Live), and the vendor choices (Clerk, Bunny, FCM, RealtimeKit) all survive largely intact. But the **data layer is the opposite of what the Rulebook mandates**, and the Rulebook's central rule — *"D1 is the database; KV is for ephemeral tokens only"* — is violated by essentially every endpoint we have today.

Today's backend is a **single monolithic Worker (`signaling/src/index.ts`, ~900 lines) backed entirely by one KV namespace**, plus a **custom relay that stores all Nostr events in one global Durable Object's SQLite**. The Rulebook calls for **18 D1 databases, R2 public-bucket reads, Queues, Workers AI moderation, and a thin relay router** — almost none of which exists yet.

So: **UI and protocol layer ≈ aligned. Storage, moderation, and async layers ≈ greenfield.**

---

## 2. Side-by-side: what the Rulebook wants vs. what we run

| Concern | Rulebook (proposed) | Current build | Gap |
|---|---|---|---|
| **Primary database** | D1, 18 databases, sharded by `npub % 16`; "everything queryable goes in D1" | **No D1 anywhere.** Zero `d1_databases` bindings in any `wrangler.toml` | 🔴 Total |
| **App data store** | D1 tables (profiles, contacts, follows, settings, media metadata…) | **All of it in one KV namespace** (`PUSH`): `prof:`, `handle:`, `email:`, `phone:`, `contacts:`, `comm:`, `dir:all` | 🔴 Inverted — Rulebook explicitly **BANS** every one of these from KV |
| **KV usage** | Ephemeral tokens only (5 allowed: upload tokens, rate-limit counters, NIP-05 cache, flags, CSRF) | KV is the entire database | 🔴 Violates "Golden Rule 5" |
| **Nostr event storage** | D1 `DB_RELAY_0..15`, sharded by author | **Single global DO** (`relay-global`) SQLite, no sharding | 🔴 Rulebook: "DOs are coordination, NOT storage" |
| **Relay router** | 3-line Worker: get DO stub → forward, no logic | Custom hand-rolled relay (EVENT/REQ/CLOSE, schnorr verify) in the DO | 🟡 Functionally a relay, wrong storage substrate; **not Nosflare** as spec assumes |
| **Media reads** | R2 **public bucket** at `blossom.avatok.ai/<hash>`, **no Worker in read path**, 30-day edge cache | `GET /media/:hash` **proxies bytes through the Worker** via `env.MEDIA.get()` (immutable cache-control set) | 🔴 Violates "Golden Rule 2 / NEVER proxy R2 reads" |
| **Media writes** | Worker auth + Workers AI moderation → R2 PUT | `POST /media` hashes + PUTs to R2 (`avatok-media`), **no moderation, no auth** | 🟡 Path exists, gate missing |
| **Async work** | Cloudflare Queues for moderation, push, email, video, analytics, cleanup | **No Queues.** Push/email called inline (FCM, Resend) | 🔴 None |
| **AI moderation** | Workers AI on every image; OpenAI on every text; pHash blocklist | **None implemented** (no `AI` binding, no `@cf/*` calls) | 🔴 None |
| **Auth on requests** | Clerk JWT + NIP-98 signature + tier check on every state change | **No Clerk/NIP-98/tier verification in the Worker.** (App has a hand-rolled `clerk_client.dart`; backend doesn't check it) | 🔴 Backend is effectively open |
| **Push bridge** | Relay `onEventSaved` hook → Queue → FCM/APNs | Relay has **no push hook**; client calls `POST /call` which reads tokens from KV and fires FCM inline | 🟡 Works, wrong shape; token registry in KV (Rulebook allows tokens in KV via DB_META, but spec puts push tokens in D1) |
| **Service catalog used** | D1, R2(public), DO, Workers, Cache API, KV, Queues, Cron, Workers AI, Calls, Stream Live, Vectorize… | KV, R2(proxied), DO (relay + call rooms), Workers, RealtimeKit | 🟡 ~5 of ~20 services |
| **Cache API** | Free edge cache before any KV read | Not used | 🟡 Missing (cheap win) |

---

## 3. Where we already agree (don't rip these out)

These current choices already match the Rulebook / spec and should be **kept**:

- **Flutter is the app, React only for marketing.** Current repo is Flutter-only (`app/`); the React file in `mobile-design/` is treated as a visual mockup, exactly as the spec demands. ✅
- **Nostr identity + relay model.** secp256k1 keypair, npub identity, kind-0/1/3 events, NIP-19, NIP-17 gift-wrap, kind 25050 call signaling — all present in `app/lib/nostr/` and `crypto/nip44.dart`. ✅
- **1:1 = P2P, group = SFU, separate binaries.** `flutter_webrtc` P2P in the main app; RealtimeKit SFU isolated in `avaconsult/` + `calls/` worker; AvaLive via Stream Live. Matches the "three topologies, three cost tiers" rule and the dual-WebRTC-clash constraint. ✅
- **FCM/APNs as the one accepted centralization** for waking sleeping phones, with CallKit/ConnectionService. ✅
- **R2 for blobs, Bunny for video, Cloudflare-native bias, vendor list (Clerk/Bunny/Stripe/PostHog/novu).** ✅
- **Route-based dispatch in one API Worker** — the Rulebook actually *wants* one API Worker, so the monolith shape is fine; it's the **KV-as-database** inside it that's wrong.

---

## 4. The five divergences that actually matter

Ordered by blast radius, not by effort.

1. **KV is the database.** Every profile, handle, contact, community, and directory entry lives in one KV namespace. The Rulebook treats this as the cardinal sin (KV reads are 500× costlier than D1 and can't do `WHERE`/`JOIN`/pagination). **This is the migration.** Everything else is small next to it.

2. **No D1 at all.** There is no schema, no sharding router, no `clerk_nostr_link`, `user_media`, `verification_requests`, `account_strikes`, `blocked_media_hashes`, `user_reports`. The spec's entire data model (§3, §4, §7.4, §8) is unbuilt.

3. **Relay stores events in a DO, not D1, and isn't Nosflare.** It's a clean custom relay, but: single global DO (no `npub % 16` sharding), no NIP-42 AUTH (the NIP-11 doc *claims* 42 but `onMessage` only handles EVENT/REQ/CLOSE), and **no `onEventSaved` push hook** — the keystone the spec calls "not optional once we go live on mobile."

4. **No moderation and no auth gate.** No Workers AI, no OpenAI text check, no pHash, no Clerk/NIP-98/tier enforcement on the API. Any caller can write to `/media`, `/profile`, `/contacts`. The spec's three-layer defense-in-depth is absent.

5. **No async layer.** No Queues, no Cron. Push and email run inline in the request path — the exact pattern the Rulebook lists under "Banned Patterns."

---

## 5. A contradiction to resolve before migrating

The **contacts/phone-directory feature drifted away from both governing docs.** Recent commits added device-contact sync and phone-number matching (`/contacts/sync`, `/contacts/match`, `phone:` KV keys, `flutter_contacts`), giving WhatsApp-style discovery. But:

- `AVATOK_SPEC.md` says **"Contacts: npub / @handle (NIP-05) / QR + invite link. No phone directory."**
- The Rulebook **bans** contacts and phone data from KV outright.

So this feature is offside on *both* the product spec (shouldn't use a phone directory) and the infra rulebook (shouldn't be in KV). Decide whether phone matching stays; if it does, it has to move into D1 with hashed phone lookups (`WHERE phone_hash IN (?, ?)`), which the Rulebook explicitly describes.

---

## 6. Migration impact (rough shape, not a quote)

| Workstream | Effort | Notes |
|---|---|---|
| Stand up 18-DB D1 topology + sharding router | M | New `wrangler.toml` bindings, schema migrations, `parseInt(npub.slice(-2),16)%16` router |
| Port KV data model → D1 (profiles, contacts, communities, directory, media metadata) | **L** | The bulk of the work; needs a one-time KV→D1 backfill script |
| R2 public bucket + `blossom.avatok.ai` custom hostname; drop Worker read proxy | S | Plus Cache-Everything rule, Smart Tiered Cache |
| Add Clerk JWT + NIP-98 + tier middleware to the API Worker | M | Backend currently trusts the client |
| Relay: shard events to D1 + add NIP-42 AUTH + `onEventSaved` push hook (or adopt Nosflare) | **L** | Decide: keep custom relay vs. fork Nosflare as spec assumes |
| Queues for moderation / push / email + move inline calls behind them | M | |
| Workers AI image + OpenAI text moderation + pHash blocklist | M | Gates `/media` and AvaTweet |
| Cache API on NIP-05 / public profiles | S | Cheap, do alongside D1 |

S/M/L = small/medium/large. The two **L** items (KV→D1 port, relay re-platform) are the spine of the shift.

---

## 7. Recommendations

1. **Treat this as a backend migration with a frozen frontend.** The Flutter app and Nostr/calling layers are aligned; don't churn them. Scope the work to Workers + relay + storage.
2. **Sequence: D1 first.** Stand up D1 and the sharding router, port the KV data model, *then* layer auth, moderation, and Queues on top. Everything downstream assumes D1 exists.
3. **Make one decision on the relay now:** keep the custom DO relay (and add D1 sharding + NIP-42 + push hooks yourself) or **fork Nosflare** as `specs-final.md` §7.2 and `PROPOSAL.md` assume. The spec assumes Nosflare; the repo built custom. Pick one and update the docs.
4. **Flip media reads to a public R2 bucket before scale.** It's a small change with an outsized cost/latency payoff and removes a banned pattern.
5. **Add the auth middleware early** — the backend is currently unauthenticated, which is a security gap independent of the Rulebook.
6. **Reconcile the phone-directory feature** against the "no phone directory" product decision before porting it anywhere.
7. **Keep MLS where it is — later.** Neither doc expects MLS yet (no `packages/ava_mls/`, no Rust FFI); the app uses NIP-44 today, which both `HANDOFF.md` and the spec treat as the interim. The Rulebook is about infra, not encryption, so MLS doesn't gate this migration.

---

## 8. One-line summary

> **Frontend and protocol layer: already on-spec. Backend: a KV-and-DO prototype that needs to become a D1-and-Queues platform.** The Rulebook doesn't change *what AvaTok is* — it changes *where the data lives and how writes are gated*, and that touches almost every Worker endpoint we have.
