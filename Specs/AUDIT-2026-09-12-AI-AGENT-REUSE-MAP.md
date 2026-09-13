I have a complete picture. Report follows.

# avaTOK reuse map — "AI voice agent" listing type

All paths repo-relative to `/home/claude/avatok`. Line numbers from current tree (2026-09-12).

---

## 0. Headline finding before the details

**A near-complete AI-voice-agent product already exists twice, on a parallel rail — not as a listing.**

| Rail | Tables | Routes | DO/engine | Client |
|---|---|---|---|---|
| **AvaVoice** (voice-only AI agent, booked in minute slots, escrow + settle) | `worker/migrations/avavoice.sql` | `worker/src/routes/avavoice.ts` (829 L) | Gemini Live ephemeral token, no DO | `app/lib/features/avavoice/*`, no web UI |
| **AvaVision** (same + camera) | `worker/migrations/avavision.sql` | `worker/src/routes/avavision.ts` (1220 L) | Gemini Live + MediaPipe | `app/lib/features/avavision/*`, **web**: `web/src/islands/vision/*`, `web/src/pages/vision/*` |
| **Grok realtime voice agent** (PSTN/dialer lane) | — | `worker/src/routes/agent_voice_routes.ts` | `worker/src/do/agent_voice_room.ts` + `worker/src/lib/grok.ts` | app dialer |

And the **listing** side already reserves an agent slot:
- `worker/src/lib/listing_section.ts:23` `"ai_voice_agents"` is a live `Section` value; `:112` `if (k.startsWith("agent") || k === "ai_agent") return "ai_voice_agents";`
- `worker/src/lib/listing_section.ts:159-181` — `ai_voice_agents` is deliberately **absent** from `GROUP_FOR_SECTION`, so `groupFor()` returns `null` → "renders nowhere" (owner decision 2026-09-05).
- `worker/src/routes/listings.ts:98` `const KINDS = new Set(["live_event", "consult", "sell", "buy", "social"]);` — **`agent` is NOT an accepted kind today.**
- But `listings` already has `agent_instructions`, `agent_lang`, `agent_voice_persona` columns (`worker/migrations/2026-07-18-listings-drift-columns.sql:59-61`) and they are in `EDITABLE` (`worker/src/routes/listings.ts:1029`).
- Web card rendering already has a full `agent` lane: `web/src/lib/card.ts:261` `export type ListingLane = 'live' | 'consult' | 'agent' | 'free' | 'adda';`, `:266` `if (kind === 'agent') return 'agent';`, `:364` "agent — ALWAYS ON, always", `:495` `laneBadge.NAYA_AGENT`; `web/src/components/ListingTile.tsx:239,476,587,710`.
- App detail already renders it: `app/lib/features/explore/native_listing_detail_v2.dart:402` `l.kind == 'agent' ? '⚙ AI VOICE AGENT' : '✓ REAL HUMAN'`.
- Hidden on both clients: `web/src/lib/listingTaxonomy.ts:74` `HIDDEN_SECTIONS = new Set(['ai_voice_agents'])`; `app/lib/core/listing_groups.dart:93` `kHiddenListingSections = {'ai_voice_agents'}`; admin label `web/src/islands/admin/labels.ts:50` `'Voice agents (retired)'`.

---

## 1. LISTINGS

### 1.1 `listings` table (D1 `DB_META` / `avatok-meta`)

Base: `worker/migrations/listings.sql:26-56`
```sql
CREATE TABLE IF NOT EXISTS listings (
  id, creator_id,                          -- Clerk uid
  kind             TEXT NOT NULL,          -- live_event | consult    (listings.sql:30)
  title, description, category,
  price            INTEGER DEFAULT 0,      -- coins/tokens; 1 token = ₹1
  currency_display TEXT DEFAULT 'INR',     -- listings.sql:40 (real default = LISTING_DEFAULT_CURRENCY)
  country, adults_only, badges, cover_media,
  starts_at, duration_min,
  capacity         INTEGER,                -- consult 1|10|20 (1 = 1:1); live = NULL
  status           TEXT DEFAULT 'draft',   -- draft|published|live|completed|cancelled
  joined_count, rating_avg, rating_count, created_at, updated_at );
CREATE INDEX idx_listings_browse ON listings(status, kind, category, starts_at);
```
Plus `listings_fts` FTS5 virtual table (`listings.sql:136-142`), `reviews` (`:59`), `creator_profiles` (`:73`), `creator_follows` (`:89`), `fanout_log` (`:99`), `listing_promotions` (`:107`), `orders` (`:120`).

**All `ALTER TABLE listings` columns added since** (exact file:line):

| Column | File:line |
|---|---|
| `translation_enabled`, `spoken_lang` | `worker/migrations/translation.sql:32-33` |
| `vertical` (`commerce`/`connect`), `attrs` (JSON, 8 KiB cap), `video_url`, `proposed_category`, `cat_version`, `playbook_version`, `template_version` | `worker/migrations/2026-07-18-listings-taxonomy-columns.sql:157,161,166,184,204-206` |
| `agent_instructions`, `agent_lang`, `agent_voice_persona`, `market_type`, `social_sub`, `location`, `expiry_days`, `expires_at` | `worker/migrations/2026-07-18-listings-drift-columns.sql:59-71` |
| `content_version` | `worker/migrations/2026-07-18-listings-content-version.sql:57` |
| `public_agent_brief`, `seller_private_rules`, `never_disclose`, `floor_price`, `ask_before_commit` | `worker/migrations/2026-07-18-listings-mandate-columns.sql:127,151,185,222,244` |
| `section` (NOT NULL DEFAULT `'live_streaming'`) | `worker/migrations/2026-08-31-listings-section.sql:46` |
| `series_id` | `worker/migrations/2026-08-29-listings-series-id.sql:20` |
| `blurb`, `slug`, `schedule_mode`, `recurrence_days`, `recurrence_time`, `timezone` (DEFAULT `'Asia/Kolkata'`), `billing_unit`, `free_entry`, `max_per_booking`, `response_time_min`, `vibe_tags`, `credential` | `worker/migrations/2026-09-02-listings-content.sql:36-47` |
| `authority_version`, `publication_version` | `worker/migrations/2026-09-04-listing-authority-version.sql:3-4` |
| `reviewed_content_hash`, `reviewed_at`, `reviewed_by` | `worker/migrations/2026-09-04-listing-reviewed-version.sql:35-37` |
| `media_mode` (`audio_video`/`audio_only`) | `worker/migrations/2026-09-05-mkt-3group-alters.sql:30` |

Note: `price_coins` is **not** on `listings` — it lives on the OLX rail (`worker/migrations/olx.sql:14`) and on calendar slots (`worker/src/routes/commercial_checkout.ts:1160`). `listings` uses `price` (tokens/₹) + `currency_display`.

Sibling tables: `listing_slots` (`worker/migrations/2026-09-02-listing-slots.sql:33-50`), `listing_highlights` + `creator_stats` (`worker/migrations/2026-09-02-creator-stats.sql:50-61`), `listing_favorites.sql`.

### 1.2 Enums / accepted values (`worker/src/routes/listings.ts`)

```ts
:96   const APP = "avaexplore";
:98   const KINDS = new Set(["live_event", "consult", "sell", "buy", "social"]);
:118  export const LISTING_DEFAULT_CURRENCY = "INR";
:120  const MARKET_KINDS = new Set(["sell", "buy", "social"]);
:121  const CAPACITIES = new Set([1, 10, 20]);
:128  const SCHEDULE_MODES = new Set(["fixed_date","recurring","on_request","always_on"]);
:134  const SLOT_CLAIMED_STATUSES = new Set(["published", "live"]);
:139  const BILLING_UNITS = new Set(["session","minute","10min","chat","night","game","hour"]);
:146  const MEDIA_MODES = new Set(["audio_video", "audio_only"]);
:147  const SLUG_RE = /^[a-z0-9-]{1,48}$/;
:313  const COMMERCIAL_REFUND_WINDOWS = new Set([0, 12, 24, 48]);
:314  const COMMERCIAL_BOOKING_NOTICE_HOURS = new Set([1, 2, 6, 24]);
```
Commercial policy attrs whitelist per-kind: `worker/src/routes/listings.ts:319-359` (`liveKeys` = `commercial_refund_window_hours`; `consultKeys` = cancellation window / reschedule / booking notice / preparation instructions / no-show policy). A new kind falls into `allowed = new Set<string>()` → any `commercial_*` attr is rejected (`:333`).

Server-side commercial session kinds are a *separate, narrower* enum with D1 CHECK constraints: `'live_event' | 'consult_1to1'` (`worker/migrations/2026-08-24-commercial-stream-sessions.sql:16,35,57,201`; `worker/src/lib/commercial_stream_sessions.ts:12`).

### 1.3 Create / update / publish pipeline (worker)

