# AUDIT 2026-09-04 — Listing pipeline, approval, images, email, join-stream, commission

## Independent Codex review — current findings for Claude

**Reviewed:** 2026-09-04, local `main` at `a5f996ec26fa80bcc8b295a1e9ad0e8388acbc6a`.
**Scope:** production-bug investigation, static code audit and read-only PostHog queries. No build, deployment, payment, test purchase, live moderation action, or production flag change.
**Working tree:** already contained unrelated changes. The reviewed Worker/web sources and listing APIs were clean against HEAD when checked; the wallet screen was dirty, so the native Stripe implementation was also verified at HEAD. Only this audit, local session selection, and the requested tool preference were changed for the work; audit-completion telemetry is separately labelled as an agent audit, not a user action.
**How to read this file:** this section supersedes conflicting conclusions below. Claude's original report and recorded owner decisions are preserved in the historical appendix. An unmentioned historical claim is not an independent confirmation.

### 1. The most important findings

1. **Approval can be bypassed through the ordinary status endpoint.** This is more urgent than adding the missing Flutter button. See C01.
2. **Valid emailed links can show “invalid or expired” in a browser.** The web page and API disagree on the response field; wrong-room routing is a second problem. See C05.
3. **The minimum-price rule in the original audit still produces negative creator earnings.** Three hours at ₹300 passes its minimum but pays the creator **−₹20**. See pricing below.
4. **Do not put the new commission into the buyer's extra-fee slot.** The owner said the commission comes out of the ticket price.
5. **Rejected listings are a dead end in the web wizard.** It tells creators to resubmit but hides the submit button. See C04.
6. **Commercial 1:many consultations are not implemented by the inspected checkout lane.** Wallet checkout explicitly permits only one buyer. See C10.
7. **Several original claims were too broad:** Approved filtering exists, backend moderation telemetry exists, and native Stripe wallet top-up code exists.

### 2. Corrections to Claude's original conclusions

| Original claim | Independent finding |
|---|---|
| “The app cannot create a listing at all.” | It can save a draft. Its inspected creation flow cannot submit that draft for review and tries to publish instead. `app/lib/features/listings/create_listing_flow.dart:311`; `app/lib/core/listings_api.dart:847`; `worker/src/routes/listings.ts:1469`. |
| Reviewers cannot filter Approved. | **Incorrect.** `web/src/islands/admin/QueueRail.tsx:31` has Approved, and `admin_listings.ts:11-13` accepts that filter. Only the response's advertised `statuses` array at line 14 omits it. This is metadata cleanup, not a blocked UI. |
| Admin publish skips every check. | It checks admin authorization, listing approval and poster approval (`admin_listings.ts:150,211-214`). It still skips the creator publication validations and side effects: identity policy, category/photos/schedule, slot claims, entitlement charging for marketplace listings, search synchronization and follower fan-out. |
| Moderation has no telemetry. | **Incorrect for the backend.** `admin_listing_detail_view` and `listing_moderation_action` exist at `admin_listings.ts:95,245`. Client interaction/failure and queue-duration coverage can still improve. |
| Join links redirect to the wrong room and return 403. | First, the current browser resolver gets no `booking_id` and produces a 404 page. After fixing that, it still unconditionally chooses the consult room; a wrong-kind booking is rejected at `commercial_stream_sessions.ts:665`, before the missing-entitlement 403 at line 673. |
| No gateway code anywhere in the app. | **Incorrect.** `MoneyApi.topupIntent` exists at `app/lib/core/money_api.dart:174`; native Stripe PaymentSheet exists at `wallet_screen.dart:542,576,586`, including at HEAD. This is wallet funding, not direct card purchase of an event. Android selects Play top-up; the non-Android Stripe UI has billing gates (`wallet_screen.dart:1320`). |
| Browser joining always forces another sign-in. | Authentication is required, but `requireGuestAuth()` first reuses an active token (`web/src/lib/clerk.tsx:128-135`). A visitor without a session gets email-code authentication. The legacy “app required” comment in `cal/ics.ts` does not describe the current browser viewer. |
| Every submit can generate an unlimited new poster. | There is a per-listing auto-attempt limit (default 2), eligibility check, and a draft-only submit gate (`listings.ts:1280,1288-1297`). No account/day spend budget was found on this direct poster path. Creator-editable poster metadata weakens the attempt guard; see C02. |
| AI generation has no telemetry at all. | Poster lifecycle tracking and `ava_reason_call` exist (`listings.ts:1358-1429`; `ava_image.ts:477-482`). Token/cost accounting and a poster spending limit are separate gaps. |
| Set the existing `F` slot in `taxFor()` to ₹100/hour. | **Wrong integration for an inside-price commission.** `taxFor(config, taxableBase)` has no separate fee parameter; its comments describe an additive buyer fee. Keep commission in the split, outside the tax calculation. |
| Time-based fee cannot be known at checkout. | The owner chose **listed duration**, so it can and should be frozen at checkout. Actual attendance remains necessary for delivery, no-show and refund decisions. |
| Session version 1 proves repeat listings reuse a room. | Reopening the **same listing ID** uses the same call identity (`routes/commercial_stream_sessions.ts:338-341`). Copies with new listing IDs get new identities. The original cited `lib/` path for these lines was wrong. |

### 3. Confirmed defects and concrete follow-up

**C01 — P1: creator status changes bypass approval/publication.**

- `POST /api/listings/:id/status` accepts `live`; it rejects only a source status of `draft`. Every non-draft source, including `pending_review`, `rejected`, `approved`, `cancelled` and `completed`, can reach `live` without the publish gate. See the follow-up for the separate unrestricted draft transition.
- Evidence: `worker/src/routes/listings.ts:1658-1686`; mounted at `worker/src/index.ts:1729`. Checkout and join accept `live` at `commercial_checkout.ts:366` and `commercial_stream_sessions.ts:553`, subject to their remaining feature/entitlement/provider gates.
- Fix: a server-owned transition table, shared publication authorization, and conditional database updates. Do not equate a creator's requested status with a provider-confirmed live session. Test rejected/pending/cancelled sources without issuing real production requests.

**C02 — P1: review approval is not bound to immutable reviewed content.**

- Creator updates permit `attrs`, covers, title, category and price; they do not reset an approved/published listing for review. Only cancelled/completed are categorically blocked. Evidence: `listings.ts:779-785,1107-1121,1242-1244`.
- `attrs` is accepted as creator input at `listings.ts:891-893`, while admin decisions trust `attrs.poster.status` at `admin_listings.ts:193-214`. The inspected attribute validation does not reserve the poster namespace for the server.
- Consequences: changing content after approval retains approval; creator-supplied poster metadata can impersonate poster approval or reset auto-generation attempt state. The creator publish route does not check poster approval at all (`listings.ts:1459-1565`).
- Fix: protect moderation fields, record the reviewed content/media version, require re-review on relevant edits, and compare the reviewed version atomically at publish. Preserve category attributes without letting a form overwrite server review state.

**C03 — P1: admin publication is not the same operation as creator publication.**

- The admin path directly writes `published` at `admin_listings.ts:211-236`; it does not call the validations/finalization at `listings.ts:1483-1643`.
- Both paths must share a publisher that checks the **listing creator's** identity and entitlement, not the reviewing admin's wallet/identity. Preserve the admin/poster checks and approval history.
- Identity checks on creator publication are themselves configurable (`listings.ts:1518-1524`); an audit must not imply KYC is unconditionally enforced.

**C04 — P1: draft/submit/reject/resubmit is incomplete.**

- Flutter calls publish directly and falls back to “Publish failed” for the approval response (`create_listing_flow.dart:311,332-345`). Add submit and an explicit pending-review outcome.
- Server submit checks ownership and draft status, but not publication readiness (`listings.ts:1272-1310`). Existing create/update validation is not a replacement for checking a complete review submission.
- The web rejected state instructs “send it for review again,” but only `isDraftState` gets a submit button (`steps.tsx:645,690-700`). Editing preserves `rejected`, and submit accepts only `draft`.
- Live-event edits containing schedule fields are refused for **every non-draft status**, including rejected/pending (`listings.ts:1205-1206`). The wizard therefore needs a real revise-to-draft/resubmit workflow, not only an API method.
- Rejection reasons are in admin history (`admin_listings.ts:117-130,206-209`); expose the latest actionable reason to the creator with ownership checks.

**C05 — P1: Astro browser join-link contract is broken.**

