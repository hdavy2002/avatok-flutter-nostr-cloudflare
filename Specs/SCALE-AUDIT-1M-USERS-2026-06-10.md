# AvaVerse — Architecture Audit for 1M Users (2026-06-10)

Companion document: `Specs/SCALE-UPGRADE-PROPOSAL-1M-2026-06-10.md` (the proposal).
Scope: the post-pivot Cloudflare-native architecture (`AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`),
audited against a target of 1,000,000 registered users (~100–200k DAU, ~20–50k peak
concurrent), an ecosystem of 100s of micro-apps, and smooth 1:1 audio/video calls globally.

---

## 1. Executive verdict

**The architecture is fundamentally sound for 1M users.** The 2026-06-09 pivot
(per-user `InboxDO` with DO-local SQLite, server as router, device local-first cache)
already eliminated the two worst scale killers: the single global relay DO and
per-message crypto on the device. Messaging, push, media, and moderation all shard
horizontally by construction.

There are **four real risks** between here and 1M, none of which require a rebuild:

| # | Risk | Severity | When it bites |
|---|------|----------|---------------|
| 1 | **D1 10 GB hard cap + single-writer** on `avatok-meta` once social feeds (AvaBook/AvaGram/AvaTweet posts) live there | 🔴 P0 | ~300k–500k users posting publicly |
| 2 | **Clerk cost** (~$19k/month at 1M MAU at $0.02/MAU) | 🟠 P1 | Linear from ~50k users; contract decision needed by ~250k |
| 3 | **Calls productization** — RealtimeKit still beta, TURN egress unbudgeted, no call-quality telemetry | 🟠 P1 | First serious usage; reputation risk |
| 4 | **Flutter single-binary bloat** at 100s of micro-apps (download size, not RAM) | 🟡 P2 | ~25–40 micro-apps |

Everything else is tuning, not surgery. Detailed findings below.

---

## 2. What the audit confirmed is RIGHT (keep, don't touch)

These choices are the canonical pattern for this product class and survive 1M+ users:

- **Per-user `InboxDO`** (`worker/wrangler.toml`, `worker/src/do/`): hibernatable
  WebSocket + DO-local SQLite. Writes shard one-DO-per-user; no central writer
  contention ever. Per-DO limits — 10 GB SQLite, ~1,000 req/s soft — are *per user*,
  i.e. effectively unreachable for a single human. This is the single most important
  thing you got right.
- **D1 reserved for low-write global query surfaces**, never the per-message hot
  store. The earlier SCALE_AUDIT P0s (global relay DO, 100-param limit, LIKE-scan
  search, pHash O(n)) are all fixed.
- **Device local-first** (drift SQLite, one indexed query per screen, no boot
  pre-warm, `chat_list_snapshot` without `warm()`). This is exactly what keeps RAM
  flat as micro-app count grows — memory cost is per *open screen*, not per
  *installed app*.
- **Media path**: R2 content-addressed + `blossom.avatok.ai` cache-everything 30d +
  CF image transforms + on-device per-account caches. Scales to 1M with no change;
  cost is bandwidth-shaped, not architecture-shaped.
- **Queues-based async** (moderation, push, email, analytics) with FCM
  high-priority for offline delivery. Correct decoupling.
- **Per-account scoping** (`scopedKey`/`AccountScope`) — a correctness foundation
  that's much cheaper to enforce now than retrofit.
- **1:1-only call rule with layered enforcement** (UI, client guard, CallRoom DO
  2-peer cap) — keeps the calls problem in the easy class (P2P-viable).

---

## 3. Bottleneck findings

### 3.1 🔴 D1 — the one architectural wall

Facts (verified against current docs):
- **10 GB hard cap per database** (writes fail at the cap; not a soft limit).
- **Single-writer**: one primary instance serializes all writes per database.
- **Read replication is free and automatic** (replicas per region, Sessions API for
  read-your-writes) — but it scales *reads only*, never writes or size.

Current exposure: `avatok-meta` is fine for identity/directory/follows/blocks/
push_tokens at 1M users (these are KBs per user → low single-digit GB). The danger
is the *planned* social surfaces. Posts, comments, likes, and feed tables for
AvaBook + AvaGram + AvaTweet at 1M users is **hundreds of GB and a high write rate
— it cannot live in one D1**. The arch doc already names D1 for "social posts";
that part needs the sharding design in the proposal before AvaGram/AvaTweet launch.

