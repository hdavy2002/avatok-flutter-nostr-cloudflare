# HF-INTRO-VIDEO-1 — Backend API contract (lane W1)

Master plan: `Specs/HF-INTRO-VIDEO-1.md`. Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` section 20. The web and app lanes build from this file.
All endpoints are JSON unless stated. Errors are `{ ok:false, error:<code>, message:<plain English>, ...extra }`. Auth = the normal bearer (Clerk) used everywhere else.

## Flags (all default false, public in `/api/config`)

| Flag | Effect |
|---|---|
| `hfIntroOnboardingEnabled` | `/api/hf/onboarding/*`, `/api/admin/hf/intro-applications*`, and the extra fields on `GET /api/hf/me`. Off -> 404 `not_enabled`. |
| `hfIntroReelsEnabled` | `/api/hf/reels*` serves ONLY approved intro videos (old YouTube/Instagram embed feed + invite reels are off). Also needs `hfReelsEnabled` (the existing master switch) and, for likes/comments, `hfReelEngageEnabled`. |

(`hfCallOptionEnabled`, `hfFacebookLoginEnabled`, `hfQueueBreakSeconds` belong to lanes W2/W3.)

## Database (apply by hand, in this order; nothing is applied by the lane)

1. `worker/migrations/2026-10-28-hf-intro-video-alters.sql` — `hf_hosts.categories_json TEXT, call_option TEXT ('A'|'B', NULL = legacy), intro_video_id TEXT, intro_approved_at INTEGER`.
2. `worker/migrations/2026-10-28-hf-intro-video-tables.sql` — `hf_intro_videos`, `hf_influencer_applications` (CREATE only; `d1_apply_alters.py` skips CREATE, run with `cf.sh worker d1 execute`).

`hf_hosts.call_option` and `hf_hosts.categories_json` are written ONLY by admin approval (not at submit). Before approval a person has no `call_option`.

## 1. Onboarding (signed-in influencer)

### GET `/api/hf/onboarding/categories` (no sign-in)
```json
{ "ok": true,
  "categories": [ { "id": "astrology", "label": "Astrology", "sensitive": false }, "... 15 normal ...",
                  { "id": "listener", "label": "Listener", "sensitive": true }, { "id": "prayer", ... }, { "id": "virtual_friend", ... }, { "id": "women_to_women", "label": "Women-to-Women", "sensitive": true } ],
  "langs": ["hi","en","mr","bn","ta","te","gu","pa","kn","ml"],
  "callOptions": [ {"id":"A","label":"Bookings only"}, {"id":"B","label":"Bookings + live"} ],
  "video": { "minSeconds": 10, "maxSeconds": 20, "portraitOnly": true } }
```
Order is the display order (sensitive four always last, in that order; no LGBTQ+). Ids: `astrology teacher traveller cook fitness music beauty tech comedy spirituality career health_wellness language gaming other listener prayer virtual_friend women_to_women`.

### POST `/api/hf/onboarding/intro-video`
Raw body = the recorded video. Headers: `content-type: video/mp4` or `video/webm`; `x-duration-ms` (int, required); `x-video-width`, `x-video-height` (ints, required, width must be < height); optional `x-lang` (one of `langs`), `x-topic` (a category id or `general`).
Limits: 10 000–20 500 ms (500 ms recorder tolerance), body ≤ 25 MB, magic bytes must match the type. 10 uploads / hour.
Success `200`:
```json
{ "ok": true, "video": { "id": "hfin_<20hex>", "status": "draft", "videoUrl": "https://media…/intro-video/<uid>/<id>.mp4", "posterUrl": null,
                         "durationMs": 12000, "width": 720, "height": 1280, "lang": "hi", "topic": "astrology", "createdAt": 1790000000000 } }
```
A new upload replaces the caller's previous draft (the old file is deleted) — one intro per person.
Errors: `unsupported_type` 415, `too_large` 413, `empty_video` 400, `duration_required` 400, `size_required` 400, `too_short` 422, `too_long` 422, `not_portrait` 422, `invalid_field` 400 (`field`: lang|topic), `store_failed` 500.

### PUT `/api/hf/onboarding/intro-video/:id/poster`
Raw image body (`image/jpeg|png|webp`, ≤ 2 MB). Owner only, video must be `draft` or `rejected`. Returns `{ ok, video }` with `posterUrl`. Errors: `video_not_found` 404, `video_locked` 409, `unsupported_type`, `too_large`.

### GET `/api/hf/onboarding/me`
```json
{ "ok": true,
  "host": { "status": "draft", "displayName": "…", "about": "…", "ratePerMin": 20, "photoUrl": "…|null", "callOption": null, "introApprovedAt": null } ,
  "video": { …video shape… } ,
  "application": { "id": "hfia_…", "status": "submitted|approved|rejected", "categories": [ {"id","label"} ], "lang": "hi", "introVideoId": "hfin_…", "callOption": "A|B",
                   "submittedAt": 0, "reviewedAt": null, "rejectReasons": [ { "code": "video_dark", "text": "…" } ], "rejectNote": null },
  "requirements": { "whatsappVerified": true, "aadhaarDone": false, "aadhaarGender": "F|M|T|null", "hasVerifiedSocial": false, "aadhaarNeededWithoutSensitive": true },
  "socials": [ { "platform": "youtube", "handle": "x", "url": "https://…" } ] }
```
`host`, `video`, `application` are `null` when absent. Use `requirements` to decide whether to show the Aadhaar step (needed when `!hasVerifiedSocial` OR any sensitive category is picked; Women-to-Women needs `aadhaarGender == "F"`).

### POST `/api/hf/onboarding/submit`
Profile name / description / photo / rate are saved by the existing calls (`PUT /api/hosts/me`, `PUT /api/hosts/me/photo`) BEFORE this.
```json
{ "categories": ["astrology","prayer"], "lang": "hi", "intro_video_id": "hfin_…", "call_option": "A", "topic": "general" }
```
(`topic` optional.) Success: `{ "ok": true, "application": { …status "submitted"… }, "message": "Sent for approval. A person from our team will check your profile. Once approved you can receive calls." }`.
The account is NOT upgraded: nothing changes on `hf_hosts` until a person approves. A rejected person fixes things and calls submit again (same `rejected` video or a new draft) — a new application row is created.
Errors: `invalid_field` 400 (`field`: categories|lang|call_option|intro_video_id|topic), `video_not_found` 404, `video_not_available` 409, `already_submitted` 409, `incomplete` 422 (`missing`: any of `name description photo rate whatsapp`), `aadhaar_required` 409, `women_to_women_requires_female` 403.

## 2. Admin review (ADMIN_UIDS)

* `GET /api/admin/hf/intro-applications?status=submitted|approved|rejected` (default `submitted`, oldest first, max 100)
  `{ ok, items:[ { id, uid, status, name, categories:[{id,label}], lang, ratePerMin, callOption, submittedAt, reviewedAt, hasSocials, aadhaar:{status:"verified|none", female} } ], rejectReasons:[{code,text}] }`
* `GET /api/admin/hf/intro-applications/:id` ->
  `{ ok, application, host:{uid,status,name,description,ratePerMin,photoUrl,callOption}, video:{videoUrl,posterUrl,durationMs,…}, socials:[{platform,handle,url,followers}], aadhaar:{done,female,gender}, whatsappVerified, womenToWomen, calendar:{timezone,weekly:[{weekday,ranges:[{startMin,endMin}]}],exceptions,empty}|null, history:[application], rejectReasons }`
* `POST /api/admin/hf/intro-applications/:id/approve` -> `{ ok, status:"approved", notified, notifyReason }`. Makes the host live (status `live`, presence online if newly live), sets `categories_json`, `call_option`, `intro_video_id`, `intro_approved_at`, `women_lane=1` when Women-to-Women, assigns a slug, WhatsApps "you are live". Re-checks the rules (WhatsApp verified, name, rate, Aadhaar/gender). Errors: `bad_state` 409, `host_not_eligible` 409, `not_ready` 409 (`missing`), `aadhaar_required`, `women_to_women_requires_female`.
* `POST /api/admin/hf/intro-applications/:id/reject` `{ "reasons": ["video_dark","audio_unclear"], "note": "…" }` -> `{ ok, status:"rejected", notified, notifyReason }`. At least one reason; `other` needs a note. Reason codes + texts (single source `lib/hf_intro_video.ts` `REJECT_REASONS`): `face_unclear video_dark audio_unclear contact_shared unsuitable wrong_category description_fix rate_fix aadhaar_mismatch other`. The WhatsApp lists each reason's text, the note, and "fix this and send it again".

## 3. Reels feed (flag `hfIntroReelsEnabled`)

`GET /api/hf/reels?limit=&cursor=` -> `{ ok, items:[intro], nextCursor }` (cursor `"<intro_approved_at>_<hfin id>"`, newest approved first). Never cached (liveness changes by the second).
Included: approved intro videos whose host is `live|approved` with `intro_approved_at` set. Option **A** always. Option **B** only while Online (presence `online|busy` and `call_mode` not `offline|bookings_only`); B offline is omitted (still bookable from profile/search). Pre-existing influencers without an approved intro are omitted.
```json
{ "id": "hfin_<20hex>", "kind": "intro", "platform": "intro",
  "videoUrl": "https://media…/intro-video/…mp4", "posterUrl": "…|null", "durationMs": 12000, "width": 720, "height": 1280, "lang": "hi", "topic": "astrology",
  "host": { "slug": "…", "name": "…", "handle": "@user|null", "avatar": "…|null", "ratePaise": 2000, "presence": "online|busy|offline", "greenTick": true,
            "mode": "…", "callState": "…", "queue": {"open":true,"waiting":0}  /* last three only when hfCallModesEnabled */ },
  "categories": [ {"id":"astrology","label":"Astrology"} ], "description": "one line, <= 120 chars", "ratePaise": 2000,
  "callOption": "A|B", "callState": "appointments (A) | available | on_call | connecting | queue_only (B)", "queue": {…}, 
  "womenOnly": true, "greenTick": true,
  "socials": [ { "platform": "youtube|instagram|facebook", "handle": "x", "url": "https://…" } ],
  "shareUrl": "https://<brand>/r/<id>",
  "likes": 0, "comments": 0, "views": 0, "publishedAt": 1790000000000,
  "url": "<shareUrl>", "embedUrl": null, "thumbUrl": "<posterUrl>", "title": "<description>", "caption": "<description>" }
