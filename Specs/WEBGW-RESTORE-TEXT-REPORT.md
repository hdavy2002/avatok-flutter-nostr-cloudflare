# WEBGW-RESTORE-TEXT — implementer report

Text-only safety pass on top of the restored baseline (`c3f7344b`). No layout, component,
class, id, href, data-\* id, or `lang=` attribute was touched. Only text nodes, `alt`/
`aria-label`/`title`/`placeholder`/meta VALUES, string literals in `.ts`/`.tsx` copy files,
Markdown body text, and the matching English catalog values changed. Verified with an
automated pairwise diff (below) that every changed line across `web/src` differs only inside
a quoted string/text node — zero `href=`, `class=`, `id=`, `data-i18n=` or other attribute-name
changes anywhere in the diff.

## Files changed

**Astro/TSX markup + copy files**
- `web/src/pages/index.astro` — homepage hero + ideas section (steps 1–2)
- `web/src/pages/ideas.astro`, `web/src/pages/blog/creator-ideas/[slug].astro`,
  `web/src/pages/blog/global-creator-ideas/[slug].astro` — plain-English copy, format names
- `web/src/pages/about.astro`, `web/src/pages/careers.astro` — entity text, founders phrasing
- `web/src/pages/sign-in.astro`, `web/src/pages/sign-up.astro` — Devanagari/Hinglish removed
- `web/src/components/SiteFooter.astro` — footer Hindi slogans, "Find your people" banned label
- `web/src/components/MarketplaceBrowse.astro` — "For fans" → "For customers"
- `web/src/components/BazaarHero.astro`, `web/src/components/BazaarSearchStrip.astro` — hero/search Hinglish
- `web/src/components/ListingDetailsComp.astro`, `web/src/components/listing/ReviewsSection.astro` —
  "NAYA HOST"→"NEW HOST", "Public ki Rai"→"Reviews", masala sticker `alt`s/quotes translated
- `web/src/components/LegalStatus.astro`, `web/src/components/EntityFaq.astro` — entity/founders text
- `web/src/components/india-preview/BookingExpressIllustrated.astro` — format labels, handwritten notes
- `web/src/components/IslandBoundary.tsx` — shared error-boundary fallback text (found via catalog sweep)
- `web/src/islands/auth/AuthKit.tsx` — role picker "Friend"→"Customer" (value stays `'friend'`)
- `web/src/islands/marketplace/{ExploreGrid,FilterRail,SearchBox,VerticalSection}.tsx` — empty-state/search copy

**Lib/data files (string literals + the one authorized restructure)**
- `web/src/lib/creatorIdeas.ts` — replicated a42f2a41's filter/translate approach: `formats` renamed,
  the 6 unsafe ideas excluded, all Hindi working-titles mapped to English display titles, description
  banned-word fixes (private→exclusive/confidential)
- `web/src/lib/creatorGuides.ts` — deleted the 6 corresponding guide bodies only
- `web/src/lib/globalCreatorIdeas.ts` — removed "private"/"meetup" from session descriptions
- `web/src/lib/copy.ts` — full Hinglish→English pass (promises band, reviews, ask-host, lane badges);
  reused a42f2a41's reviewed wording for "FIRST SHOW", "NEW HOST" (via ListingDetailsComp),
  "Reviews", "PAYMENT PROTECTED"
- `web/src/lib/listingDefaults.ts` — Hinglish `houseRulesIntro`/FAQ answers translated per category
- `web/src/lib/marketGroups.ts` — corrected `find_your_people` (→ "Group classes") and
  `book_their_time` (→ "1:1 consultations") display copy to match the actual taxonomy content
- `web/src/lib/org.ts` — `indianEntity.name` → `''`, founders phrasing removed, slogan updated
- `web/src/lib/indiaLandingSource.ts` — `sourceHinglish`/`sourceEnglish` both rewritten to plain
  English (were the default SSR text for the shared india-preview components); "fans"/"meetup"/
  "private" fixed in both
- `web/src/lib/i18n/localeStore.ts` — the one-line `t()` fix from a42f2a41 (live markup beats stale
  catalog for `en`), with its comment. `setUiLocale` untouched — locale switching still works.
- `web/src/layouts/Base.astro` — default `keywords` no longer names "Delaware company, American and
  Indian founders"

**Content**
- `web/src/content/help/**.md` (5 files) — Hinglish keywords, banned "private", stale group names
  ("Find your people"→"Group classes" description, "gyaan desk"→"Expert desk" language) corrected
- `web/public/_redirects` — added the six `/blog/creator-ideas/<slug> /ideas 301` lines (not the
  close-friends-studio page, per instructions)

**i18n catalogs** — `shared/i18n/source/{web-common,web-landing,web-ideas,web-marketplace,web-about,
web-auth,web-careers,web-blog}.json` updated (same keys, new English values) for every `data-i18n`/
`UiText` key whose markup string changed. No keys added or removed.