`worker/src/routes/listings.ts`:
- `createListing` `:1343` — kind check `:1348`, identity gate `:1353` (`identityGate` `:1333`), free-entry gate `:1375`, price/commercial gate `:1402`, `commercialPolicyError` `:1411`, INSERT `:1466-1512`, `sectionFor(kind, category)` written at `:1496`, `billing_unit` default `"hour"` for session kinds `:1506`.
- `updateListing` `:1524` (`EDITABLE` whitelist `:1029`, `MATERIAL` `:1079`, `REVIEW_MATERIAL_FIELDS` `:1125`, `reviewedContentHash` `:1156`).
- `normListingFields` `:1199` / `normFields` `:1203`.
- `submitListingForApproval` `:1948`; `listingBlockersRoute` `:1927` (admin list `:1932`); `publishListingAuthoritative` `:2466`; `ensurePublicationEffects` `:2433`; `fanout` `:964`; `ftsSync` `:945`.
- Card shaping: `CARD_SELECT` `:611`, `shapeCard` `:674` (emits `currency_display: r.currency_display ?? LISTING_DEFAULT_CURRENCY` at `:694`), `cardStatsFor` `:865`, `promosFor` `:918`, `popularityOrder` `:854`.
- AI copy polish: `polishListingCopy` `:1877`; auto-poster: `runAutoPosterGeneration` `:2231`, `persistPosterAttempt` `:2148`.
- Listing fee quote (marketplace kinds only): `listingFeeQuote` `:2377`.

Slots CRUD: `worker/src/routes/listing_slots.ts` — `listSlots:60`, `overlapsSameLabel:82`, `createSlot:97`, gate `slotsOn:27` (`listingSlotsEnabled`, default **false** at `worker/src/routes/config.ts:2529`), `MAX_CONSULT_CAPACITY = 1` `:24`.

Route wiring: `worker/src/index.ts:1804` (`POST /api/listings`), `:1805` (`/api/listings/mine`), `:1809` (`/api/listings/copy-review`), `:1883` (`/api/listings/:id/slots`), `:1886` (`/api/slots/:slotId`), `:1797-1800` (`/api/explore`, `/api/explore/live-now`, `/api/explore/search`, `/api/explore/categories`).

### 1.4 Publish / expiry authority

`worker/src/lib/listing_schedule.ts` (153 L, pure, no I/O) — the single time authority:
```ts
:26  export const LATE_BOOKING_GRACE_MS = 15 * 60_000;
:31  export const END_GRACE_MS = 15 * 60_000;
:36  export const STUCK_LIVE_MS = 6 * 60 * 60_000;
:38  export type ScheduleState = "upcoming"|"starting"|"live"|"ended"|"cancelled"|"expired"|"open"|"unpublished";
:65  export function toMs(value: unknown): number | null
:72  export function eventWindow(row): {start,end} | null      // live_event only
:80  export function scheduleState(row, now = Date.now()): ScheduleState
:104 export function bookability(row, now): Bookability        // {ok:true}|{ok:false,reason,message}
:132 export function endMsSql(alias): string
:144 export function notEndedSql(alias, nowRef): string
:150 export function notStuckLiveSql(alias, nowRef): string
```
`scheduleState` returns `"open"` for anything without an `eventWindow` (`:89`) — i.e. a non-`live_event` kind is automatically "bookable, no fixed end". Cron sweep: `consumers/src/listing_expiry.ts`; background context in `AUDIT-2026-09-11-listing-expiry.md`.

### 1.5 Creation UIs

**Web** (`web/src/islands/dashboard/`):
- `CreateListing.tsx`, `EmbeddedCreateListing.tsx`, `ListingPublish.tsx`, `MyListingsPanel.tsx`, `CreatorListings.tsx`, `CreatorAgents.tsx`
- Wizard: `listing-form/ListingWizard.tsx`, `steps.tsx`, `wizardLogic.ts`, `types.ts`, `Editors.tsx`, `CopyReview.tsx`, `PreviewCard.tsx`
- Pages: `web/src/pages/dashboard/listings/new.astro`, `.../publish.astro`, `.../index.astro`, `web/src/pages/add.astro`
- Taxonomy/defaults helpers: `web/src/lib/listingTaxonomy.ts`, `listingDefaults.ts`, `listingErrors.ts`, `verticals.ts`, `marketGroups.ts`, `card.ts`
- **AI-agent creation precedent (AvaVision studio)**: `web/src/islands/vision/AgentForm.tsx` (template-seeded create/edit form; `:16-37` imports `createAgent/publishAgent/updateAgent, CREATOR_PAYS_RATE_PER_HOUR, MIN_RATE_PER_HOUR, SESSION_LIMITS` from `./avavisionApi`), `TemplatePicker.tsx`, `StudioFlow.tsx`, `GatedStudio.tsx`, `AgentCta.tsx`, `MarketplaceGrid.tsx`, `VisionCard.tsx`; API client `web/src/islands/vision/avavisionApi.ts` (`SESSION_LIMITS = [5,10,30,60]` `:47`, `MAX_SESSION_MINUTES = 60` `:46`, `MAX_CONCURRENT_CALLS = 10` `:45`, `CREATOR_PAYS_RATE_PER_HOUR = 500` `:48`, `MIN_RATE_PER_HOUR = 300` `:49`, `createAgent:395`, `publishAgent:418`, `uploadFile:440`, `book:517`, `callNow:526`). Pages `web/src/pages/vision/studio.astro`, `vision/agent/[id].astro`, `vision/session/[id].astro`, `dashboard/vision.astro`, `dashboard/voice.astro`.

**App (Flutter)**:
- Native wizard: `app/lib/features/marketplace/native_listing/native_listing_wizard_screen.dart`, `controller/listing_wizard_controller.dart` (kind branching at `:73,104,243,271,440-469,502`), `steps/step_1_type.dart:25-33` (`kinds = [('live_event',…), ('consult',…)]` — the place a third tuple would go), `steps/step_2..step_8`, `listing_draft.dart`, `listing_draft_serialization.dart`
- Other entry points: `marketplace/create_service_choice_sheet.dart`, `marketplace/edit_listing_screen.dart`, `marketplace/listing_web_form.dart`, `listings/create_listing_flow.dart`, `marketplace/sell_listing_flow.dart`
- AI agent studios: `app/lib/features/avavoice/studio/agent_form_flow.dart`, `avavoice/studio/voice_picker.dart`, `avavision/studio/agent_form_flow.dart`, `avavision/studio/template_picker.dart`

### 1.6 Detail pages

**Web**: `web/src/pages/l/[id].astro` (SSR fetches `getListing`/`getListingReviews`/`getListingSlots`/`getCreator` at `:14,27,64,67`), `web/src/pages/[username]/[slug].astro`, `e/[event].astro`, `watch/[id].astro`, `c/[handle].astro`, `embed/listing.astro`, `book/[id].astro`. Components: `components/ListingDetailView.astro`, `ListingDetailsComp.astro`, `ListingTile.tsx`, `listing/HostCard.astro`, `listing/PromisesBand.astro`, `listing/ReviewsSection.astro`, `listing/BrowseMore.astro`. Islands: `islands/listing/BookingBox.tsx`, `QuickInfo.tsx`, `ShareBox.tsx`, `QrCode.tsx`, `AskHost.tsx`, `MessageHost.tsx`, `LeaveReview.tsx`.

**App**: `app/lib/features/explore/native_listing_detail_v2.dart` (`NativeListingDetailV2` class `:58`, `_when(epochMs, timezone)` timezone renderer `:21-40`, `_closedLabel(ListingCard)` `:43-53`, agent badge `:402`), dispatcher `app/lib/features/explore/listing_detail.dart:17`, booking flow `explore/native_listing_booking_flow.dart`, checkout sheets `explore/commercial_checkout_sheets.dart`.

### 1.7 Marketplace listing surfaces

- Web pages: `web/src/pages/marketplace.astro` (header comment `:1-40` explains the real-data rule), `explore.astro`, `dashboard/marketplace.astro` (301s to `/marketplace`)
- Components/islands: `components/MarketplaceBrowse.astro` (`:40` — "'Voices with character' (`ai_voice_agents`) is removed entirely"), `BazaarHero.astro`, `BazaarSearchStrip.astro`, `TruckBorder.astro`, `islands/marketplace/{ExploreGrid,FilterRail,LiveNowRail,SearchBox,VerticalSection,api}.tsx`
- App: `app/lib/features/marketplace/marketplace_browse.dart` (`:454`, `:704` — null group ⇒ renders nowhere), `marketplace_hub.dart`, `app/lib/core/listing_groups.dart:88-93,182`, `app/lib/core/listings_api.dart:449,483`
- Worker section/group authority: `worker/src/lib/listing_section.ts` (`SECTIONS:18`, `DEFAULT_SECTION:31`, `SECTIONS_WITHOUT_A_SOURCE:46`, `SECTION_REQUIRES_FLAG:62`, `publishBlockedReason:71`, `sectionFor:104`, `isSection:120`, `GROUPS:135`, `GROUP_META:140`, `GROUP_FOR_SECTION:166`, `groupFor:179`)
- Negotiation/agent marketplace (separate feature): `worker/src/routes/marketplace.ts` (`isNegotiableListing:37`, `marketplaceNegotiate:499`, `runNegotiationJob:632`, `marketplaceSearch:1047`, `marketplaceAudio:1133`), `worker/migrations/marketplace_agent_settings.sql`

---

## 2. BOOKINGS + SESSIONS

### 2.1 Tables