```
Button rule (clients): `callOption A` -> "Book a time"; `B` + `callState available` -> "Call now"; `B` + `on_call|connecting|queue_only` -> "Busy · Join queue / Book a time".
With `hfReelEngageEnabled` on, items also carry `likeCounts`, `commentCounts`, `likedByMe` and `likes`/`comments` become the totals.

* `GET /api/hf/reels/:id` (deep link / share link `/r/<id>`) returns `{ ok, item }` for an `hfin_` id even when a B host is offline (a shared link still plays). Old `hfrl_`/`hfiv_` ids return 404 while the flag is on.
* `POST /api/hf/reels/:id/view` counts a view. Likes / comments: the existing `POST|DELETE /api/hf/reels/:id/like`, `GET|POST /api/hf/reels/:id/comments` accept `hfin_` ids (comment on an intro reel imports nothing from YouTube/Instagram). Bookmarks (`/api/hf/reel-bookmarks`) accept `hfin_` ids.
* Profile reels (`GET /api/hosts/public/:slug` -> reels) return the host's approved intro video while the flag is on.

## 4. Existing influencers (D18)

`GET /api/hf/me` (flag `hfIntroOnboardingEnabled`) adds: `needsIntroVideo` (true = live/approved influencer with no approved intro and nothing waiting for review: show the dashboard banner), `introStatus` (`none|submitted|approved|rejected`), `callOption`, `introApprovedAt`, and for a rejected one `introRejectReasons` / `introRejectNote`. No bulk WhatsApp is sent by the backend.

## 5. Telemetry (PostHog, all carry `email` + `clerk_uid`)

`hf_intro_upload{ok,bytes,ms,reason?}`, `hf_intro_poster`, `hf_onb_categories{n,has_sensitive}`, `hf_onb_submitted{n_categories,has_sensitive,call_option,lang,has_socials,aadhaar}`, `hf_onb_submit_refused{reason}`, `hf_admin_review{decision,reasons,application_id,influencer_uid}` (emitted for the reviewer), `hf_review_whatsapp{decision,ok,reason}`. Client-side events (`hf_onb_step_view`, `hf_intro_record`, `hf_reel_start`, `hf_women_gate`, `hf_reel_share`, `hf_social_link_open`) are the web/app lanes' job.

## 6. Decisions made by lane W1 (flag to coordinator)

* Reel id is `hfin_<20 hex>` (the video id), not `intro:<id>`, so the existing id regexes (`[a-z0-9_]`) and the likes/comments tables work unchanged.
* Video is stored in the public media bucket (`BLOBS`, key `intro-video/<uid>/<id>.<ext>`, `immutable` 1-year cache) — admin plays the same public URL.
* Duration accepted: 10 000–20 500 ms (500 ms tolerance for recorders that stop late).
* Approval does not use the old `goLiveBlockers` / selfie / video-KYC checks (D5: no selfie in this flow); it re-checks WhatsApp verified, name, rate and the D4 Aadhaar rules.

---

# HF-INTRO-VIDEO-1 — API notes per lane

Master plan: `Specs/HF-INTRO-VIDEO-1.md`. Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` §20. Each lane appends its own section.

