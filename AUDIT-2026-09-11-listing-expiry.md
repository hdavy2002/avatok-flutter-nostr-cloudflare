# Listing expiry audit (2026-09-11)

**Trigger:** "Cooking with Davy" (avatok.ai/avatok_team/cooking-with-davy) was set for Tue 8 Sept 2026, 2:42 AM IST. On 11 Sept it is still in the web marketplace and the app, its page shows a 00:00:00:00 countdown, and **Book 1 seat · ₹118** still works.

**Bottom line:** there is no time-based expiry for live events or sessions anywhere: not in the server, the web or the app. A listing only leaves the marketplace when its status changes, and for a live event that only happens if the host actually went live and GetStream reported the stream ended.

This is a code audit, and every claim below cites a file and line. Production rows and flags were NOT checked. See "Not verified" at the end.

---

## Issue list

### P0: money / trust

**P0-1: Tickets can be bought for an event that is over**
- **Today:**
  - Live-event checkout checks status and schedule shape, but never checks `starts_at > now` (`worker/src/routes/commercial_checkout.ts:621-658`). Same gap in the gateway order route (`pay.ts:124`).
  - `provisionFromGatewayPurchase` doesn't even re-check status (`commercial_checkout.ts:1385-1405`).
  - The buyer then can't join: the join route returns 410 after end + 15 min (`commercial_stream_sessions.ts:312-320, 380-382`).
  - If the buyer cancels, it counts as a *late* cancel (`commercial_lifecycle.ts:225-232`).
  - Consults are already guarded (`commercial_checkout.ts:676`, `pay.ts:161`). The old `bookListing` guard (`listings.ts:4116`) is not on the path in use.
- **Fix:** one shared `isBookable(listing, slot, now)` check used by checkout, pay-order and gateway provisioning. Return 410 `event_ended` for past events. The server fix also protects old app builds.

**P0-2: Host no-show can leave buyers' money held forever**
- **Today:** the no-show refund sweep only looks at `commercial_sessions` rows (`commercial_settlement.ts:123-139, 702-723`). A row is only created when someone opens the room (`commercial_stream_sessions.ts:441-455`).
  - If nobody ever joined, there is no row, so no refund and no payout, and the money stays held indefinitely.
  - If a row exists, the refund is automatic only when `creator_cancel_refund_pct == 100`; otherwise it goes to manual review (`commercial_settlement.ts:585-599`).
- **Fix:** drive the sweep from overdue ticket/order rows (`starts_at` + grace), not from session rows.

**P0-3: Past events never leave the marketplace, search, sitemap or creator page**
- **Today:** every public query filters `status IN ('published','live') AND (expires_at IS NULL OR expires_at > now)` (`listings.ts:3386-3390, 3471, 3586`, `sitemap.ts:24-27`).
  - `expires_at` is only set for classifieds (`listing_billing.ts:543`, `listings.ts:2710`). Live events and consults are published by `cal/listing_reservations.ts:123` with `expires_at` NULL, so they pass the filter forever.
  - The 5-minute scheduled job (`wrangler.toml:22`, `index.ts:407-455`) has no listing-expiry task.
  - The only automatic move to `completed` is live → completed after GetStream confirms (`listing_transitions.ts:149-150`).
- **Fix:**
  - (a) Add a scheduled task that moves published events whose end + grace has passed to `completed` (or a new `expired` status with a transition rule), reusing `systemMarkListingCompleted` (`listings.ts:3003`).
  - (b) Also add an end-time condition to the queries, so a listing disappears the moment it ends, not up to 5 min later.

### P1: what users see

**P1-4: Public link for a past / ended / cancelled event**
- **Today:**
  - *Past but still "published"*: the page shows "NEXT SHOW: TUE 8 SEPT", a countdown stuck at zero (`web/src/components/ListingDetailsComp.astro:934-937, 1264`), the calendar opened on the past date (`:901`), a fake slot built from `starts_at` with no date check (`:357-373`), and a live Book button (`:929, :990`).
  - *Completed or cancelled*: the API returns 404 to non-owners (`listings.ts:3631-3633`) and the page prints plain "Listing not found" (`web/src/pages/[username]/[slug].astro:34`).
- **Should:**
  - The link always opens.
  - Ended: "This event has ended", no booking card, plus the host's upcoming listings and a Follow button.
  - Cancelled: "This event was cancelled", with the refund status for ticket holders.
  - Live now: a Join / Watch state.
  - Future dates on the calendar: show only those dates.
- **Fix:** let `getListing` return completed / expired / cancelled listings publicly with a `state` field (`upcoming | starting | live | ended | cancelled | sold_out`). Drive the whole page and the booking card from that one field.

**P1-5: App has no expiry handling**
- **Today:** the listing detail is a native screen now (`app/lib/features/explore/listing_detail.dart:9-18` → `native_listing_detail_v2.dart`), not the web page.
  - It always shows "BOOK A SEAT" unless live (`native_listing_detail_v2.dart:159-163`).
  - Booking calls checkout with no time check (`native_listing_booking_flow.dart:269-274`).
  - `isExpired` only reads `expires_at` (`core/listings_api.dart:578`).
  - The feed adds no time filter (`marketplace_browse.dart:654-716`) and caches for 2–5 min.
