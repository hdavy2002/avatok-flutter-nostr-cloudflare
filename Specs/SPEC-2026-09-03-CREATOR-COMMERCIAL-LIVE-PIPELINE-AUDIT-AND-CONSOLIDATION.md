# Creator Commercial Live Pipeline: Audit, Consolidation, and Delivery Spec

**Status:** Review draft  
**Date:** 2026-09-03  
**Target environment:** Production architecture; implementation must be staged and verified before production promotion  
**Primary media provider:** GetStream Video  
**Audience:** AI reviewers, implementation agents, product owner, QA, and operations

> **Review resolution:** Sections 18–22 preserve the audit discussion. Section 23 is the final reconciliation of those reviews against the current repository instructions and code. Implementers must follow §23 when an older section conflicts with it.

## 1. Why this document exists

We need one complete commercial creator journey that works across the public website, the Android/Flutter phone app, the admin system, payments, email, wallets, and GetStream video.

Much of the required code is already present. The current problem is fragmentation:

- newer components are not always reachable from the main navigation;
- old Cloudflare live/consult routes still receive customers who should enter GetStream;
- creator publishing can bypass admin and poster approval;
- commercial notifications are mostly in-app instead of email;
- useful old live-room UI was never connected to the current GetStream rooms;
- duplicate screens and transports create ambiguity and maintenance risk.

This is therefore primarily a **consolidation and rewiring project**, followed by deletion of verified dead code. It is not a request to rebuild every feature.

## 2. Product outcome we are trying to achieve

### 2.1 Creator journey

1. A creator signs in and creates a listing on the website or phone.
2. The creator fills in the service details, date/time, duration, price, capacity, refund policy, media, and any required safety information.
3. The creator submits the listing for review. Submission does not publish it.
4. An admin reviews the listing and may approve it, reject it with a reason, or request changes.
5. After listing approval, the admin creates or regenerates the poster using AI.
6. The poster is approved or rejected separately.
7. Only after both approvals may the admin publish the listing.
8. The creator sees the listing as published and can share its public URL.
9. Before the event, the creator can see ticket sales, receipts, event status, and camera/microphone readiness.
10. On the event day, the creator enters backstage in the phone app, checks the device, and starts the GetStream broadcast.
11. During the show, the creator sees the video, audience count, chat, reactions, moderation tools, and remaining time.
12. When the event ends, earnings move through the settlement rules and become visible in the creator wallet/receipts.
13. The completed occurrence moves to expired/history. The creator can duplicate it into a new draft for another date.

### 2.2 Buyer journey

1. A buyer opens the creator's shared public listing URL.
2. Before the event, the page says it is upcoming and offers Book/Get ticket.
3. The buyer supplies an email and verifies it with an email OTP if not already signed in.
4. The buyer sees the exact event, date/time/time zone, duration, price, fees, refund policy, and whether the event has already started.
5. The buyer pays with wallet balance or one configured external payment provider.
6. The buyer receives an on-screen confirmation and an email containing a stable event link.
7. The buyer receives a reminder before the event.
8. When the event is live, the same stable public/event link shows Join now.
9. An entitled buyer joins the GetStream viewer room without being charged again.
10. The buyer can reconnect using the same entitlement after a network interruption.
11. The buyer can watch, chat, react, report abuse, and leave.
12. After the event, the buyer receives a review request and can leave one verified review.

### 2.3 Creator, buyer, and admin communications

After purchase:

- Buyer: confirmation, receipt, time, policy, and stable join link.
- Creator: buyer display name, event, scheduled time, gross sale, and current ticket count. Do not disclose private buyer data unnecessarily.
- Admin: order, creator, buyer/account reference, gross amount, fees, settlement state, and risk/reconciliation link.

Before the event:

- Buyer: reminder with stable join link.
- Creator: reminder to open backstage and test camera/microphone.

After the event:

- Buyer: outcome/refund receipt and review request.
- Creator: attendance and settlement summary.
- Admin: only exceptions, failed settlements, refund claims, or reconciliation problems should require attention.

## 3. Supported product types

This specification covers the shared commercial pipeline and the following room types:

- paid or free scheduled livestream;
- paid one-to-one GetStream video consultation;
- voice/AI one-to-one service where applicable.

The first production test should use a normal, non-explicit livestream. Existing policy prohibits commercial sexual services and explicit public/session content. The current `adults_only` field is only a label and is not an age-verification system.

## 4. Canonical architecture decisions

### 4.1 Media

- GetStream Video is the canonical provider for commercial livestreams and commercial one-to-one consultations.
- The server mints all GetStream user tokens and room identifiers.
- The client must never choose its own privileged role, call type, or call ID.
- Commercial entitlement and session state remain server-authoritative.
- Old Cloudflare WHEP/HLS and native-WebRTC commercial routes must not receive new commercial traffic.

### 4.2 Canonical website destinations

| Purpose | Canonical route | Legacy route that must not receive new commercial traffic |
|---|---|---|
| Public listing | `/l/<listing-id>` or the existing public listing canonical URL | N/A |
| Checkout | `/book/<listing-id>` | N/A |
| Paid livestream | `/live/<listing-id>` | `/watch/<listing-id>` |
| Paid 1:1 consultation | `/session/<booking-id>` | `/consult/<booking-id>` |

All listing CTAs, confirmation pages, payment returns, reminder emails, dashboard tickets, live-now cards, push deep links, and calendar links must use the canonical destinations.

Legacy routes should initially redirect safely. They may be deleted only after telemetry shows no required traffic and all internal link generation has been changed.

### 4.3 Listing state machine

The server must enforce this state machine:

```text
draft
  -> submitted
      -> changes_requested -> draft
      -> listing_rejected
      -> listing_approved
          -> poster_generating
          -> poster_rejected -> poster_generating
          -> poster_approved
              -> published
                  -> live
                      -> completed
                  -> cancelled
                  -> expired
```

Rules:

- Creator may save and edit `draft`.
- Creator may submit but may not approve or publish.
- Editing material fields after approval returns the listing to review.
- Admin approval and poster approval are separate recorded decisions.
- Only an admin/server transition may publish an approved listing.
- Every state change must have actor, timestamp, reason, prior state, and new state.
- AI poster generation must be asynchronous or bounded so a slow model does not exhaust a request.

### 4.4 Money

- A purchase creates one idempotent order and one account-bound entitlement.
- Reopening or reconnecting never charges again.
- Money is held until the event outcome is authoritative.
- Creator cancellation/no-show and provider failure can issue full refunds.
- Buyer no-show can receive no refund under the disclosed policy.
- A partial refund must be expressed as explicit ledger lines; it must not be approximated or silently left in `review_pending`.
- Client claims such as "my Wi-Fi failed" are not enough on their own. Use signed provider events, join/leave records, heartbeats, reconnect attempts, and admin review for ambiguous cases.

### 4.5 Reviews

- Only verified attendees may review after the event ends.
- One buyer may leave one review per listing occurrence.
- The listing rating and creator profile rating must both update.
- A repeated event should be a new occurrence/duplicate so historic attendance, money, and reviews are preserved.

## 5. Audit findings

### 5.1 What is already available

| Area | Website | Phone | Backend | Finding |
|---|---|---|---|---|
| Listing creation | Multi-step form exists | Form exists | CRUD exists | Reuse |
| Creator listing management | `CreatorListings` exists | Rich studio exists but main shell opens an older screen | Mine/status/duplicate APIs exist | Rewire |
| Admin listing review | Small panel exists | Not required for launch | Approve/reject/poster/publish actions exist | Extend and enforce |
| AI poster | Admin action exists | N/A | Image generation and cover storage exist | Reuse |
| Public listing | Exists | Exists | Public listing API exists | Fix CTA routing |
| Email OTP | Exists | Auth exists | OTP/auth support exists | Reuse |
| Commercial checkout | Exists | Exists | Wallet and gateway checkout exist | Reuse/configure |
| GetStream live | Viewer exists | Host and viewer exist | Join/control/webhook/settlement exist | Canonicalize |
| GetStream consult | Exists | Exists | Prejoin/join/session support exists | Canonicalize |
| Live chat/reactions | New web chat is incomplete | Rich old UI exists but is not connected to GetStream | Old event channel exists; commercial moderation incomplete | Port presentation, build safe transport |
| Reminders/email | Generic booking email machinery exists | Push/deep-link handling exists | Queue, Brevo, ICS, reminder templates exist | Rewire to commercial events |
| Refunds | Status/result UI partly exists | Details UI exists | Full/zero refund paths exist | Add partial split |
| Reviews | Exists | Exists | Verified review system exists | Add automatic invitation |
| Expired/duplicate | Partial | Duplicate and archive concepts exist | Duplicate/renewal support exists | Consolidate |

### 5.2 Production configuration findings

At audit time, production effective flags enabled the commercial live and consultation listing, checkout, and join lanes. GetStream API and webhook secrets were present.

The payment UI and adapters exist, but the enabled Paytm method did not appear to have its required production merchant credentials in the Worker secret inventory. Cashfree, Razorpay, and Stripe international were disabled. Therefore an external production payment should be treated as blocked until one provider is deliberately configured and tested.

No payment or deployment change was made during this audit.

### 5.3 Telemetry findings

For the designated test account during the inspected recent window, there was essentially no evidence of a completed listing-to-purchase-to-stream funnel. One live session open/close pair existed, while listing views, OTP, booking, Stream webhook, and wallet-loading signals were absent or zero in the inspected query.

This means the code inventory is stronger than the production evidence. The pipeline must be proven with a controlled end-to-end test rather than assumed complete from source code.

## 6. High-value reuse map

### 6.1 Phone creator studio

**Keep and make canonical:**

- `app/lib/features/listings/my_listings_screen.dart`

It already includes sharing, commercial policy, ticket receipts, camera/microphone testing, backstage, GetStream launch, consultation management, earnings, duplication, and cancellation.

**Currently opened by main shell but too limited:**

- `app/lib/features/marketplace/my_listings_screen.dart`

Rewire both `app/lib/shell/ava_shell.dart` and `app/lib/shell/v2/shell_destinations.dart` to the richer creator studio. Resolve all imports with explicit aliases during migration because both files declare `MyListingsScreen`.

### 6.2 Phone live experience

**Keep as canonical commercial flow:**

- `app/lib/features/commercial_getstream/commercial_live_screens.dart`
- `app/lib/features/commercial_getstream/commercial_getstream_handoff.dart`
- `app/lib/features/commercial_getstream/commercial_live_gateway.dart`

These already provide server-authorized GetStream entry, readiness, backstage, broadcast, viewing, reconnect behavior, and result/receipt screens.

**Reuse presentation widgets from the old AvaLive implementation:**

- `app/lib/features/avalive/live_room_widgets.dart`

Reusable pieces include chat overlays, flying messages, emoji bursts, stickers, donation banners, viewer count, countdown, and live controls. Move or adapt them into a transport-neutral shared live UI directory. Do not copy their old room-channel networking into the commercial GetStream implementation.

**Consolidate:**

- `app/lib/features/commercial_getstream/commercial_getstream_screens.dart`

This is a second generic commercial room UI. Preserve any shared media controls or test seams, then make it infrastructure rather than a competing user journey.

### 6.3 Website creator dashboard

**Keep:**

- `web/src/islands/dashboard/CreatorListings.tsx`

It is the fuller dashboard and is mounted by the listings, live, and consultation dashboard pages.

**Candidate for deletion after import verification:**

- `web/src/islands/dashboard/MyListingsPanel.tsx`

It is a simpler duplicate and had no observed page import during this audit.

### 6.4 Website checkout

**Keep and reuse:**

- `web/src/islands/listing/BookingBox.tsx`
- `web/src/islands/checkout/BookingFlow.tsx`
- `web/src/islands/checkout/CommercialPayStep.tsx`
- `web/src/islands/checkout/GatewayPicker.tsx`
- `web/src/islands/checkout/gatewaySheet.ts`
- `web/src/islands/checkout/PayReturn.tsx`
- `web/src/islands/checkout/Confirmation.tsx`

Required changes are provider readiness, route correction, stable join URLs, and end-to-end verification.

### 6.5 Website GetStream rooms

**Keep:**

- `web/src/pages/live/[id].astro`
- `web/src/islands/live-gs/LiveGsViewer.tsx`
- `web/src/islands/live-gs/LiveStage.tsx`
- `web/src/pages/session/[booking].astro`
- `web/src/islands/consult-gs/ConsultRoomGS.tsx`
- `web/src/islands/consult-gs/PreJoin.tsx`

The current web live chat uses temporary custom events and memory. Before broad release, add moderation, rate limits, reporting, reconnection behavior, and an authoritative event/history policy.

### 6.6 Email and reminders

**Reuse:**

- `worker/src/cal/emails.ts`
- `worker/src/cal/ics.ts`
- `consumers/src/calendar.ts`
- the existing `Q_EMAIL` consumer and Brevo delivery path

Create commercial-specific templates and trigger them from commercial checkout, lifecycle, and settlement outcomes. Do not reuse legacy `/j`, `/watch`, or `/consult` destination construction.

### 6.7 Admin and poster generation

**Keep and extend:**

- `worker/src/routes/admin_listings.ts`
- `web/src/islands/admin/ListingsPanel.tsx`

The backend already has the central actions. The UI needs rejection/reasons, revision details, KYC/policy context, poster feedback, publish/unpublish, and an audit timeline. The creator-side publish endpoint must be restricted server-side.

### 6.8 Reviews, receipts, and lifecycle

**Keep:**

- `worker/src/routes/reviews.ts`
- `worker/src/routes/commercial_checkout.ts`
- `worker/src/routes/commercial_stream_sessions.ts`
- `worker/src/routes/commercial_lifecycle.ts`
- `worker/src/routes/commercial_admin_claims.ts`
- phone commercial customer/session and creator receipt screens

Extend the lifecycle and receipt schema for partial refunds instead of creating a separate refund subsystem.

## 7. Known wrong links that must be corrected

At audit time, new commercial traffic could still reach old routes from these locations:

- `web/src/components/ListingDetailView.astro`: live CTA uses `/watch/<id>`.
- `web/src/islands/checkout/Confirmation.tsx`: live uses `/watch`; consult uses `/consult`.
- `web/src/islands/checkout/PayReturn.tsx`: live uses `/watch`.
- `web/src/islands/dashboard/TicketCard.tsx`: live uses `/watch`; consult uses `/consult`.
- `web/src/islands/marketplace/LiveNowRail.tsx`: live cards use `/watch`.
- `web/src/islands/consult/ConsultRoom.tsx`: fallback redirects live events to `/watch`.

The implementation agent must perform a repository-wide route search, not only edit this list.

## 8. Missing UI by surface

### 8.1 Website

Missing or incomplete:

