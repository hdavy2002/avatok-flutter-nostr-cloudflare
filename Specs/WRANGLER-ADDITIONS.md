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

---

## Liveness V3 — additions (2026-07-06, dark behind `livenessV3Enabled`)

Server side of Liveness V3 (`worker/src/routes/liveness_v3.ts`, provider
normalization + deterministic rules). EXTENDS V2 — reuses the existing
`liveness-verify` queue, the `VERIFICATION` R2 bucket (`avatok-verification`),
`DB_META`, `identity_proofs`, and the `invalidateLevelCache` pattern. Nothing
below is auto-applied — the owner/orchestrator applies migrations and edits infra.

### 1. D1 migration (apply to DB_META — do NOT auto-apply)

    worker/migrations/liveness_v3.sql

Creates three additive tables: `liveness_v3_sessions`, `liveness_v3_hashes`
(content-hash dedupe / replay defense), `liveness_v3_verdicts` (append-only).

### 2. Queue — reuse the existing `liveness-verify` queue

No NEW queue. V3 verify messages are sent onto the SAME `liveness-verify` queue
avatok-api already self-consumes, discriminated by a `v3:true` flag on the body
(index.ts routes them to `runLivenessV3Checks`). If that queue is not yet created,
V3 falls back to `ctx.waitUntil` exactly like V2. Once created:

    wrangler queues create liveness-verify   # (shared with V2; create once)

and ensure both the producer binding (`LIVENESS_QUEUE`) and the
`[[queues.consumers]]` entry for `liveness-verify` exist on avatok-api (they are
already declared for V2).

### 3. R2 presigned PUT upload — S3 creds required for the production path

The session response hands the client a presigned R2 **PUT** URL so the ≤15 MB
video never streams through the Worker body (`presignPutUrl` in `aws/sigv4.ts`,
bucket `avatok-verification`). This needs the R2 S3-API creds already used by
AvaOLX:

    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   # wrangler secret put

If unset, V3 degrades to a Worker-proxied upload (`PUT /api/liveness/v3/upload`) —
functional for dev/staging but bytes pass through the Worker; set the creds for
production scale.

### 4. R2 lifecycle rules — expire liveness evidence by verdict (plan §5)

V3 tags objects with `customMetadata`: retained pass thumbnail → `retain=24h`,
fail/review video → `retain=7d`. R2 lifecycle rules cannot yet filter on custom
metadata, so drive expiry by **key prefix** instead. Configure lifecycle on the
`avatok-verification` bucket (Cloudflare dashboard → R2 → bucket → Settings →
Object lifecycle rules, or via the S3 API):

- Prefix `u/<uid>/livenessv3/` (transient uploads + fail/review videos): **expire
  after 7 days**. Passes already delete their raw video in-code; this reaps
  fail/review videos and any orphaned transient uploads.
- Prefix `liveness/<uid>/` (retained pass thumbnails, shared with V2): keep per the
  existing V2 retention policy (the green-tick thumbnail must survive for
  `identity_proofs.evidence_ref`). To honor the "pass thumbnail 24h" target from
  the plan, add a tighter rule ONLY if the product later stops needing the
  thumbnail long-term — today the ladder reads it, so it must persist.

Note: the 24h/7d split in the plan is expressed via the `retain` customMetadata
tag for forward-compat if/when R2 lifecycle gains metadata filters; the prefix
rule above is the mechanism that actually reaps objects today.

### 5. Optional media-extract binding (frame extraction)

The Workers runtime cannot decode MP4/H.264 in-process. `runLivenessV3Checks`
looks for an optional `MEDIA_EXTRACT` service binding (a Cloudflare Container /
media Worker that takes the video + `x-offsets` header and returns base64 JPEG
frames). Until that binding exists, extraction "fails" cleanly → the pipeline
records `EXTRACTION_FAILED` → **REVIEW** (never a false FAIL), so V3 is safe to
ship dark without it. To enable real verification, stand up the extractor and add:

    [[services]]
    binding = "MEDIA_EXTRACT"
    service = "<your-media-extract-worker>"

### 6. AWS Rekognition — DetectFaces

V3 uses `DetectFaces` (added to `aws/rekognition.ts`) as the launch `FaceProvider`.
Needs the AWS creds already named for V2 CompareFaces:

    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION      # wrangler secret put

Without them the pipeline degrades to the Workers AI face-present fallback →
REVIEW (breaker rule: never FAIL on our infra problem). File the Rekognition
service-quota raise (~100 TPS) before ramping past 5% (plan §3).

### 7. KV flag

`platform_config.livenessV3Enabled` defaults `false` in code. Remember the
2026-07-04 lesson: **patch the KV `platform_config` blob** to flip it on — readers
merge KV OVER code defaults, they do not fall back to a code default that was only
added after the KV blob was last written.
