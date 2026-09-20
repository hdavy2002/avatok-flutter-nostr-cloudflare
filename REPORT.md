# SAATHUM-PKG-1 — separate Android package (com.saathum.app)

## Scope

Turned the Android build into a brand-new Play Store listing so existing
avaTOK testers on `ai.avatok.avatok_call` never receive this as an update.
Old applicationId: `ai.avatok.avatok_call` (staging suffix `.staging`). New:
`com.saathum.app` (staging: `com.saathum.app.staging`). iOS bundle id was
**not** touched, per the task. Not deployed, not pushed to `main` — committed
locally on `saathum/15-new-package` only, via `scripts/git_safe_commit.py`.

## 1. `app/android/app/build.gradle.kts`

`namespace` and `applicationId` changed to `com.saathum.app`. Updated the
adjacent comment (Firebase/staging note) to match and point at the
google-services.json gap below.

## 2. Kotlin source moved to the new package directory

The app's own package (as opposed to the unrelated sibling packages
`ai.avatok.avadial`, `ai.avatok.avavision`, `ai.avatok.avavoiceaudio`,
`ai.avatok.callrecord`, `ai.avatok.calltranslation`, which are just Kotlin
namespaces unrelated to the applicationId and were left alone) had exactly
four files under `ai/avatok/avatok_call/`:

- `MainActivity.kt`
- `AvaTokApplication.kt`
- `NativeCallDeclineBridge.kt`
- `NativeCallPrewarmBridge.kt`

All four were `git mv`'d to `app/android/app/src/main/kotlin/com/saathum/app/`
and their `package ai.avatok.avatok_call` line changed to `package
com.saathum.app`. The old now-empty `ai/avatok/avatok_call/` directory was
removed.

**Cross-references fixed** — these sibling-package files referenced the old
package's `MainActivity` and generated `R` class by fully-qualified name (they
would **not compile** against the new namespace otherwise):

- `ai/avatok/avadial/AvaCallActionReceiver.kt`, `AvaInCallService.kt`,
  `AvaSmsReceiver.kt`, `IncomingCallActivity.kt` — `Class.forName(...)` /
  `setClassName(...)` calls targeting `MainActivity`.
- `ai/avatok/avadial/InCallActivity.kt`, `IncomingCallActivity.kt` — `import
  ai.avatok.avatok_call.R` (the generated resource class lives under the
  module `namespace`, which just changed).
- `ai/avatok/avavoiceaudio/CallForegroundService.kt` — a `MainActivity`
  launch intent and two `R.drawable` references.

All updated to `com.saathum.app.MainActivity` / `com.saathum.app.R`.

## 3. AndroidManifest / provider authorities / intent-filter hosts

- `app/android/app/src/main/AndroidManifest.xml`: no literal package string in
  functional XML. The `FileProvider`-style authority
  (`android:authorities="${applicationId}.SuperClipboardDataProvider"`) and
  the signature-permission name (`${applicationId}.PERMISSION_CALL`) already
  use the Gradle `${applicationId}` placeholder, so they resolve automatically
  — nothing to change. The `<queries>`/intent-filter hosts are all
  `avatok.ai` (a domain, not the Android package) and were left as-is; the
  task only asked about hosts that embed the package name, and none do. One
  explanatory **comment** (line ~479, inside the Play-Store-deep-link
  historical bug writeup) still names `ai.avatok.avatok_call` — left
  unchanged, see "Deliberately unchanged" below.
- `app/packages/stream_call_bridge/android/src/pilot/AndroidManifest.xml`
  (the Stream pilot build-variant manifest overlay): `android:name` for
  `MainActivity` updated to `com.saathum.app.MainActivity`.

## 4. Repo-wide literal sweep (`ai.avatok.avatok_call`)

Updated every occurrence that is about *this app's* current/live Android
package:

- **CI**: `.github/workflows/android.yml` (Play-guard error messages, the
  `packageName:` field for the Play publish step), `.github/workflows/
  verify.yml`.
- **CI — the actual applicationId source, not just the literal string**:
  both `android.yml` and `verify.yml` run
  `flutter create --platforms=android --org ai.avatok --project-name
  avatok_call .` before `postcreate.py` patches the generated project. This
  flag pair, not just the checked-in `build.gradle.kts`, is what determines
  the applicationId/namespace Flutter's own template writes. Changed to
  `--org com.saathum --project-name app` in both files (`macos.yml` and
  `avaconsult.yml` use the same old org for a *different* platform / a
  *different* app respectively and were deliberately left alone — see
  below).
- **Dart**: `app/lib/core/config.dart` (a doc comment and the Closed-Alpha
  testing-track URL constant).
