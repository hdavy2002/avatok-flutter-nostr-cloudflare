# Independent review — listing approval authority — 2026-09-04

> **Resolution update — 2026-09-05:** R01–R11 and the two scoped lifecycle
> follow-ups were remediated in `0f599a31`; the deployment-path correction is
> `85f75754`. Web run
> [33906492556](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/33906492556)
> and Worker run
> [33906663871](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/33906663871)
> succeeded. Worker typecheck and 56 focused tests passed before the D1 migrations
> and Worker version `1419d16a-6b9e-45a8-8a5e-08340d637c4f` deployed. The findings
> below remain as the pre-fix evidence; implementation details and remaining manual
> verification are recorded in section 8 of the change record.

Reviewed `Specs/CHANGE-2026-09-04-listing-approval-authority.md` against commits `fa44bc21` and `e369ea6b`, base `a5f996ec`. Relevant Worker/web files were clean against HEAD `e369ea6b`. Existing unrelated changes were left alone.

**Verdict: useful improvements, but not ready for production sign-off.** The creator status endpoint now has a real conditional transition guard; the admin publisher correctly uses the creator's identity/wallet and gains FTS/fan-out. The change record honestly declares its test limits. However, the HTTP/database integration leaves significant authority and lifecycle defects.

These are source-confirmed failure paths, not claims that exploitation or a production charge occurred. This review made no application-code changes, builds, test purchases, moderation actions or deployments.

## Findings

### R01 — P1: approved marketplace publication cannot finalize

**Evidence:** `worker/src/routes/listings.ts:1798-1803,1938-1976`; `worker/src/lib/listing_billing.ts:520-526`.

The shared publisher requires `approved`, then consumes a marketplace listing entitlement before calling `finalizeListingPublication`. That helper accepts only `draft` or `published`, and its UPDATE has the same two-state restriction. Therefore a normal approved sell/buy/social listing cannot finalize: after entitlement consumption it returns 503 and remains approved. A paid entitlement can already have debited tokens; a free entitlement can already have consumed quota. Retrying does not repair the incompatible source-state requirement.

The helper mismatch predates these two commits on the creator path. Routing previously working admin publication through it makes it a regression for the admin door as well. **Fix the finalizer's approval/version contract and recovery semantics together**, not by temporarily demoting the row to draft. Cover this with an HTTP/database test for both free and paid listing entitlements.

### R02 — P1: approval, edit and publish still race through unconditional writes

**Evidence:** `listings.ts:1278,1457-1522,1979`; `admin_listings.ts:341,367-371`.

The new protection makes decisions from a row read earlier, but updateListing, admin approval and non-market publication still write with only `WHERE id=?1`.

Concrete interleavings:

1. A creator edit reads pending_review. Admin approval then records the old content hash. The creator edit finishes without demotion because its earlier snapshot was pending_review. The final row is approved with changed, unreviewed content.
2. Publication reads approved. A material edit demotes the row to pending_review while publication awaits validation/slot work. Publication's final unconditional UPDATE restores published, bypassing the demotion.
3. Admin approve/poster actions can restore a stale status/hash after another action changes the row.

The sell-before-edit check also reads `commercial_entitlements` through `metaSession` (`listings.ts:973-980`), whose first query is explicitly replica-unconstrained (`db/shard.ts:53-54`). A lagged zero count or a purchase racing the final edit can defeat the stated sold-seat protection.

**Fix:** use one serialized authority or conditional version/status/hash writes across all these paths, with authoritative sale reservations checked at the same boundary. A read-time hash comparison alone does not close the race.

### R03 — P1: existing approved/published listings remain outside review protection

**Evidence:** `worker/migrations/2026-09-04-listing-reviewed-version.sql:20-23,35-37`; `listings.ts:1457`.

The migration deliberately leaves every existing row's hash NULL. updateListing applies both review invalidation and sold-seat protection only when `row.reviewed_content_hash` is truthy. An existing approved/published/live listing can therefore still change its price, title or covers without re-review or the new sold-seat refusal.

There is no automatic path that makes already published listings “re-earn” a hash. **Define a safe migration policy:** permit unchanged legacy operation if necessary, but require review for material edits with no trusted baseline. Do not backfill a hash and label it human approval without evidence. The exact current count of affected production rows was not retrieved: the read-only D1 query was denied (Cloudflare 7403).

