# HF-NATIVE-AUTH — WhatsApp-only sign-up and sign-in for the native app (HF-AUTH-WA-1)

Status: Worker + web built 2026-10-10, **dark** behind `hfPhoneOnlySignupEnabled` (server-only, default false, never in the public config).
Code: `worker/src/routes/whatsapp_auth.ts`, tests `worker/src/routes/whatsapp_auth_phone_only.test.ts`, migration `worker/migrations/2026-10-10-hf-auth-wa.sql` (CREATE only; apply to D1 before the flag is flipped).

The app signs a person up or in with ONLY their WhatsApp number. No email, no password, no SMS (Clerk SMS stays off).

## 1. The three calls (all unauthenticated except the last)

Base URL = the API origin the app already uses.

1. `POST /api/auth/whatsapp/send` body `{ "phone": "+919876543210", "client": "android" }`
   200 `{ ok, phone_masked, expires_in_s: 600, resend_after_s: 30 }`
   Errors (JSON `{ error, message }`): `invalid_phone` 400, `not_on_whatsapp` 400, `rate_limited` 429 (30 s gap per number, 5/hour per number, 10/hour per IP, 300/hour global), `otp_unavailable` 503, `provider_error` 502.
2. `POST /api/auth/whatsapp/verify` body `{ "phone": "+91…", "code": "123456", "client": "android", "age_confirmed": true? }`
   - `client` is a telemetry hint only ("android", "ios", "web"); it changes no behaviour.
   - `age_confirmed: true` — send it only if the app's own screen already showed the "I am 18 or over" tick and the person ticked it. Then the server stores the confirmation and `needs18Plus` comes back false.
   200 `{ ok:true, status:"signed_in", ticket, isNew, needs18Plus, phone_masked? }` — a ticket for an existing account OR a brand-new one (flag on).
   200 `{ ok:true, status:"needs_email", proof, phone_masked }` — **only while the flag is off.** A native build must treat it as "phone sign-up not open yet" (show a message); it must not try the email flow with it.
   Errors: `wrong_code` 400 (`attempts_left`), `code_expired` 410, `too_many_attempts` 429 (5 tries per code), `no_code` 400, `verify_failed` 502, `signin_failed` 502, `signup_failed` 502 (the code is given back; retry the same code), `signup_in_progress` 409 (a double-submit is being finished; retry after `retry_after_s`).
3. `POST /api/hf/account/age-confirm` (Bearer session JWT) body `{ "confirmed": true, "client": "android" }` -> `{ ok, confirmed_at }`. Idempotent; the first confirmation wins.

`isNew` and `needs18Plus` are present only while the flag is on. `needs18Plus` is true for an account created by this flow that has not confirmed 18+ yet — including on later sign-ins — so an app killed on the age screen is asked again at the next sign-in. Accounts that pre-date this flow never get `needs18Plus: true`.

**Order in the app:** verify -> if `needs18Plus`, show the 18+ tick (copy: "I'm 18 or over and I agree to the terms and safety rules"; HF-PROD-6, HF-WELL-10) -> redeem the ticket (section 2) -> `age-confirm` with the new session JWT -> continue. The app may instead show the tick BEFORE verify and send `age_confirmed:true`; both are valid.

## 2. Redeeming the ticket (Clerk Frontend API, native mode)

The ticket is a Clerk sign-in token (10 minutes, single use). The app does exactly what `app/lib/auth/clerk_client.dart` already does for Google tickets (`ClerkClient`, the block after "Redeem the ticket"); reuse that class — add one method that takes a ticket and runs the same three lines.

- FAPI host: derived from the Clerk publishable key (`pk_…_<base64>`: base64-decode the part after the last `_`, drop the trailing `$`). Example form: `clerk.<domain>`.
- Every request: `https://<host>/v1<path>?_is_native=true&_clerk_js_version=4.70.0`, headers `Accept: application/json`, `Content-Type: application/x-www-form-urlencoded`, `clerk-api-version: 2025-11-10`, `x-mobile: 1`, and `Authorization: <client token>` once you have one. (`_is_native=true` is the value the working Google flow uses; `=1` is not used anywhere.)
- The **client token** is NOT in the JSON body: after any call, read the response header `authorization` and store it (secure storage, key `clerk_client_token`). Send it back on every later call. It is the long-lived credential of the signed-in device.

