# AvaVerse — Cloudflare-Native Architecture (Nostr Deprecated)

**Status: CANONICAL as of 2026-06-09.** This document supersedes the Nostr/relay
messaging design for all AvaVerse apps. The previous E2E-gift-wrap (NIP-17/44/59)
messaging architecture is **DEPRECATED and nulled going forward** — see
"What is being removed" below. The 1:1-only product rule for AvaTok calls still
stands; only the *transport/identity/crypto* layer changes.

Decision owner: davy (hdavy2005). Decisions locked this session:
- **Drop Nostr entirely.** Clean rip-and-replace (no dual-running, no data migration — only 2 test phones, reinstall as new).
- **Messaging is server-readable** (plaintext at rest on encrypted storage + TLS in transit). No default E2E.

---

## 1. Why we are dropping Nostr

AvaVerse is a **closed, KYC-gated, centralized community**: a public marketplace
plus public social apps (AvaTweek, AvaBook, AvaGram, AvaTube), operated by a single
party who must moderate content and report bad actors to authorities.

Nostr is built for the opposite of that:

| Nostr property | What it gives | Do we want it? |
|---|---|---|
| Decentralization / censorship resistance | No single party can remove content | **No** — we must moderate + remove |
| User-owned portable keypairs | Identity not controlled by operator | **No** — we are the KYC identity authority |
| E2E gift-wrap (NIP-17/44/59) | Server can't read messages | **No** — unreadable content blocks moderation, scam/CSAM detection, lawful reporting |
| Interop with other Nostr apps | Federation | **No** — walled garden |

We were paying Nostr's full cost and getting none of the benefits we want. The
costs are exactly the felt slowness:

- **Per-message secp256k1 ECDH** on the device for every send and every receive.
- **Gift-wrap (kind 1059) wrap/unwrap** on the UI thread; observed re-decrypting
  the same wrap 3–4× before the single-decrypt hub fix.
- **Relay re-streams all historical 1059s on every reconnect**, causing decrypt
  storms and the "blank then loads one-by-one" behavior.
- Relay model is awkward for feeds, search, unread counts, and moderation — all of
  which we now want server-authoritative.

**Conclusion: Nostr is the wrong tool for this product.** Removing it makes the app
faster and unlocks the moderation/reporting we actually need.

---

## 2. Engineering verdict — will the new arch be slow or a nightmare?

**No — provided we avoid one specific trap.** The pattern (per-user Durable Object
holding a hibernatable WebSocket, server as router, local-first device cache) is
mainstream and well-supported on Cloudflare. It is unambiguously **faster** on the
device hot path because it removes all per-message crypto.

**The one real trap: do NOT use a single central D1 as the high-write message store.**
D1 is SQLite with a single-writer model and per-database size limits. A busy
messenger funneling every message write through one D1 would eventually hit write
throughput and size caps — *that* would be the nightmare.

**The fix (baked into this design): messages live in Durable-Object-local SQLite.**
Each user's `InboxDO` has its own transactional SQLite storage, co-located with that
user's live socket. Writes are naturally sharded one-DO-per-user, scale horizontally
with users, and never contend on a central writer. Central **D1 is reserved for
lower-write global query surfaces** (directory, marketplace listings, social posts,
moderation results, push tokens) — most of which already exist. This is the
canonical Cloudflare chat topology and removes the bottleneck by construction.

### Honest residual risks (all manageable)
- **DO geo-pinning:** a DO lives where first accessed; a far-away user sees extra
  latency. Fine early; use regional placement hints as the user base globalizes.
- **Group fan-out:** sending to a large group means touching many DOs. For big
  fan-out use **Queues**, not synchronous DO calls. (AvaTok is 1:1 only, so this
  only matters for group chats / social fan-out.)
- **WS hibernation discipline:** all state that must survive hibernation lives in DO
  storage, never in memory. Standard, just requires care.
- **Search at scale:** start with D1 FTS5; move to a dedicated search index later if
  needed. Not a day-1 problem.
- **Cloudflare lock-in:** accepted — we are already all-in.

### Should we redo from scratch?
**No.** Minimum blast radius = fastest + lowest risk. We **keep** the device
local-first layer (just shipped), Clerk auth, the moderation/push consumers, the
moderation D1, media on R2 + Stream, and the calls DO. We **rip out only** the relay
Worker and the client Nostr stack. Most of the backend (identity, media, moderation,
push, KYC scaffolding) already exists and is reused.

