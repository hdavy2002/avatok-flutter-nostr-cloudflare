# Multi-Account Robustness + Responsive UI Plan

**Date:** 2026-07-04 · **Owner mandate:** (1) multiple accounts sharing one phone (parent + kids, frequent log out/in) must be bulletproof; (2) UI must work on ALL phone sizes — no squeezed layouts, oversized text, hidden inputs, or buttons cut off underneath.

Evidence base: PostHog investigation `REPORT-CALL-ISSUES-SAT-HDAVY2002-2026-07-04.md` — account switching on devices `fogos` and `marvel` directly caused silent push fan-out failure (calls that never ring), receptionist double-sessions, and busy-state races.

---

## Part 1 — Multi-account on one phone (parent + kids)

### Current gaps (observed in telemetry)

1. **Server keeps stale push tokens across account switches.** After a re-login the server still holds the old token; call pushes are dropped **silently** — no `call_push_sent`, no `push_no_device`, caller hears endless ringback. (7/3 18:22–18:32: 4 calls, zero rings.)
2. **Logout is destructive.** Full sign-out + sign-in churns Keystore (BAD_DECRYPT loop pre-dce5f4f), push registration, hub connection, and local DB swap every time. 6–7 re-signups on `fogos` in 3 days.
3. **Identity confusion.** One human across accounts (sf0273 → s.rgoavilla) left dead accounts that contacts still dial.
4. **Stale call/receptionist state survives account switches** → autobusy on fresh calls, receptionist re-attach.

### Design principles

- **Device-level push token, account-level routing.** The FCM token belongs to the DEVICE (like the Clerk client token, which is already global per rulebook). Server model: `device_tokens(device_id, fcm_token, updated_at)` + `account_devices(account_id, device_id, active, last_seen)`. Login/switch = flip the mapping, never re-mint or orphan the token.
- **Fan-out must never fail silently.** On call push: resolve tokens → if zero valid, emit `push_no_device` AND return a distinct API result so the caller UI can say "X is unreachable right now" instead of fake ringing. On FCM `UNREGISTERED`/`INVALID` error: prune token, retry remaining tokens, emit `push_token_pruned` with account context.
- **Account switch ≠ logout.** Use Clerk multi-session: keep N sessions alive on the device, switch the active `AccountScope` without tearing down Keystore or the device push registration. Fast switcher UI (avatar row, like Gmail). Logout remains available but is the exception.
- **Per-account teardown checklist on switch:** end/park any active CallRoom leg, clear in-flight call state (fixes autobusy), close per-account hub socket, swap drift DB via existing `Db.reset()`, re-scope media cache dir. A single `AccountSwitcher.switchTo(accountId)` orchestrator with an idempotent step list — no screen does its own partial teardown.
- **Kid accounts:** child sessions live under the parent's device mapping; per-account scoping (rulebook rule 1) already covers local state — audit for raw global keys as part of this work.
- **Push payload carries `account_id`;** client drops pushes for accounts not on this device (prevents cross-account leaks after account moves to a new phone).

### Acceptance tests (must pass on 2 physical devices)

1. A↔B switch 10× rapidly; call each account from a third phone after every switch — rings correctly every time, zero `push_no_device` for present accounts.
2. Call arrives DURING an account switch — either rings post-switch or caller gets explicit "unreachable", never silent ringback.
3. Kid account on parent phone receives its own pushes; parent account's DMs/media never visible under kid scope.
4. Reinstall + restore: both accounts recoverable, tokens re-mapped, old tokens pruned server-side within one call attempt.

---

## Part 2 — Responsive UI on all phone sizes

### Symptoms (owner report + screenshot of sign-in on Sat's phone)

Squeezed layouts, everything oversized, input boxes not visible, actionable elements hidden beneath other widgets / off-screen. Worst on small-width (<360dp), low-DPI, and high system-font-scale devices.

### Root causes to fix

1. **Unclamped text scale on non-body text.** The 2026-06-28 fix scoped font-scale to body text only; headers/buttons/inputs still explode at system scale 1.3–2.0.
2. **Fixed-height / fixed-width layouts** (Columns without scroll, absolute paddings, `SizedBox` heights) overflow on short screens and when the keyboard opens.
3. **No keyboard inset handling** on form screens → inputs hidden behind keyboard.
4. **Overlapping stacked widgets** (things "hidden underneath") — Stack/Positioned assumptions that only hold on tall screens.

### Standard (apply via the Zine design system so it's one fix, not 40)

- **Global `MediaQuery` textScaler clamp: 0.85–1.3** at the app root (`MaterialApp.builder`), not per-widget. Body text may keep a wider clamp if accessibility requires.
- **Every screen body scrollable by default:** Zine scaffold wraps content in `SingleChildScrollView` + `SafeArea` + `resizeToAvoidBottomInset: true`; forms use `scrollPadding` so the focused input is always visible above the keyboard.
- **Breakpoint tokens in Zine core** (`zineBreakpoints`): compact <360dp, regular 360–600, expanded >600. Spacing/type ramp keys off these instead of hard-coded px.
- **No fixed heights for text-bearing widgets.** Buttons/inputs use min-height + intrinsic sizing; replace `Positioned` overlays that can collide with flow layout or `Align` + padding.
- **Min tap target 44dp**, and nothing interactive within keyboard-inset or system-gesture zones.
- **Overflow CI gate:** widget tests render key screens (sign-in, onboarding, chat, dialer, settings, wallet) at 320×568 @ scale 2.0, 360×640 @ 1.3, 412×915 @ 1.0 and fail on any `RenderFlex overflow` exception. Cheap, catches regressions forever.

### Rollout order

1. Root textScaler clamp + sign-in/onboarding screens (the screenshot case) — highest visibility.
2. Zine scaffold scroll/inset defaults + breakpoint tokens.
3. Sweep remaining ~40 unmigrated screens (fold into the existing Zine wave-2 migration).
4. Overflow CI gate in GitHub Actions.

---

## Execution notes

- Implementation delegated per tiered workflow: Part 1 server+client (hard) → Opus; Part 2 UI sweep (medium) → Sonnet; CI gate (trivial) → Haiku.
- One issue per commit via `scripts/git_safe_commit.py`; no pushes without explicit owner request.
- Telemetry to add: `account_switch` (duration, steps failed), `push_fanout_result` (tokens tried/pruned/delivered per call), `ui_overflow_detected` (debug builds), all carrying email + account_id.
