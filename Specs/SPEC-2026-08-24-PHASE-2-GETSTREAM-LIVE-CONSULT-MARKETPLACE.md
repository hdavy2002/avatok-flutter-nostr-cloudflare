# Phase 2 Implementation Specification: Commercial Live Streaming and 1:1 Consultations

**Status:** Implementation-ready specification; no production activation authorized  
**Date:** 2026-08-24  
**Environment audited:** Production, read-only  
**Products in scope:** paid/free-ticket live streaming and commercial paid 1:1 consultations  
**Media provider:** GetStream Video only  
**Out of scope:** Messenger calls, Cloudflare media fallback, group consultations, Messenger audio allowance, general Marketplace buy/sell/social redesign

## 1. Product decision

Phase 2 creates a commercial calling lane that is independent of Messenger.

- Live events are created by creators, displayed as Marketplace cards, purchased or reserved by customers, and broadcast with GetStream's livestream call type.
- 1:1 consultations are created as creator services, displayed as Marketplace cards, booked into an available time, paid into escrow, and conducted with a dedicated GetStream call.
- Creators receive the configured creator share after attendance and refund rules pass. The platform retains its configured fee.
- GetStream signed server webhooks are the authority for actual media attendance and session lifecycle.
- Cloudflare remains the application/API platform where already used, but Cloudflare must not carry, signal, publish, relay, or play Phase 2 media.
- Phase 2 does not call, depend on, or fall back to the Messenger calling lane.

## 2. What the audit found

### 2.1 Reusable implementation

The following foundations already exist and should be retained:

- `live_event` and `consult` listing kinds.
- Listing detail, creator profiles, reviews, favorites, promotions and reporting.
- Consultation availability and slot selection.
- Checkout, wallet balance, top-up, escrow holds and orders.
- Creator/platform fee separation, refund rules and idempotent settlement.
- AvaLive discovery, host preview, viewer screen, chat, moderation, reactions and donations.
- Consultation prejoin, countdown, in-call controls, extension, completion and review.
- AvaCalendar availability and booking blocks.

### 2.2 Gaps blocking launch

1. Marketplace browsing filters out `live_event` and `consult`.
2. Marketplace listing creation offers only Selling, Buying and Social.
3. Live and consultation experiences are separate UI islands instead of complete Marketplace journeys.
4. The current live media path is Cloudflare Stream Live using WHIP/WHEP.
5. The current consultation path is P2P signaling or Cloudflare Realtime SFU.
6. There is no separate GetStream commercial session authority.
7. Current attendance can be influenced by app WebSocket presence; that is not sufficient for financial settlement.
8. Customers lack a prominent, unified **My bookings** surface for upcoming, live, completed and cancelled commercial sessions.
9. Creators lack one complete **Creator Studio** surface for services, schedules, sessions and earnings.
10. Existing generic listing management actions such as “Mark sold” and “Renew” are inappropriate for services.
11. Purchase confirmation does not clearly explain escrow, creator cancellation, no-show and refund rules before payment.
12. Live hosting lacks a complete scheduled-event readiness checklist and backstage state.
13. Consultation UI lacks a strong booking summary, paid-session identity and post-call receipt journey.
14. Production flags are off and production contains no Phase 2 listings, bookings or sessions.

## 3. Experience principles

1. **Marketplace first.** Customers discover both products on Marketplace without needing to know AvaLive or AvaConsult names.
2. **Service-specific journeys.** Live and consultation cards share the design system but never pretend to be ordinary products for sale.
3. **Price before commitment.** Every paid action shows the total, wallet balance, refund summary and creator/platform commercial relationship before confirmation.
4. **One booking, one session.** A consultation booking maps to exactly one GetStream call. A live listing maps to one scheduled GetStream livestream session.
5. **Server authority.** Clients display state; they do not decide entitlement, attendance, refunds or settlement.
6. **Fail closed.** If GetStream creation, authorization or financial recording is unavailable, do not silently open an unmetered session.
7. **Accessible recovery.** Every loading state has an understandable label; every error offers Retry or a safe exit; reconnecting never creates a second charge.

## 4. Navigation and UI placement

### 4.0 Creator-led links and paid admission

Phase 2 assumes early traffic is creator-led. A creator receives one stable, shareable AvaTOK event URL after publishing, for example:

- `https://avatok.example/live/<publicSlug>`

The URL is a discovery link, not a bearer ticket. It may be posted on social media, sent through WhatsApp, email or Messenger, and forwarded safely. Opening it displays the public event landing page with creator, schedule, description, price and Buy/Join state.

