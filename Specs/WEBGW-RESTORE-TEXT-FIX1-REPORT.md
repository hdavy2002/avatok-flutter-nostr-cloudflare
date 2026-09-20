# WEB-GATEWAY-RESTORE-TEXT-FIX1 — report

Text-only fixes on top of `827f9304` per `Specs/WEBGW-RESTORE-TEXT-FIX1-BRIEF.md`. No markup,
attribute-name, class, href, route or behaviour changes — verified below via the required
attribute-diff read of `git diff -- web/src`.

## Files changed

- `web/src/islands/auth/LoginIsland.tsx` — "Ya phir" → "Or"; "Chai ho jaye?" / "Woh bhi ho
  jayega." → "Time for chai?" / "That's sorted too." (now matches `sign-in.astro`'s English for
  the same `web-auth.147f03f49b15afba` / `web-auth.eef3540404312d17` keys).
- `web/src/islands/auth/SignUpIsland.tsx` — "Ya phir" → "Or".
- `web/src/islands/auth/AuthKit.tsx` — "Desi · Dil Se · Global" → "Homegrown · Heartfelt ·
  Global" (matches `web-auth.1dbccd09995a56ce` already used on the sign-in/sign-up pages).
- `web/src/components/ListingDetailsComp.astro` — `CATS.friends`/`adda`/`astro`/`glow` labels
  and eyebrows reworded per the brief; `alt="Desi swag"` → `alt="Swag sticker"`.
- `web/src/components/BazaarHero.astro` — hero paragraph reworded to drop "astrology sessions,
  adda rooms... full glow-ups".
- `web/src/lib/indiaLandingSource.ts` — both `ideaOneTitle: 'Dance adda'` occurrences →
  `'Dance class'` (this string renders on the live homepage via `CreatorIdeas.astro`, which
  imports `sourceHinglish` directly).
- `web/src/pages/blog/index.astro` — "115 desi ideas. Your next paid session." → "109 creator
  ideas. Your next paid session." (109 confirmed by `check-homepage.mjs`'s idea-card count).
- `web/src/islands/live-gs/LiveGsViewer.tsx` — "Sab spots bhar gaye — koi buy zaroori nahi tha."
  → "All spots are taken — no purchase was needed."
- `web/src/lib/listingDefaults.ts` — "desi observations, everyday chaos" → "everyday Indian
  observations, everyday chaos"; "Fans of desi observational comedy" → "Lovers of observational
  comedy".
- `web/src/lib/creatorIdeas.ts` — "chat with viewers" → "talk to viewers" (both occurrences;
  see "Could not do" below for the discrepancy with the brief's "×3").
- `web/src/content/help/getting-started/web-vs-app.md` — "including chat with the creator" →
  "including messaging the creator".
- `web/src/lib/creatorGuides.ts` — every remaining "private" reworded (confidential / personal /
  off-camera / other / someone else's, matching `a42f2a41`'s wording line-for-line where a
  corresponding line exists there) — 16 occurrences fixed, plus "Film fans" → "Movie lovers".
- `web/src/components/help/HelpFaqStrip.astro` — alt text reworded, dropped the "log kya
  kahenge" Hinglish caption.
- `web/src/pages/india-next.astro`, `web/src/pages/landing-steps-preview.astro` — hero kicker,
  H1 spans, description, CTAs, format chips and ideas eyebrow/heading now use the exact same
  English as `index.astro` for the shared `web-landing.*` keys.
- `shared/i18n/source/{landing,web-about,web-auth,web-blog,web-common,web-live-gs}.json` — the
  English catalog value updated for every `data-i18n` key whose markup string changed above
  (same key, new value; no keys added/removed/renamed).

## Two items found beyond the brief's list, fixed for the same reason (banned words on a public
page) — flagged here rather than silently expanded

1. **`web/src/pages/about.astro`** — `alt="Four friends laughing together over a phone"` on the
   founders photo. Not in the brief's 14 items, but the final scan step (which the brief says
   should show zero hits outside the UPI-listing exception) flagged "friends" on `/about`. Fixed
   to `alt="Four people laughing together over a phone"` — the exact wording `a42f2a41` used for
   this image (`git show a42f2a41:web/src/pages/about.astro`, same `data-india-i18n-attr` key
   `web-about.c1dc3d3115a3996c`). Catalog value updated to match.