Rule of thumb: any table whose row count scales with *user-generated content
volume* (posts, comments, reactions, feed entries) must be sharded or DO-resident.
Any table that scales with *user count* (accounts, follows, settings) is fine in
central D1 to 1M+.

### 3.2 🟠 Calls — good skeleton, not yet production-grade at scale

What exists: `CallRoom` DO for signaling (2-peer cap), Cloudflare STUN +
short-lived TURN creds (`app/lib/core/config.dart` → `kIceServers`, ICE endpoint),
RealtimeKit token minting reserved for AvaConsult, `avatok-calls` worker.

Assessment for "smooth, fast calls on all devices":
- **P2P + TURN fallback is the right topology for 1:1** (the WhatsApp pattern).
  Media flows device↔device (free, lowest latency) and relays through Cloudflare's
  anycast TURN only when NATs force it (~10–20% of calls typically).
- **TURN/SFU pricing is sane**: $0.05/GB egress after 1,000 GB/month free. A
  TURN-relayed video call ≈ 0.7–1.5 GB/hour. At 1M users this is a real but linear
  budget line, not a wall.
- **Gaps that will make calls feel bad before any infra limit does:**
  - No call-quality telemetry (setup time, ICE state, RTT, packet loss, MOS-proxy).
    You cannot tune what you don't measure.
  - CallRoom DO is geo-pinned to first access — for signaling only this adds
    ~100–250ms to call *setup* for the far party, not to media. Acceptable, but
    location hints are a cheap win.
  - No documented ICE pre-warming, ICE-restart on network handoff (Wi-Fi↔LTE),
    or adaptive bitrate policy — these, not server capacity, determine perceived
    call quality on cheap Android devices.
  - RealtimeKit (the Dyte-built SDK layer, Flutter SDK available) is **beta with
    pricing TBA** — fine to adopt for AvaConsult group calls, risky as the only
    path for AvaTok 1:1. Current P2P design keeps you independent of it. Keep that.

### 3.3 🟠 Clerk — cost line and availability dependency

JWT verification is local (JWKS) so Clerk is not on the per-request hot path —
good. But: ~$0.02/MAU ⇒ roughly **$19k/month at 1M MAU**, and Clerk outages block
sign-in/token refresh (not existing sessions). Not urgent; needs a decision gate at
~250k users (enterprise contract vs. migration). Flagged now because auth
migrations get harder every month.

### 3.4 🟡 Fan-out (groups, followers, social feeds)

1:1 routing is solved. Group messages and follower-feed delivery touch N InboxDOs.
The arch doc correctly mandates Queues for large fan-out — enforce it: anything
over ~25 recipients goes through a queue, never a synchronous DO-call loop in the
router. Queues throughput (~5k msg/s/queue) is shardable across queues when needed.
Celebrity-scale accounts (100k+ followers) eventually want pull-based feeds
(read-time merge) rather than push fan-out — that's a >1M-user problem, design for
it, don't build it yet.

### 3.5 🟡 Moderation AI cost

Server-readable everything + 11B vision model on every distinct public image =
the #1 AI bill at 1M users (millions of images/day at social scale). Mitigations
already in place (sha256 dedupe, pHash LSH, public-path-only). Remaining: swap-path
to a cheap NSFW classifier as the first gate with the 11B model only for the
ambiguous band, plus a per-day neuron budget alarm.

### 3.6 🟡 Other limits checked (no action needed soon)

- **DO geo-pinning** for InboxDO: user's DO lives near their first access —
  naturally near the user. Only travelers suffer; placement hints later.
- **Workers**: stateless router scales transparently; no limit relevant at 1M.
- **KV**: read-heavy token/cache use is its sweet spot; 1 write/s/key limit — never
  put counters in KV.
- **Vectorize**: fine for semantic search at this scale; ingestion is queue-paced.
- **R2**: no practical caps at this scale.
- **PostHog/Analytics Engine**: linear cost; revisit at scale, not architectural.

---

## 4. The super-app question: one app or separate installs?

**Recommendation: ONE app. Your worry is directed at the wrong resource.**

