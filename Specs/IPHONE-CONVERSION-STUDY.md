# iPhone Conversion Study — AvaTOK

Date: 2026-08-14. Study only — nothing was changed, no builds triggered.

## The one-line answer

The app can be brought to iPhone, and the thing you sell — **phone forwarding to the AI
receptionist — still works on iPhone**, because the forwarding happens at the carrier,
not in the app. What breaks is the *automated setup*: on iPhone the app cannot dial the
carrier codes for the user or verify they registered. The user has to dial 2–3 codes
themselves in the Phone app, guided by a step-by-step screen. Everything Android-telephony
(the dialer, SMS app, missed-call detection, call recording, live call translation of
regular phone calls) is impossible on iPhone and must be hidden there. AvaTOK↔AvaTOK
voice/video calls, chat, the receptionist, wallet, and AI features all port fine.

## Where the app stands today

There is **no `ios/` folder at all** — the project has only ever been built for Android.
The Flutter/Dart code (the vast majority of the app) is cross-platform, and nearly every
pub.dev plugin in `pubspec.yaml` supports iOS. The risk is concentrated in the custom
native Kotlin under `app/android/.../kotlin/ai/avatok/` — roughly 25 files across
AvaDial (dialer/SMS/forwarding), call recording, call translation audio, voice audio,
and AvaVision. None of that exists for iOS.

## Feature-by-feature: what works, what doesn't

### ✅ Works on iPhone (ports with configuration, not rewrites)

- **AvaTOK↔AvaTOK voice calls** — `flutter_webrtc` and `realtimekit_core` both support
  iOS (RealtimeKit requires iOS 12+). Cloudflare signalling/SFU is platform-agnostic.
- **Video calls and group conferences** — same stack, works.
- **Chat / media / stickers / GIPHY / voice notes** — all iOS-supported plugins
  (GIPHY needs iOS 13+).
- **The AI receptionist** — entirely server-side (Worker + DID). An iPhone user whose
  number forwards to the DID gets the receptionist exactly like an Android user.
- **Ava AI, translation (chat + AvaTOK-call translation), liveness/identity, wallet UI,
  library, contacts sync** (`flutter_contacts` supports iOS), affiliate links (minus the
  Play install-referrer), local drift/SQLite DB, PostHog, deep links.
- **Incoming-call UI** — `flutter_callkit_incoming` supports iOS CallKit, so incoming
  AvaTOK calls get the native full-screen answer UI. But see the push caveat below —
  this is the biggest engineering item of the port.

### ❌ Impossible on iPhone (Apple provides no API — hide these on iOS)

1. **Automated forwarding setup (the dial-and-verify wizard).** On Android the app
   silently dials MMI/USSD codes (`*67*<DID>#` etc., `AvaDialPlugin.kt` +
   `pstn_forwarding_setup.dart`) and reads the carrier's status response to turn each
   row green. iOS apps cannot send USSD, cannot place any call without user
   confirmation, and Apple **strips `*` and `#` codes from `tel:` links** specifically
   to block this. There is also no API to read forwarding status.
2. **AvaDialer as the phone app** — `InCallService`, default-dialer role, in-call
   screen for carrier calls. iOS has no concept of a replacement phone app.
3. **AvaSMS** — sending/receiving SMS/MMS, OTP auto-copy overlay. No SMS API on iOS.
4. **Missed-call detection** (`AvaMissedCallReceiver`) — no call-log or phone-state
   access on iOS. (Mostly moot: with carrier forwarding active, missed calls divert to
   the DID anyway.)
