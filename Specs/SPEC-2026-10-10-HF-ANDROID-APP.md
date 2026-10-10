# SPEC — Hello Fraands Android app (Capacitor wrapper) · `HF-APP-*`

Status: **PROPOSED, waiting for owner approval** · Written 2026-10-10 · Owner: Davy
Work is done by Claude end to end: code, CI builds, and Google Play Console in the browser.

---

## 0. In simple words

- The app is **the Hello Fraands website inside an Android shell** (Capacitor). We do not rebuild the pages.
- The shell adds the things a website can't do well: **push notifications, proper camera/mic permission, links that open the app, a bottom tab bar, the Android back button, an offline screen.**
- Fixes to the website reach the app instantly. A new Play build is only needed when the shell itself changes.
- Package name: **`com.hellofraands.app`** (owner decision 2026-10-10, permanent). A new Play app, separate from avaTOK and Saathum.
- First builds go to Play **Internal testing**, just the owner (owner decision 2026-10-10). No Google review, builds reach the phone in minutes.
- Play Console account rule: **before any Play Console step, confirm the browser is signed in as `hdavy2005@gmail.com` and the developer account shown is "AvaGlobal Inc, Delaware, USA" (ID 6032333068668680495, personal account of Humphrey Davy). It is reached at `play.google.com/console/u/1/` because `u/0` is a different Google account (hdavy2002)** If not, stop and tell the owner. Never act in any other Google account.
- Real money stays off. Nothing in this plan turns it on.

---

## 1. Decisions

| ID | Decision | Status |
|---|---|---|
| HF-APP-D1 | Wrap the website with Capacitor; no Flutter rebuild, no page rebuild. | ADOPTED 2026-10-09 |
| HF-APP-D2 | Package `com.hellofraands.app`. Never reuse `com.saathum.app` (would put "saathum" in the Play link forever). | ADOPTED 2026-10-10 |
| HF-APP-D3 | First track: Internal testing, tester = hdavy2005@gmail.com only. | ADOPTED 2026-10-10 |
| HF-APP-D4 | Play Console work only in `hdavy2005@gmail.com` / Ava Global International, Inc.; checked every time. | ADOPTED 2026-10-10 |
| HF-APP-D5 | The app loads the live site (`https://<domain>` from `Specs/brand.json`), not a bundled copy. The site is server-rendered on Cloudflare, so it can't be bundled anyway. A small bundled offline page is shown when there is no network. | PROPOSED |
| HF-APP-D6 | Calls stay normal phone calls through Vobiz. The app adds **no** phone, SMS, contacts or call-log permissions (they trigger Play's strict sensitive-permission review and are not needed). | PROPOSED |
| HF-APP-D7 | Admin pages stay web-only. The app never links to `/admin/*` (they still open if typed, behind admin auth). | PROPOSED |
| HF-APP-D8 | ~~Top-up hidden in the app~~ **Superseded 2026-10-10:** callers buy **tokens with Google Play Billing inside the app**. The website cannot use Play Billing, so `/wallet` on the web says "Download the app to add tokens". No UPI, BaseUPI or Paytm checkout for customers at launch. Full model in §11. | ADOPTED 2026-10-10 |
| HF-APP-D11 | Calls paid with Play tokens are started **only in the app** (Play rule: in-app currency is used in the app). On the website the Call button says "Open the app to call"; admin test credits still work on the web. | ADOPTED 2026-10-10 |
| HF-APP-D9 | Push notifications are added, with WhatsApp kept as the fallback for people on the website. | PROPOSED |
| HF-APP-D10 | New upload key for this app only (`hf-upload.jks`), and Google Play App Signing holds the real app key. | PROPOSED |

---

## 2. Architecture

```
Phone
└─ Hello Fraands app (com.hellofraands.app, Capacitor)
   ├─ Android WebView  ──loads──►  https://<domain>  (Astro site on Cloudflare, same as web)
   │     user agent gets " HelloFraandsApp/<shellVersion>"
   ├─ Native plugins (exposed as window.Capacitor.Plugins)
   │     App (deep links, back button) · Browser (DigiLocker) · PushNotifications (FCM)
   │     StatusBar · SplashScreen · Network (offline screen)
   └─ www/offline.html (bundled, shown when the site can't load)

Cloudflare (unchanged stack)
├─ web/      — gains "app mode" (tab bar, back button, safe areas, hidden footer)
├─ worker/   — gains push token routes + HF push sends
└─ consumers/src/fcm.ts — existing FCM sender, reused (Firebase project avatok-e19ef)
```

The website already has `web/src/lib/nativeBridge.ts` (`isNativeApp()`, `openAuthInApp()`), and the DigiLocker return flow is built (`Specs/HF-APP-DEEPLINK.md`). This spec builds the app side that file asks for.

### 2.1 Where the code lives

- `hf-app/` at the repo root: the Capacitor project (`package.json`, `capacitor.config.ts`, `www/offline.html`, `android/`).
- Name, domain and scheme are read from `Specs/brand.json` at build time by a small script (`hf-app/scripts/brand.mjs`). Never type the brand or domain in `hf-app/` (brand-literal guard applies).
- `.github/workflows/hf-android.yml`: the build workflow.
- Web changes in `web/src/lib/nativeBridge.ts`, a new `web/src/components/AppTabBar.astro`, and global CSS.
- Worker changes under the existing HF routes.

### 2.2 Capacitor config (shape)

```ts
appId: 'com.hellofraands.app'
appName: BRAND.name                        // "Hello Fraands"
webDir: 'www'                              // offline.html + icons only
server: {
  url: `https://${BRAND.domain}`,
  errorPath: 'offline.html',
  allowNavigation: [BRAND.domain, BRAND.hosts.api, BRAND.hosts.auth, BRAND.hosts.media],
  androidScheme: 'https',
}
android: { appendUserAgent: 'HelloFraandsApp/1' }   // version bumped when the shell changes
plugins: { SplashScreen: {...}, PushNotifications: { presentationOptions: ['badge','sound','alert'] } }
```

- Anything outside `allowNavigation` (WhatsApp, the DigiLocker site, other sites) opens outside the app. `tel:` and `https://wa.me` links go to the phone's dialer and WhatsApp.
- Capacitor version: latest stable at build time, pinned exactly in `package.json`. Use `npm ci` only, inside CI. **Never `npm install` on the Mac's shared folder** (sandbox-npm trap).
- `minSdk` 24. `targetSdk` = Play's current minimum for new apps (check the Play Console requirement on the day; expected API 36 in 2026). Edge-to-edge is enforced on new targets, so safe areas (§5) are required, not optional.