2. **`web/src/pages/india-next.astro` / `landing-steps-preview.astro`** — two more spots the
   scan caught that item 14 didn't explicitly name:
   - Both pages still had literal text in the `<p class="rail-note" data-i18n="web-landing.e7b786bad9689075">`
     footnote ("Listening sessions: adults 18+ · Companionship, not therapy or emergency
     support."). The original `WEBGW-RESTORE-TEXT-BRIEF.md` (§2) already required this exact
     element emptied on `index.astro` for this same key; these two preview pages carry the same
     key and hadn't been updated. Emptied to match (`<p ...></p>`).
   - `landing-steps-preview.astro`'s `<Base description=… imageAlt=…>` props still read "Turn
     your fanbase into paid live events, private 1:1 video meetups and group sessions..." /
     "...private one-to-one video meetups." Replaced with the same description/imageAlt text
     `index.astro` uses for its own `<Base>` props (plain prop-value string changes, no markup).

## Verticals.ts — confirmed dead, left untouched (brief item 7)

`web/src/lib/verticals.ts` still has the Hinglish `VERTICALS` array ('Pawri zone', 'Ye hamari
pawri ho rahi hai!', 'Adda rooms', 'Gyaan desk', etc.), but nothing in `web/src` imports
`VERTICALS` or `groupByVertical` from it any more:

```
$ grep -rln "lib/verticals" web/src --include="*.astro" --include="*.ts" --include="*.tsx" | grep -v verticals.ts
web/src/lib/marketGroups.ts        # only a comment reference, no import
```

`marketGroups.ts` line 6 mentions `lib/verticals.ts` only in a comment. The file's own header
comment confirms this ("Nothing in web/src imports this file's VERTICALS/groupByVertical any
more"). Provably unreachable — left as-is per the brief's instruction.

## Could not do / discrepancies

- Brief item 11 said "chat with viewers" appears **×3** in `creatorIdeas.ts`; only **2**
  occurrences exist (`grep -in "chat with" web/src/lib/creatorIdeas.ts`). Both were fixed. A
  third `chat with` was found and fixed separately in
  `web/src/content/help/getting-started/web-vs-app.md` (brief item 11's second bullet) — that
  may be the "third" the brief was counting. A repo-wide grep after the fix
  (`grep -rin "chat with" web/src/`) returns zero hits.
- Brief item 12 said creatorGuides.ts has "private" on ~17 lines; **16** were found and fixed
  (`grep -in private web/src/lib/creatorGuides.ts` before the fix). No 17th occurrence exists.
- `web-common.5ed88592e974898e` and `web-auth.4aec6108de24a9f0`/similar sources used a curly
  apostrophe (’) in places; the brief's literal replacement text used a straight apostrophe (').
  Used the brief's literal text verbatim for the new HelpFaqStrip alt (straight apostrophe in
  "centre's"), consistent with how the rest of the file already mixes both.

## Build artifact note

`web/src/lib/publicImageManifest.json` is checked into the repo as `{}` and gets populated with
real asset-fingerprint entries as a side effect of running `npm run build` locally (confirmed via
`git log` — it has been `{}` since `c3f7344b`). Each `npm run build` run during this task
populated it; it was reset to `{}` (`git checkout HEAD -- web/src/lib/publicImageManifest.json`)
before committing so this session's build side-effect doesn't leak into the commit.
`Specs/WEBGW-COORDINATOR-REPORT.md` also shows as modified in `git status` — that change predates
this session (present at the start, per the git status snapshot) and is not part of this commit.

## Verify output (from `web/`)

```
$ PUBLIC_CLERK_PUBLISHABLE_KEY=... PUBLIC_API_BASE=https://api.avatok.ai npm run build
✓ build completed

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

Same method as the original TEXT report: `dist/index.html` and `dist/ideas/index.html` vs
`/tmp/webgw-baseline/web/dist/*`, text-stripped (script bodies removed, text nodes emptied,
`alt`/`aria-label`/`title`/`content`/`placeholder` values emptied), diffed. Since the collapsed
one-line-per-file strip makes any diff show as "the whole line differs" (a formatting artifact,
not a real signal), the same stripped output was also broken one-tag-per-line to inspect the
diff directly:

- **HOME**: only two differences — (a) the `web-authored.*` title/description hash keys
  (content fingerprints; expected since this session didn't touch homepage title/description
  text, but hashes shift if upstream content changed) and (b) the homepage's 6th idea card,
  `idea-29` (Dil Ki Baat, excluded) → `idea-44` (Phone Se Reel Bana / "Make Reels On Your
  Phone"). Both are **pre-existing from the prior `[WEB-GATEWAY-RESTORE-TEXT]` commit
  (827f9304)**, not introduced by this session — this FIX1 pass touched none of the homepage's
  hero/idea-card markup or the `web-authored.*` keys. → **HOME-STRUCT-IDENTICAL** (modulo that
  pre-existing, expected content swap).
- **IDEAS**: diff is exactly the six removed `<article id="idea-{29,31,50,51,83,114}">` blocks,
  same as the prior report. → **IDEAS-STRUCT-IDENTICAL** (modulo the required removals).

```
$ diff <(strip .../index.html) <(strip dist/index.html) | wc -l    # collapsed single-line diff
64
$ diff <(strip .../ideas/index.html) <(strip dist/ideas/index.html) | grep -oE 'idea-[0-9]+' | sort -u
idea-114 idea-29 idea-31 idea-50 idea-51 idea-83
```

Automated attribute-diff read of `git diff HEAD -- web/src shared/i18n/source`: every `-`/`+`
line pair changes only inside a quoted string or text node — no `href=`, `class=`, `id=`,
`data-i18n=` (key names), or other attribute-name/value-outside-copy changed. Full diff reviewed
line-by-line (134 lines).

## Rendered-page banned-word/Hinglish scan (`astro dev`, port 4332)

Ran the brief's exact scan script against `/`, `/marketplace`, `/sign-in`, `/sign-up`, `/about`,
`/ideas`, `/l/avatok-upi-smoke-2026`, `/blog/creator-ideas/gaon-ki-subah`, `/help`, plus
`/india-next` and `/landing-steps-preview` (added since FIX1 item 14 touched those two pages):

```
/                                        [] devanagari: 0
/marketplace                             [] devanagari: 0
/sign-in                                 [] devanagari: 0
/sign-up                                 [] devanagari: 10   <- see note below
/about                                   [] devanagari: 0
/ideas                                   [] devanagari: 0
/l/avatok-upi-smoke-2026                 ['private'] devanagari: 0   <- expected (D1 listing data)
/blog/creator-ideas/gaon-ki-subah        [] devanagari: 0
/help                                    [] devanagari: 0
/india-next                              [] devanagari: 0
/landing-steps-preview                   [] devanagari: 0
```

**`/sign-up` devanagari: 10 — pre-existing false positive of the scan's own exclusion regex, not
new content.** `sign-up.astro` renders the `IndiaLanguageSelector` component **three times**: the
desktop header nav, the mobile drawer, and a third copy in the auth page's own
`<div class="auth-language">` decorative area (`sign-up.astro:59`). The scan's exclusion regex
(`Choose language.*?(Log in|Sign out)`, non-greedy) strips the first two instances because they're
each followed by "Log in"/"Sign out" nav text, but the third instance is followed by the "One
sec…" auth-loading copy instead, so its list of native language names ("हिन्दी", "मराठी", "बड़ो"…
— the same catalogue used on every other page) isn't stripped by the regex. This is the language
picker itself, unmodified and out of scope ("language picker stays exactly as it is" per the
original TEXT brief) — not a regression from this session, and not new Hinglish.

## Could not do without touching markup

None — every item in the brief was achievable as a pure string/attribute-value change.

Committed with `python3 scripts/git_safe_commit.py`. Not pushed, not deployed.
