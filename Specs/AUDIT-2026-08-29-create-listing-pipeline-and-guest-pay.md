# AUDIT 2026-08-29 — Create-listing pipeline, card parity, money flow, guest pay

Read-only audit. No code changed, no flag flipped, no deploy. Every claim below was
verified against the file cited, and every production flag value was read from the live
cache-busted `/api/config`, not from `DEFAULTS`.

---

## 0. Verdict in one page

**The create-listing pipeline is not one pipeline. It is two, and the web one is a stub.**
The Flutter app has a complete 3-step create flow (photos, schedule, capacity, publish).
The web form at `/dashboard/listings/new` collects **four fields** — type, title, one-liner,
price — and has no publish button, no photo upload, and no page to continue on. A draft
created there can never reach `published`, because publish requires a cover photo, a
category, and (for a live event) `starts_at` + `duration_min` — none of which the web
form asks for.

**The new cards ask for roughly 20 fields. The form collects 4. Nine of those fields have
no column anywhere in D1.** The catalogue design at `web/src/landing/avatok-listings-catalogue.html`
(2026-08-27 13:41, the newest card work) and the bazaar comps in `design/live-streaming/`
are 100% hardcoded HTML, so nothing about them is currently fed by a listing.

**Money does move correctly in the commercial lane — the design is sound** (real wallet
debit, double-entry escrow, 80/20 split, cron settlement, idempotency). **But three bugs
make the paid lane unshippable as written**, two of them money bugs where a buyer is
charged and cannot be admitted. All six commercial flags are `false` in production today,
which is the only reason none of this has bitten a real user.

**The guest-pay pivot is greenfield.** There is no inbound UPI, no Indian gateway, no
anonymous purchase, and no non-uid entitlement anywhere in the repo. Everything today is
Clerk-account + token-wallet.

---

## 1. What production actually has switched on

Read 2026-08-29 from `https://api.avatok.ai/api/config` (cache-busted):

| Flag | Prod | Consequence |
|---|---|---|
| `identityGatingEnabled` | **true** | This is why the screenshot says `identity_required` |
| `listingLivenessGate` | **true** | |
| `livenessValidityDays` | 90 | |
| `marketplaceEnabled` / `marketplacePublishEnabled` | true / true | |
| `commercialLiveListingsEnabled` | **false** | paid live lane dark |
| `commercialConsultListingsEnabled` | **false** | paid consult lane dark |
| `commercialLiveCheckoutEnabled` | **false** | |
| `commercialConsultCheckoutEnabled` | **false** | |
| `commercialLiveJoinEnabled` | **false** | |
| `commercialConsultJoinEnabled` | **false** | |
| `commercialCreatorFeePct` | 80 | 80 creator / 20 platform |
| `commercialSettlementHoldHours` | 24 | |
| `billingEnabled` / `walletRealMoney` | false / false | no real money moves today |
| `playTopupEnabled` | **true** | Play top-up button live in the app |
| `upiPayoutEnabled` | **true** | outbound UPI payouts live (manual admin) |
| `messengerCallingEnabled` | **false** | messenger calling already killed ✅ |
| `shellV2` | **true** | ⚠️ already flipped — see §6 |
| `avaAffiliateEnabled` / `affiliateJoinLinkEnabled` | true / true | |

⚠️ **`shellV2 = true` in production.** `CLAUDE.md` still describes this as `false` and warns
that flipping it ships **AskAva with no kill switch** (`features/askava/askava_screen.dart:62`
is only dark *because* `shellV2` was false). That warning is now live. Worth a separate look.

⚠️ **The commercial migrations are not auto-applied.**
`worker/migrations/2026-08-24-commercial-stream-sessions.sql:2-3` says so explicitly, and no
runner references them. `commercial_checkout.ts:146-156` read-probes the schema and fails
closed with 503. So even flipping the flags does nothing until the migrations are run
against prod D1 by hand.

---

## 2. The create-listing pipeline, as built

### 2.1 The web form — four fields