## W2 — call option, mainAction, women gate

Lane W2 (backend). Everything is dark: nothing changes until `hfCallOptionEnabled` / `hfWomenAadhaarOnlyEnabled` are on, except the queue break default (below).

### Flags (worker/src/routes/config.ts, both public, default false)

| Flag | Effect |
|---|---|
| `hfCallOptionEnabled` | Call option A/B semantics, `callOption` + `mainAction` in public JSON, `/api/hosts/me/call-option`. Sits on top of `hfCallModesEnabled`. |
| `hfWomenAadhaarOnlyEnabled` | A fan qualifies for the women-only channel with a verified Aadhaar showing Female. No selfie, no lane row. LGBTQ+ unchanged. |
| `hfQueueBreakSeconds` (numeric, existing) | Default changed 60 -> **120** (HF-INTRO-9). Independent of the two flags above. A value already written to KV still wins, so check `flags.sh get` before deploy. |

### Column contract with W1

`hf_hosts.call_option TEXT` ('A' bookings only, 'B' bookings + live, NULL legacy) is created by W1's migration. W2 never creates it and reads it defensively (a DB without it = every host legacy, no error). `lib/hf_call_option.ts` is the one reader/writer: `hostCallOption`, `setCallOption`, `liveBlockedByOption`, `mainActionFor`, `canBookFor`.