**`bookings`** — `worker/migrations/calendar_phase5.sql:55-73`:
```sql
CREATE TABLE IF NOT EXISTS bookings (
  id, creator_id, buyer_id, listing_id,
  kind TEXT NOT NULL,     -- consult_1to1|consult_group|live_event   (:60)
  starts_at, ends_at, price, order_id,
  status TEXT NOT NULL,   -- confirmed|completed|cancelled_user|cancelled_creator|
                          -- no_show_user|no_show_creator|refunded   (:64)
  reschedule_count, reminder24_sent, reminder_sent, reminder10_sent,
  created_at, updated_at );
```
Plus `calendar_blocks` (`:39-51`), `availability_rules` (`:76-85`), `booking_policies` (`:88+`). Later alters: `host_marked_complete` (`worker/migrations/phase7.sql:16`), `translation_lang`/`translation_coins`/`trl_order_id` (`worker/migrations/translation.sql:38-40`).

**Commercial authority tables** — `worker/migrations/2026-08-24-commercial-stream-sessions.sql`:
`commercial_policy_snapshots:9`, `commercial_entitlements:33` (states `reserved|held|active|revoked|refunded|consumed`, roles `host|viewer|creator|buyer`), `commercial_sessions:55` (provider CHECK `= 'getstream'`, `provider_call_type IN ('avatok_livestream','avatok_consult_1to1')`, states `scheduled|backstage|live|ending|ended|cancelled|reconciliation_pending`), `commercial_session_members:93`, `commercial_provider_events:109`, `commercial_participant_intervals:135`, `commercial_control_operations:159`, `commercial_settlement_jobs:176`, `commercial_receipts:193`.
Checkout idempotency: `worker/migrations/2026-08-25-commercial-checkout.sql:9-32` (`commercial_checkout_operations` + the partial unique index `idx_commercial_live_entitlement_active` at `:29`).
Also `2026-08-25-commercial-consult-extensions.sql`, `2026-08-25-commercial-lifecycle.sql`, `2026-08-29-commercial-gst.sql`, `2026-08-29-commercial-member-order-id.sql`, `2026-09-11-settle-checkin-receipt-meta.sql`, `2026-09-11-commercial-live-outages.sql`, `2026-09-11-live-grace-alter.sql`.

**AvaVoice / AvaVision booking+session** (the closest fit for minute-slot AI):
`worker/migrations/avavoice.sql` — `avavoice_agents:5` (`rate_per_hour:13`, `payer_mode:14` `user_pays|creator_pays`, `session_limit_min:15` `5|10|30|60`, `vision_enabled:16`, `file_search_store:17`, `status:18`), `avavoice_agent_files:25`, `avavoice_bookings:36` (`scheduled_at`, `booked_minutes`, `language`, `rate_per_hour` snapshot, `escrow_coins`, `order_id` = `escrow:<order_id>`, `status booked|in_progress|completed|cancelled|no_show`), `avavoice_sessions:53` (`limit_minutes`, `started_at`, `last_beat_at`, `billed_minutes`, `gross_coins`, `creator_coins`, `refund_coins`, `end_reason user|agent_wrapup|hard_cap|disconnect|kill_switch`).
`worker/migrations/avavision.sql` mirrors it 1:1 plus vision columns (`:21-38`) and session telemetry (`:86-90`).

### 2.2 `worker/src/lib/commercial_stream_sessions.ts` (67 L — the whole file)

```ts
:10 export const COMMERCIAL_PROVIDER = "getstream" as const;
:12 export type CommercialSessionKind = "live_event" | "consult_1to1";
:13 export type CommercialProviderCallType = "avatok_livestream" | "avatok_consult_1to1";
:23 function authorityId(value, field)            // isCommercialId guard
:30 export function commercialProviderIdentity(input: {kind, listingId, bookingId?, sessionVersion?})
:42   callId: `consult_${bookingId}`             // consult_1to1
:53   callId: `live_${listingId}_${sessionVersion}` // live_event
:57 export function commercialJoinEnabled(kind, config)  // reads commercialLive/ConsultJoinEnabled
```
(There is no function literally named `mintCallId` — this is it. `isCommercialId` lives in `worker/src/lib/commercial_ids.ts`.)

### 2.3 `worker/src/routes/commercial_stream_sessions.ts` (2576 L)

GetStream plumbing: `signJwt:86`, `streamChatBindings:99`, `streamVideoBindings:105`, `providerTokens:157`, `chatToken:167`, `providerUrl:174`, `commercialChatChannel:178`, `upsertProviderUser:204`, `createProviderCall:220`, `addProviderMember:248`, `providerControl:263`.
Admission: `joinWindow:314`, `entitlement:344`, `authorizeProviderJoin:360`, `commercialLiveJoinUnsafe:667`, `commercialConsultPrejoin:756` (returns `room_ws`/`room_token`/`check_in_by` at `:798,833`), `commercialConsultJoinUnsafe:837`, `noStoreJoinResponse:1169`, `commercialLiveJoin:1177`, `commercialConsultJoin:1181`.
Extensions: `extensionConfig:875`, `extensionBooking:883`, `extensionScheduleConflict:925`, `commercialConsultExtensionQuote:945`, `commercialConsultExtensionConfirm:991`.
Control plane: `runControl:1230`, `commercialLivePrepareHost:1324`, `commercialLiveGoLive:1344`, `commercialLiveEnd:1403`, `commercialConsultEnd:1418`.
State/receipts: `commercialConsultState:1446`, `canViewSession:1459`, `consumeCommercialEntitlementsOnSessionEnd:1494`, `safeSessionState:1536`, `commercialLiveState:1564`, `commercialReceipt:1593`, `commercialRefundReceipt:1654` (`commercialSessionsMine:1654`).
**Webhook evidence ingest:** `export async function recordCommercialStreamEvent(...)` at `:1913`; `isCommercialLifecycleStart:149`; `notifyCommercialLifecycleOnce:115`; reconciliation `reconcileCommercialSessions:2412`.

### 2.4 Waiting room / `StreamSessionDO`

`worker/src/do/stream_session.ts` (522 L): `export class StreamSessionDO:75`, `fetch:111`, `handleWs:233` (welcome with embedded roster `:268`, roster broadcast `:275`), `webSocketMessage:280`, `webSocketClose:341`, `dropped:344`, `armAlarm:362`, `alarm:368`, `flushGifts:421`, `roster:451`, `rosterFlags:464` (`{host, attendee, host_checked_in_at}` — `[WAITROOM-2 / C11]` note at `:473-480`), `kick:481`, `attendance:503`.
Binding: `worker/wrangler.toml:395-397` `STREAM_SESSION_DO` → `StreamSessionDO`, migration tag `v3` (`:534-536`).
Chat attachments in the room: `worker/src/routes/commercial_session_attachment.ts:97` `commercialSessionAttachmentUpload`.

### 2.5 Availability / slot generation + double-booking guards

`worker/src/cal/engine.ts`:
```ts
:14  export const DEFAULT_POLICY: Policy = { buffer_min: 10, min_notice_min: 120, max_per_day: 8, vacation_until: null };
:19  export async function checkAvailability(env, userId, start, end, opts?)
:51  export async function claimBlock(env, a: ClaimArgs)   // atomic overlap claim
:78  export async function releaseBlocks(env, sourceApp, sourceRef)
:87  export async function loadPolicy(env, userId)
:96  export async function policyViolation(env, creatorId, start, end, p?)
:127 export function zonedEpoch(date, minutes, tz)         // DST-safe local→epoch
:138 export function weekdayOf(date)
:152 export async function freeSlots(env, creatorId, date, durMin): Promise<SlotOut[]>
:211 export type AvailabilityMode = "shared" | "custom" | "exclusive";
:376 export async function loadFixedLiveCommitments(...)
:414 export async function expireAvailabilityReservations(env, now)
:429 export async function validateListingSlot(env, listingId, startAt, endAt, opts)
:467 export async function claimListingSlot(env, a): Promise<ListingClaimResult>
:542 export async function claimExclusiveReservation(env, a)
:569 export async function releaseListingReservation(env, creatorId, reservationId, status)
:575 export async function previewListingConflicts(...)
:583 export async function replaceExclusiveReservation(...)
```
Routes: `worker/src/routes/calendar_availability.ts` — `getSchedule:57`, `putSchedule:65`, `listingAvailability:177`, `previewConflicts:234`, timezone validator `isZone:19`. Publication reservations: `worker/src/cal/listing_reservations.ts` — `publishFixedListing:35`, `releaseListingReservations:146`. `listing_slots` atomic claim pattern documented at `worker/migrations/2026-09-02-listing-slots.sql:14-17`.
Web client: `web/src/lib/availability.ts` (`getCreatorSchedule:126`, `saveCreatorSchedule:134`, `getListingAvailability:144`, `previewCalendarConflicts:159`), `web/src/islands/checkout/SlotPicker.tsx`, `web/src/islands/dashboard/CalendarPanel.tsx`.

### 2.6 Checkout / booking a slot