`web/src/islands/dashboard/CreateListing.tsx`, page `web/src/pages/dashboard/listings/new.astro:16`.

The entire request body (`CreateListing.tsx:59`):

```js
const body = {
  kind, title: title.trim(),
  description: description.trim() || undefined,
  price: price ? Math.round(Number(price)) : 0
};
```

`POST /api/listings` → `{ ok, listing_id, status: "draft", ... }` → redirect to
`/dashboard/listings?created=<id>`. Only client validation is `title.length >= 3`
(`:55`). Edit uses `PUT /api/listings/:id` and reads back only those same four keys (`:42-48`).

**Three defects in this component alone:**

1. **It is not gated.** `CreateListing.tsx:2` and `new.astro:4` both claim "Gated by
   RequireAccount", but the component body (`:111-117`) renders `<Form/>` bare.
   `RequireAccount` exists (`web/src/islands/auth/RequireAccount.tsx:78`) and is used by
   `GatedStudio.tsx:11` — just not here.
2. **It never sends `category`.** The worker silently defaults it to `"teachers"`
   (`worker/src/routes/listings.ts:647`). Publish then requires the category to be a valid
   active row — so every web draft is pre-loaded with a category the creator never chose.
3. **The promise at `:100` goes nowhere.** "Next you'll add cover photos and publish" —
   `web/src/pages/dashboard/listings/` contains only `index.astro` and `new.astro`. There is
   no publish page and no upload page. Grep of `web/src` for `cover_media` and `api/media`
   returns zero hits.

### 2.2 The worker accepts far more than the form sends

`createListing` (`listings.ts:607-685`) via `normFields` (`:512-575`) accepts:

`kind, title, description, category, price, currency_display, country, adults_only, badges,
cover_media, starts_at, duration_min, capacity, translation_enabled, spoken_lang,
agent_instructions, agent_lang, agent_voice_persona, market_type, social_sub, location,
expiry_days, attrs, video_url, proposed_category, vertical`

**The server side is not the bottleneck. The web form is.** The Flutter app already sends
the full payload — `app/lib/features/listings/create_listing_flow.dart:266-285`, including
`cover_media`, `starts_at`, `duration_min`, `capacity`, `attrs`, with a real upload to
`kUploadPublicUrl` at `:162-180` and a "≥1 photo" step gate at `:191/:221`.

### 2.3 Why the screenshot says `identity_required`

Thrown at `worker/src/lib/identity_gate.ts:185` and `:204`, reached from `listings.ts:617`
(**createListing**, not publish):

```ts
const gate = await identityGate(env, ctx.uid, kind, null);
if (gate) return gate;
```

To pass, all of the following must hold (`identity_gate.ts:71-142`):

1. `identityGatingEnabled` true — it is, in prod.
2. A row in `identity_proofs` with `proof='liveness'` and `status='verified'` for that uid.
3. `verified_at` within `livenessValidityDays` (90).

It fails **closed**: a missing row and a DB error both yield `reason: "never_passed"`.
It is *not* `users.kyc_status` and *not* `clerk_account_link.tier` (the file header at
`:13-32` calls those legacy/dead).

**Two things follow.** First, the account in the screenshot simply has no valid Didit
liveness pass — the fix is to complete liveness, not to change code. Second, **the web
handles this error terribly**: grep for `identity_required` across `web/` returns nothing,
so `apiClient` renders the raw string (`CreateListing.tsx:69`, `:95`) as `⚠ identity_required`.
No liveness flow is offered. And the form's own copy at `:100-101` ("publishing verifies
your identity (KYC)") is wrong about *when* — the gate fires at **draft creation**.

A second, different gate — `requireKyc` (`worker/src/authz.ts:56-59`) — fires later at
publish for live_event/consult and returns `"identity verification required"`. Two gates,
two error strings, neither handled in web.

### 2.4 Draft → publish requirements (the real wall)

Statuses: `draft | published | live | completed | cancelled`.
`publishListing` (`listings.ts:836-987`), creator-service branch `:872-897`:

