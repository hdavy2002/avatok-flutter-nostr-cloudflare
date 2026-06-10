# Phase 1 — Platform Groundwork

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §3, §6. Prerequisites: none.

## Objective
Prepare the shell so every later phase drops cleanly in: disable the account-type
onboarding step, show ONLY the standard apps, add an app registry + feature flags,
and lay the D1 migration scaffold for the new marketplace domains.

## 1. Disable the account-type onboarding step
File: `app/lib/features/onboarding/onboarding_flow.dart` (7-step flow; step 0 =
Single/Parent/Enterprise picker, state in `_selectedKind` / `AccountKindStore`).

- Add a const flag `kAccountTypeStepEnabled = false` (in a new
  `app/lib/core/feature_flags.dart`, so later flags live in one place).
- When false: the flow starts at the old step 1; `_steps`/`_stepNames`/progress
  dots shrink accordingly; `_selectedKind` defaults to `AccountKind.personal`
  before `accountKind:` is sent to the backend.
- Do NOT delete the step widget (`_kindStep`, card builders) — it returns later.
- Existing users untouched (they skip onboarding already).
- Keep PostHog `onboarding_step_viewed/completed` indices consistent (re-index).

## 2. Standard-apps-only sidebar
File: `app/lib/shell/ava_sidebar.dart` (+ `ava_shell.dart`).

- Introduce `AppRegistry` (`app/lib/core/app_registry.dart`): one record per app
  `{id, title, icon, color, route, tier}` where `tier ∈ {standard, hidden}`.
- Standard: AvaTOK messenger (a.k.a. AvaTalk — IS a standard app; gets group
  conferencing in Phase 10), AvaExplore, AvaVerse, AvaLibrary, AvaStorage,
  AvaWallet, AvaPayout, AvaIdentity, AvaBooking, AvaCalendar, AvaLive, AvaConsult,
  AvaInbox, AvaChat. Hidden: everything else in the current sidebar (AvaTweet,
  AvaBook, AvaGram, AvaTube, AvaWeb, AvaNote, AvaAds, AvaLinked, AvaTind, AvaMatri,
  AvaVoice, AvaAgent, AvaAI…).
- Sidebar renders `tier == standard` only. Hidden tier stays registered (flip per
  app later without re-plumbing). Parent section (child accounts etc.) untouched.
- New app entries route to placeholder screens (`ComingSoonScreen(appId)`) until
  their phase ships, so navigation never dead-ends.

## 3. Backend scaffold (D1 `avatok-meta`, migrations via REST API)
Create EMPTY migrations now (tables filled per phase) so naming is locked:

```sql
-- 0xx_marketplace_scaffold.sql
CREATE TABLE IF NOT EXISTS listings (...);          -- Phase 6 fills
CREATE TABLE IF NOT EXISTS orders (...);            -- Phase 2/7
CREATE TABLE IF NOT EXISTS wallet_ledger (...);     -- Phase 2
CREATE TABLE IF NOT EXISTS payout_accounts (...);   -- Phase 3
CREATE TABLE IF NOT EXISTS calendar_blocks (...);   -- Phase 5
CREATE TABLE IF NOT EXISTS bookings (...);          -- Phase 5
CREATE TABLE IF NOT EXISTS reviews (...);           -- Phase 6
CREATE TABLE IF NOT EXISTS files_index (...);       -- Phase 4
CREATE TABLE IF NOT EXISTS storage_quota (...);     -- Phase 4
```
(Each phase ships its own ALTER/real migration; this file just reserves names.
If preferred, skip placeholder DDL and only commit a `MIGRATION-PLAN.md` — decide
in-session; do not create empty tables that complicate later `CREATE TABLE`.)

- Worker: add route module stubs `worker/src/routes/{wallet,payout,identity,storage,
  calendar,booking,listings,inbox,avabrain}.ts` exporting routers returning 501,
  mounted in `index.ts`. Locks URL space: `/api/wallet/*`, `/api/payout/*`, etc.

## 4. Client conventions for all later phases
- Every new local store scoped: `scopedKey(...)` / per-account subdir via
  `AccountScope.id` (rulebook §1 — parent+child share a phone).
- Every new screen: local-first drift table + one indexed query; PostHog
  `screen_viewed` event.
- All money shown via a single `Money` formatter (coins ↔ USD).

## Acceptance criteria
- [ ] Fresh signup never sees the account-type page; backend receives `personal`.
- [ ] Sidebar shows exactly the standard apps + Invite/Diagnostics/Account section.
- [ ] All standard apps navigate somewhere (screen or ComingSoon).
- [ ] Flag flip (`kAccountTypeStepEnabled = true`) restores the step — verified once.
- [ ] Worker deploys with stub routes; `/api/wallet/ping` returns 501.
- [ ] APK builds green in GitHub Actions (no local flutter build).

