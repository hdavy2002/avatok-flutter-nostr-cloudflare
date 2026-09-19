# WEBGW-HOME-CREATOR — implementation report

Text-only creator-pivot copy pass on the homepage, per `Specs/WEBGW-HOME-CREATOR-BRIEF.md`. No layout,
structure, component, CSS, image, section-order, navigation, route, class, `id`, `data-*` key, or
behaviour changes were made — only human-readable strings, plus the three explicitly-allowed
non-string fixes.

## Files changed

- `web/src/pages/index.astro` — hero kicker/H1/lede/strong/CTA2 label+href/formats
  aria-label/chips/hero-alt/ideas-eyebrow/H2/lede text; `<Base>` `title`/`description`/`imageAlt`,
  new `keywords=`, removed `lang="hi-Latn"`.
- `web/src/components/india-preview/BookingExpressIllustrated.astro` — formats heading, three format
  tiles (h3/p), group-tile href fix, step alt texts, step-4 hardcoded body literal.
- `web/src/lib/indiaLandingSource.ts` — `sourceHinglish` and `sourceEnglish`, key-identical, for
  `ideasEyebrow/ideasTitle/ideaOne..FourTitle/ideaOne..FourBody/journeyTitle/stepOneBody/stepTwoBody/
  stepThreeBody/stepFour/stepFourBody/calcTitle/calcBody/calcLiveLabel/calcAudienceLabel/
  calcEventsLabel/calcOneLabel/calcBookingsLabel/calcLiveTotal/calcOneTotal`.
- `web/src/components/SiteFooter.astro` — one string: the india-variant `<p class="bf-tag">` tagline.
- `shared/i18n/source/web-landing.json` — same-key English values for every `web-landing.<hash>` key
  changed in `index.astro` / `BookingExpressIllustrated.astro`.
- `shared/i18n/source/landing.json` — same-key English values for the `indiaLandingSource.ts` keys
  listed above.
- `web/scripts/check-homepage.mjs` — the two hero-string assertions (now point at the new H1 spans),
  plus the `og:title`/`og:description` literal-match assertions (see "Deviation" below).
- `Specs/WEBGW-HOME-CREATOR-REPORT.md` — this report.

`web/src/components/india-preview/CreatorIdeas.astro` and
`web/src/components/india-preview/EarningsCalculatorIllustrated.astro` needed **no edits** — both
render purely from `indiaLandingSource.ts`, which now carries the new copy.

**Not touched**, as instructed: `web/src/lib/creatorIdeas.ts`, `SiteHeader.astro`, `Base.astro`,
`org.ts`, `web/src/lib/listingTaxonomy.ts`, anything under `worker/`/`app/`, any other page.

