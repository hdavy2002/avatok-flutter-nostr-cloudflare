# hf-app: the Android app

The Android app is the live website inside an Android shell ([Capacitor](https://capacitorjs.com)).
It does not contain the pages: it opens `https://<domain>` (from `Specs/brand.json`), and adds what a
website cannot do well: push notifications, camera/microphone permission, links that open the app,
the Android back button and an offline screen.

Spec: `Specs/SPEC-2026-10-10-HF-ANDROID-APP.md`. Rules: section 14 of `Specs/RULEBOOK-HELLO-FRAANDS.md`.

## What is here

| Path | What |
|---|---|
| `capacitor.config.ts` | App id, name, site URL, allowed hosts, user agent. All read from `Specs/brand.json`. |
| `scripts/brand.mjs` | Reads `Specs/brand.json`; also fills the brand name and site URL into the offline page. |
| `scripts/make-icons.mjs` | Draws the icon and splash sources into `assets/` (from the website's favicon artwork). |
| `www/offline.html` | Template of the "No internet" screen. The brand name is filled in by `brand.mjs` at build time. |
| `android/` | The Android project (committed). Domain, scheme and app name come from `Specs/brand.json` through `android/app/build.gradle`. |

Never type the brand name or domain in this folder; the brand-literal guard (`scripts/check_brand_literals.py`) enforces it.
The package id comes from `hfPlayPackageId` in `Specs/brand.json` and is permanent.

## How CI builds it

`.github/workflows/hf-android.yml` is started by hand only (`workflow_dispatch`, never on push) and only from `main`.

1. Node 22 and Java 21, `npm ci` in `hf-app/`.
2. `npx cap sync android`, then `node scripts/brand.mjs offline`.
3. The upload keystore is decoded from the secret `HF_UPLOAD_KEYSTORE_BASE64`. The build stops if it is missing (a release is never debug-signed).
4. `google-services.json` is written from the secret `HF_GOOGLE_SERVICES_JSON` only if that secret exists. Without it the app builds, but push notifications do not work.
5. `versionCode = 1000 + run number`, `versionName = 1.0.<run number>`.
6. Gradle `bundleRelease` (AAB) and/or `assembleRelease` (APK), signed with the upload key.
7. The artifacts are uploaded (`hf-app-aab`, `hf-app-apk`).
8. With `play_track=internal`, the AAB goes to the Play internal testing track (needs `PLAY_SERVICE_ACCOUNT_JSON`).

Secrets used: `HF_UPLOAD_KEYSTORE_BASE64`, `HF_UPLOAD_STORE_PASSWORD`, `HF_UPLOAD_KEY_ALIAS`, `HF_UPLOAD_KEY_PASSWORD`,
`HF_GOOGLE_SERVICES_JSON` (optional), `PLAY_SERVICE_ACCOUNT_JSON` (existing).

The upload key itself is kept (git-ignored) in `secrets/hf-upload.jks` with its passwords in `secrets/hf-upload.txt`.
Google Play App Signing holds the real app signing key.

## "ship hf" (magic words)

When the owner says **ship hf**, run:

```bash
gh workflow run hf-android.yml --ref main -f artifact=both -f play_track=internal
```

Then check the run, confirm the release shows in the Play Console's internal testing track, and report it.
The very first AAB of a new Play app must be uploaded by hand in the Console (Google's API refuses it);
after that `play_track=internal` works.

## Local work on a Mac

No Android SDK or Flutter is installed or wanted on the Mac; Gradle only runs in CI.
Node-only steps are fine here, inside `hf-app/`:

```bash
cd hf-app
npm ci --include=dev
npm run sync     # cap sync android + brand the offline page (no SDK needed)
npm run doctor   # cap doctor
npm run icons    # redraw icon/splash sources and regenerate the Android resources
```

Never run `npm install` in `web/` or `worker/`.

## Placeholders to know about

- The icon and splash are generated from the website's favicon artwork (speech bubble with a phone). Replace
  `scripts/make-icons.mjs` output with real artwork when the owner supplies a final logo, then `npm run icons`.
- `appendUserAgent` is `HelloFraandsApp/1`. Bump the number in `capacitor.config.ts` whenever the shell changes.