Steps:
1. `POST /client` (empty form body) — creates the device client and returns the `authorization` header. (Skip if a client token is already stored.)
2. `POST /client/sign_ins` form `strategy=ticket&ticket=<ticket>` — success = `response.status == "complete"` and a session in `client.sessions`.
3. `GET /client` — confirm `response.sessions[]` has `status == "active"`; remember its `id` (the session id).
4. Session JWT for the Worker: `POST /client/sessions/<sessionId>/tokens` (empty form body) -> `{ jwt }`. This RS256 JWT (~60 s life) is the `Authorization: Bearer <jwt>` the Worker verifies against Clerk's JWKS. Cache it until ~75% of its `exp`, then mint again (the existing `sessionToken()` single-flight + backoff logic does this; do not write a second one).
5. Sign-out: `DELETE /client` (clears all sessions on the device) and delete the stored client token.

The session persists across app restarts because the client token is stored; on start call `GET /client` and mint a JWT. If `GET /client` shows no active session the person is signed out: restart at `send`.

## 3. What the server does for a brand-new number (flag on)

1. The code is checked (same ledger and limits as the web).
2. A claim row is inserted in `hf_phone_signup` (PRIMARY KEY = sha256(E.164)). Exactly one of N concurrent verifies wins it; the others wait up to ~5 s and reuse the winner's account (so a double-tap or a retry never creates two users).
3. Clerk Backend API `POST /v1/users` with `external_id = hfwa_<24 random hex>` (chosen before the call, so a retry after a crash finds the same user), `username = hf<24 hex>`, `first_name "New"`, `last_name "User"`, `skip_password_checks`, `skip_password_requirement`, `public_metadata.signup = "whatsapp_only"`. No `email_address`, no `phone_number`.
4. App rows, in one D1 batch, mirroring web sign-up + phone claim: `users` (created_via `web`, `phone_hash`, `private_number`, `show_private_number=0`), a verified `phone_otp` row, `contact_verification` (phone_verified=1), then `ensureHandle` for the @handle.
5. `POST /v1/sign_in_tokens` -> the ticket in the answer.

The person has NO email on the account. Email can be attached later; nothing in this issue builds that screen.

## 4. Clerk dashboard settings that must be true (exact)

1. **User & authentication -> Email, phone, username -> Email address:** "Sign-up with email" may stay on, but **"Require email address" must be OFF** (email must be optional). If it is required, Clerk rejects the user creation (`form_param_missing` for email_address) and every phone-only sign-up answers `signup_failed`.
2. **Username must be enabled** (it already is; `routes/google_auth.ts` creates users with a username). Do not set a minimum length above 14 or a pattern that forbids letters+digits only.
3. First/last name: may stay required (the Worker sends "New" / "User").
4. Do NOT enable phone number / SMS in Clerk. Not needed.
5. Sign-in tokens (`/v1/sign_in_tokens`) already work for the existing join-link and Google flows; nothing to change.

Smoke test before turning the flag on (staging): flip `hfPhoneOnlySignupEnabled` in KV, send+verify with a spare WhatsApp number, expect `isNew:true`; in the Clerk dashboard the new user has username `hf…`, external id `hfwa_…`, no email.

## 5. Telemetry

`auth_whatsapp_signup { is_new, client }` on every `signed_in` verify (existing numbers: `is_new:false`; in a double-submit only the request that created the account reports `is_new:true`). `auth_whatsapp_verify` and `hf_age_confirm` also carry `client`.

## 6. Known limits

- A number whose earlier account was deleted or purged signs up fresh: a leftover `hf_phone_signup` row is recognised (no live verified account behind it) and restarted with a new external id. The purge job does not need to touch this table.
- The rate limits are unchanged and shared with the web; the Android app must show the `retry_after_s` / `resend_after_s` it is given.
