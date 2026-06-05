# wrangler.toml — Foundation Additions (Phase 1b)

**Add these to wrangler.toml before provisioning. Wire bindings now, use them later.**

---

## 1. Observability (Workers Logs)

```toml
# Workers Logs — 7-day retention, included in paid plan. No reason not to.
[observability]
enabled = true
```

Zero cost. Gives you request logs, error traces, console output for every Worker invocation. Essential for debugging from day one.

---

## 2. Analytics Engine

```toml
# Analytics Engine — high-volume product metrics that would blow PostHog's budget.
# API latency, per-app usage counters, relay event throughput, moderation queue depth.
# PostHog handles product analytics (funnels, retention, feature flags).
# Analytics Engine handles operational metrics (millions of data points/sec, $0.25/million).
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "avatok_metrics"
```

**PostHog vs Analytics Engine — they complement, not compete:**

| | PostHog | Analytics Engine |
|---|---|---|
| Purpose | Product analytics (user behavior) | Operational metrics (system health) |
| Events | Sign up, post created, match made | API latency p99, relay events/sec, queue depth |
| Volume | ~10-50 events/user/day | Thousands of data points/sec |
| Cost | Free tier 1M events/mo, then $$$  | $0.25 per million writes |
| Query | PostHog UI, dashboards | Workers Analytics SQL API |

Write to Analytics Engine from every Worker (`ctx.waitUntil(env.ANALYTICS.writeDataPoint(...))`). Push user-facing product events to PostHog via Queue.

---

## 3. Analytics Queue (PostHog batching)

```toml
# PostHog event batching — never call PostHog API synchronously from a Worker.
[[queues.producers]]
binding = "Q_ANALYTICS"
queue = "analytics"
```

Consumer Worker batches events and sends to PostHog `/capture` API endpoint. Decouples request latency from PostHog availability.

---

## 4. Vectorize (semantic search)

```toml
# Vectorize — semantic search index. Created now, populated in Phase 4.
# Powers: AvaDate matching, AvaExplore product search, AvaNews recommendations,
# AvaLibrary content discovery, AvaAgent memory.
[[vectorize]]
binding = "VECTOR_INDEX"
index_name = "avatok-semantic"
```

Create the index with: `wrangler vectorize create avatok-semantic --dimensions=384 --metric=cosine`

384 dimensions = `bge-small-en-v1.5` via Workers AI. Cosine similarity for text matching. Don't populate yet — just wire the binding so Phase 4 code can use it without a config change.

---

## 5. Browser Rendering (link previews)

```toml
# Browser Rendering — headless Chrome for link previews and OG image generation.
# AvaChat/AvaTweet show rich link cards. Cache aggressively (same URL = same preview).
[browser]
binding = "BROWSER"
```

When a user pastes a URL in AvaChat or AvaTweet, the Worker fetches OG tags via Browser Rendering, caches the result in Cache API (1-hour TTL), and returns a link card. No external service needed.

---

## 6. Logpush (trace events → PostHog)

**Not a wrangler.toml config — set up in Cloudflare Dashboard:**

Dashboard → Account → Workers → Logpush → Create Job:
- Source: Workers Trace Events
- Destination: HTTP endpoint → PostHog `/capture` batch endpoint
- Filter: errors + slow requests (>500ms) to avoid volume explosion

This feeds Worker execution traces into PostHog so you can correlate backend errors with user sessions. Set up during Phase 1b provisioning.

---

## 7. Cloudflare Calls (SFU + TURN)

**Not a wrangler.toml binding — uses REST API with API token:**

Dashboard → Calls → Enable. You already have `TURN_KEY_API_TOKEN` in the secrets list.

The CallRoom DO uses the Calls API to:
- Generate TURN credentials for NAT-punching (~15% of 1:1 calls)
- Create SFU sessions for group calls
- 1,000 GB/month free covers ~12K MAU

Verify Calls is enabled in your dashboard during Phase 1b.

---

## 8. Stream Live (AvaLive)

**Not a wrangler.toml binding — uses Stream API + webhook:**

Dashboard → Stream → Live Input → Create.

AvaLive uses two-layer architecture:
- Cloudflare Stream Live handles video bytes (RTMP ingest → HLS/WebRTC playback)
- Nostr relay handles social metadata (NIP-53 kind:30311 + kind:1311 chat)

Add a webhook endpoint to the API Worker (`/webhooks/stream`) that fires on stream start/stop/recording-ready. This dispatches to Q_MODERATION (scan) and updates the NIP-53 event status.

Verify Stream is enabled in your dashboard during Phase 1b.

---

## Updated wrangler.toml additions block (copy-paste for builder)

```toml
# ---------------------------------------------------------------------------
# Observability — Workers Logs (7-day retention, paid plan included)
# ---------------------------------------------------------------------------
[observability]
enabled = true

# ---------------------------------------------------------------------------
# Analytics Engine — operational metrics (complements PostHog for product analytics)
# ---------------------------------------------------------------------------
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "avatok_metrics"

# ---------------------------------------------------------------------------
# Vectorize — semantic search (create index now, populate Phase 4)
# wrangler vectorize create avatok-semantic --dimensions=384 --metric=cosine
# ---------------------------------------------------------------------------
[[vectorize]]
binding = "VECTOR_INDEX"
index_name = "avatok-semantic"

# ---------------------------------------------------------------------------
# Browser Rendering — link previews, OG images (cache in Cache API)
# ---------------------------------------------------------------------------
[browser]
binding = "BROWSER"

# ---------------------------------------------------------------------------
# Analytics Queue — PostHog event batching (never call PostHog sync)
# ---------------------------------------------------------------------------
[[queues.producers]]
binding = "Q_ANALYTICS"
queue = "analytics"
```

## Dashboard checklist for Phase 1b provisioning

- [ ] Workers Paid plan active ($5/mo) — **required for Queues**
- [ ] Cloudflare Calls enabled — check Dashboard → Calls
- [ ] Stream Live enabled — check Dashboard → Stream
- [ ] Logpush job created: Workers Trace Events → PostHog `/capture`
- [ ] `wrangler vectorize create avatok-semantic --dimensions=384 --metric=cosine`
- [ ] All D1 databases created, migrations run, IDs filled in wrangler.toml
- [ ] R2 buckets created, `blossom.avatok.ai` custom domain + Cache Everything
- [ ] KV namespace created
- [ ] 4 Queues created (moderation, push-notifications, email, analytics)
- [ ] Secrets set via `wrangler secret put` (CLERK_JWKS_URL, OPENAI_API_KEY, TURN_KEY_API_TOKEN, FCM_SERVICE_ACCOUNT, RESEND_API_KEY)
