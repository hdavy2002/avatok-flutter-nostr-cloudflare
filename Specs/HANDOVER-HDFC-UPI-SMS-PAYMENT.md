> **2026-09-18 v2 Worker/web deployed and migration applied.** Historical v1 details below are not
> the v2 operating contract. Current approved scope: [revised plan](PLAN-HDFC-UPI-SMS-FIX.md).
> See the v2 contract and release evidence at the end. Fresh ₹1 phone-to-bank test remains unverified.

# HDFC UPI SMS payment gateway handover

Last updated: 2026-09-17

## Purpose

This integration is a local/production smoke harness for one HDFC account. It
proves the end-to-end path:

1. A signed-in browser creates a fixed ₹1 UPI QR for the hidden dummy listing.
2. The customer scans the QR with PhonePe, Paytm, or another UPI app.
3. HDFC sends the credit SMS to the Android companion phone.
4. The companion validates and signs the SMS, then posts it to the production
   Worker at `/api/sms/incoming`.
5. The Worker validates the device signature, sender, amount, credit wording,
   and account suffix, then stores the receipt in D1.
6. The browser polls `/api/pay/hdfc-sms/status` and displays the dummy thank-you
   page after the matching receipt is confirmed.

The smoke flow does **not** create a commercial order, charge platform fees,
apply creator pricing, provision a real ticket, or run the normal paid-event
checkout. Commercial checkout remains a separate path.

## Production configuration