### 2.3 Android manifest

Permissions, the complete list:
- `INTERNET`
- `CAMERA`: selfie video during host KYC
- `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`: voice intro and the selfie video's sound
- `POST_NOTIFICATIONS`: push (Android 13+)

Nothing else. **Never** add `CALL_PHONE`, `READ_PHONE_STATE`, `READ_CONTACTS`, `READ_CALL_LOG`, any SMS permission, or location.

Main activity: `launchMode="singleTask"` plus intent filters for:
1. Custom scheme `<scheme>://` (`hellofraands://`), the DigiLocker fallback the return page already uses.
2. Verified App Links: `https` + `<domain>` with `autoVerify="true"` for `/hosts/kyc/return`, `/h/`, `/people/`, `/wallet`, `/verify/` (host profiles and wallet links from WhatsApp messages open in the app).

---

## 3. Phases

Each phase is one issue id, one worktree and one branch, landed the same day (repo RULE 3). Every phase that touches `worker/` or `web/` adds its `tool/ship_manifest.json` entry and its telemetry (§8).

### HF-APP-0 — Play Console setup (browser) · *Claude, owner only for any Google sign-in prompt*
1. Open Chrome and go to play.google.com/console. **Check the account:** the avatar menu must show `hdavy2005@gmail.com` and the developer account must be **Ava Global International, Inc.** Take a screenshot as proof. If either is wrong, stop and tell the owner.
2. Create app: name from brand.json ("Hello Fraands"), default language English (India), App, Free. Accept the declarations.
3. Internal testing: create the tester list "HF internal" with `hdavy2005@gmail.com`. Copy the opt-in link.
4. Users & permissions: give the existing CI service account (the one inside the GitHub secret `PLAY_SERVICE_ACCOUNT_JSON`) "Release to testing tracks" on the new app only.
5. The first AAB must be uploaded **by hand in the Console** (Google's API refuses uploads for an app that has never had a bundle). Download the CI artifact from HF-APP-1, upload it in the browser, and accept **Play App Signing** with a Google-generated key.
6. From App integrity, copy the **app signing SHA-256** and the **upload key SHA-256**. These feed HF-APP-2 and Firebase.
7. Fill in only the forms Play requires before an internal release. Leave the full store listing to HF-APP-7.

Done when: the app exists under Ava Global International, Inc., internal release #1 is rolled out, and the opt-in link works.

### HF-APP-1 — Capacitor shell and CI build
- Scaffold `hf-app/` (Capacitor + Android platform). The plugins are `@capacitor/app`, `browser`, `push-notifications`, `status-bar`, `splash-screen` and `network`.
- Generate `hf-upload.jks`, a new upload key for this app only. Store it as GitHub secrets `HF_UPLOAD_KEYSTORE_BASE64`, `HF_UPLOAD_STORE_PASSWORD`, `HF_UPLOAD_KEY_ALIAS` and `HF_UPLOAD_KEY_PASSWORD`, plus an encrypted copy in `secrets/` (git-ignored). Never commit the key or the passwords.
- Icon and splash: made from the Hello Fraands logo (adaptive icon, monochrome icon, splash on the brand background).
- `hf-android.yml`: `workflow_dispatch` only. Inputs: `artifact` = `apk|aab|both` (default `both`) and `play_track` = `none|internal` (default `none`). Steps:
  1. Guard that it is running from `main`.
  2. Node 22, Java 21, `npm ci` in `hf-app`.
  3. Generate the brand config, then `npx cap sync android`.
  4. `versionCode = 1000 + run_number`, `versionName = 1.0.<run_number>`.
  5. Gradle `bundleRelease` / `assembleRelease`, signed with the HF upload key. Fail if the key is missing; never debug-sign an AAB.
  6. Upload the artifacts.
  7. If `play_track=internal`: `r0adkll/upload-google-play` with `packageName: com.hellofraands.app`, `track: internal`.
- **No `push:` trigger**, since `git_safe_push.py` refuses pushes while any workflow has one.
- The magic words for this app: **"ship hf"** runs `gh workflow run hf-android.yml --ref main -f artifact=both -f play_track=internal`. After that, Claude checks the run, confirms the release shows in the Console's internal track, and reports it.

Done when: the owner installs from the opt-in link, the app opens the live site, and sign-in by WhatsApp OTP works inside the app.

### HF-APP-2 — Links open the app (App Links and DigiLocker)
- Add `com.hellofraands.app` to `web/public/.well-known/assetlinks.json` with **both** SHA-256s from HF-APP-0 step 6. Keep the existing avaTOK and Saathum entries.
- Intent filters from §2.3.
- Verify on the phone:
  - A `https://<domain>/h/...` link in WhatsApp opens the app without asking.
  - The DigiLocker round trip returns to the Aadhaar step.
  - `adb` isn't available (no local toolchain), so the test uses real links sent by WhatsApp.

Done when: the DigiLocker return and a profile link both open the app on the owner's phone.

### HF-APP-3 — App mode on the website
All in `web/`. The plain website must look exactly as it does today, so every change is gated on app mode.
- **Detect:** `isNativeApp()` (Capacitor present) or the user agent contains `HelloFraandsApp/`. Then set `<html class="hf-app">` before first paint, with an inline script in the layout head so nothing flashes.
- **Bottom tab bar** (`AppTabBar.astro`, app mode only): **Home · Calls · Wallet · Me**. Hosts see **Host** (dashboard) in place of Calls. It uses the existing fonts and sizes from the owner's design rules (Nunito headlines, Comfortaa text, no tiny fonts, no green), with tap targets of at least 48 px.
- **Hidden in app mode:** the site footer, marketing header links and any `/admin` link. The wallet's "Add tokens" button in the app opens Google Play Billing (§11). On the plain web it is replaced by "Download the app to add tokens" with the Play link.
- **Back button:** the `App` plugin's `backButton` goes back in history, or asks "Exit Hello Fraands?" on the home page.
- **Safe areas:** `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on the header, tab bar and full-screen steps. The status bar colour matches the header.
- **External links:** `tel:`, `wa.me` and other domains open outside the app; there are no dead taps.
- **Offline:** `www/offline.html` shows "No internet. Check your connection." with a Try again button, in brand fonts.
- **Pull to refresh** on Home, Calls and Wallet.
- **Update prompt:** config `hfAppMinShell` (number). If the app's shell version is lower, a soft banner asks the owner to update from Play. It only matters when the shell itself changes.
- New flags (`hfAppMinShell`, `hfPushEnabled`) are declared in `worker/src/routes/config.ts` DEFAULTS in the same change. Number flags also get a `numericKeys` entry. After deploying, prove each one can be set (fake-flag rule).

Done when: every page in the §6 list looks right in the app, and the plain website is unchanged (checked with before and after screenshots).

### HF-APP-4 — Push notifications
- Firebase project `avatok-e19ef`: add the Android app `com.hellofraands.app` with both SHA-256s. Its `google-services.json` goes into CI as the secret `HF_GOOGLE_SERVICES_JSON` (never committed).
- **Client:** after sign-in in app mode, a friendly screen first says why notifications help ("Know when your favourite host comes online"). Then the Android permission prompt, then register. The token is sent to the worker.
- **Worker:**
  - `POST /api/hf/push/register` with `{token, platform:'android', shell}` and `DELETE /api/hf/push/register`.
  - D1 table `hf_push_tokens (user_id, token, platform, shell, created_at, last_seen_at)` in its own CREATE migration, applied with `cf.sh worker d1 execute` (not `d1_apply_alters.py`).
  - Tokens are deleted on sign-out, account deletion (added to the HF deletion coverage and DPDP retention) and when FCM says a token is invalid.
- **What sends a push** (WhatsApp stays where it is today; push is added on top):
  1. "Notify me": the host you asked about is online.
  2. Host: your profile was approved or needs changes.
  3. Host: withdrawal approved or paid.
  4. Caller: your balance is low after a call.
  5. After a call: "How was your call? Leave a review."
- Tapping a push opens the matching page in the app.
- Sends go through `consumers/src/fcm.ts`, gated by `hfPushEnabled` (default `false` until tested, then switched on in prod at the owner's say-so).

Done when: on the owner's phone each of the five pushes arrives and opens the right page, and a second phone confirms "Notify me" from a real host going online (two-phone rule).

### HF-APP-5 — Camera and microphone in the app
- The selfie video step and the voice intro recorder must work inside the Android WebView. Capacitor passes `getUserMedia` permission requests on to Android once the manifest has the permissions.
- Before each Android prompt there is a short explainer screen: "We need your camera for a 10-second video to prove it's really you" and "We need your microphone to record your voice introduction".
- If the person said "Don't allow", show a clear way to fix it ("Open settings", which opens the app's settings page) instead of a broken recorder.
- Check the recorded file types (`MediaRecorder` mime type on Android) are accepted by the existing upload and review routes (selfie review, IntroCheckWorkflow).
- Upload filenames stay ASCII (known x-file-name header trap).

Done when: a full host sign-up (WhatsApp → Aadhaar → selfie → bank → voice intro) completes inside the app on the owner's phone, and admin sees the video and audio play.

### HF-APP-6 — Mobile polish pass
Page by page in app mode at 360, 390 and 412 px wide, on the owner's phone plus browser screenshots. Fix only spacing and layout. No redesigns: owner rule, designs stay as they are, and any real redesign gets a mock first. The checklist for every page:
- no sideways scrolling
- nothing hidden under the tab bar, notch or keyboard
- tap targets of at least 48 px
- forms scroll the focused field into view
- loading states, so nothing looks frozen

Done when: the §6 list is ticked with screenshots.

### HF-APP-7 — Play compliance pack (needed before closed testing; prepared now)
- **Store listing:**
  - name and short description from brand.json
  - full description in simple English
  - 512 px icon, 1024×500 feature graphic
  - at least 4 phone screenshots from the real app, with no real people's data
  - category: Social; contact email: `BRAND.emails.support`
- **Privacy policy URL:** `https://<domain>/privacy`. **Account deletion URL:** `https://<domain>/data-deletion` (the page must explain the in-app path `/account/close`).
- **Data safety form, filled from what the app really collects:**
  - collected: phone number (WhatsApp), name; for hosts also Aadhaar last 4 and address details, bank account, selfie video, voice recording and AI images
  - app activity: calls made, reviews
  - device or other IDs: the push token
  - encrypted in transit; users can ask for deletion; no data sold; shared only with service providers
  - Claude drafts the answers and the owner reads them before submitting (it is a legal declaration).
- **Content rating questionnaire:** users can talk to each other and the app has paid features. Answered honestly.
- **Target audience: 18+ only.** Ads: none. Government app: no. Health: no.
- **Financial features declaration:** describe the wallet honestly (prepaid balance for calls; real money currently off).
- **User-generated content and "talk to people" safety, which Play reviewers check:**
  - terms accepted at sign-up
  - in-app **Report** on every host profile (links to the existing `/report`)
  - # on the phone call ends and blocks
  - reviews are moderated
  - Community guidelines page linked from Me
  - Check each of these exists inside the app and add any missing entry point.
- **App access for reviewers:** a reviewer login that works without a real WhatsApp. This is a reviewer test account with a fixed code, restricted to the app review email and switched off after review. It needs owner approval before it is built.

Done when: every Play "App content" item shows complete, and the closed-testing track is ready to use when the owner wants it.

### HF-APP-8 — Telemetry
Add these to `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` first, then code them:
- **Super property** `platform: 'android-app'` and `shell_version` in app mode, through `web/src/lib/analytics.ts`.
- **Events:** `hf_app_open`, `hf_app_offline_shown`, `hf_app_back_exit`, `hf_app_deeplink_opened {path}`, `hf_app_permission {kind: camera|mic|push, result}`, `hf_push_registered`, `hf_push_sent {kind}` (worker), `hf_push_opened {kind}`.
- **Success values, written down before shipping:**
  - `hf_push_opened` arrives for each kind
  - `hf_app_permission result=granted` for camera and mic during the test sign-up
  - `hf_app_deeplink_opened path=/hosts/kyc/return`
- Errors go through `captureException` (web) and `hooks.trackException` (worker). No silent `catch {}`.

---

## 4. Order and rough effort

| Order | Phase | Who | Rough time |
|---|---|---|---|
| 1 | HF-APP-1 shell + CI (first artifact) | Claude | ½–1 day |
| 2 | HF-APP-0 Play Console setup + first upload | Claude in the browser; owner only for a Google sign-in check | ½ day |
| 3 | HF-APP-2 App Links | Claude | 2–3 h |
| 4 | HF-APP-3 App mode on the site | Claude | 1–2 days |
| 5 | HF-APP-5 Camera / mic | Claude, then the owner tests on his phone | ½–1 day |
| 6 | HF-APP-4 Push | Claude, then the owner + a second phone test | 1–2 days |
| 7 | HF-APP-6 Polish pass | Claude | 1–2 days |
| 8 | HF-APP-8 Telemetry | Claude (alongside each phase) | — |
| 9 | HF-APP-7 Compliance pack | Claude drafts, the owner approves the declarations | 1 day |

The first installable app on the owner's phone is the end of step 2.

## 5. What the owner does (only these)
1. Approve this spec.
2. Approve the Chrome / Play Console access prompts, and answer a Google sign-in or 2-step check if Google asks.
3. Install from the internal-testing opt-in link on his phone. The phone's Play Store must be signed in with `hdavy2005@gmail.com`.
4. Test on his phone when asked, and borrow a second phone for the push and call tests.
5. Read and approve the Data safety, financial features and content rating answers before they are submitted.

## 6. Pages to check in app mode
Home (host cards and filters) · host profile with voice intro · call flow (Call, Busy/Offline → Notify me) · review page · `/wallet` · `/account` and `/account/close` · `/verify/lane` · women-only and LGBTQ+ lane pages · host onboarding (all steps) · host dashboard (online/offline toggle) · sign-in / sign-up with WhatsApp OTP · help, FAQ, terms, privacy, safety, report · 404.

## 7. Rules this must not break
- Brand name and domain only from `Specs/brand.json` (guarded at push and deploy).
- One issue per commit, `scripts/git_safe_commit.py` with explicit paths, own worktree per issue, push through the wrapper.
- No local Android/Flutter toolchain. All builds run in CI. Never install the SDK on the Mac.
- Production only, no staging. Confirm before production writes (worker deploy, flags, D1, web deploy) unless the owner asked for exactly that.
- Flags declared in `config.ts` DEFAULTS. Never call `flags.sh set` twice in a row.
- PostHog on every new surface (§8).
- The Hello Fraands rulebook gets new rows `HF-APP-1…` and the HF-CALL-3 wording becomes "No app needed for calls; the Android app is optional", in the same commit as the first code change.

## 8. Risks

| Risk | What we do |
|---|---|
| Play rejects it as "just a website" (minimum functionality) | Native push, permission explainers, App Links, tab bar, back button, offline screen (HF-APP-3/4/5). Internal testing has no review, so this only matters from closed testing on. |
| Clerk / WhatsApp OTP sign-in misbehaves in a WebView | The site is loaded from its real domain, so cookies are first-party. Tested first in HF-APP-1. There is no Google sign-in (Google blocks it in WebViews). |
| Camera or recorder fails in some WebViews | Explainer + settings fallback; test on the owner's Motorola (Android 16) plus one older phone. |
| Billing policy (§9) | Settled: Play Billing in the app, web points to the app (§11). |
| Play's 12-testers-for-14-days rule | The Console shows a **Personal** account, so it likely applies before production. Internal testing is fine; a 12-person, 14-day closed test is needed before going public. |

## 9. Paying for tokens inside the app — DECIDED 2026-10-10
Google Play Billing in the app; the website sends people to the app. Full model in §11. The earlier options (keep top-up off, India alternative billing, ask Play support) are parked. India alternative billing stays a possible way to cut the fee later, through the provider switch in §11.6.

## 10. Later (not in this spec)
Closed testing → production · iOS (Capacitor iOS, App Store person-to-person rule) · in-app review prompt · native contact-free "call me back" widget.

---

## 11. Tokens, Google Play Billing and host earnings — `HF-TOK-*` (owner brief 2026-10-10)

### 11.0 In simple words
- Callers buy **tokens** in the app with Google Play: **100 tokens for ₹100**.
- At launch each token is worth **₹0.82 of call time**. The two numbers are separate settings: ₹1 is the price, ₹0.82 is the value. We never call the gap "Google's fee" or "GST".
- A host keeps the price in **rupees per minute** (say ₹20/min). The app turns it into tokens: ₹20 ÷ ₹0.82 = **24.39 tokens a minute**. 100 tokens buy **4 min 6 s** with that host. We never round this up to 25.
- Calls are charged by the second, adding up over the whole call. Rounding to the paisa happens once, when the call ends.
- **Hosts only ever see rupees.** Per full minute at ₹20: ₹2 covers the call cost (Vobiz), and of the ₹18 left the host gets 60% = **₹10.80** and the platform 40% = **₹7.20**, with any GST inside the platform's part. Google's fee is never taken off again here.
- Later, when Paytm or another gateway approves us, new tokens will be worth ₹1. Tokens bought before keep their ₹0.82 value. The host still earns ₹10.80/min either way.
- The **website can't use Google Play**, so tapping "Add tokens" on the web says "Download the Hello Fraands app to add tokens", with the Play link. Calls paid with tokens start from the app (HF-APP-D11).

### 11.1 Owner decisions (2026-10-10)
| ID | Decision |
|---|---|
| HF-TOK-D1 | Launch checkout = Google Play Billing only (consumable products). No customer UPI / BaseUPI / Paytm checkout now. Existing gateway top-up code (`HF-TOPUP-1`) stays dark. |
| HF-TOK-D2 | Pricing version v1: provider `google_play`, purchase price ₹1/token, redemption value ₹0.82/token, assumed provider fee 15%. |
| HF-TOK-D3 | Host rate stays in ₹/min. Tokens/min = rate ÷ token value, not rounded. |
| HF-TOK-D4 | Split from the **rupee value consumed**: call-cost allocation ₹2/min (prorated), host 60% of the rest, platform 40% of the rest (any GST inside it). |
| HF-TOK-D5 | Hosts see INR only; separate INR host ledger in paise; payouts outside Play. |
| HF-TOK-D6 | Every purchase is a **lot** with its pricing version and value; lots are used **oldest first**; old lots are never revalued. |
| HF-TOK-D7 | Calls paid with Play tokens start only in the app; the web shows "Open the app to call". |
| HF-TOK-D8 | Google refund after some tokens were spent: unspent tokens of that lot are removed, and the spent part becomes an **amount owed**. It is cleared automatically from the next purchase, and no new calls until it is cleared. The host keeps what they earned. |
| HF-TOK-D9 | DROPPED 2026-10-10 (HF-NOLIMITS-1): no daily or monthly spend limits. Only the "Are you sure?" step at ₹1,000+ stays. |
| HF-TOK-D10 | Admin test credits are lots of kind `test` at the active value (₹0.82). Spend-only, never withdrawable. A host's earnings from them stay non-withdrawable test earnings. |

### 11.2 What exists today (inspected 2026-10-10) and what changes
| Today | File | Change |
|---|---|---|
| Caller paid balance = whole rupees in the WalletDO (1 token = ₹1) | `routes/wallet.ts`, `hf_calls_store.ts` (`hfReserve`) | Replaced for HF by a **token-lot ledger** in D1 (below). The WalletDO is no longer used for HF callers. No real money has ever been in it, so only test data moves. |
| Test credits in `hf_credits` (whole rupees) | `lib/hf_credits.ts` | Migrated into `test` lots at ₹0.82. Keeps the same idempotency pattern (UNIQUE `op_id`, one D1 batch). |
| Billing per **started minute** (`Math.ceil`) in whole rupees | `lib/hf_call_math.ts` `billedMinutes`, `settleCall` | Replaced by **per-second cumulative** billing. Rule HF-PAY changes; rulebook updated in the same commit. |
| Host share floored **per minute** (`hostSharePerMinPaise`) | `hf_call_math.ts` | Computed once per call from the consumed rupee value (formula below). The per-minute result is the same (₹10.80 at ₹20). |
| Host earnings credited as **whole-rupee tokens** into the host's WalletDO, with fractions carried (`hostTokensToCredit`, `hf_calls.host_earned_tokens`) | `hf_call_math.ts`, `hf_calls.ts` | New **INR host ledger in paise** (`hf_host_ledger`). Hosts see ₹10.80, not 10 tokens. |
| Withdrawable = min(WalletDO balance, matured `host_paid_rupees`) | `lib/hf_payouts.ts` | Reads the host ledger: matured paid earnings (7-day hold) minus payouts, in paise. Payouts are still whole rupees (₹500 minimum). The leftover paise stay in the balance. |
| Play purchase verification for avaTOK (`verifyPlayProduct`, `listVoidedPlayPurchases`) using **one** package id | `src/play.ts`, `routes/wallet.ts` | Reused, but the package id becomes a parameter (`com.hellofraands.app` for HF). Never touches the avaTOK `topup_records` path. |
| Rupee gateway top-ups (Razorpay/Cashfree/Paytm) credit the WalletDO | `lib/hf_topup.ts` | Kept dark. When a gateway is switched on later, it credits a **lot** through the same provider interface, never the WalletDO. |
| Receipts + GST invoices on the "platform share" (₹2 + 40%) ÷ 1.18 | `lib/hf_receipts.ts` | Tax basis becomes a **setting** (§11.7). Not changed until the CA answers. |

### 11.3 Data model (DB_META; CREATE tables in their own migration file)
- `hf_pricing_versions`: `id` (e.g. `gp-v1`), `provider` (`google_play`|`paytm`|…), `purchase_paise_per_token` (100), `redemption_paise_per_token` (82), `provider_fee_bps` (1500, assumed), `tax_mode` (text; see §11.7), `effective_from` (ms), `status` (`active`|`scheduled`|`retired`), `note`. Rows are never edited once active; a change is a new version.
- `hf_token_products`: `product_id` (Play SKU, e.g. `hf_tokens_100`), `tokens` (100), `pricing_version`, `active`. The price shown to the buyer comes **from Play** (`ProductDetails`), never typed beside the button.
- `hf_token_lots`: `id`, `uid`, `kind` (`purchase`|`test`|`adjustment`), `pricing_version`, `redemption_paise_per_token`, `tokens_granted_micro`, `tokens_left_micro`, `tokens_reserved_micro`, `paid_paise` (what the buyer paid incl. tax; 0 for test), `provider`, `provider_ref` (Play orderId), `created_at`, `status` (`active`|`revoked`).
  **Unit:** micro-tokens (1 token = 1,000,000) as integers. This is what makes 24.390244 tokens/min exact enough.
- `hf_token_ledger`: append-only, with UNIQUE `op_id`. Rows for purchase, reserve, release, spend, refund_revoke, debt_create, debt_clear, admin_adjust, each with `lot_id`, `delta_micro`, `rupee_value_paise`, `call_id` / `purchase_id`.
- `hf_play_purchases`: `purchase_token` (UNIQUE), `order_id` (UNIQUE), `product_id`, `uid`, `state` (`pending`|`verified`|`credited`|`consumed`|`refunded`|`revoked`), `price_micros`, `currency`, `raw` (trimmed), `lot_id`, `acked_at`, `consumed_at`, `refunded_at`.
- `hf_token_debts`: `uid`, `amount_micro`, `value_paise`, `source_order_id`, `status` (`open`|`cleared`), timestamps.
- `hf_host_ledger` (INR, paise): `id`, `host_uid`, `kind` (`call_earning`|`call_earning_test`|`payout_reserve`|`payout_paid`|`payout_cancel`|`admin_adjust`), `amount_paise` (signed), `call_id`, `payout_id`, `available_at` (call end + 7 days), `created_at`, plus UNIQUE `op_id`.
- `hf_calls` gains a **pricing snapshot** taken at call start: `rate_paise`, `call_cost_paise_per_min` (200), `host_share_bps` (6000), `tax_mode`, `split_rule_version`, and results `billable_seconds`, `consumed_value_paise`, `call_cost_paise`, `host_earning_paise`, `platform_paise`, `tokens_spent_micro`, `lots_used` (JSON: lot id, micro-tokens, paise per lot).

Settings live in `worker/src/routes/config.ts` DEFAULTS (declared, so not fake flags): `hfCheckoutProvider` (`google_play`), `hfPricingVersion` (`gp-v1`), `hfCallCostPaisePerMin` (200), `hfHostShareBps` (6000), `hfTokensEnabled` (false until tested), `hfPlayPackageId` (`com.hellofraands.app`). Number flags get `numericKeys` entries.

### 11.4 The money maths (pure functions in `lib/hf_token_math.ts`, unit-tested)
For a call snapshot with rate **R** paise/min and **s** billable seconds:
- **Consumed value** `V = round(R × s / 60)` paise. This is the same whatever lots paid for it, because tokens are converted at each lot's own value.
- **Call cost** `C = round(200 × s / 60)` paise (capped at V).
- **Host** `H = floor((V − C) × 6000 / 10000)` paise. **Platform** `P = V − C − H`. The platform takes the odd paisa; the host is never overpaid.
- **Tokens from a lot** worth v paise/token, for value x paise: `micro = ceil(x × 1,000,000 / v)`. The ceiling is the defined rounding boundary, so it never under-charges by a fraction of a micro-token.
- **Live metering:** the call DO computes the total from the start each tick, `micro_total(s) = floor(R × s × 10⁶ / (60 × v))`. It never adds tick by tick, so there is no drift. Lots are walked oldest first; when a lot runs out mid-second, the remainder converts at the next lot's value.
- **How long the balance lasts:** sum over lots of `tokens_left × v`, as rupee value, ÷ R. Shown as "about 4 min 6 s".
- **Start rule** (unchanged): the balance must cover 2 minutes; 60-minute cap; 1-minute warning.
- **Display:** rates show 2 decimals ("24.39 tokens/min · ₹20/min"); balances show 2 decimals; the full precision is kept inside.
- **Running out mid-call:** billing stops at the last whole second the lots can pay for, and the call ends with the existing balance warning.

### 11.5 Google Play purchase flow (`HF-TOK-PLAY-1`)
1. The app lists the packs from `/api/hf/tokens/products`. Prices come from Play's `ProductDetails` (native billing plugin in the Capacitor shell: open-source and maintained, chosen at build time; no paid middleman).
2. The buyer pays in the Play sheet. The app sends `{productId, purchaseToken}` to `POST /api/hf/tokens/play/verify` (signed in, rate-limited, idempotent).
3. The worker calls the Play Developer API `purchases.products.get` for `com.hellofraands.app`. It credits only if `purchaseState = purchased`, the product is known and active, the `obfuscatedAccountId` matches the signed-in user (set at purchase), and the order is new.
4. **One D1 batch:** insert `hf_play_purchases` (UNIQUE token and orderId) → create the lot → ledger `purchase` row (op_id `hfplay:<orderId>`) → clear any open debt first (HF-TOK-D8). A second notification or retry finds the row and returns the same result, **never a second lot**.
5. Then the purchase is **acknowledged and consumed** server-side. Unacknowledged purchases are auto-refunded by Google after 3 days, so a daily cron re-tries any `credited` but unconsumed rows.
6. **Real-time developer notifications** (Cloud Pub/Sub push → `POST /api/hf/tokens/play/rtdn`, JWT checked) for purchase, refund and revoke. Plus a **daily `voidedpurchases` sweep** as the backstop.
7. **Refund / revoke** (op_id `hfvoid:<orderId>`, applied once): remove the lot's unspent micro-tokens and any reservation. The spent part becomes an `hf_token_debts` row, and calls are blocked until it is cleared. **Host earnings are never touched** (HF-TOK-D8, §11.8).
8. No spending limits (HF-TOK-D9 dropped, HF-NOLIMITS-1). The "Are you sure?" step at ₹1,000+ stays.
9. Receipts: Google sends its own receipt. `/wallet` shows a "Purchase record — paid via Google Play" with the order id. It is not a tax invoice.

### 11.6 Provider switch, prepared now, used later (`HF-TOK-PROVIDER-1`)
- `CheckoutProvider` interface: `listProducts`, `startPurchase`, `verify`, `handleNotification`, `refund`. `google_play` is implemented now. `paytm` (and the existing Razorpay/Cashfree adapters) get wrapped in it but stay **disabled**.
- Call billing reads **only lots and the call snapshot**. It never reads the provider or a hard-coded ₹0.82.
- Future version, e.g. `pt-v1`: provider `paytm`, ₹1 price, **₹1 value**. A ₹20/min host then costs 20 tokens/min, and the host still earns ₹10.80/min.
- Switching = insert the new version with an `effective_from`, then set `hfCheckoutProvider` / `hfPricingVersion`. New purchases get new lots; old lots keep ₹0.82.
- **Mixed balances:** the wallet shows "45.20 tokens worth ₹0.82 each + 100 tokens worth ₹1 each". The call screen estimate uses the lots in the order they will be used ("about 6 min 52 s with this host").

### 11.7 Tax and fees — kept as settings, nothing invented
- Store separately per purchase: buyer price (`price_micros` from Play), our pricing version, assumed provider fee (bps), and tax mode. Google's **actual** payout is recorded from the Play earnings report later (reconciliation), never assumed to equal ₹82 or ₹85.
- `tax_mode` values to start with: `none_unregistered` (today: no GSTIN, receipts only). Any GST treatment is added as a new value only after the CA's answer.

### 11.8 Things the owner must know (found while inspecting, not guessed)
1. **Checked in the Play Console on 2026-10-10 (signed in as hdavy2005@gmail.com):** the developer account "AvaGlobal Inc, Delaware, USA" (ID 6032333068668680495) is a **Personal** account. Its legal name and address are **Humphrey Davy, Dehradun, India**. So Google treats the seller as an **Indian developer**: Google does *not* collect GST on the purchase, and **GST on the sale is the seller's own job**. The rough payout is ₹100 − 15% = **₹85** (before any GST Google bills on its own fee, and before any GST the seller owes). The ₹82 value leaves about ₹3 of margin per 100 tokens above the call-time value. The platform's commission (₹29.52 per 100 tokens at ₹20/min) is where any GST must come from.
2. **The seller on Play is Humphrey Davy personally**, not a company. Money from token sales lands in his personal payments profile, and hosts are paid from it. Whether this is fine before a company exists (GST registration threshold, income tax, TDS 194-O) is a CA question. It is added to `claude/hello-fraands-ca-brief.md`.
   - **Personal account also means Play's 12-testers-for-14-days rule applies** before production access, if the account was created after 13 Nov 2023. Internal testing is not affected; plan a 12-person closed test before going public.
3. **GST on the platform commission:** today's code treats ₹2 + 40% as the platform share with 18% GST inside it. Now the ₹2 is "call cost, not profit", and Google has already charged GST on the purchase. Whether the commission carries GST again, and on what base, is for the CA. `tax_mode` stays `none_unregistered` until then.
4. **The 15% fee tier** must be confirmed in the Play Console for this account (the 15% programme for the first $1M a year needs the account group set up). Otherwise the fee is 30%.
5. **Rules that change** and must be updated in `Specs/RULEBOOK-HELLO-FRAANDS.md` in the first commit:
   - "1 token = ₹1" becomes priced and valued tokens.
   - Billing per started minute becomes per second, cumulative.
   - HF-PAY-6: same numbers, but ₹2 is relabelled as call cost.
   - **HF-PAY-15 refunds** of unused top-ups: with Play, refunds go through Google (Orders API / Play Console), not to a UPI.
   - **Account closure "pay out first"** for callers becomes a Google refund of unspent purchase lots, where Google allows it.
   - The earlier "balance can be transferred back to UPI" promise (memory/FAQ) **conflicts** with Play tokens and must be reworded. That needs the owner's OK on the new wording.
6. Play policy for tokens: products are **consumable**, tokens are used only in the app (HF-TOK-D7), and the web never links to an outside payment from inside the app.

### 11.9 Build phases (each its own issue, worktree and commit)
| Order | Issue | What |
|---|---|---|
| 1 | `HF-TOK-MATH-1` | `hf_token_math.ts` + tests (§11.10), pricing-version + lot tables, config keys. No behaviour change yet. |
| 2 | `HF-TOK-LEDGER-1` | Lot ledger: credit, reserve, spend oldest first, release, debt. Test-credit migration to `test` lots. Admin "add test credits" writes lots. |
| 3 | `HF-TOK-CALLS-1` | Call start/meter/settle on lots with snapshot + per-second billing; host INR ledger; payouts read the host ledger; caller and host screens (tokens for callers, ₹ for hosts). |
| 4 | `HF-TOK-PLAY-1` | Play products in the Console (browser, account check first), native billing in the shell, verify / ack / consume, RTDN + voided sweep, refunds → debts, limits on rupees paid. |
| 5 | `HF-TOK-WEB-1` | Web: "Download the app to add tokens", "Open the app to call", wallet lot breakdown, call estimates; FAQ/help/terms/wallet-terms copy (owner approves wording). |
| 6 | `HF-TOK-PROVIDER-1` | Provider interface, Paytm/Razorpay/Cashfree wrapped and disabled, switch runbook. |

Telemetry: `hf_token_purchase_started|verified|duplicate|failed`, `hf_token_refund_applied {debt_paise}`, `hf_call_settled {consumed_value_paise, host_earning_paise, lots}`, `hf_token_web_blocked {reason: topup|call}`. All carry email/uid; calls tag both parties.

### 11.10 Tests that must pass (pure + D1 integration)
1. ₹20/min, value ₹0.82 → 24.390244 tokens/min; 100 tokens → exactly 246 s.
2. A 246 s call at ₹20 → V ₹82.00, call cost ₹8.20, host ₹44.28, platform ₹29.52, tokens spent 100.000000.
3. One full minute at ₹20 → host ₹10.80, platform ₹7.20, call cost ₹2.00.
4. Partial: 61 s at ₹20 → V ₹20.33, call cost ₹2.03, host ₹10.98, platform ₹7.32 (prorated, host floored).
5. Host rate ≤ ₹2 → host ₹0, call cost = V.
6. The same Play purchase sent 3× (verify + RTDN + retry) → one lot, one ledger row.
7. Refund before any spend → lot removed, no debt. Refund after 60 tokens spent → 40 removed, debt for 60 tokens' value, calls blocked; the next purchase clears the debt first. Host ledger unchanged.
8. Insufficient balance: under 2 minutes → call refused with the shortfall shown; running out mid-call → stops at the last paid second.
9. Mixed lots: 50 tokens @ ₹0.82 + 100 @ ₹1.00, ₹20/min → the first 123 s use the ₹0.82 lot, then the ₹1 lot (20 tokens/min). Host earnings = ₹10.80/min throughout.
10. Provider switch mid-balance: old lot keeps ₹0.82, the new purchase is ₹1; a call already running keeps its snapshot after a config change.
11. Paise only: no floats in stored balances; property test over random rates and durations shows V = C + H + P exactly.