- KYC pass (`requireKyc`)
- `title` **and** `category` required
- **`cover_media` length ≥ 1** → else `{ error: "cover_required" }` (max 5)
- category must exist in `listing_categories` with `active=1`
- `price >= 0`
- **live_event**: `starts_at` in the future **and** `duration_min ∈ [5,480]`, then
  `claimBlock` against `calendar_blocks` → 409 `conflict` on overlap
- **consult**: `capacity ∈ {1,10,20}` **and** at least one `availability_rules` row, else
  409 `no_availability`

Slot claim is `worker/src/cal/engine.ts:39-52` — a conditional INSERT that is atomic against
overlap. Note `listings.ts:890` calls it **without `bufferMin`**, so `booking_policies.buffer_min`
is ignored at publish time (it is applied on the booking path).

**Net: a web-created draft is structurally unpublishable.** No photo, no start time, no
duration, no capacity, no chosen category, and no publish button to press anyway.

---

## 3. Card parity — what the new cards need vs what the pipeline has

The newest card design is `web/src/landing/avatok-listings-catalogue.html` (mtime
2026-08-27 13:41, commit `e4d6f300`) — 32 cards across Live friends / Live streaming /
Consultations / Voice agents. The bazaar comps (`design/live-streaming/*.dc.html`,
2026-08-27 05:10–06:04) are the same design language and are **served in production** at
`/marketplace` and `/<username>/<slug>` via `renderMockupPage`. Both are **entirely
hardcoded** — `marketplace.astro:22` says so: *"The comp runs on hardcoded mock data and
cannot be searched, filtered or booked for real."*

### The gap table

| Card shows | Example on the card | Create form asks? | D1 column? | Gap |
|---|---|---|---|---|
| Cover photo | sprite frame / `.listing-photo` | **no** (web) / yes (app) | `cover_media` | **web form** |
| Title | "Badrinath Temple Tour" | yes | `title` | ok |
| One-liner | `.card-desc` | yes | `description` | ok |
| Price | `₹50`, `₹50/hr`, `₹8/min`, `₹1,499` | yes (flat int) | `price` | **price semantics** — `price_semantics` has `asking\|per_month\|from\|range\|none`, **no per-minute or per-hour** |
| Category | "Faith & travel", "Wellness" | **no** (defaults `teachers`) | `category` | **web form** |
| Language | "Hindi · English" | **no** | `spoken_lang` | **web form**; also absent from web `Card` type |
| Location | "Mumbai", "Himalayas" | **no** | `location` | **web form**; web `Card` has only `country` |
| Status pill | "Live now", "Starts 6 PM", "Tonight 8 PM" | **no** | `starts_at`, `status` | **web form** |
| Duration | "60 min", "24/7" | **no** | `duration_min` | **web form**; absent from web `Card` type |
| Creator name + avatar | "Aashi Kapoor" + initials | derived | `creator_profiles` | ok |
| Verified ✓ | literal `✓` on every card | n/a | `creator.kycVerified` (Dart) | **web `CreatorRef` has no verified flag** |
| Rating | "★ 4.9 · 312" | computed | `rating_avg`, `rating_count` | ok (not rendered by `ListingTile`) |
| Booked count | "✓ 1.8K booked" | computed | `joined_count` | ok |
| **Watching now** | "👁 428 watching" | no | **none** | **no column anywhere** |
| **Slots left** | "◷ 3 slots left", "44 OF 60 FREE", "HOUSEFULL" | no | `capacity` only | **no seats-taken counter** |
| **Response time** | "● 12 min response" | no | **none** | **no column** |
| **Satisfaction %** | "♡ 98% felt heard", "♡ 96% come back" | no | **none** | **no column** |
| **Regulars / repeat** | "♡ 420 regulars" | no | **none** | **no column** |
| **Followers on card** | "1.2K FOLLOW THIS SHOW" | n/a | `creator_follows` | exists, but detail-only — never on the card model |
| **Recurring schedule** | "every Friday", availability dialog | no | **none** | `starts_at` is a single timestamp; `availability_rules` is per-*user*, not per-listing |
| **Multiple slots per event** | "MAIN SHOW · 90 MIN", "44 OF 60 FREE" | no | **none** | one listing = one start time |
| Favourite ♡ | per card | n/a | `favorited` (Dart) | **web `Card` has no favourite** |
| 18+ | "AI · 18+" | no | `adults_only` | **web form** |
| Fee + GST line | comp computes `base + ₹6 fee + 18% GST` | n/a | **none** | **no fee/GST model in the pipeline at all** |