- explicit `submitted`, `changes requested`, listing-approved, poster-pending, and poster-rejected states for creators;
- full admin review and feedback controls;
- a canonical GetStream creator web studio if browser hosting is required;
- reliable moderated live chat and reactions;
- event-already-started/full-price disclosure;
- clear external-payment unavailable state;
- commercial confirmation/reminder/refund/review emails;
- creator attendee/order detail view;
- expired-event history and duplicate-next-session action;
- partial-refund admin decision UI;
- stable link behavior across upcoming, live, completed, cancelled, and expired states.

### 8.2 Phone

Missing or disconnected:

- main navigation to the richer creator studio;
- chat/reactions/stickers in the current GetStream live room;
- accurate viewer count and join/leave feed;
- host moderation controls connected to the commercial channel;
- buyer report/block/mute behavior in the current room;
- late-join price disclosure;
- clearer admin-review status on creator listings;
- consistent expired/history/duplicate presentation.

### 8.3 Admin

Missing or incomplete:

- full listing and poster review UI;
- reasoned reject/request-changes workflow;
- state-transition audit trail;
- commercial order details and escrow breakdown;
- settlement exception queue;
- partial-refund claims and evidence;
- event operational status: scheduled, backstage, live, host late, completed, failed;
- emergency unpublish/end-event controls with audited reasons.

## 9. Email events to implement

| Trigger | Buyer | Creator | Admin |
|---|---|---|---|
| Listing submitted | N/A | Submission receipt | Review queue notice/digest |
| Listing rejected/changes requested | N/A | Reason and edit link | Audit only |
| Listing published | Optional | Public URL and share action | Audit only |
| Payment confirmed | Booking confirmation and receipt | Sale notification | Escrow/order record or digest |
| Event reminder | Stable join URL | Backstage URL | None |
| Creator late beyond grace | Waiting/status update | Urgent start warning | Operational alert |
| Event cancelled/refunded | Refund amount and destination | Outcome | Exception only |
| Event completed | Receipt/outcome | Attendance and settlement summary | Exceptions only |
| Review window opens | Review deep link | None | None |
| Settlement available | None | Wallet/receipt notice | Reconciliation only |

Emails must be idempotent. A retry must not send multiple confirmations or reminders for the same event/tier/recipient.

## 10. Live-event behavior and acceptance rules

### 10.1 Before start

- Public URL displays poster, creator, local time/time zone, duration, price, remaining capacity, and policy.
- Entitled users see booked status.
- Non-entitled users see booking/payment.
- Host can enter backstage within the configured early-entry window.
- Viewers cannot consume media before the server-authorized join window.

### 10.2 While live

- Public URL displays Join now.
- An unentitled visitor may authenticate and purchase if sales remain open.
- If the event has begun, checkout clearly states that the full fee still applies and shows time elapsed/time remaining.
- Entitled users join without a second charge.
- Reconnection uses the same entitlement and call.
- Creator sees chat, reactions, audience count, and moderation actions.
- Buyer can report abuse and leave.

### 10.3 Host no-show

- A server-owned grace timer determines no-show; the client clock is not authoritative.
- If the creator is not live by the deadline, the event is cancelled once.
- All eligible orders receive full refunds once.
- Emails, in-app notifications, ledger entries, and receipts agree.

### 10.4 Buyer network failure

- Reconnection is attempted first.
- The buyer is never charged twice.
- If policy allows a partial refund, the ledger records creator-earned amount, platform fee, refunded amount, and destination separately.
- Ambiguous evidence produces an admin claim, not an automatic promise.

### 10.5 Completion

- GetStream/provider attendance events are reconciled.
- Settlement is held for the configured period.
- Creator wallet changes only after authoritative settlement.
- Buyer no-show remains non-refundable when that was the disclosed policy.
- Review eligibility opens only after completion.

## 11. Safe deletion and deprecation plan

Deletion is part of this project, but must follow consolidation. Do not delete by filename resemblance alone.

### 11.1 Required deletion gate

For every candidate:

1. Search all code, tests, generated routes, deep links, emails, notifications, and documentation for references.
2. Replace internal links with the canonical path.
3. Add a redirect or compatibility adapter when external bookmarks may exist.
4. Add telemetry to the compatibility path.
5. Verify the canonical flow on website and phone.
6. Observe that the legacy path has no required traffic for an agreed period.
7. Delete code, tests, configuration, bindings, and documentation together.
8. Run repository graph update and CI verification.

### 11.2 Immediate deletion candidates after static verification

- `web/src/islands/dashboard/MyListingsPanel.tsx`, because the fuller `CreatorListings.tsx` is mounted by the dashboard pages and no import was observed for the older panel.
- Duplicate phone creator-listing implementation at `app/lib/features/marketplace/my_listings_screen.dart`, but only after all shell imports and behavior are migrated to the richer `features/listings` studio.
- Redundant presentation portions of `commercial_getstream_screens.dart`, after shared media primitives and tests are retained or moved.

### 11.3 Deprecate first; delete later

These may have external URLs or non-commercial uses and must not be removed immediately:

- `web/src/pages/watch/[id].astro`
- `web/src/islands/live/*`
- `web/src/pages/consult/[booking].astro`
- `web/src/islands/consult/*`
- `app/lib/features/avalive/live_host_screen.dart`
- `app/lib/features/avalive/live_viewer_screen.dart`

First determine whether free/non-commercial AvaLive or legacy consultations still depend on them. If not, redirect old web URLs, migrate useful UI, measure traffic, then delete.

### 11.4 Never delete these useful old pieces before porting them

- `app/lib/features/avalive/live_room_widgets.dart`
- web live chat/viewer-count presentation that is not tightly coupled to the old transport
- generic email/ICS/queue infrastructure
- existing checkout and payment gateway UI
- commercial ledger, lifecycle, claims, receipt, and review code

## 12. Implementation sequence

### Phase A: Canonical paths and navigation

- Make `/live` and `/session` the generated commercial destinations everywhere.
- Add safe redirects from old routes where appropriate.
- Point phone shell navigation to the richer creator studio.
- Add telemetry for canonical and legacy route entry.

**Exit condition:** a creator and buyer cannot accidentally enter the old media lane from any current UI, email, notification, payment return, or calendar link.

### Phase B: Approval pipeline

- Add submitted/review/poster states and immutable audit records.
- Prevent creator-side direct publishing on the server.
- Extend admin UI for complete review and feedback.
- Make poster generation retryable and observable.

**Exit condition:** no listing can become publicly published without recorded listing and poster approval.

### Phase C: Payment and communication

- Configure exactly one payment provider for the first test.
- Verify wallet and external payment idempotency.
- Wire commercial email templates and stable links.
- Add creator/admin sale messages and reminder events.

**Exit condition:** one paid test order produces matching order, entitlement, receipt, notifications, and emails without duplicates.

### Phase D: Live-room polish

- Port transport-neutral UI from old AvaLive widgets.
- Implement moderated chat/reactions and accurate presence.
- Add late-entry disclosure and reconnect UX.
- Verify host controls and server-authoritative event state.

**Exit condition:** host and multiple buyers can join at staggered times, chat/react, disconnect/reconnect, and end cleanly.

### Phase E: Financial outcomes and reviews

- Implement partial-refund ledger lines and admin evidence review.
- Verify host no-show automatic full refund.
- Wire completion settlement and wallet presentation.
- Send review invitations and verify profile/listing aggregation.
- Consolidate expired/duplicate behavior.

**Exit condition:** all tested outcomes produce mathematically consistent ledger, wallet, receipt, email, and review state.

### Phase F: Dead-code removal

- Apply the deletion gate.
- Remove verified duplicate/unreachable components.
- Remove obsolete flags, bindings, tests, and documentation with their code.
- Preserve redirects while external traffic remains.

**Exit condition:** one creator studio, one commercial live UI per platform, one commercial consult UI per platform, one checkout orchestration, and one authoritative lifecycle remain.

## 13. End-to-end test matrix

At minimum, automate or manually record these scenarios:

1. Listing rejected with reason, edited, resubmitted, poster approved, and published.
2. Buyer books with email OTP and wallet.
3. Buyer books with the configured external gateway.
4. Payment callback is delivered twice; only one entitlement and charge exist.
5. Host enters backstage early and starts on time.
6. Buyer opens the same shared URL before and after the event becomes live.
7. Multiple buyers purchase after the start and see the full-price warning.
8. Buyer disconnects and reconnects without a second charge.
9. Host never starts; full refunds occur exactly once.
10. Buyer no-shows; no refund occurs under the disclosed policy.
11. Buyer connection claim enters the correct automatic or admin-reviewed outcome.
12. Creator ends the event; settlement and wallets agree.
13. Verified attendee reviews; listing and creator ratings update.
14. Non-attendee cannot review.
15. Completed event appears in history and duplicates into a new draft with no old date/session/order leakage.
16. Legacy `/watch` and `/consult` links redirect to the correct commercial destination when applicable.

Test evidence should capture order ID, listing ID, commercial session ID, entitlement ID, GetStream call ID, webhook event IDs, ledger transaction IDs, email idempotency keys, and final wallet balances.

## 14. Observability requirements

Capture a correlated funnel without storing secrets or raw OTPs:

```text
listing_created
listing_submitted
listing_reviewed
poster_generation_started/completed/failed
poster_reviewed
listing_published
listing_view
checkout_started
email_otp_requested/verified
payment_started/completed/failed
entitlement_created
confirmation_email_queued/sent/failed
live_backstage_opened
live_started
live_join_started/succeeded/failed
live_reconnected
live_chat_sent/moderated
live_ended
refund_started/completed/review_pending
settlement_completed
review_invitation_sent
review_created
```

Use stable correlation identifiers rather than email as an event property where possible. The designated test user's email may be attached to their identified profile for operational lookup, consistent with existing project telemetry instructions.

## 15. Security, privacy, and abuse requirements

- Never put GetStream secrets, payment secrets, room tokens, OTPs, or signed join tokens into logs or analytics.
- All commercial joins are account-bound and server-authorized.
- Admin mutations require authorization and durable audit records.
- Chat/reactions require rate limiting, blocking, reporting, and moderator action logs.
- Email links should point to a stable authenticated page rather than carry long-lived room credentials.
- Refund and settlement operations must be idempotent.
- Creator and buyer local state on phone must use per-account scoped storage.
- Public poster/media must follow the existing public upload, transform, and cache pipeline.

## 16. Instructions for the reviewing AI

Before proposing implementation:

1. Validate every file and route named in this spec against the current branch.
2. Produce a disagreement list for any finding that is no longer true.
3. Search for hidden imports, dynamic routes, generated links, tests, feature flags, and external compatibility requirements.
4. Confirm which legacy live features are still used by free/non-commercial products.
5. Confirm the exact production payment provider prerequisites without changing secrets or flags.
6. Review database migrations and determine the smallest schema additions for approval history and partial refunds.
7. Convert the phases into small issues with one concern per commit.
8. Do not delete legacy code in the same commit that first redirects traffic away from it.
9. Do not deploy, build, change production flags, or write production data without explicit owner authorization.

The review should optimize for the shortest safe path to a two-account paid livestream test while leaving one coherent architecture behind.

## 17. Definition of done

This pipeline is done when:

- creator submission cannot bypass admin and poster approval;
- public, checkout, email, notification, and payment-return links all lead to GetStream commercial rooms;
- the phone's main creator navigation opens the full creator studio;
- at least one external payment provider works end to end;
- buyer, creator, and necessary admin emails are delivered idempotently;
- creator and buyers can join, arrive late, chat/react, disconnect/reconnect, and complete an event;
- host no-show, buyer no-show, provider failure, and partial-refund cases produce correct ledger and wallet results;
- verified review invitations and rating aggregation work;
- completed events preserve history and duplicate safely;
- verified dead duplicate/legacy code is removed after compatibility gates;
- CI, telemetry, reconciliation, and a documented production smoke test show the complete funnel working.


---

# 18. Second-reviewer audit (Claude, 2026-09-03)

**Method.** Every file, route, flag and behaviour named in §§4–11 was re-checked against the working tree at commit `3d572e09` (`[ADMIN-RESET-1]`, 2026-09-03) plus a cache-busted read of the live `/api/config`. Read-only: nothing was deployed, flipped, built or written to production. Line numbers below are from that commit; re-verify before editing.

## 18.1 Disagreement list (spec claims that are no longer true, or never were)

