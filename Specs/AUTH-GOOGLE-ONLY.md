# Google-only auth — cutover runbook

Login is moving to **Google sign-in only** (no password, no email OTP). This is the
one hardening item that needs your Clerk dashboard access + a device test, so it's
staged as a guided cutover rather than blind-shipped.

## What's already done in code (staged, non-breaking)

- `ClerkClient.signInWithGoogle()` — native Clerk OAuth flow (start sign-in →
  Google consent via `flutter_web_auth_2` → complete session). `app/lib/auth/clerk_client.dart`.
- `flutter_web_auth_2: ^4.1.0` added to `app/pubspec.yaml`.
- `kOAuthRedirect = avatok://oauth-callback` + `kOAuthCallbackScheme` in `config.dart`.
- The store-review login bypass was already removed (client + server) in the prior pass.

The old email/password + email-code paths are **still present** so the app keeps
building and you have a fallback while testing Google. They get removed in step 5.

## Step 1 — Clerk dashboard

1. **User & Authentication → Social Connections →** enable **Google** (use Clerk's
   shared dev credentials to test, then add your own Google OAuth client for prod).
2. **User & Authentication → Email, Phone, Username →** turn **off** Password, and
   turn **off** Email verification code as a sign-in factor. Leave Google as the
   only enabled sign-in method.
3. **Paths / Allowed redirect URLs →** add `avatok://oauth-callback`.

## Step 2 — Android manifest (callback)

`flutter_web_auth_2` needs its CallbackActivity registered for the `avatok` scheme.
Add to `app/android/app/src/main/AndroidManifest.xml` inside `<application>`:

```xml
<activity
    android:name="com.linusu.flutter_web_auth_2.CallbackActivity"
    android:exported="true">
  <intent-filter android:label="flutter_web_auth_2">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="avatok" android:host="oauth-callback" />
  </intent-filter>
</activity>
```

(iOS later: nothing extra — `flutter_web_auth_2` uses `ASWebAuthenticationSession`
with the `avatok` scheme.)

## Step 3 — `flutter pub get`

Run it so `flutter_web_auth_2` resolves before the next CI build.

## Step 4 — Swap the login UI

In `app/lib/features/auth/sign_in_screen.dart` replace the email/password/reset
form with a single **“Continue with Google”** button:

```dart
final step = await widget.clerk.signInWithGoogle();
if (step.complete) {
  // NEW: redeem any pending invite reward for the inviter.
  await ReferralService.I.claimPendingAfterSignup();
  // …proceed into the app shell as today…
} else {
  setState(() => _error = step.error ?? 'Sign-in failed');
}
```

Delete the email/password `TextField`s, the “forgot password” flow, and the
email-code entry UI.

## Step 5 — Remove the dead auth paths (AFTER Google works on a device)

In `app/lib/auth/clerk_client.dart` delete: `signIn`, `signUp`,
`_prepareSignInEmailCode`, `verifyCode`, `startPasswordReset`, `resetPassword`.
Keep `signInWithGoogle`, `currentUser`, `signOut`, and the helpers.

Server: the identity email-OTP endpoints (`/api/id/email/start|verify`) become
redundant for login (Google returns a verified email). Leave them only if you still
use email OTP for a separate identity step; otherwise retire them.

## Step 6 — Existing users (hard cutover, decided)

Password accounts are retired; everyone re-onboards with Google. No migration code.
Disable password in Clerk (step 1) and that's it.

## Step 7 — Reviewer access

Google login has no OTP, so the store reviewer just signs in with a **Gmail test
account** you list in Play Console → App access. No bypass needed.

## Test checklist (device)

- [ ] New Google account → consent → lands in app shell as a new user.
- [ ] Returning Google user → straight in, no OTP.
- [ ] Cancel on the Google screen → clean error, no crash.
- [ ] Invite link captured → after Google sign-in, inviter gets the referral reward.
- [ ] Sign out → sign back in with Google.

---

## Trust-boundary status (thin-client sweep)

Confirmed **server-authoritative** (a patched client cannot override):

- Wallet credits → Stripe webhook only (signature + server record).
- Spend/purchase amounts → server-derived (`/api/wallet/spend` disabled;
  OLX/booking/vision/voice priced server-side; premium features via
  `chargeFeature` + `FEATURE_COSTS`).
- Referral reward + affiliate top-up commission → server-set, capped, self-referral
  blocked, idempotent.
- Guardian scam/grooming verdicts → server (`/api/ava/guardian/scan`).
- Delegate disclosure (“Ava — for X”) → server-stamped (un-strippable).
- Identity/auth → Clerk (server-verified JWT).

Client-side and **advisory only** (gate the real thing server-side):

- The onboarding age-group pick / `birth_year` — gate sensitive features on
  server-verified identity, not this input.
- `PaidFeature` UI gate — display only; the charge is enforced by `chargeFeature`.