`worker/src/routes/commercial_checkout.ts` (1547 L):
```ts
:45   const DEFAULT_CURRENCY = "INR";
:146  const CHECKOUT_POLICY_VERSION = "commercial-policy-v1";
:149  REFUND_WINDOWS = new Set([0,12,24,48]); :150 BOOKING_NOTICE_HOURS = new Set([1,2,6,24]);
:151  const AVAILABILITY_HOLD_MS = 5 * 60_000;
:124  claimCommercialBlock(env, args)
:193  export async function claimCheckoutAvailability(env, args)
:274  export async function releaseCheckoutAvailability(env, uid, reservationId)
:280  checkoutKind(pathKind) → CheckoutKind | null
:319  export async function commercialHold(req, env)      // slot_id required :335-340
:433  policyFor(kind, attrs, config)                      // freezes the snapshot
:495  laneState(kind, config)
:524  canonicalRequest(args)  + :369 sha256Hex            // idempotency hash
:557  export async function recoverCommercialConfirmation(env, orderId, buyerId)
:591  export async function commercialCheckout(req, env)
:784    const r = await hold(env, auth.uid, orderId, amount, { opId: `commercial:hold:${orderId}` … });
:792    await refund(env, orderId, auth.uid, amount, { opId: `commercial:checkout-failure:${orderId}` });
:811  export async function resendCommercialConfirmation(req, env)
:927  export async function provisionCommercialPurchase(env, ctx)   // entitlement+booking+session+email
:1433 export async function provisionFromGatewayPurchase(env, args) // :1525 opId `${gateway}:hold:${ref}`
                                                                   // :1538 opId `${gateway}:reverse:${ref}`
```
Lifecycle/cancel/refund: `worker/src/routes/commercial_lifecycle.ts` (906 L, `cancellationDecision`, `runCommercialOrphanNoShowSweep`), `worker/src/commercial_settlement.ts` (`resolveConsultCheckInCfg:141`, `consultCheckInWindow:272`, `consultCheckInDecision:292`, `insertNoShowStrike:330`, `partialRefundSplit:673`, `recordPartialRefundReceipt:703`, `runCommercialSettlements:1165`, `runCommercialHostNoShowSweep:1204`), `worker/src/commercial_money_claim.ts`, `worker/src/money_engine.ts`, `worker/src/routes/commercial_diagnostics.ts`, `worker/src/routes/commercial_admin_claims.ts`.
Gateway rail: `worker/src/routes/pay.ts` (`GET /api/pay/methods`, `POST /api/pay/:gateway/order`, `POST /api/pay/:gateway/webhook`, `GET /api/pay/:gateway/status` — header `:4-7`; registry `worker/src/lib/payments/registry.ts`), `worker/src/routes/cashfree.ts`.

### 2.7 `/j/:token` no-login join lane

**Worker** `worker/src/routes/join_link.ts` (154 L — read the whole header `:1-29`):
```ts
:38  const JOIN_GRACE_MS = 24 * 60 * 60 * 1000;
:41  const DEAD_BOOKING = new Set(["cancelled","canceled","refunded","expired","declined","rejected"]);
:43  const LIVE_ENTITLEMENT = new Set(["reserved","held","active","consumed"]);
:55  function destinationFor(r): { kind:"live"|"consult", path } | null
:56    live_event → `/live/${listingId}` ; :58 consult → `/session/${bookingId}`
:61  export async function joinLinkSession(req, env, token): Promise<Response>
:62    verifyJoinTokenClaims(env, token, { allowExpired: true })
:107   SELECT entitlement_id, state, ends_at FROM commercial_entitlements WHERE kind/listing/booking/account AND role IN ('viewer','buyer')
:129   const mint = await mintClerkSignInTicket(env, resolved.accountId);
:144   return json({ ticket, ticket_kind: "clerk_sign_in_token", destination, destination_kind, account_email_masked })
```
Token signing/verify: `worker/src/cal/ics.ts` — `signJoinToken:20`, `verifyJoinToken:26`, `joinUrlFor:39` (`https://avatok.ai/j/${token}`), `JoinTokenClaims:62`, `signJoinTokenV2:71` (HMAC over `{v:2,b,l,u,k,exp}`), `verifyJoinTokenClaims:93`, `buildIcs:132`, `icsB64:151`.
Clerk sign-in ticket mint: `worker/src/lib/clerk_ticket.ts` (`mintClerkSignInTicket`, `maskEmail`; uses `CLERK_SECRET_KEY`, `worker/src/types.ts:249`).
Wiring: `worker/src/index.ts:1397` `/^\/api\/join-link\/([A-Za-z0-9._-]{1,512})\/session$/`.

**Web**: `web/src/pages/j/[token].astro` (`prerender = false` `:16`, `Cache-Control: no-store` `:28`, `noindex` `:36`) → `web/src/islands/join/JoinLink.tsx` (`safeDestination:51` regex `^\/(?:live|session|consult)\/…`, `useSignIn()` + `setActive` redemption `:64`, POST at `:77`). Path helpers: `web/src/lib/urls.ts` — `sessionPath:24`, `livePath:29`, `joinPath:34`, `appSessionDeepLink:49`, `safeReturnPath:74`, `payAndJoinPath:91`.
Pay-and-join: `web/src/islands/checkout/CommercialPayStep.tsx` (header `:1-25` documents the two independent funding rails), `BookingFlow.tsx`, `PayStep.tsx`, `GatewayPicker.tsx`, `GuestEmail.tsx`, `PayReturn.tsx`, `Confirmation.tsx`, `gatewaySheet.ts`, `types.ts`; `web/src/pages/pay/return.astro`.
Guest/email-code auth: `web/src/islands/auth/{EmailCodeSignIn,AuthGate,AuthBridge,RequireAccount,passwordless}.tsx`, `web/src/lib/clerk.tsx` (`requireGuestAuth`, `getActiveToken`, `ClerkIsland`).

**Rooms**: `web/src/pages/session/[booking].astro` (`prerender=false:8`, `no-store:20`, `<ConsultRoomGS client:load booking={booking}/>` `:29`), `web/src/pages/live/[id].astro`, `live/[id]/host.astro`, `consult/[booking].astro`.
`web/src/islands/consult-gs/` — `ConsultRoomGS.tsx` (flow documented `:8-37`), `WaitingRoom.tsx` (header `:1-16`; `WaitingChatLine:27`, `WaitingRoster:35`, `WaitingRoomProps:40`), `PreJoin.tsx`, `CallStage.tsx`, `Countdown.tsx`, `ExtendPanel.tsx`, `extend.ts`, `RoomSocket.ts`, `SessionChat.tsx`. Support libs: `web/src/lib/getstream.ts`, `commercialSessions.ts`, `commercialHost.ts`, `sessionUpload.ts`; `web/src/components/DeviceChecks.tsx`, `audioDeviceChecks.ts`.
App equivalents: `app/lib/features/commercial_getstream/commercial_waiting_room_screen.dart`, `commercial_consult_screens.dart`, `commercial_device_check.dart`, `session_chat_panel.dart`, `commercial_getstream_gateway.dart`.

### 2.8 Email confirmation

`worker/src/cal/emails.ts`: `COMMERCIAL_CONFIRMATION_VERSION = "commercial-confirmation.v1"` `:14`, `shell:20`, `CommercialConfirmationCtx:38`, `commercialDestination:67`, `buyerDestination:87`, `queueCommercialConfirmation:107`, `queueEmail:160`, `joinCta:175` (`{label:"Open in AvaTOK", url: joinUrlFor(token)}` `:178`), `emailBookingConfirmed:182`, `emailBookingCancelled:204`, `emailRefundIssued:219`, `emailSettlementPaid:225`, `emailPayoutStatus:231`, `reminderEmailHtml:239`.
Outbox + delivery: `worker/src/lib/email_outbox.ts`, queue `Q_EMAIL` (`worker/wrangler.toml:212-214`), consumers `consumers/src/email_delivery.ts`, `email_events.ts`, `email_provider.ts`.
**Provider is NOT Resend.** It is **Cloudflare Email Sending primary → Brevo fallback**: `consumers/src/email_provider.ts:15` (`Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md §3.1`), `:117` `"EMAIL binding not configured"`, `:155` `env.BREVO_API_KEY`, `:162` `https://api.brevo.com/v3/smtp/email`. Web-side transactional mail helper: `web/src/lib/sendMail.ts` (`MailEnv:25`, `OutboundMail:34`, `htmlToText:69`, `sendMail:308`). The only `resend` tokens in the worker are `resendCommercialConfirmation` (a user-triggered re-send, `worker/src/routes/commercial_checkout.ts:811`, wired at `worker/src/index.ts:1561`), not the SaaS.

---

## 3. WALLET

Primitives — `worker/src/ledger.ts`:
```ts
:17  export const PLATFORM_FEE_RATE = 0.20;       // 80/20
:18  export const ACCT_PLATFORM_FEES = "platform:fees";
:19  export const acctUser  = (uid) => `user:${uid}`;
:20  export const acctEscrow = (orderId) => `escrow:${orderId}`;
:30  export async function escrowBalance(env, orderId)
:45  export async function hold(env, uid, orderId, amount, opts?: {opId?, title?, app?})
:85  export const ACCT_EXTERNAL = (source) => `external:${source}`;
:87  export async function holdExternal(...)      :117 refundExternal(...)
:152 export async function release(env, orderId, creatorId, opts?: {title?, app?, feeRate?, gross?})
:182 export async function feeFromEscrow(env, orderId, amount, opId, meta?)
:196 export async function refund(env, orderId, uid, amount, opts?: {opId?, reason?, title?})
:216 export async function donation(...)          :242 adjust(env, uid, amount, reason, adminId, opId)
:257 export async function clerkEmail(env, uid)
:268 export interface ReceiptLine { label: string; amount: number; }   // coins (1 = $0.01)
:271 export async function sendReceipt(env, uid, kind: "topup"|"purchase", opts)
```
Balance authority is `WalletDO` (`worker/src/do/wallet.ts`; binding `WALLET_DO` `worker/wrangler.toml:384-386`); audit trail D1 `DB_WALLET` / `avatok-wallet` (`worker/wrangler.toml:160-163`), queue `Q_WALLET` → `wallet-transactions` (`:228-230`); migrations `wallet.sql`, `wallet_ledger.sql`, `wallet_phase7.sql`, `phase3_wallet.sql`.

