# 07-takedowns — REPORT

Lane: internal surfaces that must not be reachable during a payment gateway review.
Base commit: `76003bb2b8fe8a574a4bc17bc17dbf4ff7d310bf` (branch `saathum/07-takedowns`).

## 1. HDFC UPI ₹1 SMS smoke harness — removed from the router

**What it was:** a whole family of routes (`worker/src/routes/hdfc_sms_qr.ts`,
`hdfc_sms_public.ts`, `hdfc_sms_payments.ts`, `hdfc_sms_customer_test.ts`) implementing an
internal test rail that proves bank-SMS-derived payment confirmation works, gated by the
`hdfcSmsEnabled` config flag. Fully documented in `Specs/HANDOVER-HDFC-UPI-SMS-PAYMENT.md`.
Explicitly **not** the commercial rail — it creates no commercial order, no wallet credit,
no entitlement (confirmed by re-reading that handover doc, not from memory).

**What changed** (`worker/src/index.ts`):
- Removed the 4 `import` statements pulling in `hdfcSmsQr`, `hdfcPublicOrder/Status/Claim/Recheck`,
  `hdfcSmsCreateOrder/Incoming/Status/Heartbeat/Method/Current/Claim/Recheck`, and
  `hdfcCustomerRedeem/Current/Order/Status/Claim/Recheck`.
- Removed all 20 route registrations for `/api/pay/hdfc-sms/*` and `/api/sms/incoming`,
  `/api/sms/heartbeat`.
- Left a comment at both the import site and the route site explaining why, pointing back
  here.

**Verified unreachable, not just paused:** the generic multi-gateway matcher right after
the removed block (`/^\/api\/pay\/([a-z]+)\/order$/` etc.) uses `[a-z]+` with no hyphen, so
it cannot accidentally re-catch `hdfc-sms`; and no other `/api/sms/*` matcher exists anywhere
in the file. Every one of these paths now falls through to the router's final
`json({error:"not found"}, 404)`. This is real removal from the served surface, not the
existing `hdfcSmsEnabled=false` soft-pause (which still returns an identifiable
`rail_paused` JSON body — a live endpoint a scanner can fingerprint).

**What was NOT deleted, and why:** the route handler files, the underlying
`worker/src/lib/hdfc_sms_smoke.ts` / `hdfc_sms_customer_test.ts` libraries, the D1 migrations,
and the Worker/browser test suites (`worker/test/hdfc_sms_*.test.ts`) are untouched. They test
the handler functions directly, not through `index.ts` dispatch, so they still pass. This
follows the SPEC's "nothing is deleted, hidden behind flags" default — the harness can be
re-wired by reverting this one diff if it's ever needed again, without resurrecting any code.

**Web-side surface also taken down**, since a gateway reviewer would find this by browsing,
not just by crawling API paths:
- `web/src/pages/test/upi.astro` (public "Scan to pay ₹1" QR page) → now returns a hard 404.
- `web/src/pages/test/upi/admin.astro` (admin smoke console) → now returns a hard 404.
- Their backing islands (`UpiPlainQr.tsx`, `UpiSmokeCheckout.tsx`, `UpiCustomerTestCheckout.tsx`,
  and the three `upi*Controller.ts` files) are now unreferenced by any page — left in place,
  dead code, no broken imports (verified by grep: nothing else imports them).
