# Calendar audit — creator experience, app and web
Date: 15 September 2026 · Scope: production · Read-only audit · Expanded Android phone review included

**Are Android and web the same calendar? They share saved scheduling data and server-side booking checks, but use separate interfaces. They are not feature-identical, and an already-open screen does not necessarily refresh immediately.** This report covers both. See the comparison below and the additional Android findings at the end.

**Verdict: the shared booking foundation exists, but the creator experience is not yet consistent or clear enough to call this finished.** The most serious gap is that the app's active listing form does not use the newer listing-specific availability controls. There are also practical problems with full-day blocks, multiple breaks on one day, calendar display accuracy, and Google sync feedback.

This is not evidence that production is routinely double-booking people. It is evidence that creators can misunderstand what they have reserved, and that some important actions are harder or less reliable than they should be.

## What was actually checked
- Reviewed the current main branch and its remote counterpart: `c113cb0c23bd2efaf058c4ef28a9c7718d807bf5`.
- Traced the actual app navigation into its listing form, rather than assuming every scheduling component in the repository is in use.
- Read calendar screens, listing forms, customer slot pickers, scheduling rules, booking holds, publication reservations, cancellations, rescheduling, Google sync, and existing test coverage.
- Opened the production web calendar. Its page loaded and then required sign-in; authenticated screen interactions were not available in this browser.
- Reviewed PostHog activity for the designated test account and existing GitHub Actions results.
- No application code, live schedules, bookings, payments, flags, or deployments were changed. No local builds or tests were run. The local session target was set to `prod`.
- Graphify was available. Graphiti tools were not available, so project memory could not be read or updated.

**Deployment qualification:** successful web and Android runs reference the audited main revision. The latest recorded Worker deployment found was an older revision, `26ee2c15`, on 14 September. Its log confirms a production deployment and successful scheduling validation. Some Google-readiness rules changed after that revision. A later manual deployment was not ruled out; current main must not automatically be treated as the exact running backend.

## Android versus web — what is shared and what differs
For the same signed-in account and production environment, both clients read and save the same schedule API and read the same listing-availability API. This is one backend schedule shown through two separately written screens: native Flutter on Android, React on web. Android also keeps a local, account-scoped cache.

| Area | Android phone | Web |
|---|---|---|
| Saved working hours and exceptions | Shared server API, plus local cache | Same server API |
| Booking conflict authority | Shared server validation | Same server validation |
| Entry labelled “Availability” | Opens settings from the inspected shell menus | Opens the calendar dashboard |
| Usual hours | Separate settings screen | Working hours tab |
| Month / week / agenda | All exist; phone defaults to Month | All exist; narrow layout adds an agenda |
| Full-day blocks | Supported internally, shown as midnight to midnight | Midnight end conversion is broken |
| Multiple exceptions per date | First exception selected; no independent list editor | Same limitation |
| Repeat a date exception | No repeat control in the phone dialog | Weekly repetition through the horizon |
| Block a holiday date range | No simple range control | No simple range control |
| Google connection | Connect / disconnect and boolean status | Calendar selection, destination, timestamps and reconnect controls |
| Listing-specific Time step | Active native form lacks shared/custom/exclusive controls | These choices exist |
| Refresh | Button and pull-to-refresh; no refresh on return from settings | Reloads on navigation/filter/save; no live subscription found |
| Calendar data shown | Busy blocks and listing slots | Busy blocks plus appointment events |
| Appointment management from diary | Only recognized legacy booking blocks receive action IDs | Day rows do not expose appointment-management actions |

**What should sync:** a successfully saved shared working-hours change or global block should be read by the other client on refresh. A listing-specific change only affects that listing's schedule. “Shared backend” does not mean every policy change automatically overrides existing listing policies, or that both screens present the result correctly.

Evidence: [Android schedule API](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/core/availability_api.dart:125), [web schedule API](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/lib/availability.ts:126), [Android menu destination](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/shell/v2/shell_destinations.dart:108), [web calendar](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:114).

