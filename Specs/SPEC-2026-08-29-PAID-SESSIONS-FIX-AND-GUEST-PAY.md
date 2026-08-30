# SPEC 2026-08-29 — Paid sessions: fix what's broken, then build guest pay

**Status:** approved to build, phased.
**Supersedes nothing.** Sits under `Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md`
and implements the parts of it that the audit found missing or broken.
**Evidence base:** `Specs/AUDIT-2026-08-29-create-listing-pipeline-and-guest-pay.md`.
Every file:line in this spec was read on 2026-08-29, not recalled.

**Owner decisions taken 2026-08-29:**
1. **Liveness is off for creators, but NOT for stranger DMs.** A per-action carve-out,
   not a global flag flip. (`identityGatingEnabled` is one global switch and
   `config.ts:1943-1948` names the ungated first-message-to-a-stranger path as the
   confirmed CSAM-risk hole. That gate stays.)
2. **The payment gateway is Cashfree.** Stripe India requires a registered company and
   avaTOK is unregistered; Cashfree onboards unregistered merchants.
3. **One listing is one event.** A repeating show is N listings produced by a repeat
   helper. No `listing_sessions` table, no change to the booking grain. See
   `[CARD-SLOTS-1]`.
4. **18% GST is charged on top of the listing price.** Built now, **collected only once a
   GSTIN exists** — see `[TAX-GST-1]` for why that gap is deliberate.
5. **Buyers get a real account, via Clerk email OTP — no password field.** The earlier
   "no account at all" framing is retired. An email and a 6-digit code is close enough to
   frictionless, and it collapses most of Phase 4 (see the note at the head of Phase 4).
   **We never build our own password handling** — Clerk owns credentials.
6. **Refunds reverse to the source UPI handle by default**, with wallet credit as an
   opt-in. Refund-to-wallet-only was rejected: `upi_payout.ts:53,60` requires Stripe KYC,
   a verified VPA, admin approval and a **₹1,000 minimum**, so a ₹49 refund parked in a
   wallet is unrecoverable by the buyer. That lane is built for creator earnings, not for
   giving a customer their money back.

---

## BUILD LOG — 2026-08-29

Nothing below is deployed. Everything is committed to `main` and typechecks clean
(`npx tsc --noEmit` in `worker/`, `tsc -p tsconfig.json` in `web/`,
`flutter analyze` on the one touched Dart file).

| Issue | State |
|---|---|
| `[LIVE-CARVE-1]` | ✅ built — plus a **second wall** found at publish (`requireKyc` reads `kyc_status`, a different table) and given its own flag |
| `[COMM-CONSULT-ENT-1]` | ✅ built — also made `entitlement()` role-aware, removing a non-determinism the fix would otherwise have introduced |
| `[COMM-LIVE-AUTH-1]` | ✅ built — migration `2026-08-29-commercial-member-order-id.sql` |
| `[COMM-REFUND-POL-1]` | ✅ built — 3 flags, a new `no_refund` outcome, and the admin route. `provider_outage` was also reading the *creator-cancel* percentage; fixed |
| `[COMM-FLAG-UNIFY-1]` | ✅ built — `lib/commercial_lane.ts`, three states, `mixed` refuses loudly |
| `[COMM-AFFIL-1]` | ⛔️ rescoped → `[GUEST-AFFIL-BOUNTY-1]` (Phase 4). `settleAffiliate` is a **no-op** |
| `[TAX-GST-1]` | ✅ built, collection OFF — migration `2026-08-29-commercial-gst.sql` |
| `[LIST-WEB-FORM-1]` `[LIST-WEB-MEDIA-1]` `[LIST-WEB-PUBLISH-1]` `[LIST-IDGATE-UX-1]` | ✅ built as one commit |
| `[CARD-MODEL-1]` `[CARD-PRICE-SEM-1]` | ✅ built — **found two live production bugs**, see below |
| `[CARD-SLOTS-1]` | ✅ built — `POST /api/listings/:id/repeat`, migration `2026-08-29-listings-series-id.sql` |
| `[PAY-CASHFREE-1]` | 🚧 **rail only, fenced.** Escrow funding works; the entitlement handoff does not exist, so order creation returns 503 regardless of flags |
| `[PAY-HANDOFF-1]` | ⬜️ NEW, blocks the rest of Phase 4 |
| `[BUY-OTP-1]` | ⬜️ not started |
| `[PAY-REFUND-1]` | 🚧 ledger primitive `refundExternal` exists; not wired into `commercial_lifecycle` |
| `[BUY-CHECKOUT-1]` `[GUEST-AFFIL-BOUNTY-1]` | ⬜️ not started |
| `[CARD-SCHEMA-1]` `[COMM-NOSHOW-1]` | ⬜️ not started |

**Three live bugs found while building, none of them in the original audit:**

1. **Every listing card on avatok.ai renders an empty placeholder.** `Card` declared
   `poster`, `rating`, `currency`, `creator.avatar` — four fields `shapeCard()` has never
   sent. `request<CardPage>` casts without validating, so it typechecked and read
   `undefined`. Fixed in `[CARD-MODEL-1]`.
2. **`ListingTile` printed `$` and divided by 100 above 1000**, so a ₹1,500 listing showed
   as `$15`. Fixed in the same change.
3. **A second identity wall at publish.** Relaxing liveness alone would have left every
   publish 403ing on `kyc_status` one step later — fixed-looking and still broken. Fixed
   in `[LIVE-CARVE-1]`.

**And one correction to the audit:** `settleAffiliate` is not merely uncalled from the
commercial lane, it is an **empty function**. Wiring it would have shipped green and paid
nobody. See `[COMM-AFFIL-1]`.

**Before any of this reaches production:** six migrations are pending and **none is
auto-applied** — `2026-08-29-commercial-member-order-id.sql`, `-commercial-gst.sql`,
`-listings-series-id.sql`, `-direct-purchases.sql`, plus the two pre-existing 2026-08-24 /
08-25 commercial migrations. Every one is a deliberate, announced step.

---

## 0. Plain English — what we are doing and in what order

Five phases. Each one is shippable on its own and leaves the product working.

**Phase 0 — Get you unstuck (half a day).**
Right now you cannot even create a draft listing: the server demands a face-scan
("liveness") first. We switch that check off for creating and publishing listings, while
keeping it on for messaging strangers. You'll be able to make listings again.

**Phase 1 — Fix the money before anyone can spend any (a few days).**
The paid-sessions code is switched off in production, and that is lucky, because three
bugs would take real money and give nothing back. A paid 1:1 consult literally cannot
run — the expert is never given a pass to their own session. A paid live event only lets
*one* ticket holder in; everyone else is refused at the door while the creator still gets
paid. And nearly every cancellation freezes the money in a "needs a human" state with no
screen for a human to use. We fix all three, plus pay affiliates their cut, which they
currently never get.

**Phase 1B — 18% GST. A day or two, built but switched off.**
Your card design shows tax and the system charges none, so we build the tax line into
every price and every receipt. It stays **switched off until avaTOK has a GSTIN**. That is
not caution for its own sake: collecting a tax you have no registration number for, and
printing it on a receipt, is the kind of thing that is hard to unwind later. The code will
be ready the day the registration comes through. I'm not a tax adviser — please put this
one past an accountant before switching it on.

**Phase 2 — Make the website able to create a real listing (a few days).**
The web form asks four questions. Publishing requires seven answers. So every listing
made on the website is stuck as a draft forever — there isn't even a Publish button. We
add the missing fields (category, photos, date and time, length, seats), the photo upload,
and the publish step.