Routes — `worker/src/routes/wallet.ts` (1009 L):
```ts
:39  // [TOKENS-INR-RAIL-1 2026-08-28] THE RUPEE IS THE DEFAULT
:62  const TOKENS_PER_USD = 100;   :67 const TOPUP_CURRENCY = "inr";
:71  const MIN_TOPUP = 100, MAX_TOPUP = 50_000;   // ₹100 .. ₹50,000
:203 export async function walletOp(env, uid, op: WalletOperation)
:281 commissionRate(env, app)   :291 transferTokens(...)
:314 walletReserve  :323 walletConsumeReserved  :332 walletReleaseReservation
:355 export async function walletTopup(req, env)        // WEB rail: Stripe Checkout, INR, tokens*100 paise (:393)
:403   INSERT INTO topup_records (...)
:432 export async function walletTopupIntent(req, env)  // in-app PaymentSheet; { amount_minor, currency }
:501 const PLAY_TOPUP_PRODUCTS  :512 walletTopupPlayVerify
:683 export async function stripeWebhook(req, env)      // :766 ledger debit external:stripe → user
:636 runPlayVoidedPurchaseSweep
```
Wired at `worker/src/index.ts:1229-1275` (`/api/wallet/topup{,/intent,/play/verify}`, `/balance`, `/transactions`, `/statement`, `/activity`, `/statement/export`, `/summary`, `/topup-quote`, `/earnings`, `/live` WS, `/ledger`, `/spend`, `/webhooks/stripe`).
Client: `web/src/islands/dashboard/WalletPanel.tsx`, `web/src/pages/dashboard/wallet.astro`, `dashboard/billing.astro`, `web/src/pages/tokens.astro`, `web/src/lib/money.ts` (`RUPEES_PER_TOKEN = 1` `:26`, `inr:32`, `inrOrFree:39`, `inrWithTokens:45`, `GST_RATE_PCT = 18` `:66`, `priceBreakdown:81`).
Receipts: `commercial_receipts` table; `commercialReceipt` / `commercialRefundReceipt` (`worker/src/routes/commercial_stream_sessions.ts:1593,1631`); `sendReceipt` (`worker/src/ledger.ts:271`); `worker/src/routes/admin_money.ts:adminTaxExport`.

**Charge-on-book precedent for a minute-priced AI session** — `worker/src/routes/avavoice.ts`:
`perMin:68`, `billedMinutes:73`, `avavoiceBook:534` (escrow `= payer_mode==='creator_pays' ? 0 : perMin(rate_per_hour)*minutes` `:551`; `orderId = 'avv_'+id` `:552`; `hold(env, uid, orderId, escrow, {title, app})` `:554`; 402 `insufficient_avacoins` `:559`), `avavoiceCancelBooking:591` (full refund), `avavoiceSessionStart:655`, `avavoiceHeartbeat:718` (server hard-cap → `settleSession(env,s,now,"hard_cap")` `:743`), `avavoiceSessionStop:736`, `settleSession:751`:
- creator_pays: `walletOp(... op:"spend", op_id: \`avv:${s.id}:usage\`, ledger:{debit:acctUser(creator), credit:ACCT_PLATFORM_FEES, type:"avavoice_platform_usage"})` (`:926-934`)
- user_pays: `release(env, bk.order_id, creator, {feeRate: FEE_RATE, gross})` (`:939`), affiliate `settleAffiliate({settlementId:\`avv:${s.id}\`…})` (`:945`), unused minutes `refund(env, order_id, user, refundTokens, { opId: \`refund:${order_id}:unused\` })` (`:954`).

---

## 4. ADMIN

**The gate** — `worker/src/routes/admin_money.ts:18-24`:
```ts
export async function requireAdmin(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const admins = (env.ADMIN_UIDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!admins.includes(ctx.uid)) return json({ error: "admin only" }, 403);
  return { uid: ctx.uid };
}
```
`audit()` helper writes `admin_audit` in `DB_WALLET` (`:26-32`).
Allowlist is **uid-based, not email-based**: `worker/wrangler.toml:111-112` `ADMIN_UIDS = "user_3AuqQadIDHJftJtTkLD0DtKM8MB"`.
Ad-hoc re-parsings of the same list (each its own copy): `worker/src/routes/config.ts:2622` (`putConfig`), `worker/src/routes/listings.ts:1932`, `worker/src/routes/listing_review.ts:90`, `worker/src/routes/brain.ts:182`, `worker/src/lib/free_entry_gate.ts:39`, `worker/src/routes/campaigns.ts:47`, `campaign_contacts_route.ts:56`, `campaign_voices.ts:51`, `campaign_dids_route.ts:42`, `campaign_kb.ts:47`, `campaign_analytics.ts:53`, `worker/src/routes/admin_delete_user.ts:30` (+ a hard guard at `:59` refusing to delete an admin uid). Roles layer: `worker/src/routes/admin_dashboard.ts:34-41` (uid in `ADMIN_UIDS` with no `admin_roles` row ⇒ effective `super`), `:537-540`. `worker/src/routes/categories.ts:37` imports `requireAdmin` from `admin_money` explicitly as "the existing gate".
Alert email fallback `hdavy2005@gmail.com`: `worker/src/money_engine.ts:258`, `worker/src/routes/admin_dashboard.ts:519` (`env.ALERT_EMAIL`, `worker/src/types.ts:526`).

**Separate reviewer allowlist (email-based, for listing review only)**: `worker/src/routes/config.ts:1081-1127` `reviewerEmails: string` (`:1097`, default `""` at `:2218`), `reviewerTermsVersion`, `reviewerTermsForAll`; web `web/src/lib/reviewer.ts`, `web/src/islands/shell/ReviewerOnboarding.tsx`.

**Admin API routes** (`worker/src/index.ts`): `/api/admin/config` PUT `:524`, `/ledger:1283`, `/refund:1284`, `/adjust:1285`, `/recon:1286`, `/commercial/diagnostics:1287`, `/stream/calltypes/ensure:1290`, `/commercial/claims:1293`, `/tax-export:1298`, `/escrow/hold:1299`, `/escrow/release:1300`, `/welcome-backfill:1304`, `/token-hard-reset:1312`, `/overview:1319`, `/listings:1320`, `/reviews:1336`, `/live:1338`, `/agents:1339`, `/health:1340`, `/analytics:1341`, `/audit:1342`, `/users/search:1343`, `/alerts:1344`, `/alerts/evaluate:1345`, `/alert-rules:1348`, `/roles:1350`, `/payouts/upi:1411`, `/delete-user:1454`, `/test-clock:1771`, `/settlements:1777`, `/money/evaluate:1780`, `/affiliates:1931`, `/dynw/acceptance:545`.
Route files: `worker/src/routes/admin_dashboard.ts`, `admin_listings.ts` (737 L), `admin_reviews.ts`, `admin_money.ts`, `admin_delete_user.ts`, `admin_listing_purge.ts`, `admin_stream_calltypes.ts`, `commercial_admin_claims.ts`, `listing_review.ts`.
**Admin UI**: `web/src/pages/admin/index.astro`, `admin/listings.astro`, `admin/reviews.astro`; islands `web/src/islands/admin/{AdminListings,AdminReviews,AuditTimeline,BlockerPanel,CopyPanel,DeletePanel,EditPanel,ModerationBar,PosterPanel,QueueRail,RejectControl,SubmissionPanel,adminListingsShared,labels}.tsx`.

---

## 5. AI

### 5.1 `worker/src/lib/ai_gate.ts` (567 L)
```ts
:39  const GUARD = "@cf/meta/llama-guard-3-8b";
:58  export function friendlyAiError(raw)
:84  export function aiRunOpts(env, uid?)                 // AI Gateway cost-logging opts
:103 parseLlamaGuardVerdict  :124 safetyVerdict  :158 isSafe  :163 guardInput  :173 guardOutput
:193 export function intentGate(userText): IntentVerdict
:202 export type AiTier = "byo" | "ourkeys";
:220 export async function enforceQuota(...)
:243 webSearchAllowed  :249 fileAnalysisAllowed
:289 estimateTokens  :305 freeTextCostMicroUsd
:323 reserveFreeTextBudget  :384 settleFreeTextBudget  :401 releaseFreeTextBudget
:414 export const FREE_BUDGET_MESSAGE
:442 export async function runGated(...)
```
Related: `worker/src/lib/ai_quota.ts`, `ai_billing.ts` (price catalog; `:156` `openai/whisper-large-v3`, `:165` `openai/gpt-5-image-mini`), `ai_media_jobs.ts:154-163`, `worker/src/feature_pricing.ts`.