| # | Spec says | What the tree says | Consequence |
|---|---|---|---|
| D1 | §6.7 / §5.1: keep and extend `web/src/islands/admin/ListingsPanel.tsx` | **Deleted today** by `3d572e09 [ADMIN-RESET-1] Remove legacy admin web console` (23 files, −1,314 lines, incl. `AdminGate.tsx`, `ListingsPanel.tsx`, every `web/src/pages/admin/*`). `web/src/islands/admin/` and `web/src/pages/admin/` are now empty directories. | There is **no admin UI anywhere** for the approval pipeline. §6.7 "extend" becomes "build". The sibling `Specs/MARKETPLACE-FLOWPIPE-SPEC-2026-09-03.md` §5 already plans `/admin/listings` behind `AdminGate` — that gate no longer exists either. Decide which spec owns the admin surface before anyone starts. |
| D2 | §4.3: server "must enforce" a state machine with `submitted`, `changes_requested`, `poster_generating`, `poster_rejected`, `poster_approved` as listing states | `listings.status` is an **unconstrained TEXT** with comment-only enum `draft\|published\|live\|completed\|cancelled` (`worker/migrations/listings.sql:42`; confirmed "unconstrained" at `2026-07-18-listing-compose-sessions.sql:186`). Admin writes `approved`/`rejected` (`admin_listings.ts:63,65`). Poster state is a **sub-field** `attrs.poster.status ∈ generating\|draft\|approved\|rejected\|failed` (`admin_listings.ts:32-58`), not a listing state. `pending_review` is listed and accepted (`admin_listings.ts:13,62`) but **nothing ever writes it**. | The two same-day specs define **different** state vocabularies. The Flowpipe spec (`draft → pending_review → approved → published → unpublished`, poster as a separate status) matches the code; this one does not. Adopt the Flowpipe shape and map §4.3's names onto it (see 18.3-S1). |
| D3 | §5.1 "Admin listing review: approve/reject/poster/publish actions exist — extend and enforce"; §6.7 "creator-side publish endpoint must be restricted" | True that the actions exist, but the admin path is **optional and parallel**: `publishListing` (`listings.ts:1280`) needs only owner + `status='draft'` (`:1285-1286`) → `status='published'` (`:1442`); `setListingStatus` (`:1471`) lets the owner set `live\|completed\|cancelled\|draft` (`:1476,1492`). Admin `approved` is **invisible to every public query** (`l.status IN ('published','live')` at `listings.ts:715,1733,1813,1837,1859,2134,2345,2368`) so approving without publishing hides the listing, and the creator can publish without approving. Phone calls it at `core/listings_api.dart:846` (from `create_listing_flow.dart:311` and `features/listings/my_listings_screen.dart:64`); web at `ListingWizard.tsx:410`. | The bypass is not a UI gap; it is the **only** working publish path. Phase B must gate `publishListing` server-side first, then repoint both clients' "Publish" buttons to "Submit for review". Old app builds will keep calling `/publish` — return a typed 409 (`approval_required`) that the current client already renders as a snackbar, don't 404. |
| D4 | §5.1 "Refunds: full/zero refund paths exist"; §10.3 "server-owned grace timer determines no-show" | **No grace timer exists.** `commercialLiveStartGraceMin` (default 15) is used once, as a display value `closesAt` (`commercial_stream_sessions.ts:234`). No-show is judged only in the **settlement cron after the session ENDS** (`commercial_settlement.ts:377-443`). A session whose host never opens backstage stays `state='scheduled'` forever: the only sweeps are `reconciliation_pending` (`commercial_stream_sessions.ts:1686-1810`) and settlement jobs, which are created at session end (`:1588-1596`). Reschedule/cancel touch only `scheduled\|backstage` rows (`commercial_lifecycle.ts:442,497`). | **Money bug, not a polish item.** Buyer holds (`commercial:hold:<orderId>`, `commercial_checkout.ts:480-500`) for a host who never shows are never released or refunded unless someone cancels by hand. Test-matrix item 9 will fail today. See 18.3-S3. |
| D5 | §4.4 / §6.8 "extend lifecycle schema for partial refunds" | Already known to the code: `outcomeForPct` maps **every** non-0/100 pct to `review_pending` with reason `<action>_partial_refund_unsupported` (`commercial_lifecycle.ts:141-149`) because receipts can only express refunded=gross (`:136-139`). | Agree with the spec; adding that `commercialLateCancelRefundPct` defaults to `0` (`config.ts:1793`) so a partial policy is not live in prod anyway. Partial refunds can be Phase E without blocking the first test. |
| D6 | §4.5 "one buyer may leave one review per listing **occurrence**" | Reviews are unique per `(listing_id, author_id)` (`migrations/listings.sql:61`) and **upserted** (`reviews.ts:125`) — a repeat attendee silently overwrites their earlier review. Eligibility for paid kinds is "holds any `commercial_entitlements` row" (`reviews.ts:96-111`); `verified_attendee=1` only if a `consumed` row exists. | If §4.5's "repeat = duplicate into a new listing" stands, occurrence == listing id and no schema change is needed. But eligibility must require `state='consumed'`, not any row, or a refunded buyer can review. No review invitation exists anywhere (grep `review_invite\|leave a review\|rate your` = 0 hits). |
| D7 | §6.6 "reuse `cal/emails.ts`, `ics.ts`, `consumers/calendar.ts`" | These are the **legacy booking lane** (callers: `routes/calendar.ts:157,226`, `routes/booking.ts:184`, `listings.ts:2519`, `money_engine.ts:125,154`). The only URL they build is `https://avatok.ai/j/<token>` (`ics.ts:39`, `consumers/calendar.ts:183`) and **`/j/` has no web page** (`web/src/pages` has no `j/`) — only the phone handles it (`core/deep_links.dart:62-77`). The commercial lane is push/in-app only (`lib/commercial_notifications.ts:5-13`, eight types). `queueEmail` (`emails.ts:29-35`) carries no dedupe key; Brevo consumer (`consumers/src/index.ts:349-358`) has none either. | Reuse the queue and Brevo transport, **not** the templates or link builder. §9's idempotency requirement needs a `commercial_email_sends(idempotency_key UNIQUE)` table or a stable `notifications`-style id (`consumers/notify.ts:17` pattern) before the first email goes out. |
| D8 | §11.2 "`features/marketplace/my_listings_screen.dart` — only shell imports need migrating" | Three importers, not two: `shell/ava_shell.dart:41→400`, `shell/v2/shell_destinations.dart:13→93` **and `features/marketplace/marketplace_hub.dart:12→83`**. The rich `features/listings` one is reached today only via `verse_screen.dart:235,272` and `explore_home.dart:133,268`. Both files declare `class MyListingsScreen` at `:24`. | Add `marketplace_hub.dart` to the rewire list. |
| D9 | §11.3 "first determine whether free AvaLive still depends on `live_host_screen` / `live_viewer_screen`" | Determined: they are the **default branch** of `commercialLiveListingsEnabled` (`avalive_discovery.dart:113-115`, `:56-67`), reachable from `ava_shell.dart:427-428`, and `LiveViewerScreen` is also constructed at `explore/listing_detail.dart:273,292` and `consult/prejoin_screen.dart:90`. The flag is `true` in prod today (live read, 2026-09-03), so real users are on the GetStream branch — but a KV reset or a stale override flips **everyone** back to the WHEP/HLS lane silently. There is no `avaLiveEnabled` flag. | Treat these as "gated legacy", not "in use". Phase A should invert the guard (legacy only when an explicit `legacyAvaLiveEnabled` is true, default false) so the default path is GetStream even with KV silent. |
| D10 | §4.2 canonical `/session/<booking-id>` | The phone's universal-link handler accepts **query form** `https://avatok.ai/session?listing_id=…&booking_id=…` (`core/deep_links.dart:185-201`), while the web page is **path form** `/session/[booking]`. No `/live`, `/watch` or `/consult` handling exists in deep links at all. | Pick one shape. Recommend path form on web + add `/session/<id>` and `/live/<id>` to `deep_links.dart` so an email link opens the app when installed and the web page otherwise. |
| D11 | §5.2 "Cashfree, Razorpay and Stripe international were disabled; Paytm enabled but credentials missing" | Flags confirmed live: `paytmEnabled=true`, `cashfreeEnabled=razorpayEnabled=stripeIntlEnabled=false`, `walletRealMoney=false`, `billingEnabled=false`, `playTopupEnabled=true`. Secrets **cannot be verified from the repo**: none of the `PAYTM_*`, `RAZORPAY_*`, `CASHFREE_*`, `STRIPE_SECRET_KEY` names appear in `worker/wrangler.toml` for either env (only `STRIPE_PUBLISHABLE_KEY`, `:105` / `:705`); they are `wrangler secret put` values declared in `types.ts:326-378`. Also: `provisionFromGatewayPurchase` **defaults `gateway` to `"cashfree"`** (`commercial_checkout.ts:977`) and `GatewayId` still lists it (`lib/payments/types.ts:14`, `web/…/checkout/types.ts:60`). | Per CLAUDE.md the provider is an **open question and Cashfree is ruled out** — do not write a provider into Phase C. Replace the `"cashfree"` default with a hard refusal when `gateway` is absent. The spec's "one configured external provider" for the first test can only be satisfied by the wallet lane until the owner picks a rail. |
| D12 | §2.2 step 5 / §5.1 "Commercial checkout: phone exists — reuse" | The **product pivot (CLAUDE.md, 2026-08-27) makes the app read-only for money**: top-up, checkout and payout move to the web. Phone commercial checkout screens exist (`features/explore/commercial_checkout_sheets.dart`, `core/commercial_checkout_api.dart`, `features/booking/commercial_customer_screens.dart`) but building the first paid test on them contradicts the pivot. | Run the buyer side of the first end-to-end test on the **web** checkout; keep the phone for host backstage/broadcast and buyer viewing. Add this to §13 so nobody "fixes" phone checkout as part of Phase C. |
| D13 | §6.5 "web live chat uses temporary custom events" | Confirmed and narrower than stated: `GsChat.tsx:42,71` rides `call.sendCustomEvent({kind:'chat'})`, 200-message in-memory cap, **no reactions at all** in `live-gs`, no moderation/rate-limit/report. The legacy `islands/live/LiveChat.tsx` had slow-mode, blocked-notice and quick reactions over its own WS (`:2,10,16`). Phone GetStream rooms have **no chat, reactions, viewer count or moderation** either — only mute + "Report a problem" (`commercial_live_screens.dart:448-492,670-708`); `moderation` is a capability bool with no UI (`commercial_live_gateway.dart:81,86`). | Phase D is bigger than "port widgets": there is no commercial chat transport on either surface. See 18.3-S5. |

Everything else named in §6 exists at the stated path (all 7 checkout islands, both GetStream page pairs, all 7 worker routes, `live_room_widgets.dart` and its 12 transport-free classes, `commercial_getstream/*` — plus two files the spec omits: `commercial_consult_screens.dart` (276 lines, owns the only reconnect at `:195`) and `commercial_getstream_gateway.dart`). §7's six wrong-link locations are all confirmed at `LiveNowRail.tsx:60`, `PayReturn.tsx:101`, `Confirmation.tsx:58,63`, `TicketCard.tsx:41-42`, `ListingDetailView.astro:301`, `ConsultRoom.tsx:305`; **zero** generated links to `/live/` or `/session/` exist anywhere, and no redirect exists (`astro.config.mjs` has none, no `_redirects`, worker is API-only on `api.avatok.ai`).

## 18.2 Additional findings the spec does not mention

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| F1 | **`shellV2` is `true` in prod** (live read). | `/api/config` 2026-09-03; `shell/v2/shell_destinations.dart:93` opens the marketplace `MyListingsScreen`. | The pivot section says shellV2 "has never shipped". It has. §6.1's rewire must target the v2 shell first; `ava_shell.dart` is the fallback. Also means AskAva is exposed with no flag (pivot warning). |
| F2 | AI poster generation is a **synchronous 90 s Vertex call inside the admin HTTP request**. | `admin_listings.ts:35` awaits `generateImage` → `ava_image.ts:432` model `gemini-3.1-flash-image`, `timeoutMs: 90_000` (`:467`). | Worker request limits + admin browser timeouts. §4.3 says "asynchronous or bounded" — it is bounded at 90 s, which is the wrong bound. Queue it (`Q_*` consumer) and poll `attrs.poster.status`. |
| F3 | Generated poster is written into `cover_media` **before** poster approval, and stored under the **admin's** R2 namespace. | `admin_listings.ts:37-50,72-76`; key `u/${adminUid}/public/posters/${listingId}/…`. | An unapproved poster is already the public cover if the listing is published. Store under the listing/creator namespace and promote to `cover_media` only on `approve_poster`. |
| F4 | `reject_listing` records **no reason**; `reject_poster` does. | `admin_listings.ts:58` vs `:65`. | §4.3 "every state change must have reason" fails on day one. One-line fix, do it in the same migration as `listing_status_history`. |
| F5 | Admin allowlist is a single Clerk uid in **both** envs. | `wrangler.toml:112` and `:712` `ADMIN_UIDS`. | Fine for the first test; §15 "admin mutations require authorization" is satisfied only by env var. Not a blocker. |
| F6 | Per-lane flags are **triplets**; there is no single `commercialLiveEnabled`. | `config.ts:1781-1786`; `laneState()` reports `"mixed"` on disagreement (`commercial_checkout.ts:344-352`). | Test plans that say "flip commercial live on" need three keys, and §CLAUDE.md rule 5 (one `flags.sh set` with all k=v) applies. |
| F7 | Worker-side telemetry for the commercial lane is good; **client-side is thin.** | Worker: 15 `commercial_*` event families (`lib/commercial_telemetry.ts:25-42`). Phone `commercial_getstream`: exactly one event, `commercial_live_viewer_joined` (`commercial_live_screens.dart:638`). `features/listings/my_listings_screen.dart`: zero. Web `consult-gs/*`: zero `capture()` calls. | §14's funnel (`live_backstage_opened`, `live_started`, `live_reconnected`, `live_chat_sent`) has no client emitters. Add them to `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` first, per the 2026-09-02 rule. |
| F8 | The commercial features keep **no local state** on the phone, so the per-account-scoping rule is trivially met. | No `SharedPreferences`/secure-storage/`scopedKey` in `commercial_getstream`, `listings`, `marketplace`, `avalive`; `AccountScope.id` used only to bind credentials (`commercial_getstream_handoff.dart:133-164`). | Good. §15's scoping bullet is satisfied; keep it that way when Phase D adds chat (no local chat cache without `scopedKey`). |
| F9 | Stream webhook is solid: constant-time API-key check, HMAC over raw body, 2 MB cap, per-`x-webhook-id` dedupe, unbound/post-terminal → `review_pending`. | `stream_video_calls.ts:1824-1859`; `commercial_stream_sessions.ts:1436-1472`. | Nothing to change. Test-matrix item 4 (double callback) is covered for Stream; for the **payment** webhook it is covered by `commercial_checkout_operations.operation_id` (`:430-455`) + entitlement UNIQUE (`:751`). |
| F10 | Staging D1 was 23 `listings` columns behind prod until 2026-09-02. | CLAUDE.md §7 of the flags section. | Any Phase B migration must be applied to staging **and** verified with `PRAGMA table_info` before the staging end-to-end run, or the test proves nothing. |
| F11 | The legacy `/j/<token>` link is still what every reminder email carries and it 404s on web. | D7 evidence. | Not commercial-lane, but it is the *only* email link users receive today. Worth a redirect page (`/j/[token].astro` → app-or-web) in Phase A since the spec is already touching link generation. |

## 18.3 Suggestions (what I would change in the plan)

**S1 — Adopt the code-shaped state model and retire §4.3's names.** Listing: `draft → pending_review → approved → published → live → completed | cancelled | expired`, with `unpublished` (from Flowpipe) and `rejected`/`changes_requested` as review outcomes that return to `draft`. Poster stays `attrs.poster.status` (already five-valued). Smallest schema additions: `listing_status_history(id, listing_id, actor_uid, actor_role, prev_status, next_status, prev_poster_status, next_poster_status, reason, created_at)` + `listings.approved_at`, `approved_by`, `published_at`, `review_reason`. Add a `CHECK` on `listings.status` **only** after backfilling — the column has never been constrained and prod may hold stray values; run `SELECT status, COUNT(*) FROM listings GROUP BY 1` on prod first (read-only). Keep the CREATE in its own migration file (CLAUDE.md §6: `d1_apply_alters.py` skips CREATEs).

**S2 — Gate publish server-side in one place.** Make `publishListing` require `status='approved' AND attrs.poster.status='approved'` (the check `admin_listings.ts:66-70` already has) and turn the creator's call into `submit` (`draft → pending_review`). Remove `'draft'`-from-published and `'live'` from the owner-settable set in `setListingStatus` for `live_event`/`consult` kinds — going live is the GetStream session's job (`commercial_stream_sessions.ts:1575`), not a status POST. Guard with a flag `listingApprovalRequired` (declare in `PlatformConfig` **and** `DEFAULTS`, prove it flips — CLAUDE.md fake-flag rule) so the first staging run can be done with it off, then on.

**S3 — Build the host no-show sweep before the first paid test, not in Phase E.** A cron step next to `reconcileCommercialSessions` (`index.ts:410`): for `commercial_sessions` in `('scheduled','backstage')` where `scheduled_at + grace ≤ now` and no `live` transition, transition to `ended` with `settlement_state='pending'` and an `evidence_source='grace_expiry'` provider-event row, so the existing `creator_no_show` branch in `commercial_settlement.ts:409-441` fires and refunds via the already-idempotent `finalizeCommercialRefund`. Use `commercialLiveStartGraceMin` for real. Without this, test item 9 cannot pass and buyer money can sit in escrow indefinitely.

