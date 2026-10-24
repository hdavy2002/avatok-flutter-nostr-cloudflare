# HF-CREATOR-SPACES-1 — two creator types, Women-only + LGBTQ+ channels (owner 2026-10-24)

Issue id: `[HF-CREATOR-SPACES-1]`. Supersedes HF-PLAN-1-as-replacement for lanes, revives the women-only and LGBTQ+
channels in a new form, and brings back the selfie video (HF-KYC-3) ONLY for space creators and their customers.

## Owner decisions
- Type A "Channel creator": has YouTube or Instagram. Needs >= 20 followers/subscribers AND >= 1,000 total views
  (YouTube). Instagram does not expose total views -> Instagram checked on followers only. No Aadhaar to go live.
- Type B "Space creator": no channel needed. Starts a **Women-only channel** or an **LGBTQ+ channel**.
  Needs WhatsApp OTP + Aadhaar OTP (DigiLocker fallback) + **video KYC** = 10-second selfie video reading the random
  code, admin compares face with Aadhaar photo (existing /api/hosts/kyc/selfie* + admin review).
  - Women-only: Aadhaar gender must be **F only** (not T).
  - LGBTQ+: Aadhaar gender T passes; otherwise private self-declaration + accept LGBTQ+ space terms. Creator also
    gives explicit consent that the "LGBTQ+ channel" tag is PUBLIC on the profile and in search/Google.
- Customers of a space channel: Call / Book / Queue / Notify are locked until **full video KYC** (WhatsApp + Aadhaar +
  latest selfie APPROVED; pending/rejected = locked). Women-only: customer Aadhaar must be **F**. LGBTQ+: video KYC +
  private self-declaration. Enforced on the server at call start, booking, queue join — never just hidden buttons.
- Profile (web + app): **green "Video KYC verified"** badge for anyone with Aadhaar verified + approved selfie
  (owner explicitly asked for green here — the ONLY green allowed on the site), plus a "Women-only channel" or
  "LGBTQ+ channel" tag.
- Search: space channels are visible to EVERYONE in site search, Explore and Google (sitemap/indexable); only eligible
  customers can call. New filters "Women-only" and "LGBTQ+" on Explore/search (web + app).

## API contract (worker) — web and app build against exactly this
Config (routes/config.ts DEFAULTS + PlatformConfig + numericKeys/validation):
- `hfInfluencerMinFollowers: 20` (was 10), new `hfInfluencerMinViews: 1000` (NUMERIC), new boolean kill switch
  `hfCreatorSpacesEnabled: true`.

Channels: `GET /api/hf/channels` and check routes: each channel gains `views:number`; responses gain `minViews`.
New CheckResult `needs_views` ("We need at least 1,000 total views on your YouTube channel.").

Spaces (new file worker/src/routes/hf_spaces.ts, mounted in index.ts):
- `GET /api/hf/spaces/me` (signed in) ->
  `{ ok, kind:'channel'|'women'|'lgbtq'|null, whatsappVerified, aadhaarVerified, gender:'F'|'M'|'T'|null,
     selfie:{ status:'none'|'pending'|'approved'|'rejected', reason:string|null }, lgbtqDeclared:boolean,
     videoKycVerified:boolean, qualified:boolean, hostStatus:string|null, minFollowers, minViews }`
- `POST /api/hf/spaces/creator { kind:'channel'|'women'|'lgbtq', declare?:true, acceptTerms?:true, publicTagConsent?:true }`
  -> `{ ok, kind }`. Records the creator type (hf_hosts.creator_kind; creates the host row 'pending_check' if none).
  women -> sets women_lane=1; lgbtq -> requires publicTagConsent (400 consent_required) and, unless Aadhaar gender is T,
  declare+acceptTerms (400 declare_required); sets lgbtq_lane=1, lgbtq_public=1. If Aadhaar already verified and
  kind=women with gender != F -> 403 not_eligible { message }.
- Qualification for a space creator = WhatsApp verified + Aadhaar verified + (women: gender F | lgbtq: gender T or
  declared) + latest selfie approved. Unqualified space creators cannot be published/approved/live
  (409 video_kyc_required on admin approve).

Customer lanes (existing /api/hf/lanes/*): `GET /api/hf/lanes/me` gains `selfie:{status,reason}` and
`videoKycVerified`; `lanes.women.granted` = joined + Aadhaar F + selfie approved; `lanes.lgbtq.granted` = declared +
Aadhaar verified + selfie approved. Join routes still record membership before the selfie is approved.
Gate errors on call/booking/queue stay `403 lane_required { lane }`.

Public host objects (public profile `/api/hf/hosts/public/...`, hosts lists, search results, favourites):
add `videoKycVerified:boolean` and `space:'women'|'lgbtq'|null`.
Search `GET /api/hf/search` and the Explore hosts list accept `space=women|lgbtq` filter. Space hosts are no longer
excluded from public search/lists/sitemap.

Migration: `worker/migrations/hf_creator_spaces.sql` — ALTER TABLE only:
`hf_channels ADD COLUMN views INTEGER NOT NULL DEFAULT 0`, `hf_hosts ADD COLUMN creator_kind TEXT NOT NULL DEFAULT 'channel'`.

## Telemetry (PostHog, existing helpers; never send gender or the declaration)
`hf_space_creator_chosen {kind}`, `hf_channel_threshold {result, followers, views}`, `hf_space_gate_shown {lane, missing}`,
`hf_space_filter {space, surface}`, `hf_video_kyc_badge_shown {surface}`.