- **Web**: `web/public/.well-known/assetlinks.json` (`package_name`),
  `web/src/islands/listing/MessageHost.tsx`, `web/src/components/
  StartInApp.tsx`, `web/src/pages/add.astro`, `web/src/lib/config.ts` (doc
  comment), `web/src/landing/avatok-listings-catalogue.html` (all Play Store
  URLs / App-Links package).
- **Worker/consumers**: `worker/wrangler.toml` (`PLAY_PACKAGE_ID`, both prod
  and staging sections), `worker/src/play.ts`, `worker/src/routes/
  affiliate.ts` (fallback defaults for the same var).
- **marketing/public/_worker.js**: booking-page intent URL, assetlinks
  fallback, Play Store link.
- **Scripts**: `scripts/dev-emulator.sh`, `scripts/push_apk.sh` (dead per the
  no-local-toolchain rule, but still "about this app's package" so updated
  for correctness/consistency), `scripts/patch_callkit_native_decline.py`
  (four `Class.forName("...NativeCallDeclineBridge")` reflection strings —
  these must match wherever `NativeCallDeclineBridge` actually now lives).
- **tool/avatok-freeze/postprocess-dist.test.mjs**: a test fixture URL,
  updated for consistency (the test only exercises generic URL-liveness
  logic, no behaviour depends on the exact id).
- **Templates**: `app/android/app/google-services.json.example` and
  `firebase/google-services.json.example` — these are *templates*, not
  registrations, so updating their `package_name` fields is safe and keeps
  them useful as a guide for the new Firebase app (see §5).
- **Docs**: `CONFIG.md`, `PLAY-STORE-SETUP.md`, `Specs/
  SPIKE-2026-07-12-avadial-telecom.md` — live/forward-looking config
  references, updated with a note pointing at this report.

## 5. google-services.json — NOT fabricated, real gap flagged

Per the task, the three **real** registration files were left byte-for-byte
untouched:

- `app/android/app/google-services.json`
- `firebase/google-services.json`
- `firebase/google-services-staging.json`

