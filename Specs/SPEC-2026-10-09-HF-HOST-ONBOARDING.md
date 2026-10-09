# Host onboarding — spec (HF-HOST-ONBOARD)

Owner approved 2026-10-09. Plan context: project doc `claude/hello-fraands-host-listing-plan.md`.

## Owner decisions (2026-10-09)
- App = this website wrapped with **Capacitor** (no Flutter rebuild). Same React code in browser and app.
- **One price for all topics.** ₹5 floor. Earnings per HF-PAY-6.
- **KYC first** (phone → video KYC → Aadhaar), then profile, so no generation money is spent on unverified hosts.
- Phase 1 uses the 12 existing sample portraits as avatars.
- Photo avatars (no video). AI images and cloned-voice sample conversation are labelled as AI.
- Never real photos of the host.

## Steps
welcome · phone · aadhaar · selfie · payout · avatar · about · languages · topics · price · hours · voice · review · generating · preview · done
(contract: `web/src/islands/host-onboarding/types.ts`, lists: `data.ts`)

## Phases
0. Spec ✅ · **1. Clickable mock (no backend)** · 2. Real verification (WhatsApp OTP/WasenderAPI, Didit, Aadhaar, Clerk) · 3. Save drafts + avatar/topic APIs · 4. Voice upload + generation pipeline + WhatsApp ping · 5. Host preview/approve + admin approval → live · 6. Capacitor app test. PostHog in every phase.

## App-ready rules (all phases)
- Screens only talk to `OnboardingApi` (mock in Phase 1). No fetch() in screens.
- Step in the URL (`?step=`) via history.pushState; Android back = previous step.
- Draft saved via `storage.ts` (try/catch localStorage); resume where she left.
- Mobile first: sticky bottom action bar, tap targets ≥ 48px, `env(safe-area-inset-*)`, `100dvh`, inputs 16px+ (no iOS zoom), `inputMode="numeric"` + `autoComplete="one-time-code"` for OTP. No hover-only UI, no alert()/confirm().
- Voice: MediaRecorder + getUserMedia; fallback `<input type="file" accept="audio/*" capture>`.
- Design: Nunito headings, Comfortaa everything else, nothing under 14px, **no green**, full width. Desktop ≥ 1024px: form left, live card preview right (sticky). Phone: "See my card" button opens the preview sheet.
- Colours: plum #46113e, coral #ff585c, accent red #bd2740, ivory #fffdf7, muted #785979, lilac #f8f1fc / #f2ecfc, pink #fde8ef, butter #fff4c9.

## Phase 1 build lanes (separate files, no overlap)
| Lane | Files |
|---|---|
| A Shell | `HostOnboarding.tsx`, `api.ts` (mock), `storage.ts`, `Icon.tsx`, `PreviewCard.tsx`, `pages/hosts/onboarding.astro`, `styles/host-onboarding/base.css` |
| B Verify | `steps/WelcomeStep.tsx`, `PhoneStep.tsx`, `KycStep.tsx`, `AadhaarStep.tsx`, `styles/host-onboarding/verify.css` |
| C Profile | `steps/AvatarStep.tsx`, `AboutStep.tsx`, `LanguagesStep.tsx`, `TopicsStep.tsx`, `PriceStep.tsx`, `HoursStep.tsx`, `styles/host-onboarding/profile.css` |
| D Finish | `steps/VoiceStep.tsx`, `ReviewStep.tsx`, `GeneratingStep.tsx`, `PreviewStep.tsx`, `DoneStep.tsx`, `styles/host-onboarding/finish.css` |
Each step file: `export default function XStep(props: StepProps)`. Shared CSS primitives (from base.css): `.hob-h1`, `.hob-lead`, `.hob-card`, `.hob-chip`(+`[aria-pressed=true]`), `.hob-field`, `.hob-label`, `.hob-input`, `.hob-help`, `.hob-error`, `.hob-btn` / `.hob-btn-primary` / `.hob-btn-ghost`, `.hob-ai-label`, `.hob-grid-2`.

---

# Phases 2–5 — backend spec (DRAFT, awaiting owner approval — no code yet)

Grounded in the current code (2026-10-09 investigation).

