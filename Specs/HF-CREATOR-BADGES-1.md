# HF-CREATOR-BADGES-1 — one creator profile, stacked verifications (owner 2026-10-24)

Issue id `[HF-CREATOR-BADGES-1]`. Builds on HF-CREATOR-SPACES-1 (read Specs/HF-CREATOR-SPACES-1.md first).
Replaces the "pick ONE path" model with stacked badges. Rulebook: add HF-SPACE-6..9 (coordinator does it).

## Owner decisions
- Creators can be individuals with no social channel and no space (e.g. a housewife who wants to chat / share her day).
  They go live with **full video KYC** (Aadhaar + 10-s selfie, admin approved). Copy: "chat, company, share your day".
  NEVER mention sex/adult talk anywhere — HF-CON-1 still bans sexual or suggestive talk.
- One sign-up; badges stack: Phone verified (WhatsApp, everyone) · Channel verified (approved channel, 20 followers +
  1,000 YouTube views) · Video KYC verified (Aadhaar verified + latest selfie approved) · Space (Women-only OR LGBTQ+,
  ONE at a time, needs video KYC; women = Aadhaar F; lgbtq = Aadhaar T or private declaration + public-tag consent).
- **Go-live rule:** approved channel OR video KYC verified. Space creators additionally need their space qualification.
  A creator may have both channel + video KYC + a space; channel videos show on the profile whenever a channel is connected.
- **"Who can call you"** setting, FREE for every creator (replaces HF-PLAN-1 monthly-plan-only):
  `everyone` (phone-verified customers, default) | `video_kyc` (only customers with full video KYC).
  Space creators are always `video_kyc` + their space rule (setting shown locked). Enforced by the server at call start,
  booking, queue join (403 `video_kyc_required_caller` with `{ level:'video_kyc' }`; spaces keep 403 `lane_required`).
  UI text next to it: "We never share any customer's details with anyone."
- Customers can do a plain video KYC with no space (to call video-KYC-only creators): `/verify/lane?lane=kyc`.
- Search/Explore: new filter "Video KYC verified" (`kyc=1`) next to Women-only / LGBTQ+.

## API contract (worker)
- hf_hosts new column `caller_level TEXT NOT NULL DEFAULT 'everyone'` (migration `worker/migrations/hf_creator_badges.sql`, ALTER only).
  `creator_kind` stays as legacy, no longer drives anything except reading old rows (women/lgbtq → space).
- `GET /api/hf/spaces/me` → adds `{ badges:{ phone, channel, videoKyc, space:'women'|'lgbtq'|null },
   canGoLive:boolean, missing:string[]  /* e.g. ['channel_or_video_kyc','space_video_kyc'] */,
   callerLevel:'everyone'|'video_kyc', callerLevelLocked:boolean }` (keep all old fields).
- `POST /api/hf/spaces/space { space:'women'|'lgbtq'|null, declare?, acceptTerms?, publicTagConsent? }` → join/leave a space
  (null = leave; sets women_lane/lgbtq_lane accordingly; one at a time; same eligibility errors as /creator).
  `POST /api/hf/spaces/creator` keeps working (kind 'channel' = no space; women/lgbtq = join that space).
- `POST /api/hf/spaces/caller-level { level:'everyone'|'video_kyc' }` → `{ ok, callerLevel }`; 409 `space_locked` for space creators.
- Go-live / admin approve / publication blocker: `verification_required` when neither approved channel nor video KYC;
  `video_kyc_required` for a space creator not qualified. syncHostState must not demote a host who lost her channel but
  has video KYC.
- Customer lanes: `GET /api/hf/lanes/me` adds `lanes.kyc.granted` (= Aadhaar verified + latest selfie approved, i.e. videoKycVerified).
  `/verify/lane?lane=kyc` uses role "lane_caller" Aadhaar + selfie, no join call.
- Public host objects add `callerLevel` ('everyone'|'video_kyc', spaces always 'video_kyc') and `channelVerified:boolean`
  (+ keep videoKycVerified, space). Lists/search accept `kyc=1` (videoKycVerified only).

## Telemetry
`hf_verify_badge_added {badge}`, `hf_caller_level_set {level}`, `hf_space_joined {space}` / `hf_space_left`,
`hf_caller_gate_shown {reason:'video_kyc'|'women'|'lgbtq'}`, `hf_space_filter {space|'kyc'}`. Never gender/declaration.