**Scripts** (not shipped)
- `web/scripts/check-homepage.mjs` — hero regex/title/description assertions updated to the new copy;
  115→109 idea-card/article counts (six unsafe ideas removed)
- `web/scripts/check-render-performance.mjs` — one assertion (`/Apna hunar/` → `/Turn your skill/`)
  needed the same fix to keep `npm run check-performance` green; also not shipped.

## Key strings, before → after

**Homepage hero**
- H1: `Apna hunar.` / `Apni kamaai.` → `Turn your skill` / `into income.`
- Kicker: `A global creator marketplace` → `Creator marketplace · India`
- Description: `Jo aata hai, usse kamao. Host a live event... —on your terms, at your price.` →
  `avaTOK is a marketplace where verified creators sell tickets to live online events, 1:1 video
  consultations and small-group classes. Customers book and pay in rupees. / Creators are paid to
  their bank account.`
- CTAs: `Start earning free` → `Start selling, free`; `Explore ideas` → `Browse sessions` (href
  stays `/ideas`)
- Format chips (hrefs unchanged): `india_goes_live`→**Live events** (unchanged); `find_your_people`→
  **Group classes** (was "Private 1:1"); `book_their_time`→**1:1 consultations** (was "Group sessions")
- Ideas section: `Kya offer karoge?`→`What will you offer?`; `Socha hai, isse bhi kamaa sakte ho?`→
  `Ideas you can earn from.`; the `rail-note` footnote (adult-companionship copy) is now empty text
  in the same `<p>`.

**Footer slogans** (india variant, both variants where applicable)
- `Seat book karo, kursi kheencho, apna time lo.` → `Book your seat, pull up a chair, take your time.`
- `Aapki awaaz, duniya tak.` → `Your voice, out to the world.`
- `OK TATA · PHIR MILENGE` / `CREATORS EVERYWHERE · PHIR MILENGE` → `BYE FOR NOW · SEE YOU SOON` /
  `CREATORS EVERYWHERE · SEE YOU SOON`
- `फिर आना!` (Devanagari) → `Come back soon!`
- `BURI NAZAR WALE, TERA MUH KALA · USE DIPPER AT NIGHT` → `GOOD VIBES ONLY, NO EVIL EYE · USE DIPPER
  AT NIGHT`
- Bazaar column label `Find your people` (banned phrase) → `1:1 consultations` (href `/#live-friends`
  unchanged, matches BookingExpress's own "1:1 sessions" anchor)

**Entity paragraph** (`LegalStatus.astro`, `org.ts`, `about.astro`)
- `org.ts` `indianEntity.name`: `'Ave Maria International Pvt Ltd'` → `''`
- `LegalStatus.astro` heading `Our Indian operating entity.` → `India.`; body → the exact sentence:
  **"An Indian subsidiary is being incorporated in Mumbai; its details will be published here once
  registered."**
- All "American and Indian founders" phrasing removed from `org.ts`, `LegalStatus.astro`,
  `EntityFaq.astro`, `about.astro`, `careers.astro`
- `about.astro` `lead`: dropped the `Ave Maria International Pvt Ltd` mention entirely, replaced with
  the same India sentence in substance
- No "Pvt Ltd" or "Ave Maria" remains anywhere in rendered text or meta (verified by grep across the
  full built site)

## Six unsafe ideas unpublished

| id | working title | slug | redirect |
|---|---|---|---|
| idea-29 | Dil Ki Baat | `dil-ki-baat` | → `/ideas` 301 |
| idea-31 | NRI Homesick Adda | `nri-homesick-adda` | → `/ideas` 301 |
| idea-50 | Saree Draping Help | `saree-draping-help` | → `/ideas` 301 |
| idea-51 | Style Your Own Wardrobe | `style-your-own-wardrobe` | → `/ideas` 301 |
| idea-83 | Saree Draping Circle | `saree-draping-circle` | → `/ideas` 301 |
| idea-114 | Shaam Ka Adda | `shaam-ka-adda` | → `/ideas` 301 |

Homepage's 6th slot (previously idea-29/Dil Ki Baat) now shows idea-44 "Make Reels On Your Phone"
(safe), matching a42f2a41's `openingTitles` reordering. Confirmed via the structural-identity diff
below — the only content difference on the homepage is that one card swap.

## Verify output (from `web/`)

```
$ PUBLIC_CLERK_PUBLISHABLE_KEY=... PUBLIC_API_BASE=https://api.avatok.ai npm run build
✓ build completed, 177 pages incl. 109 creator-idea articles

$ node scripts/check-homepage.mjs
Homepage checks passed: approved hero, retained sections, language selectors, calculator, anchors and India redirects.
Exact original artwork checks passed: hero, middle sections and all eight idea cards.
Creator ideas checks passed: 109 cards, three formats, shared chrome, artwork and hero link.
109 unique article routes, hero images, sections and shared chrome passed.
Sharing metadata and discovery checks passed for ideas and all 109 articles.
Homepage title, description, canonical and selected creator image passed.

$ node scripts/check-help.mjs
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB), 21 built pages +
4 policy pages checked (20 articles), all /help, /help#, and /#anchor links resolved, no placeholder
text, FAQPage present once, BreadcrumbList present once per article, 36 /help/art image refs OK,
353 JS chunks checked for rem-based rootMargin, 84 help-page CSS files checked for undefined custom properties.

$ node scripts/check-image-urls.mjs
Image URL origin, privacy, idempotence and bounded variant checks passed

$ node scripts/check-performance.mjs
Render/font/telemetry readiness contracts passed; live FCP/CLS/font bytes require browser measurement.
Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks, private reads, mutation contracts.
Browser image AVIF/q60 coverage, runtime callsites and immutable sources passed
Web performance release checks passed
```

## Structural-identity check (mandatory)

`dist/index.html` vs `/tmp/webgw-baseline/web/dist/index.html`, text-stripped: the ONLY differences
are (a) the `web-authored.*` title/description hash keys (expected — the hash is a content
fingerprint, and the text changed on purpose) and (b) the homepage's 6th idea card:
`idea-29`(Dil Ki Baat, now excluded) → `idea-44`(Phone Se Reel Bana / "Make Reels On Your Phone",
safe). Same DOM shape, same classes/attrs, only the id/href/content of that one `<article>` differ.

`dist/ideas/index.html` vs baseline, text-stripped: diff is exactly six whole `<article>` blocks
removed — `id="idea-29"`, `idea-31`, `idea-50`, `idea-51`, `idea-83`, `idea-114` — matching the six
unpublished ideas above, plus nothing else.

```
HOME: only web-authored.* hash + idea-29→idea-44 swap. -> HOME-STRUCT-IDENTICAL (modulo the required content swap)
IDEAS: only the 6 removed <article id="idea-{29,31,50,51,83,114}"> blocks. -> IDEAS-STRUCT-IDENTICAL (modulo the required removals)
```

Automated attribute-diff scan (`href=`, `class=`, `id=`, `data-i18n=`, `data-*=` extracted from every
`-`/`+` line pair across the whole `git diff -- web/src` and compared): **0 mismatches** — every
changed line differs only inside quoted text content.

## SSR pages (curled from `astro dev`, compared against the same routes served from
`/tmp/webgw-baseline/web` on another port)