Admission is tied to the signed-in AvaTOK account:

1. Visitor opens the public link in a browser or app.
2. AvaTOK resolves the public slug to the listing without exposing a provider call ID or credential.
3. Visitor signs in or creates an account.
4. Server checks that exact account for a valid free reservation or paid order.
5. If not entitled, show **Buy ticket** or **Reserve free**.
6. If entitled but early, show the waiting room/countdown.
7. When joining is allowed, the server adds/validates the account as a GetStream call member and issues a short-lived user token.
8. GetStream admits only that authenticated member under the viewer role.

Forwarding the URL never transfers the purchase. The recipient must sign in and buy or reserve under their own account. Do not put a reusable admission secret, GetStream token, order ID or provider call ID in an email or share URL.

Email, push and in-app notifications all use the same stable public URL. A logged-in purchaser sees **Ticket confirmed**; a different account sees **Buy ticket**. Optional email magic-link authentication may make sign-in easier, but it must authenticate the account and then perform the same server entitlement check—it must not itself be the ticket.

**Browser requirement:** add a responsive AvaTOK web event landing page and GetStream web viewer. On a supported browser, the customer can purchase and watch without installing the app. If the web viewer is not ready at first launch, the same universal link opens the installed app or presents **Open/Install AvaTOK**; this is a temporary launch limitation and must be stated before purchase.

**New creator UI:** after publishing, show `ShareLiveEventSheet` with Copy link, Share, WhatsApp and Email actions, plus ticket sales and start time. The sheet says **Anyone can view this event page. Only customers with a ticket can enter the stream.**

**New landing-page states:**

- Signed out: event information + **Sign in to buy or join**.
- Signed in, not entitled: **Buy ticket** / **Reserve free**.
- Paid/reserved, early: **Ticket confirmed** + countdown + Add to calendar.
- Paid/reserved, join window open: **Join live**.
- Live but not entitled: **Buy ticket & watch now**, if late sales are allowed.
- Ended: replay CTA if purchased and replay is included; otherwise Event ended.
- Cancelled/refunded: cancellation and refund status instead of Join.

The creator can see ticket purchasers and aggregate attendance, subject to privacy policy. The creator never receives customer payment credentials or reusable admission tokens.

### 4.1 Marketplace root

**Existing screen:** `MarketplaceHub` / the current Marketplace destination  
**Change:** replace the three-tile intermediary as the primary customer surface with a service-aware Marketplace home. Existing buy/sell/social access remains available as a tab or section but is not redesigned in this phase.

Place the following components from top to bottom:

1. Existing Marketplace header.
2. Search field with placeholder **Search creators, live events or consultations**.
3. Horizontal filter chips: **All**, **Live now**, **Upcoming live**, **1:1 consultations**, **Categories**.
4. **Live now** horizontal rail using `LiveEventCard`; hide the rail when empty.
5. **Upcoming live events** horizontal rail using `LiveEventCard` with **See all**.
6. **Book a 1:1 consultation** vertical or two-column grid using `ConsultationCard` with **See all**.
7. **Marketplace listings** link/tab for the existing buy/sell/social browse experience.
8. Floating creator action button labelled **Create**. It opens `CreateServiceChoiceSheet`.

Add a persistent top-right calendar/ticket icon opening `MySessionsScreen` for customer bookings.

### 4.2 Create action

**New component:** `CreateServiceChoiceSheet`

Display three clear choices:

- **Host a live event** — schedule a broadcast and sell tickets.
- **Offer 1:1 consultations** — set a price and let customers book available time.
- **Create marketplace listing** — opens the existing Sell/Buy/Social composer.

Creators should never need to create a live listing in one place and then discover that “Go Live” lives elsewhere.

### 4.3 Creator Studio

**New screen:** `CreatorStudioScreen`  
**Entry points:** Marketplace profile/action area, Marketplace Create sheet, My Listings, AvaLive **Go Live**, wallet earnings screen.

Tabs:

- **Services:** drafts and published live/consultation offerings.
- **Schedule:** upcoming sessions, start readiness and calendar conflicts.
- **Earnings:** pending escrow, available earnings, refunds and platform fees.

Service rows use service-specific actions:

- Live draft: Edit, Preview, Publish, Delete.
- Upcoming live: View sales, Test setup, Start backstage, Cancel event.
- Live now: Return to stream, End event.
- Completed live: View summary, View earnings, Duplicate event.
- Consultation offering: Edit service, Availability, Pause/Resume, Preview.
- Consultation booking: View customer, Join session, Reschedule/Cancel according to policy.