## Your requirements: current assessment
| Requirement | Assessment |
|---|---|
| Set normal working hours | Implemented, but initial setup and policy explanations need improvement. |
| Block a whole busy day | App supports the underlying full-day interval. Web has a midnight conversion problem. |
| Block a holiday or several days | No straightforward date-range/vacation action in the current app or web date editor. |
| Keep two separate breaks on one day | Server supports multiple intervals, but both date editors select and replace the first exception. |
| Reserve time for a published live event | Implemented server-side, including checks against other commitments. |
| Reserve specific time for a 1:1 listing | Supported by the backend's exclusive mode; not properly exposed by the active app listing form. |
| Prevent two customers taking the same creator time | Server checks and atomic reservation admission exist; a production race test was not performed. |
| Keep app and web using the same saved schedule | Shared APIs exist. Form parity and automatic screen refresh are incomplete. |
| Include Google busy events | Implemented, with stale/error protection; app status does not adequately explain readiness. |
| Move or cancel a booking safely | Dedicated lifecycle paths exist; their complete production behaviour still needs controlled acceptance testing. |

## Findings, in priority order

### 1. High — the app's active listing form misses the new availability workflow
**Creator example:** “I want this 1:1 to be available only on Friday at 4 pm, and I want that time kept free.”

The active app Time screen offers “Fixed date and time” and “On request,” and asks the creator to type a date such as `2026-12-31T18:00`. It does not offer the web's shared/custom/exclusive availability choices or save a listing-specific schedule through the newer availability controller.

The backend only reserves a fixed 1:1 listing at publication when its schedule is explicitly exclusive. Entering a start time in the active app form does not establish that mode. For a new listing without a separately configured exclusive schedule, the date entered is therefore not enough to reserve the creator's time.

Newer native scheduling controls do exist in separate files, but repository references show they are not connected to this active screen. This is a wiring gap, not simply missing explanatory text.

**Change:** use one clear Time step in both products: “Use my usual hours,” “Choose different hours,” or “Reserve specific dates.” Provide an actual date/time picker, show existing commitments, and display a plain confirmation of what will be reserved.
Evidence: [active Time screen](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/marketplace/native_listing/native_listing_wizard_screen.dart:1551), [active save](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/marketplace/native_listing/native_listing_wizard_screen.dart:1061), [navigation](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/shell/v2/shell_destinations.dart:122), [exclusive publication requirement](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/routes/listings.ts:2870).

### 2. High — a full-day block does not round-trip correctly between app and web
The app represents a whole day as minute 0 through minute 1440. The web converts 1440 into “00:00,” then reads that back as minute 0. Its date editor rejects the result because the end is not after the start.

**Creator impact:** a day blocked in the app cannot be saved unchanged in the web date editor. Web creators also have no simple “All day” control and default to 9 am–5 pm, which is not the same as blocking the whole day.

**Change:** add “All day,” preserve the end-of-day value, and support “From this date through this date” for holidays.
Evidence: [web time conversion](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/lib/availability.ts:225), [web date validation](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:71), [app midnight handling](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:924).

### 3. High — creators cannot properly manage several exceptions on the same day
Both screens pick the first saved exception for a date. Saving again replaces that exception rather than offering a separate “Add another time” action. Neither current date editor offers a clear “Remove exception / return to usual hours” action.

**Creator example:** block lunch from 1–2 pm, then try to add school pickup from 4–5 pm. The second edit can replace lunch. Other intervals created elsewhere can remain stored without being individually selectable in this editor.

**Change:** show every interval for the selected day, each with Edit and Remove, plus “Add another time” and “Use normal hours.” Show the time range alongside every blocked/reserved badge.
Evidence: [web first exception and replacement](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:38), [app first exception](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:243), [app replacement](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:785).

### 4. High — the web calendar can hide missing commitment data
The web loads schedules, blocks, events, listings, and Google status separately. If the schedule succeeds but blocks or events fail, the page is marked ready. The main error banner is shown only when the schedule itself failed.

**Creator impact:** the calendar can show an incomplete or old agenda without a visible warning. An apparently empty day must never be taken as evidence that the creator is free. Booking enforcement is a separate safeguard and does not make this display safe to rely on.

**Change:** visibly mark the diary incomplete whenever commitment data fails; retain a clearly labelled last-known view and provide Retry.
Evidence: [loading and error rendering](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:104).