### Semantics (flag on)

| Host | Instant call (`POST /api/hf/calls`, queue dispatch) | Queue join | New bookings |
|---|---|---|---|
| A, any presence | refused | refused | allowed |
| B, Online and free | allowed | n/a (call instead) | allowed |
| B, Online on a call / connecting | refused (must queue) | allowed | allowed |
| B, Offline (or Bookings-only switch) | refused | refused | **allowed** (was: Offline = no bookings) |
| legacy (NULL) | today's rules | today's rules | Offline = none (today) |

A BOOKED call still rings in every state: `claimHost(..., {booked:true})` ignores presence and option (HF-INTRO-20). The instant claim is guarded atomically in SQL (`COALESCE(call_option,'B')<>'A'`) as well as in the routes, so a queue dispatch cannot slip through.

### Refusals

`POST /api/hf/calls` for an option-A host: `409 {error:'host_unavailable', message, reason:'bookings_only', canQueue:false, canBook:<hfBookingsEnabled>, queueWaiting:0}`.
`POST /api/hf/hosts/:slug/queue` for an option-A host: `409 {error:'queue_closed', reason:'bookings_only', canQueue:false, canBook:<hfBookingsEnabled>}`.
Option B offline: existing `reason:'offline'`, `canQueue:false`, but `canBook:true` (when bookings are on).
`CallRefusalReason` gained `'bookings_only'`.