Remove **Mark sold** and **Renew** from creator-service rows. Keep those only for ordinary Marketplace items.

### 4.4 Customer My Sessions

**New screen:** `MySessionsScreen`  
**Entry points:** Marketplace header, successful checkout, notification deep links, AvaCalendar booking cards.

Tabs:

- **Upcoming**
- **Live now**
- **Completed**
- **Cancelled/refunded**

Each card shows cover/avatar, creator, type, scheduled local time, duration, amount, state and the single relevant action:

- View event
- Join live
- Join consultation
- Add to calendar
- View receipt
- Review creator
- Refund details

The Join button is disabled before the server join window and displays **Opens in …**. It never relies only on the device clock.

## 5. UI component specification

### 5.1 `LiveEventCard`

Placement: Marketplace Live now rail, Upcoming rail, AvaLive discovery, creator channel and search results.

Required content:

- 16:9 cover image.
- Red **LIVE** badge or scheduled date badge.
- Creator avatar, display name and verification badge where applicable.
- Event title, category and language.
- Ticket price or **Free reservation**.
- Scheduled local time and duration.
- Live viewer count only when supplied by trusted session state.
- CTA: **Watch now**, **Reserve free**, **Buy ticket**, or **View booking**.

Never show “joined” as though it were current viewer count. Distinguish tickets sold, attendees connected and viewers watching.

### 5.2 `ConsultationCard`

Placement: Marketplace consultation grid, search results and creator channel.

Required content:

- Creator avatar/cover.
- Service title and expertise category.
- Creator rating and completed-session count.
- Duration and exact price: for example **₹1,500 · 30 min**.
- Next available local time: **Next: Today, 6:30 PM**.
- Spoken language and translation availability.
- CTA: **View & book**.

Do not display group capacity or “Group session” in Phase 2.

### 5.3 Service listing detail

Retain `ListingDetailScreen`, but add service-specific sections and sticky actions.

For live events, place:

1. Hero and live/scheduled badge.
2. Event title and creator.
3. Local date, duration, language and ticket price.
4. **What you will experience** description.
5. Ticket/refund summary.
6. Creator profile and reviews.
7. Sticky bottom CTA: **Watch now**, **Buy ticket**, **Reserved**, or **Event ended**.

For consultations, place:

1. Hero and **1:1 consultation** badge.
2. Service title and creator credentials.
3. Price and duration.
4. **What we can cover** description.
5. **How it works** three-step strip: Choose time → Pay securely → Meet privately.
6. Next available slots preview.
7. Cancellation/no-show summary.
8. Creator profile and consultation reviews.
9. Sticky bottom CTA: **Choose a time**.

### 5.4 Checkout sheet

Split the current generic `CheckoutSheet` internally into `LiveCheckoutSheet` and `ConsultCheckoutSheet`, sharing wallet primitives.

Both must display:

- Product title and creator.
- Base price, promotion, translation add-on and final total.
- Wallet balance and top-up recovery.
- **Held safely until the session rules are completed** escrow explanation.
- Compact refund/no-show policy with **View full policy**.
- Consent checkbox: **I understand the session, price and cancellation terms**.
- Idempotent Confirm button with progress state.

Live checkout additionally shows event time and whether replay is included.

Consultation checkout additionally shows selected slot, duration, timezone, camera/microphone requirement and a **Change time** action.

On success, replace an immediate pop with `BookingSuccessScreen` containing:

- Confirmation animation/state.
- Event/session summary.
- **Add to calendar**.
- **View my sessions**.
- **Message creator** where allowed.
- Receipt reference.

### 5.5 Live creator setup and backstage

Replace the current direct prepare/go-live path with two UI states.

**`LiveReadinessScreen`** before backstage:

- Event title, scheduled time, tickets sold and expected viewers.
- Camera picker and preview.
- Microphone picker and level meter.
- Network readiness status.
- Orientation indicator.
- Chat/moderation settings.
- Recording/replay disclosure and toggle only if policy allows it.
- Checklist with blocking errors.
- CTA **Enter backstage**.

**`LiveBackstageScreen`** after GetStream join but before broadcast:

- Full camera preview.
- **You are not live yet** banner.
- Viewer waiting count if available.
- Mic, camera and flip controls.
- Moderator list.
- CTA **Go live now** with confirmation dialog.