### 5. High — the app's Google “Connected” message does not mean ready
The app keeps only the connection boolean and says “Connected — busy events are imported.” It discards last-success time, per-calendar errors, and selected-calendar details from the status response. The web exposes more of these controls.

A connection can exist while its first import is pending or its data is stale. The scheduling engine checks these conditions, so a creator can see “Connected” while bookings are refused.

There is also a current-main inconsistency: listing availability allows a disconnected Google account through its preliminary check, while booking validation requires a connection. Depending on deployment and account state, customers can see open times that they cannot reserve. The latest recorded backend deployment predates this stricter connection requirement.

**Change:** show the same readiness state everywhere: Not connected, Syncing, Ready, or Needs attention. Explain whether Google is mandatory before the creator reaches submission. Show which calendars block time, the last successful sync, and a working recovery action.
Evidence: [app status](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:982), [readiness rules](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/gcal_availability.ts:9), [availability check](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/routes/calendar_availability.ts:182), [booking check](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/engine.ts:434).

### 6. Medium — Google status on web can overstate freshness
The status endpoint reports the most recent success across calendars; booking readiness evaluates the oldest success among selected calendars. A fresh calendar can therefore mask a stale selected calendar in the headline timestamp. Also, “Refresh calendars” refreshes the calendar list, not an immediate import of busy events.

**Change:** derive the headline from all selected calendars, show per-calendar status, and distinguish “Refresh calendar list” from “Sync busy times now.”
Evidence: [status and list endpoints](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/gcal.ts:98), [readiness calculation](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/gcal_availability.ts:22), [web controls](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:89).

### 7. Medium — one appointment can appear more than once
Web day views concatenate occupancy blocks and appointment events without matching them to a single booking. A confirmed consultation creates an appointment event as well as its busy reservation/block.

**Creator impact:** one booking can appear as both “Blocked time” and “Booked,” inflating busy counts and making the calendar look more crowded than it is. Google export deduplication does not fix this separate display issue.

**Change:** render one appointment card per booking, with its listing, customer, status, and management action. Keep the underlying busy block internal.
Evidence: [web day rows](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:40), [appointment records](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/routes/commercial_checkout.ts:1320), [reservation/block admission](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/engine.ts:489).

### 8. Medium — the app mixes timezones within the same diary
The app groups days and displays bookable slots in the creator calendar timezone, but booking/block cards use the phone's local timezone without a timezone label.

**Creator example:** a creator travelling abroad can see an appointment grouped under one calendar day but showing a local clock time that appears to contradict nearby slots.

**Change:** use the selected calendar timezone for every card and heading. If device time is useful, show it as a clearly labelled second line.
Evidence: [day grouping](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:225), [block card time](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:659), [device-local formatter](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/calendar_data.dart:546).

### 9. Medium — the web listing filter also changes what settings are edited
Selecting a listing fetches that listing's schedule. Switching to Working hours then edits that schedule, but the listing selector is only visible in the Calendar tab. Working hours still describes these as the creator's shared windows.

**Creator impact:** someone intending to change their usual hours can instead change a listing-specific schedule. Conversely, “Block time” under a selected listing creates a listing-specific closure, not necessarily a creator-wide busy block.

**Change:** keep “Editing: all listings / this listing” visible on every tab and save button. Default personal busy time to all listings, with an explicit scope choice.
Evidence: [selected schedule and tab rendering](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:104), [global versus listing block creation](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/routes/calendar_availability.ts:124).

### 10. Medium — calendar policy and listing policy are hard to understand together
The calendar offers notice, buffers, daily limits, slot spacing, and booking horizon. Listings can retain their own policy values. The effective notice also uses the larger of calendar notice and the listing's commercial notice, whose fallback is 24 hours. The web listing save explicitly resets its horizon to 62 days.

**Creator impact:** changing normal calendar policy may not change an existing listing as expected. A “2-hour notice” calendar can still produce no same-day slots. “Buffer after” is also misleading: overlap checks expand the requested interval on both sides.

