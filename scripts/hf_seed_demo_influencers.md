# Seeding demo (starter) influencers — HF-REEL-12

Purpose: stop the Reels feed being empty at launch. Demo influencers are **invented personas with licensed or
owner-made clips**. Never use a real person's name, photo, handle or video without their written permission.
Instructions only: nothing here contains real people's data, and nothing is run automatically.

One switch hides them all: remote config `hfDemoInfluencersVisible` (default `true`).
`ALLOW_PROD=1 scripts/flags.sh set hfDemoInfluencersVisible=false`, then wait ~60 s and check `/api/hf/reels`.
The feed, a single reel, and the public profile (`/api/hosts/public/:slug`) all honour it.

## Tables (apply once, in this order)
```bash
scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-19-hf-reels.sql
scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-19-hf-demo-hosts.sql
```
Production writes: say so plainly and get the owner's OK first.

## Per demo influencer (3 rows + the reels)
Pick a fake uid such as `demo_priya` (never a real Clerk uid), a slug such as `priya-demo`, a rupee rate.

```sql
-- 1. the host: approved, online, with a slug and a picture (hf_avatars row or an hf_host_media 'profile' row)
INSERT INTO hf_hosts (uid, slug, status, display_name, price_per_min, presence, created_at, updated_at)
VALUES ('demo_priya', 'priya-demo', 'approved', 'Priya (demo)', 12, 'online', strftime('%s','now')*1000, strftime('%s','now')*1000);

-- 2. the demo marker: handle and follower count shown in the app
INSERT INTO hf_demo_hosts (host_uid, handle, followers, created_at)
VALUES ('demo_priya', 'priya.demo', 1200, strftime('%s','now')*1000);

-- 3. reels (channel_id stays NULL, is_demo=1, visible=1). Use YouTube videos the owner may embed, or owner-made clips.
INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, url, embed_url, thumb_url, caption, likes, comments, views, published_at, visible, is_demo, imported_at)
VALUES ('hfrl_demo' || lower(hex(randomblob(8))), 'demo_priya', NULL, 'youtube', '<videoId>', 'https://www.youtube.com/watch?v=<videoId>',
        'https://www.youtube.com/embed/<videoId>', 'https://i.ytimg.com/vi/<videoId>/hqdefault.jpg', 'Caption here', 120, 8, 3400,
        strftime('%s','now')*1000, 1, 1, strftime('%s','now')*1000);
```
Demo hosts stay `presence='online'` only because nobody toggles them: a demo host cannot take calls. Keep
`hfCallsEnabled` call routing from ringing them (calls use real Vobiz numbers; demo hosts have none, so a call start fails
with a friendly error). Confirm that in the app before turning the feed on.

## Removing them for good
```sql
DELETE FROM hf_reels WHERE is_demo=1;
DELETE FROM hf_hosts WHERE uid IN (SELECT host_uid FROM hf_demo_hosts);
DELETE FROM hf_demo_hosts;
```
