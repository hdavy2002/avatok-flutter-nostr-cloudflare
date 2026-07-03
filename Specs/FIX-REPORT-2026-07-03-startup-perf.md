# FIX REPORT — Startup & local-cache performance (2026-07-03)

Implementation of `Specs/FIX-INSTRUCTIONS-2026-07-03-startup-perf.md` (PERF-1 … PERF-8).
All commits are LOCAL only (no push), one per item, via `scripts/git_safe_commit.py`
with explicit paths.

| Item | Status | Commit |
|---|---|---|
| PERF-1 | done | `ab5cda5` |
| PERF-2 | done | `d5ee2fd` |
| PERF-3 | done | `c7f73c0` |
| PERF-4 | done | `b90e1cc` |
| PERF-5 | done | `bc35cfd` |
| PERF-6 | done | `8d1ccf3` |
| PERF-7 | done (root-caused + client fix + capture) | `f443b05` |
| PERF-8 | clean — no commit needed | — |

---

## PERF-1 — Defer analytics/firebase/push/bootstrap init to post-first-frame
Commit `ab5cda5` — `app/lib/main.dart`, `app/lib/push/push_service.dart` (2 files, +57/−25)

**main.dart** (`main()`, formerly :41–101):
- Kept before `runApp`: `WidgetsFlutterBinding.ensureInitialized()`, the two imageCache
  caps, `FontScale.load()` (cheap prefs read, try/catch kept, moved up), `unawaited(RemoteConfig.start())`,
  both error handlers (`FlutterError.onError` / `platformDispatcher.onError`).
- New top-level `Future<void> _deferredInit({int? firstFrameMs})` scheduled via
  `WidgetsBinding.instance.addPostFrameCallback((_) { unawaited(_deferredInit(...)); })`
  placed right before `runApp(const AvaTalkApp())`. Contains, in the original order with
  all original try/catch + comments: `DiskCache.flushImageCachesOnce('img_cache_flush_0_1_17_20')`
  + imageCache clear → `Analytics.init()` → `Firebase.initializeApp(...)` (+captureException)
  → `AvaBootstrap.init()` → `FirebaseMessaging.onBackgroundMessage(...)` + `PushService.init()`.

**push_service.dart**:
- Added `static final Completer<void> ready` + `_markReady()` on `PushService`
  (push_service.dart:603–616). `init()` is now a thin wrapper:
  `try { await _init(); } finally { _markReady(); }` — the original body moved verbatim
  into `static Future<void> _init()`, so waiters can never hang (completes on success,
  throw, AND the desktop early-return path).
- `registerToken()` first line: `try { await ready.future.timeout(const Duration(seconds: 15)); } catch (_) {}`
  so the deferred init can't race FCM `getToken()`.
- `requestPermission()` stays inside `init()` (push_service.dart:626) — it now runs
  post-first-frame via `_deferredInit`, per spec item 4. It CANNOT fire before first
  frame: the only call path is `_deferredInit`, which is scheduled in `addPostFrameCallback`.

## PERF-2 — 8s timeouts + telemetry on all Clerk FAPI calls
Commit `d5ee2fd` — `app/lib/auth/clerk_client.dart` (+33/−16)

- `_send()` (:86): every `http.get/post/delete` now has `.timeout(const Duration(seconds: 8))`.
  On `TimeoutException`: `_sx('fapi_timeout', provider: 'clerk', reason: path)` then
  `rethrow` (not swallowed into `{'_status': 0}`). `dart:async` was already imported.
- `sessionToken()` logic unchanged. `_mintSessionJwt()`: each of the two attempts now
  fails fast (≤8s each leg). **Deviation (see checklist):** I wrapped each attempt's body
  in `on TimeoutException {}` so a mint timeout degrades to "mint failed → serve the
  still-valid cached JWT until hard expiry" (the documented Drive blank-screen fallback)
  instead of throwing past that fallback into every authed request.

## PERF-3 — Inbox socket starts first in chat_list `_bootstrap`
Commit `c7f73c0` — `app/lib/features/avatok/chat_list.dart` (+22/−15)