## What already exists and will be reused
| Need | Existing code |
|---|---|
| WhatsApp OTP | `routes/whatsapp_auth.ts` (`/api/auth/whatsapp/send|verify`, Clerk ticket or `needs_email`), `routes/phone_otp.ts` (`/api/account/phone/*`), WasenderAPI. Web client `islands/auth/whatsappAuth.ts`. |
| Didit | `routes/liveness_didit.ts` (session, webhook, result). Today = **liveness only** workflow; no gender/DOB/Aadhaar read. Webhook has **no signature check**. |
| Aadhaar | **Nothing in code.** Didit offers for India: Aadhaar card scan (OCR, $0.15, 500 free/month) and a UIDAI database lookup ($0.25, needs Aadhaar no. + name + DOB + **PAN**). |
| Profile + approval pattern | `consultants` (draft → live/paused, admin attach, desk self-edit, `ADMIN_UIDS` gate, `admin_audit`). |
| Reviews moderation | `consult_reviews` (pending/approved/rejected, one per completed booking, token link). Note: admin UI calls `PATCH /api/consultants/admin/reviews/:id` but no handler exists — likely bug. |
| Admin shell | `layouts/Admin2.astro` + `islands/admin2/nav.ts`. |
| Images | `generateImage(..., editRef)` → Vertex `gemini-3.1-flash-image`, reference image supported. Store in `BLOBS`. |
| Long jobs | Cloudflare Workflow template `workflows/deletion.ts`; queue `Q_AI_MEDIA`. Never `waitUntil` (poster lesson). |
| WhatsApp messages | `lib/whatsapp_send.ts sendWhatsAppText`, `lib/whatsapp_notify.ts` outbox. |
| Voice | **No ElevenLabs / voice clone code.** New secret `ELEVENLABS_API_KEY`. |

All new APIs sit behind one kill switch `hostOnboardingEnabled` (declared in `config.ts` DEFAULTS, default false; flipped in prod only when owner says).

## Phase 2 — Real verification

> **UPDATED 2026-10-09 (owner):** India KYC is WhatsApp OTP (WasenderAPI) → Aadhaar OTP (Sandbox.co.in) → our own 10-second selfie video with an on-screen code (admin compares with the Aadhaar photo) → UPI + bank account check with name match. Didit is kept only for future international hosts. See rulebook §13 and `Specs/HF-HOST-KYC-1-RUNBOOK.md` (branch issue/hf-host-kyc-1). The Didit text below is superseded.
1. **Account + WhatsApp**: step "phone" uses the existing WhatsApp flow. Existing account → signed in. New → existing sign-up (email) then back to onboarding. Phone is the number calls ring.
2. **KYC (one Didit session)**: new Didit workflow "Host KYC" = Aadhaar card scan + selfie liveness + face match + 18+ check. Replaces the separate Aadhaar OTP screen (fewer steps, no new vendor).
   - `POST /api/hosts/kyc/session` → Didit URL (opens in browser tab / Capacitor in-app browser, returns via callback).
   - Webhook reuses the liveness handler pattern + **adds signature verification**.
   - Store ONLY: passed, gender, age ≥18 yes/no, Aadhaar last 4, Didit session ref, date. Never full Aadhaar, DOB, address or ID images in our DB (matches /hosts/kyc page). Didit keeps the evidence.
3. Mock KYC gender chooser removed; women-only lane uses KYC gender.

## Phase 3 — Saving drafts, avatars, options
- D1 `DB_META` tables: `hf_hosts` (uid PK, status, display_name, about, languages_json, style, topics_json, price_per_min, hours_json, health_consent, women_lane, avatar_id, kyc_gender, kyc_ref, timestamps), `hf_avatars` (id, image_key, gender, age_band, look, status, taken_by_uid UNIQUE), `hf_host_media` (uid, kind profile|gallery|sample_audio, r2_key, caption, ai=1, status, sort), `hf_voice_consents`, `hf_media_jobs`.
- Host status: `kyc_pending → profile_draft → generating → pending_host → pending_review → live | paused | rejected`.
- APIs: `GET/PUT /api/hosts/me` (draft autosave), `GET /api/hosts/avatars?gender&age&look`, `POST /api/hosts/avatars/:id/claim` (atomic exclusive lock).
- Topics/styles/languages: one shared list, validated by the worker too.
- **Avatar catalogue** (separate task): generate ~200–300 avatars with the existing Gemini image model (rules HF-AVA-4), admin screen to approve/retire.

## Phase 4 — Voice + generation
- Starts with the **one-host spike** (images + ElevenLabs clone + 20 s conversation) to confirm cost/quality.
- `POST /api/hosts/voice` (≤60 s, ≤5 MB) → private `DIGITAL` bucket + consent row.
- Cloudflare Workflow `HostMediaWorkflow`: text (Gemini) → 6 images (avatar as reference) → ElevenLabs instant clone → 20 s two-voice sample conversation → **delete clone** → safety check (image + text) → save to `BLOBS` `hf/hosts/{uid}/…` → status `pending_host` → WhatsApp "your profile is ready".
- Regeneration limit + cost log per host (PostHog `$ai_generation`).

## Phase 5 — Approve and go live
- Host approves preview → `pending_review`.
- Admin menu **Hosts**: queue with the card + profile preview, approve / reject (reason) / edit text; WhatsApp to host either way; audit row.
- Live hosts appear on Explore and the home cards from D1; profile page `/people/<slug>` becomes a server-rendered route (static-per-file only works for samples).
- Reviews + admin review queue come with the call backend (need completed paid calls).

## Telemetry
Every phase: onboarding funnel events (step view/done, drop-off), KYC result, generation stage timings/cost/failures, admin decisions — all carrying email + uid.