## Folded from audit (build in this phase)

### A1. Staging environment [MUST]
- `wrangler.toml`: add `[env.staging]` for `avatok-api` + `avatok-consumers` with
  SEPARATE bindings: D1 `avatok-meta-staging`, R2 `avatok-blobs-staging`, KV +
  queues suffixed `-staging`. Provision via wrangler/REST (token in `secrets/cf_token`).
- Secrets per env: Stripe TEST keys, Wise sandbox, Brevo (real, but staging email
  templates prefixed `[STG]`) — record in `secrets/secret-values.env` under a
  `# staging` block.
- Flutter: `--dart-define=AVATOK_ENV=staging` flavor pointing at
  `api-staging.avatok.ai` (worker route); CI builds a staging APK on a `staging`
  branch push. All later phases: deploy to staging → verify acceptance criteria
  → then prod.

### A2. Remote kill switches / server config [MUST]
- KV key `platform_config` (JSON): `{walletRealMoney, donationsEnabled,
  liveEnabled, consultEnabled, conferenceEnabled, brainEnabled, minAppBuild}`.
- `GET /api/config` (no auth, cached 60 s) returns it; admin-only
  `PUT /api/admin/config` updates (Clerk role check `admin`).
- Flutter `RemoteConfig` service: fetched at app start + every 15 min; features
  check it before rendering money/live UI; `minAppBuild` greater than installed
  build ⇒ blocking "please update" screen.
- Acceptance: flipping `donationsEnabled=false` hides/disables donate UI within
  15 min without an APK release.

### A3. Error/empty/offline conventions [SHOULD]
- Shared widgets in `app/lib/core/ui/`: `EmptyState(icon,title,subtitle,cta)`,
  `ErrorState(retry)`, `OfflineBanner` (listens to connectivity; screens still
  render cached drift data under it).
- Rule for every later phase: each new screen MUST define its empty state copy
  and use these widgets — reviewers reject screens with blank/With-spinner-forever
  states.

### A4. HOTFIX — zombie call UI (bug observed 2026-06-10, PostHog-confirmed) [MUST]
Symptom: remote picked up then hung up; local phone stayed in "video call" until
manual hangup. PostHog evidence: `call_ended` reason=`ringing` logged by ONE side
only (00:48:57Z), no matching peer event. Root causes in
`app/lib/features/avatok/call_screen.dart`:
1. **Line ~164:** `_ws!.stream.listen(_onSignal, onError: (_) {}, onDone: () {})`
   — socket death is silently ignored. FIX: both handlers call
   `_end('socket-lost')` (`_end` is already idempotent via `_ended`).
2. **No media watchdog:** add `pc.onConnectionStateChange` — on
   `failed` ⇒ `_end('rtc-failed')` immediately; on `disconnected` start a 10 s
   timer ⇒ `_end('rtc-disconnected')` if not recovered (cancel on `connected`).
3. **Ringing race:** in `worker/src/do/call_room.ts`, a `bye`/`decline` whose
   `to` peer id is missing or not yet registered must be **broadcast to all
   other sockets** instead of dropped — covers hangup-before-welcome.
4. **End-path hygiene:** every `_end(reason)` also cancels the ongoing-call
   foreground notification / CallKit-style banner and any ringtone — audit
   `push_service.dart` (it handles CALL pushes) for a stale "ongoing call"
   notification path.
5. **Telemetry:** generate a `call_id` (uuid, passed in the call invite) and
   attach to ALL call events on BOTH sides; `call_ended` gets exhaustive
   `reason` taxonomy: `local-hangup|remote-bye|peer-left|decline|busy|
   socket-lost|rtc-failed|rtc-disconnected|timeout-ringing`. Add a 60 s
   ringing timeout ⇒ auto-end (caller side).
- Acceptance: kill the callee's app mid-call (no bye sent) ⇒ caller's UI ends
  within ~10 s with reason `rtc-disconnected`/`peer-left`; airplane-mode the
  caller ⇒ ends with `socket-lost`; PostHog shows both sides' events joined by
  `call_id` for a test call.

### A5. Platform analytics standard [MUST]
`ANALYTICS-OBSERVABILITY.md` (same folder) is BINDING from this phase on: the
`Analytics.capture` envelope, per-app event catalogs, API-error capture, and a
per-phase verification query. Build the envelope helper + worker-side capture
here; later phases add their catalogs as they ship.

## Definition of done
Deploy worker, push (CI builds APK), Graphiti episode
(`group_id="proj_avaflutterapp"`), STATUS_REPORT.md updated.