### R04 — P1: creator publication still bypasses poster approval, and neither door verifies the content hash

**Evidence:** `admin_listings.ts:235-238`; `listings.ts:1790-1834,1979,2021-2025`.

Poster approval is still checked only in the admin wrapper. The creator wrapper calls the shared publisher directly, which accepts an approved listing even if its poster is draft, rejected or generating. An admin approving the listing is enough for the creator to bypass the remaining poster decision.

The publisher also never compares the current content hash to `reviewed_content_hash`. Consequently stale approvals created by R02, poster-generation writes, or other writers are accepted. **Move both authority checks into the shared publisher**, bind them to the exact version being published, and keep them in the final conditional commit.

### R05 — P1: a second creator-writable internal attribute can swap reviewed covers

**Evidence:** `listings.ts:238-253`; `admin_listings.ts:50-54,304-322,341,369`; `categories.ts:461-463`.

Only `poster` is reserved. A creator can still store `attrs.__generated_cover_media`: unknown attrs are allowed, and an array under that key passes generic attrs serialization. Admin detail deliberately hides this key from the reviewer. On the next non-publish admin action, the handler consumes it as trusted generated media and replaces cover_media; approving the listing then hashes the substituted gallery. The reviewer can thus approve a gallery different from the one they were shown.

**Fix:** remove this temporary transport value from persistent creator attrs entirely; keep generation output in a request-local variable. Reserve/reject internal namespaces on every creator write.

A related hole remains in the “cannot erase poster” claim: `sanitizeCreatorAttrs(null, existing)` returns null and `encodeAttrs(null)` explicitly allows clearing the column (`listings.ts:203-205,247`). Handle explicit clearing without deleting server-owned metadata.

### R06 — P1: AI compose is a live third publication path without admin approval

**Evidence:** `worker/src/routes/compose.ts:303-317,1938-1948,2154-2184`; mounted at `worker/src/index.ts:1699`.

`POST /api/marketplace/compose/publish` creates a `sell` listing directly as published, or promotes an existing draft with raw SQL. It runs identity, automated text moderation and entitlement checks, but no admin approval, review hash or shared publisher. This uses the same listings table; it is not the separate AvaVision pipeline listed as out of scope.

The live config read during this review returned `marketplaceEnabled=true`, `marketplacePublishEnabled=true`, and `aiComposeEnabled=true`. **Either route compose output into submission/review or record an explicit product exemption.** “One publication authority” is not currently true.

### R07 — P1: host joining backstage is treated as confirmed public go-live

