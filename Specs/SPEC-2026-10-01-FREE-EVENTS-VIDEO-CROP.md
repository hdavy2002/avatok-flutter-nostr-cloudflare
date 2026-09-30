# SPEC 2026-10-01 — Free events + YouTube crop + view counts

Owner decisions (2026-10-01, in chat):

1. **Free events.** An admin can mark an event FREE. A free event's YouTube video can be
   watched by anyone **signed in with an email** — no payment, no booking, **no WhatsApp
   verification** (WhatsApp stays required for PAID events only). Examples: meditation,
   satsang.
2. **Crop.** In the event form the admin pastes the YouTube link, sees the video, and
   draws a box over it. Every player then shows ONLY that box. Mockup approved:
   "YouTube Crop Tool" design canvas (admin board + public phone board).
3. **YouTube only for now.** No Cloudflare Stream / R2 video in this build.
4. **Hide the source from casual users.** The video id is never in page HTML; it only
   comes from the entitled `GET /api/saathum/watch/:id` after sign-in. (Owner knows a
   tech-savvy user can still find it in DevTools.)
5. **View counts.** Track who watched with PostHog AND show it on the admin Analytics page.

Decision made by Claude (owner can overrule): a FREE event stays watchable after it ends
(replay on its event page); a PAID event keeps today's rule (no player once ended).

## Shared foundation (landed first, `[SAATHUM-FREEVID-BASE-1]`)

- `web/src/components/dash2/crop.ts` — `VideoCrop {x,y,w,h}` fractions of the 16:9 frame,
  `isValidCrop`, `toCrop`, `isFullFrame`, `cropAspect`, `cropInnerStyle`.
- `worker/src/lib/video_crop.ts` — same rules server-side + `cropFromRow(row)`.
- `YouTubeGuardedPlayer` takes `crop?: VideoCrop | null`. With a crop the frame's
  aspect-ratio becomes the crop's (inline style, and CSS var `--d2-crop-ar`) and gets class
  `d2-player-frame--cropped`; the iframe host + poster are scaled/shifted inside.
- Migrations (NOT applied — owner confirms prod writes):
  - `worker/migrations/2026-10-01-freevid-alters.sql` → `listings.free_watch INTEGER NOT NULL DEFAULT 0`,
    `event_videos.crop_x/crop_y/crop_w/crop_h REAL`.
  - `worker/migrations/2026-10-01-freevid-views.sql` → table `event_video_views
    (listing_id, uid, first_at, last_at, plays, PK(listing_id,uid))`.

## API contract

### Admin (worker/src/routes/admin2_events.ts)
- Event create/update body accepts `free_watch: boolean`. Event detail returns
  `event.free_watch: boolean`. When `free_watch` is true the price is not required
  (store price 0); publish blockers must not reject a free event for price.
- The existing YouTube save route (`PUT /api/admin/listings/:id/youtube`, used by
  `saveYoutube` in `web/src/islands/admin2/eventsApi.ts`) accepts
  `{ url, crop?: {x,y,w,h} | null }`. `crop` absent = leave crop unchanged;
  `null` = clear. Invalid crop → 400 `bad_crop`. Detail returns
  `youtube: { video_id, url, crop: VideoCrop | null } | null`.
- Admin events list rows carry `free_watch`.

### Public / viewer (worker/src/routes/saathum_checkout.ts)
- `GET /api/saathum/live-state/:id` (public) adds `free: boolean`. Still NEVER a video id.
  For a free event with a saved video whose state would be `ended`, state is reported as
  `ended` but add `replay: true`.
- `GET /api/saathum/watch/:id`:
  - free event → `requireUser` only (email sign-in). Skip `requireVerifiedWhatsApp` and
    the booking check. Playable when a video is saved and state is `live` OR `ended`.
  - paid event → unchanged.
  - Response adds `free: boolean`, `crop: VideoCrop | null`, `playable: boolean`.
- `POST /api/saathum/watch/:id/view` — same entitlement as the GET (free: signed in;
  paid: confirmed booking + WhatsApp; admin `?preview=1` allowed but NOT counted). Upserts
  `event_video_views` (plays+1, last_at). Emits PostHog `saathum_video_view`
  `{listing_id, free, first_view, email}` via the worker's existing `track()` helper.
  Rate-limit: ignore (return ok, don't increment) if the same uid+listing wrote < 60s ago.
- Checkout create for a `free_watch=1` listing → 409 `free_event`.
- `/api/me/events` youtube payload adds `crop`.
- Public listing payloads used by the homepage/marketplace cards and the event page SSR
  (`routes/listings.ts` and wherever `book/[id].astro` gets its listing) include `free_watch`.

### Admin analytics (worker/src/routes/admin2_analytics.ts)
Response adds
`video_views: { viewers: {cur, prev}, plays: {cur, prev}, by_event: [{listing_id, title, free, viewers, plays}] }`
— viewers = distinct uid with `first_at` in the window; plays = sum of plays for rows
with `last_at` in the window (approximation, documented); `by_event` top 20 by viewers
in the window.

## Web

- **Admin (`[SAATHUM-FREEVID-ADMIN-1]`)**: EventForm "Free event — anyone signed in can
  watch" switch (hides/disables the price field; sends `free_watch`). Crop editor under
  the YouTube link (`web/src/islands/admin2/VideoCropEditor.tsx`): shows the video frame,
  draw/move/resize box, shape presets (Free, 16:9, 4:3, 1:1, 9:16), Auto-trim black bars,
  Show full video, Reset, live preview using `YouTubeGuardedPlayer` with `crop`. Saved with
  the YouTube link. Analytics page gets a "Video views" section. Admin events list shows a
  FREE badge.
- **Public (`[SAATHUM-FREEVID-WEB-1]`)**: event page + cards say FREE instead of a price
  and "Watch free" instead of Book; free event: signed-out → "Sign in to watch free"
  (email sign-in, returns to the page); signed-in → player with crop (live or replay).
  All players pass `crop`. Pressing Play calls `POST /api/saathum/watch/:id/view` once per
  page load and captures PostHog `saathum_video_play` client-side.

## Telemetry
PostHog events: `saathum_video_view` (server, per recorded view), `saathum_video_play`
(client), `admin2_video_crop_saved` (client). All carry email via the existing
super-properties / track helper.