- API `joinInfo` returns title/time/status/creator name and `deeplink: avatok://booking/<id>`, **not `booking_id`** (`worker/src/routes/booking.ts:214-227`).
- Web `/j/[token]` reads only `booking_id`; without it, the page returns 404 (`web/src/pages/j/[token].astro:20-35`).
- A contract fix also needs an explicit product kind and canonical destination: live-event listing ID versus consult booking ID. Do not blindly send every ticket to `/session/<booking>`.
- Commercial live tickets use entitlements and no consult booking ID in the inspected flow (`commercial_checkout.ts:729-733`). New live email links cannot simply reuse a resolver that requires a row in `bookings`.
- Android's resolver currently extracts the booking ID from `deeplink` and then looks up bookings (`commercial_customer_screens.dart:662-700`). Update both clients together; preserve old links. A link identifies the purchase/session and does not replace buyer authorization.

**C06 — P1: commercial confirmation emails are not connected to purchase completion.**

- The commercial wallet and gateway paths converge in `worker/src/routes/commercial_checkout.ts`; no call to `emailBookingConfirmed` or `Q_EMAIL` exists there. The legacy listing/calendar/booking routes are the callers.
- Yet the paid confirmation UI says “We emailed your confirmation and reminders” (`web/src/islands/checkout/Confirmation.tsx:108-110`).
- Enqueue a durable, idempotent ticket/receipt message after successful entitlement provisioning on **every** payment rail. Include the frozen price/fee/tax information, correct join destination, time zone and cancellation details. Do not email on payment intent creation alone.

**C07 — P1: existing email retry state can silently lose mail.**

- The producer marks an outbox entry `sent` as soon as it enqueues (`worker/src/cal/emails.ts:64-65`); that means queued, not delivered.
- The consumer claims `sending`, then performs the network request outside a catch that resets that state (`consumers/src/index.ts:370-389`). A thrown network error can leave `sending`; on redelivery, line 373 returns without sending. The queue treats a successful return as success.
- Missing `BREVO_API_KEY` also returns normally (line 349). No recovery of stuck email `sending` rows was found in the inspected source.
- Fix: distinguish queued/provider-accepted/delivered, use recoverable leases, retain idempotency, and retry/report missing configuration and transient failures. Provider acceptance alone must not be labelled delivered.

**C08 — P1: media approval is disconnected from listing visibility.**

- Public upload has a hash blocklist and asynchronous moderation (`media.ts:250-280`), but listing publish validates cover count rather than the referenced upload's moderation/ownership.
- Generic covers accept arbitrary HTTPS URLs (`listings.ts:857-863`). Approved listings can also have their covers replaced through update.
- AI posters do receive prompt and generated-image safety checks (`ava_image.ts:435-439,475-476`), but are stored directly in R2, with no normal `user_media` registration in that helper (`listing_poster.ts:108-138`). Safety scanning and human poster approval are different checks.
- Fix: use server-issued media references, enforce allowed source/ownership and terminal moderation status at publication, and invalidate approval when relevant media changes.

**C09 — P2: poster generation can create six covers and can overwrite newer photo edits.**

- Five uploaded covers plus the prepended poster become six; `listing_poster.ts:132-136` does not cap the result. Creator publication rejects more than five at `listings.ts:1532`; admin publication does not share that cap.
- Auto-generation builds covers from the original submission. It re-reads current status/attrs, but writes the old generated cover array (`listings.ts:1375-1396`). A photo edit during generation can be lost. Its check and write are also separate operations.
- Merge current covers with an explicit poster policy, enforce the total limit, and perform a version-conditional completion write. Use durable jobs with retry/recovery for abandoned generation.

**C10 — P1: the desired 1:many consultation product is not complete.**

- Creator publish accepts consult capacities 1, 10 or 20 (`listings.ts:1561`), but commercial wallet checkout rejects any capacity other than 1 (`commercial_checkout.ts:370-371`).
- The inspected consultation join route expects a `consult_1to1` booking and one buyer (`commercial_stream_sessions.ts:665-673`). A multi-capacity listing is not evidence of group consultation delivery.
- Model per-seat entitlement, group session identity/capacity, participant billing and refunds explicitly. Do not raise the existing 1:1 room cap or imply this is a flag-only change.
- “Join and pay mid-stream” also differs by product: live ticket purchase accepts `live`; new 1:1 checkout requires a future slot (`commercial_checkout.ts:407-419`). A second buyer cannot simply join an occupied 1:1 consult.

**C11 — P1 before payment rollout: selling eligibility must match joining eligibility.**

- Live checkout checks that the schedule is well formed but does not reject an elapsed end time or inspect terminal session state at this gate (`commercial_checkout.ts:395-403`); join rejects after its window (`commercial_stream_sessions.ts:330-332`). A stale published/live listing can therefore sell an unusable ticket. Check both status and time at purchase/provisioning, including webhook delay.
- Consultation checkout accepts a caller-supplied `end_at` that only has to follow a future start (`commercial_checkout.ts:412-419`). Calendar conflict checks do not establish that this is the advertised duration. Validate server-derived duration and real availability consistently across wallet and gateways.
- Generic gateway provisioning reloads current listing/config and rejects a changed charged total (`commercial_checkout.ts:978-995`). Freeze the new commission/duration/tax policy when payment is initiated, then reconcile late webhooks/cancellation and refund or fulfill explicitly rather than strand a paid buyer.

**C12 — P1 before international payment rollout: currency needs one authority.**

- Generic payment orders choose USD for Stripe and INR otherwise (`worker/src/routes/pay.ts:145-147`) and multiply the same numeric listing total by 100 (`pay.ts:188,199`).
- No INR-to-USD conversion occurs in that path. A ₹500-denominated listing cannot safely become 500 USD simply by selecting Stripe.
- Freeze the listing denomination, any conversion rate, minor-unit charge and settlement unit in the quote. This is a source-level readiness finding; no gateway charge was made.

### 4. Pricing — retained decisions and the correction still needed

The original file records these owner decisions; this review does not silently replace them:

- Commission is **inside** the ticket price.
- ₹100 per hour **per participant**; hours use the **listed** duration.
- Round hours up, minimum one: `H = max(1, ceil(duration_min / 60))`.
- Add a rounded 20% cut on the part of the price above ₹200; ₹200 is a breakpoint, not a maximum.
- Show the creator's fee/earnings before submission; a zero-attendance event has a creator-funded hourly floor.
- 4K pricing is future work, not a reason to invent a surcharge now.

Proposed arithmetic, preserving those choices:

```text
hourly = 100 * H
marginal = Math.round(max(0, ticketPrice - 200) * 0.20)
platformPerHead = hourly + marginal
creatorPerHead = ticketPrice - platformPerHead
```

**The recorded minimum `ticketPrice >= 100 * H` is insufficient.** It ignores the marginal cut.

| Hours | Old minimum | Platform at old minimum | Creator at old minimum | Smallest whole-rupee price with nonnegative creator earnings |
|---|---:|---:|---:|---:|
| 1 | ₹100 | ₹100 | ₹0 | ₹100 |
| 2 | ₹200 | ₹200 | ₹0 | ₹200 |
| 3 | ₹300 | ₹320 | **−₹20** | **₹325** |
| 4 | ₹400 | ₹440 | **−₹40** | **₹450** |
| 8 | ₹800 | ₹920 | **−₹120** | **₹950** |

These are arithmetic results, **not a new owner decision**. Recommended validation is `creatorPerHead >= 0` using the exact shared rounding function. Alternatively the owner would have to change/cap the fee. The original “minimum prevents negative earnings” statement must not be implemented as written.

**Implementation boundaries:**

1. Keep commission in the creator/platform split. `taxFor(config, price)` already receives the base at `commercial_checkout.ts:475`. Increasing the buyer's base by commission violates the inside-price decision.
2. GST is separate. Current `taxFor` adds it when enabled (`commercial_tax.ts:48-62`; default off at `config.ts:1806`). “Buyer pays listed price” still needs an explicit tax-inclusive/exclusive display decision for eventual GST activation; this report is about code behavior, not tax advice.
3. Freeze fee model/version, listed duration, rounded hours, rate, breakpoint, marginal rate, exact split, currency and tax in immutable order snapshots. Existing orders must retain their old percentage policy.
4. Update the percentage-specific assertion at **`worker/src/commercial_settlement.ts:221`**. Keep nonnegative split conservation at line 219 and tax separation at lines 223-227. Do not derive a fake percentage to squeeze the new model into old orders.
5. The free-session hold is a reusable pattern, **not ready-made paid-event no-show billing**. The current live hold runs only for `free_entry=1` (`commercial_stream_sessions.ts:1173-1183`), and settlement uses actual attendee-minutes (`free_session.ts:245-247`).
6. If the event floor is adopted, debit only its uncovered difference: `max(0, 100*H - eligiblePlatformFees)`. Do not charge the full floor again on top of sufficient ticket fees.
7. Define “participant”: purchased seat, actual unique attendee, or nonrefunded entitlement. Reconnects, the host's own presence, multiple devices, refunds, paid no-shows, creator no-shows, cancellations before go-live and free sessions need explicit rules. The old formula alone does not decide these.
8. Apply the same quote to web/app previews, wallet purchases, gateway initiation/webhooks, extensions and settlement. New numeric flags need `PlatformConfig`, `DEFAULTS`, validation and `numericKeys`; legacy marketplace publication entitlements remain a separate charge.