**Summary: 8 fields need only a form field (the column exists). 7 fields need new schema.
1 needs a price-semantics extension. Plus the whole recurring/multi-slot model is missing.**

Two structural notes:

- **The comps bake the price into the title string** (`"Antakshari Friday with Sunny · ₹49"`,
  `design/live-streaming/avaTOK Marketplace.dc.html:242`, and every `.card-title` in the
  catalogue). Real data will not have that — the card template needs a separate price slot.
- **The web `Card` interface** (`web/src/lib/types.ts:7`) is much thinner than the Dart
  `ListingCard` (`app/lib/core/listings_api.dart:275`). Dart already carries `durationMin`,
  `spokenLang`, `location`, `favorited`, `capacity`, `promoPct`, `attrs`. Web carries none
  of those. **Bringing the web card model up to the Dart one closes about half the gap with
  no schema change.**

---

## 4. Money — does it actually get deducted, and where does it go?

### 4.1 Yes, and the design is sound

The buyer debit is real, synchronous, and correctly ordered. `worker/src/routes/commercial_checkout.ts:410-424`:

```ts
if (price > 0) {
  const held = await hold(env, auth.uid, orderId, price, {
    opId: `commercial:hold:${orderId}`,
    title: listing.title,
    app: route.kind === "live_event" ? "avalive" : "avaconsult",
  });
  if (!held.ok) { ... return json(response, held.status === 402 ? 402 : 502); }
```

`hold` (`worker/src/ledger.ts:45-52`) debits `user:<uid>` and credits `escrow:<orderId>`
with a double-entry row. The real balance change happens in the WalletDO
(`worker/src/do/wallet.ts:557-587`), which returns 402 on insufficient balance. Idempotency
is enforced at the DO by `op_id` (`do/wallet.ts:428-441`) — a replay returns the original
result and does not re-emit the ledger row.

**No entitlement is ever created without a successful hold.** Order row, policy snapshot,
booking and entitlement are all written after (`:440-457`, `:495-550`).

### 4.2 Where it goes

Split frozen at checkout into an immutable policy snapshot (`commercial_checkout.ts:429-436`):

```ts
const creatorAmount = Math.round(price * creatorFeePct / 100);
const platformFeeAmount = price - creatorAmount;
```

Released by the cron (`worker/src/commercial_settlement.ts:170-227`):

- `escrow:<orderId>` → `user:<creatorId>` for the creator's 80% (as an `earn` with
  `hold_hours = 24`, so it matures rather than landing instantly)
- `escrow:<orderId>` → `platform:fees` for the 20%

The snapshot arithmetic is re-verified before release (`:153-168`). Cron is wired at
`worker/src/index.ts:401-403`; jobs are claimed with a 60s stale lease, batch ≤50
(`:353-390`), and cross-path races are closed by `commercial_money_claims`
(`commercial_money_claim.ts:17-37`).

**Payout is outbound UPI, manual.** `worker/src/routes/upi_payout.ts` — `upiPayoutEnabled`
is **true** in prod, min 1000 tokens, requires Stripe KYC + signed creator agreement +
verified VPA. It only *reserves*; the actual debit is an admin action with a hand-entered
UTR. There is no automated bank API call, and `tds_inr_paise` is `NULL` (`tax_pending: true`).