### Public JSON added (only while `hfCallOptionEnabled` is on; rides on `hfCallModesEnabled`)

| Field | Where | Values |
|---|---|---|
| `callOption` | host card (`/api/hosts/public`, list, search, reels, favourites), `GET /api/hf/hosts/:slug`, `/api/hf/me` (own host) | `'A' | 'B' | null` (null = legacy) |
| `mainAction` | same places | `'call' | 'queue_or_book' | 'book' | 'none'` |

`mainAction` rules: A -> `book`. B available -> `call`. B on_call / connecting / queue_only -> `queue_or_book` (falls back to `book` when the queue is closed or paused). B offline or Bookings-only -> `book`. Legacy offline -> `none`. `book` becomes `none` when `hfBookingsEnabled` is off.
For an A host `callState` is reported as `'appointments'` and `queue.open` is false. `GET /api/hf/hosts/:slug` also returns `canQueue` / `canBook` computed with the option. The feed filter (hide B-offline, D16) is W1's; this lane only supplies the fields.

### Switch endpoint

`GET|PUT /api/hosts/me/call-option` (auth = the host, any `hf_hosts` row so onboarding can call it before approval; 404 `not_enabled` while the flag is off; 409 `not_host` for a non-influencer).
PUT `{option:'A'|'B', surface?:'web'|'app'|'onboarding'}` -> `{ok, callOption, changed}`. Switching to A closes a running queue exactly like going Offline (waiters told once, lock released). Telemetry `hf_host_call_option_changed{from,to,surface}`. 400 `invalid_field` for anything else, 503 `unavailable` if the column is missing.
W1 can call `setCallOption(env, uid, option)` from `lib/hf_call_option.ts` during onboarding submit.

### Queue break

`hfQueueBreakSeconds` default 120. The heads-up WhatsApp ("You're next for X. We'll call you in about 2 minutes") is sent when the break starts and its wording follows the configured value (`queueWaitPhrase` in `lib/hf_queue_messages.ts`: under 45 s "in a few seconds", else minutes rounded). WhatsApp pacing constants (one message per fan per 60 s) are unrelated and unchanged.

### Women-to-Women gate

With `hfWomenAadhaarOnlyEnabled` on:
- `getLaneAccess` (and so `hasLaneAccess`, lane lists, profile visibility): women = `hf_kyc.verified_at` set and `gender='F'`. The latest-selfie and `hf_lane_access` row are no longer needed for women.
- `callerKycBlocked` returns false for a women-lane host (its "video KYC for callers" rule is the lane rule now).
- Booking SQL `laneGuardSql(customer, host, lane, womenAadhaarOnly)`: the women clause is Aadhaar-F only and the `caller_level='video_kyc'` clause ignores women-lane hosts. Used at quote, confirm and the booked-call start.
- Enforced at call start (`POST /api/hf/calls` and queue dispatch), queue join, booking eligibility/quote/confirm.
- `403 {error:'lane_required', lane:'women', need:'aadhaar'}` when the fan has no verified Aadhaar; `need:'female_only'` when verified but not F. `need` is added only while the flag is on; flag off = the old body.
- LGBTQ+ lane and the Female-only `womenEligible` rule are unchanged.