**S4 — Phase C can only be wallet-lane until the owner names a rail.** Delete the `"cashfree"` default (`commercial_checkout.ts:977`), leave the adapters in place, and make `/api/pay/methods` the single source of truth for the web picker (it already is: `GatewayPicker.tsx:86`). Stripe is on **test keys** and `walletRealMoney=false`, so a wallet-funded test moves no real money — which is the correct first test. Add "provider is undecided; do not assume" to §5.2 so the next agent doesn't re-enable Cashfree.

**S5 — Chat needs a transport decision, not a widget port.** Options: (a) GetStream Chat (same SDK family, Mumbai, moderation/rate-limit/ban built in — but a second billable product); (b) keep `sendCustomEvent` and add a server-side persist + moderation relay via the existing `InboxDO` pattern; (c) reuse the legacy `room.ts` WS. (c) is the lane being killed. Recommend (a) for the paid lane and reuse `live_room_widgets.dart` purely as presentation on top of it — the widgets are already transport-free (`live_room_widgets.dart:1-16`). Whatever is chosen, `moderation` capability in `commercial_live_gateway.dart:81` should become the single client gate.

**S6 — Reorder Phase A.** Do the link rewrite as a **single commit** that adds one helper per surface (`web/src/lib/commercialUrls.ts`, `worker/src/lib/commercial_urls.ts`, `app/lib/core/commercial_urls.dart`) and makes the six §7 sites + the email builders call it. Then add `/watch/[id].astro` and `/consult/[booking].astro` as 302s to the canonical page **only when** the listing/booking is a commercial kind (legacy free AvaLive may still need `/watch`), with a `legacy_route_hit` capture so §11.1 step 6 has data. Do not delete in the same commit (§16.8).

**S7 — Rewire the phone shell in the same commit as a class rename.** Rename `features/marketplace/my_listings_screen.dart`'s class to `LegacyMyListingsScreen` (touches `ava_shell.dart:41,400`, `shell_destinations.dart:13,93`, `marketplace_hub.dart:12,83`) rather than aliasing imports; then point all three at `features/listings/`. `flutter analyze` is available locally (CLAUDE.md toolchain note) — run it before commit.

**S8 — Reviews.** Change eligibility to `state='consumed'` only, and keep one-review-per-listing (occurrence == duplicated listing). Add the invitation as a `commercial_notifications` type (`review_window_open`) fired from `commercial_settlement.ts` at `settled`, not a new email until D7's dedupe table exists.

**S9 — Telemetry catalogue first.** Add the §14 event list to `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` with the success value per event (ship-gate rule 3), and a `tool/ship_manifest.json` entry per phase issue id with `two_sided: true` and `min_devices_on_build: 2` for Phase D. Evidence for the first test = the §13 id list, captured from PostHog, not from a screen recording.

**S10 — Merge or subordinate the two 2026-09-03 specs.** Flowpipe owns listing creation → approval → poster → public card → booking modal; this spec owns checkout → GetStream session → settlement → review → deletion. Cross-reference each from the other's header and delete the overlapping §4.3 / Flowpipe §3 duplication so there is one state table. Two agents implementing two state machines this week is the most likely way to lose a month.

## 18.4 Shortest safe path to a two-account paid livestream test (my ordering)

1. S3 no-show sweep + F4 reject reason + S1 history table (one worker issue, staging first, then prod migration — deliberate).
2. S6 link helper + six-site rewrite + `/j` redirect page (web + worker; no deletion).
3. S7 shell rewire (phone; local `flutter analyze`, `ship local` for both targets).
4. S2 publish gate behind `listingApprovalRequired=false`, admin actions reachable via `curl` + `ADMIN_UIDS` until an admin UI exists (D1) — the first test does not need a UI, it needs the gate.
5. Wallet-lane paid test on **web** buyer + **phone** host, two real accounts, both on the newest build (ship-gate rule 2), asserting `commercial_settlement outcome=settled` and `commercial_checkout outcome≠refused` in PostHog.
6. Only then: chat transport (S5), emails (D7), partial refunds (D5), deletion gate (§11).

## 18.5 What I could not verify

- Worker **secrets** (Paytm/Razorpay/Stripe secret keys) — not in the repo; needs `wrangler secret list` run by the owner or via `scripts/cf.sh`.
- GetStream **region = Mumbai** — dashboard setting, not in code (CLAUDE.md).
- Prod `listings.status` value distribution — needs a read-only D1 query before S1's CHECK constraint.
- Whether any external party holds `/watch/<id>` bookmarks — only telemetry after S6 can answer.

---

# 19. New admin dashboard — first two screens (owner decision 2026-09-03)

The legacy console was removed by `[ADMIN-RESET-1]` (D1). This section specifies its replacement, **scoped to the two screens the owner asked for first**: an **Overview** landing page of analytical cards, and a **Listings** page (next sidebar item) where listings are approved. Everything else (money, users, alerts, flags) is out of scope until these two ship.

## 19.1 What already exists and is reused

| Piece | Where | State |
|---|---|---|
| Admin auth | `worker/src/routes/admin_money.ts:18-24` `requireAdmin` — Clerk user ∈ `ADMIN_UIDS` (`wrangler.toml:112` prod, `:712` staging, one uid each) | Reuse as-is. Server is the boundary; UI gate is cosmetic. |
| Overview API | `GET /api/admin/overview` → `admin_dashboard.ts:83-135` | Returns sessions / money / signups / needs_attention / surfaces. **Partly stale**: counts `live_sessions` (legacy Cloudflare table) and lists surfaces `AvaLive/AvaConsult/Conference/AvaVoice/AvaVision/Translation` — pre-pivot names. Needs a commercial block (below). |
| Analytics proxy | `GET /api/admin/analytics?insight=<key>&range=<days>` → `admin_dashboard.ts:252-290`; fixed HogQL allow-list `POSTHOG_QUERIES` (`:239-247`: `dau`, `events_total`, `signups`, `errors`, `error_by_endpoint`, `active_now`, `trend_daily`); 60 s per-isolate cache; personal key never reaches the browser | Reuse. Add commercial insights to the allow-list. `POSTHOG_PROJECT_ID`/`POSTHOG_QUERY_HOST` are set in both envs (`wrangler.toml:87-88`, `:695-696`); `POSTHOG_PERSONAL_API_KEY` is a secret — confirm it is set or the cards render "PostHog key not configured" (`:262`). |
| Listings API | `GET /api/admin/listings?status=` and `POST /api/admin/listings/:id` (`admin_listings.ts`; wired `index.ts:1246-1247`) | Reuse, extend per 19.4. |
| Audit | `admin_audit` in `DB_WALLET` (`migrations/wallet_ledger.sql:38-45`), read by `GET /api/admin/audit` (`index.ts:1252`) | Reuse for the per-listing timeline until `listing_status_history` (S1) lands; then join both. |
| Layout | `web/src/layouts/Dashboard.astro` — sidebar (`:123-159`), active-item key (`:20`), mobile drawer (`:189`) | Reuse the shell; give it an `items` prop (or an `admin` variant) instead of forking a second layout. Drop the "+ New" button (`:178`) in admin mode. |
| Gate + API wrapper | Deleted `web/src/islands/admin/AdminGate.tsx` (50 lines) and `adminApi.ts` (174 lines) — recover with `git show 3d572e09^:web/src/islands/admin/AdminGate.tsx` | Restore both **verbatim first**, then edit. `adminApi.ts` already types `Overview`, `AnalyticsResult` and `useAdminGate()`; `AdminGate` fails closed on `anon`/`forbidden`. |
| Design tokens | Tailwind classes already used by the creator dashboard (`border-zine`, `shadow-zine-xs`, `font-mono uppercase tracking-[0.06em]`), type rules in CLAUDE.md (Anton/Nunito/Instrument Sans; never negative tracking on bold) | Same system as the creator dashboard. No new fonts. |

Stack: Astro 5 + React 19 islands (`web/package.json`), same as every other dashboard page. Deployed as part of the Pages project `avatok-app`; no worker deploy is needed for the UI, but the API additions in 19.4 are worker changes (commit → `npx tsc --noEmit` → `scripts/cf.sh worker deploy`, staging first).

## 19.2 Routes and navigation

```text
/admin                → Overview (analytical cards)          sidebar key: overview
/admin/listings       → Listings queue + review drawer       sidebar key: listings
/admin/listings/<id>  → same page, drawer opened on <id> (deep-linkable from emails/alerts)
```

Sidebar order: **Overview, Listings**, then a divider and greyed placeholders (Money, Users, Alerts, System) that are **not rendered as links** until they exist — never a dead link in admin. Every `/admin/*` page: `AdminGate` around the island, `noindex`, no `BetaBanner`, no marketing header. `Nav.astro` gets the admin link back **only for admins** (the deleted commit removed 6 lines there; render it client-side after `useAdminGate()` returns `admin`, not server-side).

## 19.3 Screen 1 — Overview (landing)

Purpose: in ten seconds, is the platform healthy and is anything waiting for me. Cards only; no tables. Four rows, top to bottom by urgency.

**Row 1 — Needs attention (click-through chips, red when > 0).**
`Listings awaiting review` (new: `COUNT(*) FROM listings WHERE status='pending_review'` — after S2; until then `status='draft' AND attrs.submitted_at IS NOT NULL`) · `Posters awaiting review` (`attrs.poster.status='draft'`) · `Failed settlements` · `Recon diffs` · `Open reports` · `Open alerts` · `Sessions in review_pending` (new: `commercial_settlement_jobs WHERE state='review_pending'`). Each chip links to its queue; the first two link to `/admin/listings?queue=…`; the rest link to the placeholder sections (disabled until built — show the count, disable the link).

**Row 2 — Right now.**
`Live now` (new: `commercial_sessions WHERE state='live'` split by `kind`; **replace** the legacy `live_sessions` count) · `Backstage` (`state='backstage'`) · `Scheduled next 24 h` · `Active users (5 min)` (PostHog `active_now`) · `Web/app error count today` (PostHog `errors`, plus a new `exceptions` insight on `$exception`).

**Row 3 — Money (₹, never `$`; formatter `web/src/lib/money.ts`).**
`Escrow held` · `GMV today / MTD` · `Platform fees today / MTD` · `Refunds today` (new: `wallet_ledger` type `commercial_refund*` since start-of-day) · `Creator payouts pending`. Source: `/api/admin/overview.money` + two new fields. Stripe is on test keys and `walletRealMoney=false`, so label the row **"test mode"** whenever `walletRealMoney` is false — read it from `/api/config`, do not hardcode.

**Row 4 — Growth (PostHog, 7 / 30 / 90-day toggle, sparkline per card).**
`DAU` · `Signups` · `Listings published` (new insight on `listing_published`) · `Checkouts started → paid` (new insight: `commercial_checkout` with `outcome` = `started`/`settled`… as a two-number card + conversion %) · `Live joins succeeded / failed` (new: `live_join_result`). Each card is one `POSTHOG_QUERIES` entry; the client never sends SQL.

Behaviour: every card fetches independently with its own skeleton and its own error state ("PostHog not configured" is a valid state, not a crash). Auto-refresh 60 s (matches the server cache). `ts` shown in the corner. No card may block another.

## 19.4 Screen 2 — Listings (approval)

**Left: queue.** Tabs = `Awaiting review` (default) · `Poster review` · `Published` · `Rejected / changes` · `All`. Columns: poster thumb (or "no poster"), title, creator (display name + handle — **the API must join `creator_profiles`**, today it returns only `creator_id`), kind, price (₹), scheduled `starts_at` in IST, submitted-at, status pill, poster-status pill. Search by title/creator; sort by submitted-at asc (oldest first — it is a queue). Server pagination — the current route is `LIMIT 100` with no cursor; add `?cursor=&limit=`.

**Right: review drawer** (opens on row click or `/admin/listings/<id>`), sections top to bottom:

1. **Public preview** — render the exact public card and the details page content (`ListingTile`, `ListingDetailView` data), not a summary. What the admin approves is what the buyer sees.
2. **Submitted fields** — every field the creator entered, read-only, with `adults_only`, refund policy, capacity, duration and price called out. KYC/liveness status of the creator (already required by `publishListing`, `listings.ts:1280ff`) shown as a badge.
3. **Listing decision** — `Approve` · `Request changes` (reason required, returns to `draft` with `review_reason`) · `Reject` (reason required — fixes F4). Reasons are free text plus 5–6 canned picks (pricing unclear, prohibited content, missing schedule, media quality, policy mismatch, other).
4. **Poster** — current poster (versioned), `Generate` / `Regenerate` (with optional prompt note), `Approve poster` / `Reject poster` (feedback required, already stored at `admin_listings.ts:58`). Generation is **async** (F2): the button enqueues, the drawer polls `attrs.poster.status` every 5 s and shows `generating` → `draft` | `failed`. Promote to `cover_media` only on approve (F3).
5. **Publish** — enabled only when listing = `approved` **and** poster = `approved` (the rule already at `admin_listings.ts:66-70`). Also `Unpublish` (new action; sets `unpublished`, preserves bookings — from the Flowpipe spec §3) with reason.
6. **Timeline** — every transition with actor, time, prev → next, reason, from `listing_status_history` (S1) merged with `admin_audit` rows where `target = listing id`.

Every action: optimistic UI off, confirm dialog for reject/unpublish, disabled while in flight, `Idempotency-Key` header (reuse the `commercial_live_gateway` pattern: `admin:<listingId>:<action>:<version>`), toast with the server's returned `next_status`.

## 19.5 API changes (worker, one issue each)

| Id | Change | File |
|---|---|---|
| A1 | `GET /api/admin/listings`: join `creator_profiles` (name, handle, kyc/liveness), add `queue=` (`review`, `poster`, `published`, `rejected`), `q=`, `cursor=`, `limit≤100`, return `total` per queue for the tab badges | `admin_listings.ts:8-14` |
| A2 | `GET /api/admin/listings/:id`: full record + poster versions + merged timeline | new handler, `index.ts` |
| A3 | `POST …/:id` actions: add `request_changes` (reason required), make `reject_listing` require `reason`, add `unpublish` (reason), write `listing_status_history` on every action, accept `Idempotency-Key` | `admin_listings.ts:16-84` |
| A4 | Poster generation → queue consumer (`Q_*`), handler sets `attrs.poster.status='generating'` and returns 202; consumer writes `draft`/`failed`; R2 key under `u/<creatorId>/public/posters/…` | `admin_listings.ts:26-53`, `consumers/` |
| A5 | `/api/admin/overview`: add `commercial: { live, backstage, scheduled_24h, review_pending_settlements, listings_awaiting_review, posters_awaiting_review, refunds_today }`; replace `live_sessions` count with `commercial_sessions`; retire the pre-pivot `surfaces` list or map it to the real flag names (`commercialLive*`, `commercialConsult*`) | `admin_dashboard.ts:83-135` |
| A6 | `POSTHOG_QUERIES`: add `exceptions`, `listings_published`, `checkout_funnel`, `live_join_results`; all `{RANGE}`-parameterised, no client SQL | `admin_dashboard.ts:239-247` |