**Metering is binary, not per-minute.** `commercial_participant_intervals` records join/leave
spans, but they are used only as a delivery gate with a 60s threshold
(`commercial_settlement.ts:96-151`): live events check **host** connected time only; consults
check **creator × buyer overlap**. There is no per-minute billing anywhere in the commercial
lane. That matches "pay the price mentioned and watch for the designated time" — but it means
a creator who shows up for 61 seconds and leaves still settles at 100%.

### 4.3 🔴 Three bugs that must be fixed before this lane is switched on

**P0-1 — a paid 1:1 consult cannot run. The creator has no entitlement.**

Consult join requires `grant.role === 'creator'` for the creator
(`commercial_stream_sessions.ts:541-548`). There are exactly **two** `INSERT INTO
commercial_entitlements` in the whole repo — checkout writes `'viewer'`/`'buyer'` for the
buyer (`commercial_checkout.ts:545-550`), and the live-event host self-grants `'host'`
(`commercial_stream_sessions.ts:455-459`). **No row with `role='creator'` is ever created.**

Result: creator gets 403 `"booking entitlement required"` → session never happens → zero
creator×buyer overlap → `"insufficient signed two-party delivery evidence"` → the job lands
in `review_pending`. **Buyer charged, session impossible, money stuck.**

Corroborating: the paid extension path asserts two entitlements and can never pass
(`commercial_stream_sessions.ts:827-835`), so every paid extension charges and then
auto-refunds.

**P0-2 — only one ticket holder can join a paid live event.**

`authorizeProviderJoin` writes the *first* joiner's per-buyer `order_id` onto the shared
session row (`commercial_stream_sessions.ts:336`) and then re-verifies it for every later
joiner (`:368`):

```ts
|| (persistedSession.order_id ?? null) !== (args.orderId ?? null)
... return refused("session_authority_mismatch", ..., 409);
```

Live join passes `orderId: grant.order_id` (`:500`), which is unique per ticket. So buyer #2
gets 409. And if the **host** joins first, the session's `order_id` is `NULL` (the host
entitlement stores NULL at `:458`) — so **every paying viewer is refused**.

This is a money bug, not just an availability bug: live settlement only requires host
delivery, so the creator is still paid 80% and the platform takes 20% while the buyers who
were refused entry have no automatic recourse.

**P0-3 — almost every cancellation path parks money in `review_pending`.**

`commercial_lifecycle.ts:119-142` auto-refunds only when the policy percentage is exactly
100. But the snapshot written at checkout (`commercial_checkout.ts:179-223`) contains **no**
`creator_cancel_refund_pct`, `provider_failure_refund_pct` or `late_cancel_refund_pct`.
So creator cancel, creator no-show, provider outage and every late buyer cancel all resolve
to `review_pending` (202). Only an early in-window buyer cancel auto-refunds. **There is no
admin route in the commercial lane to resolve `review_pending`** — only the generic
`adjust()` (`ledger.ts:138`).

Also: the public lifecycle route can only ever emit `creator_cancel` or `buyer_cancel`
(`commercial_lifecycle.ts:542`), so `no_show_policy` is unreachable from the product.

### 4.4 Two more risks worth naming

- **Dual-lane double charge.** The legacy `bookListing` fence reads
  `commercial*ListingsEnabled` (`listings.ts:81-88`) but checkout reads
  `commercial*CheckoutEnabled` (`commercial_checkout.ts:225-229`). Turn checkout on without
  listings on and **both** lanes will take money for the same listing into two separate
  escrow buckets. Flip these four flags together, or unify the gate.
- **Settlement silently blocks if the queue consumer lags.** Escrow buckets in D1 are
  materialized by `consumers/src/wallet.ts:16-31` off the `wallet-transactions` queue.
  `escrowBalance` is compared to snapshot gross before release and before refund
  (`commercial_settlement.ts:326-330`, `commercial_lifecycle.ts:194-196`). If
  `avatok-consumers` is not deployed or is behind, **every settlement and refund falls to
  `review_pending` while the buyer has already been debited in the DO.**
