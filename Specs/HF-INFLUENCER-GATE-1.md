# HF-INFLUENCER-GATE-1 — nobody is an influencer until a human approves (owner decision 2026-10-29)

Incident: hdavy2002@gmail.com tapped "Log in with Facebook" (Page below minimum, channel rejected) and got the
influencer dashboard on web + app. Root cause: social logins call ensureHostRow()/syncHostState(); /api/hf/me says
isHost for ANY hf_hosts row; web Shell.tsx:44 and app services.dart:111 trust that; /inf/* has no guard;
syncHostState auto-promotes to 'approved' (approved channel OR video KYC) which also shows people in reels/search/profile.

## Owner rules (2026-10-29)
G1. Logging in / connecting Facebook, Instagram or YouTube NEVER makes anyone an influencer. Video KYC / selfie approval
    never does either. Only an admin approving an intro application (hf_intro_admin approve) does.
G2. An application can be submitted only when ALL are true:
    a. profile photo  — hf_user_photos kind='profile' status='active'
    b. cover photo    — hf_user_photos kind='cover'   status='active'
    c. WhatsApp verified
    d. at least one VERIFIED social account (hf_channels status='approved', i.e. at/above the minimum) OR Aadhaar verified.
       A connected account below the minimum does NOT count (Aadhaar needed). Existing rule kept: Aadhaar also required for
       Listener / Prayer / Virtual friend / Women-to-Women (lib/hf_intro_video.ts).
    e. an intro video (existing rule)
    (plus the existing name / about / rate / category checks)
G3. Admin approve re-checks G2 and shows it as a checklist; approve always sets hf_hosts.status='live' (fix the CASE that
    keeps 'approved').
G4. EVERY account (fans too) must have an active profile photo AND cover photo. Server blocks placing a call, joining a
    queue and creating a booking with error code `photos_required` (HTTP 403, message "Add your photo and cover photo
    first."). Clients send the person to the existing "My photo & cover" page. Config flag `hfPhotosRequiredEnabled`
    (default true when unset) is the kill switch.
G5. Public surfaces (reels feeds, search, public profile, call/book targets) show only status='live' AND
    intro_approved_at IS NOT NULL. 'approved' alone shows nobody.

## Status model
- isInfluencer(status) === status === 'live' || status === 'paused' (a safety pause of a live influencer keeps the
  dashboard so she can withdraw). One shared helper in worker/src/lib/hf_influencer.ts — every server check uses it.
- 'pending_check' and 'approved' are RETIRED: nothing writes them any more. Non-admin code that needs an hf_hosts row
  (onboarding drafts, space choice, name/rate) creates it as 'draft'. Channel connects/logins never touch hf_hosts.
- syncHostState(): may no longer insert or promote. Keep only as a no-op-safe function (or remove callers).

## API contract (GET /api/hf/me) — clients rely on this
- `isHost`: boolean = isInfluencer(status)   (was: any row)
- `host`: object as today but ONLY when isInfluencer, else null
- NEW `influencerApplication`: { status: 'none'|'draft'|'submitted'|'rejected'|'approved', rejectReason?: string|null,
     missing: string[] }  — `missing` uses these codes (only the ones not yet met):
     'profile_photo','cover_photo','whatsapp','social_or_aadhaar','aadhaar','intro_video'
- NEW `photosReady`: { profile: boolean, cover: boolean }   (G4)
- Error code for G4 on call/queue/book endpoints: `photos_required`.
- Submit error (POST /api/hf/onboarding/submit) when G2 fails: 400 `application_incomplete` with `missing: [...]` same codes.
