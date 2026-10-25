# HF-EXPLORE-PUBLIC-1 — public reels Explore page, /r/<id> share page, vertical share image, app reel/profile changes

Owner-approved design (2026-10-25, canvas "HF Explore — Public Reels"). Owner asked to code and deploy (web + Play).

## A. Website (web/ + worker/)  — issue id HF-EXPLORE-PUBLIC-1

1. **/explore = public reels** (was a 301 to /marketplace). Like the Instagram web reel page: ONE vertical 9:16 video in the
   centre at full viewport height, any screen size. Mouse wheel / trackpad / arrow keys-free buttons (up/down arrows at far
   right) / touch swipe move to the next/previous reel. Dark theme: page #0E0A12, dark header #160F1B (logo left, Log in /
   Sign up right when logged out; search + wallet/avatar when logged in). **No footer.** On phones (<= 640px): **no header,
   no footer** — only the full-bleed video.
   - Over the video, bottom: ONLY the full-width marigold "Call <influencer>" button (56px tall, ink #2B1530 text, phone
     glyph). **No name, handle or caption above it.**
   - Rail to the right of the video (desktop) / over the right edge (phone): Like (+count), Comment (+count), Save, Share,
     then the influencer's round photo (marigold ring) UNDER Share. No info (i) icon.
   - Call button and the round photo both go to the influencer's profile page: network host -> /h/<slug>;
     creator not on Hello Fraands (invite reel, id hfiv_…) -> new public page /i/<platform>/<handle> (see 4).
   - Logged out: watching and scrolling are free. Like / Comment / Save open a centred sign-in card (dark #1B1321, creator
     photo, title e.g. "Loved this reel?", one line, two buttons ONLY: "Continue with WhatsApp" (marigold) and
     "Continue with Google" (white); small line "New or returning — the same button signs you in."). Close (X) returns to the
     same reel. Both buttons go to /sign-in (WhatsApp) / Google OAuth with a return to /r/<current id>.
   - Logged in (desktop): Like toggles via POST/DELETE /api/hf/reels/:id/like; Comment opens a right-hand comments panel
     (GET/POST /api/hf/reels/:id/comments); Save uses the existing reel bookmarks API. Phone: comments open as a bottom sheet.
   - Share: Web Share API on phones, copy link on desktop; link = brandUrl('/r/<id>').
   - Mute toggle top-right of the video; thin marigold progress line optional.
   - YouTube / Instagram controls, titles and chrome must be hidden, as in the app (crop/scale the official embed, block
     pointer events on the iframe; our own tap layer toggles play/pause). Never link out to YouTube/Instagram (HF-WEB-NOOUT-1).
   - Data: SSR first page from GET /api/hf/reels (public feed, includes invite reels); more pages via nextCursor in the browser.
   - Fonts: Nunito headlines, Comfortaa elsewhere (owner rule). No green. Touch targets >= 44px.
   - PostHog: explore_reel_view, explore_reel_swipe, explore_signin_prompt {action}, explore_call_tap, explore_share.
2. **/r/<id>** (SSR): the same Explore page opened on that reel first (GET /api/hf/reels/:id), the feed continues after it.
   Unknown/hidden id -> Explore from the top (200, noindex). Head tags: og:title "<Creator> on Hello Fraands",
   og:description = the reel's own caption (trimmed), og:url, og:type video.other, **og:image = vertical 720x1280 PNG**
   (see 3) with og:image:width/height, twitter:card summary_large_image. All brand text from lib/brand (never typed).
3. **Share image** per reel: 720x1280 PNG, the reel's thumbnail full-bleed (object-fit cover), a soft dark gradient at the
   bottom and the marigold "Call <Creator name>" pill (40px from sides, 56px from bottom, 112px tall, 40px heavy text).
   No icons, no other text. Served through the existing OG pipeline (web/src/pages/og/[kind]/[...key].png.ts) as a new kind
   `reel`, cached like the others.
4. **/i/<platform>/<handle>** (SSR) — public page for a creator NOT on Hello Fraands (web version of the app's
   InviteProfileScreen): photo, name, @handle · platform, status chip "Vote to invite", followers / videos / votes, big
   marigold "VOTE TO INVITE" button (POST /api/hf/invites/:platform/:handle/vote; logged out -> same sign-in card), the
   creator's videos as a grid (tap = play in place, no link out). Needs a new public worker route
   GET /api/hf/invites/:platform/:handle -> { ok, creator:{platform,handle,name,avatar,followers,votes,joinedSlug?}, reels:[…] }
   (if the creator has since joined, answer joinedSlug so the page redirects to /h/<slug>).
5. Site nav: the "Explore" link points to /explore (reels). The old marketplace stays at /marketplace.

## B. Website sign-in — issue id HF-AUTH-GOOGLE-BACK-1
Owner 2026-10-25 reverses part of HF-AUTH-WA-ONLY-1: "Continue with Google" comes back on /sign-in and /sign-up (and the
Explore sign-in card). WhatsApp code stays. A Google sign-in still goes through the WhatsApp gate (finishUrl) before
liking/commenting/calling, because those need a verified WhatsApp number. Rulebook HF-KYC-6 + change log updated.

## C. App (hf-flutter/) — issue id HF-REEL-CALL-2
1. Reel screen: remove the info (i) icon from the rail; put the influencer's round photo in the rail right under Share; the
   bottom bar is only "Call <influencer>" — no name / handle / caption / "Not on Hello Fraands yet" above it. Every reel
   says Call (never Invite), network or not. Call bar and photo open the profile: network -> host profile; invite creator ->
   InviteProfileScreen.
2. InviteProfileScreen: status chip "Vote to invite" (not "Not on Hello Fraands yet"), button "VOTE TO INVITE" (VOTED after),
   helper "<Name> isn't on Hello Fraands yet. Your vote tells us to invite them." Network host profile keeps Call / Book.
3. Tapping a video on a profile: a light preview — the video plays with only a close X and mute. No Invite/Call bar, no
   info sheet, no rail.
4. Deep link /r/<id>: open a single-reel player with THAT reel as item 0, its poster shown at once; the normal feed loads
   behind it; nothing else plays first (fixes "another video plays, then it jumps").
5. Share text = this reel's own caption (bug: a different reel's caption was sent) + brandUrl('/r/<id>').