- `web/src/islands/checkout/GatewayPicker.tsx:98-99` already defensively filters `hdfc_sms`
  out of the methods list client-side ("Fail closed even if a cached/older Worker still
  advertises HDFC") — untouched, still correct, now redundant-but-harmless belt-and-braces.

**The Android companion — could not be touched from this repo, flagging as a follow-up:**
Per `Specs/HANDOVER-HDFC-UPI-SMS-PAYMENT.md:64,206`, the companion is a **separate
repository and release**, `hdavy2002/upeo-sms-gateway`, currently on Google Play Internal
Testing (companion version `1.0.6+6`). It does not exist anywhere in this worktree — I
confirmed with a repo-wide grep for `hdfc`/`sms` across `app/lib` (the Flutter app): zero
hits. There is nothing in this repo to remove for it. What I *did* do is close the server
side of the channel it depends on: with `/api/sms/incoming` and `/api/sms/heartbeat`
unregistered, an installed companion app can no longer successfully deliver anything even
if it's still running on a phone. Two things remain outside this worktree's reach and need
the coordinator/owner to action directly:
1. Unpublish `upeo-sms-gateway` from the Play Internal Testing track (or otherwise "withdraw"
   it as an app, not just its server access).
2. Rotate/clear the `HDFC_SMS_DEVICE_ID` / `HDFC_SMS_DEVICE_SECRET` production secrets so a
   sideloaded copy of the companion can't be pointed at a re-enabled endpoint later by mistake.
3. `.github/workflows/hdfc-sms-verify.yml` and `hdfc-sms-production.yml` are `workflow_dispatch`-only
   maintenance workflows for this same harness (deploy/configure-secrets). I did not touch,
   disable, or run them (out of scope, and I don't trigger workflows), but whoever eventually
   decides this harness is permanently retired should retire these too — right now they'd
   still let someone manually redeploy/re-enable the exact surface this task took down.

## 2. Listing questions inbox — hidden

**Finding:** `web/src/islands/listing/MessageHost.tsx:14-20` already documents, in its own
header comment, that the creator-facing question inbox has no client anywhere: *"the
creator-facing inbox route (`GET /api/questions/inbox`) has no client on any surface, web or
app — so a buyer's question went into a table nobody opens."* MessageHost already replaced
the old "Ask the host" flow's UI mounting point on every live listing page
(`web/src/components/ListingDetailsComp.astro`) — I confirmed the old `AskHost.tsx` island is
only mounted from `ListingDetailView.astro`, which is itself never imported by any page
(`web/src/pages/l/[id].astro`, `[username]/[slug].astro`, `e/[event].astro` all use
`ListingDetailsComp.astro` instead). On the Flutter side, `app/lib/core/listings_api.dart`
defines a `ListingQuestion` model that is never constructed or used anywhere else in `app/lib`.

**What changed** (`worker/src/index.ts`): removed the `GET /api/questions/inbox` route
registration (was line 1544, calling `listCreatorQuestions`) and dropped the now-unused
`listCreatorQuestions` import. It now falls through to the router's final 404.

**What I deliberately left alone:** `askQuestion` (`POST /api/listings/:id/questions`),
`listMyQuestions` (`GET /api/questions/mine`, the asker's own view), `answerQuestion`, and
`promoteToFaq` are untouched. The brief names "the listing questions inbox" specifically —
that's the creator's read side. The write path and the asker's own view are separate,
functioning surfaces I wasn't asked to touch, and `answerQuestion`/`promoteToFaq` require a
question ID a caller would only ever have obtained from the (now-dark) inbox anyway, so they
were already practically unreachable without it. `listing_questions.ts` itself is untouched.

## 3. `/[username]` now 404s for a handle nobody owns

**Finding:** `web/src/pages/[username]/index.astro` had exactly one guard — a regex on the
*shape* of the handle (`/^[a-z0-9][a-z0-9._-]{1,30}$/i`) — before unconditionally rendering
a hardcoded demo profile (`web/src/generated/creator-profile.dc.html`, a design comp with
mock data) at HTTP 200. There was no check that the username corresponds to a real,
registered user. Any syntactically valid but nonexistent handle (e.g.
`/this-handle-does-not-exist-12345`) rendered the same fake "Creator Profile" page — exactly
the kind of surface a gateway reviewer probing arbitrary URLs would flag as fake/deceptive
content served with a success status.

**What changed:** added a real existence check before the demo render, reusing the same
handle-or-uid lookup `web/src/pages/c/[handle].astro` already uses in production
(`getCreator()` in `web/src/lib/apiClient.ts`, backed by `routes/listings.ts getCreator`,
which does `SELECT ... FROM users WHERE uid=?1 OR handle=?1` and 404s if nobody matches). A
404/410 `ApiError` from that call now short-circuits to a real `404` response before the
mockup ever renders. Any other error still throws (SSR 500), matching `/c/[handle].astro`'s
existing behavior — this is not a place to swallow unrelated failures.

**Untouched:** the shape guard, `/c/[handle].astro` itself (the real data-driven creator
page — SPEC/comments both say it's a separate, unaffected surface), and the demo HTML/design
comp asset generation pipeline.

## What I could NOT verify

Hard rule 6 asks to curl the actual page and report the live status. **I could not run
`astro build`, `npx tsc --noEmit`, or start a dev server** — this worktree has no
`node_modules` anywhere (checked at repo root, `worker/`, and `web/`), and Hard Rule 2
forbids `npm install` inside a sandbox. Nothing here has been deployed (Hard Rule 8), so
there is no live URL to curl for this branch yet — verification is by careful manual
diff/grep review instead:
- Grepped for every removed identifier (`hdfcSmsQr`, `hdfcPublicOrder`, …,
  `listCreatorQuestions`) across `worker/src/index.ts` after the edit — zero remaining
  references, so no dangling-import compile error is expected (worker's `tsconfig.json`
  doesn't set `noUnusedLocals`/`noUnusedParameters` either way, so even a missed unused
  import would not fail typecheck).
- Grepped for every orphaned web component (`UpiSmokeCheckout`, `UpiCustomerTestCheckout`,
  `UpiPlainQr`) — confirmed no remaining importers, so no broken-import build error.
- Confirmed by regex inspection that the generic multi-gateway route matchers cannot
  accidentally re-catch any `/api/pay/hdfc-sms/*` or `/api/sms/*` path.
- Confirmed `getCreator`/`ApiError` are already exported from `web/src/lib/apiClient.ts` and
  used with the identical try/catch shape in `/c/[handle].astro`, so the new `[username]`
  guard follows an existing, presumably-already-working pattern rather than introducing a
  new one.

Recommend the coordinator run `worker/`'s typecheck and an `astro build` (or a staging
deploy) before merging, per Hard Rules 0/6, since I had no toolchain access to do it myself
in this worktree.

## Files touched

- `worker/src/index.ts`
- `web/src/pages/test/upi.astro`
- `web/src/pages/test/upi/admin.astro`
- `web/src/pages/[username]/index.astro`

No commits were made yet pending final review of this report — all changes are currently
uncommitted in the working tree, scoped to the four files above.
