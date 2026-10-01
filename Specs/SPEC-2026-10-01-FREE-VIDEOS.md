# SPEC 2026-10-01 — Free videos (a separate section, not events)

Owner decisions (2026-10-01, chat; mockup approved: design canvas "YouTube Crop Tool",
boards "Admin · New free video", "Home / marketplace · Free videos row", "Free video
watch page"):

- A **Free video** is NOT an event/listing. No price, booking, reviews, booked count,
  date, countdown, performer, checkout. Fields: **title, description, category,
  cover photo (optional — falls back to the YouTube thumbnail), YouTube link + crop**.
- Categories (fixed list): `satsang`, `meditation`, `sermon`, `bhajan`, `aarti`,
  `festival`. Labels: Satsang, Meditation, Sermon, Bhajan, Aarti, Festival.
- Cards appear in their **own "Free videos" row** on the home page and the marketplace
  (separate from paid events). Card = cover + category chip + badge + title +
  description + "Watch free →" button. Badge: **"Streaming live now"** only when the
  YouTube video is actually live right now, else **"Free video"**.
- Each has its own **simple watch page** `/watch/<id>`: big cropped guarded player,
  category chip, title, description, "Watch free" button that greys to "Watching now"
  while playing, WhatsApp share, "More free videos" strip.
- Watching needs an **email sign-in only** (no WhatsApp), same as free events. A
  signed-out visitor clicks → `/sign-in?redirect_url=/watch/<id>?freewatch=1` → back
  and the video plays. Signed-in visitor goes straight to `/watch/<id>?freewatch=1`.
  The video id is NEVER in page HTML; it only comes from the entitled watch call.
- Views are counted (PostHog + D1) and appear on the admin Analytics "Video views"
  section alongside free events.
- Never type the brand name/domain (use BRAND / brandUrl). PostHog on every surface.

Reuse (already on main): `web/src/components/dash2/crop.ts`, `worker/src/lib/video_crop.ts`,
`YouTubeGuardedPlayer` (`crop` prop; hides YouTube UI incl. pause/resume),
`web/src/islands/admin2/VideoCropEditor.tsx`, `web/src/lib/clerk.tsx`
`ClerkSessionBridge` (ONE session-only Clerk provider per page — never mount
`<ClerkIsland>{null}</ClerkIsland>` yourself), `event_video_views` table,
`web/src/lib/authRedirect.ts` free-watch marker helpers, `saathum_stream_state.ts`
YouTube live check (YOUTUBE_API_KEY).

## Data — `worker/migrations/2026-10-01-free-videos.sql` (CREATE-only, DB_META)

```sql
CREATE TABLE IF NOT EXISTS free_videos (
  id TEXT PRIMARY KEY,                 -- 'fv_' + random
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,              -- one of the fixed list
  cover_url TEXT,                      -- NULL = use the YouTube thumbnail
  youtube_video_id TEXT NOT NULL,
  source_url TEXT,
  crop_x REAL, crop_y REAL, crop_w REAL, crop_h REAL,
  status TEXT NOT NULL DEFAULT 'draft',-- 'draft' | 'published' | 'archived'
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_live INTEGER NOT NULL DEFAULT 0,  -- refreshed by cron from the YouTube API
  live_checked_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
  admin_uid TEXT
);
CREATE INDEX IF NOT EXISTS idx_free_videos_pub ON free_videos(status, sort_order, published_at);
```
Views: reuse `event_video_views` with `listing_id = <free video id>` (ids start `fv_`, so they
never collide with listing ids).

## API (worker) — `[SAATHUM-FREEVIDEOS-API-1]`, new file `worker/src/routes/free_videos.ts`

Public card shape (NEVER contains youtube_video_id or source_url):
```json
{ "id":"fv_x", "title":"…", "description":"…", "category":"satsang", "category_label":"Satsang",
  "cover_url":"https://…" , "is_live":false, "published_at":1790000000000 }
```
`cover_url` = the uploaded cover, else `https://i.ytimg.com/vi/<id>/hqdefault.jpg` (thumbnail
URLs reveal the id; acceptable — owner already knows a determined user can find it; do NOT
add the raw watch URL anywhere).

- `GET /api/free-videos?limit=12&category=` → `{ items: Card[] }` published only, order
  `is_live DESC, sort_order ASC, published_at DESC`. `cache-control: public, max-age=60`.
- `GET /api/free-videos/:id` → `{ video: Card }` (published only; 404 otherwise). Public, cacheable 60s.
- `GET /api/free-videos/:id/watch` → requireUser ONLY (no WhatsApp) →
  `{ ok, id, youtube_video_id, crop: VideoCrop|null, is_live }`. Admin may watch drafts.
- `POST /api/free-videos/:id/view` → requireUser; upsert `event_video_views` (same 60 s
  throttle helper as free events — reuse `recordVideoView`); PostHog `saathum_video_view`
  `{ listing_id: id, free: true, kind: 'free_video', first_view, email }` via `trackUser`.
- Admin (`requireAdminRole`/the admin2 guard used by admin2_events.ts):
  - `GET /api/admin/v2/free-videos` → all (incl. drafts) with youtube url + crop + view counts.
  - `GET /api/admin/v2/free-videos/:id`
  - `POST /api/admin/v2/free-videos` body `{ title, description, category, cover_url?, youtube_url, crop?, status? }`
  - `PUT /api/admin/v2/free-videos/:id` partial of the same (crop absent = keep, null = clear)
  - `DELETE /api/admin/v2/free-videos/:id` → status 'archived' (soft)
  - Validation: title 3–120, description ≤ 600, category in list, youtube url parses to an id
    (reuse the existing YouTube id parser used by the event video route), crop via `toCrop`
    (400 `bad_crop`). Cover upload reuses the existing admin cover upload route
    (`uploadCover` in web/src/islands/admin2/eventsApi.ts → find its worker route).
- Live badge: in the existing cron that checks YouTube live state (see
  `saathum_stream_state.ts` / index.ts scheduled handler), also refresh `is_live` for
  published free videos (batch ids, ≤50 per API call, only when YOUTUBE_API_KEY set;
  unset → is_live stays 0).
- Admin analytics `video_views.by_event`: titles for `fv_` ids come from `free_videos`
  (LEFT JOIN / second lookup); add `kind: 'event'|'free_video'` to each row.
- Telemetry: `free_video_admin_saved` (server, on create/update).

## Web — admin `[SAATHUM-FREEVIDEOS-ADMIN-1]`
- Admin menu item "Free videos" (web/src/islands/admin2/nav.ts) → `/admin/free-videos`
  (list: cover thumb, title, category, status, viewers, Edit) and `/admin/free-videos/new`,
  `/admin/free-videos/<id>` (form exactly as the mockup: Details [title, description,
  category chips], Cover photo [upload / use YouTube thumbnail], YouTube video + crop
  [VideoCropEditor], card preview on the right, Save draft / Publish, Archive).
- Analytics "Video views" table: show a small "Free video" tag for `kind === 'free_video'`.

## Web — public `[SAATHUM-FREEVIDEOS-WEB-1]`
- `FreeVideoCard` + `FreeVideosRow` island (home page + marketplace, own row titled
  "Free videos", "See all free videos →" → `/free-videos`), hidden when there are none.
- `/free-videos` page: grid of all published cards with category filter chips.
- `/watch/[id].astro` SSR (fetch `GET /api/free-videos/:id`; 404 page if missing) + island
  `FreeVideoWatch`: cover with "Click to watch free" overlay (signed out → sign-in URL with
  marker; signed in → player), player = `YouTubeGuardedPlayer` with `crop` + `autoPlay`,
  "Watch free" button → "Watching now" while playing, WhatsApp share, "More free videos".
  Uses `ClerkSessionBridge` (lazy) — never its own ClerkIsland. On first Play:
  `postFreeVideoView` once + PostHog `saathum_video_play {listing_id, free:true, surface:'free_video_page'}`.
- `authRedirect.isFreeWatchTarget` must also accept `/watch/<id>?freewatch=1`.
- SEO: title/description meta, OG image = cover. Add `/free-videos` and `/watch/<id>` to the
  pages sitemap if a simple hook exists (optional).
