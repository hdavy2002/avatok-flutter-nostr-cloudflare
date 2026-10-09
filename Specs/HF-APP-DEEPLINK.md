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
- Optional, nicer: verified https links for `https://<domain>/hosts/kyc/return` (the app opens without a prompt).
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
