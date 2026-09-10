# Unified creator availability — audit and implementation plan

Date: 2026-09-10. Target: production feature. Status: proposal; implementation and release not performed.

## Recommendation

Extend the existing AvaCalendar authority into one listing-aware scheduling system shared by the native Flutter app and Astro/React website. Keep Google Calendar as a connected calendar and notification channel. AvaTOK remains authoritative for bookings, payments, cancellations and conflict decisions.

A creator is one reservable resource, regardless of how many listings they publish. All creator commitments consume that same resource.

## Evidence and limits

Reviewed the three supplied screenshots, opened the live availability URL, consulted project Graphiti/Graphify, and inspected the local web, Flutter, Worker and Google sync implementations. The browser session was signed out, so authenticated production records and actual booking outcomes were not exercised. Local source findings are not proof that every production deployment has identical code. No build, payment, booking, deployment or Google invitation was performed.

PostHog project 139917 was matched to repository documentation and its identity schema was read. The connector returned `Tool read-data-warehouse-schema not found`, preventing the required schema-verified account activity query. No claim of absent telemetry is made. No synthetic production user events were generated for this planning audit.

## Confirmed source findings

| Area | Evidence | Implication |
|---|---|---|
| Web creator calendar | `web/src/islands/dashboard/CalendarPanel.tsx:34` loads events/rules only; failed event requests become an empty list | No visual occupancy calendar, listing filter, date exceptions, or Google controls; errors can look like no bookings |
| Listing Time step | `web/src/islands/dashboard/listing-form/steps.tsx:423` and `:479` expose a date-time input and optional slot rows | Separate controls lack a visible shared diary/conflict preview |
| Customer listing calendar | `web/src/islands/listing/BookingBox.tsx:222` disables only cells outside the current month | Dots indicate schedule information, not enforceable bookability |
| Web checkout | `web/src/islands/checkout/SlotPicker.tsx:204` fetches slots by host only | A listing cannot reliably express its own allowed schedule through this picker |
| Native booking | `app/lib/features/explore/native_listing_booking_flow.dart:70` loads creator/date/duration grid and filters unavailable slots | No listing-specific schedule; occupied times disappear instead of explaining availability |
| Native slot contract | `worker/src/cal/engine.ts:122` emits `start/end`; `native_listing_booking_flow.dart:168` reads other names; `listings_api.dart:1556` does no adaptation | Selected times can become zero at checkout; fix and contract-test before rollout |
| Existing authority | `worker/src/cal/engine.ts:39` uses atomic conditional inserts | Reuse this foundation; do not assume there is no conflict protection |
| Commercial checkout | `worker/src/routes/commercial_checkout.ts:454` accepts caller timestamps; `:706` claims both calendars | Existing overlap protection is valuable, but needs canonical slot membership, duration and unified policy validation |
| Publishing | `worker/src/routes/listings.ts:2611` claims a live-event block | Consult listing publication does not itself reserve exclusive time; recurring/fixed slots need explicit reservation semantics |
| Policies | `worker/src/cal/engine.ts:70` counts daily caps in UTC; commercial claims omit the calendar buffer | Align preview and commit policy, count days in creator timezone, and enforce buffers everywhere |
| Privacy | `worker/src/cal/engine.ts:166` exposes occupancy title; `calendar.ts:68` accepts another creator | Public/customer availability must redact private event titles and other booking identities |
| Native calendar | `app/lib/features/calendar/avacalendar_screen.dart` already has month/agenda, Google settings, rules and vacation | Extend existing native functionality; provide a proper wide-screen layout and listing management |
| Google | `worker/src/cal/gcal.ts` supports OAuth, primary-calendar import/export and a webhook receiver | Integration exists, but production readiness and delivery guarantees need work |
| Google correctness | Import skips newly transparent events without clearing old busy blocks, interprets all-day dates as UTC, and drops syncToken on subsequent pagination pages | Stale or wrong occupancy is possible; repair import/reconciliation before relying on it |

## Product rules

1. **Available**: the creator permits bookings in this window. Listing rules may narrow it. Default: closed until configured.
2. **Reserved for this listing**: exclusive creator time allocated to a named listing before a customer books. Other listings cannot use it. The owning listing can consume its own reservation atomically.
3. **Booked**: a confirmed customer appointment; blocks all competing creator commitments.
4. **Unavailable**: personal time, holiday, livestream, external busy event, buffer or other policy restriction. A listing override can never reopen a hard block.
5. **Temporarily held**: short checkout reservation with server expiry. Distinct from wallet escrow; visible as unavailable to others.