The existing host HUD becomes `LiveBroadcastScreen` and retains chat, moderation, health, viewer count, earnings estimate and End Stream. Replace raw bitrate-only health with human states: **Excellent**, **Good**, **Weak**, **Reconnecting**; technical detail can appear in a diagnostic sheet.

After end, `LiveSummaryScreen` shows:

- Broadcast duration.
- Peak and unique viewers.
- Ticket gross and donations.
- Refunds under review.
- Platform fee.
- Estimated creator payout and settlement status.
- Replay state if supported.
- Actions: View earnings, View event, Duplicate event, Done.

### 5.6 Live viewer

Retain full-screen video, chat, pinned message, reactions, donations and creator link.

Add:

- Pre-stream waiting room with event countdown and **Notify me when live**.
- Clear **Ticket confirmed** state.
- Captions button when available.
- Quality selector limited to provider/server-supported options: Auto, Data saver, Standard, High.
- Report/block entry in the overflow menu.
- Reconnect banner that explains the ticket will not be charged twice.
- Ended state with review, receipt and replay CTA where eligible.

The viewer UI must not expose Messenger SD/HD/2K/4K paid-quality pricing. That belongs to Phase 1 Messenger video, not commercial live tickets.

### 5.7 Consultation creation

**New screen:** `CreateConsultationServiceFlow`

Steps:

1. Basics — title, category, expertise, description and cover.
2. Session — duration, price, spoken language and translation option.
3. Availability — link to or embed AvaCalendar weekly availability; show timezone.
4. Policies — cancellation window, booking notice and preparation instructions within server policy bounds.
5. Preview — render the real `ConsultationCard` and listing detail.
6. Publish — identity/KYC readiness, remote fee quote and final confirmation.

Phase 2 hard-locks capacity to one customer. Do not show a capacity selector.

### 5.8 Live event creation

**New screen:** `CreateLiveEventFlow`

Steps:

1. Basics — title, category, description, cover and trailer/preview media.
2. Schedule — start date/time, timezone and planned duration.
3. Ticket — free or paid ticket, capacity if the product chooses a cap, promotions.
4. Experience — spoken language, translation option, chat, recording/replay disclosure and adults-only setting.
5. Policies — cancellation/refund summary.
6. Preview — render the actual `LiveEventCard` and listing detail.
7. Publish — identity/KYC readiness, fee quote, conflicts and final confirmation.

After publish, route to Creator Studio Schedule with **Test setup** and **Start backstage** actions.

### 5.9 Consultation prejoin and call

Enhance the existing prejoin screen with:

- Creator/customer identity and service title.
- Scheduled local time and paid duration.
- Camera preview, mic toggle and mic level.
- Speaker test.
- Network status in simple language.
- Private-session notice.
- Join-window countdown.
- **Join consultation** CTA authorized by the server.

Replace the current P2P/Cloudflare room with `GetStreamConsultationRoomScreen`.

In-call placement:

- Top: service title, connected status and remaining paid time.
- Centre: remote video; local picture-in-picture.
- Bottom: mic, camera, flip, speaker, send file and leave.
- Overflow: report technical problem, view booking details and message thread.
- Five-minute warning as an accessible banner plus optional vibration.
- Extension is a paid order modification. Show price, wallet balance and the other participant's consent before extending; do not silently add 15 minutes.

After leaving, show `ConsultationCompletionScreen`:

- Connected duration.
- Booking amount and settlement state.
- Rate/review action.
- Receipt.
- Message creator/customer.
- Book again.
- Report a problem within the permitted window.

## 6. GetStream commercial architecture

### 6.1 Separation from Messenger

Create a new server module, suggested name `commercial_stream_sessions.ts`. Do not extend Messenger placement endpoints with listing/order logic.

Suggested GetStream call types:

- `avatok_livestream` for scheduled live events.
- `avatok_consult_1to1` for paid consultations.

Suggested deterministic CIDs:

- Live: `avatok_livestream:live_<listingId>_<sessionVersion>`
- Consultation: `avatok_consult_1to1:consult_<bookingId>`

Store call type and call ID separately. Never accept a client-provided CID as authority.

### 6.2 Commercial authorization endpoints

Suggested contracts:

