# Beta soft launch — marketplace preparation and end-to-end test

Target: **PRODUCTION** (`https://avatok.ai`). Production is live. Every write to prod
flags, D1 or KV is a deliberate step — say what you are about to write and why, in one
line, before you write it.

Read before starting: `Specs/RULEBOOK-PAID-SESSIONS.md` (especially §7),
`CLAUDE.md`, `CONFIG.md`.

---

## 0. Ground rules that override the obvious reading of this brief

1. **The creator NEVER transmits from a browser.** Owner decision 2026-09-12,
   rulebook §7, shipped as `[APP-ONLY-TX-1]`. `/live/:id/host` is now a page that
   deep-links into the app — it loads no GetStream SDK and asks for no camera. So the
   host side of every live event, and the creator side of every 1:1, is the **Flutter
   app on the owner's phone** (Closed Alpha build). The browser is the **customer**
   surface. Do not build, restore or ask for a web green room, backstage or Start-live
   button.
2. **Never state a flag value from `config.ts` DEFAULTS.** Read production:
   `curl -s -H 'Cache-Control: no-cache' "https://api.avatok.ai/api/config?cb=$RANDOM"`.
3. **A tick comes from a verdict, not from a call completing.** A step is "passed"
   only when you read the value that means it worked. "The page loaded" and "the
   request returned 200" are not results.
4. **No local build toolchain.** No Flutter, no adb, no emulator. CI only, and only
   if the owner explicitly asks for a build.
5. **Web deploys go through the GitHub workflow**, never a laptop Pages deploy — a
   local build ships without the Clerk key and kills sign-in on avatok.ai. Run
   `check-homepage.mjs` before pushing web changes.
6. **Any code you write gets PostHog telemetry** (`web/src/lib/analytics.ts`) and a
   `tool/ship_manifest.json` entry with a success assertion. Run
   `python3 tool/check_design_guard.py --check all` and
   `python3 tool/check_ship_readiness.py --check all`.
7. Commit through `scripts/git_safe_commit.py` with explicit paths and an `[ISSUE-ID]`
   prefix; push through `scripts/git_safe_push.py`. Never `git add`/`git commit`/
   `git push` directly.

---

## 1. Pre-flight — confirm these before doing any work, and stop if one fails

| Check | How | If it fails |
|---|---|---|
| Admin access | Admin is gated by the Worker env var `ADMIN_UIDS` (Clerk uid), **not by email**. Confirm the uid for `hdavy2002@gmail.com` is in `ADMIN_UIDS`. | Stop and ask the owner. `/admin/listings` will 403 otherwise. |
| Customer account | `guestCheckoutEnabled=false`. A buyer needs a full signup: email code **plus** a +91 SMS OTP (2Factor). | Ask the owner for a spare number before starting. This blocks all of §4. |
| Razorpay mode | Prod runs `razorpayEnabled=true` with **test keys** (`rzp_test_…`). Confirm on the cache-busted config endpoint. | If it is not test mode, stop — do not show a "no real money" message. |
| Razorpay dashboard webhook | Still does not exist (`https://api.avatok.ai/api/pay/razorpay/webhook`). Razorpay has no API for it and browser automation refuses payment-provider dashboards. | **Owner action.** Report it and continue; note in the final report which cases this leaves untested. |
| Creator poster subject | The poster model paints the creator. Make sure the admin account's profile has a face photo and gender set, or the model invents a person from the title. | Fix the profile first. |

Out of scope because the flags are off in prod — do not test, do not report as broken:
`commercialRecordingEnabled=false`, `commercialReplayEnabled=false`,
`commercialConsultExtensionEnabled=false`, `listingPromotionsEnabled=false`,
`listingSlotsEnabled=false`, `listingMaxPerBookingEnabled=false`.

---

## 2. Create the marketplace listings

The owner deletes the existing pending listings first. Then, signed in as the admin
account, through the real web wizard at `/dashboard/listings/new`:

* Create **at least 16 listings**, all owned by the admin account.
* Mix live group events (`live_event`) and private 1:1 sessions (`consult_1to1`) —
  IT consulting, startup mentoring, language practice, career advice, creator
  workshops, photography, cooking, music.