New tail order (formerly :658–677):
1. `Analytics.identify(id.uid);`
2. `_startInbox(id);` — socket + cursor sync now starts with zero network prerequisites.
3. `unawaited(PushService.registerToken(id.uid));`
4. `unawaited(() async { … currentUser → setUserKeys → _clerkName → Directory.registerProfile … }());`
   — internal try/catch and `mounted` checks preserved exactly.
Nothing afterwards awaits those futures. `dart:async` already imported.

## PERF-4 — AvaShell renders from persisted gate flags
Commit `b90e1cc` — `app/lib/shell/ava_shell.dart` (+108/−40)

- New per-account flags `shell_profile_complete` / `shell_has_number` ('1'/'0') via
  `DiskCache.read/write` — DiskCache writes under `cache/<AccountScope.id>/`, the same
  per-account pattern `FocusMode` uses (which the spec said to mirror), so scoping holds.
- New `_load()`: `_idStore.load()` → `FocusMode.load()` → read both flags. If BOTH known:
  immediate `setState` (`_id`, `_profileComplete`, `_needsNumber`) — user enters the app
  with no network — then the ENTIRE former network sequence (clerk email → `store.load()` →
  `restoreFromServer` → `serverProfileComplete` → `AvaNumber.me()`) runs in a background
  `validateGates()` closure (`unawaited`), which persists both flags and `setState`s ONLY
  when a value differs from what was rendered. First run (no flags): `await validateGates()`
  — today's blocking behavior — and flags are persisted at the end.
- `_authEmail` now arrives from the background block (setState when it changes).
- `number_gate_shown` fires on both the cache and network paths; `BackupService.I.maybeAutoBackup()`
  moved into the background block.
- Telemetry: `shell_gate_ms` (`ms`, `source: 'cache'|'network'`) at the first revealing setState.
- Added imports: `dart:async`, `../core/disk_cache.dart`.

## PERF-5 — Idempotent v6 npub→uid migration
Commit `bc35cfd` — `app/lib/core/db.dart` (+18/−2)

The `if (from < 6)` body now defines a local `renameIfExists(TableInfo, String, GeneratedColumn)`
that (1) checks `PRAGMA table_info(<actualTableName>)` via `customSelect(...).get()` and
`r.read<String>('name')` (valid for drift ^2.16), (2) only then calls `m.renameColumn`,
(3) wraps everything in try/catch so a legacy rename can never abort the migration —
schemaVersion 6 finally sticks. schemaVersion NOT bumped. `package:drift/drift.dart`
(already imported) exports `TableInfo`/`GeneratedColumn`.

## PERF-6 — first_frame_ms telemetry
Commit `8d1ccf3` — `app/lib/main.dart` (+11/−2)

