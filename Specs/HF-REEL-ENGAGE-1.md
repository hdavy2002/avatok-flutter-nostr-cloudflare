# HF-REEL-ENGAGE-1 — Likes and comments on every reel (plan + contract)

Owner request 2026-10-24. Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` HF-REEL-53 … HF-REEL-57.
Issue ids: `HF-REEL-ENGAGE-1` (this plan), `HF-REEL-ENGAGE-API-1` (worker), `HF-REEL-ENGAGE-APP-1` (app).

## 1. What the owner wants (plain words)
- Every reel shows how many likes and how many comments it has.
- A **Like** button (heart). A **Comment** button (speech bubble). Tapping Comment slides a sheet up from the
  bottom: the comments list, and a box at the bottom with **Send**. A sent comment appears in the list at once.
- Counts = what YouTube / Instagram say **plus** what our users add. We pull YouTube / Instagram again and again so
  the numbers keep growing. **Nothing is ever sent back** to YouTube or Instagram.

## 2. Owner decisions (2026-10-24)
| Q | Answer |
|---|---|
| Heart icon | Heart = **Like** (pink when liked) with the count under it. **Save** moves to a bookmark icon. |
| Instagram | Counts now (likes + comments numbers), our own comments now. Instagram comment **text** later, only when the creator connects with Instagram login. No scraping of comment text. |
| Who can like / comment | **Signed-in users only.** A guest tapping Like or Send gets the normal WhatsApp sign-up sheet, then the action finishes. |

## 3. Numbers on the reel
- `likes.total = likes.platform + likes.ours`; same for comments.
- The button shows the total (compact: 1.2K, 3.4M).
- The comment sheet header shows the breakdown: **"2,000 likes · 1,500 on YouTube · 500 on Hello Fraands"** (brand
  name from `Brand.name`, platform name from the reel). Our number is never presented as a YouTube / Instagram number.
- Platform numbers come from the existing import (`hf_reels.likes/comments`, `hf_invite_reels.likes/comments`), which
  the cron already refreshes; this work makes sure the refresh runs at least every 7 days for every visible reel.

## 4. Backend — `HF-REEL-ENGAGE-API-1`
Flag **`hfReelEngageEnabled`** (default `false`) in `config.ts` DEFAULTS + PlatformConfig. Off → routes 404
`not_enabled` and the feed omits the new fields. **`hfReelCommentHideAt`** (number, default 3, `numericKeys`) =
reports from different users that hide a comment. **`hfReelCommentMaxLen`** (number, default 500).

### 4.1 Tables (own CREATE migration `worker/migrations/2026-10-24-hf-reel-engage.sql`, DB_META)
- `hf_reel_likes (reel_id TEXT, uid TEXT, created_at INTEGER, PRIMARY KEY (reel_id, uid))`
- `hf_reel_comments (id TEXT PK 'hfrc_<20hex>', reel_id TEXT, uid TEXT, parent_id TEXT NULL, body TEXT, status TEXT
  'visible'|'hidden'|'deleted', reports INTEGER DEFAULT 0, created_at INTEGER)` + index `(reel_id, status, created_at)`
- `hf_reel_comment_reports (comment_id TEXT, uid TEXT, reason TEXT, created_at INTEGER, PRIMARY KEY (comment_id, uid))`
- `hf_reel_counts (reel_id TEXT PK, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, updated_at INTEGER)` —
  our side only, kept in step inside the same `batch()` as the like / comment write.
- `hf_reel_ext_comments (id TEXT PK '<platform>:<platform comment id>', reel_id TEXT, platform TEXT, author_name TEXT,
  author_avatar TEXT, author_url TEXT, body TEXT, like_count INTEGER, published_at INTEGER, fetched_at INTEGER)` +
  index `(reel_id, published_at)`
- `reel_id` is either an `hfrl_…` (hf_reels) or an `hfiv_…` (hf_invite_reels) id. Every route checks the reel exists
  and is publicly visible (same `publicWhere` / unplayable rules as the feed).
- `purgeHfUser` deletes the user's likes, reports and comments and re-counts the touched reels.

### 4.2 Routes (in `worker/src/routes/hf_reels.ts` or a new `hf_reel_engage.ts` wired from the same index line)
| Method + path | Auth | Does |
|---|---|---|
| `POST /api/hf/reels/:id/like` | signed in | idempotent like → `{liked:true, likes:{platform,ours,total}}` |
| `DELETE /api/hf/reels/:id/like` | signed in | idempotent unlike → same shape, `liked:false` |
| `GET /api/hf/reels/:id/comments?cursor=` | public (uid optional) | `{counts:{likes,comments}, likedByMe, items:[…], nextCursor}` |
| `POST /api/hf/reels/:id/comments` `{body, parentId?}` | signed in | creates, returns the item; 422 `empty` / `too_long` / `not_allowed` |
| `DELETE /api/hf/reels/comments/:cid` | author or admin | status=deleted, count −1 |
| `POST /api/hf/reels/comments/:cid/report` `{reason}` | signed in | one per user; at `hfReelCommentHideAt` → hidden |

Comment item: `{id, source:'ours'|'youtube'|'instagram', author:{name, avatar, url?}, body, likeCount?, createdAt,
mine:boolean, parentId?, replies?:[…]}`. **Never** return uid or phone. Our author name = the user's display name
(first name + initial if no display name). Order: our newest first, then the platform's top comments; one list,
cursor-paged (20 a page). Replies one level deep, only on our side (a reply under a YouTube comment stays ours).

Feed + saved + profile items (flag on only; flag off = none of these keys) gain **new keys** — the old flat `likes` /
`comments` numbers keep their type (old app builds read them) and are set to the totals:
`likeCounts:{platform,ours,total}`, `commentCounts:{platform,ours,total}`, `likedByMe:boolean` (only when a bearer is
sent; absent for guests). With the flag on the feed is `private, no-store` (likedByMe is per user). The profile
(`/api/hosts/public/:slug`) reels carry the counts but no `likedByMe`.

**As built (API lane, 2026-10-24) — exact shapes the app matches:**
- Like / unlike: `{ok:true, liked:boolean, likes:{platform,ours,total}}`.
- Comments GET: `{ok:true, counts:{likes:{platform,ours,total}, comments:{platform,ours,total}}, likedByMe:boolean, items:[comment], nextCursor:string|null}`.
  Cursor is opaque (`o:…` our part, `x:N` imported part); pass it back as `?cursor=`.
- Comment: `{id, source:'ours'|'youtube'|'instagram', author:{name, avatar:string|null, url?:string}, body, likeCount? (imported only), createdAt (ms), mine:boolean, parentId?, replies?:[comment]}`.
  An unknown name or a phone-like name shows as "A fan".
- Comment POST `{body, parentId?}`: `{ok:true, item:comment, counts:{likes:{..}, comments:{..}}}`. Errors: 401 guest, 403 `not_verified`,
  404 `not_found` (reel not visible), 422 `empty` | `too_long` | `no_links` | `not_allowed` | `bad_parent`, 429 rate limited.
  `parentId` must be a top-level comment on the same reel (ours `hfrc_…` or imported `youtube:…`); a reply to a reply is `bad_parent`.
- Comment DELETE: `{ok:true}` (idempotent; 404 for anyone but the author or an admin). Report POST `{reason}`: `{ok:true, reported:true, hidden:boolean}`
  (works on ours and on imported `youtube:…` ids; imported ones are hidden for everyone after the same number of reports).
- Like / comment / report need a WhatsApp-verified account (403 `not_verified`); unlike and delete do not.

### 4.3 Pulling YouTube comments
- `commentThreads.list?part=snippet&videoId=<id>&order=relevance&maxResults=50&textFormat=plainText` with
  `YOUTUBE_API_KEY` (1 quota unit a call). Comments turned off → 403 `commentsDisabled` → store nothing, show none.
- Pull **on demand** when a sheet opens and `fetched_at` is older than 6 h (stale-while-revalidate via `ctx.waitUntil`),
  and from the daily cron for reels published in the last 7 days.
- Each refresh **replaces** that reel's set (delete then insert in one batch) so a comment deleted on YouTube
  disappears here. Cron also deletes any `hf_reel_ext_comments` row with `fetched_at` older than 30 days.
- Instagram: no comment-text pull in this issue (owner decision). The sheet says "Instagram comments are on
  Instagram" with the existing Open-in-Instagram page.

### 4.4 Safety
- Signed-in only (`requireUser`); WhatsApp-verified account (same check other HF write routes use).
- Body trimmed, 1…`hfReelCommentMaxLen` chars, no links (http/www → 422 `no_links`), the existing sexual-words
  backstop used by merch (`hf_merch_ai.ts`) → 422 `not_allowed`.
- Rate limit: 10 comments / 10 min and 60 likes / min per user (existing KV limiter pattern).
- Admin delete reuses `DELETE /api/hf/reels/comments/:cid` for `AGENT_ADMIN`-style admin check used by HF admin routes.

### 4.5 Telemetry (PostHog, `hooks.track`)
`hf_reel_like` {reel_id, on, platform}, `hf_reel_comment_sent` {reel_id, len, is_reply}, `hf_reel_comment_report`,
`hf_reel_ext_comments_fetch` {reel_id, platform, count, ms, ok, reason}. Failures → `hooks.trackException`.

### 4.6 Tests (vitest) — flag off 404; like idempotent + counts; unlike; comment create/delete/report-hide; guest 401;
too long / link 422; invisible reel 404; YouTube refresh replaces set; commentsDisabled stores none; feed totals = sum.

## 5. App — `HF-REEL-ENGAGE-APP-1` (`hf-flutter/`)
- Model: `FeedReel` reads the new `likes{}`/`comments{}`/`likedByMe` (falls back to the flat numbers).
- Repo: `ReelEngageRepo` — like / unlike, comments page, send, delete, report.
- Right column on the reel (`demo/screens/feed.dart`): add **Like** (heart, `C.rani` when liked, count under it)
  and **Comment** (`Icons.chat_bubble_outline_rounded`, count under it) above Save; Save becomes
  `Icons.bookmark_border_rounded` / `Icons.bookmark_rounded`. Counts 14 sp, white with a soft shadow. Same 58 px
  circles (HF-REEL-48/51). Like is optimistic (instant, rolled back with a toast on error).
- Comment sheet: `showModalBottomSheet(isScrollControlled, useRootNavigator)` + `DraggableScrollableSheet`
  (opens at 70 %, drag to 95 %), slides up from the bottom; the video pauses while the sheet is open
  (`_whileCovered`, same as the info sheet) and resumes after.
  - Header: "1,500 comments" + the breakdown line (§3) + close X.
  - List: avatar, name, small source chip ("YouTube" / "Instagram" in a plum chip; none for ours), time ago, text,
    Reply, ⋯ menu (Delete if mine, Report otherwise). Empty state: "No comments yet. Be the first."
  - Composer pinned at the bottom above the keyboard (`viewInsets`): rounded field "Add a comment…", **Send**
    button (rani pink, 48 px). Guest → `requireAccount(reason: 'to comment')` then send. Sent comment appears at
    the top at once (optimistic), count +1.
  - Instagram reel: a line "Instagram comments stay on Instagram" + "Open in Instagram" (existing page).
- Flag-off / old server → the two buttons are hidden (no fake numbers).
- Plain English, nothing under 14 sp, no green except Online (HF-REEL-45), Nunito/Comfortaa only.
- Telemetry: `Telemetry.event('hf_reel_action', {'action':'like'|'unlike'|'comments_open'|'comment_send'})`.
- Tests: widget test for the sheet (open, empty state, send adds a row, guest gate) + model parse test.
- CI: `gh workflow run hf-flutter.yml --ref issue/hf-reel-engage-app-1 -f mode=check` (no build to Play).

## 6. Order and go-live
1. Land this plan + rules (docs only).
2. API and app lanes in parallel, own worktrees.
3. Review → land both → apply migration to prod → deploy worker → flag `hfReelEngageEnabled=true` → app build
   (`mode=internal demo=false`) **only when the owner says** → test on the phone (like, comment, guest sign-up,
   YouTube comments appear, Instagram line shows).

## 7. Later (not in this issue)
Instagram comment text after Instagram-login connect; creator replies pinned; admin comments queue page; liking a
comment on our side; push / WhatsApp to the creator about new comments.