---

## 3. What we KEEP, what we REMOVE

### Keep (reuse as-is or lightly adapt)
- **Device local-first layer** — local SQLite (drift) as source of truth + the
  chat-list projection (`app/lib/core/db.dart`, `chat_list_snapshot.dart`,
  `app/lib/features/avatok/chat_list.dart`). Transport-agnostic; this is *why* it
  feels instant. The `RelayHub` becomes a `SyncHub` (same single-socket shape, but
  it stores plaintext rows instead of decrypting gift-wraps).
- **Clerk** auth (FAPI). Identity = Clerk user id (already `AccountScope.id`).
- **Cloudflare infra:** `avatok-api` Worker, `avatok-consumers` (moderation + FCM
  push + cron), D1 `avatok-meta` / `avatok-media-meta` / `avatok-moderation`, R2
  `avatok-blobs` (blossom.avatok.ai) + `avatok-verification`, KV `avatok-tokens`,
  Queues (Q_PUSH etc.), Vectorize.
- **FCM high-priority push** for offline delivery (already built in consumers/fcm.ts).
- **Calls** — CallRoom DO + WebRTC signaling (already Cloudflare/DO, barely touched).
- **Per-account scoping**, media cache pipeline, AvaBrain consent model.
- **KYC scaffolding already in D1 `avatok-meta`:** `verification_requests`,
  `account_status`, `strikes`; `avatok-verification` R2 bucket for ID docs.

### Remove
- `relay/` Worker (`avatok-relay`) and D1 `avatok-relay` (`nostr_events`,
  `nostr_tags`). The DB can be left dormant then deleted post-cutover.
- Client Nostr stack: `app/lib/nostr/` (nip17, nip44, nip59/gift-wrap, relay_hub's
  Nostr bits, presence-over-Nostr), keypair identity (`app/lib/identity/` nsec/npub
  generation), NIP-42 relay auth, NIP-98 request signing.
- Any "private kind" relay logic and the 1059 re-stream handling.

---

## 4. Target architecture

```
 ┌───────────────┐     WSS (1 socket)      ┌──────────────────────────────┐
 │  Flutter app  │ ───────────────────────▶│  InboxDO  (one per user)     │
 │  local SQLite │   send / sync / live    │  • hibernatable WebSocket    │
 │  (source of   │◀─────────────────────── │  • DO-local SQLite = msgs     │
 │   truth)      │                         │  • presence (is socket open) │
 └───────────────┘                         └──────────────┬───────────────┘
        ▲                                                  │ route to recipient DO
        │ FCM data push (offline)                          │ (1:1/small) or Queue (large)
        │                                                  ▼
 ┌──────┴────────┐   enqueue    ┌───────────────┐   ┌──────────────────────┐
 │ avatok-       │◀─────────────│  avatok-api   │   │ recipient InboxDO     │
 │ consumers     │  Q_PUSH      │  Worker       │   │ → live WS or offline  │
 │ (FCM, mod)    │              │ (auth+KYC+    │   └──────────────────────┘
 └───────────────┘              │  validate)    │
                                └───────┬───────┘
                          D1 (global query surfaces): identity/directory,
                          listings, social posts, moderation, push tokens
```

### Components
1. **Auth + KYC gate.** Clerk JWT verified at the Worker/DO edge (replaces NIP-42 /
   NIP-98). A video-liveness KYC step (Persona / Onfido / Veriff / Stripe Identity)
   sets `account_status.kyc = verified`; sending, posting, and transacting are gated
   on it. KYC docs land in the locked `avatok-verification` R2 bucket (never public).
2. **InboxDO (per user) — the messaging core.** Holds the user's live hibernatable
   WebSocket, their presence, and their **DO-local SQLite** message store. It is both
   the live delivery endpoint and the durable per-user message log.
3. **`avatok-api` Worker — the router.** Validates (auth + KYC + block/mute), assigns
   a monotonic message id, writes to the relevant store, pushes to the recipient's
   InboxDO if online, and enqueues `Q_PUSH` → FCM if offline.
4. **D1 — global query surfaces only** (low-write): identity/directory, follows,
   blocks, mutes, push tokens (avatok-meta); media metadata (avatok-media-meta);
   moderation results + reports + blocked hashes (avatok-moderation); marketplace
   listings + social posts (new tables). **Not** the per-message hot store.