Three fixed appointments proposed for 10:00–11:00: reserve the first; reject the others with the conflicting title/date/time and alternatives. Three services with shared Monday 09:00–17:00 hours: allow all three to offer those hours; booking one service at 10:00 closes that interval on the other two. Creator can choose exclusive windows when needed.

Fixed livestream occurrences reserve time on publication, including preparation/wrap-up buffers. Draft previews do not reserve time. Reserve every published recurrence in the supported horizon; never advertise occurrences beyond what the engine has validated. Recurrence extensions undergo the same checks and surface failures.

## Creator experience

Rename the page **Calendar & availability**. Offer Calendar, Working hours, and Connected calendars tabs. Calendar has a listing filter, timezone selector, Today, month/week/agenda switch, Block time, and Open availability actions.

Desktop: compact navigation, useful full-width week grid, and a right-side selected-day editor. Month view shows counts and status badges; week view shows exact overlaps and buffers. Phone: agenda-first, expandable month, date strip, and a full-height editor sheet. iPad: calendar and day details side by side when space permits; narrow split-screen uses the phone arrangement.

Selecting a day or time range opens: available / unavailable / reserved for listing; listing selector or all listings; start/end; repeat; optional private note; and preview of affected times. Bulk select dates for holidays. Never silently cancel or move existing bookings when changing hours—show affected appointments and route through explicit rescheduling/cancellation.

Creator-only conflict example: **“This overlaps with Live Q&A on 18 September, 4:00–5:00 PM IST. With your 15-minute buffer, the next available start is 5:15 PM.”** Actions: Choose 5:15 PM, Find another time, View conflict. Never offer a force-book option for 1:1 conflicts.

Listing Time step becomes: session duration; use default working hours / custom listing hours / specific exclusive dates; timezone; notice, horizon and buffers; live availability preview. Hide Seats for 1:1 and enforce capacity one on the server. Display how changes affect other listings. Check while editing and again when saving/publishing.

## Customer booking experience

Use one listing-aware picker contract on the listing page, checkout and Flutter. A month summary marks days with bookable times; unavailable days cannot be selected for purchase. Selecting a day shows actual server-generated time slots, duration, explicit timezone and next-available shortcut. Unavailable times may remain visible but disabled, labelled Unavailable or Booked without private reasons. Loading, error, empty and stale states must be distinct.

Default to the customer's timezone with an obvious selector; retain creator timezone in the confirmation summary where helpful. Changing timezone must preserve the instant and regroup dates correctly. The creator edits weekly rules in their own IANA timezone. Proposed change from the current listing-zone-only display should be explicit in UI review.

Refresh on date selection and before holding a slot. If another customer wins, show “That time was just booked” and return alternatives without losing other form details. Browsing availability should not require login; identity is required to hold/confirm, with rate limits and privacy-safe responses. An expired hold cannot confirm. Offline Flutter may show cached agenda with a stale label, but must never confirm cached availability.

## Technical design

Reuse `calendar_blocks`, bookings, the commercial idempotency/recovery infrastructure and per-account identity. Extend the existing authority before considering a new storage service. Scheduling volume and atomicity should drive any later move to a creator Durable Object; do not create two writable scheduling authorities.

Add listing schedule associations, weekly windows, date overrides, exclusive reservations, versioned policies and expiring holds. Exact migrations should follow a schema audit. Keep UTC instants for occurrences and IANA timezone + local wall time for recurring rules. Keep a separate slot-start interval from session duration (e.g. 60-minute sessions starting every 15 minutes).

Effective availability = creator working windows intersect listing windows, then apply date exceptions, horizon and notice, then subtract global blocks, other listing reservations, active holds and buffers. Booking the owning listing converts its reservation instead of conflicting with itself. Date-specific opening may override weekly closure but never an existing commitment.

Proposed API contracts:
- `GET /api/listings/:id/availability?from=&to=&timezone=`: bounded month summary, slot identifiers, UTC times, status, schedule version and freshness.
- `POST /api/calendar/conflicts/preview`: authenticated, read-only creator preview, including alternatives and private owner-visible reasons.
- Versioned creator schedule/exception writes: optimistic concurrency plus authoritative conflict checks.
- Hold/confirm/release operations: stable idempotency keys; server-issued slot identity; server-derived duration, creator, price and policy. Do not trust arbitrary client timestamps.

