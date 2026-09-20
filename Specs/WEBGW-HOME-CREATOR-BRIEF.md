# WEB-GATEWAY-HOME-CREATOR — homepage creator-pivot copy (Sonnet implementer brief)

You are working in the git worktree `/Users/davy/.cache/deepastra/webgw-20260918/home-creator`,
branch `webgw/home-creator`, HEAD = `origin/main` (`0cf3fedb`). That site is LIVE right now.
Your job is a **TEXT-ONLY** copy pass on the FRONT PAGE ONLY, repositioning avaTOK for
YouTube / Instagram / Facebook creators. Read `Specs/WEBGW-COMMON.md` first (banned words,
verify commands).

## THE ABSOLUTE RULE

**No layout, structure, component, CSS, image, section-order, navigation, route, class, id,
`data-*` key, or behaviour changes. Zero new sections, zero removed sections, zero removed
slots, no new components, no new files under `web/src`, no changes outside the files listed
in SCOPE.** Only human-readable strings may change:

- text nodes, headings, button/link labels
- `alt`, `aria-label`, `title`, `placeholder` attribute VALUES
- `<Base …>` prop VALUES for `title`, `description`, `imageAlt`, and a NEW `keywords=` prop on
  the homepage `<Base>` only (the layout already accepts it; it renders the same
  `<meta name="keywords">` tag with new content)
- string literals in `web/src/lib/indiaLandingSource.ts` (both `sourceHinglish` and
  `sourceEnglish` — keep them key-identical and give both the same new English value)
- the English catalog VALUES in `shared/i18n/source/web-landing.json` and
  `shared/i18n/source/landing.json` for exactly the keys whose markup string you changed
  (same key, new value — never add/remove/rename keys; do not touch `reviewed/`,
  `locales.json`, or any inventory/coverage JSON)

Exactly TWO non-string edits are allowed, because the page must WORK:

- (a) **href fix where a label and its href disagree.** Known cases:
  - `web/src/pages/index.astro` hero second CTA (`data-home-cta="hero-ideas"`): label becomes
    "Browse creators" → href becomes `/marketplace` (was `/ideas`).
  - `web/src/components/india-preview/BookingExpressIllustrated.astro` third tile
    (`id="group-sessions"`, `data-home-cta="format-group"`): label becomes "Group live sessions"
    → href becomes `/marketplace?group=find_your_people` (was `book_their_time`, which is the
    1:1 group and is already used by the 1:1 tile). The hero chip with the same label already
    points at `find_your_people`; the two must agree.
  - If you find another label/href disagreement on the homepage, fix the href the same way and
    list it in the report. Never change an `id=`, `data-home-cta=` or `data-i18n=` value.
- (b) **remove `lang="hi-Latn"`** from `web/src/pages/index.astro` (the `<Base … lang="hi-Latn">`
  prop) — the page is English now. Just delete that prop line; `Base` defaults to `en`. Do NOT
  touch `web/src/pages/landing-steps-preview.astro` or any other file for this.

Keep every changed string CLOSE TO THE ORIGINAL LENGTH so nothing wraps differently.
If a requested change cannot be done without touching markup, DO NOT do it — leave the original
and list it under "Could not do" in your report.

## POSITIONING AND WORDING RULES