A3 depends on S1's migration (`listing_status_history`) and S2's `pending_review` write. A1/A5/A6 have no schema dependency and can ship first so the Overview is useful on day one.

## 19.6 Telemetry (required before code — `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md`)

Web (`web/src/lib/analytics.ts`, never `window.posthog`): `admin_page_view {page}`, `admin_card_error {card, reason}`, `admin_listing_open {listing_id, queue}`, `admin_listing_action {listing_id, action, ok, ms}`, `admin_poster_generate {listing_id, ok, ms}`. Super-properties as everywhere (`platform`, `service_name`, `release`, `email`, `clerk_uid`, `trace_id`). Worker: `track('admin_listing_action', …)` with `outcome`, mirroring `commercial_telemetry.ts`. Success value for the ship manifest: `admin_listing_action ok=true action=publish` observed for a listing that subsequently appears in `listing_view` from a non-admin person.

## 19.7 Acceptance

- Non-admin (signed-in) hitting `/admin` sees "Admins only" and every `/api/admin/*` call returns 403 — verified with a second real account, not just the UI.
- Overview renders all cards with PostHog key **absent** (degraded state) and present.
- A listing submitted from the phone appears in `Awaiting review` within one refresh, shows creator name, and cannot be published until both approvals are recorded; the timeline shows four rows (submit, approve, poster approve, publish) with the admin's uid and reasons.
- Reject without a reason is refused by the **server** (400), not only the UI.
- Poster generate returns within 1 s (202) and the drawer reaches `draft` or `failed` without a page reload.
- All money on the page prints `₹`; no `$` anywhere in `web/src/islands/admin/**` (grep gate).
- `flutter analyze` not needed (web only); `npx tsc --noEmit` in `worker/` green before deploy; `check_design_guard.py` irrelevant (web), but no inline colour literals outside Tailwind tokens.

## 19.8 Ordering

1. Restore `AdminGate.tsx` + `adminApi.ts` from git; `Dashboard.astro` admin variant; `/admin` page with Row 1–3 cards from the **existing** overview payload. (Web only — ships in an afternoon.)
2. A5 + A6 → Row 2/4 cards go live.
3. A1 + A2 → Listings queue + read-only drawer.
4. S1/S2 migrations (§18.3) → A3 → decision buttons.
5. A4 → async poster.
6. Only then: Money / Users / Alerts screens, each as its own spec addendum.

## 19.9 UI inventory — what exists vs. what must be built

Checked against the tree at `3d572e09` and the pre-deletion tree (`3d572e09^`). "Recoverable" = deleted today, restore with `git show 3d572e09^:<path> > <path>`, then edit.

### Exists in the tree today (reuse)

| UI piece | Path | Notes |
|---|---|---|
| Sidebar dashboard shell | `web/src/layouts/Dashboard.astro` | Sidebar, active key, mobile drawer. Needs an `items`/admin variant; no fork. |
| `Card`, `Pill` (`ok\|no\|hint\|plain`), `Button`, `Modal` (`dismissable`, `maxWidth`), `Sheet`, `Spinner`, `Field`, `Avatar`, `IslandBoundary` | `web/src/components/*.tsx` | The whole admin UI can be built from these. |
| `ListingTile` + `ListingDetailView.astro` / `ListingDetailsComp.astro` | `web/src/components/` | The "public preview" pane in the drawer renders these with the listing record — no second renderer. |
| Money formatter | `web/src/lib/money.ts` | `₹` only. |
| Analytics wrapper | `web/src/lib/analytics.ts` (`capture`, `withTrace`, `apiError`) | Mandatory for 19.6. |
| API client + Clerk bridge | `web/src/lib/apiClient.ts`, `web/src/lib/clerk.ts` (`ClerkIsland`, `getActiveToken`) | `adminApi.ts` sits on top of these. |
| Creator-side listing form | `web/src/islands/dashboard/listing-form/ListingWizard.tsx`, `ListingPublish.tsx` | Not admin UI, but the field list in the drawer's "Submitted fields" section should mirror the wizard's steps. |

### Recoverable from git (deleted by `[ADMIN-RESET-1]`, restore then edit)

| File (lines) | Keep / change |
|---|---|
| `islands/admin/AdminGate.tsx` (50) | **Restore verbatim.** Fail-closed gate on `useAdminGate()`; already wraps `ClerkIsland`. |
| `islands/admin/adminApi.ts` (174) | **Restore**, then extend: `Overview` type gains `commercial{…}`; add `getAdminListing(id)`, `adminListingAction(id, action, {reason, idempotencyKey})`, `getAdminListingsQueue({queue,q,cursor})`. |
| `islands/admin/OverviewCards.tsx` (92) | Restore the `Kpi` card and the needs-attention `Pill` strip. **Change:** labels say "Coins" (`:55`) — must become tokens/₹ per the 2026-08-05 rule; surface pills (`:80`) list pre-pivot products — replace with 19.3 Row 2. |
| `islands/admin/AnalyticsCards.tsx` (103) | Restore. Loads Chart.js 4.4.1 from cdnjs at runtime (`:11-22`) — no npm chart dep exists (`package.json` has none), so this is the sparkline mechanism; keep it, add the four new insights. |
| `islands/admin/ListingsPanel.tsx` (18) | **Do not restore as-is** — it was a flat card list with status chips and inline buttons, no reasons, no drawer, no creator name (reads `l.creator_name` which the API never returned), no poster feedback, `approve_listing` only offered on `draft`. Use it as the reference for the action names only. |
| `islands/admin/AuditLog.tsx` (56) | Restore; reuse inside the drawer's Timeline section filtered by `target = listing id`. |
| `pages/admin/index.astro` (64), `pages/admin/listings.astro` (12) | Restore the page files, replace their body: the old index stacked six sections on one page (`:54-59`); the new one is Overview only, with Listings as its own sidebar route. |
| `AlertsInbox`, `LiveFeed`, `AgentsPanel`, `FlagsPanel`, `LedgerExplorer`, `PayoutsQueue`, `ReconPanel`, `UserSearch` | Leave deleted for now — out of scope for the first two screens. They stay recoverable when Money/Users/Alerts are specified. |

### Must be built new (does not exist anywhere)