**Pre-existing, not mine**: `web/src/lib/publicImageManifest.json` was already modified in the
working tree before this task started (a build-cache artifact, per the session's initial `git
status`). It is excluded from the commit below.

## Deviation from the brief (flagged, not silent)

The brief restricted `check-homepage.mjs` edits to "ONLY the assertions on lines ~14-15." Those two
lines were updated as instructed. However the same file also hard-asserts the **exact** `og:title`
and `og:description` meta values (originally the two old lines ~220-221), which are computed
directly from the `<Base title=… description=…>` props the brief explicitly told us to change. Since
`Base.astro`'s `pageTitle` logic passes `title` through unchanged whenever it already contains
"avatok" (case-insensitive) — which our new title does — `og:title` equals the new title exactly, and
`og:description` equals the new description exactly. Leaving those two assertions on their old
literal values would make `check-homepage.mjs` fail on a correct, intentional copy change, so they
were updated to the new literal strings as a direct, mechanical consequence of the Base prop change
the brief already authorized. No other assertion in the file needed touching (checked by grep for
every other changed string).

## Before → after copy table

### Hero (`index.astro`)
| Slot | Old | New |
|---|---|---|
| kicker `web-landing.b9d43bd06fbe8631` | Creator marketplace · India | For YouTube and Instagram creators · India |
| H1 span 1 `0528be3d426aff53` | Turn your skill | Your audience is ready |
| H1 span 2 `92f4118799fbcf80` | into income. | to pay for you. |
| `<ui-copy>` `d0082f5d7ac7dd8b` | avaTOK is a marketplace where verified creators sell tickets to live online events, 1:1 video consultations and small-group classes. Customers book and pay in rupees. | avaTOK lets YouTube, Instagram and Facebook creators sell tickets to live streams and booked 1:1 video calls. Your audience pays in rupees. |
| `<strong>` `721cb60fc48386d6` | Creators are paid to their bank account. | You are paid to your bank account. |
| CTA 1 `c54a63bb77c61e9d` | Start selling, free | unchanged |
| CTA 2 `87423590f6bd3088` | Browse sessions → `/ideas` | Browse creators → `/marketplace` (fix a) |
| chip 1 `b7a9f5518da78e1f` | Live events | Paid live streams |
| chip 2 `451c573451f6721a` | Group classes | Group live sessions |
| chip 3 `84d0be67f5ca32a2` | 1:1 consultations | 1:1 video calls |
| formats `aria-label` `eed4e047041fb536` | Ways to earn on AvaTOK | Ways to earn on avaTOK |
| skip link `e4fa98b15a1e147a` | Skip to earning ideas | unchanged |
| live badge `f675ebf648fc78c6` | ● Live around the world | unchanged |
| hero `alt` `7c72ea27bba5af71` | Creators hosting a live stream, teaching a class, and offering a one-to-one conversation online. | Creators hosting a paid live stream and taking 1:1 video calls with their audience. |
| `80%` / `you keep` `6785ce181ad9bfd9` | unchanged | unchanged |
| rail-next `ceae9c3f4625186e` | Find your first earning idea | unchanged |

`<Base>` props:
| Prop | Old | New |
|---|---|---|
| `title` | Turn your skill into income. · avaTOK | avaTOK: paid live streams and 1:1 video calls with your favourite creators |
| `description` | avaTOK is a marketplace where verified creators sell tickets to live online events, 1:1 video consultations and small-group classes. Customers book and pay in rupees. | YouTube, Instagram and Facebook creators sell tickets to live streams and 1:1 video calls on avaTOK. Pay securely in rupees. |
| `imageAlt` | Creators hosting live events, group classes and one-to-one video consultations. | Creators hosting a paid live stream and taking 1:1 video calls with their audience. |
| `keywords` | (none) | paid live stream, creator live stream tickets, 1:1 video call with creators, YouTube creators India, Instagram creators India |
| `lang` | `hi-Latn` | removed (defaults to `en`) |

### Formats + steps (`BookingExpressIllustrated.astro`, `indiaLandingSource.ts`)
| Slot / key | Old | New |
|---|---|---|
| Formats heading `e38ba82f0a13cc39` | One platform. Three ways. | One platform. Three ways to earn from your audience. |
| Tile 1 h3 `b7a9f5518da78e1f` | Live events | Paid live streams |
| Tile 1 p `982acdf78125b594` | Sell tickets to your stream. | Sell tickets to your live stream. |
| Tile 2 h3 `f34fb6b7a6f51b9d` | 1:1 consultations | 1:1 video calls |
| Tile 2 p `7480d0ba273e2df7` | Offer your undivided time. | Booked, paid, one follower at a time. |
| Tile 3 h3 `84d0be67f5ca32a2` | Group classes | Group live sessions |
| Tile 3 p `bf94bce3c2953bed` | Teach or advise a small group. | Host a small paid group live. |
| Tile 3 href (fix a) | `/marketplace?group=book_their_time` | `/marketplace?group=find_your_people` |
| `journeyTitle` | From poster to booking — four easy moves. | From channel to first booking in four steps. |
| `stepOneBody` | Write your creator page and offer. | Create your creator page. |
| `stepTwoBody` | Choose your ticket or session price. | Set your ticket or call price. |
| `stepThreeBody` | Send the link to your community. | Share your avaTOK link with your audience. |
| `stepFour` | Host | Go live |
| step-4 body (hardcoded literal) | Start your show on your app. | Go live from the avaTOK app. |
| `stepFourBody` (catalog, unread by component, kept consistent) | Open the room, give your time, run your show. | Go live from the avaTOK app. |
| step `alt` 1 | A creator preparing a page and a new offer. | A creator setting up their creator page. |
| step `alt` 2 | A creator choosing a ticket or session price. | A creator choosing a ticket or call price. |
| step `alt` 3 | Sharing an invitation with a community of customers. | Sharing an avaTOK link with an audience. |
| step `alt` 4 | A creator welcoming people to an online session. | A creator going live from the avaTOK app. |

### Ideas rail (`index.astro`)
| Slot | Old | New |
|---|---|---|
| eyebrow `af29625174aed2ab` | What will you offer? | Ideas for your channel |
| H2 `35013d916827ddd2` | Ideas you can | What could you offer |
| H2 span `6088e03833a8d3c7` | earn from. | your audience? |
| `6193ee40538a4862` | A few ideas to get your first listing started. | A few ideas to get your first paid stream or call started. |

### Niche tiles (`CreatorIdeas.astro` via `indiaLandingSource.ts`)
| Key | Old | New |
|---|---|---|
| `ideasEyebrow` | FROM CONTENT TO OFFER | CREATORS WHO FIT AVATOK |
| `ideasTitle` | What will you host? | Which creator are you? |
| `ideaOneTitle` / `ideaOneBody` | Dance class / Choreography, feedback, practice room. | Dance creators / Choreography breakdowns, live practice, feedback calls. |
| `ideaTwoTitle` / `ideaTwoBody` | Home flavours / Recipe live, regional thali, kitchen hacks. | Food & chai creators / Recipe live streams, street-food stories, kitchen hacks. |
| `ideaThreeTitle` / `ideaThreeBody` | Study buddy / Revision sprint, language practice, exam pep talk. | Study & exam creators / Revision sprints, language practice, exam pep talks. |
| `ideaFourTitle` / `ideaFourBody` | Style desk / Look breakdowns, draping, thrift finds. | Saree & fashion creators / Draping tutorials, outfit ideas, live styling streams. |

### Calculator (`EarningsCalculatorIllustrated.astro` via `indiaLandingSource.ts`)
| Key | Old | New |
|---|---|---|
| `calcTitle` | See your gross estimate. | Estimate your gross earnings |
| `calcBody` | Change the inputs to see what ticketed events or 1:1 bookings could gross. | Change the inputs to see what paid live streams or 1:1 video calls could gross. |
| `calcLiveLabel` | Live Ticket price per participant | Ticket price per viewer |
| `calcAudienceLabel` | Audience per event | Viewers per stream |
| `calcEventsLabel` | Events per month | Streams per month |
| `calcOneLabel` | 1:1 or 1:many Price per participant | 1:1 video call price |
| `calcBookingsLabel` | Bookings per month | Calls per month |
| `calcLiveTotal` | Live event gross | Live stream gross |
| `calcOneTotal` | 1:1 gross | 1:1 call gross |
| `calcEyebrow`/`calcTotal`/`calcDisclaimer`/`calcPricingNote`/`ariaCalculator`/the two `.calculator-price-help` literals | unchanged | unchanged |

### Footer (`SiteFooter.astro`)
| Slot | Old | New |
|---|---|---|
| `chrome.tagline` (india branch) | India's live creator bazaar. Book your seat, pull up a chair, take your time. | Paid live streams and 1:1 video calls from creators you already follow. |

## The three allowed non-string fixes

1. **Hero CTA2 href** (`data-home-cta="hero-ideas"`): `/ideas` → `/marketplace` (label became "Browse creators").
2. **Group-tile href** (`id="group-sessions"`, `data-home-cta="format-group"`): `/marketplace?group=book_their_time` → `/marketplace?group=find_your_people` (was colliding with the 1:1 tile's `book_their_time`; the hero chip with the same label already pointed at `find_your_people`).
3. **`lang="hi-Latn"` removed** from `index.astro`'s `<Base>` (defaults to `en`).

No other label/href disagreement was found on the homepage beyond these two.

**Pre-existing catalog bug, reported per the brief**: `web-landing.84d0be67f5ca32a2` is used both by
the hero chip 3 and the group-tile h3. Per the brief's instruction, the catalog value was set to the
hero-chip text ("1:1 video calls") — the live-markup fallback wins for English anyway, so the
group tile still renders "Group live sessions" from its own markup.

## Could not do without touching markup

Nothing. Every change requested in the brief was achievable as a pure string/attribute-value change,
within the three explicitly-authorized non-string fixes.

## Verify output

Build (from `web/`):
```
PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA PUBLIC_API_BASE=https://api.avatok.ai npm run build
...
09:13:55 [build] Rearranging server assets...
09:13:55 [build] Server built in 7.65s
09:13:55 [build] Complete!
```

`node scripts/check-homepage.mjs`:
```
Homepage checks passed: approved hero, retained sections, language selectors, calculator, anchors and India redirects.
Exact original artwork checks passed: hero, middle sections and all eight idea cards.
Creator ideas checks passed: 109 cards, three formats, shared chrome, artwork and hero link.
109 unique article routes, hero images, sections and shared chrome passed.
Sharing metadata and discovery checks passed for ideas and all 109 articles.
Homepage title, description, canonical and selected creator image passed.
```

`node scripts/check-help.mjs`:
```
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB), 21 built pages + 4 policy pages checked (20 articles), all /help, /help#, and /#anchor links resolved, no placeholder text, FAQPage present once, BreadcrumbList present once per article, 36 /help/art image refs OK, 353 JS chunks checked for rem-based rootMargin, 84 help-page CSS files checked for undefined custom properties.
```

`node scripts/check-image-urls.mjs`:
```
Image URL origin, privacy, idempotence and bounded variant checks passed
```

`node scripts/check-performance.mjs`:
```
Render/font/telemetry readiness contracts passed; live FCP/CLS/font bytes require browser measurement.
Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks, private reads, mutation contracts.
Browser image AVIF/q60 coverage, runtime callsites and immutable sources passed
Web performance release checks passed
```

## Structural-identity diff (mandatory)

The literal byte-diff of the two "stripped" (text/attribute-normalized) HTML files collapses the whole
document into a single line each, so a raw `diff` is unreadable. A tag-level `SequenceMatcher` diff of
the same two stripped strings (identical normalization, just tokenized by tag instead of by line)
shows exactly the three allowed differences and nothing else:

```
replace ---OLD---
   <html lang="hi-Latn" dir="ltr">
