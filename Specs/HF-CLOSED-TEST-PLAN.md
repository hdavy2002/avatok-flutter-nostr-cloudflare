# Hello Fraands app: closed test plan (HF-WIRE-12)

Plain-English checklist. Tick each box with a date and your initials. Do the parts in order: A to G.
Related: `Specs/HF-REELS-BUILD-PROGRESS.md` section 5 (go-live checklist), `Specs/HF-REELS-APP-HANDOVER.md`, `Specs/HF-PLAY-DATA-SAFETY.md`, `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md`.

Words used here:
- **Demo build**: the app shows dummy reels, dummy wallet, dummy calls. Nothing is real.
- **Live build**: the app reads the real server only. Made by running the workflow with `demo=false`.
- **The influencer phone** is the phone of the person being called. **The fan phone** is the phone of the person calling.

---

## A. Before anyone tests (owner / last agent)

The live build only works when the server side is ready. Do all of these first.

- [ ] D1 migrations applied (section 5, step 1 of the progress log).
- [ ] Secrets set: `TREG_API_KEY`, `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` (sandbox values for now), `HF_CALL_DID`, `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_WEBHOOK_SECRET`. `YOUTUBE_API_KEY` already exists.
- [ ] Worker deployed.
- [ ] Flags on: `hfFanSignupEnabled`, `hfPhoneOnlySignupEnabled`, `hfChannelsEnabled`, `hfReelsEnabled`, `hfCallsEnabled`, `hfTopupEnabled`, `hfTopupGateway=cashfree`, `hfTokensEnabled`, `hfBookingsEnabled`, `hfFavouritesEnabled`, `hfInvitesEnabled`, `hfPayoutsEnabled`.
- [ ] Clerk dashboard: "Require email address" is OFF.
- [ ] GitHub secret `HF_POSTHOG_KEY` set to the PostHog EU project key (project 139917), so the live build sends analytics and crash reports. Without it the build works but sends nothing.
- [ ] Run the live build (owner asks for it, only then): `gh workflow run hf-flutter.yml --ref main -f mode=internal -f demo=false`. The default `demo=true` keeps the dummy app on the phone.
- [ ] Install the build on both test phones from the Play internal test link.
- [ ] Open the app on each phone: no dummy names (no Meera Joshi, Rohan Mehta, Arjun Rao), no "demo" word anywhere, wallet starts at Rs 0.00. If you see any dummy data in a live build, stop and report it.

---

## B. Two-phone call test (the most important test)

Needs two phones with two different WhatsApp numbers, a real SIM on each, and the Vobiz number configured (`HF_CALL_DID`).

Setup
- [ ] Phone 1 = influencer. Phone 2 = fan.
- [ ] Phone 1: sign up (WhatsApp code), then Me, Join as an influencer, add the channel (see section E), wait for approval, set the rate (for example Rs 10 per minute), go Online.
- [ ] Phone 2: sign up with a different WhatsApp number, tick the 18+ box.
- [ ] Phone 2: top up the wallet (section C) so it has at least Rs 100.

Steps (write down the time of each step)
- [ ] Phone 2 opens the Reels tab and sees the influencer's reel. Phone 1 shows Online.
- [ ] Phone 2 taps CALL NOW. The confirm sheet shows the rate and the wallet balance. Tap to confirm.
- [ ] Phone 1 rings first (a normal phone call from the Hello Fraands number). Answer it.
- [ ] Phone 2 then rings. Answer it.
- [ ] Both people can hear each other. Neither phone shows the other person's real number (it shows the Hello Fraands number).
- [ ] Talk for about 2 minutes. The call screen on phone 2 shows the timer.
- [ ] Hang up from phone 2. The summary screen shows the minutes and the cost. Give a star rating.
- [ ] Wallet on phone 2 went down by (minutes x rate). The Wallet history lists the call.
- [ ] Call records on phone 2 list the call. On phone 1 the earning shows under Ready to withdraw or on hold (7 days).

Things that go wrong, test each once
- [ ] Phone 1 declines: phone 2 is told the influencer was not available, the wallet is not charged, and the "Notify me" button appears.
- [ ] Phone 1 does not answer: same result after the ring time runs out.
- [ ] Phone 2 cancels before phone 1 answers: no charge.
- [ ] Phone 2 has only Rs 5 left: the app says to top up before the call starts.
- [ ] Wallet runs out mid-call: the "About 1 minute left" warning shows, then the call ends by itself. No negative balance.
- [ ] Phone 1 goes Offline: the reel leaves phone 2's feed, and CALL NOW changes to Offline with Notify me.
- [ ] Phone 1 is on a call: phone 2 sees the influencer as busy.

