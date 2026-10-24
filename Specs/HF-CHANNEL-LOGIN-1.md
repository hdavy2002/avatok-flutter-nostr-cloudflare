# HF-CHANNEL-LOGIN-1 — Influencers log in with Instagram / YouTube; comments and likes come in through the official APIs

Owner request 2026-10-24. Status: **PLAN — waiting for owner approval before any code.**
Rules: HF-REEL-58 … HF-REEL-61 (PLANNED) in `Specs/RULEBOOK-HELLO-FRAANDS.md`. Builds on `Specs/HF-REEL-ENGAGE-1.md`.

## 1. What the owner wants
- An influencer adding a channel logs in with that platform: Instagram account → Instagram login; YouTube channel → Google/YouTube login.
- Because she logged in, we may legally pull her posts' comments and likes and show them on our network.
- Imported comments carry **no** "YouTube" / "Instagram" tag. They read like any comment, so people converse naturally.

## 2. Owner decisions (2026-10-24)
| Question | Answer |
|---|---|
| Reels of creators NOT on Hello Fraands (invite reels) | **No imported comments.** Only our users' comments. (See §6 note: YouTube's official API does allow this for free — owner to confirm.) |
| Personal Instagram accounts (Meta only allows Business/Creator accounts to log in) | **Guide her to switch** (Instagram → Settings → Account type and tools → Switch to professional account → Creator; free, ~1 minute), then log in. Bio-code stays as a fallback for ownership only (no comments). |
| Influencers already on Instagram via bio code | **Ask them to reconnect**: they stay approved; a banner asks them to log in with Instagram. Until they do, their reels get no imported comments. |

## 3. Phases
### Phase 1 — no outside approvals needed (server + app, ~1 day)
1. App: remove the YouTube / Instagram chip from imported comments; author shown as a plain name (`@handle` for Instagram stays, as that is the person's name there).
2. Server: **stop all treg comment imports** (invite reels and bio-code channels). Imports only for reels whose channel was connected by login (§4, §5).
3. Already-stored treg Instagram comments: delete them, **except** ones our users replied to (the conversation stays). Default — owner can veto.
4. YouTube reels of logged-in channels keep the official import (already built: random 18–30 once + free 25-day re-check).
5. Rules HF-REEL-58…61 → ADOPTED; rulebook change log.

### Phase 2 — Instagram login (needs the Meta app, §7)
- **API:** Instagram API with Instagram Login (no Facebook Page needed). Scopes: `instagram_business_basic` (profile, media, `like_count`, `comments_count`) and `instagram_business_manage_comments` (read comments on her own media; we never post).
- **Flow (app + web):** "Log in with Instagram" → `https://www.instagram.com/oauth/authorize?client_id=…&redirect_uri=https://<brand domain>/oauth/instagram&scope=…&state=<signed nonce>` (in-app browser / Custom Tab) → our callback exchanges the code for a short-lived token → long-lived token (60 days) → `GET /me?fields=user_id,username,account_type,followers_count,media_count` → channel saved as owned (`provider_ref: "instagram-oauth"`) → deep link back to the app.
- **Token storage:** encrypted at rest (AES-GCM with a worker secret) in a new `hf_channel_tokens` table (channel_id PK, enc_token, expires_at, scopes, updated_at). Cron refreshes tokens older than 50 days (`refresh_access_token`). Never sent to any client, never logged.
- **Reels import:** `GET /<ig-user-id>/media?fields=id,shortcode,media_type,media_product_type,permalink,thumbnail_url,caption,like_count,comments_count,timestamp` replaces the treg reels import for logged-in channels (free). Counts refreshed by the daily sync.
- **Comments:** `GET /<media-id>/comments?fields=id,text,username,like_count,timestamp` — the same one-time seed (random 18–30) per reel, stored for good; free upkeep re-check like YouTube (deleted ones removed unless our users replied).
- **Disconnect / deauthorize / data deletion:** Meta's deauthorize + data-deletion callbacks and our own Remove button delete the token and that channel's imported comments (except ones with our replies, whose text is blanked to "Comment removed") and hide the reels.
- **Personal account:** `account_type` check → if Instagram refuses login for a personal account, show the switch guide (screenshots + steps) and a "Try again" button.
- **Existing bio-code Instagram channels:** dashboard + Channels banner "Log in with Instagram to bring your comments and likes".

### Phase 3 — YouTube login for everyone
- Already built (HF-WIRE-14: app sends a Google access token, `channels.list?mine=true`, scope `youtube.readonly`). Web connect exists too.
- Needed: Google consent screen **published + verified** for `youtube.readonly` (sensitive scope) — today it is in Testing, so only listed test users can connect. Bio-code YouTube channels (if any) get the same reconnect banner.
- Comments for logged-in YouTube channels: as built (official API, random 18–30 once, 25-day free re-check).

## 4. Data model (new, CREATE-only migration)
- `hf_channel_tokens` (above).
- `hf_channels.provider_ref` already records how ownership was proven (`youtube-oauth`, `instagram-oauth`, bio code). Comment imports run only when `provider_ref` ends in `-oauth`.
- Flags: `hfInstagramLoginEnabled` (default false), `hfImportCommentsOAuthOnly` (default true when Phase 1 ships).

## 5. Telemetry (PostHog)
`hf_channel_oauth_start` / `_done` / `_fail` {platform, reason, account_type}, `hf_ig_token_refresh` {ok}, existing `hf_reel_ext_comments_fetch` with `source: oauth`. Every event carries the influencer's email.

## 6. Notes / risks
- **Unlabelled comments:** fine for Instagram content shown with the creator's consent. YouTube's API policies ask apps to make clear when content comes from YouTube; the reel itself is YouTube's embedded player with its branding, which we rely on. Low risk; flagged.
- **Invite reels + YouTube:** the official YouTube API reads comments on any public video for free and legally. The owner chose "no imported comments" for invite reels when asked whether there was a legal free way — for YouTube there is. Owner to confirm: keep YouTube comments on invite reels (official), drop only Instagram (treg)?
- Meta App Review usually takes 1–2 weeks; until it passes, only accounts added as testers in the Meta app can log in.

## 7. Owner actions (Claude can drive the browser for most of these)
1. Meta for Developers: create app "Hello Fraands" (type Business) under the owner's Meta account; add product "Instagram" → "API setup with Instagram login"; set redirect URI; privacy policy + data deletion URLs (we host them).
2. Meta Business Verification (needs a registered business — AvaGlobal Inc, Delaware, is the likely candidate; the Indian company is not registered yet).
3. App Review for `instagram_business_basic` + `instagram_business_manage_comments` with a screencast (we record it on the phone).
4. Google Cloud (project `hello-fraands`): finish branding, publish the consent screen, submit `youtube.readonly` for verification.