**Change:** show the effective rules for each listing in plain English, identify inherited versus overridden settings, and preserve a deliberately chosen horizon.
Evidence: [effective schedule](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/engine.ts:309), [web listing save](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/listing-form/ListingWizard.tsx:537), [buffer checks](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/cal/engine.ts:390).

### 11. Medium — date selection is not a clear live calendar preview
The web checks fixed-time conflicts after saving the draft, rather than displaying an occupied/free calendar while the creator chooses the time. The active app form has no equivalent conflict-preview integration. Server submission/publication checks help, but are late feedback.

**Change:** show “Checking…,” “This time is free,” or the conflicting commitment immediately in the Time step. Offer valid alternatives and explain: “Draft: time not reserved yet” versus “Published: time reserved.”
Evidence: [web save-time preview](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/listing-form/ListingWizard.tsx:505), [active app Time step](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/marketplace/native_listing/native_listing_wizard_screen.dart:1551).

### 12. Medium — shared data is not the same as a live-updating screen
Both products fetch the shared backend, but the inspected creator screens do not subscribe to booking changes. Web reloads on initial load, range/filter changes, and its own saves; app provides refresh. An already-open screen can lag after a booking or a change on another device.

**Change:** refresh on foreground/focus and after booking notifications, show “Updated at…,” and offer a prominent Refresh action. Keep server revalidation before every reservation.
Evidence: [web refresh triggers](/Users/davy/Documents/websites/avaTOK-2-Flutter/web/src/islands/dashboard/CalendarPanel.tsx:112), [app refresh path](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:89).

## What is already good
- Published fixed live events reserve creator time; the server also considers live occurrences when checking other appointments.
- Shared/custom availability is intersected with creator hours, while unavailable exceptions take precedence.
- Reservation admission checks overlap again during the database write, with schedule versions and creator-day booking limits.
- Checkout uses expiring holds and validates them again before commitment. Native booking refuses a stale/unavailable selection.
- Commercial cancellation and rescheduling have dedicated paths; rescheduling validates the new slot and uses a guarded move.
- Native calendar caches are account-scoped, with checks for account changes during requests.
- Public availability gives busy/unavailable states without exposing private appointment titles.
- Google integration includes incremental imports, webhook verification, all-day handling, export retry/reconciliation, and suppression of re-imported AvaTOK events.

These are source-confirmed safeguards, not a claim that every recovery path has been proven against live accounts.

## A simpler experience for the creator
1. First visit: “Choose your timezone and usual working hours.” Explain Google setup here, including whether it is required.
2. Main diary: one card per event/appointment, clear times, and a visible last-updated status.
3. Two prominent actions: **Block time** and **Offer time**. Both support all-day, date ranges, and multiple intervals.
4. Listing creation: reuse usual hours by default; make custom hours and exclusive dates explicit choices.
5. Before submission: show the effective schedule, conflicts, booking notice, gaps between sessions, and whether time is already reserved.
6. When busy time overlaps an existing appointment: list affected appointments and link to their reschedule/cancel controls. Never silently cancel them.
7. After every successful save: explain the scope, such as “Friday is blocked across all your listings.”

## Acceptance checks before calling the calendar complete
| Scenario | Expected result |
|---|---|
| Event overlaps another event or a 1:1 | Refused with the existing commitment and usable alternatives. |
| Two customers choose the same time together | Only one obtains the reservation; the other can pick again. |
| Exclusive 1:1 created in the app | Same reservation and visible result as web. |
| Full-day block created in app, edited in web | Whole day remains blocked, including midnight boundaries. |
| Lunch plus another break | Both remain visible and independently editable/removable. |
| Holiday spanning several days | All intended days close across listings; existing appointments are surfaced. |
| Working hours changed with confirmed bookings | Bookings remain protected; creator sees affected commitments. |
| Google meeting created, moved, or deleted | Busy time updates and readiness accurately reflects pending/error states. |
| One selected Google calendar goes stale | App and web both warn; no false “Ready” status. |
| Cancellation, failed payment, or expired hold | Correct time is released without reviving an invalid booking. |
| Appointment rescheduled while another customer books | New time is acquired safely; original is not lost on failure. |
| Creator travels / daylight-saving clock changes | Dates and times remain consistent and clearly labelled. |
| App/web open simultaneously | Changes appear after refresh/notification; stale views are marked. |
| Network fails while loading commitments | A visible warning replaces any implication that the day is free. |
| Switch between family accounts | No previous account's calendar or cached details appear. |
| Phone, tablet, desktop, keyboard and screen reader | Main scheduling actions remain discoverable and usable. |

