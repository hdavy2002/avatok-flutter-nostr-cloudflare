# Hello Fraands Reels app — Google Play "Data safety" DRAFT

> Status: DRAFT for the owner to copy into Play Console (App content > Data safety). Written 2026-10-19 (HF-WIRE-11) from what the code does today
> (`hf-flutter/`, `worker/`). It is not legal advice; the privacy policy at `Brand.url('/privacy')` must say the same things.
> Package: `com.hellofraands.app`. Re-check this file when any stage adds an SDK, a permission or a table.

## 1. Answers to the top-level questions
| Play question | Answer | Why |
|---|---|---|
| Does the app collect or share any of the required user data types? | Yes | Sections 2-3. |
| Is all collected data encrypted in transit? | Yes | Only `https://api.<domain>` and the payment page over HTTPS (`ApiClient`). |
| Can users request that data is deleted? | Yes | In app: Settings > Delete my account (pay-out-first closure, then deletion after a 30-day grace). Also the web page `/data-deletion` and support email. Provide that URL in the Play form. |
| Does the app follow the Families policy? | No | 18+ only (age confirmation is stored: `hf_age_confirm`). |

## 2. Data collected (what the app / server actually keeps today)
"Shared" in Play's sense = sent to a third party for its own use. Service providers that only process data for us (Clerk, Cloudflare, WhatsApp/SMS sender, the payment gateway, Vobiz) are **not** counted as sharing, except where noted.

