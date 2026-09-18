# Stream FIX3 report — [WEB-GATEWAY-FIX3]

Commit: `6c3616f8` on branch `webgw/int` (local only, not pushed).

## Files changed

- `web/src/pages/[username]/[slug].astro` — ported `isExampleListing`, `noindex={closedListing || isExampleListing}` and the "Example listing — This shows what creators will offer on avaTOK. Booking opens at launch." notice bar from `l/[id].astro`, same `data-i18n` ids (`web-l.5f2a7c19be3d4e0a` / `web-l.7c6d0a2f915e4b3c`).
- `web/src/pages/e/[event].astro` — same patch. Found via `grep -r ListingDetailsComp` (brief's check): this route also renders `ListingDetailsComp` directly off `getListing()` with no `isExampleListing`/`noindex` handling, so an example listing shared as `/e/<id>` was indexable and showed no notice. Patched identically.
- `web/src/lib/copy.ts` — translated every Hinglish value to plain English (keys/ids untouched): `statusPill.SOLD_OUT`, `chips.seatsLeft`, `promises.*`, `promiseBand.*` (title, escrow/number/host/support/reviews titles+bodies, refund/cancel), `houseRules.*`, `reviewsCopy.*` (title → "REVIEWS", empty state, hostReply, loadMore), `askHost.*` (placeholder/submitting/success/alreadyAsked/rateLimited/masked/error/signInPrompt), `freeBox.full`/`spotsLeft`, `liveWatching()`, `laneBadge.PEHLA_SHOW`→"FIRST SHOW", `laneBadge.NAYA_AGENT`→"NEW AGENT", `laneName.adda`→"GROUP ROOM", `spotsLeft()`/`seatsBaakiUrgent()` functions, `ctaExtra.SUNO`→"▶ LISTEN". Also added two new entries used by item 5: `cta.SEE_EXAMPLE` and `laneBadge.EXAMPLE`. Updated stale-example doc comments that quoted old Hinglish strings (§ "SEEDHI BAAT NO CHAKKAR", `DEKH RAHE`, `BAAKI`, the old "SOLD OUT" comment).
- `web/src/components/ListingDetailsComp.astro` — `'NAYA HOST'` → `'NEW HOST'` (both places), "Public ki" / "Rai." → "Reviews" / "." (same two elements, same `data-i18n` ids, so the visible text reads "Reviews."), alt texts for `desi-swag.png`, `vadapav-uncle.png`, `dekho-pyar-se.png`, `baccha-uncle.png` rewritten as neutral English illustration descriptions, the `masala-quote__text` Bollywood-style quote and the handwritten aside line translated to English. `chill-uncle.png`'s alt ("Chill uncle with coconut") was left as-is — it's already plain English, not Hinglish, and wasn't in the brief's explicit list.
- `web/src/components/listing/ReviewsSection.astro` — same "Public ki"/"Rai." → "Reviews"/"." markup change (this file renders the paginated reviews section used elsewhere), plus the file-header comment updated.
- `web/src/lib/card.ts` — `uniformChips()`'s availability slot now branches on `card.is_example` before falling through to `BOOKING_OPEN`/`ENTRY_OPEN`, printing `laneBadge.EXAMPLE` ("EXAMPLE") instead — smallest possible change, ladder structure untouched. Updated one stale doc comment (`DEKH RAHE` → `WATCHING`).
- `web/src/lib/listingDefaults.ts` — every Hinglish `houseRulesIntro` and FAQ answer across all 9 wizard flavours (`music`, `comedy`, `quiz`, `fitness`, `cooking`, `astro`, `consult_tax`, `consult_career`, `ai_bestie`, `generic`) rewritten in plain English with the same meaning; ids/keys/templates untouched. For `ai_bestie` specifically, avoided reintroducing the banned words `friend`/`companion` when translating "Ek dost jo hamesha available hai" and "bestie" in the FAQ answers (COMMON.md banned-word list), rephrasing to "always here whenever you want to talk" / "it never sleeps, so it is always available".
- `web/src/components/ListingTile.tsx` — imported `cta` from `copy.ts`; primary CTA label is now `cta.SEE_EXAMPLE` ("SEE EXAMPLE") when `c.isExample`, else the normal `buttons.primaryLabel` — same button/link, only the label branches.

## Decisions

- Kept the design-comp file reference (`design/live-streaming/avaTOK Listing Details.dc.html`) and the `listing-details.css` comment `(Public ki Rai)` untouched, per the brief — design/ and that CSS comment are explicitly out of scope.
- `promiseBand.title` ("SEEDHI BAAT, NO CHAKKAR") had no exact mapping in the brief; translated to "STRAIGHT TALK, NO CATCH" (same meaning: no hidden catch/run-around), and `promiseBand.reviewsTitle` ("SACCHE REVIEWS") → "VERIFIED REVIEWS".
- Did not touch `laneName`/`ListingLane` type value `'adda'` or any other object key/id/data-i18n attribute — only rendered English values changed, per the hard rule in the brief.

## Verify output

Build + existing check scripts (from `web/`):

```
PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build
...
[build] Complete!

node scripts/check-homepage.mjs
Homepage checks passed: approved hero, retained sections, language selectors, calculator, anchors and India redirects.
... (all sub-checks passed)

node scripts/check-help.mjs
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB), 21 built pages + 4 policy pages checked (20 articles), all /help, /help#, and /#anchor links resolved, no placeholder text, FAQPage present once, BreadcrumbList present once per article, 36 /help/art image refs OK, 349 JS chunks checked for rem-based rootMargin, 63 help-page CSS files checked for undefined custom properties.

node scripts/check-performance.mjs
Render/font/telemetry readiness contracts passed; live FCP/CLS/font bytes require browser measurement.
Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks, private reads, mutation contracts.
Browser image AVIF/q60 coverage, runtime callsites and immutable sources passed
Web performance release checks passed

node scripts/check-image-urls.mjs
Image URL origin, privacy, idempotence and bounded variant checks passed
```

`astro dev --port 4326`, then curl of the canonical live example listing:

```
curl http://localhost:4326/avatok_team/ganga-havan-haridwar-live
```

- `<meta name="robots" content="noindex, nofollow">` — present.
- "Booking opens at launch." — present (in both the visible notice bar and OG/meta description echo).
- "Example listing" badge text — present.
- `grep -inE 'Public ki|NAYA|PEHLA|Paisa|paisa|DEKH RAHE|hai\b|karo\b|nahi\b'` on the rendered HTML — **zero matches**.
- `grep -o 'href="[^"]*checkout[^"]*"'` on the rendered HTML — **zero matches**.

Homepage (prerendered — checked `dist/index.html` after build, since dev/prod can differ on SSG output):

- `grep -c 'SEE EXAMPLE' dist/index.html` → 8 (one per example card's primary CTA).
- `grep -c 'BOOK NOW' dist/index.html` → 0.
- `grep -c 'PEHLA SHOW' dist/index.html` → 0; `grep -c 'FIRST SHOW' dist/index.html` → 9.
- `grep -c '>EXAMPLE<' dist/index.html` → 11 (badge sticker + new availability chip, both present on example cards).
- `grep -inE 'Public ki|NAYA|PEHLA|Paisa|paisa|DEKH RAHE|BAAKI|hai\b|karo\b|nahi\b' dist/index.html` → zero matches.

Also confirmed `npm run build` itself (SSR + prerender) compiled `e/[event].astro` and `[username]/[slug].astro` cleanly with the new code (both were part of the successful build above), so the second listing route the brief asked to check is verified by the same build pass; a live curl of `/e/<id>` wasn't attempted since no real event id/slug was on hand for this worktree's dev server, but the component logic is identical to the already-curled `[username]/[slug].astro` path.

## Not done / out of scope

- Did not touch `app/` or `worker/`, per the hard rules.
- Did not rename the `ai_bestie` flavour id, its `laneName`/type keys, or the "AI Bestie" speaker label in `sampleChat` — none of those are Hinglish (they're English slang), so rewriting them was out of this stream's scope (Hinglish → English), even though "bestie"/"companion" sit close to the COMMON.md banned-word list; flagging for whoever owns that broader copy-tone pass.