replace ---NEW---
   <html lang="en" dir="ltr">
replace ---OLD---
   <a data-i18n="web-landing.87423590f6bd3088" class="station-outline" href="/ideas" data-home-cta="hero-ideas">
replace ---NEW---
   <a data-i18n="web-landing.87423590f6bd3088" class="station-outline" href="/marketplace" data-home-cta="hero-ideas">
replace ---OLD---
   <a id="group-sessions" href="/marketplace?group=book_their_time" data-home-cta="format-group" data-astro-cid-i36ijbkw>
replace ---NEW---
   <a id="group-sessions" href="/marketplace?group=find_your_people" data-home-cta="format-group" data-astro-cid-i36ijbkw>
```

## Banned-word / Hinglish scan

```
grep -oiE 'tiktok|fans?\b|fanbase|fan base|meetup|meeting|private|find your people|friends|companion|lonely|dating|chat with|verified' dist/index.html
   -> 2 "friends", 4 "private"
```
All six hits are in non-visible attribute values the brief forbids changing: `id="live-friends"`,
`data-home-cta="hero-private"`, `data-home-cta="format-private"`, `data-i18n="web-ideas.format.private"`
(an idea-card format class from the out-of-scope `creatorIdeas.ts`), and the footer's `href="/#live-friends"`
anchor target. On the tag-stripped VISIBLE TEXT only, the same scan returns **zero hits**.

## Link / anchor check

Every `href` on the built `dist/index.html` was checked: absolute `https://avatok.ai/...` links resolve
to a prerendered path (`/ideas` exists), `#anchor`/`/#anchor` links all match an `id=` on the page, and
every other internal path either prerenders under `dist/` or is one of the SSR routes
(`/marketplace`, `/sign-up`, `/sign-in`, `/sign-out`, `/dashboard`) or a `/cdn-cgi/`/`/assets/`/`/_images/`
asset URL. No missing targets.

## Hydration / catalog check

`shared/i18n/source/web-landing.json` and `shared/i18n/source/landing.json` were read back and every
changed key now holds the new English text (see the before→after tables above; values printed and
verified programmatically). The runtime `t()` prefers live markup for `en`, so this is belt-and-braces
per the brief's own note.

## Git

Committed locally on `webgw/home-creator` via `scripts/git_safe_commit.py`, explicit paths only
(excludes the pre-existing, unrelated `web/src/lib/publicImageManifest.json` change). Not pushed, not
deployed; no `wrangler`/`cf.sh`/`flags.sh`/`gh` was run.