**Phase 3 — Make listings look like your new cards (about a week).**
Your new card design shows about twenty things. The database can currently supply about
eleven of them. We wire up the eleven, then add storage for the rest — seats left, people
watching, response time, repeat-customer rate — and decide how repeating events work,
because the design assumes them and the database has no idea they exist.

**Phase 4 — Anyone with a link can pay by UPI and walk in (about a week and a half).**
This is the new part, and owner decision 5 made it much cheaper than first scoped. Today
buying needs an account **and** a topped-up token wallet. We remove the wallet step, not
the account: at checkout the buyer types an email, gets a 6-digit code, and pays by UPI in
one go. No password, no top-up, no separate signup trip. Because they end up with a real
account, everything downstream — the ticket, the door, affiliate credit, the receipt —
uses machinery that already exists and only needs the money half rebuilt. Money still
flows through the same escrow and the same 80/20 split fixed in Phase 1; we are adding a
way to pay *in*, not a second money system.

**How to follow progress.** Every commit starts with an issue id in square brackets, and
every id below has a "Done when" line that is a fact you can check, not an opinion. When
I say something is done I will quote that fact.

---

## 1. Ground rules for this build

- **`flutter analyze` before every commit touching `app/`.** The local toolchain is back
  (verified 2026-08-27); CI is a 40–80 minute round trip and is not the place to find a
  type error.
- **`npx tsc --noEmit` in `worker/` before every `cf.sh worker deploy`.** Wrangler strips
  types without checking them; a deploy can be green on code that does not compile.
- **Commit worker source before deploying it.** The tree is shared by several agents.
- **Every new `RemoteConfig` getter needs a key in the `PlatformConfig` interface AND in
  `DEFAULTS` in `config.ts`, in the same change.** A flag the client reads that `config.ts`
  does not declare is a fake flag — `putConfig` rejects it with 400 and the client's
  fallback becomes its permanent value. Prove each new flag with
  `ALLOW_PROD=1 scripts/flags.sh set <key>=false` (must not 400) and a cache-busted
  `/api/config` read.
- **Every issue below gets a `tool/ship_manifest.json` entry before its build goes out**,
  using the `success[]` assertions written into each section. Do not run
  `--update-baseline`.
- **Never state a live flag value from `config.ts`.** Read prod.

---

## PHASE 0 — Liveness carve-out

### `[LIVE-CARVE-1]` Creators stop being face-scanned; stranger DMs still are

**Problem.** `createListing` calls `identityGate` at `worker/src/routes/listings.ts:617`,
before anything else. `gatePublicAction` (`worker/src/lib/identity_gate.ts:161-205`) reads
one global boolean, `identityGatingEnabled` (`:169`), which is `true` in prod. With no
verified `identity_proofs` row the caller gets
`{ error: "identity_required", reason: "never_passed", action: "listing" }` 403. That is
the error in the owner's screenshot.

Turning `identityGatingEnabled` off would fix it — and simultaneously ungate `dm_stranger`,
`call_stranger`, `post`, `comment`, `forward`, `upload`, `group_*`. `config.ts:1943-1948`
is explicit that the ungated stranger-DM path was "the confirmed root cause of the
CSAM-risk hole". **We do not flip it.**

**Change.** Split `PublicAction` into two enforcement classes inside `identity_gate.ts`,
governed by two booleans instead of one.

```ts
// identity_gate.ts — new, next to the PublicAction type at :44
/** Actions that publish content the author chose to make public. */
const CONTENT_ACTIONS: ReadonlySet<PublicAction> = new Set([
  "post", "listing", "comment", "live", "group_post", "group_create", "upload", "forward",
]);
/** Actions that push the actor at a person who did not ask for them. Never ungated
 *  by the content switch — see config.ts:1943-1948. */
const CONTACT_ACTIONS: ReadonlySet<PublicAction> = new Set([
  "dm_stranger", "call_stranger", "group_join",
]);
```

In `gatePublicAction`, after the existing `identityGatingEnabled` read at `:169`, add:

```ts
if (on && CONTENT_ACTIONS.has(action)
    && (await readConfig(env)).identityGateContentActionsEnabled !== true) {
  void trackUserContact(env, uid, email, null, "identity_gate_content_exempt", APP, { action });
  return null;
}
```

Keep the whole existing fail-closed posture untouched below that. `CONTACT_ACTIONS`
gets no exemption path at all — not a flag, not a config key. A future action added to
`PublicAction` and to neither set falls through to the strict path, which is the correct
default.