avaTOK is for YouTube, Instagram and Facebook creators who sell paid live streams and 1:1 video
calls to their audience. **Never mention TikTok.** Say **audience / followers / subscribers**
(never fans, fan base, fanbase). Say **"1:1 video call"** (never meeting, private, meetup).
None of: private, meetup, fanbase, fans, find your people, friends, companionship, lonely,
dating, chat with. Do NOT claim creators are verified by an automated system; the owner reviews
each listing by hand, so if you need the idea say "reviewed" (e.g. "Every listing is reviewed
before it goes live"). No Hinglish, no Devanagari in the default (English) copy. Entity text
(`org.ts`, LegalStatus, footer entity line) untouched. Language picker untouched.

## SCOPE — the only files you may edit

- `web/src/pages/index.astro`
- `web/src/components/india-preview/BookingExpressIllustrated.astro`
- `web/src/components/india-preview/CreatorIdeas.astro` (probably nothing — its strings come
  from `indiaLandingSource.ts`)
- `web/src/components/india-preview/EarningsCalculatorIllustrated.astro`
- `web/src/lib/indiaLandingSource.ts` (only the keys listed below; note the same keys are also
  rendered on the noindex preview pages `india-next` / `landing-steps-preview` — that is fine)
- `web/src/components/SiteFooter.astro` — ONE string only: the india-variant tagline in the
  `<p class="bf-tag">` element (the `variant === 'global'` branch and everything else stays)
- `shared/i18n/source/web-landing.json`, `shared/i18n/source/landing.json` (values only)
- `web/scripts/check-homepage.mjs` — ONLY the assertions on lines ~14-15 that hardcode the old
  hero strings (`Turn your skill`, `into income.`) → point them at the new H1 spans. This script
  is not shipped, so it is the one place a non-string edit is allowed.
- `Specs/WEBGW-HOME-CREATOR-REPORT.md` (your report)

Do NOT edit `web/src/lib/creatorIdeas.ts` (its `formats`/`topics` and idea titles are shared
with `/ideas` and 109 guide pages — out of scope), `web/src/components/SiteHeader.astro`,
`web/src/layouts/Base.astro`, `web/src/lib/org.ts`, anything under `worker/`, `app/`, or any
other page.

## THE COPY (exact strings unless marked "your wording")

### Hero (`index.astro`)
| Slot | Now | New |
|---|---|---|
| kicker `web-landing.b9d43bd06fbe8631` | Creator marketplace · India | **For YouTube and Instagram creators · India** |
| H1 span 1 `0528be3d426aff53` | Turn your skill | **Your audience is ready** |
| H1 span 2 (accent) `92f4118799fbcf80` | into income. | **to pay for you.** |
| `<ui-copy>` `d0082f5d7ac7dd8b` | avaTOK is a marketplace where verified creators sell tickets to live online events, 1:1 video consultations and small-group classes. Customers book and pay in rupees.␠ | **avaTOK lets YouTube, Instagram and Facebook creators sell tickets to live streams and booked 1:1 video calls. Your audience pays in rupees.␠** (keep the trailing space before `</ui-copy>`) |
| `<strong>` `721cb60fc48386d6` | Creators are paid to their bank account. | **You are paid to your bank account.** |
| CTA 1 `c54a63bb77c61e9d` (`/sign-up`) | Start selling, free | Start selling, free (unchanged) |
| CTA 2 `87423590f6bd3088` | Browse sessions → `/ideas` | **Browse creators** → **`/marketplace`** (fix a) |
| chip 1 `b7a9f5518da78e1f` (`india_goes_live`) | Live events | **Paid live streams** |
| chip 2 `451c573451f6721a` (`find_your_people`) | Group classes | **Group live sessions** |
| chip 3 `84d0be67f5ca32a2` (`book_their_time`) | 1:1 consultations | **1:1 video calls** |
| formats `aria-label` `eed4e047041fb536` | Ways to earn on AvaTOK | Ways to earn on avaTOK (your wording, plain) |
| skip link `e4fa98b15a1e147a` | Skip to earning ideas | keep, or "Skip to ideas" — your call |
| live badge `f675ebf648fc78c6` | ● Live around the world | keep |
| hero `alt` `7c72ea27bba5af71` | Creators hosting a live stream, teaching a class, and offering a one-to-one conversation online. | **Creators hosting a paid live stream and taking 1:1 video calls with their audience.** |
| `80%` + `6785ce181ad9bfd9` you keep | keep | keep |
| rail-next `ceae9c3f4625186e` | Find your first earning idea | keep |

`<Base>` props in `index.astro`:
- `title` → **avaTOK: paid live streams and 1:1 video calls with your favourite creators**
- `description` → **YouTube, Instagram and Facebook creators sell tickets to live streams and 1:1 video calls on avaTOK. Pay securely in rupees.**
- `imageAlt` → same as the hero alt above
- add `keywords="paid live stream, creator live stream tickets, 1:1 video call with creators, YouTube creators India, Instagram creators India"`
- delete `lang="hi-Latn"` (fix b)

### Formats + steps (`BookingExpressIllustrated.astro`, `indiaLandingSource.ts`)
- Formats heading `e38ba82f0a13cc39`: One platform. Three ways. → **One platform. Three ways to earn from your audience.**
- Tile 1 (`live-streaming`, `india_goes_live`): h3 `b7a9f5518da78e1f` Live events → **Paid live streams**; p `982acdf78125b594` Sell tickets to your stream. → **Sell tickets to your live stream.**
- Tile 2 (`live-friends`, `book_their_time`): h3 `f34fb6b7a6f51b9d` 1:1 consultations → **1:1 video calls**; p `7480d0ba273e2df7` Offer your undivided time. → **Booked, paid, one follower at a time.** (or similar length, your wording)
- Tile 3 (`group-sessions`): h3 `84d0be67f5ca32a2` Group classes → **Group live sessions**; p `bf94bce3c2953bed` Teach or advise a small group. → **Host a small paid group live.** (your wording); href → `find_your_people` (fix a)
- express label `2bf54f09cc27116b` Your first booking express → keep
- `journeyTitle` (landing.json + indiaLandingSource): From poster to booking — four easy moves. → **From channel to first booking in four steps.**
- Steps — the h4 stays a short title, the body carries the brief's step text:
  - `stepOne` Create → **Create**; `stepOneBody` → **Create your creator page.**
  - `stepTwo` Price → **Price**; `stepTwoBody` → **Set your ticket or call price.**
  - `stepThree` Share → **Share**; `stepThreeBody` → **Share your avaTOK link with your audience.**
  - `stepFour` Host → **Go live**; step-4 body is a hardcoded literal in the component (`"Start your show on your app."`) → **Go live from the avaTOK app.** (also set `stepFourBody` in the source/catalog to the same text for consistency, even though the component does not read it)
- step `alt` texts in the `steps` array: make them creator-flavoured plain English of similar length (e.g. "A creator setting up their creator page.", "A creator choosing a ticket or call price.", "Sharing an avaTOK link with an audience.", "A creator going live from the avaTOK app.")
- bottom CTA `60be9273c8e3a386` Create your free listing → keep; `4222c5d83d78fcf9`/`07ed97e71da22c72` keep

### Ideas (rail-ideas section in `index.astro`)
- eyebrow `af29625174aed2ab` What will you offer? → **Ideas for your channel**
- H2 `35013d916827ddd2` + `6088e03833a8d3c7`: "Ideas you can" + "earn from." → **What could you offer** + **your audience?**
- `6193ee40538a4862` A few ideas to get your first listing started. → **A few ideas to get your first paid stream or call started.**
- cards/links/chips: UNCHANGED (they come from `creatorIdeas.ts`, out of scope). The six titles
  (Temple Darshan, Live / Ladakh Ride Diaries / English Practice Circle / Morning In The Village /
  Mum's Kitchen, Live / Make Reels On Your Phone) do not clash — leave them.
- `fb4c2e13ffc8a351` Explore more ideas → keep; `e7b786bad9689075` stays empty.

### Niche tiles (`CreatorIdeas.astro` via `indiaLandingSource.ts`)
Keep images and slots; labels become creator niches that honestly match each image:
- `ideasEyebrow` FROM CONTENT TO OFFER → **CREATORS WHO FIT AVATOK**
- `ideasTitle` What will you host? → **Which creator are you?**
- tile 1 (folk-dance image) `ideaOneTitle` Dance class → **Dance creators**; `ideaOneBody` → **Choreography breakdowns, live practice, feedback calls.**
- tile 2 (chai-stall vendor filming with a phone) `ideaTwoTitle` Home flavours → **Food & chai creators**; `ideaTwoBody` → **Recipe live streams, street-food stories, kitchen hacks.**
- tile 3 (study-with-me image) `ideaThreeTitle` Study buddy → **Study & exam creators**; `ideaThreeBody` → **Revision sprints, language practice, exam pep talks.**
- tile 4 (woman draping a saree on a group video call) `ideaFourTitle` Style desk → **Saree & fashion creators**; `ideaFourBody` → **Draping tutorials, outfit ideas, live styling streams.**

### Calculator (`EarningsCalculatorIllustrated.astro` via `indiaLandingSource.ts`)
- `calcEyebrow` THE MATH, CLEARLY → keep
- `calcTitle` See your gross estimate. → **Estimate your gross earnings**
- `calcBody` → **Change the inputs to see what paid live streams or 1:1 video calls could gross.**
- `calcLiveLabel` Live Ticket price per participant → **Ticket price per viewer**
- `calcAudienceLabel` Audience per event → **Viewers per stream**
- `calcEventsLabel` Events per month → **Streams per month**
- `calcOneLabel` 1:1 or 1:many Price per participant → **1:1 video call price**
- `calcBookingsLabel` Bookings per month → **Calls per month**
- `calcLiveTotal` Live event gross → **Live stream gross**
- `calcOneTotal` 1:1 gross → **1:1 call gross**
- `calcTotal`, `calcDisclaimer`, `calcPricingNote`, `ariaCalculator` → keep (the disclaimer MUST stay)
- the two `<small class="calculator-price-help">` literals ("₹100 platform fee per participant…") → keep as they are (pricing facts)

### Footer (`SiteFooter.astro`) — one string
- `chrome.tagline`, india branch: India's live creator bazaar. Book your seat, pull up a chair, take your time. → **Paid live streams and 1:1 video calls from creators you already follow.**
- Nothing else in the footer or header.

### Catalogs
For every `data-i18n="web-landing.<hash>"` key whose text you changed, set the same key in
`shared/i18n/source/web-landing.json` to the new text. For every `data-india-i18n="<key>"` you
changed, set that key in `shared/i18n/source/landing.json`. Note `web-landing.84d0be67f5ca32a2`
is (pre-existing bug) used both by the hero chip 3 ("1:1 video calls") and the group tile h3
("Group live sessions"); set the catalog value to the hero chip text ("1:1 video calls") — the
live-markup fallback wins for English anyway. Report it.

## Verify before every commit (from `web/`)

```
PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA PUBLIC_API_BASE=https://api.avatok.ai npm run build \
 && node scripts/check-homepage.mjs && node scripts/check-help.mjs \
 && node scripts/check-image-urls.mjs && node scripts/check-performance.mjs
```

Structural-identity check (mandatory, paste the result in your report). A build of current
`main` already exists at `/tmp/webgw-main-dist`. Strip text and diff:

```
strip() { python3 -c "import re,sys;h=open(sys.argv[1],encoding='utf8').read();h=re.sub(r'<script[^>]*>.*?</script>','',h,flags=re.S);h=re.sub(r'>[^<]*<','><',h);h=re.sub(r'(alt|aria-label|title|content|placeholder|data-i18n-meta)=\"[^\"]*\"',r'\1=\"\"',h);print(h)" "$1"; }
diff <(strip /tmp/webgw-main-dist/index.html) <(strip dist/index.html)
```
The ONLY allowed differences: `href="/ideas"` → `href="/marketplace"` on the hero CTA,
`book_their_time` → `find_your_people` on the group tile, and `lang="hi-Latn"` → `lang="en"`
on `<html>`. Anything else = you touched markup; undo it.

Also run, on `dist/index.html`: a banned-word/Hinglish grep of the visible text
(`grep -oiE 'tiktok|fans?\b|fanbase|fan base|meetup|meeting|private|find your people|friends|companion|lonely|dating|chat with|verified'`
on the tag-stripped text — expect ZERO hits outside the `<select>` language picker options),
and check that every internal href on the page exists in `dist/` (prerendered) or is one of
the SSR routes (`/marketplace`, `/sign-in`, `/sign-up`, `/sign-out`, `/dashboard`) and that
every `#anchor` has a matching `id=`.

Hydration check: from `web/`, `node --input-type=module -e` a script that imports nothing
from Astro — instead simply confirm, for each changed key, that
`shared/i18n/source/web-landing.json` / `landing.json` now hold the new English text (print a
key → value table). The runtime `t()` prefers live markup for `en`, so a matching catalog is
belt-and-braces.

Finally `git diff --stat HEAD` must list only the files in SCOPE. Run
`git diff HEAD -- web/src | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)'` and read every line:
every `-`/`+` pair must differ only inside a quoted string / text node, except the three
allowed fixes.

## Git

- Commit with `python3 scripts/git_safe_commit.py "[WEB-GATEWAY-HOME-CREATOR] <what>" <paths…>`
  — always pass explicit paths. One or two commits is fine.
- NEVER `git push`, never deploy, never run `wrangler`, `cf.sh`, `flags.sh` or `gh`.

## Report

Write `Specs/WEBGW-HOME-CREATOR-REPORT.md`: files changed; a before→after table of EVERY string
you changed (slot / key, old, new); the three allowed non-string fixes; the exact verify output
including the structural diff; the banned-word scan result; the link/anchor check; and a
"Could not do without touching markup" list. Do not push.
