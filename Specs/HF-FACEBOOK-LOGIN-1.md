# HF-FACEBOOK-LOGIN-1 — "Log in with Facebook" for Social media verification, and the public verifiedSocials list

Lane W3 of `Specs/HF-INTRO-VIDEO-1.md` (D3, D14, D15). Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` §20 (HF-INTRO-3, 14, 17).
Built like the Instagram login (`Specs/HF-CHANNEL-LOGIN-1.md`). Status: **code complete, flag `hfFacebookLoginEnabled` OFF** until Meta approves the app.

## 1. What was built

**Design choice: the Facebook Page.** A personal Facebook profile link needs the `user_link` permission, which Meta rarely grants. A Page has a public link and a follower count, and every influencer can have one for free. So the person logs in, we read the Pages she manages, and we use the one with the most followers. If she has no Page she is told to create one (`reason=no_page`).

Permissions asked: `public_profile` (always allowed), `pages_show_list`, `pages_read_engagement` (Page name, link, followers). We only read. We never post.

**No token is stored.** The login token is used once inside the callback and dropped. So there is nothing to refresh and nothing to leak. Because of that, followers are read at login time only; to refresh them she logs in again. The daily sync skips these channels. A small table `hf_fb_logins` (channel id to Facebook user id) exists only so Meta's deauthorize / data-deletion calls can find the channel.

### Routes (`worker/src/routes/hf_facebook.ts`, mounted before `/api/hf/channels` in `index.ts`)
| Route | What |
|---|---|
| `GET /api/hf/channels/facebook/start?client=app\|web` | Signed in. Returns `{ok, url}` (the Facebook dialog). State is HMAC-signed (10 min) plus a one-time nonce in KV. 404 `not_enabled` when the flag is off; 503 `provider_not_configured` if the secret or app id is missing. |
| `GET .../callback?code&state` | A browser redirect, no bearer. Exchanges the code, reads Pages, saves the channel (`platform 'facebook'`, `provider_ref 'facebook-oauth'`, verified, public Page link as `url`), then 302 to the app `<scheme>://channels?fb=connected&result=<approved\|needs_followers>` or `?fb=error&reason=...`; web goes to `<web origin>/dashboard/become?fb=...`. Reasons: `cancelled`, `no_page`, `claimed`, `limit_reached`, `bad_state`, `not_enabled`, `not_configured`, `provider_error`. |
| `POST .../deauthorize` | Meta calls it when a person removes the app. Verified with the app secret. Disconnects that person's channels. Always answered, even with the flag off. |
| `POST .../data-deletion` | Same, answers `{url, confirmation_code}`; the url is `<web origin>/data-deletion?code=...`. |
| `GET .../data-deletion-status?code=` | Public status for that page (shares the table `hf_ig_deletion_requests`; codes start `hffbdel_`). |

With the flag off, `POST /api/hf/channels {platform:'facebook'}` still says "Facebook is coming soon." With it on, that route says to use Log in with Facebook (there is no bio-code route for Facebook).

The acceptance rule is the same as every channel (`thresholdResult`): followers >= `hfInfluencerMinFollowers`. Remove channel, deauthorize and data deletion all forget the mapping; account deletion purges `hf_fb_logins` (both purge copies updated).

### Verified socials (public)
`verifiedSocialsFor(env, uid)` and `verifiedSocialsForMany(env, uids)` in `worker/src/lib/hf_public_channels.ts` (pure shaper: `shapeVerifiedSocials`). Shape:

```
verifiedSocials: [{ platform: 'youtube'|'instagram'|'facebook', handle, url, followers? }]
```
Only approved channels whose `provider_ref` is `youtube-oauth`, `instagram-oauth` or `facebook-oauth` (proven by login; a bio-code or treg check never counts). Order: YouTube, Instagram, Facebook. `followers` appears only when known (> 0). `url` is always https. Never throws (empty list on error).
It is returned as `verifiedSocials` on the single public host profile (the one-host response of `routes/hf_hosts_public.ts`). The list endpoints are unchanged on purpose (a test requires the two list endpoints to have identical cards); the reels feed (lane W1) should call `verifiedSocialsForMany` once for the whole page.

