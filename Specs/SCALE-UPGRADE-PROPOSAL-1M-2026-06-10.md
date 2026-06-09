# AvaVerse — Scale Upgrade Proposal to 1M Users (2026-06-10)

Companion to `Specs/SCALE-AUDIT-1M-USERS-2026-06-10.md`. The audit's verdict: the
architecture is sound; this proposal converts its four risks into a phased plan.
Phases are gated by user count, so nothing is built before it's needed.

---

## Phase 0 — Finish the pivot + instrument (now, before growth)

You can't scale what you can't see. Cheapest, highest-leverage work first.

1. **Complete the Nostr rip-out** (client `app/lib/nostr/`, `app/lib/crypto/`,
   keypair identity; delete `relay/` worker + `avatok-relay` D1 post-cutover).
   Every week it lingers, two messaging stacks get maintained.
2. **Call-quality telemetry** (the prerequisite for "smooth calls", not an infra
   change): log per-call to PostHog/Analytics Engine — setup time (tap→first
   frame), ICE candidate type chosen (host/srflx/relay = TURN%), ICE state changes,
   RTT, packet loss, audio level gaps, teardown reason. Add a `call_quality`
   dashboard. Target budgets: setup <2s p75, TURN usage <25%, setup failure <1%.
3. **Observability + alarms**: Analytics Engine dashboards for DO error rate,
   queue backlog/fail, D1 rows_read/written per route, Workers AI neuron spend
   (daily budget alarm), TURN egress GB.
4. **Load-test harness**: scripted WS clients (k6/artillery from the sandbox)
   driving send/sync/receipt against staging InboxDOs — 10k concurrent sockets,
   measure p99 delivery. Re-run before each phase gate.
5. **Verify the money guards are still on**: `blossom.avatok.ai` cache-everything
   rule, moderation sha256 dedupe, image transform quotas.

**Cost: ~0 infra. Effort: small. Do before marketing pushes.**

---

## Phase 1 — to 100k users: tuning, not surgery

1. **D1 read replication** — enable on `avatok-meta` (+ Sessions API for
   read-your-writes; you already hit this class of bug with the call-push stale
   replica fix). Free, automatic, scales the read side of directory/profile/feeds.
