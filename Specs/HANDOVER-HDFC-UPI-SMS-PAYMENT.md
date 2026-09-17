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
