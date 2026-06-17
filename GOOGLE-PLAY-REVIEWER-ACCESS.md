# Google Play — Reviewer Account (no email OTP)

## Credentials to give Google
| Field | Value |
|---|---|
| Username (email) | `googleplay@avatok.ai` |
| Password | `Sonal@Bush` |

The login screen asks for an **email** + **password** (this Clerk setup is
email-based — there is no separate username field). Enter the email above as the
username. **No OTP / verification code is required** for this account.

## Where to enter it in Play Console
**Play Console → your app → App content → App access → "All or some functionality
is restricted"** → add an instruction:

> Tap **"I already have an account" → Log in**, then enter:
> Email: `googleplay@avatok.ai`  •  Password: `Sonal@Bush`
> No verification code is needed; you'll land directly in the app.

## How it works (for your reference)
This Clerk instance requires an **email code as a second factor at every login**,
which reviewers can't receive. A scoped bypass was added for *only* this one
allowlisted email:

- `POST /api/review/login` (Worker) checks the password against the
  `REVIEW_PASSWORD` secret and mints a Clerk **sign-in token**, which the app
  redeems via the `ticket` strategy — bypassing the second factor. Every other
  account still uses password + email OTP, unchanged.
- Backed by Clerk user `user_3FCgblNmsaDZj0U9Zu3blA7dOeu` + a `users` row
  (handle `gplayreview`), so the app restores straight into the shell.

## ⚠️ Important
- This login works **only in the new build** (CI build from commit `d61f31b`,
  pushed to `main`). Wait for that APK/AAB to build, then upload **that** build
  for review. The currently-published build will still ask for an OTP.
- Verified end-to-end on production: email+password → completed session →
  `/api/me` → app shell, with no OTP.
- To rotate the password later: update the Clerk user's password **and** the
  `REVIEW_PASSWORD` Worker secret on `avatok-api` to the same value.