## Evidence and limits
PostHog returned **2 Google connection URL events**, and **0 schedule-save, slot-pick, checkout-hold, or commercial-checkout events** for the designated test account using the person-email filter over its returned 15 August–14 September window. This is insufficient to establish successful end-to-end calendar use. It does not prove nobody used the feature or that all events are instrumented correctly. No synthetic booking activity was inserted.

Existing [production Worker run](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/34820708084) passed its validation step and deployed successfully. The additive availability migration step was skipped in that run; this alone does not say whether it had already been applied. [Web deployment](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/34867490921) and [Android build](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/34867651214) succeeded at the audited client revision.

The production sign-in barrier prevented authenticated visual testing; no fresh booking, payment, Google edit, or concurrent-request test was performed. Therefore this report identifies source-confirmed defects and usability risks, and supplies the acceptance checks still needed. It does not certify production end-to-end behaviour.

**Recommended order:** first connect the active app listing form to the scheduling workflow; repair full-day/multiple-interval editing and hidden loading failures; then unify Google readiness, timezone display, policy explanations, and cross-device refresh.


## Additional Android phone audit
The original findings already included Android's listing integration, date exceptions, Google status, timezone mismatch, and refresh behaviour. This follow-up traced the phone diary, its settings, navigation, and appointment popup in more detail.

**Verification limit:** the configured Android SDK and Flutter paths were checked. They do not exist in this environment, `adb` was unavailable even after applying the prescribed PATH, and no matching Flutter-run/emulator process was found. No Android control tool was exposed. The following are code-confirmed findings; screen-reader behaviour, visual clipping, and operation on the installed APK have not been tested on a running phone.

### A1. High — modern bookings are not fully actionable from the phone diary
The diary only passes a booking ID to its popup when the block source is exactly `avabooking`. Modern unified reservations use `availability`, while commercial commitments can also use `avaconsult`. These blocks therefore reach the popup without the booking ID needed for Join, New time, or Cancel.

The source-style map also lacks `availability`, so it falls back to the label “Busy.” A creator can see an important commitment without a clear indication of what type it is or a direct route to manage it. Other appointment pages exist, so this finding concerns the diary entry point, not the absence of management everywhere.

**Change:** resolve every diary item to its actual booking/listing, show its real status, and open the correct commercial appointment or event page. Do not send modern bookings into an incompatible legacy action.
Evidence: [phone card ID condition](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:639), [popup action conditions](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/booking_card.dart:118), [source fallback](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/calendar_data.dart:45).

### A2. Medium — the most obvious “Availability” entry misses the diary
The inspected shell routes “Availability” to the settings screen. That screen provides hours and Google settings, rather than the diary with “Block time.” The calendar is reachable elsewhere, including through listing creation.

**Creator impact:** someone who wants to block Friday can reasonably open Availability and find only settings. This is an avoidable navigation detour.

**Change:** make “Calendar & availability” open the diary with direct access to Working hours and Connected calendars. Use the same name and structure on web.
Evidence: [shell destination](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/shell/v2/shell_destinations.dart:108), [settings contents](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:1004).

### A3. Medium — Android offers an unlimited daily setting that the server refuses
The phone explicitly prompts “Maximum per day (0 = no limit).” Its numeric dialog accepts zero, but the schedule endpoint requires a daily limit between 1 and 100.

**Creator impact:** selecting the advertised option produces a save error instead of applying it. The server prevents the invalid value; the problem is the promise made by the screen.

**Change:** align the prompt and input limits with the supported policy. Validate before closing the dialog and explain the allowed range next to the field.
Evidence: [phone limit prompt](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:1151), [numeric acceptance](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:1267), [server limits](/Users/davy/Documents/websites/avaTOK-2-Flutter/worker/src/routes/calendar_availability.ts:102).