All three still register only `ai.avatok.avatok_call` /
`ai.avatok.avatok_call.staging` under Firebase project `avatok-e19ef`.
**`app/tool/postcreate.py`'s `patch_firebase()` copies `firebase/
google-services.json` (or `firebase/google-services-staging.json` when
`AVATOK_ENV=staging`) over `android/app/google-services.json` on every CI
run** — so the committed `app/android/app/google-services.json` is a decoy;
the real source of truth is the `firebase/` copy.

**This is a real build/runtime blocker, not just cosmetic:**

- The Google Services Gradle plugin (`com.google.gms.google-services`)
  fails the build if no `client` entry in `google-services.json` matches the
  module's `applicationId`. With `applicationId = com.saathum.app` and no
  matching entry, **the Gradle build will fail** the moment this plugin runs
  — or, if enforcement is lenient, is silently skipped and FCM never
  initializes.
- Even if the build somehow succeeds, without a Firebase Android app
  registered for `com.saathum.app`, FCM tokens cannot be issued/validated,
  so push (call ringing, chat notifications, update prompts) is dark.

**Action required before this can ship a working build:** register a new
Firebase Android app for `com.saathum.app` (and, if staging installs
side-by-side, `com.saathum.app.staging`) — either in the existing
`avatok-e19ef` project or a fresh one — download the resulting
`google-services.json`, and replace `firebase/google-services.json` (and
`firebase/google-services-staging.json` if used). The `.example` templates
in this diff already show the expected shape with the new package name.

## 6. External systems that must be updated for the new package

- **Firebase / FCM** — see §5. New Android app registration + fresh
  `google-services.json`.
- **Google OAuth Android client** (used by "Sign in with Google", if wired)
  — any OAuth client of type "Android" registered in Google Cloud Console
  under the old `ai.avatok.avatok_call` package + SHA-1 needs a **new**
  Android OAuth client for `com.saathum.app` with the new signing
  certificate's SHA-1. Not found wired into this codebase directly (no
  `google_sign_in` package reference turned up in the sweep), but flagging
  per the task — verify against whatever signs in via Google before shipping.
- **`web/public/.well-known/assetlinks.json`** — `package_name` updated to
  `com.saathum.app` in this diff, but the `sha256_cert_fingerprints` array
  still lists the **old app's signing certificates**
  (`C9:8F:...` / `76:31:...`, the latter matching `PLAY-STORE-SETUP.md`'s
  `avatok-upload` alias). A brand-new Play Store listing will very likely be
  signed with a **different** upload/app-signing key (Play App Signing
  mints a new one on first upload unless deliberately reusing the old
  keystore). **These fingerprints must be regenerated from whatever keystore
  ends up signing `com.saathum.app`**, or Android App Links verification
  will silently fail for the new app.
- **Play Console** — a brand-new app listing must be created for
  `com.saathum.app`; the "first upload" signing-key enrollment
  (`PLAY-STORE-SETUP.md` §5) happens fresh for it.
- **`secrets/avatok-upload.jks`** — decide whether the new app reuses this
  upload keystore (simplest, if intentional) or needs its own. Either way,
  the CI secrets (`ANDROID_UPLOAD_KEYSTORE_BASE64` etc.) and
  `PLAY_SERVICE_ACCOUNT_JSON` (a Play Console service account scoped to a
  package) need to be confirmed/re-scoped for the new listing before
  `play_track != none` can work.
- **Clerk "native application" allowed package** — if Clerk's native/mobile
  SDK config allowlists Android package names (Clerk's dashboard has an
  "Android package name + SHA-256" field for native OAuth redirects), a new
  entry for `com.saathum.app` (with its SHA-256) needs adding — not found
  hardcoded in this repo (Clerk config is dashboard-side), flagged for the
  owner to check.
- **PostHog / other SDKs configured with a bundle/package allowlist** —
  none found hardcoded in this repo referencing the Android package
  specifically; worth a quick check in any dashboard-side allowlists.

## 7. Deliberately left unchanged (verified — genuinely NOT about this app's
current Android package, or explicitly out of scope)

| File:line | Why left alone |
|---|---|
| `consumers/src/apns.ts:20` | `APNS_BUNDLE_ID` default — this is the **iOS** APNs topic (bundle id), not the Android package, despite sharing the same literal string historically. Task: "DO NOT change the iOS bundle id." |
| `Specs/SPEC-2026-08-24-PHASE-2-GETSTREAM-LIVE-CONSULT-MARKETPLACE.md:802` | A dated verification log entry ("staging app installed as `ai.avatok.avatok_call.staging`, build 10622...") — a historical record of a specific past test run, not current config. Rewriting it would falsify history. |
| `reports/11-resweep.md:199` | A dated audit/sweep report snapshotting identifiers *as they were* on that date. Historical record, not live config. |
| `_backups/2026-07-01-call-search-recept-fixes/worker/wrangler.toml` (both occurrences) | Inside `_backups/` — an archived historical snapshot, not live config. |
| `CLAUDE.md:76` | The repo's own root project-instructions file (describes the now-dead local `push_apk.sh`/"ship local" flow). Not an app config target of this task; editing project instructions is out of scope here. |
| `web/src/landing/archive/2026-09-09-before-railway/avatok-listings-catalogue.html` | Inside `archive/` — an explicitly archived historical snapshot of the landing page. |
| `app/android/app/google-services.json`, `firebase/google-services.json`, `firebase/google-services-staging.json` | Per task item 5 — real Firebase registrations for the OLD package; must not be fabricated. See §5/§6. |
| `.github/workflows/macos.yml` (`--org ai.avatok --project-name avatok_call`) | Drives the **macOS** build's bundle identifier, a different platform the task didn't ask about. Changing it would rename the macOS app's identity as a side effect — left alone; flag separately if macOS should also split. |
| `.github/workflows/avaconsult.yml` (`--org ai.avatok --project-name avaconsult`) | A **different Flutter app** (`avaconsult`) in the same repo, unrelated to this rename. |

## 8. Verification

No local Flutter/Android toolchain exists on this machine (removed
2026-09-10 per `CLAUDE.md`, not reinstalled). Verification here is a
mechanical repo-wide grep, not a real Gradle/Kotlin compile:

```
grep -rn "ai\.avatok\.avatok_call" . \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.dart_tool --exclude-dir=build
```

Every remaining hit is one of the nine deliberately-unchanged cases in §7
(each individually re-checked above), plus this report and the doc edits
that *mention* the old id by name for context. CI (`android.yml` /
`verify.yml`, which now regenerate the platform project with `--org
com.saathum --project-name app`) is the real compile net and must be run to
confirm the Kotlin cross-references and Gradle config actually build — not
done here per "DO NOT deploy."

## What was NOT done

- No build was triggered, no deploy, no push to `main`.
- iOS bundle id: untouched.
- Flutter/Dart package name (`avatok_call` in `pubspec.yaml`, used e.g. by
  `package:avatok_call` in `analytics.dart`'s error-tracking in-app include
  list, and by every `avatok_call`-prefixed storage key/variable name in
  `app/lib/**`) — **not renamed**. The task asked only about the Android
  applicationId/package, not the Dart project name; these are independent
  and renaming the Dart package is a materially larger, separate change.
- No new `google-services.json`, Play listing, OAuth client, or signing key
  was created — all flagged in §5/§6 for the owner to action outside this
  repo.