Guarantees: atomic conflict-and-capacity admission, including daily limits; transactionally consistent schedule mutations; idempotent retry after crashes; bounded hold expiry; durable compensation when wallet/booking steps fail; durable outbox for calendar and notifications. A plain read-then-write reschedule is insufficient. Reserve the new interval before releasing the original and complete both participants through a recoverable operation.

Retain the existing single-statement overlap claim where valid, but prove the complete workflow under concurrency. Protect creator and buyer claims from stranded partial operations. Use half-open intervals [start,end), explicit before/after buffers, and exclude only the operation's own reservation when appropriate. Late payment completion must reacquire availability or recover payment safely; never revive an expired hold blindly.

## Google integration and reminders

Connect from web and native app through account-scoped OAuth. Allow selection of calendars that block availability and one destination for AvaTOK events. Request only necessary Calendar permissions; avoid making Drive consent part of calendar setup. Confirm actual OAuth verification and configured scopes before production launch.

Export confirmed appointments with join links and lifecycle updates; support invitations to attendees without requiring them to connect Google. Make connected-user export and invitation modes explicit to avoid duplicate events. Google reminders are per authenticated user's calendar copy; a creator's reminder setting does not set the customer's reminders. Keep AvaTOK confirmation/cancellation and configurable push/email reminders as fallback. Provide .ics for other calendar users. See [Google reminders](https://developers.google.com/workspace/calendar/api/concepts/reminders).

Import external events as busy intervals; retain overlap evidence even if an external event is created over an existing AvaTOK appointment. Flag that collision for resolution rather than deleting or silently moving the booking. Google and AvaTOK cannot form one atomic transaction, so external conflicts created after confirmation cannot be completely prevented.

