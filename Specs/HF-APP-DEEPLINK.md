# HF-APP-DEEPLINK: coming back to the app after DigiLocker

Status: web side built (HF-HOST-POLISH-1). The Capacitor app project does not exist yet; this is what it must set up.
`<domain>` = `domain` in `Specs/brand.json`. `<scheme>` = first label of `<domain>` (so the custom scheme is `<scheme>://`).

## How the flow works
1. In the app (`window.Capacitor.isNativePlatform()` is true), the Aadhaar step asks the worker for a DigiLocker link with `returnPath=/hosts/kyc/return?app=1`, then opens it with `@capacitor/browser` (full screen). Code: `web/src/lib/nativeBridge.ts`, `AadhaarStep.tsx`.
2. DigiLocker finishes and lands on `https://<domain>/hosts/kyc/return?app=1` inside that in-app browser.
3. That page immediately sets `location.href = "<scheme>://hosts/onboarding?step=aadhaar&dl=return"` and also shows a "Back to the app" button with the same link.
4. The app receives the URL via `App.appUrlOpen`. Because it contains `dl=return`, the bridge closes the browser and the Aadhaar step runs its normal "complete" check. The same check also runs if the host just closes the browser (`browserFinished`).
On the plain web nothing changes: DigiLocker returns to `/hosts/onboarding?step=aadhaar&dl=return`, and `/hosts/kyc/return` without `app=1` simply forwards there.

## What the Capacitor app must configure
- Plugins: `@capacitor/browser` and `@capacitor/app` (`npm i` + `npx cap sync`). The web code reads them from `window.Capacitor.Plugins`; if missing it falls back to a full-page redirect.
- Custom scheme `<scheme>://`:
  - Android: in `AndroidManifest.xml`, on the main activity (launchMode `singleTask` recommended):
    ```xml
    <intent-filter>
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="<scheme>" />
    </intent-filter>
    ```
  - iOS: `Info.plist` `CFBundleURLTypes` with `CFBundleURLSchemes` = [`<scheme>`].
- Verified https links for the whole site (`[HF-APP-LINKS-1]`, see the section at the end). The original, narrower idea was only `https://<domain>/hosts/kyc/return`.
  - Android App Links: add an intent-filter with `android:autoVerify="true"`, `<data android:scheme="https" android:host="<domain>" android:pathPrefix="/hosts/kyc/return" />`. The site already serves `web/public/.well-known/assetlinks.json`. It currently lists two `android_app` targets (`ai.avatok.avatok_call` and `com.saathum.app`, each with two SHA-256 fingerprints). Add (or reuse, if the app ships as `com.saathum.app` = `playPackageId` in brand.json) an entry for the new app: `package_name` = the app's id, `sha256_cert_fingerprints` = the signing cert(s), including the Play App Signing certificate from Play Console.
  - iOS Universal Links: add the Associated Domains entitlement `applinks:<domain>` and serve `web/public/.well-known/apple-app-site-association` (no extension, JSON, content-type application/json), which does not exist yet:
    `{"applinks":{"details":[{"appIDs":["<TEAMID>.<bundle id>"],"components":[{"/":"/hosts/kyc/return*"}]}]}}`
  - The custom scheme above is still needed as the fallback the return page uses.

## Testing
- Android (device or emulator, app installed):
  `adb shell am start -a android.intent.action.VIEW -d "<scheme>://hosts/onboarding?step=aadhaar&dl=return"`
  The app should come to the front and the Aadhaar step should start its check.
- Return page in a normal browser: `https://<domain>/hosts/kyc/return?app=1` should show "DigiLocker is done" and try the scheme link; without `?app=1` it should forward to `/hosts/onboarding?step=aadhaar&dl=return`.
- iOS simulator: `xcrun simctl openurl booted "<scheme>://hosts/onboarding?step=aadhaar&dl=return"`.
- Worker: `returnPath` must stay a same-site path starting with "/" and at most 200 chars; `/hosts/kyc/return?app=1` fits.

## Every site link opens the app (`[HF-APP-LINKS-1]`, 2026-10-10)

Owner decision: any https link to the site that is tapped on an Android phone with the app installed opens the app (emails, WhatsApp, SMS, other apps). Typing the address in Chrome still opens the site.

### What makes it work (both app generations)
1. `https://<domain>/.well-known/assetlinks.json` and `https://www.<domain>/.well-known/assetlinks.json` answer **200, `application/json`, no redirect**, and list `hfPlayPackageId` with the Play App Signing and upload SHA-256s. Source: `web/public/.well-known/assetlinks.json`.
2. `/.well-known/*` must stay in `exclude` of `dist/_routes.json` (set in `web/astro.config.mjs`). On 2026-10-10 the file answered 404 "Not found" on the brand host because the adapter cuts excludes at Cloudflare's 100-rule limit, the request reached the SSR Function, and `pages/[username]/[slug].astro` returned its 404 for `/.well-known/assetlinks.json`. `web/scripts/check-assetlinks.mjs` (part of `check-release-contracts.mjs`) and a post-deploy curl in `web-deploy.yml` now fail the deploy if this regresses.
3. The app declares one verified filter for the whole host, apex and www, any path (the Capacitor app does this in `hf-app/android/app/src/main/AndroidManifest.xml`, host names filled from `Specs/brand.json` by `build.gradle`):
```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" />
  <data android:host="<domain>" />
  <data android:host="www.<domain>" />
</intent-filter>
```
   plus the custom scheme `<scheme>://` filter (DigiLocker fallback), activity `launchMode="singleTask"`.
