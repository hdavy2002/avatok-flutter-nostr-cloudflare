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
welcome · phone · kyc · aadhaar · avatar · about · languages · topics · price · hours · voice · review · generating · preview · done
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