### A4. Medium — Agenda mode renders the selected day twice
On a narrow phone screen, the layout always renders the calendar panel followed by the full agenda. Choosing Agenda also puts a compact agenda inside the calendar panel. The same selected-day bookings and blocks are consequently rendered in both places.

**Change:** render the agenda once. Make Agenda the useful phone default, with a compact date selector and an optional month overview.
Evidence: [narrow layout](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:286), [agenda inside calendar panel](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:385).

### A5. Medium — previous/next navigation can leave the displayed day behind
The arrow buttons change the month being loaded but do not move the selected date. Week view is based on the selected date, and Agenda is also based on that date.

**Creator example:** choose a September day, switch to Week or Agenda, and press next month. The heading can say October while the displayed week/day still belongs to September. The blocks just fetched are for the new range, making the old selected date potentially incomplete.

**Change:** navigation should follow the active view: one month, one week, or one day, and move the selected date consistently.
Evidence: [month arrows](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:408), [week selection](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:526), [agenda selection](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:590).

### A6. Medium — returning from settings leaves old diary information visible
Opening settings does not await the screen's return and reload the diary. The settings screen saves successfully to the backend and cache, but the previous diary remains in memory.

**Creator impact:** change working hours, press Back, and the calendar can still show the old schedule until a manual refresh. This looks like the save failed or sync is broken.

**Change:** reload after settings close, and show a brief “Working hours updated” confirmation.
Evidence: [settings navigation](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:274), [settings save](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:1214).

### A7. Medium — “0 open” can mean availability was never loaded
The phone only fetches listing slot availability when a particular listing is selected. In All listings, the week view nevertheless renders the absent count as “0 open.”

**Creator impact:** zero appears to mean there are no bookable times, even though the screen has not calculated that number. The week cells also show slot times rather than an overview of all actual appointments.

**Change:** show “Select a listing to see bookable slots,” or compute an appropriate creator-wide summary. Keep “unknown” distinct from zero, and display actual commitments in week view.
Evidence: [conditional availability fetch](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:177), [zero fallback](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:560).

### A8. Medium — phone blocking needs clearer scope and less technical language
“Block time” opens the existing exception for the selected day without forcing Unavailable. If that exception is Available or Reserved, the dialog opens in that state. When a listing filter is active, the save uses that listing's schedule, but the dialog describes a “shared creator resource.”

The dialogue also uses “Date exception,” shows full-day blocking as midnight to midnight, and has no repeat, date-range, or delete action. These reinforce the earlier findings about busy-day management.

**Change:** make Block time start with an explicit blocked state and show “All listings” versus “Only this listing.” Replace technical wording with “I'm busy,” “I'm available,” and “Keep this time for a listing.” Add All day, Repeat, Date range, and Remove.
Evidence: [Block time handler](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:366), [save scope](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:785), [dialog state and wording](/Users/davy/Documents/websites/avaTOK-2-Flutter/app/lib/features/calendar/avacalendar_screen.dart:825).

## Combined conclusion after the phone audit
**Keep one shared scheduling backend, and bring both interfaces to the same clear behaviour.** Rebuilding a separate Android calendar backend would increase the risk of disagreement.

The Android calendar is real and already connected to the shared scheduling system. However, it is not an equivalent copy of the web calendar. The active native listing form and phone diary both need attention.

Extend the earlier acceptance checks with these phone-specific cases:
- Open Calendar & availability from the main menu and block a day without hunting through other screens.
- Tap a modern event or 1:1 booking and reach its correct management page.
- Change working hours, return to the diary, and see the update immediately.
- Switch Month / Week / Agenda, navigate forward/back, and verify matching dates and no duplicate agenda.
- Check All listings without showing unknown availability as zero.
- Save a full-day block, two breaks, and a holiday on Android; confirm identical meaning on web after refresh, then reverse the direction.
- Try invalid numeric settings and receive an inline explanation before saving.
- Confirm the actual installed APK and live web/backend revisions, then complete the controlled scheduling, sync, and booking tests.

No application changes, new build, deployment, booking, or calendar mutation were made during this extension.