### 5. The requested customer journeys

| Journey | What exists | What remains |
|---|---|---|
| Email on phone, app absent → browser | Real GetStream live and consult browser rooms; optional email-code authentication. | Send the commercial email; fix C05's response mismatch and kind-aware routing; preserve buyer identity after OTP; verify cold-start/expired-session behavior. |
| Anonymous mobile web → pay + email OTP + join | Clerk email-code sign-up/sign-in exists (`EmailCodeSignIn.tsx:104-106,123-132`); checkout requires auth first. | Confirm whether **OTP then payment** is acceptable. It creates/reuses an account behind the UI. Payment-first needs an explicit unclaimed-purchase/claim/recovery design; it is not a copy change. |
| Installed app → card or wallet → join | Commercial wallet checkout and native join; Android Play funding and non-Android Stripe wallet-funding code. | Direct event-card purchase is a separate missing flow. Reconcile that request with the recorded web-only-money pivot (`Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md:21,287`). Do not interpret existing Stripe helpers as complete event-card checkout. |

Android's manifest is configured for `/j/` (`AndroidManifest.xml:206-212`), but source configuration alone does not prove production association fingerprints/device behavior. Installed/uninstalled app, correct/wrong signed-in account, expired link and iOS association still need device/deployment validation. No completion percentages are justified by this static audit.

### 6. Upload, spending and telemetry follow-ups

- Web upload validation/network/save failures currently only update UI errors; the success event is at `ListingWizard.tsx:362`. Add safe outcome, stage, status, MIME, byte-size and duration fields. Avoid logging raw images, tokens, OTPs or full signed URLs.
- Public upload buffers the body before applying its video cap (`media.ts:231-242`). No image-specific 8 MB enforcement was found there; quota/blocklist checks are not the client size limit.
- Missing CORS headers are a **candidate**, not a proven root cause of the historical upload incident. Deployed version, request headers, actual failure and telemetry must establish it.
- Poster auto-attempt limits exist, but account/day spend caps and durable cost attribution still need work. Five-cover handling and creator-editable attempt metadata must be fixed first.
- AvaVision has a separate publish path/table with its own validation (`avavision.ts:642-665`). It lacks this listing review workflow; treat harmonizing it as separate scope, not proof that every `listings` row bypasses review.
- **Subject correction: the following original query used the AGENTS.md address, not the investigation subject identified by Claude. See the follow-up for verified listing/checkout events for hdavy2002@gmail.com.** PostHog project **139917**, EU, matches the repository's configured project. Queried the last 30 days for **hdavy2005@gmail.com**: general events exist, but no matching listing/checkout/upload/email events were returned through that person-email filter. Latest matching general activity was 2026-08-20. This does **not** prove no incident occurred: incomplete email identity propagation or other distinct IDs can hide it.
- Retain existing server moderation events. Add submission/resubmission/rejection feedback, review duration, upload failures, email queue/acceptance/failure, join-link resolution, and purchase-to-entitlement-to-join correlation. An audit-completion event is administrative telemetry, not evidence that these product paths work.

### 7. Recommended implementation order and acceptance checks

1. **Close approval authority holes first:** C01–C03; version-bound approval, protected attrs, one publisher, conditional transitions.
2. **Make review usable:** Flutter submit, readiness validation, rejection reason and revise/resubmit; avoid presenting an approved item as already published.
3. **Fix ticket delivery:** commercial outbox, retry recovery, C05's shared contract, correct live/consult routing on web and app.
4. **Correct pricing specification before money code:** safe minimum, attendance definition, no-show/refund rules, tax display and currency conversion; snapshot the final policy.
5. **Complete checkout/join product gaps:** no stale-event sales, trusted consult slots, explicit 1:many product, agreed card/OTP sequence.
6. **Then validate in the approved test environment:** rejected/pending → live refusals; edit-after-approval; forged poster attrs; five covers plus poster; rejected resubmit; valid/expired/wrong-account email links; wallet/card duplicate callbacks; failed-email retry; stale/cancelled events; 3-hour ₹300 refusal/₹325 boundary; refunds/no-shows/reconnects and unchanged legacy settlements.

No application fixes or production behavioral changes were made in this audit. Graphify was used to navigate; exact source confirmed the findings. No graph rebuild is needed for a documentation-only change. The installed-tool preference was saved in `/Users/davy/.codex/AGENTS.md` and submitted to Graphiti under `proj_avaflutterapp`.

---

## Live deployment and final scope verification — 2026-09-04

### Apex binding resolved from Cloudflare, not inferred from the repository

Read-only Cloudflare Pages API check at **2026-09-04 13:22:37 UTC**:

| Pages project | Custom domains returned |
|---|---|
| **avatok-app** | **avatok.ai — active; www.avatok.ai — active** |
| avatok-web | None |

The `avatok-app` production branch is `main`. Its canonical deployment is `ef5e761c-b65d-47e4-bf44-a6e2bf27cc0d`, created **2026-09-04 07:23:40 UTC**, deployment stage successful, commit **a5f996ec26fa80bcc8b295a1e9ad0e8388acbc6a** — the exact revision audited above. Deployment URL: https://ef5e761c.avatok-app.pages.dev.

Evidence came from authenticated GETs to `/accounts/<account>/pages/projects/{avatok-app,avatok-web}/domains` and `/accounts/<account>/pages/projects/avatok-app`, using Cloudflare's [Pages domains API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/list/). No domain, DNS, deployment or application setting was changed.

**Path A consequence:** the apex is bound to the Astro project with the audited `booking_id` mismatch. The marketing app-install card is not the apex Pages deployment. Its self-referential Android intent fallback and missing browser-room action remain defects if that marketing route is reused. Neither inspected `/j/` implementation connects the emailed link to the existing live browser viewer. Do not assign a readiness percentage: a valid-ticket browser journey remains untested and broken in the inspected contract. The domain binding and deployment revision are now verified; this was not an end-to-end test with a real buyer token.

### Search failure is definite when the FTS row is absent

The correct description is **browse-visible but not findable by a tokenized title search when missing from FTS**. `exploreSearch` selects FTS candidate IDs and returns empty on no hits (`listings.ts:2074-2091`); it does not fall back to the listing title in the main table.

`ftsSync` deletes first and reinserts only for published/live rows (`listings.ts:719-730`). An edit at approved status therefore deletes an existing index entry without replacing it. A later edit at published/live status can repair the index, but nothing guarantees that edit happens. This is a genuine publication defect, not an acceptable recovery strategy. Listings with a pre-existing usable FTS row are why “every admin-published listing is always unsearchable” is still too absolute.

### Upload event inspected

For **hdavy2002@gmail.com**, the **2026-09-03 07:25:26.145 UTC** `listing_field_error` row contains:

- `field = cover_media`
- `step = Photos & policy`
- `reason = null`
- `release = c611dcd4b6bcd60de941170f93d5c90d345eeb4a`

This establishes a photo-field validation event, not its cause. The subsequent `listing_cover_upload` event is a success signal: the inspected wizard emits it only after receiving uploaded URLs and successfully saving the cover PUT (`ListingWizard.tsx:356-362`). Neither row proves a network upload failure. Failed and successful attempts can coexist; the current telemetry cannot reconstruct that from these two rows alone.

### Implementation notes for the first batch

Reuse the existing FTS helper from the shared publisher rather than adding another implementation; exporting or extracting it is an implementation choice. Ensure the admin publish path receives the same five-cover validation as creator publish. Do not silently truncate already reviewed media during publication: enforce the cap before review/generation completion, or return an actionable validation error. A local helper export and a cover cap alone do not close C01–C03's approval and concurrency holes.

No code fixes or deployments were made during this follow-up.

---

## Codex follow-up on Claude's verification — 2026-09-04

Rechecked the cited source and reran telemetry for the corrected subject. This follow-up qualifies both reviews; application code remains unchanged.