| Play data type | What exactly | Required? | Purpose | Shared? | Where stored / how long |
|---|---|---|---|---|---|
| Personal info > Name | Display name (editable in Settings; 2-40 letters) | Optional | App functionality, account management | No | `users`, `hf_user_profile`; deleted with the account |
| Personal info > Email address | Clerk's email, or the one typed at sign-up | Optional (phone-only sign-up exists) | Account management, support, receipts | No | Clerk + `hf_user_email`; deleted with the account |
| Personal info > Phone number | WhatsApp number, verified by OTP. Shown to the app masked (`******3210`); both call parties' numbers are hidden from each other | Required | Account management, fraud prevention/security (OTP), app functionality (we call this number), messages | No (the WhatsApp / SMS / telephony providers process it for us) | `hf_phone_signup`, `contact_verification`; deleted with the account |
| Personal info > Other (age confirmation) | "I am 18 or over" tick + time | Required | Compliance | No | `hf_age_confirm`; deleted with the account |
| Personal info > User IDs | Account id (Clerk user id), host slug / handle | Required | Account management | No | Deleted with the account |
| Financial info > Purchase history / Other financial info | Wallet balance and ledger (top-ups, call charges, booking holds, refunds), payout requests (influencers). **No card, UPI or bank details are typed in the app**: the top-up page is the payment gateway's own page in a Custom Tab, and only the order id and result come back | Optional (needed to call) | App functionality, account management | The payment gateway sees the payment (processor) | Wallet and ledger deleted with the account. **Paid payout rows and refunded refund rows are kept 8 years** for tax/audit, with the identity removed (one-way hash, bank snapshot blanked) |
| Financial info > Other (influencers' bank / UPI for payouts) | Only if the influencer asks for a payout; entered on the web dashboard / payout flow, verified by the owner | Optional, influencers only | Pay the influencer | No | Removed on deletion except as above |
| Messages > Other in-app messages | None stored. Support questions sent from the dashboard (`hf_support_tickets`) | Optional | Support | No | Deleted with the account |
| Audio > Voice or sound recordings | No call audio is stored by us (HF-PRIV-1; internal note only, the owner's rule is that public pages and the store listing never talk about recording, so in Play answer simply that no audio is collected). Calls are two masked phone legs joined by the telephony provider. The app declares the microphone permission for the influencer's optional voice intro; nothing is recorded unless the person uses it | Optional | App functionality (voice intro) | No | `hf_host_media`; deleted with the account |
| Photos and videos | Influencer profile photo and chosen reels (links to the influencer's own YouTube / Instagram posts, not copies); camera permission is declared for the optional selfie video | Optional, influencers only | App functionality | No | `hf_host_media`, `hf_reels`, `hf_channels`; deleted with the account |
| Contacts | Not collected | - | - | - | The app never reads the address book |
| Location | Not collected (no location permission) | - | - | - | - |
| App activity > App interactions | Favourites (saved influencers), "Notify me" requests, invite votes, reviews, bookings, call outcomes. Analytics events are defined (`hf_app_open`, `api_error`, `hf_app_deeplink_opened`) but **PostHog is not wired in the app yet**; the sink only logs in debug builds. When it is wired, add "Analytics" as a purpose and PostHog (EU) as a processor | Optional | App functionality (analytics later) | No | `hf_favourites`, `hf_notify`, `hf_reviews`; deleted with the account |
| App activity > Other (call metadata) | Call records: who called whom (internal ids), start/end time, duration, charge, outcome, reason for failure. **Never phone numbers in the app responses** | Required to call | App functionality, fraud prevention/safety, compliance | The telephony provider carries the call | `hf_calls` kept **1 year** then deleted by the daily purge (HF-PRIV-6); deleted on account deletion unless held for a safety report |
| App info and performance > Crash logs / Diagnostics | Server-side error reports (`trackException`) with the account id and route; the app sends nothing to a crash service today | - | Analytics / debugging | No | Operational logs |
| Device or other IDs | Firebase push token (`hf_push_tokens`) once push is switched on; Clerk device session token in secure storage | Optional | App functionality (notifications), security | Firebase Cloud Messaging delivers pushes (processor) | Token removed on sign-out and on account deletion |
| Web browsing, Calendar, Health and fitness, Emails/SMS content | Not collected | - | - | - | The app does not read SMS or email |

## 3. Data shared with third parties (Play's "shared" column)
Play counts sharing only when a third party may use the data for its own purposes. We believe the answer is **No for every data type** as long as each provider is under a processor contract. The owner should confirm this for: the payment gateway (it keeps its own payment records by law), the telephony provider (call detail records by law), and Google / Firebase.

## 4. Security practices (Play form section)
- Data encrypted in transit: yes (HTTPS only).
- Data at rest: stored on Cloudflare D1 / R2; sensitive IDs and bank details are encrypted (`pii_crypto`); the Clerk token is kept in Android secure storage.
- Users can request deletion: yes (section 1).
- Independent security review: no (answer "No").
- Committed to the Play Families policy: no.

## 5. Deletion, exactly as built
1. Settings > Delete my account reads `GET /api/hf/account/exit`.
2. No money in the account: `POST /api/account/delete` schedules deletion with a **30-day grace**; signing back in within 30 days restores the account (`POST /api/account/delete/cancel`).
3. Money in the account (HF-PAY-14): `POST /api/hf/account/exit` first creates the influencer's final payout and the caller's refund to the original payment; test credits are dropped; when every payout/refund is paid or rejected by an admin, the 30-day grace starts. The person can stop the closure until a payment is approved (`DELETE /api/hf/account/exit`).
4. After the grace, the purge removes the tables listed in `worker/src/lib/hf_purge.ts` (`hfPurgeTables`), the media in R2 and the account's sign-in identity (see `worker/src/routes/account.ts` and the deletion consumer). Exceptions: paid payout and refunded refund rows (8 years, identity removed), and safety records kept for an open report.

## 6. Permissions declared (AndroidManifest)
`INTERNET`; `CAMERA` and `RECORD_AUDIO` (optional, influencer voice intro / selfie video; `required=false` features); `POST_NOTIFICATIONS`. Storage permissions are removed. Play asks why for each sensitive permission: say "optional influencer features, requested only when the person uses them".

## 7. Open items for the owner before submitting
1. Decide whether `CAMERA` / `RECORD_AUDIO` ship in the first release; if the voice intro and selfie video are not in the build, remove the permissions and the two lines in section 2.
2. When PostHog and Firebase push are wired (HF-WIRE-12), add: App activity > App interactions with purpose **Analytics**, and Device or other IDs with purpose **App functionality**; re-check section 3.
3. Publish the same deletion instructions at `/data-deletion` (the page exists) and paste its URL in the Play form.
4. Confirm processor contracts (section 3).