5. **Media.** R2 (`avatok-blobs`, public via blossom.avatok.ai + CF Image transform)
   for images/files; **Cloudflare Stream** for AvaTube video (ingest/transcode/HLS).
6. **Async / moderation.** Existing `avatok-consumers` (Queues): CSAM-hash gate →
   NSFW classifier → vision ambiguous-band → pHash → strikes → cron. Now applies to
   *all* content because it is server-readable.

### Data model (first cut)
- **DO-local SQLite (per InboxDO):** `messages(id INTEGER PK AUTOINCREMENT, conv,
  sender, kind, body, media_ref, created_at, edited_at)`, `receipts(conv, peer,
  delivered_id, read_id)`, `conv_meta(conv, last_id, unread, peer/group info)`.
- **D1 (global):** `accounts` + `account_status`(kyc) + `verification_requests`
  (exist); `conversations`, `conversation_members` (membership routing); `contacts`,
  `blocks`, `mutes`; `listings` (marketplace); `posts`, `follows`, `feed_*` (social);
  `moderation_results`, `user_reports` (exist); `push_tokens` (exist).

### Core flows
- **Send (1:1):** client → `POST /msg` (or over WS) → Worker validates → assign id →
  write to sender's InboxDO log → call recipient InboxDO `push(msg)` (live WS) or
  enqueue FCM if offline → ack id back to client. Client already stored it locally
  (write-to-DB-first), so UI is instant.
- **Sync on connect:** client sends highest local message id (cursor); server returns
  everything newer across the user's conversations; client writes to local SQLite,
  then lives on the socket. No crypto.
- **Receipts/presence/typing:** small writes + a push over the DO socket — trivial
  server state (vs gift-wrapped events before).
- **Group / social fan-out:** membership in D1; fan-out via **Queues** for large
  audiences, direct DO push for small ones.

---

## 5. The 200-app backbone

Every AvaVerse app reuses **one spine**: Clerk+KYC identity, the InboxDO messaging
core (where relevant), D1 for global query surfaces, R2/Stream for media, Queues for
fan-out, consumers for moderation/push, and the **device local-first SQLite + one
indexed query per screen** pattern. Nothing is pre-loaded into memory; the open app
reconstructs its working set on demand from local SQLite and releases it on close.
This is what keeps cheap phones fast across many apps.

---

## 6. Performance: why this is faster than Nostr

- **Zero per-message ECDH** on send or receive (the biggest device CPU win).
- **No gift-wrap** wrap/unwrap and **no 1059 re-stream storms** on reconnect.
- **Direct server routing** to the recipient's InboxDO → near-instant 1:1 delivery.
- **Authoritative server state** for receipts, unread counts, and search.
- **Local-first device cache** (already shipped) → instant paint, background sync.

---

## 7. Clean rip-and-replace migration plan

1. **Server messaging backend.** Add the `InboxDO` (hibernatable WS + DO-local SQLite)
   and `messaging` routes on `avatok-api`; send + sync + receipts; FCM-on-offline via
   existing Q_PUSH. Clerk JWT verification at the edge. Deploy.
2. **Client SyncHub.** Replace `RelayHub` with a WS client to the InboxDO; `send()` =
   POST to the Worker; ingest = store plaintext to local SQLite (reuse the projection).
   Delete `app/lib/nostr/`, keypair identity, NIP-42/98. Identity = Clerk user id.
3. **Receipts + presence + typing** over the DO socket. Verify calls (CallRoom DO)
   still work with the Nostr signaling glue removed.
4. **Video KYC gate** at onboarding; gate send/post/transact on `kyc = verified`.
5. **Housekeeping.** Update `CLAUDE.md` (remove the Nostr E2E mandate), delete the
   relay Worker + `avatok-relay` D1 after cutover, log to Graphiti.
6. **Then:** feed/marketplace backbone (AvaTweek/AvaBook/AvaGram/AvaTube) on the same
   spine — D1 + Queues fan-out + R2/Stream + server-side moderation.

---

## 8. Open questions for next session
- KYC vendor choice (Persona vs Onfido vs Veriff vs Stripe Identity) — cost + Android
  SDK + liveness quality.
- Group chat: keep full messaging in groups (per the existing rule) on InboxDO fan-out
  vs a per-conversation DO — decide when group volume is known.
- Message retention / export policy for lawful requests.
- Whether AvaTube needs DRM (Stream signed URLs) at launch.
