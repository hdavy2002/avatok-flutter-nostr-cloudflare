# Play Store upload setup

Generated **2026-06-12**. One-time setup so CI can produce signed `.aab` builds for Play Console Internal testing.

## 1. Back up the keystore (CRITICAL)

The upload keystore lives at `secrets/avatok-upload.jks` (gitignored).
If you ever lose it, **you can never push another update to this Play Store listing**.

- Copy `secrets/avatok-upload.jks` to 1Password / iCloud Drive / wherever you back things up.
- Passwords are in `secrets/secret-values.env` (search for `ANDROID_UPLOAD_`).

Certificate fingerprints (for any service that asks — Firebase, Google sign-in, etc.):

```
SHA1   73:A1:37:EF:97:D8:1A:16:23:D1:D8:5E:76:06:57:A8:BC:66:3A:4D
SHA256 76:31:21:81:58:AA:01:C4:1F:C6:F1:99:23:CF:3B:01:46:29:40:E6:70:A4:0F:A9:CB:1F:51:92:73:A8:6A:4C
Alias  avatok-upload
```

## 2. Add 4 GitHub Actions secrets

Open https://github.com/<your-user>/avaTOK-2-Flutter/settings/secrets/actions and add:

| Name | Value | Source |
| --- | --- | --- |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | contents of `secrets/avatok-upload.jks.base64` | `cat secrets/avatok-upload.jks.base64 \| pbcopy` |
| `ANDROID_UPLOAD_STORE_PASSWORD` | `qiRHhFUlgLB3xhPSvPStYO9E` | secret-values.env |
| `ANDROID_UPLOAD_KEY_ALIAS` | `avatok-upload` | secret-values.env |
| `ANDROID_UPLOAD_KEY_PASSWORD` | `CrbfWLuOn6jmyWvEfx3zOak3` | secret-values.env |

Or via `gh` CLI (run from repo root):

```sh
gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64 < secrets/avatok-upload.jks.base64
gh secret set ANDROID_UPLOAD_STORE_PASSWORD --body 'qiRHhFUlgLB3xhPSvPStYO9E'
gh secret set ANDROID_UPLOAD_KEY_ALIAS      --body 'avatok-upload'
gh secret set ANDROID_UPLOAD_KEY_PASSWORD   --body 'CrbfWLuOn6jmyWvEfx3zOak3'
```

## 3. Trigger a build

Push anything to `main` (or run the workflow manually from Actions tab).
CI will produce:

- `dist/avatok-call.aab` — the file you upload to Play Store
- Attached to the GitHub Release tag `calltest-latest` for download

The `.aab` is **only** built on the `main` branch and only when all 4 secrets are set.
APK builds (used for side-load testing) are unchanged and keep using the debug keystore.

## 4. Upload to Play Console

1. Download `avatok-call.aab` from the `calltest-latest` release (or the workflow run artifacts).
2. Go back to https://play.google.com/console → Internal testing → Create new release.
3. Drag `avatok-call.aab` onto "Drop app bundles here to upload".
4. Fill in release name + release notes, click Save → Review release → Start rollout.
5. Add testers under **Internal testing → Testers** (a Google Group or list of emails, max 100).

## 5. Watch for these gotchas

- **versionCode collision** — the workflow builds with `versionCode = 10000 + GITHUB_RUN_NUMBER`. If you ever upload a build with a lower versionCode than one already on the track (rejected or not), Play Console will reject it. Bump and rebuild.
- **applicationId mismatch** — Play Console locks the listing to `ai.avatok.avatok_call`. Don't change `applicationId` in the gradle file.
- **First-time signing key choice** — when you upload the first `.aab`, Play Console will ask whether to enroll in Play App Signing. **Say yes** (default). It means Google holds the *signing* key, you hold the *upload* key — if you ever lose `secrets/avatok-upload.jks` you can request a reset. Without Play App Signing there's no recovery.
- **Firebase / Google sign-in** — Play App Signing changes the SHA1 that runs in production. After your first upload, go to Play Console → Setup → App integrity, copy the **App signing key certificate** SHA1, and add it to Firebase (`firebase_options.dart` consumers don't care, but any SHA1-pinned API does).

## How signing works in this repo (for future-you)

- `tool/postcreate.py → patch_signing()` injects TWO signing configs into the generated `android/app/build.gradle.kts`:
  - `debug` — uses the committed `android-keystore/debug.keystore.base64` (so every side-load APK has the same signature, no uninstall needed between builds)
  - `release` — reads from env vars `ANDROID_UPLOAD_KEYSTORE_PATH` / `_STORE_PASSWORD` / `_KEY_ALIAS` / `_KEY_PASSWORD`
- The `release` buildType picks `release` when `ANDROID_UPLOAD_KEYSTORE_PATH` is set, otherwise falls back to `debug`.
- `.github/workflows/android.yml` step "Decode upload keystore" writes the keystore from the secret into `$RUNNER_TEMP` and sets those env vars only for the `flutter build appbundle` step. The APK steps run without those env vars, so they keep using the committed debug keystore.