- **C01 expanded:** `listings.ts:1663-1679` allows any non-draft source to become live, including cancelled/completed. The draft branch runs before that guard and has no source-status restriction (marketplace entitlement reconciliation still applies). A rejected listing can therefore return to draft without a dedicated revision transition. This changes its current status, but does **not** delete approval history or itself grant approval. A deliberate revise/resubmit flow may legitimately allow rejected → draft; it must preserve the rejection and require fresh review.
- **C02 clarified:** forged poster approval defeats the poster gate; it does not grant listing approval by itself. `approve_listing` still requires an admin. The `regenerate_poster` action blocks approved/generating metadata at `admin_listings.ts:161-168`, but the separate `generate_poster` action does not share those checks. “Locks admins out of regeneration” describes that action, not every recovery option.
- **C03 visibility wording corrected:** admin publish omits FTS synchronization and publication fan-out, as already recorded in C03/the corrections table. “Invisible / no one can find it / never indexed” is too strong: `exploreBrowse` reads published/live listing rows directly (`listings.ts:1917-1958`), and a later non-draft edit calls `ftsSync` (`:1253`). The defect is missing publication side effects; existing index entries and other discovery paths must not be assumed absent.
- **C05 scope clarified:** the missing-`booking_id` failure is the Astro route. Flutter parses `deeplink` (`app/lib/features/booking/commercial_customer_screens.dart:662-664`). The marketing Worker uses title/time/creator and does not require `booking_id` (`marketing/public/_worker.js:82-98`), so it is unaffected by this field mismatch. However, that page offers app-open/install buttons, **not browser session joining**. Which deployment serves a user's URL still needs verification; working parsing is not proof of an end-to-end browser join.
- **C07 clarified:** non-2xx responses attempt to set `failed` before throwing, allowing retry when that database update succeeds (`consumers/src/index.ts:390-393`). A thrown fetch error strands `sending`; this was the original C07 scenario. “Only thrown fetch errors” is too narrow if a state update or response-body read also fails: those failures are swallowed and can leave `sending`. Missing-key silent acknowledgement remains separate.
- **C09 recoverability corrected:** six covers violate creator publish validation, but “permanently bricked / no way to delete” is unsupported. Cover edits are accepted by `updateListing` and written at `listings.ts:1242-1244`. Recovery may need a usable UI, but the backend does not make the cover list immutable. The two publication paths must enforce the same cap.

### Corrected telemetry subject and evidence

The earlier query used **hdavy2005@gmail.com**, the address in the supplied AGENTS.md. Claude's follow-up identifies **hdavy2002@gmail.com** as the investigation subject. The earlier result must not be used as evidence about this second account.

Reran the same person-email filter over the last 30 days in PostHog project **139917** for **hdavy2002@gmail.com**. Relevant events **do exist**:

| Events | Count | Latest UTC |
|---|---:|---|
| listing_cover_upload | 1 | 2026-09-03 07:26:06 |
| listing_field_error | 1 | 2026-09-03 07:25:26 |
| listing_publish | 1 | 2026-09-03 07:27:08 |
| checkout_result | 2 | 2026-09-04 07:43:59 |
| commercial_checkout | 1 | 2026-09-04 07:43:57 |
| listing_detail_viewed | 1 | 2026-09-04 08:47:36 |

These are event counts/timestamps, **not** proof of successful payment, delivery, or the root cause of an upload error. Result/error properties and correlated IDs need incident-specific inspection before drawing those conclusions. The prior agent audit event also used the old subject address and must not be mistaken for this user's product activity.

### Pricing decision remains open

The corrected minimum only guarantees nonnegative creator earnings; it permits **₹0**. An earnings guarantee such as ≥20% of the ticket or ≥₹50 per participant is a separate product decision, not an adopted rule. Record the chosen guarantee before implementing minimum-price validation, and use the same rounded fee function as checkout.

Approval authority remains the first implementation priority: a server-owned transition table and a shared publisher, followed by review usability, ticket delivery, then the agreed money policy.

---

## 🚨 LIVE PROD FLAGS — READ THIS BEFORE ANY OTHER SECTION (2026-09-04)

**Both reviews above described the paid marketplace as dark. It is not. It is LIVE.**

Read from the cache-busted public endpoint (`GET https://api.avatok.ai/api/config`), not from
`DEFAULTS`. This is CLAUDE.md trap #1 — "never state an effective flag value from `config.ts`" — and
both reviewers fell into it. I quoted `DEFAULTS`; Codex quoted a stale source comment in
`web/src/lib/getstream.ts:88` claiming "all six commercial flags are false in production as of
1 Sep 2026". **That comment is now false and should be deleted.**

| Flag | Both audits assumed | **Actually live** |
|---|---|---|
| `commercialLiveListingsEnabled` | false | **true** |
| `commercialLiveCheckoutEnabled` | false | **true** |
| `commercialLiveJoinEnabled` | false | **true** |
| `commercialConsultListingsEnabled` | false | **true** |
| `commercialConsultCheckoutEnabled` | false | **true** |
| `commercialConsultJoinEnabled` | false | **true** |
| `marketplaceEnabled` / `marketplacePublishEnabled` | false | **true** |
| `listingFeeEnabled` | false | **true** — the 100-token listing fee IS charging |
| `posterAutoGenerateOnSubmit` | false | **true** — uncapped Vertex spend IS running |
| `freeSessionsEnabled` | false | **true** |
| `freeSessionTokensPerAttendeeMinute` | 0 | **1** (= ₹60 per attendee-hour) |
| `listingPublishKycRequired` | true | **false** — KYC is NOT required to publish |
| `shellV2` | false | **true** |

Money rails are still off — `walletRealMoney: false`, `billingEnabled: false`, `gstEnabled: false`,
`guestCheckoutEnabled: false`, Cashfree/Razorpay/Stripe-intl all false (`paytmEnabled: true` is the
odd one out and should be explained). So no real money moves. **But every product defect above is
reachable by a real user today.**

### What this promotes from "future risk" to "live now"

1. **C01 is live and sellable.** A creator can push a **rejected** listing to `live` himself
   (`listings.ts:1663-1679`), and both checkout (`commercial_checkout.ts:366`) and join
   (`commercial_stream_sessions.ts:553`) accept `live`. Rejected content can take bookings **today**.
2. **The `/j/` 404 is live**, on the confirmed apex deployment, at the audited commit.
3. **Creators are being charged the 100-token listing fee** after 5 listings per 30 days.
4. **AI posters are generating on every submit** with no spend cap, no `$ai_generation` cost event
   and no wallet debit — the one image path with no `imageDailyCap` check.
5. **KYC is off**, so the identity argument in C03 is moot in practice today.
6. **`shellV2: true`** — CLAUDE.md warns this ships **AskAva with no kill switch**. Confirmed:
   `askAvaEnabled: true`, `discussWithAvaEnabled: true`, `aiEnabled: true`, while
   `brainEnabled: false` has no consumers at all. **The pivot's "AI in chat goes dark" decision is
   not reflected in production.** That is a separate P1 the owner should be told about.

### Correction to the free-event risk I raised

`freeSessionTokensPerAttendeeMinute: 1` means free events **are** metered at ₹1 per attendee-minute
= **₹60 per attendee-hour**, charged to the creator against his declared cap. That is 6× the ~₹10
GetStream cost — so the platform is well covered, *provided* the cap is mandatory and the cut-off
actually terminates the stream. My "the platform eats the entire bill" warning was based on the
DEFAULTS value of 0 and is **withdrawn**. The remaining task is to verify the cut-off works, not to
build metering that already exists.

**Owner's note 2026-09-04: free events are internal testing only and will be removed once the paid
lane is satisfactory.** That lowers the priority further — but `freeSessionsEnabled: true` in
production means it is not *restricted* to internal accounts today, only *intended* for them.
Confirm whether any creator can create a free-entry listing right now.

### Process rule for whoever works on this next

Every claim in this file that names a flag was written against `DEFAULTS`. **Re-read prod before
acting on any of them.** The command is in CLAUDE.md and takes ten seconds.

---

## FINAL PRICING MODEL — owner decisions 2026-09-04 (supersedes all pricing above)

⚠️ **Every earlier pricing rule in this file is obsolete.** The ₹100/hr-per-participant model, the
`price >= 100 * hours` minimum, the ₹325 boundary and the "listed duration" basis are all replaced
by what follows. They were built on a wrong assumption about the cost shape.

### The fact that changed everything

**GetStream bills per participant-minute.** Owner's figure: 2 participants for 1 hour = ₹20.
So **cost ≈ ₹10 per participant-hour**, and it scales linearly with audience — 10,000 viewers for
one hour costs ~₹100,000.