* Every listing gets a title, a useful description, a category, a **price**, duration,
  capacity and a future date and time.
  * **Price every listing.** `freeEntryAllowlistOnly=true`, so a free listing will not
    publish from a non-allowlisted account.
  * `consult_1to1` capacity is forced to 1 by the server — do not fight it.
* Generate the poster through the wizard's own image step (`posterAutoGenerateOnSubmit`
  is true in prod), look at each one, and approve the listings through `/admin/listings`.
* Label them clearly as beta/demo offerings. **Do not invent professional
  qualifications, reviews, ratings or confirmed guest speakers.**
* Note: `listingFeeEnabled=true` and `listingAiReviewEnabled=true` — 16 listings means
  16 listing fees and 16 AI review passes. Report the total.
* Verify the published listings render on `/marketplace` and on each `/l/:id`,
  desktop and at 390px width.

If the marketplace shows skeletons and then "no listings", that is truthful — check the
D1 row count before touching the client.

---

## 3. Beta checkout — this is a BUILD task, not a check

**There is no test-mode banner and no test-card block in the web checkout today.** It
has to be built.

* Build a beta notice that appears **only** when the selected gateway is Razorpay and
  the account is in test mode. `payGatewayPickerEnabled=true` and `paytmEnabled=true`,
  so the picker also offers Paytm — either hide Paytm for the beta or make the notice
  gateway-aware. Never show "no real money will be charged" next to a gateway you have
  not verified is in test mode.
* Wording: "This is a beta demonstration. Payments are in test mode, and no real money
  will be charged. Please use the test payment details shown below."
* The test credentials are already recorded in `CONFIG.md` — card `4111 1111 1111 1111`,
  OTP `1111`, UPI `success@razorpay`. Cross-check them against Razorpay's current
  official documentation; do not guess, and do not invent alternatives.
* Show them only in beta/test checkout, never on a live-mode page.
* Also surface the beta status on the listing page, so a customer knows before reaching
  checkout.

Then test, through the interface:

* successful payment, failed payment, cancellation, retry;
* double-clicking Pay, refreshing mid-flow, and using the browser back button out of
  checkout and returning — none may create a second booking;
* a failed or abandoned payment grants no event access.

Terminal success state is **`credited`**, not `paid` — a poller that waits for `paid`
will sit on the timeout screen forever. The existing duplicate guards are
`ticket_already_owned`, `consultation_already_booked`, `calendar conflict` and
`slot_already_booked`; confirm each one you can reach and name the ones you could not.

**Group capacity:** confirm a group event actually refuses the booking that would exceed
`capacity`. If no sold-out enforcement exists in the checkout path, report it as a
finding — do not quietly pass it.

---

## 4. Customer booking journeys

With the separate customer account, book 2–3 group events and at least one 1:1, through
the normal interface. For each:

* listing details, availability, date, time, timezone, duration, price;
* checkout, test payment, confirmation screen, booking history;
* the confirmation email actually arrives in that inbox;
* the email carries correct event details, booking reference, test-payment note and a
  working access link;
* clicking the link opens the correct event;
* the customer's booking and the host's attendee list agree.

Two things about the link, so you test the right behaviour:

* The emailed link is `/j/<token>` and **deliberately needs no login** — it redeems a
  Clerk sign-in ticket and drops the customer straight into the room. It is not
  single-use, on purpose (phone, then laptop). If it demands a sign-in, that is a bug.
* A bare `/live/:id` or `/session/:id` reached from anywhere else **keeps** the
  email-code gate. Test the "signing in returns me to the same event" path there.

Send test emails only to accounts controlled for this testing.

---

## 5. Editing after publication and booking

Back on the admin account, edit a published listing's permitted fields (description,
image) via `/admin/listings` and confirm the change saves and reaches customers.

**Date/time immutability needs code, not just a check:**

* The creator's own `PUT /api/listings/:id` already refuses:
  409 `cannot move a published event — cancel and re-create`. Verify it still does.
* `PUT /api/admin/listings/:id` **currently allows** `starts_at`, `timezone`,
  `duration_min` and `capacity` — they are in `ADMIN_EDITABLE` in
  `worker/src/routes/admin_listings.ts`. For this phase, gate the schedule fields on the
  server for published listings and return a clear error. Keep the edit logged
  (`listing_approval_history` + `admin_audit`) and keep the approval, as today.