| Piece | For | Size |
|---|---|---|
| Admin sidebar item list + `Dashboard.astro` admin mode (no "+ New", placeholders greyed) | both | S |
| Client-side admin link in `Nav.astro` (render after gate says `admin`) | both | S |
| `AttentionChip` (count + href, red when > 0, disabled when target screen doesn't exist) | Overview row 1 | S |
| Range toggle (7/30/90) shared across Row 4 cards + per-card skeleton/error/"not configured" states | Overview | S |
| `ListingsQueue` table: tabs with counts, search, sort, cursor pagination, poster thumb, creator cell, IST time | Listings | M |
| `ListingReviewDrawer`: preview pane, submitted-fields pane, KYC badge | Listings | M |
| `DecisionBar`: approve / request changes / reject with **required-reason** dialog and canned reasons (built on `Modal`) | Listings | S |
| `PosterPanel`: versions, generate/regenerate with note, approve/reject with feedback, 5 s polling of `attrs.poster.status` | Listings | M |
| `PublishBar`: publish (gated on both approvals) / unpublish with reason | Listings | S |
| `ListingTimeline`: merged `listing_status_history` + `admin_audit` rows | Listings | S (after S1) |
| Toast/notice primitive (none exists in `components/`; the creator dashboard uses inline text) | both | S |
| `Tabs` primitive (none exists; old panel used ad-hoc buttons) | Listings | S |

Rough total: two small screens' worth of new React (~1,200–1,500 lines including the restored files), plus the six worker changes in 19.5. No new npm dependency; no design-system additions.

---

# 20. Browser-only attendance — no app required (owner decision 2026-09-03)

**Rule.** A buyer who does not have the AvaTOK app must be able to attend a paid livestream and a paid 1:1 consultation entirely in a mobile or desktop browser. The link we email is the **same** link the public listing, the confirmation page and the dashboard use — one stable URL per event, opening in the app when installed and in the browser otherwise. The app is optional for buyers; it stays required only for the creator's live broadcast (§6.2).

## 20.1 What already works in the browser (verified)

| Capability | Evidence | Status |
|---|---|---|
| Watch a paid livestream signed-out → sign in by email + 6-digit code → join | `web/src/pages/live/[id].astro` renders `LiveGsViewer` with a public SSR read that degrades instead of 404 (`:20-28`); `LiveGsViewer.tsx:88` calls `requireGuestAuth()`, which opens the email/code modal and resolves a **real Clerk session** (`web/src/lib/clerk.tsx:32-36,128-135`); join is then `POST /api/commercial/live/<id>/join` → GetStream viewer token. | **Works today.** |
| No ticket → sent to checkout in the browser | `LiveGsViewer.tsx:81` `bookHref=/book/<id>`; `needs_ticket` refusal (`:327-369`) | Works. |
| Attend a paid 1:1 as buyer **or** creator in the browser | `web/src/pages/session/[booking].astro` (`no-store`, `headerAuth="static"`, `:23-29`); `ConsultRoomGS.tsx:103` `requireGuestAuth()`, `:264` role derived server-side (`creator` \| `buyer`), prejoin → join. | Works. Creator can host a 1:1 from a browser; only the **livestream** host needs the app. |
| Buy in the browser with email + code (no account beforehand) | `BookingFlow.tsx` → `GuestEmail.tsx` (thin wrapper on `GuestGate`, `:3-9`) → wallet or gateway | Works (wallet lane; gateway per D11). |
| Entitlement follows the email, not the device | `commercial_entitlements` keyed on `account_id` (`commercial_stream_sessions.ts:257-270`); Clerk resolves the same email to the same user, so a purchase on the web and a later join from another browser (or the app) hit the same entitlement. | Works by construction. |

So the browser lane is **not a build project; it is a linking and email project.** The two pages exist, authenticate guests and authorise joins. Nothing today sends anyone to them (§18.1, zero generated `/live/` or `/session/` links) and no email carries them (D7).

## 20.2 The one link

```text
Livestream:  https://avatok.ai/live/<listing-id>
1:1:         https://avatok.ai/session/<booking-id>
```

- **One URL for the whole life of the event.** Before start it shows the poster, local time, price and Book/Booked; during, Join now; after, the outcome/receipt and the review prompt (§10). The page decides from server state — the link never changes, so an email sent at purchase time is still correct on the day.
- **Used everywhere**: listing CTA, `Confirmation.tsx`, `PayReturn.tsx`, `TicketCard.tsx`, `LiveNowRail.tsx`, the reminder and confirmation emails, the `.ics` `URL:` field, push deep links, and the phone's share sheet (`share_live_event_sheet.dart`). One helper per surface (S6) so nobody hand-builds it.
- **No credentials in the link.** The URL carries only the public id (§15). Identity comes from the email + code gate at click time; the join token is minted per request by the worker. This is why the same link is safe to forward — a forwarded link without the buyer's mailbox is worth nothing.
- **App-or-browser**: register `/live/*` and `/session/*` as Android App Links in the manifest and add both path shapes to `core/deep_links.dart` (today it only accepts `/session?listing_id=` query form, D10). With the app installed the OS opens it; without, the same URL opens the browser page. Do **not** use a separate `avatok://` link in emails — mail clients strip or block custom schemes and it breaks for the exact users this section is for.
- **Legacy**: `/watch/<id>` and `/consult/<id>` 302 to the canonical URL for commercial kinds (S6). `/j/<token>` gets a tiny page that redirects to the canonical URL for the booking it encodes (F11), so already-sent calendar invites keep working.

## 20.3 Email content (extends §9)

Every buyer email for a paid event carries the canonical link as the primary button and as plain text underneath (mail clients that strip buttons). Subject and first line state the event, IST date/time, and "works in your browser — no app needed". Include: creator name, duration, price paid (₹), refund policy one-liner, an `.ics` attachment whose `URL:` and `DESCRIPTION:` carry the same link (`worker/src/cal/ics.ts` currently writes `/j/<token>` at `:39` — change to the canonical URL). Reminder ladder (24 h / 60 m / 10 m) reuses the existing one-shot flags pattern in `consumers/src/calendar.ts:92-131` but must be driven off `commercial_sessions.scheduled_at`, not `bookings`. A **"Join now — the stream has started"** email at `commercial_broadcast_started` is optional; push already exists for app users, email is the equivalent for browser users.

Idempotency: one `commercial_email_sends(idempotency_key UNIQUE)` row per `(session_id, order_id, template)` before enqueue (D7). Never re-send a confirmation on retry.

## 20.4 Browser-page requirements (gaps to close on `/live` and `/session`)

| Gap | Where | Why |
|---|---|---|
| Signed-out visitor sees "Sign in required" language | `LiveGsViewer`, `ConsultRoomGS` refusal copy | Say "Enter the email you booked with" — the buyer has no account in their mind. |
| Wrong email → `needs_ticket` → sent to buy again | `LiveGsViewer.tsx:327-369` | Show "No ticket found for **x@y** — did you book with a different email?" with a switch-email action before offering checkout. Double-purchase is the failure mode here. |
| No "add to calendar" / "email me the link" on the page | both pages | Buyer opened on desktop, wants it on phone later. Re-send goes through the same idempotent template (`resend` counter, capped). |
| No pre-join device check for buyers on `/live` | `LiveGsViewer.tsx:126` joins directly | Fine for viewing (no local media). For `/session` the `PreJoin.tsx` check exists — keep. |
| Mobile-browser autoplay | `LiveStage.tsx` | iOS Safari needs a user gesture + muted start; show a tap-to-unmute overlay rather than a silent failure. Emit `live_player_state`. |
| Reconnect on the web live page | none (only consult has `_reconnect`, phone) | Auto-retry join with the same entitlement on `call` disconnect; §10.4. |
| Chat / reactions for browser viewers | `GsChat.tsx` — in-memory, no reactions, no moderation | Whatever S5 picks must work identically on web; browser viewers are the majority for this lane. |
| Leave → outcome / review | pages end at "ended" | After `ended`, render receipt summary + review CTA (verified attendee, §4.5) on the same URL. |
| Immersive chrome | `Base.astro` `chrome` prop (`:19-20`) | Use `chrome={false}` on `/live` during playback; keep header on `/session` pre-join. |
| No app-nag | — | Never gate the page behind "download the app". `AppDownloadCta.tsx` may appear **after** the event, as a footer, not before join. |

## 20.5 Telemetry (add to the catalogue)

`link_open {surface: email|listing|dashboard|share|calendar|legacy_redirect, kind, id}` on page load (from a `?src=` param the helper appends; never the buyer email in the URL), `guest_gate_shown / guest_gate_verified`, `live_join_result` (exists), `live_wrong_email_switch`, `email_resend_requested`. Success value for the ship manifest: a `live_join_result ok=true` from a person whose **first** event ever is a `link_open src=email` on a non-app `platform`.

## 20.6 Acceptance

1. Fresh browser, no cookies, no app: open the emailed `/live/<id>` link → poster + time → "Enter the email you booked with" → code → Join now → video plays; total taps ≤ 4.
2. Same link opened on a phone **with** the app installed opens the app's viewer via App Links; uninstalling the app and reopening the same link lands on the browser page.
3. Same for `/session/<booking>` as buyer and as creator, on iOS Safari and Android Chrome.
4. Booked with email A, gate with email B → clear "no ticket for B" message with switch-email; no second checkout started.
5. Confirmation email, 24 h reminder, and `.ics` all contain the identical canonical URL; resending the confirmation produces one email.
6. Forwarding the link to a third party who never bought yields `needs_ticket`, never a join.
7. Old `/watch/<id>` and `/j/<token>` links from earlier emails land on the canonical page.

## 20.7 Ordering (folds into §18.4)

Add to step 2 (link helper): register App Links + `deep_links.dart` paths + `/j` redirect page. Add to step 5 (first paid test): the buyer joins **from a browser on a phone with no app installed** — that is the test, not a nice-to-have. The email templates (§20.3) come with D7's dedupe table, directly after the first successful wallet-lane test.

---

# 21. Independent audit and resolution (Codex, 2026-09-03)

## 21.1 Method and limits

I re-read the full current document, the second-reviewer notes, the current tree at `3d572e09`, the marketplace pivot, the Flowpipe spec, relevant routes, migrations, web islands, phone navigation, Android App Links, email consumers, GetStream rooms, and settlement code.

I also fetched the live public production configuration with a cache-busting query. It confirms, among other values:

- `shellV2=true`;
- all three commercial live flags are true;
- all three commercial consultation flags are true;
- `liveEnabled=false` and `consultEnabled=false` for the old lanes;
- `paytmEnabled=true`, while Cashfree, Razorpay and Stripe international flags are false;
- `walletRealMoney=false` and `billingEnabled=false`;
- `listingPublishKycRequired=false`;
- `commercialLiveStartGraceMin=15`;
- `commercialCreatorCancelRefundPct=100`;
- `commercialLateCancelRefundPct=0`.

The local Cloudflare OAuth session is currently authenticated to a different account from the account id in `worker/wrangler.toml`. Fresh read-only D1 and secret-list commands failed with Cloudflare errors `7403` and `10000`. Therefore I could not independently query the live listing-status distribution in this pass. An earlier successful secret-name inventory during the initial audit showed Stream secrets but no Paytm merchant secret names; that result should be rechecked after the Cloudflare account login is corrected.

No code, flag, database, deployment, or production data was changed by this audit.

## 21.2 Executive correction

The second reviewer materially improves the original spec, especially on the missing no-show sweep, deleted admin UI, review eligibility, email deduplication, web-only payments, and link fragmentation. It should not be adopted verbatim, however. The following corrections are important:

1. `expired` is not a real listing status today. Expiry is derived from `expires_at`/time. Do not add an `expired` status without a separate reason.
2. Poster status must remain separate from listing status.
3. The current web GetStream livestream already has SDK reconnect state, a stuck-reconnect warning, manual retry, `live_player_state`, and `live_stall` telemetry. Section 20's statement that web live has no reconnect is false.
4. The GetStream consultation web client already emits prejoin, join, SDK-error, extension, and end telemetry. F7's claim of zero consult telemetry is false.
5. A wallet-token test with `walletRealMoney=false` is useful, but it is not a real paid-payment test. The spec must name those as two different milestones.
6. The entitlement lifecycle never appears to write `state='consumed'`. This is a new launch-critical finding because verified reviews and creator repeat-buyer analytics depend on that state.
7. The removed admin console should be treated as recoverable reference code, not restored wholesale or verbatim without understanding why `[ADMIN-RESET-1]` deliberately removed it.
8. Local `flutter analyze`, TypeScript compile, and build instructions in the reviewer notes conflict with the current repository instruction that local build/compile tools must not be run. Verification belongs in GitHub Actions unless the repository rule is explicitly changed.

## 21.3 Resolution of the second reviewer's disagreement list

| Note | Independent verdict | Resolution |
|---|---|---|
| D1 — admin UI was deleted | **Confirmed.** Commit `3d572e09 [ADMIN-RESET-1]` deleted 23 admin web files, including all admin pages, `AdminGate`, `adminApi`, and `ListingsPanel`. Backend admin routes remain. | Change all earlier “extend admin UI” wording to **build a new focused admin UI, selectively reusing code from history**. Do not restore the old console wholesale. |
| D2 — listing/poster state mismatch | **Confirmed, with correction.** `listings.status` is unconstrained text; admin writes values outside the old comment enum; poster uses `attrs.poster.status`; nothing submits to `pending_review`. | Use the state model in §21.5. Do not model poster states as listing states, and do not store `expired` merely because time passed. |
| D3 — creator publish bypass is the only working publish path | **Confirmed.** Phone and web call owner `/publish`; admin approval is optional and parallel. | Add server submission first, update both clients to submit, then gate owner publish. Old builds receive typed `409 approval_required`, never a 404 or accidental publish. |
| D4 — no host-no-show grace sweep | **Confirmed and P0.** Grace is used as a join-window close value. Settlement jobs are created by an end event; an untouched scheduled session has no terminal event/job. | Build an idempotent server cron transition for overdue `scheduled/backstage` sessions before accepting money from real users. This moves ahead of UI polish and partial refunds. |
| D5 — partial refund unsupported | **Confirmed.** Non-0/100 percentages become `review_pending`. Production late-cancel policy is currently 0%. | Partial refunds do not block a controlled wallet-token happy-path test, but they block the user-requested connectivity-refund policy from being considered complete. |
| D6 — review eligibility too broad | **Confirmed, plus a deeper defect.** Any entitlement permits a review; only `consumed` makes it verified. No code was found that ever marks an entitlement consumed. | On authoritative completion, move eligible active entitlements to `consumed`. Require `consumed` for paid-event review eligibility, not merely for the badge. Preserve one review per duplicated listing occurrence. |
| D7 — email code is legacy | **Confirmed.** Queue/Brevo/Clerk lookup/ICS primitives are reusable, but templates and `/j/<token>` routing are legacy; email sending has no commercial idempotency store. | Reuse transport primitives only. Add commercial templates, stable URLs, and an outbox/dedupe record before wiring commercial email. |
| D8 — third old My Listings importer | **Confirmed.** `marketplace_hub.dart` also imports the old phone screen. | Rewire `marketplace_hub.dart`, shell v1 and shell v2 together. Because shell v2 is live, verify it first. |
| D9 — legacy AvaLive is gated fallback | **Confirmed.** Old screens remain reachable when the commercial flag is false and through explicit old imports. Production currently selects commercial GetStream. | Inventory free/non-commercial dependencies. Add an explicit legacy flag defaulting false if the product must preserve the lane temporarily; otherwise migrate callers and delete after route telemetry. Never let missing config silently choose legacy media. |
| D10 — phone deep-link shape mismatch | **Confirmed.** Android claims `/session`, but Dart extracts only query parameters; there is no `/live/<id>` parser. | Adopt `/live/<listing>` and `/session/<booking>` paths. Extend Dart parsing and navigation, verify Android association, and separately verify/add iOS association if iOS is in scope. |
| D11 — payment provider uncertainty | **Partly confirmed.** Live flags prove Paytm is selected, but current Cloudflare auth prevented a fresh secret inventory. The generic gateway provisioning fallback to Cashfree is real. | Treat external payments as unavailable until `/api/pay/methods` and a sandbox/test order prove a configured provider. Make new generic callers supply a gateway explicitly; update the legacy Cashfree caller explicitly before removing the compatibility default. Do not simply delete the default and break an existing webhook. |
| D12 — phone must be read-only for money | **Confirmed by the 2026-08-27 owner pivot.** Existing phone checkout code contradicts the current product decision. | Web owns checkout/top-up/payout. Phone may show balance, receipts, booked state, and a secure “Continue on web” handoff. Existing phone checkout becomes a deprecation/deletion candidate after all entry points are redirected. |
| D13 — commercial chat incomplete | **Confirmed.** Web has ephemeral custom-event chat only; phone GetStream live has no chat/reactions/moderation UI. | Choose a commercial chat authority before porting UI. Reuse old widgets only as presentation. Do not reconnect the legacy room WebSocket merely to save time. |

## 21.4 Resolution of additional findings F1–F11

| Note | Independent verdict | Independent note |
|---|---|---|
| F1 — shell v2 is live | **Confirmed by current public production config.** | The main navigation bug affects production users now. The shell-v2 import is the first phone rewire; shell v1 remains compatibility work. |
| F2 — poster generation is synchronous for up to 90 seconds | **Confirmed.** | Queue generation and return `202`. Record attempts/version so an older completion cannot overwrite a newer regeneration. |
| F3 — poster enters `cover_media` before approval and under admin namespace | **Confirmed.** The generation action stores a staged array in attrs and the common final update immediately writes it to `cover_media`. | Keep the draft asset private/non-public to listing rendering until approval. Store ownership under listing/creator, run the required safety/moderation policy, and promote atomically on approval. |
| F4 — listing rejection has no reason | **Confirmed.** | Make reason mandatory server-side. Also make poster rejection feedback non-empty server-side; today an empty string passes. |
| F5 — one configured admin uid per environment | **Confirmed from repository configuration.** | Sufficient for a first controlled test, but actions still require durable, fail-closed audit writes. Current listing audit is best-effort and can disappear. |
| F6 — commercial lane uses three flags | **Confirmed.** | Treat listing, checkout and join as a triplet in readiness checks. Add an aggregate diagnostic, but retain individual emergency switches. |
| F7 — client telemetry is thin | **Partially false/outdated.** Web live and web consult now have meaningful join/player/extension telemetry. Phone creator/listing/live telemetry remains thin. | Keep existing web events. Add phone backstage/start/end/reconnect/chat/moderation events and creator-studio actions. Do not duplicate event names with incompatible shapes. |
| F8 — no current local commercial state | **Confirmed for the inspected feature directories.** | If chat history or event drafts are cached later, namespace them with `AccountScope.id`/scoped storage from day one. |
| F9 — Stream and payment idempotency foundations are strong | **Confirmed from the inspected code.** | Preserve raw-body verification, provider-event dedupe, checkout operation IDs, and entitlement uniqueness. Add explicit tests around them rather than replacing them. |
| F10 — historic staging schema drift | **Not independently verifiable from the current tree.** Fresh remote D1 access failed because the local OAuth account does not match the configured Cloudflare account. | Before migrations or a staging test, compare `PRAGMA table_info` and migration ledger in both environments through the wrapper. Do not add a listing-status `CHECK` until live values are inventoried and backfilled. |
| F11 — `/j/<token>` has no web page | **Confirmed.** Android can claim `/j/`, and the phone can resolve it, but a browser without the app has no Astro route. | Add a web resolver/redirect before changing old email infrastructure so historic links work without the app. Do not expose provider credentials in the resulting URL. |

## 21.5 Canonical state model after review

Listing state and poster state are separate.

### Listing status

```text
draft
  -> pending_review
      -> draft             (changes requested; reason stored in review decision/history)
      -> rejected          (terminal until creator chooses to revise into draft)
      -> approved
          -> published
              -> live
              -> completed
              -> cancelled
              -> unpublished
```

`expired` is initially a **derived presentation condition**, not a stored listing status:

```text
is_expired = scheduled occurrence ended OR expires_at <= now
```

If future queries require materializing expiry, specify the operational need and transition rules separately. Do not mix automatic time expiry into the approval enum casually.

### Poster status

```text
none -> generating -> draft -> approved
                    -> rejected -> generating
                    -> failed   -> generating
```

### Decision/audit records

Do not overload `listings.status` with every reviewer action. Store an immutable transition/decision row containing:

- listing id;
- actor uid and role;
- action;
- previous and next listing status;
- previous and next poster status where applicable;
- required reason/feedback;
- listing content version and poster version;
- idempotency key;
- created timestamp.

The audit write must be in the same reliable operation as the state change or fail closed. The current best-effort `try/catch` audit is not sufficient for approvals, rejections, publishing, unpublishing, cancellations, or refunds.

## 21.6 New finding: entitlement completion is missing

This is not called out in the second-reviewer audit and must be added to the delivery plan.

The commercial entitlement schema permits:

```text
reserved -> held -> active -> consumed
```

The inspected code creates entitlements, promotes them to `active`, and can change them to `refunded`. A repository-wide search found no production update that sets a commercial entitlement to `consumed`.

Consequences:

- paid attendees can submit reviews because the current gate accepts any entitlement, but the review is not marked verified;
- after eligibility is tightened to `consumed`, nobody will be able to review unless completion is implemented first;
- creator repeat-buyer metrics query only `consumed` entitlements and therefore remain zero/incomplete;
- entitlement state does not truthfully reflect completed delivery.

Required fix:

1. On an authoritative ended/reconciled event, close attendance intervals.
2. During successful settlement—or a dedicated idempotent completion step—set each delivered buyer/viewer entitlement to `consumed` using provider-attendance evidence and the agreed minimum-connected rule.
3. Leave no-show entitlements in an explicit terminal state appropriate to policy; do not call them consumed merely because money settled.
4. Refunded entitlements remain `refunded` and cannot review.
5. Store the terminal evidence/event id so replay cannot change the outcome twice.
6. Update review eligibility and creator statistics only after this transition exists.

This is a **P0/P1 boundary issue**: it does not stop video playback, but it blocks trustworthy reviews, completion semantics, and analytics.

## 21.7 Assessment of suggestions S1–S10

| Suggestion | Decision |
|---|---|
| S1 state/history migration | **Adopt with §21.5 corrections.** Poster stays separate; expiry stays derived initially. Inventory live status values before a constraint. |
| S2 server publish gate | **Adopt, but use a fail-safe rollout.** A permanent approval flag should default true if retained. If temporarily overridden during migration, record and remove the override after compatible web/app clients ship. A KV reset must not reopen direct publishing. |
| S3 host no-show sweep | **Adopt as P0 before any real-money test.** Include per-order idempotent refunds, terminal events, notifications, and health alarms. |
| S4 wallet-only first test | **Split into two milestones.** First run a no-real-money token/escrow integration test. Then run a separately authorized external-provider sandbox/real-money test after the provider is chosen and configured. Do not describe the first as proof that payments work. |
| S5 chat transport | **Resolved by owner: GetStream Chat SDK is the canonical commercial chat authority.** Use GetStream Chat capabilities for web and phone commercial livestream chat, reactions, moderation, rate limits, reporting, blocking/muting, and reconnect/history policy. Reuse legacy live widgets only as presentation; do not reuse the legacy live-room WebSocket. Verify the required GetStream Chat SDKs, channel model, region, retention, permissions, and cost before broad release. |
| S6 URL helpers and conditional redirects | **Adopt.** Add one URL builder per runtime and contract tests using the same cases. Keep legacy redirects observable. `/j` must resolve in browser as well as app. |
| S7 phone shell rewire/class rename | **Adopt concept, change verification instruction.** Rewire all three importers and rename/remove the duplicate carefully. Do not run local `flutter analyze` under the present repository rules; use CI. |
| S8 review completion/invitation | **Adopt only after entitlement completion exists.** Trigger the invitation from authoritative completion/settlement, and use the commercial email outbox for email delivery. |
| S9 telemetry catalogue and ship manifest | **Adopt.** These files and enforcement exist. Add issue entries when implementation issues are created, not speculative placeholders with no matching code. |
| S10 divide ownership with Flowpipe | **Adopt.** Flowpipe owns listing creation through public booking entry. This document owns checkout, sessions, settlement, reviews, communications, consolidation, and deletion. §21.5 is the canonical shared state definition unless Flowpipe is updated to point to one shared section. |

## 21.8 Assessment of the proposed admin screens (§19)

The requested Overview and Listings screens are sensible. The backend authorization, overview, analytics proxy, listing actions, money routes, audit table, dashboard layout, components, and historical UI are reusable.

Corrections and guardrails:

- `[ADMIN-RESET-1]` was an intentional deletion. Recover individual files as reference; do not revert the commit or restore the entire console verbatim.
- Start with a minimal new `AdminGate` and typed client. Historical versions can supply patterns, but their stale product names, token wording, assumptions, and navigation should not return unchanged.
- The server remains the security boundary. A hidden nav link is not access control.
- Do not make admin audit best-effort. Approval and money mutations must fail closed if their durable audit record cannot be written.
- Do not expose disabled placeholder links. Showing disabled counts is acceptable.
- Poster generation needs a version/attempt id, queue idempotency, stale-result protection, failure retry, and moderation status—not just five-second polling.
- A public preview should reuse data contracts and presentation primitives, but embedding an Astro component directly inside a React drawer may not be mechanically possible. Reuse a shared renderable component or create a read-only preview page/frame rather than duplicate business rules.
- Admin overview money labels must distinguish test tokens from real money. Showing `₹` while `walletRealMoney=false` can falsely imply real escrow.
- Restoring a CDN-loaded Chart.js implementation creates a runtime third-party dependency. Prefer the existing project approach only after CSP/privacy/offline behavior is checked; simple SVG sparklines may be smaller and safer.
- The claimed 1,200–1,500-line estimate is not an acceptance criterion and should not drive architecture.
- All local compile/build commands in §19 must be replaced with the repository's approved GitHub Actions verification.

## 21.9 Assessment of browser-only attendance (§20)

The product decision is sound: buyers should be able to purchase and attend without installing the app. The code supports much of it, but “works today” is too strong without an end-to-end run.

### Confirmed implemented

- `/live/<listing>` renders a public poster gate and opens email-code authentication only after Join is tapped.
- `/live` requests a server-authorized GetStream viewer handoff.
- `/session/<booking>` supports email-code authentication, server-derived creator/buyer role, prejoin device checks, and GetStream joining.
- The live viewer has GetStream reconnect-state handling, a 15-second stuck warning, manual retry, rejoin after leaving, and player-state telemetry.
- Android App Links already claim `/session`; `/j` and `/l` are also registered.
- Phone share currently uses `/l/<listing>`, which is appropriate as the lifelong public link if that page changes its CTA according to server state.

### Still unproven or missing

- No current internal generator sends commercial users to `/live` or `/session` consistently.
- No browser `/j/<token>` page exists.
- Dart does not parse `/live/<listing>` or path-form `/session/<booking>`.
- iOS universal-link association was not verified in this pass.
- Wrong-email recovery is missing and can steer a legitimate buyer toward a second purchase.
- Commercial confirmation/reminder/review emails are missing.
- Autoplay/audio behavior needs real iOS Safari and Android Chrome testing.
- Web live chat remains ephemeral and unmoderated.
- The post-event screen does not yet combine outcome, receipt, and review action.
- Browser attendance has not been demonstrated in current production telemetry.

Therefore label browser attendance **implemented in substantial parts, not end-to-end verified**.

### One-link clarification

Use `/l/<listing>` as the public/share link that remains meaningful throughout the listing lifecycle. Use `/live/<listing>` as the direct livestream room link in a paid entitlement confirmation/reminder. For consultations, use `/session/<booking>` because the booking identifies the private occurrence.

This avoids an unnecessary conflict in §20's wording: there can be one stable link per purpose without pretending a public marketing listing URL and a private occurrence room URL are the same resource.

## 21.10 Updated deletion inventory

### Delete after direct rewiring and CI verification

- `web/src/islands/dashboard/MyListingsPanel.tsx`, if a fresh import/build graph confirms no dynamic reference.
- `app/lib/features/marketplace/my_listings_screen.dart`, after shell v1, shell v2 and `marketplace_hub.dart` point to the richer studio and its useful archive/renew behavior is retained.
- phone commercial checkout presentation/API code that initiates payment, after every phone entry point is converted to a secure web handoff and the read-only-money pivot is fully implemented.
- redundant user-facing portions of `commercial_getstream_screens.dart`, after consult dependencies, shared controls, test seams, and `commercial_consult_screens.dart` are mapped.

### Deprecate, instrument, then delete

- `/watch/<id>`, `web/src/islands/live/*`, old phone AvaLive host/viewer networking;
- `/consult/<booking>`, `web/src/islands/consult/*`;
- old `/j/<token>` behavior after a compatibility resolver exists;
- legacy feature flags and Cloudflare media bindings only after no surviving non-commercial product uses them.

### Preserve/rehome before deletion

- transport-neutral widgets in `live_room_widgets.dart`;
- useful slow-mode/moderation/reaction presentation from legacy web live chat;
- `commercial_consult_screens.dart`, which owns phone consult prejoin/reconnect behavior;
- `commercial_getstream_gateway.dart` and GetStream token/handoff infrastructure;
- queue, Brevo, Clerk email lookup, and ICS primitives;
- idempotency, webhook validation, settlement, claims, receipt, and review infrastructure;
- selectively useful historical admin gate/API/card code.

### Additional deletion rule

Removing a client or route is not enough. Each deletion issue must also examine:

- tests and fixtures;
- feature flags and defaults;
- Worker routes and imports;
- Durable Object bindings/migrations;
- Android/iOS links;
- emails, pushes, calendar URLs, and share sheets;
- telemetry catalogue and dashboards;
- specifications and comments that still describe the removed lane.

## 21.11 Revised shortest safe path

1. Fix Cloudflare operator authentication so authorized agents can perform read-only schema/secret verification against the correct account.
2. Build the host-no-show terminal sweep and idempotent full-refund path; add alarms for overdue scheduled/backstage sessions.
3. Implement entitlement terminal transitions, including `consumed`, and fix paid-review eligibility.
4. Define shared canonical URL helpers, correct all six known wrong web links, add browser `/j` compatibility, and support `/live/<id>` plus `/session/<id>` in phone deep links.
5. Rewire shell v2, shell v1, and Marketplace Hub to the richer phone creator studio.
6. Add the creator submission endpoint and state history, then build the minimal new admin Overview/Listings UI and enforce listing+poster approval server-side.
7. Move all money initiation out of the phone and provide a secure continue-on-web handoff.
8. Wire idempotent commercial emails: confirmation, reminders, cancellation/refund, settlement, and review invitation.
9. Run a two-account, no-real-money wallet-token test: web buyer, phone host, browser viewer, staggered join, reconnect, completion, settlement, and review.
10. Select/configure one external payment rail and run a separately authorized provider test.
11. Choose and implement the moderated chat authority; reuse the old UI widgets as presentation.
12. Implement partial refunds and evidence-backed connectivity claims.
13. Instrument legacy routes, observe them, then remove verified dead code in separate commits.

## 21.12 Revised blockers for the first trustworthy test

### P0 — must fix first

- host-no-show sessions can remain scheduled and keep buyer money held indefinitely;
- creator publishing bypasses admin approval and is the only complete client path;
- no admin web UI currently exists;
- canonical commercial room links are not generated by current surfaces;
- phone navigation exposes the wrong creator-listing screen;
- operator Cloudflare credentials currently target the wrong account, preventing reliable prod/staging verification.

### P1 — required for a trustworthy completed lifecycle

- entitlements never transition to `consumed`;
- paid review eligibility accepts refunded/unconsumed entitlements;
- commercial email and email idempotency are missing;
- current phone money initiation contradicts the web-only-money product decision;
- GetStream region cannot be proved from code and must be verified in its dashboard;
- external payment availability remains unproven.

### P2 — required before broad audience use

- moderated, durable or policy-defined commercial chat/reactions;
- partial refunds and connectivity evidence;
- wrong-email recovery;
- iOS/Android browser and App Link matrix;
- admin settlement/refund exception screens;
- legacy-route traffic measurement and dead-code deletion.

---

# 22. Third-pass audit of §21 (Claude, 2026-09-03)

Re-checked every factual claim in §21 against the tree at `3d572e09` and a fresh cache-busted `/api/config`. Same limits as §18: read-only, no deploy, no flag, no build.

## 22.1 Where §21 is right and I was wrong — accepted

| §21 claim | Verdict | Correction to my earlier notes |
|---|---|---|
| 21.2 #3 — web live **does** have reconnect handling | **Correct.** `LiveStage.tsx:42` `RECONNECT_STUCK_MS = 15_000`, `:61-62` `RECONNECTING/MIGRATING/RECONNECTING_FAILED/OFFLINE` states, `:87-90` stuck timer, manual retry via `onRetry` (`LiveGsViewer.tsx:210,457`). | §20.4 row "Reconnect on the web live page — none" is **withdrawn**. What is missing is narrower: no *automatic* rejoin after `RECONNECTING_FAILED` (it waits for the tap), and no reconnect telemetry beyond `live_player_state`. |
| 21.2 #4 — web consult **does** emit telemetry | **Correct.** `ConsultRoomGS.tsx:113,121` `consult_prejoin`, `:151,192,201` `consult_join_result`, `:200` `gs_sdk_error`, `:230` `consult_end`; `ExtendPanel.tsx:84,96,125` extension events. | F7's "web `consult-gs/*`: zero `capture()` calls" is **withdrawn** — my sub-search missed them. F7 stands only for the **phone** (`commercial_getstream`: one event; `features/listings/my_listings_screen.dart`: zero). |
| 21.6 — entitlements never reach `consumed` | **Correct and important.** Repository-wide, `state='consumed'` appears only in **reads**: `reviews.ts:105` (badge), `creator_stats.ts:174` (repeat-buyer metric), and the accept-lists at `commercial_checkout.ts:789,878`. No `UPDATE … SET state='consumed'` exists anywhere. | Adopted into the plan (22.4 step 3). My S8 ("eligibility = `consumed` only") would have made reviews impossible without this — §21 is right to sequence completion first. |
| 21.2 #1 — `expired` is not a stored status | **Correct.** Zero occurrences of `'expired'` in `listings.ts`; `isExpired` is derived on the client (`core/listings_api.dart:513`). Note this was the **original** §4.3's addition, not §18's. | Agree: derived, not stored. |
| 21.2 #5 — wallet-token test ≠ paid-payment test | **Correct.** Two milestones. | Adopted; wording in 18.4 step 5 and 20.7 should read "no-real-money integration test". |
| 21.4 F3/F4 — poster reject accepts empty feedback; audit is best-effort | **Correct.** `admin_listings.ts:58` `String(body.feedback \|\| "")`; `:78-82` `try { … } catch {}`. | Make both server-enforced (already in 19.5 A3; add "non-empty" to the rule). |
| 21.9 — `/l/<listing>` is the share link today | **Correct.** `share_live_event_sheet.dart:47` `https://avatok.ai/l/$listingId`. Android already claims `/j/`, `/session`, `/l/`, `/a/`, `/i/`, `/add` (`AndroidManifest.xml:212-256`); **`/live/` is not claimed**. | Accept the one-link-per-purpose split: `/l/<id>` = public/share (CTA must be state-aware), `/live/<id>` = room link in paid confirmations/reminders, `/session/<booking>` = private 1:1. Add `/live/` to the manifest; `pathPrefix="/session"` already covers the path form, so only the Dart parser needs the change (D10). |
| 21.3 D11 — do not delete the `"cashfree"` default blindly | **Correct.** `routes/cashfree.ts:255-266` calls `provisionFromGatewayPurchase` **without** `gateway:` and relies on the default; `routes/pay.ts:21-24` passes `gateway: adapter.id` explicitly. | S4 amended: make `cashfree.ts` pass `gateway: "cashfree"` explicitly in the same commit that removes the default. |

## 22.2 Where §21 is wrong — rejected, with evidence

| §21 claim | Verdict | Evidence |
|---|---|---|
| 21.2 #8 / 21.7 S7 / 21.8 last bullet — "local `flutter analyze` / `tsc` conflict with the repository rule that local build/compile tools must not be run; verification belongs in GitHub Actions" | **Wrong — this is the stale-rule trap CLAUDE.md explicitly warns about.** | `CLAUDE.md:978` "✅ THE LOCAL BUILD TOOLCHAIN IS BACK — YOU CAN BUILD AND HOT RELOAD (verified 2026-08-27)" and, in the same section: *"The 2026-08-05 'toolchain deleted, do not install one' rule … is DEAD … Do not assert the toolchain is missing. Run `flutter doctor` and look."* It then mandates `flutter analyze` **before every commit that touches `app/`** and `npx tsc --noEmit` in `worker/` **before every deploy** (flags section, item 0). §21's instruction would reintroduce the 40–80-minute CI round-trip as the first place a type error is found — the exact failure CLAUDE.md records. **Keep the local checks in §18.3 S7, §19.7, §19.5.** CI remains the authority; local analysis is the cheap net in front of it. |
| 21.12 P0 — "operator Cloudflare credentials currently target the wrong account, preventing reliable prod/staging verification" | **Not a product blocker; an operator-environment note, and possibly a rule breach.** | The live prod config was read successfully three times today via the public `/api/config` (§18, §22). D1/secret reads are the only thing blocked, and CLAUDE.md forbids invoking `wrangler` directly at all — reads go through `scripts/cf.sh` (which selects the account from `.avatok-target`). If §21's errors `7403`/`10000` came from bare `wrangler`, the fix is to use the wrapper, not to add a P0. Moved to 22.4 "operator prerequisites", off the P0 list. |
| 21.8 — "embedding an Astro component directly inside a React drawer may not be mechanically possible" | **Correct as stated but the conclusion is easy:** `ListingTile.tsx` is already React; the details view is `.astro`. | Preview pane = `ListingTile` (React, direct) + an `<iframe src="/l/<id>?preview=1">` for the details page. No duplicated business rules, no new renderer. |
| 21.8 — Chart.js from cdnjs "creates a runtime third-party dependency; check CSP" | **Half right.** There is no CSP on the site today (`web/public/_headers` and `astro.config.mjs` define none), so nothing blocks it — but §21's point that a 200 KB runtime script for four sparklines is disproportionate stands. | Use inline SVG sparklines (≈30 lines). Drop the Chart.js loader when restoring `AnalyticsCards.tsx`. |

## 22.3 New findings from this pass

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| G1 | **KYC is switched OFF for publishing in production.** | `listingPublishKycRequired` DEFAULTS `true` (`config.ts:2099`) but the live override is **`false`** (cache-busted `/api/config`, 2026-09-03, also listed by §21.1). | Combined with D3 (creator publish bypass), **any account can publish a paid listing today with no KYC and no admin approval.** The approval gate (S2) is therefore also the KYC gate until this override is lifted; mention both in the Phase B exit condition. Do not flip the flag without the owner — it is a prod write. |
| G2 | §21.5's state model and this document's §4.3 still **both** exist in the file; the Flowpipe spec has a third copy. | §4.3 (lines ~113–137), §21.5, `MARKETPLACE-FLOWPIPE-SPEC-2026-09-03.md` §3. | Three state tables in two files is how two agents build two machines (S10). **Editorial action:** replace §4.3's diagram with "see §21.5", and add a one-line pointer from Flowpipe §3 to §21.5. |
| G3 | §21.11 step 1 ("fix Cloudflare operator authentication") is ahead of the no-show sweep. | See 22.2 row 2. | Reorder: the sweep is a code change verifiable in CI and staging via `scripts/cf.sh`; nothing about it waits on the operator's wrangler login. |
| G4 | §21.3 D9 says "inventory free/non-commercial dependencies" as an open task. | Done in §18 D9: `avalive_discovery.dart:56-67,113-115`, `explore/listing_detail.dart:273,292`, `consult/prejoin_screen.dart:90` are the complete constructor list for the legacy screens. | No further inventory needed; proceed to the explicit `legacyAvaLiveEnabled=false` guard. |

## 22.4 Consolidated plan (supersedes 18.4, 20.7 and 21.11 where they differ)

**Operator prerequisites (not blockers):** run reads through `scripts/cf.sh`, never bare `wrangler`; confirm `POSTHOG_PERSONAL_API_KEY` is set for the admin analytics proxy; confirm GetStream region in the dashboard.

1. **Host-no-show terminal sweep** + idempotent full refund + overdue alarm (P0, worker, staging then prod migration).
2. **Entitlement completion** — write `consumed` from authoritative end/settlement with attendance evidence; no-show/refunded stay terminal; then tighten paid-review eligibility to `consumed` (§21.6).
3. **Canonical URL helpers** (one per runtime) + six-site rewrite + browser `/j/<token>` resolver + `/live/` App Link + Dart path parsing for `/live/<id>` and `/session/<id>`. Conditional 302s from `/watch` and `/consult`.
4. **Phone creator-studio rewire** — shell v2 first (it is live), then shell v1 and `marketplace_hub.dart`; rename the duplicate class; `flutter analyze` locally, CI as authority.
5. **Submission endpoint + `listing_status_history`** (fail-closed audit, reason required, poster feedback non-empty) → **server publish gate** (approval **and**, while `listingPublishKycRequired=false` in prod, the only KYC gate) → typed `409 approval_required` for old clients.
6. **Admin Overview + Listings** (§19, with §21.8 guardrails: no wholesale console restore, SVG sparklines, iframe preview, "test tokens" label while `walletRealMoney=false`, disabled placeholders not links).
7. **Async poster** with version/attempt id and stale-result protection; promote to `cover_media` only on approval, under the creator namespace.
8. **Phone money → read-only** with a secure continue-on-web handoff; phone checkout becomes a deletion candidate.
9. **Commercial email outbox** (dedupe table) + confirmation / reminders / cancellation-refund / settlement / review-invite templates carrying the canonical links.
10. **Milestone A — no-real-money integration test**: web buyer (browser, no app), phone host, second browser viewer, staggered join, reconnect, end, settlement, `consumed`, review. Evidence = the §13 id list from PostHog.
11. **Provider decision (owner) → Milestone B — separately authorised real-money test.**
12. Implement commercial chat with the GetStream Chat SDK as the authoritative transport/channel, then partial refunds + evidence claims → legacy-route measurement → deletion gate (§11).

## 22.5 Owner decision: commercial chat authority (2026-09-03)

The owner has resolved the open S5 decision: **GetStream Chat SDK is the canonical transport and server-authoritative chat system for commercial livestreams on both web and phone.**

Implementation requirements:

- Use GetStream Chat channels associated with the server-authorized commercial session/listing; clients must not choose privileged roles or bypass server authorization.
- Use GetStream Chat for chat, reactions, moderation, rate limiting, reporting, blocking/muting, reconnect behavior, and the defined message/history policy.
- Keep the old AvaLive widgets only as transport-neutral presentation where useful; do not reconnect the legacy room WebSocket.
- Preserve per-account scoping for any phone-side cache or draft state.
- Confirm GetStream Chat SDK availability, channel permissions, region/data-retention behavior, and costs during staging verification before production promotion.

## 22.6 Status of this document

Sections 18–22 are audit layers on the original §§1–17 and now disagree with it in places (state machine, admin UI, reuse of `cal/emails.ts`, phone checkout). Before implementation issues are cut, someone should fold the accepted corrections back into §§4–12 and delete the superseded text, so an implementer reads one plan, not four. Until then, precedence is: **§22 > §21 > §18 > §§1–17**, and CLAUDE.md over all of them.

---

# 23. Final audit reconciliation (Codex, 2026-09-03)

This section resolves the third-pass review in §22. It is the implementation-facing authority for this document. The earlier sections remain an audit trail showing how the conclusions were reached.

## 23.1 Accepted from §22

The following third-pass conclusions are correct and adopted:

- web livestream reconnect handling already exists; only failed-reconnect automation and richer reconnect telemetry remain;
- web consultation telemetry already exists;
- commercial entitlements never transition to `consumed` and must do so before review eligibility is tightened;
- expiry is derived today and should not become a listing status in this project;
- wallet-token testing and real-payment testing are separate milestones;
- reject-poster feedback and reject-listing reasons must be non-empty and server-enforced;
- `/l/<id>` is the public/share URL, `/live/<id>` is the direct livestream room URL, and `/session/<booking>` is the private consultation URL;
- Android must add `/live/` App Link handling and Dart must parse path-form `/live/<id>` and `/session/<id>`;
- `routes/cashfree.ts` must pass `gateway: "cashfree"` explicitly before the generic Cashfree default is removed;
- inline SVG is preferable to restoring the old runtime Chart.js loader;
- production `listingPublishKycRequired=false` is confirmed by the live public configuration and is a serious launch condition;
- the state-machine duplication across the original spec, §21 and the Flowpipe document must be resolved before parallel implementation;
- the legacy AvaLive constructor inventory in §18 D9 is sufficient to begin a guarded migration; repeat it immediately before deletion to catch intervening changes.

## 23.2 Corrections to §22

### A. Local verification rule

Section 22 says local `flutter analyze` and TypeScript compilation must be run because `CLAUDE.md` restored the toolchain. That conflicts with the current root `AGENTS.md` instruction supplied for this repository:

> **No local build tools. Do NOT attempt builds, compiles, or local verification (`npm build`, `flutter build`, `flutter analyze`, etc.). All builds run in GitHub Actions.**

`AGENTS.md` is the active repository instruction for this task. Therefore:

- do not run local `flutter analyze`, Flutter builds, npm builds, or TypeScript compilation as part of this project;
- use static inspection locally;
- use the approved GitHub Actions workflows for compile/build verification;
- do not trigger a workflow unless the owner explicitly asks for a build.

If the owner later changes `AGENTS.md`, the newer explicit rule wins. Until then, §22.2's rejection of §21 on this point is itself rejected.

### B. Cloudflare operator authentication

Section 22 speculates that the failed D1/secret reads may have used bare Wrangler. They did not. Both commands used the mandatory wrapper:

```text
ALLOW_PROD=1 scripts/cf.sh worker d1 execute ... --remote
ALLOW_PROD=1 scripts/cf.sh worker secret list
```

The wrapper resolved production correctly. Wrangler then reported that the target account in `wrangler.toml` was not accessible by the currently logged-in OAuth account.

This is not a running-product defect, but it is a **release-operations blocker** for:

- verifying production/staging schemas;
- verifying secret names;
- applying migrations;
- deploying the Worker through the approved wrapper;
- completing an evidence-backed release audit.

It does not need to precede writing code, but it must be fixed before any environment migration, deploy, or final readiness declaration.

### C. Admin preview cannot use the public page directly

Section 22 proposes an iframe to `/l/<id>?preview=1`. This does not work by itself: public listing reads intentionally expose only `published`/`live` rows. A pending or approved-but-unpublished listing will return the non-public result before the iframe can render it.

Use one of these secure designs:

1. preferred: a dedicated admin preview route that authenticates the admin server-side and renders from `GET /api/admin/listings/:id`;
2. acceptable: a short-lived, single-listing, read-only preview token minted for an authenticated admin and accepted only by the preview route;
3. React preview assembled from the same normalized `CardView`/listing primitives, with contract tests proving parity.

Never make a draft publicly readable merely because `?preview=1` is present. Query parameters are not authorization.

### D. Admin approval is not KYC

Section 22 says the approval gate becomes the KYC gate while `listingPublishKycRequired=false`. That is not a sufficient security model. An admin clicking Approve does not prove the Worker checked a valid identity record.

Before real money is enabled, the final server-side publish transition for a commercial listing must independently enforce:

- recorded listing approval;
- approved poster;
- required creator KYC/liveness status;
- publishable commercial configuration;
- valid schedule, policy, capacity and price;
- durable audit write.

The UI should display KYC state, but the Worker must enforce it. Restoring `listingPublishKycRequired` is a separate explicit production flag decision and must not be performed without owner authorization.

## 23.3 Final severity classification

### P0 — blocks accepting real money

1. Host no-show has no terminal sweep, allowing sessions and buyer holds to remain open indefinitely.
2. Creators can directly publish commercial listings without admin or poster approval.
3. Commercial publish KYC enforcement is disabled in production.
4. No admin web UI currently exists for the intended review pipeline.
5. Current CTAs and generated links still route commercial buyers into legacy media lanes.
6. No external payment provider is currently proven available end to end.

### P1 — blocks a trustworthy completed event

1. Entitlements never become `consumed`.
2. Paid review eligibility accepts any entitlement, including refunded/unconsumed rows.
3. Commercial confirmation/reminder/outcome emails and email deduplication are absent.
4. Phone payment initiation contradicts the owner-approved web-only money model.
5. Phone main navigation opens the old creator listings screen.
6. GetStream Mumbai-region configuration is not provable from source and must be checked in the provider dashboard.
7. Cloudflare operator authentication must be corrected before schema verification, migration or deployment.

### P2 — required before broad public use

1. Moderated commercial chat and reactions across browser and phone.
2. Partial refunds and evidence-backed connectivity claims.
3. Wrong-email recovery without encouraging duplicate purchase.
4. Android/iOS App Link and browser matrix testing.
5. Admin settlement/refund exception handling.
6. Legacy traffic measurement and dead-code removal.

## 23.4 Final implementation order

1. Implement the host-no-show terminal sweep, idempotent full refunds, and overdue-session alarms.
2. Implement entitlement completion to `consumed`; then require `consumed` for paid reviews and repair creator repeat-buyer statistics.
3. Create canonical URL helpers for web, Worker/email, and phone; fix all current link generators; add `/j` browser compatibility and App Link/deep-link handling.
4. Rewire shell v2, shell v1, and Marketplace Hub to the richer creator studio.
5. Add creator Submit for review, immutable listing transition history, mandatory reasons, and fail-closed audit writes.
6. Build the minimal new Admin Overview and Listings screens using selective historical reuse—not a wholesale console restoration.
7. Enforce final publish server-side: KYC, listing approval, poster approval, listing validity, and durable audit.
8. Move money initiation out of the app and add a secure Continue on web handoff.
9. Queue poster generation with attempt/version protection, moderation, creator/listing ownership, and promotion to `cover_media` only after approval.
10. Add the commercial email outbox and canonical confirmation, reminder, refund, settlement, and review templates.
11. After operator authentication is corrected, verify staging/prod schema and provider secret names through `scripts/cf.sh`.
12. When explicitly authorized to build, run the no-real-money two-account integration test through CI-produced artifacts: web buyer, phone host, browser viewer, staggered join, reconnect, end, settlement, consumed entitlement, and review.
13. Obtain an owner decision on the external payment rail, configure it deliberately, and run a separately authorized payment-provider test.
14. Select the chat authority, implement moderation/reactions, then add partial refunds and connectivity claims.
15. Instrument legacy routes, observe them, and delete dead code in separate scoped commits.

## 23.5 Final deletion decisions

### Planned deletion after rewiring

- `web/src/islands/dashboard/MyListingsPanel.tsx`;
- `app/lib/features/marketplace/my_listings_screen.dart` after preserving needed archive/renew behavior;
- phone checkout code that initiates money movement, after all callers use the secure web handoff;
- redundant user-facing room UI in `commercial_getstream_screens.dart` after its infrastructure/test responsibilities are extracted.

### Conditional deletion after telemetry and compatibility period

- `/watch/<id>` and `web/src/islands/live/*`;
- `/consult/<booking>` and `web/src/islands/consult/*`;
- old phone AvaLive networking/host/viewer screens;
- legacy `/j` behavior;
- unused media flags, bindings and tests.

### Must be retained or moved before deletion

- transport-neutral AvaLive overlay widgets;
- useful slow-mode, moderation and reaction presentation;
- commercial GetStream handoff/gateway/token code;
- `commercial_consult_screens.dart` reconnect/prejoin behavior;
- queue, Brevo, Clerk email lookup and ICS primitives;
- webhook verification, idempotency, ledger, lifecycle, claims, receipts and reviews;
- selectively useful historical admin patterns.

No deletion may occur in the same change that first reroutes production traffic. Each deletion requires a fresh import/route/flag/binding/link/test search and telemetry evidence that the compatibility path is no longer required.

## 23.6 Document precedence

For implementation decisions in this file:

```text
current system/developer instructions
  > current repository AGENTS.md
  > explicit newer owner decisions
  > §23 final reconciliation
  > §22 third-pass notes
  > §21 independent audit
  > §18 second-reviewer audit
  > §§1–17 original draft
```

The sibling Flowpipe spec owns listing creation through public booking entry. This document owns commercial checkout, GetStream sessions, settlement, communications, reviews, consolidation, and deletion. Before implementation is split across agents, Flowpipe should replace its independent state table with a pointer to §21.5/§23.3–23.4 so there is only one implementation model.