`t0` recorded at the top of `main()`; the ms value is computed inside the first
`addPostFrameCallback` (i.e. AT first frame) and passed into `_deferredInit(firstFrameMs:)`,
which sends `Analytics.capture('first_frame_ms', {'ms': …})` immediately AFTER
`Analytics.init()` completes (the spec's "simplest" option). `ttfm_ms` untouched —
still fires from `sync_hub.dart:183`.

## PERF-7 — /api/profile 422 root-caused + fixed + captured
Commit `f443b05` — `app/lib/features/avatok/chat_list.dart`, `app/lib/features/avatok/contacts.dart` (+22/−1)

**Root cause (definitive):**
- The 422 is NOT from `restoreFromServer`/`serverProfileComplete` (those hit `GET /api/me`).
  It is from `Directory.registerProfile` → `POST /api/profile`, called on every launch
  from chat_list's `_bootstrap`.
- Client: `ClerkUser.fromJson` (clerk_client.dart:524) sets `label = first_name ?? EMAIL ?? 'Account'`.
  chat_list sent `name: cu.label` — so any account with no Clerk first_name sends its
  **email address as the profile name**.
- Worker: `profileUpsert` (worker/src/routes/api.ts:277) calls `guardWrite` →
  `firstUnsafe` (worker/src/lib/moderation.ts:210): for `field: "name"`,
  `namePlausible()` rejects any string containing digits or failing the letters-only
  regex — an email always fails ⇒ `guardWrite` returns **422**
  `{ok:false, moderation:"unsafe", field:"name", categories:["name_format"], error:"That doesn't look like a real name…"}`
  (moderate.ts:91–94). Matches hdavy2002 (email-derived label) 139×/launch-every-time.
- Request shape sent: `{name:"<email>", email:"…", phone:"…"}`; response shape above.

**Fix (client, ~10 lines, chat_list.dart):** prefer `prof.displayName` as the directory
name; if empty, only send `cu.label` when it contains no `'@'` and no digit, else send
`''` (the Worker's `COALESCE` upsert keeps the stored name; `firstUnsafe` skips empty
fields — no moderation call, no 422).

**Capture (contacts.dart):** in `registerProfile`, on any non-200, once per session:
`Analytics.capture('profile_restore_rejected', {'status': …, 'body': <first 300 chars>})`.

No Worker change made (server behavior is arguably correct — it rejects a non-name;
the client was sending garbage).

## PERF-8 — Ably verification
`grep -ri ably app/pubspec.yaml app/lib`: **clean** — no `ably` package in pubspec, no
`package:ably` import anywhere in `app/lib`; only historical comments ("replaces Ably",
"ABLY-R2 phase" notes) and English words (relia**bly** etc.). The telemetry spam comes
from build 0.1.17, which predates the removal. **Clean — needs a new build** to stop the
AblyException presence spam in the field. No commit.

---

## Risks / assumptions

- **PERF-1:** `Analytics.captureException` in the error handlers can now run before
  `Analytics.init()` (init is deferred). If the Analytics wrapper does not queue/no-op
  pre-init, a crash in the first ~1s could be dropped. Same for `Analytics.capture`
  calls made by early widgets. (posthog_flutter generally queues; not verified.)
- **PERF-1:** `firebaseBackgroundHandler` registration also moved post-frame — for a
  cold start triggered BY a push, registration happens ~1 frame later; FCM re-delivers,
  so risk is low, but noted.
- **PERF-4:** after ProfileSetupScreen `onDone` re-runs `_load()`, the cached flag still
  says incomplete, so the setup screen may flash for ~100ms until the background
  `store.load()` (local read, first step of validateGates) flips it. Functional, mildly
  ugly; fix would be persisting the flag in the save path.
- **PERF-4:** a user who genuinely loses profile-completeness sees the app briefly
  before being routed to the gate — accepted by the spec's design.
- **PERF-5:** used `table.actualTableName` (present in drift 2.16; deprecated in favor of
  `entityName` in newer majors). CI build will confirm; trivial rename if it warns.
- **PERF-7:** the fix is client-side; OLD builds keep 422ing until updated. The
  `name_format` reject can also fire for legit labels with digits — those now send `''`
  (server keeps stored name), which is strictly better.
- No builds/analyze were run (per rules) — CI on the final merge is the compile gate.

## Supervisor review checklist

1. **Analytics pre-init queueing** — confirm `Analytics.capture`/`captureException`
   are safe (queue or no-op) before `Analytics.init()`; otherwise `first_frame_ms` order
   is fine but early exceptions may drop (app/lib/core/analytics.dart).
2. **PERF-2 deviation:** `_mintSessionJwt` catches `TimeoutException` per attempt so the
   cached-JWT fallback in `sessionToken()` survives — spec said "no change to logic" for
   sessionToken (unchanged) but didn't specify mint-loop behavior on the new throw. Review.
3. **PERF-4 onDone flash** (see risks) — decide whether to persist the flag directly in
   ProfileSetupScreen's save path.
4. **PERF-7:** decide whether the Worker should ALSO skip name moderation when the stored
   profile already has a vetted name, and/or whether `/api/profile` should return the
   moderation reject as 400 instead of 422 for client UX consistency.
5. **PERF-8:** schedule a new APK build so field devices stop running the Ably-era 0.1.17.