### Memory (RAM) — not the problem
Flutter only materializes the widget tree, state, and data for the *open screen*.
A micro-app that is compiled in but never opened costs essentially zero RAM. Your
codebase already enforces the right pattern (no boot pre-warm, one indexed SQLite
query per screen, snapshot caches dropped on close). 100 micro-apps with this
discipline have the same steady-state RAM as 5 micro-apps. The actual RAM risks
are generic: unbounded `ImageCache`, video player instances not disposed, and
route stacks retaining heavy screens — all fixable with budgets, none related to
micro-app count.

### Storage/data — already solved
Per-account drift DB + content-addressed shared media cache means on-device data
grows with *use*, not with *installed surface area*. The universal storage pool
(AvaLibrary) dedupes across apps by design.

### Download size — the real cost of all-in-one, and it's manageable
Each micro-app adds compiled Dart (~0.3–1 MB AOT) + its assets. The current app
(13 feature modules, ~30–50 MB split-per-ABI APK) is nowhere near the pain line.
Pain starts around ~25–40 micro-apps **only if assets ship in the bundle**. Two
levers fix it permanently:
1. **Ship zero heavy assets in the binary** — Lottie/Rive packs, sticker packs,
   ML models, fonts beyond core come from R2/CDN on demand (you already have the
   cache pipeline for this).
2. **Flutter deferred components** (Android dynamic feature modules): core spine
   (shell, auth, AvaTok messaging, wallet) installs up-front; long-tail micro-apps
   download on first open, transparently. iOS doesn't support split downloads, but
   iOS users tolerate larger binaries and App Store thinning helps; the asset rule
   does most of the work there.

### Why NOT separate installs
- The ecosystem's moat is the **shared spine**: one identity (Clerk+KYC), one
  wallet, one storage pool, one social graph, one InboxDO socket. Separate apps
  re-pay login, push registration, socket, and cache per app — *that* multiplies
  device memory and battery cost (N background push handlers, N sockets) and
  fragments the UX.
- Cross-app flows (share an AvaGram post to AvaTok DM, pay from AvaWallet in
  Explore) become deep-link gymnastics with N× the auth surface.
- 100 store listings = 100× review/release overhead with your CI.
- Every successful precedent at this scale (WeChat, Grab, Gojek) is one binary
  with dynamically delivered mini-apps. The Meta multi-app model (Facebook /
  Messenger / Instagram) is a *brand* strategy for mature 100M+ user products with
  separate teams — and even they share backend identity.

**Hybrid escape hatch (later, optional):** if one micro-app (say AvaTube) deserves
its own store presence for discoverability, ship a thin satellite app that reuses
the same backend and account — a marketing decision at >1M users, not an
architecture decision today.

### Client-side requirements this implies (in the proposal)
A formal micro-app module contract: lazy route registration from `core/apps.dart`,
`deferred as` imports per micro-app, no static singletons that initialize at boot,
per-module dispose, asset-from-CDN rule, and CI tracking of binary size per module.

---

## 5. Scorecard

| Layer | Verdict at 1M | Notes |
|---|---|---|
| Messaging (InboxDO) | ✅ scales | Canonical pattern; per-user sharding |
| Push (Queues→FCM) | ✅ scales | Shard queues if >5k msg/s |
| Media (R2+cache+Stream) | ✅ scales | Cost-linear; verify cache rules stay on |
| Moderation | ✅ w/ cost work | Cheap-classifier first gate needed |
| D1 identity/directory | ✅ to 1M+ | User-count-scaled tables only |
| D1 social/feeds (planned) | 🔴 redesign before launch | Shard or DO-resident; see proposal |
| Calls 1:1 | 🟠 right topology, needs hardening | Telemetry, ICE handling, TURN budget |
| Group calls (AvaConsult) | 🟠 | RealtimeKit beta; acceptable, it's a separate app |
| Auth (Clerk) | 🟠 cost | Decision gate at 250k users |
| Flutter client | ✅ w/ size work | Deferred components + asset rule |
| Search | ✅ | FTS5 now; dedicated index later |
| Analytics | ✅ | Revisit cost at scale |

**Bottom line:** no rebuild, no platform change. Fix the D1 social-surface design
before the social apps launch, harden calls with telemetry + ICE discipline, put a
decision gate on Clerk, and adopt deferred components before micro-app #25. The
upgrade path is in the proposal document.

---

*Sources: Cloudflare DO limits/pricing, D1 limits & read replication, Realtime
SFU/TURN pricing, RealtimeKit beta status, Flutter deferred components docs, Clerk
pricing — see proposal §7 for links.*