- **No affiliate cut on commercial orders.** `settleAffiliate` is called from
  `money_engine.ts:145`, `avavoice.ts:782`, `avavision.ts:1070` — **never from any
  `commercial_*` file.** An affiliate-driven ticket sale pays the affiliate nothing today.
  This directly contradicts the "affiliate-created link" traffic source in the new plan.

---

## 5. The guest-pay pivot — what exists, and what has to be built

Target: a visitor with a link pays by UPI and joins, with no AvaTOK account and no wallet
top-up. **None of the four required pieces exists.**

### 5.1 Auth — Clerk only

`worker/src/authz.ts:16-42` — `requireUser` accepts only an RS256 Clerk JWT validated
against Clerk's JWKS (`worker/src/auth.ts:26-53`; the header at `auth.ts:1-2` states Clerk
is the sole authority since 2026-07-02). `requireUser(` appears **484 times** in `worker/src`.

A guest-token primitive **does** exist and is already HMAC-signed —
`worker/src/routes/ladder.ts:40-56`, format `g1.<uid>.<exp>.<hmac>`. But its own header
(`ladder.ts:13-16`) says: *"Guests NEVER pass requireUser."* Its only verifier call site
(`ladder.ts:145`) is inside `guestUpgrade`, which itself needs a Clerk session. It reserves
a handle; it cannot buy or join.

🐛 **The existing web guest gate is already broken.** `web/src/lib/clerk.tsx:16` claims
*"requireGuestAuth() resolves the guest_token (a valid requireUser JWT)"* — it is not.
`GuestGate` (`:233-289`) passes that HMAC token to `/api/id/email/start` and
`/api/id/email/verify`, both of which call `requireUser` (`worker/src/routes/id.ts:36`, `:77`)
and will reject `g1.…` as bad JWT → 401. `BookingFlow.tsx:74-77` depends on this. **Web
checkout cannot currently complete for a new visitor.**

### 5.2 Payment rails — Stripe + Google Play in, UPI out only

| Rail | Direction | Where | Auth |
|---|---|---|---|
| Stripe Checkout (web) | in | `wallet.ts:355` `walletTopup` | `requireUser` |
| Stripe PaymentIntent (app) | in | `wallet.ts:432` | `requireUser` |
| Google Play billing | in | `wallet.ts:512` | `requireUser` |
| UPI payout | **out** | `upi_payout.ts` | `requireUser` + KYC |

Money-in is off anyway (`wallet.ts:371-374` returns 503 `pending_legal_approval` when
`WALLET_TOPUP_ENABLED` is unset), and `billingEnabled`/`walletRealMoney` are both false in prod.

**No Indian gateway exists.** A repo-wide search for
`razorpay|cashfree|phonepe|paytm|payu|instamojo|juspay` across `worker/src`, `web/src` and
`app/lib` returns exactly one hit, and it is an unrelated intent-classifier regex
(`worker/src/lib/ava_triggers.ts:60`). `worker/src/types.ts:326-336` lists only Stripe and
Play credentials; `wrangler.toml` has no Indian gateway secret.

**There is no inbound UPI of any kind** — no collect request, no UPI intent link, no VPA
receiving address, no QR. UPI is outbound-only.

Note `CLAUDE.md` already anticipates this: Stripe India needs a registered business, avaTOK
is unregistered, so the real rail is expected to be **Cashfree**. That decision is still open.

### 5.3 Entitlement — hard-bound to a uid

`worker/migrations/2026-08-24-commercial-stream-sessions.sql:33-53`:

```sql
account_id TEXT NOT NULL,
role TEXT NOT NULL CHECK (role IN ('host','viewer','creator','buyer')),
UNIQUE(kind, listing_id, booking_id, account_id, role)
```

Written straight from the Clerk uid (`commercial_checkout.ts:548`) and then re-verified
against it (`:583-586`). The checkout response literally names the model (`:601`):
`access: "account_bound"`, and the file header (`:5-8`) states it as a deliberate stance:
*"A public listing URL is discovery only; this route requires an authenticated account."*

