# SPEC 2026-08-14 — Unified menu, iOS forwarding wizard, APNs/PushKit

Owner decisions (2026-08-14, this session):

> **Superseded in part — owner decision 2026-08-15:** every Android production
> **SHIP IT** must send a quiet FCM "Update available" notification after the
> build is successfully published to Google Play Internal. The notification is
> required even though the retired self-updating APK path stays retired. CI must
> verify the FCM fan-out completed before reporting the release successful.

1. The device-phone-app layer is retired on **all platforms** — AvaDialer as a
   phone app, AvaSMS, the missed-call overlay, and the self-updating APK.
   Done today: prod KV `avaSms=false`, `missedCallOverlay=false`,
   `inAppUpdateEnabled=false` (verified cache-busted). `avaDialer` remains
   TRUE in prod **only** because every shipped client gates the forwarding
   wizard on `avaDialer && pstnVoicemail`; commit `[IOS-PORT-DISABLE-1]`
   decouples that (gate is now `pstnVoicemail` only). **Flip `avaDialer=false`
   in prod once a build containing 94f21e39 is on phones** — flipping earlier
   kills the forwarding product for existing users.
2. One menu for iPhone and Android — the Android menu is replaced, not forked.
3. Forwarding stays the product. iPhone gets the copy-to-dial wizard with a
   server test-call verifier; Android keeps silent USSD.
4. APNs/PushKit is committed work: calls must ring on a closed iPhone.

## 1. Unified menu (replaces the current Android default)

The 3-root shell survives as-is on both platforms; only the Calls root's
insides change. Display renames landed in `[IOS-PORT-DISABLE-1]`
(`RootId.key` strings, analytics, persisted order all unchanged):

- **AvaTalk** — messages & in-network calls. Unchanged.
- **Calls** (was "AvaDialer") — AvaTOK-network calls only. Tab strip becomes:
  - *Contacts* — already AvaTOK-network (`_ContactsTab`), keep.
  - *Dialpad* — already the AvaTOK-directory dialer, keep.
  - *Voicemail* — NEW, replaces *Block list*. The receptionist inbox: message
    cards (play button, transcript, caller), the forwarding status card, and
    the "Set up forwarding" entry that opens the wizard. This puts the
    product you sell one tap from the tab bar instead of buried in Settings.
    (Settings → Voicemail row stays as a second entry point.)
  - *Call history* — replaces carrier *Call logs* with the AvaTOK call log
    (`core/call_log_store.dart` already records these).
  - The old Block list / Call logs bodies stay in the tree behind
    `RemoteConfig.avaDialer` and die when the flag flips; delete in a later
    cleanup pass.
- **Services** — unchanged.

Sidebar copy updated to "AvaTOK calls, contacts & voicemail". Nothing in the
menu is platform-forked; iOS simply never sees the dormant Android-only
bodies because the flags are off and `Platform.isAndroid` guards the
carrier-forwarding row.

Update path replacement (self-updating APK is dead): Android testers move to
the Play internal track / a plain "new version" notice linking the store;
iOS uses TestFlight. `latestAppBuild` stays as the version beacon; the
client stops auto-installing.

## 2. Forwarding wizard — iOS mode

Same `PstnForwardingWizard` screen, two capability lanes chosen at runtime:

- **Android (unchanged):** silent USSD dial + carrier status query.
- **iOS:** the platform cannot dial `*`/`#` codes (Apple strips them from
  `tel:`) or read carrier status. Each wizard row becomes:
  1. Show the exact per-carrier code (the server-driven template table in
     `pstn_forwarding_setup.dart` already resolves per-carrier codes — reuse
     it verbatim).
  2. **Copy code** button + "open the Phone app and dial it" instruction.
  3. **Verify** button → server test call (below). Row turns green only on
     proof, preserving the AVA-RCPT-VERIFY-1 principle (never assume).

**Server test-call verifier (new Worker route, works for BOTH platforms as a
fallback):** `POST /api/forwarding/verify-call` → Worker instructs the DID
provider to place one short call to the user's real number with a verification
tag. If the diverted leg arrives at our DID within ~20s carrying the tag, the
route returns `verified: true` and the client persists the per-account
`pstn_voicemail_*_on` key exactly as the USSD lane does. Busy/no-answer
conditions are verified by the receptionist DO answering the diverted leg —
same signal. Rate-limit per account; declare any new config keys in
`PlatformConfig` + `DEFAULTS` in the same change (fake-flag rule).
Blocked on: the DID provider having an outbound-call API (the DID plan is
currently on hold pending the owner's provider choice — [VNUM-SPEC-1]).

## 3. APNs/PushKit — calls ring on a closed iPhone

The single biggest engineering item of the port. Design:

1. **Client:** `flutter_callkit_incoming` already supports iOS CallKit +
   PushKit; add the PushKit registration in the iOS runner, `voip`
   background mode + push entitlement. On a VoIP push, iOS REQUIRES an
   immediate `reportNewIncomingCall` — decline-path bugs are app-store
   removals, so the CallKit decline bridge trap
   (avatok-native-decline-kills-accepts) must be re-audited on iOS.
2. **Token registry:** device token rows gain a `kind` — `fcm` | `apns_voip`
   (+ `apns_alert` for normal pushes). Client uploads the PushKit token
   alongside the FCM path.
3. **Worker push fan-out:** where the call path today sends FCM
   (`ring`/`incoming_call` data messages), branch by token kind. VoIP pushes
   go direct to APNs (JWT p8 key as a Worker secret — no Firebase needed for
   the VoIP lane; message/alert pushes can keep going through FCM, which
   fronts APNs for normal notifications).
4. **Discipline:** VoIP pushes are for CALLS ONLY (Apple policy); everything
   else rides `apns_alert`/FCM.
5. **Ship gate:** two iPhones on the same build, success = `call_answered`
   with `app_state=terminated` on the callee side; write the manifest entry
   before the build goes out.

Prereqs: Apple Developer account ($99/yr, owner action), `ios/` runner
generated + committed, an `ios.yml` workflow (macos runner, dispatch-only,
same guard/no-push rules as android.yml), signing certs + App Store Connect
API key as GitHub secrets, APNs p8 key as a Worker secret.

## 4. Sequencing

1. ✅ Prod flags off (avaSms / missedCallOverlay / inAppUpdateEnabled).
2. ✅ Decouple forwarding from `avaDialer` + menu renames (94f21e39).
3. Build the Voicemail + Call history tabs (Android-first, same code serves
   iOS later). Ship an Android build; verify Settings→Voicemail renders on
   the new build; **then flip `avaDialer=false` in prod.**
4. Generate `ios/` runner + `ios.yml`; get a TestFlight build compiling with
   Android-only channels failing soft.
5. APNs/PushKit lane (§3).
6. iOS wizard lane + test-call verifier (§2) once the DID provider exposes
   outbound calls.