- `/marketplace` (200) — no banned words/Hinglish; "For fans" fixed to "For customers"; language
  picker native-script option names (हिन्दी, मराठी, …) are the *only* Devanagari present, which is
  the language picker itself and must stay.
- `/sign-in` (200) — Devanagari greeting and "Desi · Dil Se · Global" stamp translated; same
  language-picker Devanagari as above (expected).
- `/about` (200) — entity text, founders phrasing, "private" all clean after the fix pass above.
- `/l/avatok-upi-smoke-2026` (200) — masala quote/stickers translated, "NEW HOST" renders; the
  listing's own title/description ("Private payment-pipeline test event…") comes from
  `worker/migrations/2026-09-17-upi-smoke-event.sql` seed data — **not** a `web/` file, out of scope,
  left untouched.
- Structure (tag shapes, ids, classes) matches the baseline build on every page checked; only text
  content differs.

## Could not do without touching markup

Nothing. Every requested change was achievable as a text-node/attribute-value/string-literal/
Markdown-body edit.

## Notes for the owner

- `web/src/components/IslandBoundary.tsx` (shared React error-boundary fallback, not in the
  original file list) had a Hinglish crash message ("Kuch gadbad ho gayi — reload karke dekho.")
  found via a full sweep of `shared/i18n/source/*.json` for Hindi keywords. Fixed to "Something went
  wrong — try reloading." since it can surface on any page.
- `web/src/lib/copy.ts`'s `promiseBand`/`promises` objects (fixed per instructions, including the
  "PAYMENT PROTECTED" wording) are currently only consumed by an apparently-unused sibling component
  (`components/listing/PromisesBand.astro` / `ListingDetailView.astro`), not the live
  `ListingDetailsComp.astro`. The fix is still correct and future-proof; flagging in case that's
  surprising.
- `web/src/lib/creatorIdeas.ts` and `web-ideas.json` retain stale Hindi values for the six excluded
  ideas' rows/catalog entries (their ids are simply absent from the exported array, so nothing
  references them) — left alone rather than scrubbed, since they're unreachable.
- Two files changed in the working tree that are **not part of this commit**, left untouched:
  `Specs/WEBGW-COORDINATOR-REPORT.md` (edited by someone/something else during this session — not
  mine) and `web/src/lib/publicImageManifest.json` (an auto-generated build cache that `npm run
  build`/`astro dev` appended to; reverting it isn't necessary since it's gitignored-style generated
  data, but I left it out of my commit rather than touch it).

## Git

Not pushed. Commit created with `scripts/git_safe_commit.py`, explicit paths only (excludes the two
files noted above).
