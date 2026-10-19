# HF-TREG-JEV-RESEARCH — treg + jev API research for Channels and face check

Issue: [HF-WIRE-1C] · Researched 2026-10-19 · Method: fetched the actual doc pages. Anything marked
**NOT VERIFIED** could not be fetched or is not stated in the docs.

## 1. Summary + recommendation

Neither service is what the plan assumed. **treg (treg.to) is not an Instagram/YouTube API.** It is a
pay-per-call gateway (one token, many providers) that resells other vendors' endpoints; its Instagram and
YouTube data come from third-party scrapers (mainly ScrapeCreators, also Bright Data, SerpApi and others).
It can do everything we want (exists, followers, bio, recent reels/shorts with video URL, views, likes) but it
is scraping, it adds a middleman, and treg itself publishes no response schema — the shape is the upstream
vendor's. **jev (typesafe.ai) is a text-only decision model and cannot look at a thumbnail or video.** The
owner's belief that it "now does face detection" is not supported by its docs: the models page says text
only, no images, no audio or video. (The docs' Images page describes an image feature behind a "danger zone"
header, but the models page contradicts it and no face use is documented — treat as unavailable.) Jev's
sibling **clef / clef-flash** (same TypeSafe design, hosted on Cloudflare Workers AI, accepts up to 4 images)
is the thing that could answer "is a face visible" with a probability, but it is a general decision model, not
a face detector, and is untested for faces.

**Recommendation:** (1) For Instagram/YouTube data, go direct to **ScrapeCreators** (the vendor behind treg's
endpoints; $ per call, simple `x-api-key` auth, documented schemas) instead of treg, OR use treg only if the owner wants
one key for many tools — treg adds nothing for this use case. For YouTube use the **official YouTube Data
API v3** (free quota, no ToS risk). Instagram has no free official route for arbitrary handles; ownership
verification should use **Instagram Login (OAuth)** on the influencer's own Business/Creator account, which
is stronger than the bio code and fully ToS-clean; keep the bio-code via scraper as the fallback for personal
accounts. (2) For the face check, do **not** use jev. Use **Cloudflare Workers AI** (clef-flash or a vision
model) or **Google Cloud Vision face detection** (first 1,000/month free, then $1.50 per 1,000) on the
thumbnail/keyframe; Cloud Vision is the only one with a purpose-built face detector and a reliable boolean.

## 2. treg

### What it is
"One MCP server with one key" for 4,000+ tools from 113 providers (treg.to home). Operated by Superdesign
(terms). Source is public AGPL (github.com/superdesigndev/treg). Not a data source itself.

### Auth and calling
- Base URL `https://treg.to`. Header `X-Treg-Token: trg_live_...` (a per-org token; identity tokens also need `X-Treg-Org`). MCP clients use `Authorization: Bearer`.
- Call pattern: `GET https://treg.to/call/<catalog-endpoint-id>?<params>`; method, path, query and body pass through to the upstream. Response is the **upstream body verbatim**.
- Headers returned: `X-Treg-Call-Id`, `X-Treg-Cost-Micro`, `X-Treg-Cache`, `X-Treg-Served-Via`. Send `Idempotency-Key` on retries (24h). `X-Treg-Route-Max-Cost` caps spend.
- Example from docs: `curl "https://treg.to/call/tikhub.tiktok.user.profile?uniqueId=tiktok" -H "X-Treg-Token: $TREG_TOKEN"`.

