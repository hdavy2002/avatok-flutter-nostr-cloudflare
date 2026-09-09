# Session screens and device checks audit — 2026-09-09

Scope: production journey audit; no application changes, builds or live session starts in this audit. Reviewed local revision f73d8844 (Android release 10639); website runtime was released from 035205bd. Later revision added tests.

## Verdict

The main screen destinations exist and their role-specific navigation is wired in source. This is not a complete end-to-end acceptance pass. Device checks are incomplete: permission granted does not prove audible microphone input or working speaker output.

| Scenario | Source-traced destination | Device preparation |
|---|---|---|
| App creator live event | My Live Events → Live readiness → Backstage → Start live → broadcast → End event | Permission and connection checks; real video preview backstage. No microphone level meter or speaker test. |
| App customer live event | My Tickets & Appointments → LiveViewerScreen | Receive-only viewing; camera/microphone checks are unnecessary. |
| App creator appointment | Customer Appointments → Consultation setup → room → completion | Permissions, connection probe, camera/mic starting toggles. No pre-join camera preview, microphone meter or speaker test. |
| App customer appointment | My Tickets & Appointments → Consultation setup → room → completion | Same incomplete preparation screen; exact booking ID is passed. |
| Web creator live event | My Live Events → /live/:listing/host → preview/backstage → live/end | Actual local camera preview, camera/mic selection and toggles. No microphone meter or speaker test. |
| Web customer live event | My Tickets & Appointments → /live/:listing | Separate receive-only viewer island. |
| Web creator appointment | Customer Appointments → /session/:booking | Actual camera preview, device selection and toggles before joining. No microphone meter or speaker test. |
| Web customer appointment | My Tickets & Appointments → /session/:booking | Same browser preparation screen, server-authorized booking admission. |

## Source evidence

- App destinations: `app/lib/shell/v2/shell_destinations.dart:99` and legacy shell; creator schedule actions: `app/lib/features/booking/creator_schedule_screen.dart:291`.
- Customer actions and creator-role handling: `app/lib/features/booking/commercial_customer_screens.dart:500`.
- Live readiness/backstage/broadcast/viewer: `app/lib/features/commercial_getstream/commercial_live_screens.dart`.
- Actual consultation wrapper: `app/lib/features/commercial_getstream/commercial_getstream_screens.dart:103` delegates to `commercial_consult_screens.dart`, not the generic entry screen.
- Consultation setup and room: `app/lib/features/commercial_getstream/commercial_consult_screens.dart:40`; local and remote video renderers exist after joining at line 250.
- Web role-specific links: `web/src/islands/dashboard/TicketCard.tsx:44`; live host/viewer page files under `web/src/pages/live/`; appointment page `web/src/pages/session/[booking].astro` uses ConsultRoomGS.
- Web device preparation: `web/src/islands/live-gs/LiveGsHost.tsx` and `web/src/islands/consult-gs/PreJoin.tsx` (the commercial lane, distinct from legacy consult/PreJoin).

## Gaps and corrections

1. Add a private camera preview to app appointment preparation for both creator and customer.
2. Add microphone input level indication and a user-triggered speaker test to creator live and both appointment preparation surfaces, app and web. Viewer audio playback should be tested separately.
3. Fix the app consultation readiness guard: `_network?.verdict != 'red'` permits an unknown result, and `_checking` does not disable Join. With both devices switched off, Join can become available before a successful connection check. This is a source finding, not a reproduced device incident; server admission still applies.
4. App live backstage currently has a preview and Start live, but no visible camera/microphone adjustment controls in that screen. Bring preparation controls into this screen.
5. Correct the creator instructions: create the appointment service through **Create listing**, then set working times through **Availability**. Availability navigates to CalendarSettingsScreen; it is not the service listing creator.
6. Avoid exposing provider/settlement wording to customers: current app appointment screens contain GetStream and signed evidence terminology.

## What was actually verified

- Read-only source inspection and role/ID destination tracing for the eight combinations above. This does not prove that every runtime state renders correctly.
- Production browser rendered My Tickets & Appointments and Customer Appointments headings and the intended sidebar links. Customer tickets then redirected to sign-in with its return path preserved. No signed-in purchase list or media room was exercised in this audit.
- ADB returned no connected devices. The phone's installed release and on-device navigation could not be verified today.
- Canonical app link parsing supports /live/:listing and /session/:booking plus legacy /j/:token. Role selection and session resolution are present. Cold-start, post-login continuation and wrong-account behavior require runtime acceptance tests.
- Earlier implementation evidence covers confirmation/reminder email and calendar generation, but this audit did not place a purchase, inspect a delivered email, or open its actual calendar attachment. Delivery/bounce callbacks remain a previously recorded operational gap.

## Acceptance still required before saying every scenario works

Use a creator and a separate customer account. Exercise app→app, app→browser, browser→app and browser→browser for live events and appointments. Confirm purchase visibility, delivered email/calendar link, correct account, early arrival/waiting, permission denied recovery, device choices, audible sound, visible video, creator start/end, reconnection and ended/cancelled/refunded access. Include app closed/open link handling. Never count a signed-out landing page or passing source-level tests as a live two-person media pass.

No full-green claim is justified until the preparation gaps are addressed and these runtime checks pass.