---

## C. Cashfree sandbox top-up test

Use the Cashfree SANDBOX keys only (never live money in this part). The test payment page opens in a browser tab on the website host, not inside the app.

- [ ] Wallet, TOP UP, pick Rs 500. The screen shows the amount you pay including 18% GST and the credit you get (paid divided by 1.18, rounded down to the paisa). Rs 500 gives Rs 423.72.
- [ ] Tap pay. The Cashfree test page opens.
- [ ] Pay with the Cashfree sandbox test card or test UPI id (take the current values from the Cashfree sandbox documentation; do not use a real card). The page shows success.
- [ ] Come back to the app. Within about 30 seconds the app shows "paid" and the wallet shows the new balance.
- [ ] The wallet history shows one top-up line with the right amount. Closing and reopening the app shows the same balance.
- [ ] Pay twice by tapping the pay button twice quickly: only one order is created and the balance goes up only once.
- [ ] Failed payment: use the Cashfree sandbox failure test value. The app says the payment did not go through and the balance does not change.
- [ ] Abandon the payment (close the browser tab): the app shows a slow or pending message and the balance does not change. Retry works.
- [ ] Top up below the minimum (under Rs 10) is refused with a clear message.
- [ ] Top up Rs 1,000 or more asks for a second confirmation first.
- [ ] The receipt or ledger line never shows the payment gateway's name (house rule).
- [ ] Before real money: the owner switches the Cashfree keys to LIVE and repeats this section ONCE with a real Rs 10 top-up, then checks the settlement in the Cashfree dashboard.

---

## D. Booking auto-start test

The booking should ring both people at the booked time by itself.

- [ ] Phone 1 (influencer): Availability, open today with a time about 15 minutes from now.
- [ ] Phone 2 (fan): open the influencer, Calendar tab, pick today and that time, confirm. Rs (rate x 10) is held in the wallet and the booking appears under My bookings on phone 2 and under Bookings on phone 1.
- [ ] Both phones get a reminder (WhatsApp message and/or app notification) before the start time.
- [ ] At the booked time phone 1 rings first, then phone 2, with no button pressed. Answer both and talk for about 1 minute.
- [ ] After the call the held money is settled: fan's wallet shows the real charge, extra hold returned.
- [ ] Cancel test (fan): book another slot, cancel more than 1 hour before. Full hold returned at once.
- [ ] Late cancel test (fan): book a slot less than 1 hour away and try to cancel. The app explains the rule.
- [ ] Cancel test (influencer): cancel a booking. The fan always gets the full hold back and is told.
- [ ] A time that is already booked cannot be booked again by a second fan.
- [ ] Phone 1 closes a day in Availability: that day disappears from phone 2's calendar. A day with a booking cannot be closed.

---

## E. Channels test: one real YouTube and one real Instagram handle

Use real accounts the tester really owns. Each must have at least 10 followers or subscribers (owner rule HF-REEL-23).

YouTube
- [ ] Me, Join as an influencer, Channels, YouTube. Read and tick all four consent boxes. Enter the real channel handle (for example @yourchannel).
- [ ] The app shows a short code to put in the channel description (bio-code ownership proof). Paste it there and save on YouTube.
- [ ] Tap check. The app shows the channel name, the subscriber count (matches YouTube), and "qualified".
- [ ] A different person's channel handle is refused (code not found).
- [ ] The same channel cannot be added from a second account (shows "already claimed").

Instagram
- [ ] Same flow with a real Instagram handle. Put the code in the Instagram bio. Check.
- [ ] The follower count matches Instagram, and the account is public.
- [ ] A private or tiny account says it does not qualify yet, and what to do.

Reels and feed
- [ ] After approval, the influencer's public videos show under My reels. Switch one off: it leaves the feed on phone 2. Switch it back on.
- [ ] Go Online on phone 1: reels show in phone 2's feed, YouTube and Instagram videos play (embed) without a crash.
- [ ] Remove a channel: its reels leave the feed.
- [ ] Facebook shows "coming soon" and cannot be added.