**Evidence:** `commercial_stream_sessions.ts:1670-1708,1169-1171`; [Stream call lifecycle documentation](https://getstream.io/video/docs/api/call-lifecycle/).

The branch matches both `session_started` and `live_started`. Stream distinguishes them: session_started means the first participant joined, including a host joining backstage; live_started means the call left backstage.

Therefore host preparation can set commercial_sessions.state to live and the new helper can mark the listing LIVE and notify followers before the broadcast actually starts. The real Go Live endpoint then rejects because it permits only scheduled/backstage sessions. The session classification error existed before this change; the new projection extends its effect to listing status and follower notifications.

**Fix:** separate participant-session lifecycle from broadcast lifecycle. For livestreams, project public live only from the relevant broadcast confirmation. Add a host-backstage → Go Live sequence test, not only a transition-table test.

### R08 — P2: listing projection has no durable recovery and no matching commercial completion projection

**Evidence:** `commercial_stream_sessions.ts:1537-1558,1684-1716,1719-1830,1946-1952`; `listings.ts:2144-2158`.

If session state is committed live but `systemMarkListingLive` fails, the exception is swallowed and the provider event is marked applied. The same event is skipped on replay; another start event sees wasLive and skips projection. Reconciliation can also set a commercial session live without calling the listing helper. A temporary failure can leave a published card indefinitely, and a failure after the listing CAS but before fan-out loses the notification.

The commercial end branch ends the session and queues settlements but does not complete the listing. The table's system_complete row has no caller on this commercial path. The legacy money engine has its own completion write; that is not wiring for commercial settlement.

**Fix:** make projection/retry an idempotent durable operation for live and terminal states, with separately idempotent notification delivery. The document's concern about two simultaneous calls does not by itself prove duplicate fan-out: the listing UPDATE's status CAS already makes one contender lose. The concrete gap is recovery after partial success.

### R09 — P2: the reviewed-field list excludes visible substance, not just bookkeeping

**Evidence:** `listings.ts:923-926,1037-1044,1057-1074`; `web/src/islands/admin/SubmissionPanel.tsx:71-100,120-130,163`.

video_url, blurb, billing_unit, recurrence/timezone, credential and adults_only are editable and absent from the hash. These are shown in the actual admin submission panel. A creator can replace the video, change advertised billing/schedule terms, or change the adult-content label while retaining approval, including on a listing with sold entitlements because the hash does not change.

**Fix:** classify fields by their customer/reviewer impact, rather than treating every field outside the initial list as presentation. At minimum include reviewed public media and substantive terms. A hash test that asserts these fields are ignored enshrines the omission; it does not validate the product policy.

### R10 — P2: the new six-cover refusal leaves manual poster generation stuck

**Evidence:** `admin_listings.ts:198-199,213,314-320,367-371`; `lib/listing_poster.ts:127-136`.

Manual generation writes poster.status=generating before calling the image provider. With five non-poster covers, generation returns six; the new cap returns 400 before persisting the completed poster or changing the placeholder. The listing remains generating and regenerate_poster refuses that state. Removing a cover does not reset it. The separate generate_poster action can recover, so this is not permanent data loss, but normal regeneration is stuck and another paid generation may be needed.

**Fix:** check available capacity before generation, or land an explicit terminal failure and preserve the generated result for recovery. Do not leave a permanent generating placeholder on a validation return.

### R11 — P2: existing non-allowlisted free listings cannot follow the UI's recovery instruction

**Evidence:** `web/src/islands/dashboard/listing-form/steps.tsx:91-115`; `web/src/lib/listingErrors.ts:112`; `listings.ts:1299-1316`.

For an existing free listing belonging to an account outside the allowlist, the wizard removes the checkbox and shows a read-only “free show” state. Every edit then fails because effectiveFreeEntry remains true. The error tells the creator to turn the free-show option off, but that control is absent.

**Fix:** allow turning off an existing free setting while preventing turning it on; preserve explicit user choice and require a valid paid price.

## Other scoped follow-ups

- The free-entry capability is checked at create/update, not in the shared publisher or commercial go-live. Previously created free listings, or listings whose creator later leaves the allowlist, are not rejected by those boundaries. Decide and enforce whether the restriction governs only creating new free listings or operating them too; the helper currently describes “create or hold.”
- `worker/src/routes/live.ts:144` remains another direct listing-live writer, mounted at `index.ts:1517`, after allocating a legacy Cloudflare Live Input rather than confirming a broadcast. The inspected handler does not read liveEnabled; provider credentials are still a prerequisite. Thus “systemMarkListingLive is the only writer” is false even apart from the commercial event issue. No legacy start request was issued.
- The document's “no real money moved” cannot be established from billing flags alone. Existing wallet tokens/free listing quota can still be consumed. No payment-ledger audit was performed.
- Already documented work such as Flutter submit/resubmit, media moderation, ticket email/links, pricing and group consultations remains outside this implementation review.

## Verification and next steps

- Read the changed source, callers, billing finalizer, relevant web UI, migration and test code. No local test/build commands were run, per this project's tooling rules. Historical test counts and baseline-run claims were not independently reproduced.
- Read the live public config. All six commercial flags, marketplace/compose publication and the free-session feature were enabled; walletRealMoney, billingEnabled and gstEnabled were false; freeEntryAllowlistOnly was true. These are observations at review time, not DEFAULTS assumptions.
- Queried recent listing/commercial events for hdavy2002@gmail.com. Returned activity predated these new validation paths; it does not establish post-deploy behavioral success.
- A read-only D1 aggregate for status/hash counts was attempted through the mandated wrapper and denied with Cloudflare code 7403. No affected-row count is claimed.
- Review priorities: fix R01–R07 before calling approval authority closed. Add HTTP/database integration coverage for both publisher doors, old rows with NULL hashes, concurrent edit/approve/publish/purchase, hidden attrs, compose publication and backstage/live transitions. Then verify projection retry, end-of-session behavior, full gallery generation and non-allowlisted free-listing recovery in an authorized test environment.