### Words
User-facing worker messages now say "social media verification" instead of "channel" (channel check messages, remove/not-found, admin go-live message). Identifiers, routes and table names are unchanged.

### Config and secrets
- Flag `hfFacebookLoginEnabled` (default false) and string `hfFacebookAppId` (default empty, in `stringKeys`) are in the `PlatformConfig` interface and `DEFAULTS` of `routes/config.ts`.
- Secret `FACEBOOK_APP_SECRET` is read from KV like `INSTAGRAM_APP_SECRET` (no wrangler var; the worker is at the 128-binding limit).
- Migration `worker/migrations/2026-10-28-hf-facebook-login.sql` (CREATE only, coordinator applies).
- Telemetry: `hf_channel_oauth_start|done|fail` with `platform: 'facebook'`, plus the usual `hf_channel_added` / `hf_channel_threshold`, `hf_fb_deauthorize`, `hf_fb_data_deletion`. Ship manifest entry `HF-INTRO-W3`.

## 2. Why the Instagram app cannot be reused
The Instagram login uses the "Instagram API with Instagram login" product, whose app id and secret are special to that product (the Instagram app secret is `INSTAGRAM_APP_SECRET`). Facebook Login needs the **main Meta app id and main app secret** of the same Meta app (App settings, Basic). It is the same Meta app, but a different id and secret pair. So one new secret (`FACEBOOK_APP_SECRET`) and one config string (`hfFacebookAppId`).

## 3. What the owner does in Meta (simple English)
1. Open Meta for Developers and the existing Hello Fraands app (the same one used for Instagram). No new app needed.
2. **Add the product "Facebook Login"** (or "Facebook Login for Business" works too, pick the normal Facebook Login) and choose the Web setup.
3. In Facebook Login, Settings, add this to **Valid OAuth Redirect URIs**: `https://api.<brand domain>/api/hf/channels/facebook/callback` (that is `BRAND.apiOrigin` plus the path; today `https://api.hellofraands.com/api/hf/channels/facebook/callback`). Keep "Use Strict Mode for redirect URIs" on.
4. In App settings, Basic, fill: Privacy Policy URL and Terms URL (our pages), app icon, category.
5. Set **Deauthorize Callback URL** to `https://api.<brand domain>/api/hf/channels/facebook/deauthorize`.
6. Set **Data Deletion Request URL** to `https://api.<brand domain>/api/hf/channels/facebook/data-deletion` (Meta wants a callback URL, not an email).
7. In App settings, Basic, copy **App ID** and **App Secret**. Give both to the coordinator: the App ID goes into the config string `hfFacebookAppId`; the App Secret goes into KV as `secret:FACEBOOK_APP_SECRET` (never in code or wrangler.toml).
8. **App Review** (Meta takes about 1 to 2 weeks): request Advanced access for `pages_show_list` and `pages_read_engagement` (`public_profile` needs no review). Meta asks for: a short screen recording of the login and of the Page being shown as "verified owner of"; a one-line reason ("so an influencer can prove she owns her public Facebook Page; we only read the Page name, link and follower count"); and test login details. Complete **Business Verification** (same as for Instagram; the legal company that owns the app).
9. Until review passes, only people added to the Meta app as Admin / Developer / Tester can log in. That is enough for a first live test with the owner's own Page.
10. Flip the flag `hfFacebookLoginEnabled` to true only after: the migration is applied, the secret and app id are set, and review has passed (or for testers only).

If Meta later grants `user_link`, a personal-profile option can be added; it is not needed for launch.

## 4. Not built / notes
- No Facebook comment or reel import (not requested).
- Graph API version is pinned in `lib/hf_facebook.ts` (`FB_GRAPH_VERSION`, v21.0). Raise it when Meta retires it.
- The app and web buttons ("Log in with Facebook" under Social media verification) are other lanes; they call `start`, open the returned url, and handle the `fb=` return parameters.