### Instagram / YouTube / Facebook endpoints (catalog)
Catalog counts: Instagram 187 endpoints (from $0.0007/success), YouTube 168 (from $0.0009), Facebook 88
(from $0.0012). Providers: AnyAPI, Bright Data, Crawl4AI, Just One API, ScrapeCreators, SerpApi, TikHub, DataForSEO
(+ official "Instagram", "YouTube", "Facebook Pages" OAuth entries for the user's OWN accounts).
ScrapeCreators entries on treg (each $0.00188/call, "Platform + BYOK"; own ScrapeCreators key = not metered by treg):

| Need | treg endpoint id | Input |
|---|---|---|
| IG exists, followers, bio | `scrapecreators.instagram.user.profile` | username |
| IG recent reels/posts | `scrapecreators.instagram.user.posts` | username |
| IG single post/reel | (post detail) | URL |
| YT channel info | `scrapecreators.youtube.channel.profile` | channel id or handle |
| YT recent Shorts | `scrapecreators.x.v1-youtube-channel-shorts` | channel id or handle |
| YT uploads | `scrapecreators.x.v1-youtube-channel-videos` | channel id or handle |
| YT video/short detail | `scrapecreators.youtube.video.detail` | video or Short URL |

treg's page does not list parameter names or response schemas (**NOT VERIFIED on treg**); the schemas below are
ScrapeCreators' own docs.

### Response fields (from ScrapeCreators docs, which is what treg returns)
- **IG profile** `GET https://api.scrapecreators.com/v1/instagram/profile?handle=jane` (1 credit; 0 if cached; `cache_max_age=1d|3d|7d|14d|30d` returns cached with `"cached":true,"cached_at"`):
  followers `data.user.edge_followed_by.count`; bio `data.user.biography` (and `biography_with_entities`); also `is_private`.
  **Exists check:** nonexistent account returns **HTTP 200**, `success=true`, `userId=null`, `error="not_found"`,
  `errorStatus=404` (still costs 1 credit; docs say it means "no matching result", not confirmed deletion).
  Private: HTTP 200, `message="Profile is private"`, `is_private=true`. Age-restricted: 403, 0 credits. Upstream block: 500 "IG is blocking us. Try again" (0 credits).
- **IG reels** `GET /v1/instagram/user/reels?handle=|user_id=&max_id=&trim=true`. Top level `success, credits_remaining, credits_charged, items[], paging_info{max_id,more_available}, status`. Each `items[].media`:
  `video_versions[].url` (direct mp4 + width/height), `play_count` / `ig_play_count`, `like_count`, `comment_count`, `display_uri` or `image_versions2.candidates[].url` (thumbnail),
  `caption`, `taken_at` (unix) and `created_at` (ISO), `code` (shortcode), `url` (reel link), `video_duration`, `product_type`, `pk`, `id`.
  Caveat: IG CDN `video_versions`/thumbnail URLs are signed and expire — **copy to R2 or re-fetch; never store as permanent**.
- **YT Shorts** `GET /v1/youtube/channel/shorts?handle=|channelId=&sort=&continuationToken=`. Docs page documents only `publishDate` (ISO 8601 with offset, or null when YouTube hides the exact time). Short URL, thumbnail, views, likes: **NOT VERIFIED** (full schema is at docs.scrapecreators.com, which we did not get to load). `video.detail` takes a Short URL.
- Embed URL: neither returns a ready embed URL. Build it ourselves: YouTube `https://www.youtube.com/embed/<id>`; Instagram `https://www.instagram.com/reel/<code>/embed`.

### Rate limits
treg: no per-token or per-team concurrency limit; provider limits pass through; 429 `share_busy` (not billed, `retry_after_s`), 503 `treg_saturated` (Retry-After). 8 MiB response cap. ScrapeCreators' own rate limits: **NOT VERIFIED** (pricing page would not load).

### Price
treg: $1.00 free credit once, then prepaid, per call, "0% markup" claimed; BYOK = unmetered. Roughly **$0.0019 per call** for the ScrapeCreators IG/YT endpoints. A channel connect (profile + reels, 2 calls) ≈ $0.004; 1,000 creators synced daily ≈ $3.8/day for 2 calls each if not cached. ScrapeCreators direct pricing: **NOT VERIFIED** (pricing page would not load); use the `cache_max_age` option to cut cost.

### Data freshness
Live scrape on each call unless `cache_max_age` is set (ScrapeCreators) or treg returns `X-Treg-Cache`. No SLA ("as is", no uptime commitment per treg terms).

### Facebook
Listed: 88 endpoints for public Pages/posts via scrapers, and official OAuth for your OWN Pages' insights and publishing. Reels app is Instagram+YouTube only for now (owner answer HF-REEL-23..25), so Facebook is out of scope.

### ToS / risk
- It **is scraping** (ScrapeCreators, Bright Data, Crawl4AI etc. read public pages). treg's terms do not mention scraping by name, but §07 forbids using treg to break an upstream API's terms, rate limits or anti-abuse measures, and §05 says Superdesign is not party to your relationship with providers. Liability capped at max(12-month spend, US$100); as-is; no support commitment. So the legal risk of scraping Instagram sits with us.
- Instagram prohibits automated collection in its ToS; scrapers can be blocked at any time (the 500 "IG is blocking us" response is documented). Plan for outages and degrade gracefully.
- For public-business-data and consented creators (the creator connects her own handle) the practical risk is low but not zero. Do not scrape private accounts, and do not store scraped video files long-term without the creator's consent — the video is her IP; we should embed, not rehost, unless she opts in during onboarding.

### Bio-code ownership check — feasible?
Yes, technically. Flow: worker issues a one-time code (e.g. `HF-7K3Q9`), creator pastes it in her IG bio, worker calls the profile endpoint and checks `data.user.biography` contains the code. Caveats: IG bio edits can take seconds to a few minutes to show; if the response is cached (`cached:true`) the code will be missing, so **always pass no `cache_max_age` for verification**; retry up to ~3 times over a minute; scraper block errors (500) are retryable; private accounts return no bio (reject with a clear message). For YouTube, the channel `description` (channel.profile) can carry the code the same way, but better to use official YouTube OAuth (see Fallbacks). Weakness: a bio code proves control of the account at that moment only; a stronger proof is the official Instagram Login OAuth on that account.

## 3. jev

### What it is
TypeSafe AI's first "System One" model (launched 2026-09-15, early access). You send a `state` (text or JSON) and typed questions (`choice`, `score`, `noul` = yes/no probability, plus `box` on 1.14); it returns structured answers with probabilities and a confidence value — it never generates free text. It is built for fast software decisions (routing, classification, guardrails).

### API
- `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>` (keys from console.typesafe.ai/keys), `Content-Type: application/json`.
- Models: `jev-1.13.0` (alias `jev-latest`) and `jev-1.14.0` (alias `jev-preview`).
- Example request/response (from docs): `{"state": "...", "model": "jev-latest", "questions": {"is_urgent": {"type":"noul","instructions":"..."}}}` → `{"model":"jev-1.13.0","answers":{"is_urgent":{"type":"noul","noul":0.99}},"usage":{"input_tokens":428,"output_tokens":73}}`.

### Face detection? **No.**
- Models page: input is **text only**; "does not accept audio or video"; images not supported. Blog post: images are "not on images (yet…)".
- Contradiction: the Images doc page describes an `assets` map (base64 or multipart, PNG/JPEG only, 280–1568 px per side, 16 MiB per image, header `TypeSafe-Danger-Zone-Images: true`) and says Noul questions can take images ("is there a person in X"); Box (locate in image) needs jev-1.14 and is called "Dreamer-ready, not production-ready". But there is no face guidance or example anywhere, and the models page says images are unsupported. **Treat jev as not usable for face detection** until TypeSafe confirms in writing. Input cannot be a video URL or an image URL in any case (base64/multipart only).

### Latency / price / limits
- Latency: blog says 70–500 ms end to end; a third party measured a 524 ms median vs clef's 209 ms.
- Price: $0.042 per million input tokens, output free (so text decisions are essentially free; image token cost: not documented).
- Limits: 64k tokens per request (262k with a slower long-context header); per-org tokens/sec and requests/sec limits, 429 on excess; early-access waitlist; US-hosted.

### Clef (the sibling that does take images)
Cloudflare launched `clef` and `clef-flash` on Workers AI on 2026-10-01: API-compatible with jev, accept **up to 4 images** per request, return a probability per option. Clef median 209 ms / $0.24 per M input tokens; clef-flash median 39 ms / $0.09 per M; 10,000 free neurons/day on Workers AI. Not a face detector — benchmarks cover intent/reasoning tasks, not faces — so a "face visible, yes/no + probability" question must be tested on our own thumbnails. (Source: betterstack comparison, orcarouter release note, Cloudflare model catalog; the Cloudflare per-model page itself was NOT fetched.)

## 4. Fallbacks

### YouTube Data API v3 (official, recommended for YouTube)
- Default quota 10,000 units/day per project; `channels.list`, `playlistItems.list`, `videos.list` each cost 1 unit; `search.list` is separate (100 calls/day default). Quota resets midnight Pacific. (Fetched.)
- Subscribers: `channels.list?part=statistics,snippet,contentDetails&forHandle=@x` → `statistics.subscriberCount` (rounded to 3 significant figures publicly; `hiddenSubscriberCount` may be true), `snippet.description` (bio code), `snippet.thumbnails`. Existence = `items` is empty or not.
- Uploads: take `contentDetails.relatedPlaylists.uploads` then `playlistItems.list` (1 unit, 50 per page), then `videos.list?part=snippet,statistics,contentDetails` for views/likes/comments/duration/publish time. Embed URL `https://www.youtube.com/embed/<id>`. No direct video file URL (not available officially; embed instead).
- Shorts detection: no official flag. Common approach: duration ≤ 60 s (YouTube extended Shorts to up to 3 min in 2024 — use ≤ 180 s plus vertical aspect), or probe `https://www.youtube.com/shorts/<id>` (returns 200 for a Short, redirects to /watch otherwise). **Not re-verified from docs today** (from prior knowledge).
- Ownership: Google OAuth with `youtube.readonly`, `channels.list?mine=true` proves she controls the channel; stronger than a bio code.

### Instagram Graph API / Instagram Login (official, for the creator's OWN account)
- Instagram API with Instagram Login covers "Instagram professionals — businesses and creators" (no Facebook Page needed). Scope `instagram_business_basic` (fetched).
- Fields `followers_count`, `username`, `biography` on `/me`; `/me/media?fields=id,media_type,media_product_type,permalink,thumbnail_url,media_url,caption,timestamp,like_count,comments_count` (REELS appear as `media_product_type=REELS`, `media_url` is an expiring video URL). The fetched overview page does not list these fields, so they are **NOT VERIFIED from docs today**; confirm in the Instagram Media reference.
- Limits: personal (non-professional) accounts cannot connect; production use needs Meta app review/advanced access (**NOT VERIFIED** — page did not mention it). Cannot look up other people's accounts. Good for ownership proof + insights, not for "does this handle exist".
- Meta oEmbed: `GET graph.facebook.com/instagram_oembed?url=...` returns `html` embed; 1,000 requests/hour; only for embedding (analytics use prohibited); no private/age-restricted accounts. `thumbnail_url` NOT confirmed on the page. Use only to render the embed on the fan page.

### Face-detect fallback
- **Google Cloud Vision** face detection: first 1,000 units/month free, $1.50 per 1,000 up to 5M (fetched). Returns `faceAnnotations[]` with `detectionConfidence`; purpose-built, accepts image bytes or a public URL. Best accuracy for "a human face visible".
- **Cloudflare Workers AI**: vision models (llava-1.5-7b, llama-3.2-11b-vision, moondream, clef/clef-flash) can answer "is a human face visible?" from a thumbnail; cheaper and in-stack, but a general model, not a detector (**NOT** benchmarked for faces; no detr/face model found on the catalog page).
- Input should be a keyframe, not the whole video: for "first few seconds" use the platform thumbnail (instant) and, if needed, extract a frame at ~1–2 s from the cached video via ffmpeg (not available inside a Worker — needs a Container / external step). Thumbnail-only is the cheap v1.

## 5. Proposed integration design (Cloudflare worker)

Secrets: `SCRAPECREATORS_API_KEY` (or `TREG_API_KEY` if treg is chosen; same call shape via `https://treg.to/call/<id>` with `X-Treg-Token`), `YOUTUBE_API_KEY`, `GCV_API_KEY` (only if Cloud Vision is picked). `JEV_API_KEY` only if the owner still wants jev for text-only decisions; do not add it for the face check. Worker is at the 128 text-binding limit (CLAUDE.md) — add ONE secret each, and check headroom before adding more.

Provider lib `worker/src/lib/social_provider.ts` with an interface `lookupChannel(platform, handle)` and `listRecent(platform, handle)` so treg / ScrapeCreators / official API are swappable behind it.

At channel-connect (synchronous, user waiting):
1. Normalise handle/URL. Call profile (IG scraper profile, no cache param; YT `channels.list`). Return `exists`, `followers`, `bio/description`, avatar.
2. Enforce the 10-follower minimum (owner answer) from that response.
3. Issue code; creator pastes it; on "Verify" call profile again with no cache and match the code (retry 3x/60 s). For YouTube prefer OAuth.
4. After verify, enqueue (Queue, not inline) the first import of recent reels/shorts.

In the daily cron (per verified channel, staggered):
1. `listRecent` (IG reels endpoint with `max_id` paging; YT uploads playlist + `videos.list`); upsert by shortcode/video id; update views/likes/comments.
2. Refresh follower count weekly, not daily (cost). Use `cache_max_age=1d` for non-verification calls.
3. For NEW items only: store thumbnail to R2, run the face check once, store `face_visible` + `face_confidence` + model + date; never re-run for existing items.

Face check location: a Queue consumer (not the request path), input = thumbnail image bytes from R2, output `{face_visible: bool, confidence: 0..1}`; reels below a threshold (e.g. <0.5) are held for manual review, not auto-rejected. Video file URLs from the scraper expire, so persist only when the creator opted in; otherwise embed.

Caching: D1 table `hf_channel_cache(platform, handle, payload_json, fetched_at)`; reuse within 24 h for display; never for ownership verification. Store raw provider JSON in D1/KV so a provider swap does not lose fields. Telemetry (PostHog, per CLAUDE.md): `hf_channel_lookup{provider,platform,ok,ms,cost_micro}`, `hf_face_check{model,face_visible,confidence}`; failures through `hooks.trackException`. Cost guard: daily spend counter in KV with a kill switch flag declared in `config.ts` DEFAULTS.

## 6. Open questions for the owner

1. Is scraping Instagram acceptable? It breaks Instagram's ToS (the vendor, not us, runs the scrape, but we depend on it and it can stop any day). Alternative: Instagram Login OAuth only (creators connect; no scraping), at the cost of requiring Business/Creator accounts and Meta app review.
2. treg vs ScrapeCreators direct: treg is a gateway with no added capability for this use; choose treg only for its single bill / one key. Which one?
3. Who should own the video: embed only (safe), or copy the mp4 to our R2 (needs creator consent in the terms)?
4. Face check: OK to use Google Cloud Vision (needs a Google Cloud key; $1.50/1000 after 1,000 free) vs a Workers AI vision model (cheaper but unproven)? Should we test 30 real thumbnails with each before deciding?
5. Is a ~3-minute vertical YouTube video a "Short" for us? (YouTube now allows Shorts up to 3 minutes.)
6. Should YouTube creators verify by Google OAuth (stronger, one tap) instead of a bio code?
7. What happens when an IG scraper call fails at connect time: block the creator, or let her through as "pending verification"?
8. Ask TypeSafe whether jev (or clef) officially supports face/person detection on images; their docs contradict each other.

## 7. Sources

- https://treg.to/ (home), https://treg.to/llms.txt, https://treg.to/catalog, https://treg.to/tools/scrapecreators, https://treg.to/terms
- https://typesafe.ai/blog/introducing-system-one-models-and-jev
- https://docs.typesafe.ai (intro), https://docs.typesafe.ai/llms.txt, https://docs.typesafe.ai/introduction/quickstart, https://docs.typesafe.ai/models, https://docs.typesafe.ai/images (the /api-reference and jaggedness pages failed to fetch)
- https://docs.scrapecreators.com/v1/instagram/profile, https://scrapecreators.com/tutorials/how-to-scrape-instagram-reels-with-python, https://scrapecreators.com/youtube/endpoints/channel-shorts (scrapecreators.com/pricing and the IG profile endpoint page failed to fetch)
- https://betterstack.com/community/guides/ai/jev-vs-clef-decision-model/, https://www.orcarouter.ai/blog/clef-decision-models-release, https://developers.cloudflare.com/workers-ai/models/
- https://developers.google.com/youtube/v3/determine_quota_cost
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login, https://developers.facebook.com/docs/instagram-platform/oembed (the "get-started" page failed to fetch)
- https://cloud.google.com/vision/pricing