- `POST /api/commercial/live/:listingId/prepare-host`
- `POST /api/commercial/live/:listingId/go-live`
- `GET /api/commercial/live/:listingId/join`
- `POST /api/commercial/live/:listingId/end`
- `GET /api/commercial/live/:listingId/state`
- `GET /api/commercial/consult/:bookingId/prejoin`
- `POST /api/commercial/consult/:bookingId/join`
- `POST /api/commercial/consult/:bookingId/extend/quote`
- `POST /api/commercial/consult/:bookingId/extend/confirm`
- `POST /api/commercial/consult/:bookingId/end`
- `GET /api/commercial/session/:sessionId/receipt`

Each join response includes only the short-lived user token, API key, call type, call ID, role, join window and presentation metadata needed by the client.

### 6.3 Authorization checks

Live host:

- Authenticated creator owns the listing.
- Listing is published and within backstage/start window.
- Creator is commercially eligible.
- No other active session version exists.

Live viewer:

- Listing is live or in permitted waiting window.
- Free reservation or paid order exists and is valid.
- User is not banned from this event/creator.

Consultation:

- User is exactly the booked creator or buyer.
- Booking and escrow order are valid.
- Current server time is inside the configured join window.
- Session has not been cancelled, refunded, completed or superseded.
- The GetStream member list is exactly those two account IDs.

### 6.4 Commercial session records

Add provider-neutral records with at least:

- `commercial_session_id`
- `kind` (`live_event`, `consult_1to1`)
- `listing_id`, `booking_id`, `order_id`
- `creator_id`, buyer/viewer entitlement references
- `provider`, `provider_call_type`, `provider_call_id`
- scheduled/backstage/live/ended timestamps
- state and state version
- settlement state
- recording/replay state
- created/updated timestamps

Add provider event inbox and participant intervals:

- Raw signed webhook ID and type.
- Received/provider timestamp.
- Deduplication status.
- Actor/member ID.
- Join/leave intervals derived idempotently.
- Reconciliation status.

Never overwrite raw provider evidence during reconciliation.

### 6.5 Webhook truth and settlement

Extend the signed GetStream webhook receiver to route commercial call types to the commercial handler.

Required event handling includes call/session started, participant joined/left, broadcast started/stopped, call ended and recording events where enabled.

Rules:

- Verify signature before parsing business effects.
- Deduplicate by provider webhook/event ID.
- Process events idempotently and tolerate out-of-order delivery.
- Map provider user IDs to account IDs through server-owned membership.
- Build connected intervals from provider evidence.
- Run periodic reconciliation against the provider call state.
- Only enqueue financial settlement after a terminal/reconciled state.
- If evidence is incomplete, settlement becomes `review_pending`; it must not guess.

## 7. Commercial money rules

- Checkout holds the full buyer amount in escrow.
- Every order snapshots the creator share, platform fee, currency/token conversion, cancellation rules and policy version.
- Creator earnings display **estimated** until settlement is final.
- Ticket price is the live-event charge; live viewer quality does not produce additional Messenger-quality charges.
- Consultation price covers its booked duration. Extensions require a new quote, buyer consent and additional escrow hold.
- Donations remain separate transactions and show their own receipt.
- Free live reservations still create an entitlement record so capacity, bans, attendance and analytics work consistently.
- Creator payout is released only after configured hold/refund rules pass.
- Duplicate provider events, reconnects and multiple devices must never duplicate payment or entitlement.

The existing default appears to be 80% creator / 20% platform. Production activation requires the owner-approved split to be set remotely and snapshotted per order.

## 8. Remote configuration and kill switches

Add separate Phase 2 controls:

- `commercialLiveListingsEnabled`
- `commercialLiveCheckoutEnabled`
- `commercialLiveJoinEnabled`
- `commercialConsultListingsEnabled`
- `commercialConsultCheckoutEnabled`
- `commercialConsultJoinEnabled`
- `commercialCreatorFeePct`
- `commercialSettlementHoldHours`
- `commercialConsultJoinEarlyMin`
- `commercialConsultJoinLateMin`
- `commercialLiveBackstageEarlyMin`
- `commercialLiveStartGraceMin`
- `commercialReplayEnabled`
- `commercialRecordingEnabled`

All default false for new production activation flags. `streamCallsEnabled`, Messenger allowances and Messenger quality pricing must have no effect here.

## 9. Sub-phased implementation plan

### Phase 2A — Product contracts and safety foundation

**Outcome:** a separate commercial lane exists in schema and server contracts without changing visible production behavior.

- Add commercial session, provider event and participant interval records.
- Add remote flags and policy snapshot fields.
- Create commercial authorization service and GetStream call-type adapter.
- Route signed webhooks by lane and call type.
- Add idempotency, reconciliation and audit logging.
- Write contract tests proving Messenger and commercial rules cannot cross.