5. **Call recording of carrier calls** (`callrecord/` LegTap) and **live translation of
   carrier calls** (`CallTranslationAudioPlugin`) — both tap PSTN audio via Android
   telephony. No equivalent exists on iOS. (Recording/translating *AvaTOK* calls is
   fine — that audio is the app's own WebRTC stream.)
6. **Self-updating APK / in-app update** — `in_app_update` no-ops on iOS; there is no
   sideloading. Updates go through TestFlight (instant for testers) or App Store review.
7. **Play install referrer** — Android-only; use a code/link-based referral fallback.

### ⚠️ Works differently / needs real engineering

- **Ringing when the app is killed.** On Android, FCM + full-screen intent wakes the
  app. On iOS a normal push will not reliably ring a dead app: you need **PushKit VoIP
  push via APNs**, and Apple *requires* every VoIP push to immediately report a call to
  CallKit. This means: an APNs key added to Firebase, a device-token type split in the
  Worker's push path (`fcm` vs `apns_voip`), and PushKit wiring in the iOS runner.
  This is the single most important technical task of the port — without it, iPhone
  users only receive calls while the app is open.
- **Token top-ups.** Apple requires digital-goods purchases to use **StoreKit in-app
  purchase** — the Stripe/UPI PaymentSheet flow is not allowed inside the iOS app for
  buying tokens, and Apple takes 15–30%. `in_app_purchase` already in pubspec supports
  StoreKit; you'd define token packs in App Store Connect and add a server-side receipt
  verification route (mirroring the existing Play verify route). Purchases made on the
  website or on an Android device still land in the same wallet an iPhone reads.
- **Background contact backup** — `workmanager` on iOS is best-effort only (BGTaskScheduler);
  runs opportunistically, not every 24h. Acceptable, but not guaranteed.
- **App badge** — actually *better* on iOS (always shows the count).

## Phone forwarding on iPhone — the product you sell

The pipeline is: carrier forwards the user's real number → AvaTOK DID → receptionist
answers, takes the message, notifies the app. Steps 2–3 are server-side and untouched.
Only step 1's setup changes:

- **Android today:** consent screen → wizard dials 3 codes silently → carrier-confirmed
  green ticks.
- **iPhone version:** same consent screen → wizard shows each code with a **"Copy code"
  button and instructions to paste-dial it in the Phone app**, one row at a time. The
  app cannot confirm registration, so verification becomes either (a) the user reads the
  carrier's on-screen confirmation and taps "Done", or (b) the strong option: a
  **server-side test call** — the Worker rings the user's number for 1 ring; if the DID
  receives the diverted leg, forwarding is proven and the row turns green with real
  evidence. Option (b) keeps the "verified, not assumed" principle of AVA-RCPT-VERIFY-1
  and is the recommended build.
- iPhone's own Settings → Phone → Call Forwarding only does *unconditional* forwarding
  (all calls). The busy / no-answer / unreachable variants — the ones that make the
  receptionist a voicemail replacement rather than a number hijack — are only reachable
  via the dialed codes, which is fine since the wizard hands the user the exact codes.
- Practical caveat: **eSIM/carrier variations** — the per-carrier code templates already
  come from the server, so the same override table serves both platforms.

Net: the sellable feature survives; setup friction rises from "tap 3 buttons" to
"dial 3 codes we hand you". The test-call verifier closes most of the trust gap.

## Building with GitHub Actions (no Mac needed)

Your no-local-toolchain rule carries over cleanly — GitHub's **`macos-latest` runners
ship with Xcode**, and everything (build, sign, upload to TestFlight) runs in CI. You
never open Xcode. One-time things you personally must do:

1. **Apple Developer Program** — $99/year, enroll as individual or company.
2. Nothing else manual — certificates, provisioning profiles, App Store Connect app
   record, and TestFlight upload can all be created and driven from CI/API by an agent
   using an App Store Connect API key stored as a GitHub secret.

The pipeline (a new `ios.yml`, mirroring `android.yml`'s manual-dispatch design):

1. `flutter create --platforms=ios .` once to generate the `ios/` folder, then commit
   the configured runner: bundle id (`ai.avatok.app`), Info.plist usage strings
   (mic, camera, contacts, location, speech), background modes (`voip`, `audio`,
   `remote-notification`), push + associated-domains entitlements, `GoogleService-Info.plist`.
2. CI: checkout → Flutter setup → `pod install` → `flutter build ipa --release
   --export-options-plist` with signing via a distribution certificate + profile held
   as base64 GitHub secrets → upload to TestFlight via App Store Connect API key.
3. A `postcreate`-style script (like `tool/postcreate.py` does for Android) applies any
   Info.plist/entitlement patches so regeneration can't drop them.

Costs/timing: macOS runners bill at **10× Linux minutes** (~$0.08/min); an iOS Flutter
build is typically 20–35 min, so roughly $1.50–3 per build on the paid tier (free-tier
minutes deplete 10× faster). TestFlight delivers builds to up to 10,000 testers with no
review for internal testers — this becomes the iPhone equivalent of your APK sideload.

Two CI gotchas to plan for: `super_clipboard` needs the **Rust toolchain** on the runner
(same as Android CI already does), and `realtimekit_core` 0.1.6 is marked discontinued
on pub.dev — its iOS pod (`realtimekit_core_ios`) is untested by us and is the most
likely first build breakage.

## Apple review risks (before you invest)

- **IAP enforcement** — if review sees token top-ups outside StoreKit, instant
  rejection. Ship iOS with StoreKit packs from day one.
- **VoIP push misuse** — using PushKit for anything but calls gets apps removed; keep
  message pushes on plain APNs.
- **Privacy manifests** — Apple now requires privacy manifest declarations for several
  APIs the app touches (file timestamps, user defaults); recent plugin versions include
  theirs, but the runner needs its own.
- The de-dialered feature set actually *helps* here — the scariest Play permissions
  (call log, SMS) simply don't exist as iOS concepts.

## Suggested phasing

1. **Phase 1 — boot on iOS:** generate `ios/` runner, gate all Android-only features
   behind `Platform.isAndroid`, get a TestFlight build compiling in CI. (Biggest chunk:
   making the ~7 `MethodChannel`s to AvaDial/callrecord/voiceaudio fail soft on iOS.)
2. **Phase 2 — calls ring:** APNs + PushKit + CallKit and the Worker push split.
3. **Phase 3 — money:** StoreKit token packs + server receipt verification.
4. **Phase 4 — forwarding wizard iOS mode:** copy-to-dial UX + server test-call verifier.

Phases 1–2 are the minimum for a credible iPhone beta; 3–4 make it sellable.
