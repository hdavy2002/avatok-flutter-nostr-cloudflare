# Onboarding & Profile Fix Plan — 2026-07-08

Owner: Humphrey. Author: agent. Grounded in code + PostHog telemetry for test user
`hdavy2041@gmail.com` (signup 2026-07-08 04:23–04:26 UTC), which proved the duplicate
number gate (`number_gate_shown` ×3, `number_gate_completed` ×2, the second gate firing
at 04:26:17 — *right after* `profile_completed`).

> No build is triggered by this plan (builds are manual per CLAUDE.md). One issue per
> commit, `[ISSUE-…]` prefix, via `scripts/git_safe_commit.py` with explicit paths.

---

## Target onboarding order (new)

```
Welcome → Login (Google) → [auto-fill from Google] → Liveness intro screen →
Liveness check (human + phone confirm) → Get AvaTOK number →
Complete profile (photo, name, full DOB, gender-locked, personal phone+OTP, bio) → App
```

Number is asked ONCE, before profile. Never again after.

---

## Work items

### 1. Fix the duplicate AvaTOK-number ask  ★ highest priority, smallest change
**Root cause:** `app/lib/shell/ava_shell.dart` recomputes `needsNumber` from
`AvaNumber.me()` / the `_kHasNumberFlag` cache on every `_load()` (incl. the refresh
that runs after `ProfileSetupScreen` completes). When that read is stale, `needsNumber`
flips back to `true` and the number gate re-renders after profile.

**Fix:**
- Make "number assigned" sticky for the session: once `onAssigned` fires (or
  `_kHasNumberFlag == '1'`), never set `_needsNumber = true` again in this app run.
- On a successful assign, write `_kHasNumberFlag = '1'` and update the `AvaNumber.me()`
  cache synchronously BEFORE the profile screen mounts, so the post-profile `_load()`
  reads a fresh "has number" and short-circuits.
- Guard the gate: show it only when `needsNumber && !profileComplete && !numberAssignedThisSession`.
- De-dupe telemetry: emit `number_gate_shown` once per actual presentation (guard against
  the double `setState` paths at ava_shell.dart:117/176/182); `number_assigned` currently
  double-fires (×2 per completion) — emit once.

**Files:** `app/lib/shell/ava_shell.dart`, `app/lib/features/avatok/ava_number.dart`.
**Verify:** re-run the PostHog timeline for a fresh signup → exactly one
`number_gate_shown` + one `number_gate_completed`, ordered *before* `profile_completed`.

### 2. Add a liveness intro/explainer screen
A single screen before the camera check: "We'll do a quick check to confirm you're a real
human (not an alien from Mars)" + Continue → hands off to the existing liveness GUI.

**Files:** new `app/lib/features/identity/liveness_intro_screen.dart`; wire into
`app/lib/main.dart` RootFlow (`_Stage.humanCheck` path, ~L724–762) so the intro precedes
`liveness_v3_screen.dart`. Gate behind `RemoteConfig.livenessOnboardingGate`.
**Telemetry:** reuse `liveness_why_opened` / `liveness_gate_shown`.

### 3. Reuse the stripped-down liveness GUI to confirm the phone
Use the existing listing-liveness GUI (`liveness_v2/phone_stage.dart` + `liveness_v3`) as
the phone-confirmation step rather than a new screen. Slot it into the flow after the
intro (item 2), feeding the confirmed phone into the profile's personal-phone field (item 9).

**Files:** `app/lib/features/identity/liveness_v2/phone_stage.dart`,
`app/lib/features/identity/liveness_v3/*`, `worker/src/routes/liveness.ts`.

### 4. Re-sequence: liveness → number → profile
Ensure the number gate (ava_shell) runs only after liveness passes and before
`ProfileSetupScreen`. Confirm `main.dart` stage order and the shell gate order agree.

**Files:** `app/lib/main.dart`, `app/lib/shell/ava_shell.dart`.