**Exit:** server can create and reconcile dark test calls; no customer UI enabled.

**Local implementation progress (2026-08-24, not deployed):**

- Complete: independent default-off commercial flags and Flutter mirrors.
- Complete: commercial policy snapshots, account-bound entitlements, sessions,
  server-owned membership, provider evidence, participant intervals, control
  operations, settlement handoff jobs and receipt records.
- Complete: deterministic GetStream-only call identity; no client CID/provider.
- Complete: authenticated live join, consultation prejoin/join, host backstage,
  go-live/end, consultation end, safe state and receipt endpoints.
- Complete: signed GetStream webhook routing before Messenger billing, immutable
  payload-hash replay checks, unknown-member review, terminal-state protection
  and exactly-once settlement-job creation.
- Complete: bounded settlement runner with per-order jobs for multi-viewer live
  events, durable escrow verification, WalletDO idempotency, snapshotted payout
  holds, immutable receipt replay checks and creator-scoped receipt lists.
- Complete: bounded authenticated provider-state reconciliation. Recovered
  terminal state without signed attendance evidence remains review-pending and
  never releases escrow automatically.
- Complete: automatic payout requires an explicit snapshotted
  `auto_release_on_provider_end` policy plus signed host delivery for live or
  signed two-party overlap for consultations; otherwise support review is
  mandatory.
- Remaining in 2A: Stream call-type/dashboard verification and dark staging
  test calls after migration approval.

### Phase 2B — Marketplace discovery and service creation UI

**Outcome:** creators can create both services and customers can find them as cards.

- Build the Marketplace service rails and filters.
- Build `LiveEventCard` and `ConsultationCard` shared components.
- Add `CreateServiceChoiceSheet`.
- Build `CreateLiveEventFlow` and `CreateConsultationServiceFlow`.
- Add service-specific listing detail layouts.
- Refactor My Listings into Creator Studio service actions.
- Add loading skeletons, empty states, errors and analytics.

**Exit:** full draft/publish/discover/detail journey works with provider joining still disabled.

**Local implementation progress (2026-08-24, not deployed):**

- Complete: reusable `LiveEventCard` and `ConsultationCard` discovery
  components with real listing price, schedule, duration, creator, rating and
  explicit live/ticket/booking actions.
- Complete: a default-off Marketplace **Book a creator** shelf with independent
  Live & upcoming and 1:1 consultation filters, de-duplicated live results,
  loading, failure, retry and empty states, plus detail-page navigation and
  commercial-card analytics.
- Complete: the commercial shelf is absent unless the corresponding remote
  listing flag is enabled; production Marketplace behavior is unchanged.
- Complete: Marketplace **Offer a service** entry and
  `CreateServiceChoiceSheet`, with plain-language GetStream, ticket and
  account-bound access explanations.
- Complete: the existing upload/KYC/price/schedule/preview/publish wizard accepts
  a locked commercial kind; live events remain one-to-many and Phase 2
  consultations are forced to private 1:1 instead of exposing group capacity.
- Complete: service creation collects live ticket-refund deadlines and
  consultation cancellation/reschedule/no-show choices in the existing bounded
  listing attributes, ready for server validation and immutable checkout
  snapshotting in 2C.
- Complete: commercial listing details now show service-specific GetStream
  three-step explanations, account-bound access, refund/cancellation summaries,
  and explicit server-policy-at-checkout language.
- Complete: Phase 2 sticky actions render Buy ticket, Reserve free, Watch now,
  Ticket reserved, Choose a time or Consultation booked as appropriate, but are
  deliberately disabled in 2B and cannot reach the legacy checkout/viewer path.
- Complete: `ShareLiveEventSheet` appears after commercial live publishing and
  remains available from Creator Studio. Copy, system share, WhatsApp and Email
  receive only `https://avatok.ai/l/<listing_id>` plus event copy; provider,
  entitlement and order identifiers never enter the link.
- Complete: the service-aware My Listings surface becomes **Creator Studio**,
  routes New service through the locked service chooser, shows ticket counts
  without estimating earnings, opens consultation availability in AvaCalendar,
  and exposes preview/share/sales/setup/backstage/pause actions.
- Complete: commercial camera testing, backstage and pause controls are
  explanatory/dark only; they cannot call legacy status transitions or provider
  controls before the Phase 2C authorization UI exists.