**Good news:** `account_id` is a plain `TEXT` column with **no foreign key to `users`**. An
opaque buyer token (`tkt:<uuid>`) satisfies the schema and both unique indexes unchanged.
The work is in the readers: `commercial_stream_sessions.ts:241`, `listings.ts:1336`,
`commercial_notifications.ts:60`, `commercial_lifecycle.ts:449`.

**Deeper blocker:** the money path itself is uid-keyed. `commercial_checkout.ts:411` funds
the purchase with `hold(env, auth.uid, ...)` against a uid-keyed WalletDO — a wallet debit,
not a card charge. "No wallet top-up" breaks more than the entitlement row; it needs a
direct-charge branch that bypasses `hold()` when the order was already paid at the gateway.

### 5.4 Join — every path needs an authenticated uid

`streamVideoToken` (`stream_video_calls.ts:504-532`) calls `requireUser`, and the token is
minted with the uid as the Stream identity (`:250-255`: `{ user_id: uid, ... }`).
Commercial live join (`commercial_stream_sessions.ts:436-439`, `:489`) and legacy live join
(`live.ts:182-196`) both require it. The only unauthenticated join-adjacent surface is the
`liveRoom` WebSocket (`live.ts:222-226`), which takes a `room_token` HMAC — but that token
is only issued *after* `requireUser` succeeded and embeds the uid. It is session
continuation, not admission.

### 5.5 Affiliate links — the click half already works anonymously

`GET /a/:linkId` (`affiliate.ts:549-552`) is genuinely public: it mints an `ava_aff_dev`
cookie (`:571-575`, `:620`) and parks pending attribution in KV for 30 days (`:40`).
**But the conversion half requires an account** — `affiliateBind` calls `requireUser`
(`:666-667`) and writes `affiliate_attributions.referred_uid`, joined to `users.uid` (`:506`).
There is no attribution row keyed by anything but a uid. Combined with §4.4, an
affiliate-driven ticket sale today would neither attribute nor pay.

### 5.6 Public pages

| Route | Logged-out? | Note |
|---|---|---|
| `/l/[id]` | yes | SSR, edge-cached 60s |
| `/e/[event]`, `/c/[handle]` | yes | |
| `/marketplace`, `/explore` | yes | reads are public by design (`index.ts:1604`) |
| `/book/[id]` | shell yes, checkout no | email gate fires inside `BookingFlow` |
| `/watch/[id]` | shell yes, stream no | `LiveViewer.tsx:113` → `/api/live/:id/join` with auth; has a `'noticket'` phase |
| `/[username]/[slug]` | yes — **but it is the hardcoded mockup** | `[slug].astro:1-8` |

**So the "shareable link" half of the vision already works.** The page opens for anyone.
Everything past "Join now" is what is missing.

### 5.7 What the guest flow needs, minimally

1. A second accepted credential in a `requireBuyer`-style gate. The HMAC guest token
   already exists (`ladder.ts:40`) and only needs to be honoured on a narrow allowlist of
   routes — not a new auth system.
2. An inbound Indian gateway (order-create + signed webhook). **Entirely greenfield, and
   blocked on the Cashfree/registered-business decision.**
3. `commercial_entitlements.account_id` accepting an opaque buyer token, plus the four
   readers above taught to accept it.
4. A direct-charge branch in `commercialCheckout` that skips `hold()` when the gateway
   webhook has already confirmed payment — and that still writes the same escrow ledger
   rows, so settlement, split and refund all keep working unchanged.
5. `streamUserToken` (`stream_video_calls.ts:250`) and `upsertProviderUser` given a non-uid
   Stream identity for guests.
6. `affiliateBind` able to attribute against the same opaque token.
7. A contact channel for the guest (email or phone) so a receipt and a rejoin link can be
   sent — currently the only notification path is `commercial_notifications.ts` keyed by uid.

---