### 5. Profile validation UX — jump to the offending field
The logic partly exists (`_missingFields`, `_scrollToField`, red borders in
`profile_setup_screen.dart`) but is too subtle — the "wouldn't budge" moment emits NO
telemetry (no `profile_save_rejected` for the client-side block).

**Fix:**
- On invalid submit: scroll to the first offender AND show a clear message at the button
  ("Add a profile photo to continue"), plus a brief highlight/shake.
- Emit a new event `profile_submit_blocked` `{first_missing_field}` so it's measurable.

**Files:** `app/lib/features/profile/profile_setup_screen.dart`.

### 6. Birth year → full birth date (day / month / year), mandatory
Replace the 4-digit `_birthYear` field with a full date picker; keep the 13+ / under-18
logic driven off the full date (`MinorTerms`).

**Files:** `app/lib/features/profile/profile_setup_screen.dart`,
`app/lib/core/profile_store.dart` (store full DOB, migrate from `birthYear`),
`worker/src/routes` profile register (accept `birth_date`), keep `birthYear` derived for
back-compat.

### 7. Optional time of birth
Separate optional time picker; store as part of DOB record.
**Files:** same as item 6.

### 8. AI-detect gender from name, then lock it
On name entry, call a new endpoint to infer gender; prefill and render read-only (replace
the editable ChoiceChips with a locked display). Keep a manual fallback only if AI is
uncertain (decision needed — see Open questions).

**Files:** new `worker/src/routes/ava_gemini.ts` handler (or `/api/ai/gender`),
`app/lib/features/profile/profile_setup_screen.dart`, `app/lib/core/profile_store.dart`.

### 9. Personal phone field + OTP + lock (NEW field)
Today the profile "phone" box shows the AvaTOK number (locked) — there is no real personal
phone field. Add one: enter number → send OTP → verify → lock. Reuse existing OTP infra
(`otp_sent`/`otp_requested` events, `app/lib/core/verification_api.dart`,
`worker/src/routes/number.ts` or a verify route).

**Files:** `app/lib/features/profile/profile_setup_screen.dart`,
`app/lib/core/verification_api.dart`, `app/lib/core/profile_store.dart`, worker verify route.

### 10. Auto-fill from Google sign-in
Pull from the Google/Clerk profile on sign-in: full name → first/last; birth year/date if
present; personal phone if the scope exposes it → prefill item 9's field.

**Files:** `app/lib/auth/clerk_client.dart`, `app/lib/core/profile_store.dart`,
onboarding/profile prefill. May need added Google OAuth scopes (Clerk dashboard — owner action).

---

## Suggested commit order (one issue each)
1. `[ONB-NUM-DUP]` item 1 — kill the duplicate number gate (ship first, verify in PostHog).
2. `[ONB-PROFILE-VALIDATION]` item 5.
3. `[ONB-DOB]` items 6 + 7.
4. `[ONB-PHONE-OTP]` item 9.
5. `[ONB-GENDER-AI]` item 8.
6. `[ONB-GOOGLE-AUTOFILL]` item 10.
7. `[ONB-LIVENESS-INTRO]` items 2 + 3 + 4.

## Verification (per CLAUDE.md)
- After each fix, add/extend telemetry incl. the user's email so issues are retrievable.
- Re-pull PostHog for a fresh signup to confirm: single number gate before profile; new
  `profile_submit_blocked` fires on missing field; `otp_sent` on phone verify.
- Update Graphiti (`group_id="proj_avaflutterapp"`) with what shipped.

## Open questions for owner
- Gender lock: if AI is *uncertain*, allow a one-time manual pick, or force a value?
- DOB: date-of-birth is sensitive — confirm it stays private (current copy says "never shown").
- Google phone: Google rarely exposes a phone via OAuth; if unavailable, item 10's phone
  part becomes a no-op and item 9's manual OTP is the path. OK?