- Complete: Marketplace search submits the same user query to separately scoped
  ordinary-listing, live-event and consultation reads, preserves live-first
  ordering and de-duplication, and provides service-specific no-result states.
- Complete: Creator Studio has remote-flag-aware All, Live events and 1:1
  consultations filters with filtered empty states and unchanged pull refresh.
- Complete: Creator Studio opens a dedicated commercial policy editor. It
  preserves unrelated attributes, edits only future-checkout policy, and makes
  clear that existing orders retain their accepted immutable snapshot.
- Complete: live refund and consultation cancellation/rescheduling/minimum
  notice/preparation fields are server allowlisted and bounded before both
  create and update storage. Client-supplied unknown `commercial_*` fields and
  weakened no-show authority are rejected.
- Remaining in 2B: dedicated earnings/receipt summaries and runtime UI tests.

### Phase 2C — Booking, checkout and customer session UI

**Outcome:** customers can pay, receive a reliable entitlement and find the booking again.

- Split live and consultation checkout presentations.
- Add policy consent and escrow explanation.
- Add `BookingSuccessScreen`.
- Build `MySessionsScreen` and deep links.
- Connect AvaCalendar booking cards and notifications.
- Add receipt and refund-status surfaces.

**Exit:** paid/free orders are idempotent and visible to creator and customer; media remains dark.

### Phase 2D — GetStream 1:1 consultations

**Outcome:** one booked creator and customer can conduct a private paid session entirely through GetStream.

- Replace P2P/Cloudflare media and signaling with GetStream SDK integration.
- Upgrade prejoin UI.
- Build the GetStream consultation room and completion UI.
- Add paid, mutually confirmed extensions.
- Drive attendance and settlement from signed webhooks.
- Validate no-show, cancellation, reconnect and refund paths.

**Exit:** two physical accounts complete a paid test and produce an exactly-once receipt and creator/platform ledger split.

### Phase 2E — GetStream live streaming

**Outcome:** a creator can host and paid/free-entitled viewers can watch a GetStream livestream.

- Replace Cloudflare Stream Live creation, WHIP and WHEP.
- Build readiness, backstage, broadcast and summary states.
- Adapt existing chat, moderation, reactions and donations.
- Add waiting room, viewer quality, captions and replay UI where supported.
- Drive viewer attendance, downtime and refunds from provider evidence.
- Test creator no-show, provider interruption and stream termination.

**Exit:** physical creator and multiple viewer accounts complete live tests with correct entitlement, moderation, settlement and refunds.

### Phase 2F — Commercial hardening and staged activation

**Outcome:** observable, supportable launch with controlled exposure.

- Complete accessibility, localization and small-screen UI review.
- Add support diagnostics that exclude secrets and provider tokens.
- Create commercial telemetry dashboard and reconciliation alarms.
- Run failure injection for duplicate/out-of-order webhooks and provider timeouts.
- Verify creator identity/KYC, payout and policy disclosures.
- Activate listings before checkout, checkout before joining, and consultation before live streaming.
- Canary with allowlisted creators and customers before broad availability.

**Exit:** production launch checklist is signed off and rollback uses independent Phase 2 flags.

## 10. Telemetry

Capture server and client events with `lane=commercial`, `kind`, `session_id`, `listing_id` and `booking_id` where applicable. Never include provider tokens.

Minimum funnel:

- `commercial_card_impression`
- `commercial_listing_opened`
- `commercial_slot_selected`
- `commercial_checkout_started`
- `commercial_terms_consented`
- `commercial_order_held`
- `commercial_booking_confirmed`
- `commercial_prejoin_opened`
- `commercial_join_authorized/refused`
- `commercial_provider_connected`
- `commercial_participant_joined/left`
- `commercial_broadcast_started/ended`
- `commercial_reconnect_started/succeeded/failed`
- `commercial_session_reconciled`
- `commercial_settlement_pending/released/refunded/review_pending`
- `commercial_receipt_viewed`
- `commercial_review_submitted`

Dashboards must distinguish business conversion, provider reliability and money reconciliation.

## 11. Required tests

### UI

- Marketplace rails, filters, cards and empty states.
- Service composers preserve drafts and validate each step.
- Correct CTA for free, paid, owned, live, upcoming, ended and cancelled states.
- Checkout cannot confirm without terms consent.
- Successful checkout always offers My Sessions and receipt access.
- Join countdown uses server time.
- Reconnect retains the same session and entitlement.
- Screen-reader labels and minimum touch sizes for all in-call controls.

### Authorization and money

