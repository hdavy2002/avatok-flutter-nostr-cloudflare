# HF-INTRO-VIDEO-1 — Influencer intro video (onboarding + Reels feed)

Owner decision 2026-10-26. Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` §20 (HF-INTRO-1…10). Status: **PLANNED**, not built.

## 1. Why

The feed used to play influencers' YouTube / Instagram reels as embeds. Their controls and branding do not
represent us, and a random reel does not tell a fan what a call is for. Instead every influencer makes one
short video for us saying what fans can talk to them about and how the fan benefits. It is honest (the person
on the call is the person in the video), it keeps the feed about topics rather than looks, and it costs ~₹1.

## 2. Onboarding flow

```
fan account
  → link channel (HF-SPACE-1: 20 followers / 1,000 YouTube views)   [space creators: video KYC instead]
  → INTRO VIDEO  (record or upload → automatic check → pass / fail / borderline)
  → set rate
  → submit → existing admin approval → influencer
```

- No passed intro video → the account stays a fan. Never upgraded (HF-INTRO-1).
- The check runs only after the channel check passed (no spend on non-creators).
- Progress is saved per step; the person can leave at any step and resume (HF-INTRO-6).
- Next day, if the video is still missing: one WhatsApp nudge (8 am–11 pm window), from the HF WhatsApp session.

## 3. The video

- 30–60 s, vertical 9:16, own face + own voice. Record in app/browser (preferred) or upload a file.
- Example script on screen (Hindi + English), e.g. astrologer:
  "Namaste, I'm Pandit Rohan, 12 years reading kundlis. Call me about marriage timing, career change, or a bad
  phase. On the call I'll look at your birth chart live and tell you what to do next. I'm online most evenings."
- Uploads: tick "I own this video and the music in it"; other platforms' watermarks are refused.
- Compress on the device before upload (target 720×1280, ~1.5–2 Mbps, ≤ ~15 MB for 60 s). No server ffmpeg.

## 4. Automatic check (Gemini, video input)

One call per video returns JSON: `{ verdict: pass|fail|borderline, reasons: [{code, at_s, text}], transcript, topics[], lang }`.

| Check | Fail reason shown (plain words) |
|---|---|
| Face in first 3 s | "We couldn't see your face in the first 3 seconds." |
| Phone / handle / UPI / "DM me" (speech or on screen) | "Remove your Instagram handle at 0:12." |
| Sexual or flirty pitch (HF-CON-1) | "This video talks about things we don't allow on calls." |
| Guaranteed results / cures | "Please don't promise guaranteed results (0:34)." |
| Other platform watermark | "Please upload a video without the Instagram / TikTok logo." |
| Too short / too long / not vertical | "Your video should be 30–60 seconds and filmed upright." |

- `pass` → live automatically. `fail` → reasons + **Re-record**. `borderline` → admin queue (approve / reject with a reason).
- A missing model answer is never a pass (lesson from listing review — verdict, not vibes).
- Transcript → captions on the reel, and suggested topics for the profile.
- Cost: under ₹1 per video.

## 5. Replacing a video (HF-INTRO-7)

New upload = new draft row, checked the same way. The live video stays until the draft passes, then swaps
atomically. Old file kept 30 days, then deleted.

## 6. Storage and playback (HF-INTRO-10)

- Cloudflare **R2**: `intro/<userId>/<videoId>.mp4` + `poster.jpg`. Served from the CDN with long cache headers.
  No Cloudflare Stream (its per-minute delivery fee is ~₹78k/month at 6 M plays; R2 egress is free).
- Feed (app + web /explore) plays only passed intro videos of approved influencers. Poster first; play when on
  screen; warm the next one (HF-REEL-49 pattern, now with our own file so it can be cached on the phone).
- Profile keeps channel stats (followers, views) as proof. **Open:** do profiles still show the channel's
  embedded videos tab (HF-SPACE-6)? Default: yes, on the profile only, not in the feed.
- Invite reels of creators not on the network (HF-REEL-40) leave the feed. **Open:** where does Invite live —
  search only (default) or a separate card type?

## 7. Existing and demo influencers (HF-INTRO-8, HF-INTRO-9)

- Existing influencers: dashboard banner + WhatsApp asking for the video; after the deadline (owner to set),
  hidden from the feed and treated as fan until a video passes. Bookings already made still ring.
- Demo influencers (is_demo): admin uploads an intro video per demo account in the admin demo screen.

## 8. Data (sketch)

`hf_intro_videos(id, user_id, status[draft|checking|pass|fail|borderline|live|replaced], r2_key, poster_key,
duration_s, source[recorded|uploaded], owns_rights_at, verdict_json, transcript, created_at, live_at)`;
`users`/host row gets `intro_video_id` (the live one) and an onboarding step marker.

## 9. Switches

- `hfIntroVideoRequired` (default false) — makes the step required for new upgrades.
- `hfIntroVideoFeedEnabled` (default false) — feed plays intro videos instead of embeds.
- `hfIntroExistingDeadline` (date, unset) — when existing influencers without a video are hidden.
All declared in `config.ts` DEFAULTS (no fake flags).

## 10. Telemetry (PostHog, every surface)

`hf_intro_step_view`, `hf_intro_record_start`, `hf_intro_upload` (source, duration_s, bytes),
`hf_intro_check` (verdict, reason codes, ms), `hf_intro_rerecord`, `hf_intro_nudge_sent`, `hf_intro_live`,
`hf_reel_start` (existing; add `source=intro`). Include email + clerk_uid. Success = `hf_intro_check verdict=pass`
and `hf_intro_live` for real accounts; feed `hf_reel_start` p50 under 500 ms.

## 11. Open questions for the owner

1. Deadline for existing influencers (HF-INTRO-8).
2. Channel videos tab on profiles: keep or drop?
3. Where Invite (vote) lives once invite reels leave the feed.
4. Min / max length: 30–60 s OK?