---

## F. Everything else a tester should try (each tester, once)

- [ ] First open: intro screens, 18+ and safety tick, Reels feed.
- [ ] Heart a reel: it appears under Favourites on the same account, and stays after restarting the app.
- [ ] Share a reel: the system share sheet opens with a link. Open that link on another phone: the app opens that reel.
- [ ] Search by name and by exact handle. An influencer not on the app shows "Not on Hello Fraands" and a vote button; one vote per person.
- [ ] Settings: change the name, switch a notification, open the legal pages, Delete account (use a throw-away account). After deleting, the same number can sign up again as new.
- [ ] Sign out and in again: wallet, favourites, bookings are still there.
- [ ] Turn on airplane mode: friendly "no connection" messages with a retry button, no crash, no blank screen.
- [ ] Rotate / lock / background the app during a call and a payment: nothing breaks.
- [ ] TalkBack on (Android accessibility): every button announces a name (Back, heart, share, profile, call, online switch, calendar arrows). Text is readable, nothing under 14 sp.
- [ ] Big font size in Android settings: no screen is cut off.
- [ ] The Android permission list for the app (Settings, Apps, Permissions) only shows Camera, Microphone, Notifications. Never phone, contacts, SMS or location.
- [ ] Force an error on a test device (owner only) and check the `app_crash` event arrives in PostHog with `platform = android-app`.

Report each bug with: phone model, Android version, app version (Me, Settings, version), what you tapped, what you expected, a screenshot.

---

## G. Play closed test (12 testers for 14 days)

Google requires this for a new personal developer account before production. The rule: at least 12 testers opted in, continuously for 14 days. (If your Play Console account is an organisation account, check whether the requirement shows for you.)

Before you start
- [ ] The app is in the Play Console as the Hello Fraands app (package `com.hellofraands.app`, set by the brand file).
- [ ] Store listing done: name, short and full description, icon, feature graphic, at least 2 phone screenshots, privacy policy URL, support email.
- [ ] Data safety form filled from `Specs/HF-PLAY-DATA-SAFETY.md` (phone number, name, email, purchase history, app activity, crash logs and diagnostics; data encrypted in transit; account deletion link works).
- [ ] Content rating questionnaire done. Target audience 18 and over. Ads: none. Declare that the app handles money (wallet, payouts) honestly.
- [ ] App access: give Google a test login or explain the WhatsApp code sign-in, and give a test number that receives the code.
- [ ] Permissions declaration screens: Camera and Microphone are for the influencer's selfie and voice check; Notifications for call and booking alerts. No sensitive permissions.
- [ ] Target API level 36, the AAB signed with the upload key (the workflow does both).

Run
- [ ] Play Console, Testing, Closed testing, Create track (or use the default one). Upload the AAB made with `demo=false`.
- [ ] Create a testers list (email list or Google Group) with at least 12 people who have Google accounts (friends, family, other creators). Aim for 15 to 20 because some drop out.
- [ ] Send each tester the opt-in link. They must open it, accept, and install from the Play Store. They must stay opted in for the full 14 days.
- [ ] Day 1: write the date and the number of testers who opted in: ____ (must be 12 or more, and stay 12 or more every day).
- [ ] Ask testers to open the app at least every 2 to 3 days and to follow section F once. Give them a WhatsApp group for bug reports.
- [ ] Day 7: check PostHog for `app_crash` and `api_error` spikes, fix, and ship fixes as new closed-test builds (a new build does not restart the 14 days as long as testers stay opted in).
- [ ] Day 14: confirm the Play Console shows the "12 testers, 14 days" requirement as met.
- [ ] Apply for production access in Play Console. Answer the questionnaire about the test (what testers did, what you changed). Review can take a few days.
- [ ] While waiting: no open crash that affects sign-up, top-up or calls. Crash-free sessions above 99% in the Play Console Android vitals.

Go to production
- [ ] Owner confirms the live Cashfree keys and a real Rs 10 top-up worked (section C).
- [ ] Owner confirms one real two-phone call worked on the live Vobiz number (section B).
- [ ] Promote the tested build from closed testing to production, staged rollout 10 percent, then 50, then 100 over a week, watching crashes in PostHog and Play vitals.
- [ ] Keep the demo off: every public build is made with `demo=false`.