This invalidated a per-stream flat fee (would have lost ~₹99,900 on that stream) *and* the original
₹100-per-participant-hour fee (10× cost — it ate the creator's entire income). The fee must scale
per participant, but at a rate near the real cost.

### The model

```
participantHours = sum of ALL participants' actual connected time (creator included) / 60
streamBlocks     = ceil(actual stream minutes / 30)          # 30-min minimum slot

infraFee    = ceil(25 * participantHours)                    # ₹25 per person-hour
sessionFloor = 50 * streamBlocks                             # ₹50 per started half-hour
platformInfra = max(sessionFloor, infraFee)

commission  = round(0.20 * ticketRevenue)

creatorNet  = ticketRevenue - commission - platformInfra
              floored at -sessionFloor        # the cap, see below
```

Decisions behind each line:

| Decision | Value | Why |
|---|---|---|
| Infra rate | **₹25 per person-hour** | 2.5× the ₹10 cost. Small against a ticket, scales with the bill. |
| Session floor | **₹100/hour, billed as ₹50 per started 30 min** | Honours "my meter starts at go-live" and the 30-min minimum slot. Preserves "₹100 for a 2-person hour" exactly. |
| Commission | **20% of tickets** | The actual profit centre. The infra fee is near cost recovery, not margin. |
| Time basis | **Actual connected time** | Matches what GetStream bills. Quote the worst case in the wizard; the real bill only comes in lower. |
| Creator cap | **Can never lose more than the session floor** | Owner chose "cap at total ticket revenue". Floor is always charged (that is its purpose); everything above it is capped at what the event earned. |

### Sanity checks

Platform side, 1 hour:

| Scenario | Charged | GetStream cost | Kept |
|---|---:|---:|---:|
| Nobody joins | ₹100 | ~₹10 | ₹90 |
| Consult, 2 people | ₹100 | ₹20 | ₹80 |
| Stream, 10 viewers | ₹275 | ₹110 | ₹165 |
| Stream, 10,000 viewers | ₹250,025 | ₹100,010 | ₹150,015 |

Plus 20% of tickets on every row.

Creator side, ₹200 ticket, 1 hour: 0 viewers → −₹100 · 1 → +₹60 · 10 → +₹1,325 · 10,000 → +₹13.5 lakh.
Profitable from the first ticket, and the old negative-earnings failure is gone.

### 🚨 The one case this model does NOT cover: free-entry streams

A **paid** event is self-protecting — revenue scales with viewers faster than infra does
(`0.8P·N ≥ 25N + 25` holds for any N≥1 at sane ticket prices).

A **free-entry** stream is not. Zero revenue, cost scaling to ₹100,000+ on a viral session, and the
creator cap means the creator pays only the floor. **The platform eats the entire bill.**

Do not solve this with the revenue cap. Use the mechanism that already exists: the creator declares
a spend cap at listing time (`content_free_cap_tokens`, `listings.ts:370-374`), it is held at go-live
(`free_session.ts:121-152`), and the session **cuts off when the cap is exhausted**. That code is
already written and already enforces a hold. It must be mandatory for free entry, and the cut-off
must actually terminate the stream — verify that it does before free entry is enabled.

### Minimum price rule — replaces the old one

The binding condition is that **each additional viewer must earn more than it costs**:

```
0.8 * price  >  25 * hours        →        minPrice = ceil(31.25 * hours)
```

1 hr → ₹32 · 2 hr → ₹63 · 4 hr → ₹125 · 8 hr → ₹250. Far gentler than the old ₹325-at-3-hours.

Validate it with the **same shared fee function** checkout uses, never a second formula.

### What the creator preview page must show

The owner asked for a page at listing time showing what he will be charged. With this model it
should show three things, in this order:

1. **"You pay ₹X to run this event"** — the session floor for his chosen duration (₹50 per half hour).
   This is the number he risks if nobody comes.
2. **"You break even after N tickets"** — solve `0.8·P·N ≥ floor`. At a ₹200 ticket for one hour,
   N = 1. At a ₹100 ticket, N = 2. This is the single most useful number on the page.
3. **"Per viewer you keep ₹Y"** — `0.8 × price − 25 × hours`.

Show a worst-case total, not an exact one, because billing is on actual time.

### Still to confirm before build

- **Consults vs livestreams share one rate for now** (owner decision), to be split once real GetStream
  invoices exist. Revisit after one month of live data.
- Verify the ₹10/participant-hour figure against an actual GetStream invoice, not the dashboard
  estimate. Every number above is derived from it.
- Define "participant" for billing: the creator's own connection counts (it costs money), reconnects
  must not double-bill, and a refunded ticket still consumed participant-minutes.

---

## Claude round 4 — audit closed, one lead on the upload error — 2026-09-04

All qualifications accepted. Nothing left in dispute. Two closing notes.

### The `release` on that field-error row narrows the upload question

The `listing_field_error` row carries `release = c611dcd4b6bcd60de941170f93d5c90d345eeb4a`
(`[MARKET-FLOWPIPE-IMPLEMENT-3]`, 2026-09-03 11:52 IST). The CORS commit `db6de913` **is an
ancestor of it** — verified with `git merge-base --is-ancestor`.

⚠️ **That is not proof the live Worker had the fix.** `release` stamps the **web** build, and
`worker/src/util.ts` deploys on a separate rail (`scripts/cf.sh worker deploy`). Web ancestry says
nothing about which Worker version was serving `/upload/public` at 07:25 UTC. So this narrows the
question rather than answering it: the CORS hypothesis now needs a Worker deployment timestamp, not
a git check.

What the row does settle: `field = cover_media`, `step = Photos & policy`, **`reason = null`**. The
event fires with no reason attached, so the row cannot say whether it was a size reject, a MIME
reject, a missing token, or a network failure. That is the §6 telemetry gap producing exactly the
outcome it was flagged for — an incident that cannot be reconstructed. Fixing the failure-branch
events is not tidy-up; it is the prerequisite for ever diagnosing this.

### Status of this audit

Three cross-review rounds. Every disputed claim was re-opened against source; the domain binding and
deployment revision are confirmed live. Remaining items are implementation work and one owner
decision (the creator earnings floor), not investigation. Both reviewers agree on the order:
**C01–C03 → review usability → ticket delivery → money.**

Accepted on the first batch: reuse the FTS helper from the shared publisher rather than adding a
third copy; give the admin path the same five-cover validation; and **do not silently truncate
reviewed media at publication** — enforce the cap before review/generation completes, or return an
actionable error. Noted and agreed: a helper export and a cover cap do not by themselves close the
approval and concurrency holes in C01–C03.

---

## Claude round 3 — accepting the qualifications, and one new blocker — 2026-09-04

Verified Codex's three qualifications against source. Read-only.

### Accepted — my wording was wrong

- **"Permanently bricked" — withdrawn.** Refuted on both layers. `cover_media` is in `EDITABLE`
  (`listings.ts:779`), no status gate touches it, and the wizard renders a `✕` on every cover
  including the AI poster with no status guard (`steps.tsx:560-566`, `ListingWizard.tsx:368-375`,
  `CreatorListings.tsx:237`). A creator can delete the poster. Bonus: any cover PUT re-runs
  `normFields`' `.slice(0, 5)`, so a 6-cover row self-corrects on the first photo edit.
- **"Wiping the rejection" — overstated.** The `→ draft` path changes current status only; it does
  not delete `listing_approval_history`. The practical effect is still that the creator sees no
  rejection (C04 — nothing exposes that history to them), but that is a missing-read defect, not
  data loss, and I should have said so.
- **"Invisible / no one can find it" — too strong.** Correct scope below.

### But the search half of C03 is real, and Codex's softening goes slightly too far

`exploreBrowse` reads the table directly (`listings.ts:1954`) — browse works, as Codex says. But
`exploreSearch` is the **only** FTS reader and it hard-returns empty when the index misses:

```ts
// listings.ts:2083-2092
SELECT listing_id FROM listings_fts WHERE listings_fts MATCH ?1 LIMIT 200
if (!idList.length) return json({ ..., listings: [], cursor: null });
```

So an admin-published listing **cannot be found by typing its own title**, only by browsing. Exact
wording: *un-searchable by name.* `admin_listings.ts` never imports `ftsSync` — it is module-private
to `listings.ts:719` (`compose.ts:2210` had to hand-roll a copy for the same reason).

Two caveats on "a later edit self-heals it", neither mentioned:

1. `ftsSync` only re-inserts when the row is `published`/`live` (`listings.ts:725`). An edit made
   while the listing sits at `approved` or `pending_review` **deletes** the FTS row and inserts
   nothing — the edit makes it worse.
2. Nothing triggers the heal automatically. No cron, no backfill. It requires the creator to
   happen to edit an `EDITABLE` field (`listings.ts:1254`). Self-healing that depends on an
   unprompted user action is not a mitigation.

### 🚨 NEW — Path A has no working browser join on EITHER deployment

Codex is right that the marketing worker "works" only in the sense of parsing. Reading it
(`marketing/public/_worker.js:61-105`), what a user with no app actually gets is an
`intent://` link whose `browser_fallback_url` is **the same page**, plus a Play Store button.
Tapping "Open in AvaTOK" without the app bounces straight back. No room URL, no guest join.

So both candidates fail, differently:

| Serves the apex | What an emailed `/j/<token>` gives a phone with no app |
|---|---|
| `avatok-app` (Astro, `web/`) | **404 "invalid or expired"** on a valid token — the `booking_id` mismatch (C05) |
| `avatok-web` (marketing worker) | An app-install card. A dead intent link on iOS/desktop. |

**And which project serves `https://avatok.ai` cannot be determined from this repo.** It is a
Cloudflare Pages custom-domain binding set in the dashboard. Both projects implement `/j/` and both
ship an `assetlinks.json`; `marketing/README.md` says the apex routes to `avatok-web`, while
`Specs/web-client/PROPOSAL-WEB-APP-PARITY-v3.md:217-219` describes a planned cutover to
`avatok-app` with no in-repo evidence it happened.

**This is a blocking unknown, and it is a 60-second dashboard check, not a code question.** Every
Path A estimate either review has given is unsafe until someone looks. My original "Path A is ~70%
built" was wrong for a reason neither of us had found: the browser viewer exists at `/live/<id>`,
but **no email link on either deployment can currently reach it.**

### Pricing

Agreed and closed as an open decision: the corrected minimum guarantees only ₹0 to the creator. The
earnings guarantee (≥20% of ticket, or ≥₹50/head, or none) is the owner's call and must be recorded
before minimum-price validation is written, using the same rounded fee function as checkout.

### Telemetry

Accepted — the corrected `hdavy2002@gmail.com` query shows listing, upload and checkout events do
exist. Note for whoever investigates the upload incident: `listing_cover_upload` **only fires on
success** (`ListingWizard.tsx:362`), so that single 2026-09-03 event is one *successful* upload and
says nothing about failures. The `listing_field_error` 40 seconds earlier is the more interesting
row. Until the failure branches emit events (§6), absence of evidence here is not evidence.

### Standing order of work — unchanged

C01–C03 first. Two additions to that batch, both one-liners: give `admin_listings.ts` access to
`ftsSync` (export it from `listings.ts` rather than a third hand-rolled copy), and apply the
5-cover cap on the admin write path.

---

## Claude's verification pass on the Codex review — 2026-09-04

I re-opened every file Codex cited rather than accepting its conclusions. Read-only; no prod writes.

### Verdict: Codex is right. 9 of 9 claims I spot-checked CONFIRMED, every line number correct.

Where it corrected me, it was correct and I was wrong. Specifically:

| My original claim | Correct position |
|---|---|
| "Reviewers can't filter Approved" | Wrong. `QueueRail.tsx:31` has it and `admin_listings.ts:11-13` passes any status straight to the bind. Only the advertised `statuses` array at line 14 omits it — metadata cleanup, not a blocked UI. |
| "Admin publish skips every check" | Overstated. It checks admin auth (`:150`), listing approval and poster approval (`:211-214`). What it skips is the creator-publication validation set and side effects. |
| "Moderation has no telemetry" | Wrong for the server. `admin_listing_detail_view` and `listing_moderation_action` exist at `admin_listings.ts:95,245`. The client-side gap is real; the blanket claim was not. |
| "Zero payment-gateway code in `app/lib`" | Wrong. `MoneyApi.topupIntent` (`money_api.dart:174`) and a native Stripe PaymentSheet (`wallet_screen.dart:542`) both exist. They fund the **wallet**, not a direct event purchase — so the product conclusion survives, but the evidence I gave for it was false. |
| "Wire the ₹100/hr into the `F` slot in `taxFor()`" | Wrong, and Codex caught the reason. `taxFor(config, taxableBase)` takes **one** number (`commercial_tax.ts:48`) and `F` is a **buyer-additive** fee — `taxableBase = P + F`, buyer pays more. The owner chose an **inside-price** commission. Putting it in `F` inverts the decision. Commission belongs in the creator/platform split that runs on `taxableBase`. |
| "`price >= 100 * hours` prevents negative earnings" | **Arithmetically wrong.** It ignores the marginal cut. Verified: 3 hr at ₹300 → platform ₹320, creator **−₹20**. See the corrected rule below. |

### Where Codex UNDERSTATED — C01 is worse than it says

`listings.ts:1663-1679` rejects exactly one **source** status (`draft`) and permits four targets. So the bypass set is not the three transitions Codex listed — it is **every status except draft**, including `completed → live` and `cancelled → live`.

And there is a second hole Codex missed on the same endpoint: `to === "draft"` is reachable from `rejected`. A creator whose listing was rejected can silently launder it back to an editable draft, wiping the rejection from the creator-visible state. Combined with C02 (edits don't reset approval), the moderation gate is advisory rather than enforced.

Two consequences nobody has stated yet:

- **An admin-published listing is invisible.** The admin path never runs `ftsSync` or `fanout`, so it is never search-indexed and never announced to followers. Approving a listing through the admin UI produces a listing no one can find.
- **Admin publish can brick the creator.** Admin publish has no cover-count check, so poster + 5 uploads = 6 covers ships fine; the same listing can then never be re-published by the creator, who hits `max 5 photos` 400 at `listings.ts:1532` with no way to delete the admin's poster.

### Where Codex OVERSTATED — three scope corrections

1. **C05 is narrower than "the browser join-link contract is broken."** Only the Astro `/j/[token]` route 404s. The Flutter resolver parses the id out of `deeplink` (`commercial_customer_screens.dart:662-664`) and the marketing worker renders from title/time/creator (`marketing/public/_worker.js:82-98`). Both work today. The fix is still needed; the blast radius is one route.
2. **C07's stuck-`sending` hole is narrower.** A non-2xx Brevo response *is* handled — `consumers/src/index.ts:391` sets `state='failed'` and retries correctly. Only a thrown fetch error (DNS, timeout, abort) strands the row. Still a real P1, but "existing email retry state can silently lose mail" applies to the throw path, not the whole rail.
3. **C02's poster forgery does not self-publish.** `approve_listing` still requires an admin and rejects any source status outside draft/pending_review (`admin_listings.ts:203`). Forging `attrs.poster.status` defeats the **poster** half of the two-key gate and locks admins out of regeneration (`:167`) — it does not get a listing published on its own.

### One process flag

Codex queried PostHog for **hdavy2005@gmail.com**. The email nominated for this investigation was **hdavy2002@gmail.com**. Its "no matching listing/checkout/upload/email events in 30 days" result may simply be the wrong person. Re-run before treating that as evidence of anything.

### The corrected pricing minimum

Codex's arithmetic is right; adopt it. The general closed form, for reference:

```
creatorPerHead = p − (100H + round(0.20 × max(0, p − 200))) ≥ 0

H ≤ 2 :  minPrice = 100H
H ≥ 3 :  minPrice = ceil(125H − 50)     # 3h→₹325, 4h→₹450, 8h→₹950
```

**But do not implement the closed form.** Implement Codex's recommendation instead: validate
`creatorPerHead >= 0` using the **exact same shared fee function** the checkout uses. A second
formula in a validator is how the quoted price and the charged price drift apart — the failure
`web/src/lib/money.ts:79-80` was written to prevent.

⚠️ **One thing neither review has resolved, and it is an owner decision, not arithmetic:** at the
minimum price the creator earns exactly **₹0**. A rule whose floor is "the creator works for
nothing" is a rule creators will hit and resent. The real question is whether the floor should be
a creator *earnings* floor (e.g. creator keeps ≥ 20% of the ticket, or ≥ ₹50/head) rather than a
break-even floor. That changes the minimum price at every duration.

---

<details>
<summary>Historical Claude audit and recorded owner decisions — preserved for comparison; corrections above take precedence</summary>

# AUDIT 2026-09-04 — Listing pipeline, approval, images, email, join-stream, commission

Read-only audit. Nothing was changed, deployed or written to prod.
Plain English, point form. Every point is from real code, with file:line.

---

## 0. The 10 things that will bite you first

1. **The app cannot create a listing any more.** The Flutter flow still calls `/publish`, which now 409s unless the listing is already approved. The app has no `/submit` call at all. The creator just sees "Publish failed." — `app/lib/features/listings/create_listing_flow.dart:311`, `worker/src/routes/listings.ts:1469`.
2. **A paid live event on the web sends NO email.** Zero. The commercial checkout never touches the email queue. But the confirmation screen tells the buyer "We emailed your confirmation" — `web/src/islands/checkout/Confirmation.tsx:109`. That sentence is a lie today.
3. **Where an email does fire (old lane), the join link goes to the WRONG room.** `/j/<token>` redirects to `/session/<booking>` = the 1:1 consult room. A live-event ticket holder lands there and gets a 403 — `web/src/pages/session/[booking].astro:11`, `worker/src/routes/commercial_stream_sessions.ts:673`.
4. **Admin "publish" skips every safety check.** The admin button does a raw SQL status update — no KYC, no photo check, no date check, no fee charge — `worker/src/routes/admin_listings.ts:211-236`.
5. **The creator never sees why he was rejected.** The reason is saved, but no creator-facing route ever reads it back — `admin_listings.ts:117-131` vs `listings.ts:1842`.
6. **Photos are never checked before going live.** They get scanned asynchronously, but no listing code ever reads the scan result. A rejected or unscanned photo can be live on a listing — `listings.ts:857-863`.
7. **Live events and consults have no master kill switch on create/publish.** `marketplaceEnabled` only covers sell/buy/social — `listings.ts:72`.
8. **No card payment inside the app.** Zero payment-gateway code in `app/lib`. In-app is wallet-only today.
9. **The commission model you just described does not exist anywhere.** Today it is a flat 20% of price. No per-hour fee, no ₹200 threshold, no marginal rate — `worker/src/routes/commercial_checkout.ts:612-619`.
10. **Your new pricing rules contradict each other.** See §5 — I need one decision from you before any of it can be built.

---

## 1. Listing pipeline

### What works
- Web wizard is the real path: 8 steps, saves a draft, then **submits for review** — `web/src/islands/dashboard/listing-form/ListingWizard.tsx:253, 414`.
- Real state machine exists: `draft → pending_review → approved/rejected → published → live/completed/cancelled`.
- There **is** a real admin review UI — `web/src/pages/admin/listings.astro` + `web/src/islands/admin/AdminListings.tsx`. Approval is not manual SQL.
- Approval history is recorded — `worker/migrations/2026-09-03-marketplace-approval-history.sql`.

### Gaps
- **App is broken** (see §0.1). Needs a `/submit` method in `app/lib/core/listings_api.dart` and a matching error handler.
- **Submit validates nothing.** An empty draft can enter the review queue — `listings.ts:1272-1310`. Title, price, date, category, photo: none checked at submit.
- **`approved` is missing from the admin queue's status filter** — `admin_listings.ts:14`. Reviewers can't filter for the exact state that publish requires.
- **Two publish doors**, one guarded (creator) and one not (admin) — §0.4.
- **No price ceiling anywhere.** A ₹99,999,999 listing publishes — `listings.ts:849, 1501`.
- **Consults have no duration check** and no past-date check; those rules are inside an `if (kind === 'live_event')` — `listings.ts:1554-1556`.
- **`currency_display` defaults to "USD"** on create, even though the unit is ₹ — `listings.ts:1053`.
- **`sessionVersion` is hardcoded to 1.** Re-running the same listing reuses the same GetStream call id — `worker/src/lib/commercial_stream_sessions.ts:338, 341, 395`.
- **A second unmoderated pipeline exists**: AvaVision agents publish straight to `published` with no approval — `worker/src/routes/avavision.ts:665`.
- **`reviewerModeEnabled` / `reviewerEmails` have nothing to do with listing approval.** They are an app-store/payment-reviewer onboarding hint stored in `localStorage` — `web/src/lib/reviewer.ts:7-18`. Don't confuse the two.

### Telemetry gaps
- Submit-for-review emits **no server event** — `listings.ts:1272-1344`.
- The **entire admin moderation UI has zero PostHog**. No approve/reject/publish events, no reviewer time-to-decision.
- **No time-in-queue metric** anywhere.

---

## 2. Images — upload + AI poster

### What works
- Web upload: `ListingWizard.tsx:331-367` → `POST /upload/public` → public R2. Max 5 photos, 8 MB each (client-side only).
- AI poster: Google Vertex `gemini-3.1-flash-image`, triggered on submit if `posterAutoGenerateOnSubmit` is on — `worker/src/lib/listing_poster.ts:108`, `worker/src/routes/ava_image.ts:432`.
- Images are served through the Cloudflare AVIF transform on public surfaces — `web/src/lib/config.ts:55-75`.
- AI-generated images get a prompt check AND an output safety check — `ava_image.ts:435-439, 475-476`.

### Gaps
- **The 2026-09-02 upload failure has a named cause and a fix dated BEFORE the incident.** Missing CORS headers (`x-file-name`, `x-app`) caused a silent "Failed to fetch" with no status and no log; the fix is `worker/src/util.ts:4-37`, commit dated 2026-08-30. **So either the fix wasn't deployed, or it's a second cause.** Check what is actually live, not the source.
- **Every upload failure branch is silent.** No token, wrong type, too big, non-200, network error, save-after-upload failure — 7 branches, zero PostHog events — `ListingWizard.tsx:332-375`.
- **`listing_cover_upload` only fires on SUCCESS.** The telemetry catalog says it should carry `reason/size/type/ms` and an error outcome; it carries none of that — `ListingWizard.tsx:362` vs `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md:127`.
- **No server-side image size cap at all.** Only videos are capped (64 MB). The 8 MB limit is client-side and trivially bypassed — `worker/src/routes/media.ts:241`.
- **No client-side compression on web** (the app does compress). Big phone photos go up raw.
- **Creator photos are never gated on moderation.** Scan runs async; nothing reads the result. And `cover_media` accepts **any** https URL — a creator can paste an off-site image that is never scanned — `listings.ts:857-863`.
- **AI posters are stored without a moderation queue message and without a `user_media` row** — `listing_poster.ts:114-116`.
- **AI poster generation has no spend cap and no cost tracking.** No `imageDailyCap` check on this path, no `$ai_generation` event, no wallet debit. Every submit can burn Vertex money — `ava_image.ts:418-484`.
- **No durable retry.** Generation is a fire-and-forget `waitUntil`, not a queue. If the isolate dies, the poster is lost until the creator re-submits — `listings.ts:1326-1341`.
- **Two Flutter upload helpers, one silent.** `sell_listing_flow.dart:110-125` swallows every error with `catch (_)`; the good one is `marketplace_api.dart:364`. The bad one is still mounted from 4 places.

---

## 3. Email

- **Provider actually wired: Brevo only.** Not Resend, not Novu (Novu is dark) — `consumers/src/index.ts:375`.
- Email templates live in one file — `worker/src/cal/emails.ts`. Contains title, times, other party, ₹ price, an ICS attachment, and one CTA.
- The join link is a **plain https URL**, `https://avatok.ai/j/<token>`, HMAC-signed — `worker/src/cal/ics.ts:39`.
- **Android App Links are configured** (`autoVerify`, host `avatok.ai`, prefix `/j/`) — `app/android/app/src/main/AndroidManifest.xml:208-212`. So on Android, installed app intercepts, not-installed opens the browser. Good.
- **iOS is not configured** — no `apple-app-site-association` file anywhere.

### Gaps
- **Paid live/consult checkout sends no email at all** (§0.2).
- **The link routes to the wrong room** (§0.3). There is no `/live/` variant of the join URL builder.
- **No telemetry on the email path.** No `email_sent`, no `/j/<token>` resolve event.

---

## 4. Join the stream — the three paths you described

### PATH A — email on phone, app NOT installed → join in browser
**Verdict: about 70% built, blocked on two things.**

- ✅ There **is** a real browser stream viewer using the GetStream web SDK — `web/src/pages/live/[id].astro` + `web/src/islands/live-gs/LiveGsViewer.tsx`. This was the big unknown and the answer is good.
- ✅ `/j/<token>` works with no app installed — `web/src/pages/j/[token].astro`.
- ❌ No email is sent for paid events.
- ❌ The link points at the consult room, not the live room.
- ❌ The browser page still forces a Clerk sign-in before joining — `LiveGsViewer.tsx:88`. So the emailed link is **not one-tap**.
- ❌ `commercialLiveJoinEnabled` is `false` by default — `worker/src/routes/config.ts:1793`.

### PATH B — browsing on phone, no app, not logged in → pay, email OTP, join
**Verdict: the whole chain exists in code, but not the way you described it.**

- ✅ Chain is present: `/book/[id]` → email + 6-digit code (**no password**) → pay → entitlement → `/live/<id>` viewer.
- ❌ **Payment requires auth first** — `worker/src/routes/commercial_checkout.ts:335`. You cannot pay then verify; you must verify then pay.
- ❌ **The OTP creates a real Clerk account.** Your "no account creation" requirement is not literally met — it *feels* like guest checkout (one field, one code) but a real account is made. Decide if that's acceptable; if yes, Path B is mostly a flag-flip and copy job.
- ❌ All card gateways default off — `config.ts:1810-1815`.
- ❌ There is a "guest token" concept but it is **display-only** and explicitly says so: "actually joining still requires the app + Clerk auth" — `worker/src/cal/ics.ts:3-5`.

### PATH C — has the app → pay by card or wallet → join
**Verdict: wallet works, card does not exist.**

- ✅ In-app checkout + in-app GetStream join both exist — `app/lib/core/commercial_checkout_api.dart:83`.
- ✅ Wallet debit + escrow at checkout — `commercial_checkout.ts:481-497`.
- ❌ **No card rail in the app.** Zero gateway references in `app/lib`. Today it is "wallet, or top up the wallet via Google Play".
- ⚠️ Note the pivot says payments move to web and the app goes read-only for money. **"Pay by card in the app" contradicts your own pivot decision.** Pick one.

### Mid-stream join
- ✅ Buying a ticket while the event is live is already allowed — `commercial_checkout.ts:366`.
- ✅ The late joiner pays **full price, per seat, no pro-rating**.
- ❌ But you cannot join-and-pay in one step: join 403s without a pre-existing ticket — `commercial_stream_sessions.ts:596-599`. The buyer must go back to checkout first.

---

## 5. Commission — the new model

### What exists today
- **Flat 20% of price.** `commercialCreatorFeePct = 80` → creator gets `round(price × 80/100)`, platform gets the rest — `commercial_checkout.ts:612-619`.
- Buyer pays `Price + Fee + GST`. **The flat-fee slot `F` already exists and is hardcoded to 0**, deliberately, so it can be switched on later — `worker/src/lib/commercial_tax.ts:6-8`. That is where your ₹100/hr plugs in.
- Listing publish fee exists: 5 free per 30 days, then 100 tokens — but `listingFeeEnabled` is off — `worker/src/lib/listing_billing.ts:18-20`.
- **Elapsed time is fully tracked already.** Session start/end and per-participant `connected_ms` all exist — `commercial_stream_sessions.ts:1605-1683`. Per-hour billing needs **no new instrumentation**.
- **A creator-side hold at go-live already exists** for free events — `worker/src/lib/free_session.ts:121-152`. That is the exact mechanism for "charge the creator ₹100/hr even if nobody joins", just with the settle rule inverted.
- Payout takes **no** commission — the whole cut is taken upstream at settlement — `worker/src/routes/upi_payout.ts:42-68`.

### The model, as decided by the owner 2026-09-04

- Fee is taken **inside** the ticket price. Buyer pays the listed price; the platform cut comes out of it.
- **₹100 per hour, per participant.**
- Hours = the **listed `duration_min`**, not actual elapsed time. So the bill is known at listing time and can be shown in the wizard.
- Above ₹200 the 20% marginal cut **stacks** on the hourly fee.

Formula, per participant:

```
hours          = ceil(duration_min / 60)          # rounding rule TBD, see below
platformPerHead = 100 * hours
                + (price > 200 ? round(0.20 * (price - 200)) : 0)
creatorPerHead  = price - platformPerHead
```

Worked examples (1-hour event):

| Price | Heads | Platform/head | Creator/head | Platform total | Creator total |
|---|---|---|---|---|---|
| ₹200 | 3 | ₹100 | ₹100 | ₹300 | ₹300 |
| ₹500 | 3 | ₹160 | ₹340 | ₹480 | ₹1020 |
| ₹1000 | 10 | ₹260 | ₹740 | ₹2600 | ₹7400 |

### 🚨 The model goes negative on long events — needs one more decision

`platformPerHead` scales with hours but `price` does not. So:

| Price | Duration | Platform/head | Creator/head |
|---|---|---|---|
| ₹200 | 1 hr | ₹100 | ₹100 ✅ |
| ₹200 | 2 hr | ₹200 | **₹0** ⚠️ |
| ₹200 | 3 hr | ₹300 | **−₹100** 🚨 |
| ₹500 | 4 hr | ₹460 | ₹40 ⚠️ |

A 3-hour event at ₹200 means the creator **owes the platform money per viewer**. `duration_min` is
validated up to 480 minutes (8 hours) — `worker/src/routes/listings.ts:1555` — so this is reachable
today, not a theoretical edge.

**DECIDED 2026-09-04 — minimum price by duration.** A listing cannot be published unless
`price >= 100 * hours`. A 3-hour event must be priced ≥ ₹300. Enforced server-side at publish
(alongside the existing checks in `worker/src/routes/listings.ts:1491-1565`) **and** surfaced live in
the wizard as the creator types the price, so he never hits the error blind.

### The "nobody joins" rule also breaks under per-participant

"If no participants join, the creator is charged ₹100/hour." But the fee is **per participant**, and
zero participants × ₹100 = ₹0. So the no-show charge cannot be the same rule — it has to be a
separate **per-event floor**: `max(sum of per-head fees, 100 * hours)`, charged to the creator when
attendance revenue doesn't cover it.

Mechanism already exists: the creator-side hold at go-live in `worker/src/lib/free_session.ts:121-152`.
Same escrow, same idempotent op-ids — the settle rule is just inverted (spend the floor instead of
refunding it).

### Settled

- **Hour rounding — DECIDED: round UP to the whole hour, minimum 1 hour.** 45 min = 1 hr = ₹100.
  90 min = 2 hr = ₹200. `hours = max(1, ceil(duration_min / 60))`. No fractional rupees anywhere in
  the hourly component, which matters because tokens are whole-rupee integers.
  The only place fractions can still appear is the 20% marginal band (₹237 → ₹7.4); use `Math.round`
  there, matching `commercial_checkout.ts:618`, and mirror it exactly in `web/src/lib/money.ts`.

### Still open
- **Mid-stream joiner** pays the applicable fee — today that is the full ticket price, no pro-rating.
  Consistent with per-participant billing, so no change needed unless you want pro-rating.
- **₹200 is a breakpoint, not a cap.** Nothing in the code should reject a price above ₹200.

### What's missing in code
- No config key for: per-hour fee, ₹200 threshold, 20% marginal rate, 4K surcharge, no-show charge. All must be added to `PlatformConfig`, `DEFAULTS` **and** `numericKeys` together, or they become fake flags that silently can't be set.
- **No creator-facing fee/earnings preview anywhere.** The wizard shows nothing; `RemoteConfig.commercialCreatorFeePct` is fetched by the app and never displayed. Meanwhile `web/src/pages/pricing-fees.astro:115` **publicly promises** this disclosure. The site promises something the product doesn't do.
- **4K is completely greenfield** — no resolution field on listings, no quality config.
- **Rounding is inconsistent across 6 sites** (`round` in most, `ceil` in `free_session.ts`). Your 20% band produces fractions on most prices: ₹237 → ₹7.4, and ₹201 → ₹0.2 which rounds to **₹0**, so the marginal rate does nothing for the first few rupees.
- **A settlement invariant will break.** `commercial_settlement.ts:221` hard-asserts `creator === round(gross × pct/100)`. A time-based fee isn't known at checkout, so this assertion must be reworked — carefully, because the sibling assertion at `:219` is what stops creators being paid out of tax money.
- Three files each read `commercialCreatorFeePct` separately (`commercial_checkout.ts`, `pay.ts`, `cashfree.ts`). **Put the new maths in one pure function** or they will drift.

---

## 6. Suggested order of work

**Fix-first (broken now, small):**
1. Add `/submit` to the Flutter listings API + fix the 409 error handler.
2. Add `approved` to the admin queue status list.
3. Make the admin publish door run the same validation as the creator door.
4. Show the rejection reason to the creator.
5. Delete or fix `sell_listing_flow.dart`'s silent upload.
6. Add PostHog to every upload failure branch + the admin moderation UI + submit-for-review.

**Then the join story (the actual product):**
7. Send a ticket email from the commercial lane.
8. Add a `/live/` join URL and route live tickets there, not `/session/`.
9. Decide the guest question — is "email + code creates a Clerk account" acceptable? If yes, Path B is close to done.
10. Add `apple-app-site-association` for iOS.

**Then money (blocked on your decision):**
11. Answer the 5 pricing questions above.
12. One pure fee function → wire into the existing `F` slot in `taxFor()`.
13. Creator-side hourly hold at go-live, modelled on `free_session.ts`.
14. Fee preview step in the listing wizard.
15. Join-and-pay in one step for mid-stream.

---

*Audit performed read-only. `.avatok-target` was set to `prod` for this session; no production write was made.*

</details>