2. **DO location hints** — set placement hints for CallRoom (created near caller)
   and document InboxDO behavior (pins near user's first access — already optimal).
3. **Fan-out rule enforcement**: any message/notification to >25 recipients goes
   via Queues (never sync DO loops in the router). Add a lint/code-review rule +
   a queue-shard map ready for >5k msg/s (multiple queues keyed by uid hash).
4. **Calls hardening (client)** — this is where "smooth on all devices" is won:
   - ICE pre-warm: fetch TURN creds + gather candidates while the callee is still
     ringing; aim tap→connected <2s.
   - ICE restart on network change (Wi-Fi↔LTE handoff) — flutter_webrtc supports
     `restartIce`; wire it to connectivity events.
   - Adaptive bitrate + sane codec prefs: Opus DTX + 24–32 kbps audio floor; VP8/
     H.264 hardware-encode preference per device; start video at 480p and ladder up.
   - CallKit (iOS) / ConnectionService (Android) integration for OS-level call UX
     and reliable wake from FCM high-priority push.
   - TURN-only test mode in diagnostics (forces relay; validates worst-case path).
5. **Flutter RAM budgets** (generic hygiene, fixes the real memory risks):
   `ImageCache` cap (~100MB), dispose video controllers on route pop, evict
   snapshot caches on background, leak check in CI (flutter_memory_profiler run).

**Gate to pass: load test at 25k concurrent sockets green; call setup p75 <2s.**

---

## Phase 2 — to 500k users: the social-surface redesign (the one real project)

The audit's P0: posts/comments/reactions/feeds for AvaBook/AvaGram/AvaTweet cannot
live in a single D1 (10 GB cap, single writer). Design now, build before those
apps launch.

**Recommended design — same pattern you already trust:**
- **Content-owner sharding**: each post lives where its *author or community*
  lives. Two options, pick per surface:
  - **CommunityDO / per-community SQLite** (like InboxDO but per community/page):
    posts+comments for a community are co-located with its members' traffic.
    Natural for AvaBook groups and AvaGram-style profiles.
  - **Sharded D1** (`posts_00..posts_15`, route by `hash(author_uid) % 16`,
    extend `worker/src/db/shard.ts`): 16 DBs × 10 GB = 160 GB, single-writer
    contention divided by 16. Resharding plan documented up-front (doubling +
    dual-write window).
- **Feeds are fan-out-on-write to InboxDO-adjacent `feed` tables via Queues** for
  normal users; **fan-out-on-read** (query authors' shards at view time, cached)
  for high-follower accounts (>20k followers). This hybrid is the standard
  Twitter-scale answer and you have the primitives already.
- **Counters** (likes/views) in the owning DO, flushed to D1 in batches — never
  row-per-like in central D1, never counters in KV.
- **Search**: keep FTS5 for handles/profiles; index post text into a dedicated
  sharded FTS D1 or Vectorize (semantic) via the existing queue path.

Also in phase 2:
- **Moderation cost step-down**: cheap NSFW classifier as first gate; 11B vision
  only for the ambiguous band; per-day neuron budget enforcement (swap path
  already exists per SCALE_AUDIT P1-5).
- **Deferred components**: adopt before micro-app #25. Formal micro-app contract:
  `deferred as` import + lazy route registry in `core/apps.dart`, no boot-time
  singletons, assets from CDN not bundle, CI binary-size report per module.
- **Clerk decision gate (~250k users)**: negotiate enterprise MAU pricing vs.
  migrate to self-managed auth (e.g., better-auth/OpenAuth on Workers + D1, keep
  the same JWT shape so the edge verification doesn't change). Budget reality:
  Clerk list price ≈ $19k/mo at 1M MAU; a negotiated commit typically lands far
  lower; migration is ~3–4 weeks of work that gets harder later. Decide on data.

**Gate: social surfaces launched on sharded storage; load test 100k sockets.**

---

## Phase 3 — to 1M+ users: capacity and geography

1. **Reshard/expand** whatever Phase 2 chose (16→32 shards, or promote the
   busiest global query surfaces to Hyperdrive + Postgres only if D1 sharding
   shows operational pain — don't pre-buy this).
2. **Calls at volume**: TURN egress budget line (~$0.05/GB after 1 TB free —
   at 1M users with 10% DAU calling 10 min/day and ~20% relayed, expect roughly
   1–3 TB/day relayed ⇒ $1.5–4.5k/month; tune TURN% down with better ICE first).
   Adopt **Cloudflare Realtime SFU/RealtimeKit when GA** for AvaConsult group
   calls (Flutter SDK exists); keep AvaTok 1:1 on P2P+TURN — cheapest and lowest
   latency. Fallback vendor if RealtimeKit GA slips or prices badly: **LiveKit
   Cloud** (best Flutter SDK + self-host escape hatch); Agora/100ms are the
   per-minute alternatives but cost more at this scale.
3. **Regional placement**: DO location hints per user-region cohort; Smart
   Placement on the API worker if Clerk/D1 round-trips dominate.
4. **Analytics offload** if PostHog cost balloons: events through the existing
   analytics queue into ClickHouse/Tinybird; PostHog kept for product analytics
   on a sampled stream.
5. **AvaTube**: Cloudflare Stream (signed URLs when DRM matters); already planned.

---

## 4. Services menu — adopt / skip (the "Ably etc." question)

| Service | Verdict | Why |
|---|---|---|
| **Ably / Pusher / PubNub** | **Skip** | They solve managed WebSocket fan-out — your InboxDO + hibernation *is* that layer, cheaper (~$5/mo per 5k mostly-idle sockets vs Ably's per-message/per-connection pricing at 1M scale) and already presence-aware. Re-evaluate only if you abandon DOs. |
| **Cloudflare Realtime (SFU+TURN)** | **Adopt** (TURN now, SFU for AvaConsult) | Anycast, on-net with your stack, $0.05/GB after 1 TB free |
| **RealtimeKit (Dyte)** | **Adopt at GA, not before, and only for AvaConsult** | Beta + pricing TBA; don't couple AvaTok 1:1 to it |
| **LiveKit Cloud** | **Hold as fallback** | Strong Flutter SDK; the escape hatch if RealtimeKit disappoints |
| **Agora / 100ms / Daily** | Skip | Per-minute pricing beats nothing you have; only if you wanted zero-ops video yesterday |
| **D1 read replication** | **Adopt now** | Free read scaling |
| **Hyperdrive + Postgres (Neon/etc.)** | Hold | Only if D1 sharding becomes operationally painful |
| **Upstash Redis** | Optional | Hot global counters/rate-limits if DO-batching ever feels heavy; not required |
| **ClickHouse / Tinybird** | Phase 3 optional | Analytics at volume |
| **Stripe Identity / Persona / Veriff** | Adopt one (Phase 4 of pivot) | KYC gate — pick on Android SDK + liveness + per-check price |
| **Firebase** | Keep FCM only | Don't expand surface |

## 5. Cost sketch at 1M users (~150k DAU), monthly, list prices

| Line | Est. |
|---|---|
| Workers Paid + requests/CPU | $200–600 |
| Durable Objects (requests/duration/storage; hibernation keeps idle ~free) | $500–1,500 |
| D1 (rows read/written) | $200–800 |
| R2 + cache (egress free, ops cheap) | $100–400 |
| Queues | $50–200 |
| Workers AI moderation (after cheap-classifier gate) | $500–3,000 |
| TURN egress | $1,500–4,500 |
| Stream (AvaTube, usage-dependent) | $1,000–5,000 |
| FCM | $0 |
| Clerk (list / negotiated) | $19,000 / likely $3–8k |
| PostHog (sampled) | $500–2,000 |
| **Total order of magnitude** | **~$25–40k/mo list; ~$10–20k negotiated+tuned** |

Auth is your #1 line item — that's why the Phase 2 decision gate exists. The
Cloudflare core scales at single-digit thousands; that's the payoff of the DO
architecture.

## 6. What NOT to do (re-affirmed)

- No Nostr, ever again. No central-D1 message store.
- No per-micro-app separate installs (audit §4) — one binary + deferred components.
- No pre-warming app data into memory at boot.
- No counters in KV; no >25-recipient sync fan-out loops.
- Don't adopt an external realtime-messaging SaaS to "be safe" — it would
  duplicate InboxDO at 10–50× the cost.

## 7. Sources

- DO limits: https://developers.cloudflare.com/durable-objects/platform/limits/ (10 GB SQLite/DO, ~1k req/s soft/DO)
- DO pricing & hibernation: https://developers.cloudflare.com/durable-objects/platform/pricing/
- D1 limits (10 GB/db hard, 50k dbs/account): https://developers.cloudflare.com/d1/platform/limits/
- D1 read replication: https://developers.cloudflare.com/d1/reference/faq/
- Realtime SFU/TURN pricing ($0.05/GB after 1 TB free): https://developers.cloudflare.com/realtime/sfu/pricing/
- RealtimeKit (beta, free during beta, Flutter SDK): https://developers.cloudflare.com/realtime/realtimekit/pricing/ , https://blog.cloudflare.com/introducing-cloudflare-realtime-and-realtimekit/
- Flutter deferred components: https://docs.flutter.dev/perf/deferred-components
- Clerk pricing: https://clerk.com/pricing
- Ably vs DO comparison: https://ably.com/compare/ably-vs-cloudflare-durable-objects