4. Android verifies at install time. After the assetlinks fix is deployed, an already-installed build re-verifies on its own within a day, or immediately with `adb shell pm verify-app-links --re-verify <package>`; check with `adb shell pm get-app-links <package>` (both hosts must say `verified`).

### Interim Capacitor app
`web/src/lib/appMode.ts` handles `App.appUrlOpen` (app running) and `App.getLaunchUrl()` (cold start, once per app process). It only follows https links on the apex or `www`; `www` is folded onto the apex so the WebView keeps one origin and its sign-in. DigiLocker returns (`dl=return`, `/hosts/kyc/return`) are left to `nativeBridge.ts`. Telemetry: `hf_app_deeplink_opened {path, launch}`.

### Native app (Flutter) requirements
- Package `com.hellofraands.app` (same as the Capacitor app, so it replaces it in place and keeps the same assetlinks entry and signing). Same manifest filter as above; same custom scheme filter.
- Read the launch link (`app_links` plugin: `getInitialLink()` for cold start, the link stream when running). Accept only `https` and host `<domain>` or `www.<domain>`; ignore everything else. Drop the query before logging; send `hf_app_deeplink_opened {path, launch}` with ids/slugs/tokens replaced by `:id` (same rule as `deepLinkTelemetryPath` in `appMode.ts`).
- If the person is signed out and the screen needs sign-in, keep the target, sign in, then go to it. Never drop them on the home screen.
- A path the app has no screen for, or an unknown path, opens the site page in an in-app web view (never a dead end). Never route to `/admin/*` in the app (the push path guard already rejects it).
- Do not claim `/.well-known/*`, `/_astro/*`, `/api/*`. (Those are not user links.)
- Push taps carry `data.path` (same-site path); route it with the same table.

### Path to screen (what the worker puts in emails, WhatsApp and push)
| Path | Sent by | Screen to open |
|---|---|---|
| `/h/<slug>` | WhatsApp "is online now" (`lib/hf_notify.ts`), push `notify_me` | Host profile with the Call button |
| `/review/<token>` | WhatsApp "How was your call" (`lib/hf_reviews.ts`), push `review_request` | Review screen for that call (token is the credential, no sign-in) |
| `/wallet` | Push `low_balance`; Razorpay top-up return (`routes/hf_topup.ts`, `WALLET_RETURN_URL`); `wallet-terms` links | Wallet. A top-up return may carry query params; pass them through so the status check runs |
| `/hosts/dashboard` | Push `host_approved`, `host_changes`, `withdrawal_approved`, `withdrawal_paid` | Host dashboard (earnings, profile status, withdrawals) |
| `/hosts/onboarding?step=preview` | WhatsApp "profile is ready to check" (`workflows/host_media.ts`) | Host onboarding at the profile preview step |
| `/hosts/onboarding?step=aadhaar&dl=return` | Custom scheme `<scheme>://hosts/onboarding?...` from the DigiLocker return page | Host onboarding, Aadhaar step runs its completion check |
| `/hosts/kyc/return?app=1` | DigiLocker redirect (`routes/hf_host_kyc.ts`) | Not a screen: close the in-app browser and run the Aadhaar completion check, then show onboarding |
| `/hosts/join`, `/hosts/rules`, `/hosts/rates`, `/hosts/requirements`, `/hosts/agreement`, `/hosts/crisis-script`, `/hosts/kyc` | Site pages, host recruiting links | Matching host-onboarding or policy screen; if none, web view |
| `/people/<name>`, `/verify/lane` | Site sample profiles and verification explainer (not sent by the worker) | Web view, or the matching screen once it exists |
| `/` and any other site page (help, terms, refunds, privacy, safety...) | Footer links, shared pages | Home for `/`; in-app web view for policy and help pages |

Links the worker sends that are NOT Hello Fraands screens (shop `/dashboard/orders`, guides `/guides/*`, `/desk/*`, event `/book/<id>`, `/watch/<id>`) belong to the other products on the same host; the native HF app should open them in the web view, not claim a screen.

### Audit result (2026-10-10)
No user-facing Hello Fraands link points at the `api.` host, a legacy domain, or `http://`. The only `api` URL built in HF code is the Vobiz webhook (`lib/hf_calls_store.ts`), which is a server callback, not a link a person taps. `WEB_BASE_URL` and `WALLET_RETURN_URL` in `worker/wrangler.toml` use the brand domain.

### Test on a phone
1. Install a build with this manifest (`adb shell pm get-app-links <package>` should list the apex and `www` as `verified`).
2. Send yourself `https://<domain>/h/<a host slug>` by WhatsApp and by email; tap each. The app opens (no browser, no "open with" chooser) on that host page. Repeat with the app force-stopped (cold start).
3. Tap `https://www.<domain>/wallet`: app opens on the wallet.
4. Tap a link from an app that uses an in-app browser (Gmail): the app should still take it. If not, long-press the link and check "Open by default" in Settings > Apps > Hello Fraands (links toggle on).
5. A DigiLocker round trip still comes back to the Aadhaar step.
6. PostHog: `hf_app_deeplink_opened` with `path = /h/:id` and `launch = cold` / `warm`.