**Flag.** New boolean `identityGateContentActionsEnabled`, **default `true`** (so the
default preserves today's behaviour and only an explicit KV override relaxes it).
Declare in the `PlatformConfig` interface near `identityGatingEnabled`
(`config.ts:958`) and in `DEFAULTS` near `config.ts:1954`. Boolean, so no `numericKeys`
entry.

**Rollout.** Deploy, then `ALLOW_PROD=1 scripts/flags.sh set identityGateContentActionsEnabled=false`.
That is a deliberate production write and must be announced as one.

**Also in this issue — the client half.** `RemoteConfig.listingLivenessGate`
(`app/lib/core/remote_config.dart:564`) drives the Flutter app's own pre-emptive liveness
prompt at `marketplace_hub.dart:22` and `ava_shell.dart:384`. Leaving it `true` means the
app still opens the camera before calling a server that no longer cares. Set
`listingLivenessGate=false` in prod KV in the same step. No app rebuild is needed — it is
read from remote config.

**Done when.**
- `POST /api/listings` with a uid having no `identity_proofs` liveness row returns
  `200 {status:"draft"}`, not 403.
- PostHog: `identity_gate_content_exempt` present with `action=listing`; and
  `identity_gate_hit` **still** present with `action=dm_stranger` for an unverified user.
  The second assertion is the one that matters — it proves we carved rather than gutted.
- `ALLOW_PROD=1 scripts/flags.sh set identityGateContentActionsEnabled=false` does not 400.

**`ship_manifest.json`:** `two_sided: false`, `min_devices_on_build: 1`,
`flags: ["identityGatingEnabled","identityGateContentActionsEnabled","listingLivenessGate"]`.

> **Not deleted.** Didit, `identity_proofs`, `recordLivenessPass()` and the whole liveness
> flow stay compiled and working. This is a switch, not a removal — KYC at payout
> (`requireKyc`, `authz.ts:56`) is a separate gate and is **not** touched here.

---

## PHASE 1 — Money correctness

Nothing in this phase is user-visible while the commercial flags are `false`. All six are
`false` in prod today. **Do not flip any of them until every issue in this phase is done
and its "Done when" is proven.**

### `[COMM-CONSULT-ENT-1]` The consult creator has no ticket to their own session

**Problem.** Consult join requires `grant.role === 'creator'` for the creator
(`commercial_stream_sessions.ts:541-548`). There are exactly two
`INSERT INTO commercial_entitlements` in the repo — checkout writes `viewer`/`buyer` for
the **buyer** (`commercial_checkout.ts:545-550`), and live-event **hosts** self-grant
`host` (`commercial_stream_sessions.ts:455-459`). No row with `role='creator'` is ever
written. The creator gets 403 `"booking entitlement required"`, the session never happens,
`commercial_settlement.ts:113-128` finds zero creator×buyer overlap, and the job lands in
`review_pending` with the buyer already debited.

Same root cause breaks paid extensions: `commercial_stream_sessions.ts:827-835` requires
two entitlements on the booking and can never see them, so every extension charges then
auto-refunds.

**Change.** In `commercialCheckout`, in the consult branch, write a **second** entitlement
alongside the buyer's, in the same batch at `commercial_checkout.ts:544-550`:

```ts
// consult only: the creator's own admission. Same booking, same order, role='creator',
// state mirrors the buyer's. The UNIQUE(kind,listing_id,booking_id,account_id,role) key
// makes this idempotent under INSERT OR IGNORE exactly like the buyer row.
entitlement_id: `commercial-entitlement:${orderId}:creator`,
account_id: listing.creator_id,
role: 'creator',
state: price > 0 ? 'held' : 'reserved',
```

Then extend the post-write verification at `:583-586` to assert **both** rows exist and
carry the expected `account_id`/`role`, so a partial write cannot authorize a session.

**Alternative considered and rejected:** a lazy self-grant at join time, mirroring the
live-event host pattern at `:455-459`. Rejected because the host grant is what makes
P1's `[COMM-LIVE-AUTH-1]` bug possible (a NULL `order_id` on a shared session), and
because an entitlement created at checkout is covered by the refund and lifecycle paths
that already sweep `commercial_entitlements` by `order_id`
(`commercial_lifecycle.ts:245-268`); one created at join time is not.

**Migration.** None. Existing orders are unaffected — the commercial lane has never been
live, so there are no rows to backfill. **Verify that claim before shipping** with
`SELECT COUNT(*) FROM commercial_entitlements WHERE kind='consult_1to1'` against prod D1;
if it is non-zero, write a backfill.

**Done when.**
- Two rows in `commercial_entitlements` for one consult checkout: `role='buyer'` /
  `account_id=<buyer>` and `role='creator'` / `account_id=<creator>`.
- Both parties reach `commercialConsultJoin` with 200.
- PostHog `commercial join` event: `outcome=authorized` for **both** `role=creator` and
  `role=buyer` on the same `booking_id`. Absence of
  `reason=entitlement_role_mismatch` is the failure value to assert against.
- A settled consult produces a `commercial_settlement_jobs` row reaching `state='settled'`,
  **not** `review_pending`.

**`ship_manifest.json`:** `two_sided: **true**`, `min_devices_on_build: 2`. This is a
two-sided feature — ship-gate rule 2 applies, count DISTINCT persons on the newest
`$app_build` before saying it works.

### `[COMM-LIVE-AUTH-1]` Only one ticket holder can enter a live event

**Problem.** `authorizeProviderJoin` stamps the first joiner's per-buyer `order_id` onto
the **shared** session row (`commercial_stream_sessions.ts:336`) and then re-verifies it
for every subsequent joiner (`:368`):

```ts
|| (persistedSession.order_id ?? null) !== (args.orderId ?? null)
... return refused("session_authority_mismatch", { error: "commercial session authority mismatch" }, 409);
```

Live join passes `orderId: grant.order_id` (`:500`), unique per ticket. So buyer #2 is
refused. If the **host** joins first, the session `order_id` is `NULL` (the host
entitlement stores NULL, `:458`) and **every** paying viewer is refused.

This is a money bug, not an availability bug: live settlement checks **host** connected
time only (`commercial_settlement.ts:96-151`), so the creator is paid 80% and the platform
takes 20% while refused buyers have no automatic recourse.

**Change.** `order_id` is per-purchase and does not belong on a shared session row.

1. Drop `order_id` from the identity comparison at `commercial_stream_sessions.ts:363-375`.
   Session authority becomes exactly: `commercial_session_id`, `kind`, `listing_id`,
   `booking_id`, `creator_id`, `provider`, `provider_call_type`, `provider_call_id`,
   `scheduled_at`. That set is already sufficient — it is what the pre-insert check at
   `:300-306` uses, and it is derived from the listing, not from any buyer.
2. Keep `commercial_sessions.order_id` populated **only for `consult_1to1`**, where the
   session genuinely is one order. For `live_event`, insert `NULL` at `:336`.
3. Record the per-ticket order on the member row instead —
   `commercial_session_members` already exists
   (`2026-08-24-commercial-stream-sessions.sql:93`). Add `order_id TEXT` and
   `entitlement_id TEXT` to it via a new migration, and write them on every join. That
   preserves the audit trail this check was reaching for, at the right grain.
4. `commercial_participant_intervals` rows must carry the same `order_id`, so settlement
   can attribute attendance per ticket later (needed by `[CARD-SCHEMA-1]`'s seats-taken
   and by any future per-buyer refund).

**Why not simply relax the comparison to allow NULL.** Because the check exists to stop a
concurrent insert authorizing against a different session authority, and weakening it to
"NULL matches anything" would let a host-created session admit a viewer whose ticket is
for a different listing. Removing the field from the authority set and moving it to the
member row keeps the guarantee and fixes the grain.

**Done when.**
- Three distinct ticket holders plus the host all reach `authorizeProviderJoin` 200 on one
  `live_<listingId>_<sessionVersion>` call.
- PostHog: `commercial join` with `outcome=authorized` and **three distinct** `distinct_id`
  values with `role=viewer` on one `listing_id`; **zero** events with
  `reason=session_authority_mismatch`. That reason string appearing at all is the failure
  value.
- `commercial_session_members` has one row per joiner carrying its own `order_id`.

**`ship_manifest.json`:** `two_sided: true`, `min_devices_on_build: 3`. Rule 2 with teeth
— this bug is invisible with fewer than two paying viewers, which is exactly how it
survived review.

### `[COMM-REFUND-POL-1]` Cancellations freeze money with no way to unfreeze it

**Problem.** `commercial_lifecycle.ts:119-142` auto-refunds only when the policy
percentage is exactly `100`. The policy snapshot written at checkout
(`commercial_checkout.ts:179-223`) carries **none** of `creator_cancel_refund_pct`,
`provider_failure_refund_pct`, `late_cancel_refund_pct`. So creator cancel, creator
no-show, provider outage and every late buyer cancel all resolve to `review_pending` (202).
There is **no admin route in the commercial lane** to resolve `review_pending` — only the
generic `adjust()` (`ledger.ts:138`).

Separately, the public route can only ever emit `creator_cancel` or `buyer_cancel`
(`commercial_lifecycle.ts:542`), so `no_show_policy` is unreachable from the product.

**Change, three parts.**

1. **Produce the three percentages into the snapshot.** New config keys, all integers, all
   requiring a `numericKeys` entry in `config.ts`:
   | Key | Default | Meaning |
   |---|---|---|
   | `commercialCreatorCancelRefundPct` | `100` | creator cancels → buyer made whole |
   | `commercialProviderFailureRefundPct` | `100` | GetStream/infra failed → buyer made whole |
   | `commercialLateCancelRefundPct` | `0` | buyer cancels after the window → creator keeps it |
   Write them into `commercial_policy_snapshots` at checkout alongside the existing
   `refund_window_hours` etc. **The snapshot is immutable by design** — a listing sold
   under one policy settles under that policy even if the flag changes later. That is the
   whole point of the snapshot and must not be "simplified" into a live config read at
   settlement time.
2. **Make the failure states reachable.** Extend the lifecycle action derivation at
   `commercial_lifecycle.ts:542` beyond the creator/buyer identity test: a creator who
   never produced 60s of connected time by `ends_at` is `creator_no_show`
   (derivable from `commercial_participant_intervals`, the same evidence
   `commercial_settlement.ts:96-151` already trusts); a session whose provider events
   terminated abnormally is `provider_outage`. Both should be produced by the settlement
   cron, not by a client claim.
3. **Build the admin resolution route.** `POST /api/admin/commercial/claims/:orderId`
   taking `{ decision: "refund"|"release"|"split", note }`, admin-gated exactly as
   `admin_money.ts` is, writing through `refund()`/`release()` and stamping
   `commercial_money_claims`. Without this, `review_pending` is a black hole and every
   edge case becomes a support ticket with no tool behind it.

**Done when.**
- A creator-cancelled paid booking auto-refunds: `commercial_refund_receipts` row written,
  order `refunded`, buyer balance restored.
- A late buyer cancel produces `review_pending`, and the new admin route moves it to a
  terminal state.
- PostHog `commercial_lifecycle`: `outcome=refunded` present for `action=creator_cancel`.
  The failure value to assert against is `reason=creator_cancel_policy_missing` — its
  presence means the snapshot still lacks the percentage.
- `ALLOW_PROD=1 scripts/flags.sh set commercialCreatorCancelRefundPct=100` does not 400
  (proves the `numericKeys` entry landed).

### `[COMM-FLAG-UNIFY-1]` Two lanes can take money for the same listing

**Problem.** The legacy `bookListing` fence reads `commercial*ListingsEnabled`
(`listings.ts:81-88`); commercial checkout reads `commercial*CheckoutEnabled`
(`commercial_checkout.ts:225-229`). Enable checkout without listings and **both** lanes
accept money for one listing into two independent escrow buckets (`ord_*` and
`commercial-order:*`).

**Change.** One derived predicate, `commercialLaneOn(env, kind)`, read by both files, that
requires **both** flags to be true and returns 503 when they disagree — a disagreement is
a misconfiguration and should be loud, not silently permissive. Keep all four flag keys
(they are already in prod KV; renaming would silently revert them to defaults) and change
only who reads them and how they combine.

**Done when.** With `commercialLiveCheckoutEnabled=true` and
`commercialLiveListingsEnabled=false`, both `POST /api/listings/:id/book` and the
commercial checkout route return 503 — neither takes money. PostHog:
`commercial_lane_misconfigured` emitted with both flag values.

### `[COMM-AFFIL-1]` ⛔️ RESCOPED 2026-08-29 — this is a product decision, not a wiring job

**The audit was right that affiliates earn nothing on ticket sales and wrong about why**,
and the difference changes what to build. Corrected on reading the code:

`settleAffiliate` (`worker/src/routes/affiliate.ts:1094-1109`) **is a no-op**. Its body is
a comment and `return 0`:

> *"PURCHASE COMMISSIONS RETIRED (2026-06-18). Affiliates now earn 10% of their referred
> users' TOP-UPS for life (`payAffiliateOnTopup`) instead of a cut of listing purchases.
> No-op so the existing callers (money_engine, avavision, avavoice) keep compiling
> without paying purchase commissions."*

So calling it from `commercial_settlement.ts` — the fix this issue originally proposed —
**would pay nobody anything.** It would look like a fix, ship green, and change no money.
That is precisely the failure mode `tool/check_ship_readiness.py` exists to catch, and it
is worth noting that a manifest entry asserting "a ledger row appears" would have caught
it while one asserting "settleAffiliate was called" would not.

The live model is: **10% of a referred user's top-ups, for life**, paid by
`payAffiliateOnTopup` (`affiliate.ts:841`), called from exactly two places, both in
`wallet.ts` (`:622` Play top-up, `:771` Stripe top-up). Caps
`affiliateDailyEarnCapCoins` / `affiliateMonthlyEarnCapCoins` /
`affiliatePerReferredCapCoins` are live in prod.

> ### 🚨 The collision with Phase 4
>
> **The affiliate program is paid out of top-ups, and Phase 4 removes top-ups.**
>
> The whole point of `[PAY-CASHFREE-1]` is that a buyer pays ₹ per ticket by UPI and never
> funds a wallet. If they never top up, `payAffiliateOnTopup` never fires. An affiliate
> who drives a thousand ticket sales through their link earns **zero** — while the
> attribution machinery dutifully records every one of them.
>
> This is not a bug in either system. It is two correct designs that assume different
> things about how money enters, and the pivot is what put them in the same room.

**Owner decision required. Three options:**

- **(a) Un-retire purchase commissions for the commercial lane only.** Implement a real
  body for the commercial path, funded from the **platform's 20%**, never the creator's
  80% (`money_engine.ts:145` shows the intended shape: `platformCut` is the source).
  Existing caps apply. Cost: the 2026-06-18 decision to retire purchase commissions is
  partially reversed, and two commission models coexist.
- **(b) Pay the affiliate a percentage of the guest's first purchase**, once, at Cashfree
  webhook time — a referral bounty rather than a commission. Simpler than (a), does not
  touch settlement, and does not resurrect a retired model.
- **(c) Accept that affiliates earn only from top-ups.** Coherent only if buyers still
  top up, which Phase 4 is designed to stop. Effectively ends the affiliate program for
  the new traffic.

### ✅ DECIDED 2026-08-29 (owner) — option (b), a first-purchase bounty

**Moved out of Phase 1 into Phase 4 as `[GUEST-AFFIL-BOUNTY-1]`**, because the natural
place to pay it is the Cashfree webhook, which does not exist yet. `settleAffiliate` stays
a no-op and `commercial_settlement.ts` is **not** touched — purchase commissions stay
retired.

Shape: when a Cashfree payment settles for a buyer carrying a pending affiliate
attribution (the `ava_aff_dev` cookie, KV, 30 days — `affiliate.ts:40`, `:571-575`), pay
the affiliate a percentage of that **first** purchase, once, funded from the platform's
20%, never the creator's 80%. Idempotent on the purchase id. The existing caps
(`affiliateDailyEarnCapCoins`, `affiliateMonthlyEarnCapCoins`,
`affiliatePerReferredCapCoins`) apply unchanged, and the bounty percentage gets its own
flag. `reverseAffiliate` (`affiliate.ts:1114`) already exists and must be called when that
first purchase is refunded, or a cancelled event pays a bounty on money the buyer got back.

**Do not wire the no-op.** It would look done and pay nobody.

---

## PHASE 1B — Tax

### `[TAX-GST-1]` 18% GST — built now, collected when there is a GSTIN

**Owner decision 2026-08-29: charge 18% GST on top of the listing price.**

> ⚠️ **Compliance flag, and I am not a tax adviser.** In India, GST is collected against a
> **GSTIN**, and avaTOK has none — `Specs/`/`CLAUDE.md` record that no company is
> incorporated and that registration in Mumbai is still in process. Collecting a tax under
> no registration number, and printing "GST" on a receipt, is materially harder to unwind
> than not charging it. **Build the engine now; keep collection behind a flag that stays
> `false` until a GSTIN exists, and have an accountant confirm the rate, the place-of-supply
> rules and the invoice format before it is switched on.** The 18% figure comes from the
> card comp (`design/live-streaming/avaTOK Listing Details.dc.html:762`), not from advice.

**Problem.** The pipeline has **no fee and no tax model at all**. The comp computes
`base = 49 × qty`, `fee = 6`, `gst = 18%`, `total` — entirely in the mockup's JavaScript.
Meanwhile `commercial_checkout.ts:429-436` splits exactly `price` into creator 80 /
platform 20 with nothing above it, and `upi_payout.ts:42-47` already carries an unresolved
outbound tax question (`tds_inr_paise: NULL`, `tax_pending: true`). Adding an inbound tax
without deciding the outbound one leaves the two halves inconsistent.

**Change.** One tax computation, applied at the single point where an amount is
first fixed — checkout — and frozen into the policy snapshot exactly as the split is:

```
listing price      = P          (what the creator set, what the card shows)
platform fee       = F          (0 today; the comp's flat ₹6 is NOT adopted here)
taxable base       = P + F
gst                = round((P + F) × gstRatePct / 100)
buyer pays         = P + F + gst
escrow             = P + F                 ← the existing 80/20 split runs on THIS
gst                → acct 'platform:tax'   ← never enters escrow, never splits
```

Non-negotiable properties of that shape:

- **GST never enters escrow and is never split with the creator.** It is not revenue. A
  design where the creator's 80% is computed off a tax-inclusive number silently pays
  creators out of tax money.
- **The creator's payout is unchanged by the tax.** `P` is what they set and 80% of `P`
  (plus fee handling) is what they earn, whether GST is on or off. Assert this in a test —
  it is the property most likely to break quietly.
- **The rate is snapshotted per order.** `commercial_policy_snapshots` gains
  `gst_rate_pct`, `gst_amount`, `taxable_base`. A rate change never retroactively alters a
  sold ticket, for the same reason the refund percentages are snapshotted.
- **Refunds return the tax too.** `commercial_refund_receipts` must reverse
  `P + F + gst`, not `P + F`. This is easy to get wrong and expensive to discover.

**Flags.** `gstEnabled` (boolean, **default `false`**) and `gstRatePct` (integer, default
`18`, **needs a `numericKeys` entry** in `config.ts`). With `gstEnabled=false` the
computation runs and stores zeros, so the code path is exercised in production long before
it charges anyone.

**Display.** The price a card shows stays `P` — the tax appears at checkout and on the
receipt, itemised. `wallet_statement.ts:formatMoney` already renders ₹ correctly. Per
`[TOKENS-INR-1]`: the unit is a **token**, 1 token = ₹1, and no wallet or listing amount
ever prints a `$`.

**Also decide the platform fee `F` while here.** The comp shows a flat ₹6. Today `F = 0`
and the platform's income is the 20% split. Charging both a flat fee *and* a 20% cut is a
pricing decision, not an implementation detail — this spec sets `F = 0` until the owner
says otherwise, and the arithmetic above carries `F` so it can be turned on without
reshaping anything.

**Done when.**
- With `gstEnabled=false`: buyer is charged exactly `P`, and
  `commercial_policy_snapshots.gst_amount = 0`. Nothing about today's behaviour changes.
- With `gstEnabled=true` on staging: a ₹100 ticket charges ₹118; escrow holds 100;
  `platform:tax` holds 18; creator settles 80; platform settles 20. **Assert the creator's
  80 explicitly** — that it did not become 94.4 (80% of 118) is the whole test.
- A refund of that order returns ₹118 to the buyer and leaves `platform:tax` at 0.
- `ALLOW_PROD=1 scripts/flags.sh set gstRatePct=18` does not 400.

---

## PHASE 2 — Web create-listing to publishable

### `[LIST-WEB-FORM-1]` The form asks four questions; publishing needs seven

**Problem.** `web/src/islands/dashboard/CreateListing.tsx:59` sends
`{ kind, title, description, price }`. `publishListing` (`listings.ts:872-897`) requires
title, **category**, **≥1 cover photo**, and for `live_event` **`starts_at` (future) +
`duration_min` ∈ [5,480]**, for `consult` **`capacity` ∈ {1,10,20}** plus at least one
`availability_rules` row. Web drafts also silently inherit `category = "teachers"`
(`listings.ts:647`).

**The server accepts everything already.** `normFields` (`listings.ts:512-575`) takes 26
fields. This is a front-end gap, not an API gap.

**Change.** Extend the form to send, per kind:

| Field | Kinds | Control | Server key |
|---|---|---|---|
| category | all | select from `GET /api/listing-categories` (`active=1`) | `category` |
| starts_at | live_event | date + time, must be future | `starts_at` |
| duration_min | live_event | select 15/30/45/60/90/120 (clamp 5–480) | `duration_min` |
| capacity | consult | select 1 / 10 / 20 — no free entry, server rejects anything else | `capacity` |
| spoken_lang | all | multi-select | `spoken_lang` |
| location | all | free text | `location` |
| adults_only | all | checkbox | `adults_only` |

Also: **wrap the component in `RequireAccount`** (`web/src/islands/auth/RequireAccount.tsx:78`),
which `CreateListing.tsx:2` and `new.astro:4` already falsely claim is there.

Mirror the server's constraints client-side so the user is told before the round trip, but
**never rely on that** — the server checks are the authority and stay unchanged.

**Done when.** A listing created entirely through the web form satisfies every branch of
`publishListing:872-897` without any app or curl involvement.

### `[LIST-WEB-MEDIA-1]` There is no way to add a photo on the web

**Problem.** Publish requires `cover_media.length >= 1` (`listings.ts:879-881`,
`cover_required`). Grep of `web/src` for `cover_media` and `api/media` returns **zero
hits**. `CreatorListings.tsx:139` only renders a "No cover photo" placeholder. The worker
endpoints exist and are unused by web: `/upload/public`, `/upload/private`,
`/api/media/commit` (`worker/src/index.ts:1062-1064`).

**Change.** Build the step-2 page the form already promises at `CreateListing.tsx:100`
("Next you'll add cover photos and publish") and which does not exist — the directory
`web/src/pages/dashboard/listings/` contains only `index.astro` and `new.astro`.

Copy the app's working pattern rather than inventing one:
`app/lib/features/listings/create_listing_flow.dart:162-180` posts bytes to
`kUploadPublicUrl` with `x-content-type: image/jpeg`, reads `{url}`, appends to
`_coverUrls`. Web should `POST /upload/public`, collect the returned `url`s, then
`PUT /api/listings/:id` with `cover_media: [{type:'image', url}]` (the shape `normFields`
expects at `listings.ts:530` — note the schema comment in `migrations/listings.sql` says
`r2_key` and is **stale**; the route stores `{type,url}`).

Serve them through the Cloudflare image pipeline per the rulebook:
`/cdn-cgi/image/format=avif,quality=60,width=N,fit=cover/<path>`. `cfImage` already exists
on the web side and `ListingTile.tsx:67-69` already uses it.

**Done when.** A photo uploaded in the browser appears on the listing card in both web and
the Flutter app, and `publishListing` no longer returns `cover_required`.

### `[LIST-WEB-PUBLISH-1]` There is no Publish button

**Problem.** `web/src/islands/dashboard/CreatorListings.tsx:82` is the **only** mutation
web makes on a listing, and it is `status: 'cancelled'`. There is no call to
`POST /api/listings/:id/publish` anywhere in `web/`.

**Change.** Add the publish action and a real draft-review screen showing exactly what
publish will check, with each requirement ticked or not. Handle each server refusal by
name rather than dumping the code: `cover_required`, `unknown category`, `no_availability`
(link to AvaCalendar — the message already says so), `conflict` (show `conflictWith`),
`already published`, `renewal_required`, `insufficient_funds` (marketplace kinds only).

Note for live events: `listings.ts:763-765` refuses to move a published event
("cancel and re-create"). Say that in the UI *before* publish, not after.

**Done when.** A listing goes draft → published entirely from the browser, and each of the
seven refusal codes above renders as a sentence a non-developer can act on.

### `[LIST-IDGATE-UX-1]` Error codes are shown to users as error codes

**Problem.** Grep for `identity_required` across `web/` returns nothing, so
`apiClient` renders the raw string (`CreateListing.tsx:69`, `:95`) as `⚠ identity_required`.
There are two distinct gates with two different strings — `identity_required`
(liveness, at draft creation) and `identity verification required` (KYC, at publish) — and
web handles neither. The form's own copy at `:100-101` says the check happens at publish;
it does not.

**Change.** Intercept both in `apiClient`, render human sentences, and — when
`[LIVE-CARVE-1]` is later reverted or KYC bites at publish — open the relevant flow and
retry, which is the documented client contract (`identity_gate.ts:153-156`, already
implemented in `app/lib/features/identity/identity_gate.dart`). Fix the copy at `:100-101`.

**Done when.** No raw error code is ever rendered by the listings surface. Assert by
grepping the built output for the literal strings.

---

## PHASE 3 — Card parity

The newest card design is `web/src/landing/avatok-listings-catalogue.html` (2026-08-27
13:41). It and the `design/live-streaming/*.dc.html` comps are **100% hardcoded** and are
**served in production** at `/marketplace` and `/<username>/<slug>` via `renderMockupPage`
— every card links to the same demo listing (`marketplace.astro:36-38`).

### `[CARD-MODEL-1]` Bring the web card model up to the Dart one — no schema change

**Problem.** `web/src/lib/types.ts:7` `Card` carries 12 fields. The Dart `ListingCard`
(`app/lib/core/listings_api.dart:275`) carries 30+, including `durationMin`, `spokenLang`,
`location`, `favorited`, `capacity`, `promoPct`, `attrs`, `creator.kycVerified`. The
columns already exist and the API already returns them; web just drops them.

**Change.** Extend the `Card` interface and `CreatorRef` to match the Dart model's
overlapping fields, and render them in `ListingTile.tsx`. `ListingTile` currently also
ignores `rating`, `country`, `starts_at`, `ends_at` and `creator.avatar` which it already
receives.

**This is the highest ratio of card-gap closed to work done in the whole spec** — roughly
half the missing card fields, with zero migrations.

**Done when.** `ListingTile` renders duration, language, location, rating, start time,
creator avatar and verified tick from live API data.

### `[CARD-PRICE-SEM-1]` The cards price per hour and per minute; the model cannot

**Problem.** The catalogue mixes `₹50`, `₹50/hr`, `₹8/min`, `₹1,499` on cards.
`price_semantics` (`intent_theme.dart:261`) supports `asking | per_month | from | range |
none` — **no per-minute, no per-hour**. Separately, every comp bakes the price into the
title string (`"Antakshari Friday with Sunny · ₹49"`,
`design/live-streaming/avaTOK Marketplace.dc.html:242`; every `.card-title` in the
catalogue). Real data will not.

**Change.** Add `per_minute` and `per_hour` to `price_semantics` and give the card
template a separate price slot. Ensure the currency stays `₹` per `[TOKENS-INR-1]` — 1
token = ₹1, never a `$` on a wallet or listing amount.

**Done when.** A consult priced per minute renders `₹8/min` from `price` +
`price_semantics`, with the title containing no price.

### `[CARD-SCHEMA-1]` Seven card fields have no column anywhere

**Problem.** No column exists for: seats-taken (→ "3 slots left", "44 OF 60 FREE",
"HOUSEFULL"), concurrent watchers ("👁 428 watching"), response-time SLA ("● 12 min
response"), repeat/satisfaction rate ("♡ 98% felt heard", "♡ 96% come back"),
regulars ("♡ 420 regulars"), followers-on-card ("1.2K FOLLOW THIS SHOW" — `creator_follows`
exists but is detail-only), and any fee/GST model (the comp computes `base + ₹6 + 18%`).

**Change.** Split by cost, and do not build all of it:
- **Derive, do not store**: seats-taken (count `commercial_entitlements` for the listing —
  free once `[COMM-LIVE-AUTH-1]` puts `order_id` at the right grain); watchers (live count
  from `commercial_participant_intervals` open rows); followers (`creator_follows` count,
  already exists, just needs to reach the card payload).
- **Store, per creator not per listing**: response-time SLA and repeat rate. These are
  reputation, computed on a schedule into `creator_profiles`, not written by the creator.
  **Never let a creator type these in** — they are trust signals and self-declared trust
  signals are worthless.
- **Defer**: fee and GST. That is a pricing and tax decision, not a card field.
  `upi_payout.ts:42-47` already carries `tax_pending: true` with a NULL TDS field, so
  there is an existing open tax question this would collide with. Out of scope here; raise
  separately.

**Done when.** Cards show real seats-left and real watcher counts on a live listing.

### `[CARD-SLOTS-1]` The design assumes recurring events; the schema has one timestamp

**Problem.** The comps assume repeat schedules (`days:[7,14,21,28]`, "every Friday",
`availDays()`) and multiple slots per event ("MAIN SHOW · 90 MIN", "44 OF 60 FREE").
The schema has exactly one `starts_at` and one `duration_min` per listing.
`availability_rules` is **per-user, not per-listing**.

### ✅ DECIDED 2026-08-29 (owner) — one listing is one event

The rejected alternative, recorded so nobody re-opens it casually: a `listing_sessions`
table (`listing_id, starts_at, duration_min, capacity, taken, status`) with `claimBlock`
moved to the session. It is the honest model for recurring shows and the only one that can
support "44 OF 60 FREE" per slot — and it is a rewrite of the booking grain, touching
booking, entitlements, settlement, calendar and every card. **Not built speculatively.
Revisit when a real creator asks for it.**

**Change.** Keep one `starts_at` + one `duration_min` per listing. Add a **repeat helper**
built on the existing `duplicateListing` route (`listings.ts:1023-1053`, which already
copies a listing into a fresh draft): "repeat weekly for N weeks" produces N drafts with
shifted `starts_at`, each publishing and claiming its own calendar block independently.
Group them with a nullable `series_id TEXT` column on `listings` so a creator can manage or
cancel the set as one, and so a card *may* later say "weekly" truthfully — but every row
stays a standalone bookable event with its own seats and its own settlement.

**And make the cards stop implying the model we did not choose.** The comps currently
promise recurrence and per-slot seats the schema cannot express: `days:[7,14,21,28]` and
`availDays()` (`design/live-streaming/avaTOK Listing Details.dc.html:610`), the
`.availability-slot` dialog in the catalogue, and `slotDefs()` (`:617`) with its
`total`/`taken`/`left` → "44 OF 60 FREE" / "HOUSEFULL". Under one-event-per-listing,
seats-left is a single number for the whole listing (`[CARD-SCHEMA-1]`) and the multi-slot
picker has nothing behind it. Either remove those affordances from the card and detail
templates, or point them at the sibling listings in the same `series_id`.

**Done when.** "Repeat weekly ×4" from the web form produces four published listings, each
with its own calendar block and seat count, sharing one `series_id` — and no shipped card
or detail page renders a multi-slot picker.

---

## PHASE 4 — Link-to-seat checkout with Cashfree

The goal: someone holding a shared or affiliate link pays by UPI and joins, **without a
wallet top-up and without a separate signup trip**.

> ### 📉 Owner decision 5 shrank this phase by more than half
>
> The first draft of this spec built a whole parallel identity: an account-free HMAC
> ticket (`t1.…`), a `requireBuyer` gate, `account_id = 'guest:<purchaseId>'` taught to
> four readers, and a non-uid GetStream identity. **All of that is now unnecessary.**
> Because the buyer signs in with a Clerk email OTP *during* checkout, they have a real
> uid before the money moves — so the ticket, the door, the receipt, the affiliate
> attribution and the notification path are the code that already exists and already
> works.
>
> **What is actually left to build: the money.** Paying ₹ by UPI directly for a ticket,
> instead of topping up a token wallet and spending tokens.
>
> Do not "simplify" this back to an account-free ticket later without re-reading why it
> was dropped: every one of those four subsystems keys on a uid today, and a second
> identity type in the paid lane is four more places to get authorization wrong.

**The invariant for this whole phase: money still lands in the same escrow and settles
through the same 80/20 split built in Phase 1.** We are adding a way to pay *in*, not a
second money system. Any design where this money bypasses `commercial_settlement.ts` is
wrong.

### `[BUY-OTP-1]` Sign in inside checkout — email and a code, no password

**Owner decision 2026-08-29: Clerk email OTP. No password field, ever.** avaTOK's auth is
Clerk and Clerk owns credentials. Hand-rolling username/password storage would be a
serious security regression, and it is not on the table.

**Problem — and there is an existing bug here regardless of this phase.**
`web/src/lib/clerk.tsx:16` claims `requireGuestAuth()` resolves "a valid requireUser JWT".
**It does not.** `GuestGate` (`:233-289`) mints the HMAC guest token from
`/api/identity/guest` and then passes it to `/api/id/email/start` and
`/api/id/email/verify` — both of which call `requireUser` (`routes/id.ts:36`, `:77`) and
reject `g1.…` as a bad JWT → 401. `BookingFlow.tsx:74-77` depends on this. **Web checkout
cannot complete for a new visitor today, with or without Cashfree.** Fix this first; it is
the reason the current booking flow appears to work in code review and fails in practice.

**Change.** Replace the guest-token detour with Clerk's own email-code sign-in, rendered
inline in the checkout step rather than as a redirect to a sign-in page. The buyer types an
email, receives a 6-digit code, and is a real Clerk user with a uid and a wallet before the
payment step renders. `requireUser` then works everywhere with no new gate, no allowlist,
and no second credential type in the paid lane.

Keep the existing HMAC guest token (`ladder.ts:40-56`) exactly where it is — handle
reservation. It is not repurposed here.

**Done when.** A visitor who has never used avaTOK completes checkout in one page without
leaving it, and `POST /api/pay/cashfree/order` is called with a valid Clerk JWT. PostHog:
`checkout_identify` with `method=email_otp` and `outcome=verified`; the failure value to
assert against is any `401` on `/api/id/email/*`, which is today's behaviour.

### `[PAY-CASHFREE-1]` Inbound UPI

**Problem.** A repo-wide search for `razorpay|cashfree|phonepe|paytm|payu|instamojo|juspay`
across `worker/src`, `web/src` and `app/lib` returns exactly **one** hit, an unrelated
intent-classifier regex (`worker/src/lib/ava_triggers.ts:60`). `worker/src/types.ts:326-336`
lists only Stripe and Play credentials. **UPI is outbound-only** (`upi_payout.ts`, and
`upiPayoutEnabled` is `true` in prod). There is no collect request, no UPI intent link, no
VPA receiving address, no QR.

**Change.**
1. Env: `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_WEBHOOK_SECRET`,
   `CASHFREE_ENV` (`sandbox`|`production`) in `worker/src/types.ts` and `wrangler.toml`,
   **scoped per environment** — the staging block gets sandbox keys, the top-level
   (production) block gets production keys. Remember bare `wrangler` resolves the
   top-level block: everything goes through `scripts/cf.sh`.
2. `POST /api/pay/cashfree/order` — `requireUser` (the buyer signed in at `[BUY-OTP-1]`),
   rate-limited, takes `{ listingId, bookingId? }`, creates a Cashfree order for
   `(P + F + gst) × 100` **paise** with `currency: "INR"` (see `[TAX-GST-1]`), and writes
   a `direct_purchases` row in `pending` carrying the uid, the order id and the Cashfree
   order id. **The server computes the amount from the listing. Never trust a
   client-supplied price** — the existing lane already holds this line
   (`commercial_stream_sessions.ts:30-55` mints ids and prices server-side).
3. `POST /api/pay/cashfree/webhook` — **signature-verified**, idempotent on Cashfree's
   order id. On `PAID`: mark the purchase, write the escrow ledger rows, then hand off to
   the **existing** `commercialCheckout` path for the order row, policy snapshot, booking
   and entitlement — all of which work unchanged because there is a uid. Treat the webhook
   as the only source of truth about payment; **never mark paid from a browser redirect**,
   which is forgeable.
4. **Money shape — direct charge, not top-up-then-spend.** `hold()` debits a uid-keyed
   WalletDO (`commercial_checkout.ts:411`), and the whole point of this phase is that the
   buyer never funds a wallet. Add a sibling
   `holdExternal(env, uid, orderId, amount, { opId, source: 'cashfree', ref })` writing the
   same double-entry pair with `debit: external:cashfree` instead of `user:<uid>`,
   crediting the same `escrow:<orderId>`. Everything downstream — `release()`, the 80/20
   split, `commercial_settlement.ts`, `refund()` — then works **unchanged**, which is the
   entire reason to shape it this way. Tag the ledger row with the uid in `meta` so a
   buyer's statement still shows the purchase.

   **Rejected alternative: credit the wallet with `P` tokens on `PAID`, then call the
   existing `hold()`.** It reuses more code, but it makes the money briefly the buyer's
   spendable balance — so a failure between the two steps leaves them holding tokens
   instead of a ticket, and a reverse-to-source refund (`[PAY-REFUND-1]`) then has to claw
   back a balance they may have already spent. Direct charge has no such window.

**Flags.** `guestCheckoutEnabled` (default `false`), `cashfreeEnabled` (default `false`).
Both booleans, both declared in the interface and `DEFAULTS`.

⚠️ **Before real money-in:** a live Cashfree merchant account for an unregistered business,
and the merchant information updated with Cashfree once the company is registered in
Mumbai. `billingEnabled` and `walletRealMoney` are `false` in prod today and stay false
until that is done. Ship this whole phase against **sandbox** first.

### ⛔️ Deleted by owner decision 5 — do not build these

Four issues from the first draft are **cancelled**, because the buyer now has a uid:

| Cancelled | Why it is unnecessary |
|---|---|
| `[GUEST-ENT-1]` opaque `account_id` | `commercial_entitlements.account_id` takes the real uid, as `commercial_checkout.ts:548` already writes and `:583-586` already verifies. The four readers (`commercial_stream_sessions.ts:241`, `listings.ts:1336`, `commercial_notifications.ts:60`, `commercial_lifecycle.ts:449`) need no change. |
| `[GUEST-JOIN-1]` non-uid Stream identity | `streamUserToken` (`stream_video_calls.ts:250-255`) mints against the uid and `upsertProviderUser` provisions it. Works as-is. |
| `[GUEST-AFFIL-1]` guest attribution | `affiliateBind` (`affiliate.ts:666`) writes `referred_uid` and there is now a uid. The public click half (`GET /a/:linkId`, the `ava_aff_dev` cookie, 30-day KV) already works anonymously — it just needs binding on the checkout call. Combined with `[COMM-AFFIL-1]`, an affiliate-driven ticket then actually pays. |
| `[GUEST-TOKEN-1]` `t1.` ticket + `requireBuyer` | Superseded by `[BUY-OTP-1]`. |

Two rules survive from those sections and still apply:

- **Region.** Mumbai is a **GetStream dashboard setting**, not code — it is not in
  `stream_video_calls.ts`, `commercial_stream_sessions.ts`, `stream_lane.dart` or
  `wrangler.toml`. Never assert the region from the codebase; check the console.
- **Never add a Cloudflare media fallback to the paid lane.** Failing closed is the
  specified behaviour; an unmetered session is a money bug.

### `[PAY-REFUND-1]` Refunds go back the way they came

**Owner decision 2026-08-29: reverse to the source UPI handle by default; wallet credit is
an opt-in.**

**Why not wallet-only** (the owner's first instinct, and worth recording so it is not
retried): a refund parked in the wallet is unreachable for most buyers. Cashing out runs
through `upiPayoutRequest`, which requires `requireStripeKyc` (`upi_payout.ts:53`), a
verified VPA, admin approval with a hand-entered UTR, **and** `coins >= upiPayoutMinCoins`
— **1,000 in production** (`:60`). A buyer refunded ₹49 for a cancelled event would need
full KYC and twenty more cancelled events before they could withdraw their own money.
That lane is built for creator earnings, not for giving a customer their money back.

**Change.** Extend `commercial_lifecycle.ts` refund execution (`:208-214`) with a payment
source branch:

- **Paid via Cashfree** → call Cashfree's refund API against the original payment, write
  `commercial_refund_receipts` as today, and reverse the ledger with
  `credit: external:cashfree` mirroring the `holdExternal` debit. Cashfree's refund
  webhook confirms completion; until it arrives the receipt state is `refund_pending`, not
  `refunded`. **Do not mark a refund complete on the API call's synchronous response.**
- **Paid from wallet balance** (the existing lane) → `refund()` unchanged.
- **Either, if the buyer opts in** → credit the wallet instead, at full value, with the
  choice recorded on the receipt. Offer this because it is genuinely better for someone
  who wants to rebook; never make it the default and never make it the only option.

Refund amount is `P + F + gst` (`[TAX-GST-1]`), never just `P`.

**Done when.** A creator-cancelled Cashfree-paid ticket appears back on the buyer's UPI
handle, `commercial_refund_receipts.refunded_amount` equals the full charged amount
including GST, and `platform:tax` nets to zero for that order. PostHog
`commercial_refund`: `source=cashfree`, `outcome=reversed`. Presence of
`outcome=wallet_credit` on an order where the buyer did **not** opt in is the failure
value.

### `[BUY-CHECKOUT-1]` The "Join now" page

**Problem.** The shareable pages already open logged-out — `/l/[id]` (SSR, edge-cached
60s), `/e/[event]`, `/c/[handle]`, and the `/watch/[id]` shell. But **`/[username]/[slug]`
renders the hardcoded mockup** (`[slug].astro:1-8`) — and that is precisely the URL
creators and affiliates will share. It shows fiction to real visitors today, and every
card in `/marketplace` links to the same demo listing (`marketplace.astro:36-38`).
`LiveViewer.tsx:113` calls `/api/live/:id/join` with auth and already has a `'noticket'`
phase for the 403.

**Change.** One page, one flow, no redirects out: **see the listing → Join now → email +
6-digit code → pay by UPI → you are in.** Then wire `/[username]/[slug]` to real listing
data so the shared link is a real page.

Retire the wallet detour on this path. `PayStep.tsx` today reads
`GET /api/wallet/balance`, computes a shortfall, and sends the buyer to Stripe top-up
(`:65-72`, `:172-179`) before they can book — its own header calls tokens "the booking
currency". That is the two-step being removed. Keep the wallet path for buyers who already
hold a balance; make direct UPI the default.

**Done when.** A first-time visitor goes from a shared link to inside a live stream without
ever seeing a wallet, a top-up, or a password field.

---

## 5. Sequencing and gates

```
Phase 0 ──▶ Phase 2 ──▶ Phase 3
   │                       │
   └──▶ Phase 1 ──▶ 1B ────┴──▶ Phase 4
```

- **Phase 2 depends on Phase 0** — you cannot test a create form behind a 403.
- **Phase 1B depends on Phase 1**, because the tax line is layered on top of the split and
  the refund percentages, and both of those are being changed.
- **Phase 4 depends on Phase 1 and 1B**, hard. Buyer money flows through the same escrow
  and settlement, and the Cashfree charge amount includes the tax line. Building checkout
  on top of the three unfixed money bugs would mean paying customers get charged and
  cannot get in.
- **`[CARD-SLOTS-1]` is decided** (one listing = one event) and no longer blocks Phase 3.
- **`[BUY-OTP-1]`'s bug fix is independent** and can ship any time — web checkout is
  broken for new visitors today regardless of Cashfree.

**No commercial flag is flipped in production until every Phase 1 "Done when" is proven
with the assertion named, not with "telemetry is flowing".** Ship-gate rules 2 and 3
apply throughout: two real people on the newest build, and the success VALUE asserted, not
the arrival of an event.

**Before any of it reaches production D1:** the commercial migrations are **not
auto-applied** (`2026-08-24-commercial-stream-sessions.sql:2-3`) and no runner references
them. `commercial_checkout.ts:146-156` read-probes and fails closed 503. Running them
against prod is a deliberate step, announced as one.

---

## 6. Open questions for the owner

**Answered 2026-08-29** — recurring events (one listing = one event, `[CARD-SLOTS-1]`),
GST (18%, `[TAX-GST-1]`), refunds (reverse to source, `[PAY-REFUND-1]`) and buyer signup
(Clerk email OTP, `[BUY-OTP-1]`). Still open:

1. **GST needs an accountant, not an engineer.** `[TAX-GST-1]` builds the engine and
   leaves collection switched off. Before `gstEnabled=true`: a GSTIN, confirmation of the
   rate and place-of-supply treatment for a digital service sold across Indian states, and
   an invoice format. Related and still unresolved on the outbound side —
   `upi_payout.ts:42-47` carries `tds_inr_paise: NULL` with `tax_pending: true`, so
   creator payouts have an undecided TDS question too. Deciding one without the other
   leaves the books inconsistent.
2. **The platform fee `F`.** The comp shows a flat ₹6 on top of the 20% split. `[TAX-GST-1]`
   sets `F = 0` and carries the term so it can be switched on. Charging both a flat fee and
   a 20% cut is a pricing call.
3. **Refund window.** `[PAY-REFUND-1]` reverses to source, but for how long after the event
   — and does a buyer who attended 5 of 60 minutes get anything? Today
   `commercial_settlement.ts:96-151` treats 60 seconds of creator presence as full
   delivery, and there is no partial refund concept at all.
4. **`shellV2` is `true` in production** while `CLAUDE.md` documents it as `false` and
   warns the flip ships **AskAva with no kill switch**
   (`features/askava/askava_screen.dart:62` was dark only because `shellV2` was false).
   Outside this spec's scope but needs checking.
5. **`/marketplace` serves the hardcoded mockup to real visitors today**, every card
   linking to the same demo listing. Is that acceptable until Phase 3, or should it be
   taken down?