Implement registered watch channels with renewal, validated webhook identifiers/tokens, incremental sync with consistent parameters on every page, deletion/transparent-event reconciliation, all-day timezone handling and full reconciliation on invalid sync token. Keep polling as recovery. Show last successful sync and reconnect/error states. See [Google incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync) and [push channels](https://developers.google.com/workspace/calendar/api/guides/push).

Before accepting a Google-protected booking, refresh/check busy information within a defined freshness policy. If Google is unavailable and imported data is too stale, temporarily refuse new protected bookings with a clear message. Do not turn a sync error into “available.” Fresh checking reduces the race window but cannot eliminate simultaneous external edits.

A Google delete/move of an AvaTOK-managed event must not cancel a paid appointment. Direct the creator to AvaTOK reschedule/cancel, then export the accepted result. Keep sync provenance and loop prevention. Use durable retries and deterministic event mapping; never report connected as equivalent to fully synced.

## Responsive and accessible design requirements

- Use the existing visual identity with quieter grid borders, readable body type and compact controls; reserve display typography for headings.
- Provisional breakpoints by available content width: under 600 single column; 600–1023 calendar plus optional details; 1024+ week grid plus inspector. Validate content fit, not device names. Flutter uses LayoutBuilder; web uses matching responsive CSS behavior.
- Keep forms bounded in width. Support iPad landscape, portrait and split view without orientation locks.
- Target 44–48 logical pixel touch controls; keyboard-accessible day and time selection; screen-reader labels including status, date and timezone; visible focus; text/icon status in addition to colour.
- Avoid drag-only actions: every drag/block selection has a tap-and-form equivalent. Preserve selection across layout changes and handle increased text size without clipping.
- Native views remain actual Flutter screens, not embedded web pages. Account-scoped cache keys include visible range and schedule version; clear state and prevent late responses from a previous account overwriting the new account.

## Delivery sequence

1. **Authority and contract repair:** fix native timestamp mismatch, unify policy validation, add listing slot membership, redact public conflicts, and map every booking/publish/edit/reschedule/cancel path. Validate in CI before UI rollout.
2. **Schema and migration:** add schedule/exception/reservation/hold/version support; inventory existing listings, slots, blocks and bookings. Backfill idempotently with provenance and a collision report. Keep confirmed bookings; flag ambiguous fixed-date consults for creator review rather than guessing exclusive intent.
3. **Creator web and native UI:** calendar, day editor, weekly rules, date exceptions and listing Time step with conflict preview. Review phone/iPad/desktop examples using identical fixture data.
4. **Customer picker and checkout:** one API contract across web/native, availability states, hold countdown, alternative slots and reliable rescheduling. Retire competing legacy write routes or make them use the same authority.
5. **Google and reminders:** repair existing sync, calendar selection, lifecycle outbox, channel renewal, retries, freshness gate and delivery preferences. Verify with separate creator/customer test accounts.
6. **Controlled rollout:** CI tests and explicit staging validation first; read-only comparison with existing availability, reconcile differences, then production approval for writes/migrations. Rollout flags must not permit an old checkout route to bypass new enforcement. Roll back the UI while preserving booking authority if necessary. Builds and deployments require the owner's explicit request.

## Acceptance gates

| Scenario | Required result |
|---|---|
| Three exclusive listings overlap | Only first reservation accepted; others receive conflict + alternatives |
| Three services share weekly hours | One confirmed booking blocks the overlapping interval on all three |
| Two buyers submit simultaneously | Exactly one wins; loser incurs no retained charge |
| Same checkout request retried | Same booking/payment outcome; no duplicate claim or Google event |
| Livestream vs consult, either creation order | Second incompatible commitment refused, including buffers |
| Unoffered date/time or altered duration posted directly | Server rejects before payment |
| Hold expires, late payment or abandoned checkout | No stale reservation; defined payment recovery; no double booking |
| Reschedule races another booking | No overlap, no loss of original appointment on refusal |
| Daily cap reached concurrently | Limit enforced atomically in creator's local day |
| Listing hours edited after slot display | Stale selection revalidated and refused or refreshed |
| Vacation or listing exception | Properly disabled dates/times; confirmed bookings preserved |
| DST gap/fold and midnight crossing | Explicit ambiguity handling; same UTC instant everywhere |
| Google busy becomes free/deleted | Busy interval removed after sync; no stale block |
| Google all-day/recurring/paginated events | Correct timezone, recurrence exceptions and complete sync |
| Google outage/revoked access | Clear degraded state; no unsafe availability inference |
| Private Google appointment | Customer sees Unavailable, never title/guest information |
| Phone/iPad/split view, larger text and keyboard | No clipping or blocked actions; native/web parity |
| Account switch and out-of-order slot response | No cross-account data or stale day selection |
| Reminder retries/cancellation/reschedule | Deduplicated sends; obsolete reminders suppressed |

No realistic system can promise zero errors. Release requires passing these gates and observing recovery behavior, not simply a calendar that looks correct. CI should include concurrent request tests, fault injection between claims/payment/booking commits, contract tests for all slot clients, DST fixtures, and accessible responsive end-to-end flows. No local builds/analyzers were run during this audit.

## Telemetry contract for implementation

Add availability_loaded/failed, schedule_saved/rejected, conflict_prevented, hold_created/expired, booking_confirmed/rejected, reschedule_completed, gcal_sync_completed/failed, and reminder_attempt/delivered/failed. Include request/operation IDs, listing/booking ID, platform, environment, release, timezone, schedule version, source of conflict, latency and sync age. Attribute authenticated events to the account with the existing verified email identity; phone only if already available under the established identity policy. Do not log OAuth tokens, private event titles, guest lists or arbitrary calendar descriptions.

Metrics: confirmed creator overlaps (target zero), slot rejection rate/reasons, slot-read latency, orphan holds, payment recovery backlog, Google sync freshness and reminder delivery outcome. Mark synthetic test events explicitly so they do not contaminate user behavior. The blocked PostHog account-specific review remains a pre-implementation audit item.

## Proposed defaults to review with the UI

Retain the current calendar defaults initially: 10-minute buffer, 2-hour notice, maximum 8 appointments per creator day, then reconcile commercial policy differences before activation. Propose a 60-day booking horizon and 5-minute checkout hold. Make duration listing-specific and allow custom buffers. Default custom listings to shared available hours; make exclusive reservation an explicit option. Fixed-time advertised commitments and livestream occurrences always reserve the creator.

The next deliverable is a reviewed web/phone/iPad design prototype and a schema/API contract, followed by implementation in the sequence above. This document is the completed planning deliverable, not authorization to release.
