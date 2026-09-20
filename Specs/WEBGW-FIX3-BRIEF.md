# Stream FIX3: listing page / card copy still Hinglish; example notice on the canonical listing URL  (tag [WEB-GATEWAY-FIX3])

Worktree /Users/davy/.cache/deepastra/webgw-20260918/int, branch `webgw/int`. Read Specs/WEBGW-COMMON.md.
Never push, deploy, or run wrangler/cf.sh/gh workflow. web/ only. Keep every object KEY / id / data-i18n
attribute unchanged — change only the English VALUE strings. Plain English, no Hinglish, no banned words.

Context: the 8 example listings are live in production under `/avatok_team/<slug>` (e.g.
https://avatok.ai/avatok_team/ganga-havan-haridwar-live). A payment-gateway reviewer will open them.

## 1. Canonical listing page `web/src/pages/[username]/[slug].astro`

Stream E only patched `web/src/pages/l/[id].astro`. Port the same two things to `[username]/[slug].astro`:
`const isExampleListing = Boolean(listing.is_example)`, `noindex={closedListing || isExampleListing}` on
`<Base>`, and the "Example listing — This shows what creators will offer on avaTOK. Booking opens at
launch." notice bar (copy the markup from `l/[id].astro` verbatim, same data-i18n ids). Check whether
any other page renders a listing (grep for `ListingDetailsComp` / `ListingDetailView` usages) and do the
same there if so.

## 2. `web/src/lib/copy.ts` — the card / listing-detail copy dictionary

Every value that is Hinglish must become plain English. Known ones (there are more — read the whole
file): `PEHLA_SHOW: 'PEHLA SHOW'` → `'FIRST SHOW'`; `NAYA_AGENT: 'NAYA AGENT'` → `'NEW AGENT'`;
`laneName.adda: 'ADDA ROOM'` → `'GROUP ROOM'`; `liveWatching` → `` `LIVE · ${n} WATCHING` ``;
`'PAISA SAFE'` → `'PAYMENT PROTECTED'`; `'Paisa escrow mein — session khatam tak'` → `'Payment is held
until the session is delivered'`; `'Har host ki pehchaan check hoti hai — fake profile ka koi chance
nahi'` → `'Every host completes a liveness check'`; `'Kuch galat laga? Report karo, hum dekhenge'` →
`'Something wrong? Report it and we will look into it'`; the house-rules default, the review/Q&A
strings (`'Abhi koi review nahi — pehla tum likho?'` → `'No reviews yet — be the first.'`, the
question-limit / sign-in / link-blocked messages) — all to plain English of the same meaning. Update
any comment that quotes the old string only if it would otherwise mislead.

## 3. `web/src/components/ListingDetailsComp.astro` and `web/src/components/listing/ReviewsSection.astro`

- `'NAYA HOST'` (two places, ~lines 160 and 953) → `'NEW HOST'`.
- Section title "Public ki Rai" (~line 1047, and ReviewsSection.astro ~line 32: `<ui-copy …>Public ki</ui-copy>
  <span …>Rai.</span>` or similar) → "Reviews" — keep the same element structure and data-i18n ids, just
  change the text so it reads "Reviews." Check the CSS class comment "(Public ki Rai)" needs no change.
- alt texts `"Desi swag…"` (~line 785) and the vadapav/baccha "uncle" alts (~789, ~1066): neutral English
  descriptions of the illustration (e.g. "Illustration of a street snack stall").
- Any other Hinglish literal in the rendered part of this file (grep for: hai, karo, nahi, dekh, adda,
  dost, paisa, scene, boss, yaar). Comments can stay.

## 4. `web/src/lib/listingDefaults.ts`

The listing wizard's per-template default copy (`houseRulesIntro`, `whoFor`, FAQ answers, bodies) is
mostly Hinglish ("Ek chhota sa adda — sur bigde toh koi baat nahi…", "Bilkul nahi — …", "Comedy show
hai, roast bhi ho sakta hai…", "Fair khel, full masti — Google karna allowed nahi hai!", etc.). Rewrite
every Hinglish value in plain English with the same meaning. Keep ids, keys and structure; do not
remove templates. The `live_friends` / `adda_rooms` ids in the category list (~line 353) are data, leave.

## 5. Example cards: CTA must not say BOOK NOW

`web/src/components/ListingTile.tsx`: on a card with `c.isExample`, the primary CTA label "BOOK NOW"
(copy.ts `BOOK_NOW`, rendered ~line 623/706 area) must read "SEE EXAMPLE" (add `SEE_EXAMPLE: 'SEE
EXAMPLE'` to copy.ts and use it; keep the same button/link so it still opens the listing page). The
availability rung that prints "BOOKING OPEN" on an example card should print "EXAMPLE" instead — find
where `laneBadge.BOOKING_OPEN` / the availability chip is chosen in `web/src/lib/card.ts` and branch on
`card.is_example` there (smallest possible change; do not restructure the ladder).

## 6. Verify

From web/: `PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build && node
scripts/check-homepage.mjs && node scripts/check-help.mjs && node scripts/check-performance.mjs && node
scripts/check-image-urls.mjs`. Then `npx astro dev --port 4326`, curl
`/avatok_team/ganga-havan-haridwar-live` (it fetches the live prod API, so the example renders) and
confirm: `<meta name="robots" content="noindex, nofollow">` present; "Booking opens at launch" present;
zero matches for `Public ki|NAYA|PEHLA|Paisa|paisa|DEKH RAHE|hai\b|karo\b|nahi\b`; no href containing
`checkout`. Curl `/` and confirm the Featured cards show "SEE EXAMPLE" and not "BOOK NOW" / "PEHLA SHOW"
(the homepage is prerendered — check `dist/index.html` after the build instead if dev differs).

## 7. Commit and report

`python3 scripts/git_safe_commit.py "[WEB-GATEWAY-FIX3] Listing page/card copy in plain English; example notice on canonical listing URL" <paths>`
(fallback: `git add -- <paths> && git commit`). Write Specs/WEBGW-FIX3-REPORT.md with files changed and the verify output.