* Confirm edits preserve existing bookings and existing `/j/` access links.
* Test cancellation: the cancelled-event message, and that a customer cannot join a
  cancelled session. The refund policy in prod is creator-cancel 100%, provider-failure
  100%, late-cancel 0% — check the refund email says the right thing.

---

## 6. Event access across the lifecycle

Create a separate short test event that ends about a minute after it starts. Check the
wizard's minimum duration first; if it will not accept one minute, use the shortest it
allows and say so. Keep temporary test events out of the final public showcase.

Open the event from its booking email in a normal window and an incognito window:

* **Before:** scheduled time plus a clear "not started yet" message or countdown.
* **During:** an authorised customer joins successfully.
* **Host not present:** a clear waiting message. Note the prod windows —
  `commercialLiveStartGraceMin=15`, `liveHostGraceMin=10`,
  `sessionCreatorCheckInMin=20`, consult join window early 10 / late 2.
* **After:** "This event has ended" — not a broken page, an endless spinner, or a live
  Join button.
* **Signed out:** on a bare `/live/:id`, sign-in is requested and returns to the same
  event.
* **Wrong account or no booking:** an explanation that the account has no access.
* **Invalid or tampered link:** a useful error with a way back to the marketplace.
  A cancelled, refunded or expired entitlement must return 410 on every open.

Confirm that forwarding a booking link does not bypass the intended rules — the
entitlement is re-read on every open, so prove that, don't assume it.

---

## 7. The live session and the 1:1 — one browser, one phone

**Host = the Flutter app on the owner's phone. Customer = the browser.** There is no
web hosting surface, and two browser windows cannot test this.

Coordinate with the owner for the host side; he starts the event in the app. On the
customer side in the browser, check:

* camera/mic permission prompt, denied permission, and the recovery instructions;
* the waiting room: own local preview plus "Waiting for <creator>…" — media only starts
  when the session DO reports the other party present (GetStream minutes are avaTOK's
  cost, nobody waits inside a call);
* 1:1: audio and video work in both directions;
* group livestream: the customer sees the host's video, and the audience mic/camera
  restrictions hold;
* mute, unmute, camera controls, device switching where offered;
* chat, including the file upload in the side chat;
* joining late, refreshing, leaving and rejoining, and a brief network interruption —
  reconnection must not create duplicate participants or overlapping audio;
* an unrelated signed-in user cannot enter a private 1:1;
* ending the session from the app updates the customer's screen correctly.

Overlapping bookings for the same host are prevented by the calendar claim — test it by
trying to book two sessions on the same slot.

---

## 8. Fix, re-test, report

Record every failure: page, steps to reproduce, expected, actual, screenshot where it
helps. Fix what is in this scope; if an essential part of the booking or session journey
is missing, build it and test it through the interface. After each fix, repeat the failed
journey **and** the behaviour next to it. Nothing is marked passed unless you tested it.
If credentials, provider access or a dependency blocks a test, name the exact blocker —
do not route around it and do not mark it passed.

Finish with a short report in simple English:

* listings created and published;
* customer and host journeys tested;
* problems found and fixed;
* anything still failing or untested, with the reason;
* whether the marketplace is ready for the beta soft launch.

Leave at least 16 polished beta listings live, and remove or unpublish the temporary test
listings.

---

## 9. Known gaps you will meet, so you do not misdiagnose them

* **No Razorpay dashboard webhook.** The `/verify` fast path still credits an order, so
  normal payments work, but a payment whose browser died is never reconciled. Owner
  action only.
* **The hourly fee (₹25 + 20%) is not wired into settlement** — the commercial policy
  snapshot fixes the split at checkout. Out of scope here.
* **`recordCommercialStreamEvent`**: a provider `call.session_ended` currently ends the
  commercial session. The schedule, not a provider event, should end it. If you see a
  creator who steps out being settled as "buyer no-show", that is this — report it,
  do not fix it inside this test run.
* **The app listing detail is native** (`NativeListingDetailV2`). A fix to a web listing
  page does not reach the app.
* **The free lane is off** (`liveEnabled=false`, `consultEnabled=false`); the paid
  commercial lane is what is live. A free show will not behave like a paid one.