## 6. Prioritized gap list

### P0 — money correctness, before any commercial flag is flipped

1. Create the `role='creator'` entitlement for consults (P0-1). Without it the paid consult
   product does not exist.
2. Stop binding a shared live session to one buyer's `order_id` (P0-2). Session authority
   should be listing+creator+call-identity; per-ticket `order_id` belongs on the member/
   interval row, not the session row.
3. Produce the three missing refund percentages into the policy snapshot, and add an admin
   route to resolve `review_pending` (P0-3).
4. Unify the four commercial flags into one gate, or flip them strictly together (§4.4).
5. Confirm `avatok-consumers` is deployed and draining `wallet-transactions` before any
   real money enters escrow.
6. Add affiliate settlement to the commercial release path.

### P1 — make the web pipeline able to produce a publishable listing

7. Extend the web create form to the fields publish actually requires: **category
   (chosen, not defaulted), cover photo upload, start time + duration for live events,
   capacity for consults**.
8. Build the missing step-2 page (photos) and a publish action in `web/`.
9. Handle `identity_required` and `identity verification required` in web — open the
   liveness flow instead of printing the error code. Fix the copy at `CreateListing.tsx:100`.
10. Wrap `CreateListing` in `RequireAccount` as its own comment already claims.

### P2 — card parity

11. Bring the web `Card` interface up to the Dart `ListingCard` (duration, language,
    location, favourite, capacity, verified). Closes ~half the card gap with no schema change.
12. Add the form fields for `spoken_lang`, `location`, `adults_only`.
13. Extend `price_semantics` with per-minute and per-hour, and give the card a real price
    slot instead of baking the price into the title string.
14. New schema for: seats-taken (slots left), concurrent watchers, response-time SLA,
    repeat/satisfaction %, followers-on-card.
15. Decide the recurring-event and multi-slot model — the comps assume both, the schema has
    neither (one `starts_at`, one `duration_min` per listing).
16. Decide where fee + GST live. The comp computes `base + ₹6 + 18%`; the pipeline has no
    fee or tax model at all, and `upi_payout.ts` already carries `tax_pending: true` with a
    NULL TDS field.

### P3 — the guest-pay pivot

17. Pick the gateway (Cashfree is the expected answer per `CLAUDE.md`) — everything else is
    blocked on it.
18. Then items 1–7 in §5.7.
19. Separately: fix the already-broken `requireGuestAuth` in `web/src/lib/clerk.tsx`.

### Also flagged, outside the ask

20. **`shellV2` is `true` in production** while `CLAUDE.md` documents it as `false` and warns
    that flipping it ships AskAva with no kill switch. Verify AskAva is not now reachable.
21. `/marketplace` and `/<username>/<slug>` serve hardcoded mockups to real visitors today.
    Every card links to the same demo listing (`marketplace.astro:36-38`).

---

## Appendix — what was searched for and NOT found

- No `tickets` or `slots` table (`commercial_entitlements` + `commercial_session_members`
  play that role).
- No per-minute/duration billing in the commercial lane.
- No affiliate commission on any commercial order.
- No `creator_cancel_refund_pct` / `late_cancel_refund_pct` / `provider_failure_refund_pct`
  producer anywhere.
- No admin route to resolve `commercial_settlement_jobs.state='review_pending'`.
- No auto-runner for the commercial migrations.
- No Razorpay / Cashfree / PhonePe / Paytm / PayU / Instamojo / Juspay integration, SDK,
  credential or env var.
- No inbound UPI of any kind.
- No magic-link, one-time-access-token, or signed-purchase-token admission credential.
  `JOIN_LINK_SECRET` signs display-only ICS links and post-auth room tokens.
- No `requireUserOrGuest` or optional-auth variant of `requireUser`.
- No web page or route for publishing a listing or uploading listing media.
- No handling of `identity_required` anywhere in `web/`.
- No `promo`/discount or tags array on the new card comps (Dart-only `promoPct`; categories
  are single-valued everywhere).
