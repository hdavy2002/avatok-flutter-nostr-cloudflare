# Creator session journey — implementation and test release

Target: production, explicitly requested by the owner on 9 September 2026. The owner also requested a local Android APK and installation on the attached phone. Nine Luna agents implemented the work; the coordinating agent reviewed and integrated it.

## Implemented

- The existing Marketplace sidebar contains customer tickets/appointments and creator live events, customer appointments, listing management and availability. Both app shell modes route to the same destinations.
- Account-scoped schedules include purchased live tickets, appointments and creator events before the first ticket sale. Cursor pagination, cancellation/refund states and server-authorized actions replace the old past-first appointment selection.
- Real checkout-generated booking IDs work through commercial admission. Canonical `/live/:listingId` and `/session/:bookingId` destinations connect email, notifications, browser pages and Android links. Legacy invitation resolution remains compatible without bypassing entitlement checks.
- Browser creators have camera preview/backstage, explicit go-live and end controls. Browser and app media sessions refresh credentials and release media on leave/account changes.
- Purchase confirmations use a durable outbox, verified recipient addresses, calendar attachments, bounded retries, lease recovery and authenticated rate-limited resend. Notifications preserve typed session destinations and live audiences paginate beyond 200 recipients. Reminder failures do not count as successful delivery.
- Support diagnostics expose delivery states and attempt references without publishing recipient addresses, email bodies or access tokens.

## Verification before deployment

- Executed customer and creator schedule SQL against SQLite fixtures, including 123+ rows over cursor pages, account ownership and terminal states. Both production query plans also validated read-only against production D1.
- Final commercial regression suite: 63 tests across 11 files passed. Consumer suite: 25 tests across five files passed, including 205-booking pagination with one failed recipient and durable retry/CAS behavior. Worker and consumer TypeScript checks passed.
- Website TypeScript check and complete production Astro build passed. Homepage, creator idea routes, assets and sharing metadata checks passed.
- Focused Flutter checks found no errors; the Android link parser tests passed. Local APK compilation required regenerating the existing database companion file in the isolated build checkout.

## Release coordination

The separate owner-authorized production release task committed the shared pending work as `03c6f4ba`. Subsequent reviewed fixes are committed separately. That task is the sole operator for the additive email-outbox migration, Worker/consumer deployment and production push; the push triggers the website workflow. This avoids two tasks racing production writes.

Captured rollback versions: API Worker `a38ee644-86f9-4a50-88bf-19e47c5ab001`; consumers `77161481-bb79-4f49-a4ef-28c9313e1781`. Production initially had no email_outbox table. Apply `worker/migrations/2026-09-09-commercial-email-delivery.sql` once after rechecking the live schema; its ALTER statements must not be rerun blindly after a partial application. No production order/entitlement data or feature-flag blob is copied or rewritten.

## Remaining acceptance evidence and limitations

This is a release for owner testing, not proof that every row in the plan's device/browser acceptance matrix has passed. Real two-party remote audio/video, actual purchaser inbox receipt, cold-launch identity recovery and phone installation still require device/session evidence. No real purchase or unsolicited customer email was generated merely to test implementation.

Brevo acceptance is recorded accurately as `provider_accepted`. Delivery/bounce callback configuration is not yet implemented, so the system does not claim inbox delivery. Database claims prevent concurrent sends, but a provider acceptance followed by a persistence crash still has a duplicate-mail risk; do not describe this as guaranteed exactly-once delivery.

Historical purchases can be retrieved and explicitly resent by their owner. No bulk historical email backfill was performed. Live/due-soon sidebar badges and additional standalone calendar/receipt shortcuts remain follow-up interface work; calendar attachments accompany confirmation emails. There is no iOS target in this repository, so iOS native universal-link/device acceptance was not performed. Recording, replay and session extensions remain outside this release.