### 5.2 OpenAI
**No realtime/GPT-Live usage exists.** OpenAI appears only as:
- `worker/src/lib/ava_reason/adapters/openai.ts` — thin REST adapter, `const BASE = "https://api.openai.com/v1"` `:8`, key check `:11-12` (`env.OPENAI_API_KEY`).
- Routing policy: `worker/src/lib/ava_reason/policy.ts:228-230` (`OPENAI_API_KEY` ? `openai`/`whisper-1` : `cf_ai`/`@cf/openai/whisper`), `:69` `DEFAULT_AUDIO_TRANSCRIBE_MODEL = "openai/whisper-large-v3"`.
- Provider union: `worker/src/lib/ava_reason/types.ts:18` `"openrouter" | "cf_ai" | "google" | "openai" | "xai"`.
- `OPENAI_API_KEY` is **not** declared in `worker/src/types.ts` Env (read via `(env as any)`), and **not** in `wrangler.toml`.

### 5.3 Existing realtime voice engines (the actual reuse candidates)
- **Grok realtime** (closest architecture to GPT-Live): `worker/src/lib/grok.ts` — `REALTIME_BASE = "wss://api.x.ai/v1/realtime"` `:32`, `REST_BASE` `:33`, `MANAGEMENT_BASE` `:34`, `GROK_VOICE_MODEL = "grok-voice-latest"` `:35`, `realtimeUrl(model):38`, `GrokFunctionTool:42`, `GrokFileSearchTool:52`, `buildSessionUpdate:67`, `buildWrapUpNudge:102`, `createCollection:157`, `uploadDocument:173`, `deleteDocument:201`, `searchDocuments:221`.
  DO: `worker/src/do/agent_voice_room.ts` (730 L) — `export class AgentVoiceRoom:125`, `fetch:159`, `ev:194`, `startGrokSession:212`, `failSessionStart:290`, `onClientMessage:313`, `sendToGrok:327`, `onGrokMessage:331`, `pushDialog:388`, `handleFunctionCall:399`, `runTool:424`, `runCreateBooking:452`, `writePendingBooking:498`, `tickMinute:518` (per-minute billing meter), `injectWrapUp:538`, `clearTimers:549`, `finalize:556`, `buildTranscript:685`.
  Route: `worker/src/routes/agent_voice_routes.ts:25` `agentCallStart` — flag gate `:29` (`cfg.voiceAgent !== true` → 503), concurrency reserve `:50`, `holdForAgentModeA` `:53` (402 `wallet_insufficient`), snapshot `:68`, `sid`/`rtcToken` `:77-78`, `InitBlob` `:79` stashed in KV (`INIT_TTL_SEC = 300` `:23`). WS upgrade at `worker/src/index.ts:712` (`/api/agent/call/rtc`); start at `:1115`. Bindings `AGENT_VOICE_ROOMS` (`worker/wrangler.toml:478-480`, migration `v15` `:598-600`). Flag `voiceAgent` (`worker/src/routes/config.ts:1336`).
- **Gemini Live ephemeral token** (the pattern an AI-voice *listing* would most cheaply copy) — `worker/src/routes/avavoice.ts`: `DEFAULT_MODEL = "gemini-3.1-flash-live-preview"` `:55`, `VOICES` list `:88-110` + `VOICE_NAMES:111`, **`composePrompt(a, limitMin, language)` `:116-135`** (platform prompt layer with time-management + language + knowledge sections), **`mintToken(env, a, limitMin, language)` `:140-190`** (`POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens` `:175`, `uses:1`, `expireTime = now + limitMin*60_000 + 90_000` `:147,171`, `responseModalities:["AUDIO"]` + `prebuiltVoiceConfig.voiceName` `:152-153`, input transcription deliberately OFF `:155-158`, `contextWindowCompression` `:162`, File Search tool `:164-168`), `ensureStore:193`, `indexFile:209`, `activeCalls:250` (`MAX_CONCURRENT` slot gate, used at `:742`), `flagOff:276`.
- **Gemini Live over PSTN / receptionist**: `worker/src/do/reception_room.ts` (`realtimeInput` frames `:703,770`; header warning `:16`), `worker/src/do/vobiz_agent_room.ts` (`:854,938,966,1150`), `worker/src/do/voicemail_room.ts`, `voicemail_stream_room.ts`.
- **Cloudflare-native STT→LLM→TTS engine** (provider-independent voice loop with barge-in): `worker/src/do/reception_room_cf.ts` — header `:1-24` documents the pipe and the client WS contract (PCM16 16k in / 24k out + JSON control), cost constants `:52-55`, imports `avaReasonRaw` `:29`, `aiRunOpts` `:31`, Google/Sarvam/DeepInfra TTS+STT `:33-35`.
- Web browser-side Gemini Live clients already exist: `web/src/islands/agent/GeminiLiveClient.ts`, `AudioPipeline.ts`, `AgentCall.tsx`, `CallControls.tsx`, `VisionSender.ts`, `api.ts`; and `web/src/islands/vision/session/{GeminiLiveClient,AudioPipeline,SessionRoom,visionEngineWeb,SnapshotSheet}.ts(x)`.

### 5.4 AvaBrain / RAG / embeddings
- `worker/src/lib/brain_ingest.ts` (245 L): `BrainIngestInput:25`, `BrainIngestResult:52`, `fnv1aHex:61`, `idempotencyKeyFor:70`, `legacyAliasesFor:84`, `consentAllows:101`, `brainIngest(env, input):122`.
- Vectorize is used from the DO, not from `brain_ingest`: `worker/src/do/user_brain.ts:279` (`if (!this.env.VECTOR_INDEX) return []`), `:283` (`verb:"embed", model: env.BRAIN_EMBED_MODEL || "@cf/baai/bge-small-en-v1.5"`), `:290` (`VECTOR_INDEX.query(vec, { topK, filter:{uid}, returnMetadata:true })`). Deletes: `worker/src/lib/brain_assets.ts:271-279`.
- Managed RAG (AI Search namespace, per-user store): `worker/src/lib/ava_rag.ts` — `getStoreName:23`, `ensureStore:32`, `ingestText:86`, `ingestBytes:95`.
- Other brain libs/routes: `brain_domains.ts`, `brain_assets.ts`, `routes/brain.ts`, `brain_domains.ts`, `brain_export.ts`, `brain_media.ts`, `routes/ava_rag.ts`; queue `Q_BRAIN` (`worker/wrangler.toml:220-222`), D1 `DB_BRAIN` (`:155-158`), consumers `consumers/src/brain.ts`, `brain_assets.ts`.

### 5.5 AI/Vector/R2 bindings (`worker/wrangler.toml`)
`[ai] binding = "AI"` `:320-321`; `[[ai_search_namespaces]] binding="AI_SEARCH" namespace="default"` `:326-328`; `[[vectorize]] binding="VECTOR_INDEX" index_name="avatok-semantic"` (384-dim, cosine) `:351-353`; `[[analytics_engine_datasets]] ANALYTICS → avatok_metrics` `:341-343`.
R2: `BLOBS`/`avatok-blobs` `:169-171`, `VERIFICATION` `:173-175`, `DIGITAL`/`avatok-digital` `:177-179` (+ `DIGITAL_BUCKET_NAME` var `:77`), `AGENT_AUDIO`/`avatok-agent-audio` `:181-183`, `BACKUP_R2`/`avatok-backup` `:188-190`. Public read host `BLOSSOM_BASE_URL = "https://blossom.avatok.ai"` `:72`.
`/upload/public`: `worker/src/routes/media.ts:215` `export async function uploadPublic(req, env, exec)` — no liveness gate (rationale `:218-231`), `sha256Hex` content id `:233`, `userKey(uid,"public",hash)` `:234`, URL `${env.BLOSSOM_BASE_URL}/${r2Key}` `:235`, headers `x-content-type`/`x-file-name`/`x-app`/`x-folder` `:236-244`, video cap `:241`, blocklist check `:251-253`. Wired `worker/src/index.ts:1149`.
**PDF**: `worker/src/routes/media.ts:895-897` (filter), `:939` (`WHEN mime_type='application/pdf' THEN 'pdf'`), `:1407`, `:1460` (ext map); generation `worker/src/routes/ava_copilot.ts:322,485` (`buildSimplePdf`); `worker/src/lib/ava_triggers.ts`, `worker/src/feature_pricing.ts`. Client: `web/src/lib/sessionUpload.ts`, `web/src/pages/api/careers-apply.ts`, `app/lib/features/{commercial_getstream/session_chat_panel,library/lib_thumbs,library/avalibrary_screen,ava_companion/companion_thread,avatok/chat_media_cards,avatok/file_viewer_screen}.dart`, `app/lib/core/library_ingest.dart`. Agent knowledge-file upload path (what an AI-agent listing would use): `avavoiceUploadFile` (`worker/src/routes/avavoice.ts:439`) → `ensureStore:193` → `indexFile:209` (Gemini File Search), rows in `avavoice_agent_files`.

---

## 6. CONFIG