- Browser/Worker base URL: `https://api.avatok.ai`
- Smoke page: [https://avatok.ai/test/upi](https://avatok.ai/test/upi)
- Smoke listing: `avatok-upi-smoke-2026`
- Production device ID: `avatok-prod-hdfc-01`
- HDFC account suffix: `3055`
- HDFC sender allowlist in the companion: `HDFCBK,HDFCBN,HDFCBANK`
- Production flag: `hdfcSmsEnabled=true`
- UPI payee VPA and device HMAC secret: stored as production secrets and not
  recorded in this document.

Never put the device secret, VPA credentials, account number, or SMS contents
containing private details into source control or a handover shared outside the
team.

## Code and deployment history

Parent repository: `hdavy2002/avatok-flutter-nostr-cloudflare`

- `ab8399ba` — initial production ₹1 UPI smoke test page and HDFC SMS order flow.
- `c5aff4ff` — production pricing snapshot schema needed by the normal checkout
  path; not used by the smoke path.
- `b8404cfb` — receipt reconciliation for open smoke intents.
- `9a8ead71` — made the commercial pricing migration rerunnable.
- `83f11bb0` — isolated the smoke path from commercial pricing and provisioning.
- `e97ac03d` — stopped an old confirmed receipt from auto-confirming a new QR.
- `296ffe93` — enforced HDFC sender, credit-message, amount, OTP exclusion, and
  account-suffix policy in the Worker.
- `5b3d73b3` — separate signed-in checkout email-gate fix.
- Current fix — isolates smoke matching from commercial ₹1 intents, keeps one
  live smoke QR, and recovers a matching receipt for pending/expired smoke
  intents. Deployed to production in run
  [35256433081](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35256433081)
  from commit `864d0ab8`.

Companion repository: `hdavy2002/upeo-sms-gateway`

- `371a30a` — accepts the HDFC sender family safely, including headers such as
  `JX-HDFCBK-S`, `VM-HDFCBN-T`, and `HDFCBANK`.

Relevant files:

- `worker/src/routes/hdfc_sms_payments.ts` — validation, D1 persistence,
  intent matching, status polling, and smoke isolation.
- `web/src/pages/test/upi.astro` — internal smoke page.
- `web/src/islands/checkout/UpiSmokeCheckout.tsx` — QR generation, polling,
  waiting state, and dummy confirmation.
- `sms-companion/lib/src/config/app_config.dart` — companion sender policy and
  production endpoint configuration.

## SMS policy

The Worker accepts a sender containing `HDFCBK`, `HDFCBN`, or `HDFCBANK`.
It then requires all of the following:

- the message says `credited` or `received`;
- an INR/Rs/₹ amount is present;
- the configured account suffix appears in an account-labelled token;
- the message is not an OTP, password/PIN, verification, debit, decline, or
  failed-payment message.

The real test SMS that was received had sender `JX-HDFCBK-S` and stated that
`Rs.1.00` was credited to account suffix `3055`. A later test arrived from
`VM-HDFCBK-S`, proving that sender-prefix variation occurs in practice.

## Tests performed

### Successful pieces observed

- The QR was generated for exactly ₹1.00.
- The bank accepted the payment.
- The companion detected the incoming HDFC message.
- The companion dashboard showed one synced message and zero failures.
- The signed webhook reached the production Worker.
- The verified receipt was written to the production D1 table
  `hdfc_sms_receipts`.
- An earlier smoke attempt was successfully marked `confirmed` with no
  `commercial_order_id`, proving the smoke flow can confirm without creating a
  commercial booking.

### Failure observed on the latest test

The latest receipt was present in production D1:

- sender: `VM-HDFCBK-S`
- amount: ₹1.00
- account suffix: `3055`
- UPI reference: `110703825348`

However, the browser did not receive a success state. The D1 snapshot showed
the receipt stored but no newly confirmed smoke intent. It also showed several
old pending/expired ₹1 smoke intents. The old webhook matcher searched open
intents by amount across the whole database, which allowed stale tabs and
unrelated test sessions to interfere with the intent that the paying browser
was polling. The browser therefore remained pending even though the SMS had
already completed the phone-to-server leg.

## Fix applied

The Worker fix changes the smoke path as follows:

1. Smoke intents are queried separately from commercial intents.
2. Creating a new smoke QR supersedes older pending smoke intents, so the test
   harness has one live QR at a time.
3. The newest live smoke intent is selected when a fresh verified receipt
   arrives.
4. A browser status request reconciles the receipt against the exact intent it
   is polling, rather than selecting another user's intent.
5. A matching receipt can recover a smoke intent that crossed the expiry status
   transition; the receipt must still have been stored after that QR was made.
6. The old-receipt protection remains: a receipt created before the QR cannot
   confirm the new QR.

This preserves the important safety boundary: the companion message is not an
official bank API, and no real commercial fulfillment is triggered by the smoke
listing.

## Deployment and verification still required

The source fix has passed `git diff --check`. Per project policy, no local
Flutter/Worker build is run; GitHub Actions must build/deploy it.

The production deployment completed successfully. The latest real receipt is
still present in D1 and the newest smoke intent remains `pending` until its
browser status request runs against the newly deployed Worker. Opening the
smoke page and creating a fresh QR is the clean verification of the fix.

After the production Worker deployment:

1. Open the smoke page while signed in.
2. Click **Create ₹1 UPI QR**.
3. Scan and pay exactly ₹1.
4. Confirm the companion shows the message as synced.
5. Leave the page open for the polling confirmation.
6. Confirm the page says **Payment received** and shows the dummy event.
7. Verify D1 has one new receipt and the current intent is `confirmed` with
   `commercial_order_id` still `NULL`.

If the page is closed or a new QR is created, use the newest QR for the next
test. Do not reuse a screenshot of an old QR.

## Current limitations

- The browser uses polling, not a push/WebSocket notification. The normal
  polling interval is 2.5 seconds for up to five minutes.
- SMS delivery and mobile internet can be delayed.
- The SMS-derived receipt is evidence relayed by the configured phone, not an
  HDFC merchant verification API.
- One-account smoke matching is intentionally conservative and single-live-QR.
- Before enabling real commercial HDFC checkout, add stronger order-to-payment
  correlation, operational review tooling, and an official payment provider or
  bank integration where available.


## V2 operating contract — 2026-09-18

- Web-only, administrator-only ₹1 smoke test. HDFC is removed from commercial checkout;
  existing HDFC refund identifiers are rejected for manual reconciliation, never wallet fallback.
- One active intent, idempotent creation, explicit owner-only replacement and URL resume.
- Signed bank evidence is stored separately from intent attribution. Both production sample
  SMS messages use `(UPI <12 digits>)`; neither echoes QR tr/tn. Tester UTR is therefore
  required for confirmed attribution. Reference-less/unsupported formats cannot confirm.
- Companion timestamps currently include +03:00 and second precision. Parser respects
  timezone and bounded quantization; receipt time is not payer or settlement proof.
- QR expires after 30 minutes. Original-window evidence can be recovered for 24 hours
  after expiry. GET status is read-only; explicit recheck retries the saved reference.
- One canonical bank identity can claim one intent. Confirmed derives from the stored
  accepted receipt claim; smoke order_id remains null and no commercial service is provisioned.
- Two v2 tables and a readiness view. One-time migration seeds all historical receipt hashes
  as never-claimable legacy metadata, canonicalizes duplicate references and reserves old
  intent-only references. Original rows are preserved. No runtime legacy scan or finance console.
- Phases 1+2 ship together. Before seed readiness, signed ingestion returns retryable 503;
  the companion retains its queue. After readiness, flag-off still permits evidence storage,
  but blocks creation and claim. Do not roll back to the old amount-only matcher.
- Companion acknowledgement distinguishes transport, accepted/ignored/review evidence,
  unmatched/awaiting_reference/confirmed. Display describes last server acknowledgement;
  no green confirmation merely because HTTP returned 2xx.
- Android companion is a separate repository and release from the main Flutter app. No main
  app checkout changes or main app build are required by this work.
- Readiness requires CI receipt/SQL/browser/companion tests plus a fresh ₹1 end-to-end test.
  Only the phone owner can perform the bank payment and install the companion when necessary.

### Release evidence

- Runtime source revision: `8ff312e9`; migration helper revision: `9d70eb5d`.
- Worker production workflow: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35269013764 — passed; exact production approval applied.
- Worker version: `6da907c2-352b-4b77-82d2-cb202343095c`.
- Web production workflow: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35269017562 — passed; exact production approval applied.
- Web deployment: https://b2d66bd0.avatok-app.pages.dev; https://avatok.ai/test/upi returns 200 with private/no-store headers.
- Final safety verification: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35269653640 — passed. 22 Worker real-SQL tests, 8 seed tests, 11 controller tests and 12 React browser tests.
- Whole-Worker TypeScript remains at 76 pre-existing diagnostics: same compiler/dependencies against approved `c06a87b2` baseline found zero new diagnostics and zero diagnostics in changed source files. This is not a clean whole-repository typecheck.
- Production seed applied after combined Worker deployment and ingress drain. Readback: protocol 2, cutover `1789676007000`, two legacy reservations, zero claimed receipts, zero v2 intents. Original two receipts/eight intents preserved. Same-manifest rerun succeeded without mutation.
- Seed digest: `660152c7cd774de1972c22baf6fdfaa9a858a4a75513c44e5fd0e3774f0edc47`. Private immutable manifest: `/Users/davy/.local/share/avatok/hdfc-smoke-v2/production-seed.json` (0600; never commit/upload). Original SQL sidecar preserved privately after deterministic-column-order correction; manifest/cutover unchanged.
- Anonymous production `/api/pay/hdfc-sms/current` returns 401 missing bearer.
- Companion revision: `5a3acf0`, version `1.0.6+6`; https://github.com/hdavy2002/upeo-sms-gateway/actions/runs/35269307182. Verification passed (37 Dart tests plus native Robolectric provider tests); signed release APK build passed. Artifact: https://github.com/hdavy2002/upeo-sms-gateway/actions/runs/35269307182/artifacts/10517978930. Local copy: `/Users/davy/.local/share/avatok/releases/hdfc-smoke-v2-1.0.6/app-release.apk`. Companion workflow has no environment approval gate; main production Worker/web gates were approved as authorized.
- After the signed APK release passed, production `hdfcSmsEnabled` was enabled through the protected delta-only flag wrapper. Readback confirmed true. This enables only the admin smoke harness; commercial HDFC remains removed. No synthetic bank receipt or production intent was created for verification.

### Acceptance and remaining real-device work

A1–A9 have source review and Worker/browser CI coverage; A10–A11 have companion Dart/SQLite/native-provider CI coverage. The actual SQLCipher upgrade on the owner's phone is not proven by host SQLite tests. A12 is partial: authorized CI and production deployment/migration are verified, but one fresh ₹1 end-to-end payment remains outstanding. Install/update the companion without clearing its data, sign into `/test/upi` as admin, create one fresh QR, pay ₹1, enter that payment's 12-digit UTR, and verify the persisted receipt claim with no commercial order or wallet effect. Do not reuse historical screenshots.

Graphify was refreshed. Graphiti push-hook memory writes failed; repository commits/pushes succeeded. No fabricated PostHog payment-success event was sent.


## Invited customer booking test — owner scope change, 2026-09-18

The owner approved a shareable customer experience for his brother. The earlier
administrator-only smoke harness did not meet that purpose. The customer page
now being implemented at `/test/upi` uses an ordinary signed-in account and a
private invitation; administrator diagnostics move to `/test/upi/admin`.

The customer pays a real ₹1 for a clearly marked simulated demo consultation.
A separate persisted test-booking reference is confirmed only by the existing
exact-reference bank-SMS receipt claim. It creates no real appointment, commercial
order, wallet credit, entitlement or calendar reservation. One invitation belongs
to the first account to redeem it and creates at most one payment and test booking.

Implementation contract and acceptance criteria: `PLAN-HDFC-UPI-CUSTOMER-TEST.md`.
The additive invitation/booking migration must not rerun the historical v2 seed.
No companion changes or Android build are needed for this extension. Companion
1.0.6 (6) is already available on Google Play Internal testing.

### Customer rollout evidence

- Runtime revision `34ad04f690933bdbaf66666cd79ae07a42c42657`; preserved the concurrent homepage restoration `6dfc8d21` already on main.
- Preflight build and safety: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35283272751 — success.
- Production Worker: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35283742081 — success; owner-authorized production gate approved. Version `57b96e67-744f-4baf-be78-0d07d5c1405c`.
- Production web: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35283744337 — success; owner-authorized production gate approved. Pages deployment https://23c823cf.avatok-app.pages.dev.
- Both production workflows passed 40 real-SQL Worker tests, 16 Python script tests, 18 controller tests, and 22 React browser tests. New/changed-file Worker type diagnostics: zero. Existing 76 baseline diagnostics remain; this is not a clean whole-Worker typecheck.
- Additive migration `worker/migrations/2026-09-18-hdfc-customer-test.sql` applied through protected cf.sh and read back. The v2 cutover remains `1789676007000`; historical seed was not rerun.
- Production `hdfcSmsEnabled=true` restored after both releases; exact flag readback returned true.
- Live browser verified customer heading, real-charge/test-only disclosure, and ordinary email-code sign-in modal at `/test/upi`; no invitation was redeemed during operator QA. Anonymous customer API returns 401 with `private, no-store`.
- One 24-hour brother invitation issued with hash-only remote storage and verified still unredeemed. Private output and retry journal are under `/Users/davy/.local/share/avatok/hdfc-customer-test/`, mode 0600. Never commit/share these artifacts or put the secret URL in telemetry. Share the generated URL only with the owner for the intended tester.
- PostHog deployment annotation returned HTTP 201. A separate operational deployment event with the owner email and test counts returned HTTP 200; it explicitly records `fresh_payment_verified=false` and contains no invitation, bank reference or SMS. Prior telemetry retrieval was unavailable due connector skill-scope restrictions. Graphiti tools were unavailable and its pre-push hook reported write failure; no memory-write success is claimed. Graphify AST update completed.
- AC1–AC8 verified by the source reviews and GitHub Actions above. AC9 link issuance and live unauthenticated UI verified. The actual brother sign-in/payment/receipt/test-booking confirmation remains pending his real ₹1 transaction and exact 12-digit reference. No synthetic production receipt, payment, booking, commercial order, entitlement or wallet credit was created.
- Astra-only pipeline: one audit/plan agent, two isolated implementation workers, and one independent bounded backend review. No local tests/builds/compiles were run. No companion change or additional Android build was needed.


## Owner simplification — plain public QR (2026-09-18)

The owner explicitly rejected the invitation/sign-in/booking UI and requested just
a QR. `/test/upi` now shows “Scan to pay ₹1”, the payment QR and a same-phone UPI
link. No login, invite, form or booking confirmation is required or shown. Old
invitation fragments are discarded. The standalone page loads no Clerk or analytics.

`GET /api/pay/hdfc-sms/qr` returns only the configured payee UPI URL for exactly
₹1.00 INR when enabled. It creates no intent or booking and makes no receipt claim.
Existing authenticated diagnostic/customer APIs and signed SMS authority remain
unchanged; the earlier invitation UX is superseded on the public page.

Runtime revision `76e6780b`. Worker release
https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35287136920
and web release
https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35287139513
both succeeded after approved production gates. Worker version:
`b986baf2-354b-4792-8ee7-66c315cd5158`. Tests passed: 42 Worker, 16 Python, 18
controller, 24 browser; no new/changed-file TypeScript diagnostics (76 prior
diagnostics remain). Flag restored to true; live anonymous QR GET succeeded and
a shareable PNG was generated from that exact response outside the repository.
No migration or companion build was required. One Astra worker performed the
bounded source audit/implementation; coordinator reviewed the diffs and corrected
the test's DROP VIEW statement before CI. No local application builds/tests ran.


## 2026-09-18 — App-specific ₹1 payment buttons

Owner requested Paytm, Google Pay and PhonePe icons after the generic UPI link opened WhatsApp. The public QR page now preserves the server-provided payment query and targets the selected Android package through a user-tapped browser intent. Missing-app fallback returns to the QR page. Desktop choices point to the QR; iOS uses provider-documented app schemes. No payment is submitted or considered confirmed by clicking a button; native app confirmation remains required. No backend, migration or companion release is needed.

Sources: [Chrome browser intents](https://developer.chrome.com/docs/android/intents), [Paytm Android package list](https://business.paytm.com/docs/upi-smart-intent/), [Google iOS route](https://developers.google.com/pay/india/api/ios/in-app-payments), [PayU iOS prefixes](https://docs.payu.in/docs/upi-intent-server-to-server). Paytm/PhonePe iOS prefixes are provider documented, not verified on a physical iPhone; Setu documentation lists different routes without a platform qualifier. Physical phone handoff and fresh payment remain unverified. Browser coverage checks the three app choices, exact packages, encoded payment parameters, iOS links, narrow layouts and retry behavior without launching a payment.


## 2026-09-18 — Restore customer receipt confirmation

The plain public QR removed the original purpose of this exercise: a waiting customer must see confirmation after the companion forwards the actual bank SMS. The owner explicitly requested repair and production deployment. The public page now creates an anonymous owner-scoped payment attempt, polls persisted status, resumes the same attempt after reload, and renders “Payment received” only for a claimed accepted receipt. Existing app-specific buttons remain. No login, admin role or invitation is required. The session bearer is random, tab-scoped, never in URLs, and hashed to a synthetic owner on the server; knowing an intent ID alone grants no access.

The current HDFC SMS evidence exposes the bank UTR, not the web-generated merchant reference. At fixed ₹1, amount/time alone cannot safely attribute a payment to the waiting customer. This release preserves exact-reference matching and provides transaction-reference entry plus automatic status updates when the matching SMS arrives. Merely opening or returning from a payment app cannot confirm anything. Unique small test amounts for automatic attribution were offered to the owner but are not assumed authorized. No new schema or companion build is needed for the fixed-amount path.

A read-only pre-deployment production check found zero live intents and only two historical legacy receipt reservations, with zero new accepted v2 receipts. Thus a fresh physical-phone payment remains required to verify the complete gateway path; mocked CI evidence is not a real bank payment.


Deployment completed for `bf52f5de4be88c332168f1ab0133916e5e6cf278`: Worker run https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35291691670, web run https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35291694020, both successful. Worker version `04c8c88d-1e3a-4da3-939e-170e056fb987`; Pages https://b8108592.avatok-app.pages.dev. Verification: 47 Worker SQLite tests, 16 Python tests, 18 controller tests and 32 browser tests (113 total). Live anonymous missing-session request returned 401; paused order returned 503; deployed browser rendered the matching paused message without a QR. Re-enabled only `hdfcSmsEnabled` through protected flags.sh after both deployments. No live payment attempt was left occupying the test slot. Physical SMS-to-customer confirmation remains unverified until a fresh payment and matching UTR are supplied. Two Astra workers used; Graphify updated; Graphiti write hook unavailable.


## 2026-09-18 — VPA-linked automatic SMS confirmation (owner-approved)

The owner approved asking for payer VPA and phone before generating the ₹1 QR, with an explanation that the details identify the payment. These are self-reported details, not verified ownership or authenticated identity. The customer must pay using the entered VPA. The normal flow requires no UTR entry: a newly authenticated bank SMS carries the payer VPA, credited amount, receiving account and bank reference; the server matches and claims that evidence, and the waiting page updates from persisted state.

Each payment is a separate attempt with creation, expiry, recovery and confirmation timestamps. Refresh resumes the same attempt. After confirmation, Make another payment creates a fresh request key and attempt while allowing reuse of the payer details. Different VPAs may pay identical amounts concurrently. A still-unresolved attempt reserves its VPA/amount through the recovery window, including after QR expiry. The bank reference remains the duplicate-payment/receipt identity; never match by a two-minute delay alone. Existing legacy/admin/customer exact-UTR behavior is retained separately, and old receipt rows are not backfilled into automatic VPA attribution.

Limit: the signed Android SMS receipt time is not an exact bank transaction timestamp. An unreported extra transfer from the same VPA/amount can remain ambiguous. This is a controlled test integration, not proof of payer-account ownership or demonstrated suitability for millions of daily transactions. No commercial booking or wallet settlement is introduced.

### Verified production rollout — VPA confirmation

- Release commit: `bb36a2cc459a9a0b4076d479c4c55870c27add5a` (implementation `75d7f99a`, narrow public-envelope compatibility fix `bb36a2cc`).
- Worker workflow: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35296446659 — success. Worker version `7b0c5bdc-dc98-44fb-a7d0-e37fe1fadf14`.
- Web workflow: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/35296448679 — success. Pages deployment https://bf9f2525.avatok-app.pages.dev.
- CI: 57 real-SQL Worker tests, 16 migration/invitation tests, 18 controller tests, 37 browser tests = 128 passed. Zero new TypeScript diagnostics; 76 pre-existing baseline diagnostics remain.
- Applied `2026-09-18-hdfc-sms-public-vpa.sql` once to production `avatok-meta` while matching was paused. Readback verified both intent payer columns, receipt payer VPA, four intended indexes, unchanged protocol 2/cutover `1789676007000`, and two historical receipts still without VPA. No seed rerun or historical backfill.
- Re-enabled only `hdfcSmsEnabled=true` after Worker, migration and web deployment succeeded. Live browser shows VPA/phone form and Generate QR, with no normal-flow UTR field. Live read-only probes: QR 200 / INR 100 paise; unauthenticated status 401; capability-scoped unknown attempt 404, confirming schema readiness.
- No Android rebuild needed. Fresh physical-phone payment and companion SMS delivery remain unverified; CI uses synthetic signed receipts and this rollout made no real payment or fabricated production receipt.
- Graphify refreshed by commit hook. Graphiti write unavailable (pre-push hook failed without blocking push).