- Non-owner cannot host.
- Non-entitled viewer cannot join.
- Third party cannot join a consultation.
- Cancelled/refunded/completed orders cannot mint new join credentials.
- Provider call membership cannot be expanded by the client.
- Duplicate checkout and webhook delivery are idempotent.
- Reconnect does not duplicate attendance or charging.
- Creator/buyer no-show and provider outage execute the snapshotted policy.
- Creator net plus platform fee plus refunds equals held funds.

### Physical-device scenarios

- Creator Android device + buyer Android device consultation.
- Background/foreground, lock screen, network change and reconnect.
- Creator Android device + at least three viewer accounts live.
- Host late/no-show, viewer late, viewer reconnect, creator ends normally.
- Provider interruption and webhook delay.
- Insufficient balance, top-up return and retry.
- Notification and deep-link routing into the correct session.

## 12. Production activation sequence

1. Deploy schema and dark server contracts.
2. Configure GetStream commercial call types, permissions and signed webhook.
3. Enable service creation only for internal/allowlisted creators.
4. Populate internal live and consultation listings.
5. Enable Marketplace visibility for internal accounts.
6. Enable checkout for test wallets.
7. Enable consultation joining for two physical accounts.
8. Reconcile receipts, refunds and creator/platform ledgers.
9. Enable live joining for controlled multi-viewer tests.
10. Enable Marketplace listings broadly.
11. Enable commercial checkout broadly.
12. Enable consultation joining, observe, then enable live joining.

Every activation is independently reversible. Disabling join must preserve bookings, receipts, refunds and creator/customer support access.

## 13. Definition of done

Phase 2 is ready to go live only when:

- Customers can discover, understand, purchase and later find both products entirely from Marketplace.
- Creators can create, publish, prepare, deliver and review earnings from Creator Studio.
- Live streaming and consultations use GetStream media exclusively.
- Messenger billing, allowances and UI are not invoked.
- Signed provider evidence drives attendance and settlement.
- Every commercial payment has an escrow record, policy snapshot and final receipt.
- Exactly-once settlement is proven under retries and reconnection.
- Refund and no-show paths are understandable in the UI and verified end to end.
- Two-account consultation and multi-viewer live tests pass on physical devices.
- Telemetry and reconciliation alarms are active before broad production exposure.

## 14. Explicit non-goals

- No group consultations in this phase.
- No Cloudflare media fallback.
- No Messenger ring screen or Messenger call history entries for commercial sessions.
- No Messenger daily free allowance or paid quality rates.
- No additional per-quality charge for ticketed live-event viewers.
- No production flag change, deployment or build as part of this specification.

## 15. Implementation status — 2026-08-25

Implemented and integrated in the shared working tree:

- Marketplace live-event and 1:1 consultation cards, listing creation and service-policy UI.
- Account-bound checkout, explicit policy consent, wallet checks, escrow holds, idempotent retries and entitlements.
- Customer My Sessions tabs, booking success, server-time join windows, calendar actions, cancellations, refunds and receipts.
- Creator readiness/backstage/room/summary flows, earnings and receipt views.
- GetStream-only host, viewer, creator and buyer roles; no commercial Cloudflare media fallback.
- Paid consultation-extension quote, mutual consent, escrow, calendar recheck and extension-only attendance settlement.
- Signed provider lifecycle ingestion, immutable settlement authority, notifications, deep links, diagnostics and reconciliation telemetry.

Staging verification completed:

- The four commercial migrations were applied individually to staging.
- Staging Worker version `cf1ed06f-6a86-4a04-8987-b2a2964cc9d8` was deployed.
- The combined commercial Worker contract suite passed: 6 files, 41 tests.
- The staging Flutter app compiled and installed as `ai.avatok.avatok_call.staging`, build 10622, on both attached physical Android phones.
- Marketplace discovery flags are enabled in staging. Checkout, joining and paid extensions remain disabled.

Remaining go-live gates:

- Configure staging `STREAM_VIDEO_API_KEY` and `STREAM_VIDEO_API_SECRET`, plus the signed GetStream webhook.
- Set exact consultation-extension minutes/rate if the extension product is wanted at launch.
- Seed controlled creator listings and authenticate two separate physical test accounts.
- Enable checkout and join flags progressively in staging and complete the physical-device scenarios in section 11.
- Review receipts, refunds, creator/platform splits and PostHog/reconciliation signals before any production promotion.
- Keep partial refunds in manual review until a precise partial-refund policy is approved.