- **Fix:** read the same server `state` field. Most of the effect comes free from P0-1 and P0-3 with **no app build**. The Ended screen itself needs an app build.

**P1-6: Event times saved in the phone's timezone, not the listing's** (likely cause of the odd 2:42 AM; not proven)
- **Today:**
  - The app wizard in use stores `DateTime.tryParse(text).millisecondsSinceEpoch` (`native_listing_wizard_screen.dart:167, :192`), which is phone-local and ignores `timezone` (default `Asia/Kolkata`). The newer draft code converts correctly (`listing_draft.dart:290-300`).
  - The web wizard's extra-slot picker uses browser time (`web/.../steps.tsx:597`).
  - The marketplace "More info" panel formats in browser time (`web/src/islands/listing/QuickInfo.tsx` `whenLabel`).
- **Fix:** always convert using the listing's timezone, and always print "IST".

**P1-7: Host can cancel or delete a listing with sold tickets and nobody is refunded**
- **Today:** cancel, status change and permanent delete release calendar holds but refund no one (`listings.ts:2943-2952, 3243-3294`).
- **Fix:** block when tickets are sold, or route each order through the creator-cancel refund.

**P1-8: Host has no "past event" state and can't simply add a new date**
- **Today:**
  - The dashboard keeps showing "Published" (`web/src/islands/dashboard/CreatorListings.tsx`, no time logic).
  - Moving a published event's date is refused: "cancel and re-create" (`listings.ts:1698`).
  - The only route is completed → restore to draft (`listing_transitions.ts:120, 129-130`) → review → publish.
- **Fix:** an "Ended" badge plus "Run it again / add new date" that keeps the listing, reviews and followers.

**P1-9: Multi-date / recurring live events sell the wrong date**
- **Today:**
  - The web slot picker sends `slot: null` for live events (`web/src/islands/.../SlotPicker.tsx:180-190`), so checkout always sells `listing.starts_at`.
  - Recurrence (`schedule_mode`, `recurrence_days`) is display-only.
  - The `listing_slots` table exists but `listingSlotsEnabled` defaults to `false` (`config.ts:2506`; the prod value is not checked).
- **Fix:** carry the chosen slot into checkout. Expiry should mean "no future slots left", not "`starts_at` passed". Recurring events should generate their next occurrence.

### P2: polish

**P2-10: Card pill and search data**
- **Today:** the card pill shows "8 SEPT" for a past date, and "TONIGHT <time>" for a time already gone today (`web/src/lib/card.ts:309-327`). Search structured data keeps a past `startDate` and `InStock` (`worker/.../og.ts:132-143`).
- **Fix:** show an ENDED pill (or hide the card), and mark ended events `EventCompleted` / `EventCancelled` in structured data.

**P2-11: No "starting now" state**
- **Today:** between start time and the host actually going live, the page shows zeros and a Book button.
- **Fix:** add a "Starting soon: host is getting ready" state with Join.

**P2-12: Stuck "live" and cache lag**
- **Today:** the Live-now rail trusts `status='live'` with no age check (`listings.ts:3490-3509`). Caches after a fix: listing page 60s + 5 min stale (`[slug].astro:36`), sitemap 1 h, app feed up to 5 min.
- **Fix:** add a max-age / heartbeat check on the live rail. The cache lag is acceptable once P0-3(b) is in.

---

## Scenario matrix (today)

| Scenario | Web marketplace | Web public link | App | Booking API |
|---|---|---|---|---|
| One-off live event, date passed, host never went live (**this case**) | Shown, pill "8 SEPT" | Countdown 00, past date, **Book works** | Shown, BOOK A SEAT | **Takes payment** |
| Start time reached, host not live yet | Shown | Zeros + Book | Book | Takes payment |
| Live right now | Live-now rail | LIVE, Join | BOOK & JOIN NOW | OK |
| Stream ended (GetStream confirmed) | Hidden | Bare "Listing not found" | 404 error | 404 |
| Cancelled | Hidden | Bare "Listing not found" | 404 | 404 |
| Future dates exist (slots on) | Shown | Future slots listed, **but live checkout ignores the choice** | Consult: OK | Consult OK / live sells `starts_at` |
| Recurring live event after first date | "DAILY 6 PM" pill | Stale past slot | Book | Sells stale date |
| On-request / always-on consult | OK | Empty calendar, "pick a date" | OK | Needs future slot ✔ |
| Sold out | SOLD OUT | HOUSEFULL, disabled | Not checked | Seat cap checked |
| Classified past `expires_at` | Hidden ✔ | Still opens by URL | "Expired" ✔ | n/a |

## Suggested order
1. **Server only, no app build:** P0-1 (stop selling), P0-3 (hide + auto-complete job), P0-2 (refund sweep). Together these fix web and app visibility and the money risk.
2. **Web:** P1-4 (ended / cancelled / live / starting states on the public link), P2-10, P1-8 host "Ended" + add date.
3. **App (next phone build):** P1-5 ended state, P1-6 timezone fix.
4. **Design decision needed:** P1-9 multi-date model, and what an ended link should promote.

## Not verified
- The production row for this listing, its orders and any session row.
- Prod values of `listingSlotsEnabled` and `commercialLiveCheckoutEnabled`.
- Whether the listing was created in the app or on the web (which would confirm the P1-6 cause).