`worker/src/routes/config.ts` (2812 L). Shape:
1. `const KEY = "platform_config"` `:9` — one JSON blob in KV namespace `TOKENS` (`worker/wrangler.toml:196-198`).
2. `export interface PlatformConfig { … }` `:11` — every flag declared with a doc comment saying whether it is boolean or numeric (the "fake-flag rule", e.g. `:35`, `:283-284`, `:473-474`, `:1620-1621`).
3. `const DEFAULTS: PlatformConfig = { … }` `:1876` — must be edited in the **same change** as the interface.
4. `readConfig(env)` ends `:2602` `return enforcePermanentFreeCommunication({ ...DEFAULTS, ...stored });` (memoized `:2600`).
5. `getConfig(env)` `:2605` — public GET, `cache-control: public, max-age=60` `:2615`, injects `partyEnabled` from `env.PARTY_ENABLED` `:2613`.
6. `putConfig(req, env)` `:2619` — admin gate `:2622-2623`, JSON parse `:2626`, **KV stores OVERRIDES ONLY** (rationale `:2630-2637`), whitelist merge on `k in DEFAULTS`, and `const numericKeys = new Set([...])` `:2640-2760+` — a numeric flag missing from this set 400s `bad type` via `scripts/flags.sh set`.

Flags relevant here: `commercialLive{Listings,Checkout,Join}Enabled` + `commercialConsult{…}` `:19-24`, `commercialCreatorFeePct`/`commercialSettlementHoldHours` `:25-26`, `sessionFeeRuleEnabled` `:37`, `commercialCreatorCancelRefundPct`/`ProviderFailureRefundPct`/`LateCancelRefundPct` `:55-57`, `gstEnabled`/`gstRatePct` `:75-76` (must stay false — no GSTIN), `sessionCreatorCheckInMin` `:113` (default `20` `:1914`), `avavoiceEnabled` `:627` / `avavisionEnabled` `:628` (both `false` — "FREE LAUNCH: agent builder hidden" `:2035-2036`), `voiceAgent` `:1336`, `reviewerEmails` `:1097`, `listingSlotsEnabled` `:1855` (default `false` `:2529`), poster flags `:1617-1651`. numericKeys excerpt `:2640-2679`; note at `:2761` that `listingSlotsEnabled` is boolean and deliberately absent.
Tooling: `scripts/flags.sh` (`set`/`unset`/`prune`); docs `CONFIG.md`.

### wrangler bindings inventory (`worker/wrangler.toml`)
- name `avatok-api` `:8`, `main src/index.ts` `:9`, compat `2025-05-01` `:10`, flags `["nodejs_compat","enable_ctx_exports"]` `:15`, cron `*/5 * * * *` `:21-22`, custom domain `api.avatok.ai` `:28-30`.
- **D1**: `DB_META`/avatok-meta `:140-143`, `DB_MEDIA`/avatok-media-meta `:145-148`, `DB_MODERATION` `:150-153`, `DB_BRAIN` `:155-158`, `DB_WALLET` `:160-163`.
- **R2**: see §5.5. **KV**: `TOKENS` `:196-198`.
- **Queues (producers)**: `Q_MODERATION:204`, `Q_PUSH:208`, `Q_EMAIL:212`, `Q_ANALYTICS:216`, `Q_BRAIN:220`, `Q_DELETE:224`, `Q_WALLET:228`, `Q_AGENT`/agent-tasks `:232-234`, `Q_MONEY`/money-settlements `:236-238`, `Q_ARCHIVE:240`, `Q_MKT_AUDIO:244`, `Q_AUTO_REPLY:248`, `LIVENESS_QUEUE:261`, `Q_CONTACTS:270`, `Q_AI_MEDIA:276`. **Consumers (self)**: `money-settlements:282`, `money-dlq:288`, `liveness-verify:298`, `contacts-chunk:307`, `ai-media-jobs:312`.
- **Durable Objects**: `CALL_ROOMS:359`, `MESH_ROOMS:364`, `GROUP_CALL_ROOMS:370`, `CONFERENCE_ROOMS:374`, `USER_BRAIN:379`, `WALLET_DO:384`, `MESSENGER_CALL_BILLING:390`, `STREAM_SESSION_DO:395`, `AGENT_DO:400`, `CONVERSATION_DO:405`, `INBOX:411`, `SENTINEL:419`, `PARTY:427`, `AVA_AGENT:439`, `BACKUP:444`, `RECEPTION_ROOM:450`, `RECEPTION_ROOM_CF:456`, `CALL_STATE_AUTHORITY:465`, `VOICEMAIL_ROOM:472`, **`AGENT_VOICE_ROOMS`/`AgentVoiceRoom`:478-480**, `VOBIZ_AGENT_ROOM:485`, `VOICEMAIL_STREAM_ROOM:492`, `DIALER_GATE:500`, `CAMPAIGN_DO:505`. `[[worker_loaders]] LOADER:513`, `[[workflows]] WF_DELETION:521`. DO migrations `v1`–`v23` `:526-632` (next free tag: **v24**; `v20`/`v21` are unused).
- **Vars** `:32-134` incl. `AI_GATEWAY_ID="avatok-ai"` `:37`, `CF_ACCOUNT_ID:38`, `ENVIRONMENT_NAME:41`, `OPENROUTER_AGENT_MODEL:53`, `AVA_VERTEX_TEXT_MODEL:63`, `BRAIN_REASONER_MODEL:79`, `AVA_REASONER:83`, `BRAIN_EMBED_MODEL:85`, `AVAVISION_SNAPSHOT_MODEL:91`, `VERTEX_PROJECT/LOCATION:99-100`, `WALLET_TOPUP_ENABLED:101`, `STRIPE_PUBLISHABLE_KEY:105`, `CLERK_JWKS_URL/CLERK_ISSUER:109-110`, `ADMIN_UIDS:112`.
- **Secrets referenced** (never in file): listed `:634-644` + Env decls in `worker/src/types.ts` — `GEMINI_API_KEY:448`, `RECEPTIONIST_GEMINI_API_KEY:453`, `GROK_API_KEY:266`, `GROK_MANAGEMENT_KEY:267`, `CLERK_SECRET_KEY:249`, `AI_GATEWAY_TOKEN:424`, `ALERT_EMAIL:526`, plus `BREVO_API_KEY` (consumers).
- **`[env.staging]`** `:654-700+` (`avatok-api-staging` @ `api-staging.avatok.ai`, own D1/R2/KV/queues, `TEST_CLOCK_ALLOWED="1"` `:663`).

---

## 7. WEB

- **Stack**: Astro + React islands, `web/astro.config.mjs`, Tailwind (`tailwind.config.ts`, `tailwind.zine.cjs`), own `web/wrangler.toml`. Pages under `web/src/pages` (full list gathered above), reusable Astro components in `web/src/components`, React islands in `web/src/islands/<area>/`, layouts (`Base.astro`, `Dashboard`).
- **Worker transport**: `web/src/lib/apiClient.ts` — rules header `:1-8`, `API_BASE` from `web/src/lib/config.ts` `:9`, `ApiError:32`, `RequestOptions:45` (`auth?: string | null` → `Authorization: Bearer <jwt>` `:49-50`), `buildUrl:58`, `export async function request<T>(path, opts):78`; `normalizeEndpoint:22` collapses ids to `:id` for PostHog. Auth token source: `web/src/lib/clerk.tsx` (`getActiveToken`, `requireGuestAuth`, `ClerkIsland`), `web/src/lib/authState.ts`.
- **Money**: `web/src/lib/money.ts` (see §3). **Analytics**: `web/src/lib/analytics.ts` — `DEFAULT_KEY:16`, `DEFAULT_HOST='https://eu.i.posthog.com':17`, `SENSITIVE_KEY_RE:33`, `LONG_DIGIT_RUN_RE:38`, `scrubProps:45`, `deriveApp:60`, `deviceClass:74`, `registerResponsiveSuperProps:80`, `initAnalytics:118`, `identify:185`, `reset:204`, `capture:215`, `captureException:225`, `uiInteraction:238`, `apiError:243`, `withTrace:261`, `currentDistinctUid:281`.
- **Other libs**: `getstream.ts`, `commercialSessions.ts`, `commercialHost.ts`, `availability.ts`, `card.ts`, `copy.ts`, `urls.ts`, `types.ts`, `listingTaxonomy.ts`, `listingDefaults.ts`, `listingErrors.ts`, `verticals.ts`, `marketGroups.ts`, `og.ts`, `org.ts`, `help.ts`, `sendMail.ts`, `sessionUpload.ts`, `embed.ts`, `reviewer.ts`, `creatorGuides.ts`, `creatorIdeas.ts`.
- **Customer session/waiting room (built 2026-09-11)**: `web/src/islands/consult-gs/*` — see §2.7. Live: `web/src/islands/live-gs/{LiveGsHost,LiveGsViewer,LiveStage,GsChat}.tsx`; legacy WebRTC: `islands/consult/*`, `islands/live/*`.
- **Timezone handling**: listings carry `listings.timezone` (default `Asia/Kolkata`); server validates with `Intl.DateTimeFormat` (`worker/src/routes/listings.ts:424` `isValidTimezone`, `worker/src/routes/calendar_availability.ts:19` `isZone`); DST-safe conversion `worker/src/cal/engine.ts:127` `zonedEpoch`, `:138` `weekdayOf`; availability API takes a `timezone` query param (`web/src/lib/availability.ts:148,154`); app renders in the listing's zone (`app/lib/features/explore/native_listing_detail_v2.dart:21-40`, `app/lib/core/availability_time.dart` `AvailabilityTime.inTimezone`). Emails use UTC (`whenUtc`, `worker/src/cal/emails.ts:243`).

---

## 8. TELEMETRY

`Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` — structure (heading:line):
`1. The contract:15` → `1.1 Super properties on EVERY event:17` (table: `platform`, `service_name`, `release`, `app`, `email`/`phone` = "the retrieval key", `clerk_uid`, `account_id`, `trace_id`, `screen`/`$current_url`, `viewport`/`device_class`), `1.2 Products enabled:32`, `1.3 Person identity:38`, `1.4 Naming:45` (`snake_case`, `<area>_<object>_<verb|outcome>`; every failable event carries `outcome: ok|refused|error`, `reason`, `status`, `ms`), `1.5 What is NEVER sent:52`.
`2. Website:60` → `2.1 Automatic:67`, `2.2 Auth:77`, `2.3 Marketplace + cards:84`, `2.4 Listing details:93`, `2.5 Checkout:103`, `2.6 Live + consult players:113`, `2.7 Creator dashboard:123`, `2.8 Money on the web:134`, `2.9 Site/marketing:140`, `2.10 Admin:151`, `2.11 Web-only health:156`.
`3. Android/iOS:167` (`3.1:177`, `3.2:202`), `4. Desktop:214`, `5. Worker + consumers:221` (`5.1 Listing poster:229`), `6. Dashboards and alerts:257`, `7. Rule for planners and reviewers:268`.
Then per-workstream appendices: `WP5 [LIVE-GRACE-WEB-1]:275`, `WP3 [SETTLE-CHECKIN-1]:316`, `WP1 [SESSION-CLOCK-0]:343`, `WP4 [WAITROOM-WEB-1]:388`, `WP7 [LIVE-GRACE-APP-1]:433`, `WP2:478`, `WP6 [WAITROOM-APP-1]:511`, `WP8 [LIVE-GRACE-1]:555`, `APP-ONLY-TX:630`, `JOIN-LINK-1:650`.
Project 139917 (EU), key `phc_hmYM…`, host `https://eu.i.posthog.com` (`:7-8`).
Emitters: web `web/src/lib/analytics.ts`; worker `track()`/`metric()` from `worker/src/hooks.ts` + queue `Q_ANALYTICS`; commercial-specific `worker/src/lib/commercial_telemetry.ts` (`commercialEvent`, used e.g. `worker/src/routes/join_link.ts:136`); app `app/lib/core/analytics.dart`.
AvaVoice already emits the full set to copy: `avavoice_booking_created`, `avavoice_creator_booking_received`, `avavoice_insufficient_funds`, `avavoice_busy_rejected`, `avavoice_creator_wallet_empty`, `avavoice_call_started`, `live_session_open`/`live_session_close` ("One Brain B1 §5"), `avavoice_call_ended`, `avavoice_creator_settlement`, `avavoice_token_mint_failed` — `worker/src/routes/avavoice.ts:183-188, 556-572, 743-745, 774-780, 852-856, 917-921, 967-981`.

---

## 9. Existing agent / persona / companion / voice code worth reusing

| What | Where |
|---|---|
| **Prompt composition for a paid, time-boxed AI voice session** | `worker/src/routes/avavoice.ts:116-135` `composePrompt(a, limitMin, language)` |
| **Voice catalog (Gemini prebuilt voices)** | `worker/src/routes/avavoice.ts:88-111`; `avavoiceVoices():285`; pickers `web/src/islands/vision/AgentForm.tsx:40`, `app/lib/features/avavoice/studio/voice_picker.dart` |
| **Per-session ephemeral-token minting locked to prompt+voice+limit** | `worker/src/routes/avavoice.ts:140-190` (Gemini); `worker/src/lib/grok.ts:38,67` (Grok realtime) |
| **Realtime bridge DO with per-minute meter, wrap-up nudge, hard cap, tool calls, transcript, finalize** | `worker/src/do/agent_voice_room.ts:125-730` |
| **CF-native STT→LLM→TTS voice loop with barge-in (provider-agnostic)** | `worker/src/do/reception_room_cf.ts` |
| **Receptionist LLM (Gemini Live)** | `worker/src/do/reception_room.ts`; routes `worker/src/routes/receptionist.ts`, `recept_rules.ts`, `recept_analytics.ts`; migrations `receptionist*.sql`; rules `worker/src/lib/dynw/recept_rules.ts` |
| **Ava persona / voice style** | `worker/src/lib/ava_persona.ts` (`AVA_VOICE_STYLES:48`, `styleClause:128`, `resolveStyle:134`, `AVA_STRINGS:185`, `avaString:245`, `readVoiceStyle:294`, `writeVoiceStyle:323`); `worker/src/routes/ava_voice_style.ts` |
| **Agent profiles / settings / TTS / docs (PSTN agent)** | `worker/src/routes/agent_profiles.ts`, `agent_settings.ts`, `agent_tts.ts`, `agent_docs.ts`, `agent.ts`, `pstn_agent.ts`; DO `worker/src/do/agent.ts`, `ava_agent.ts`, `vobiz_agent_room.ts` |
| **One-reasoner abstraction (verbs: text/embed/stt/tts)** | `worker/src/lib/ava_reason.ts` + `ava_reason/{core,policy,types,adapters/*}.ts` |
| **Companion / askava (app)** | `app/lib/features/askava/{askava_screen,askava_tools,persona,companion_home,companion_thread,companion_session_store,brain_memory_screen,source_chips,remember_choice_sheet}.dart`; `app/lib/features/ava_companion/*`; worker `worker/src/lib/ava_ambient.ts`, `ava_session.ts`, `ava_memory.ts`, `ava_group_session.ts`, `ava_capabilities.ts`, `ava_governor.ts`, `ava_budget.ts`, `ava_templates.ts`, `ava_triggers.ts`, `ava_lane.ts`, `ava_kinds.ts` |
| **Campaign voice agents (outbound, per-minute tokens, KB files, concurrency gate)** | `worker/src/routes/campaigns.ts`, `campaign_voices.ts`, `campaign_kb.ts`, `campaign_pstn.ts`, `campaign_handover.ts`; DO `campaign_do.ts`, `dialer_gate_do.ts`; flags `campaign*` in `worker/src/routes/config.ts:2674-2677` |
| **Web browser AI-call islands (audio pipeline + Gemini Live client + call controls)** | `web/src/islands/agent/{AgentCall,CallControls,AudioPipeline,GeminiLiveClient,VisionSender,api}.tsx/.ts`; `web/src/islands/vision/session/*` |
| **Marketplace negotiation agent (per-user persona settings, floor price, quiet hours, voice render)** | `worker/src/routes/marketplace.ts`; `worker/migrations/marketplace_agent_settings.sql`; app `app/lib/features/marketplace/call_agent_sheet.dart` |
| **Relevant specs** | `Specs/AVAVOICE-PROPOSAL.md`, `Specs/AVAVISION-PROPOSAL.md`, `Specs/RULEBOOK-PAID-SESSIONS.md`, `Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md`, `Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md`, `Specs/listing-taxonomy.json`, `Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md`, `Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md`, `Specs/AUDIT-2026-09-11-PAID-SESSION-WAITING-AND-BILLING.md`, `Specs/AUDIT-2026-09-04-listing-pipeline-join-pricing.md`, `AUDIT-2026-09-11-listing-expiry.md`, `Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md` |

---

## 10. Gap ledger (facts only — no design)

1. `worker/src/routes/listings.ts:98` `KINDS` has no `agent`; `worker/src/lib/listing_section.ts:112` already maps such a kind to `ai_voice_agents`; `:166` has no group for it, so `groupFor()` returns null and both clients hide it (`web/src/lib/listingTaxonomy.ts:74`, `app/lib/core/listing_groups.dart:93`).
2. D1 CHECK constraints on the commercial tables hard-code `kind IN ('live_event','consult_1to1')` in 5 places (`worker/migrations/2026-08-24-commercial-stream-sessions.sql:16,35,57,201`; `2026-08-25-commercial-checkout.sql:12`) and `provider = 'getstream'` in 2 (`:62,111`).
3. `worker/src/routes/listings.ts:333` rejects any `commercial_*` attr on a kind that is neither `live_event` nor `consult`.
4. `commercialProviderIdentity` (`worker/src/lib/commercial_stream_sessions.ts:30`) accepts only the two kinds and always yields a GetStream call id.
5. Minute-slot durations: nothing in the listings lane encodes 5/10/20/30/40/60; the existing enums are `avavoice_agents.session_limit_min` `5|10|30|60` (`worker/migrations/avavoice.sql:15`) and `SESSION_LIMITS = [5,10,30,60]` (`web/src/islands/vision/avavisionApi.ts:47`), with `MAX_SESSION_MIN`/`MAX_CONCURRENT` in `worker/src/routes/avavoice.ts:56-66`.
6. `avavoiceEnabled`/`avavisionEnabled` are both `false` in DEFAULTS (`worker/src/routes/config.ts:2035-2036`) and `voiceAgent` is dark (`:1336`); `listingSlotsEnabled` is `false` (`:2529`).
7. `/j/:token` resolves only two destinations (`worker/src/routes/join_link.ts:55-59`) and `web/src/islands/join/JoinLink.tsx:54` whitelists only `/live|/session|/consult` paths.
8. No `OPENAI_API_KEY` in `worker/wrangler.toml` or `worker/src/types.ts`; no code path touches OpenAI Realtime.
9. Next free DO migration tag is `v24` (`worker/wrangler.toml:626-632` ends at `v23`).