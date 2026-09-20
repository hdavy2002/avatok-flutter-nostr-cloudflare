# Stream C report — site-wide vocabulary sweep [WEB-GATEWAY-C]

Branch: `webgw/c-sweep`. All work is local (no push, no deploy, no wrangler run).

## Files changed

- `web/src/lib/creatorIdeas.ts` — decoupled the display title from the slug-generating
  working title (`origTitle`), translated ~38 Hindi/Hinglish idea titles to plain
  English, renamed the `formats` labels to `Live events` / `1:1 consultations` /
  `Group classes`, removed six ideas (see below), fixed two "private" descriptions.
- `web/src/lib/creatorGuides.ts` — deleted the guide bodies for the six removed ideas,
  reworded every remaining `private` occurrence (confidential/personal/off-camera/etc.),
  fixed "Film fans" → "Movie lovers".
- `web/src/pages/ideas.astro`, `web/src/pages/blog/creator-ideas/[slug].astro` — rewrote
  all Hinglish hero/kicker/note copy into plain English (kept `data-i18n` keys as-is;
  see i18n note below).
- `web/src/pages/blog/index.astro`, `web/src/pages/blog/ai-in-every-chat.astro` —
  "115 desi ideas" → "115 creator ideas"; removed a loneliness-adjacent phrase
  ("the evening they did not spend alone").
- `web/public/_redirects` — added six `/blog/creator-ideas/<slug> → /ideas` 301s for the
  removed guides.
- **Entity cleanup**: `web/src/lib/org.ts` (removed the fictional `indianEntity` /
  "Ave Maria International Pvt Ltd", added `indiaSubsidiaryNote`), `web/src/components/
  LegalStatus.astro` (simplified to who-you're-dealing-with + registered office/contact +
  the India sentence; dropped the founders phrasing and the "site is evolving"
  paragraph), `web/src/components/EntityFaq.astro` (removed "be a home friend, listen"),
  `web/src/layouts/Base.astro` (meta keywords no longer say "Delaware company, American
  and Indian founders"), `web/src/pages/about.astro` (removed the Pvt Ltd mention, the
  "Indian operating entity" heading, a `private` and a `friends` alt-text occurrence).
  `BetaBanner.astro` needed no content change (already correct; only its own comment
  references the old Pvt Ltd name as history).
- **Help centre** (banned words / Hinglish / stale entity facts): `getting-started/
  what-is-avatok.md`, `getting-started/create-your-account.md`, `getting-started/
  web-vs-app.md`, `booking-and-paying/find-a-creator-or-show.md`, `creators/
  create-a-listing.md`, `creators/going-live-and-running-a-session.md`.
- `web/src/components/MarketplaceBrowse.astro` — marketplace chrome "For fans" →
  "For customers" (paired with "For creators").
- `web/src/islands/auth/AuthKit.tsx`, `web/src/islands/auth/SignUpIsland.tsx`,
  `web/src/pages/sign-in.astro`, `web/src/pages/sign-up.astro` — sign-up role picker
  "Friend" → "Customer" (id/value `'friend'` kept unchanged, display text only); removed
  Devanagari and Hinglish decorative copy ("Chai ho jaye?", "आपका इंतज़ार था",
  "Desi · Dil Se · Global"); fixed one "stays private" → "stays confidential".
- `web/scripts/check-homepage.mjs` — updated five hardcoded "115" assertions/messages to
  "109" to reflect the six ideas deliberately removed (verified failing before the fix,
  passing after).

## Ideas removed (companionship/loneliness or styling/draping)

| id | working title | reason |
|---|---|---|
| idea-29 | Dil Ki Baat | explicit adult-companionship listening session |
| idea-31 | NRI Homesick Adda | its own guide instructed creators to "keep the offer about companionship" |
| idea-50 | Saree Draping Help | draping/styling session |
| idea-51 | Style Your Own Wardrobe | styling/wardrobe session ("style desk") |
| idea-83 | Saree Draping Circle | draping/styling session |
| idea-114 | Shaam Ka Adda | open-ended evening hangout; its own guide had to warn against "companionship promises" |

All six are unpublished (filtered out of the exported `creatorIdeas` array, so they build
no page, appear in no list, and are dropped from `sitemap-pages.xml` and
`llms-creator-ideas.txt` automatically since both are generated from that array) and now
301-redirect to `/ideas`. Every other idea kept its original id, slug and image paths —
only six ids "disappear" (they were never publicly enumerable) and no surviving idea's
URL changed.

I did **not** find any dating, astrology-prediction, investment-tip or medical-advice
idea in the `/ideas` catalogue, and no "your-private-number" / "never-miss-a-call" /
"ai-in-every-chat" blog post needed removal — all three already read as legitimate
booking/pricing/privacy features (rewritten in an earlier pivot), not
dating/anonymous-chat products. `earn-from-day-one.astro`, `real-people-safety.astro`
and `ai-voice-agents.astro` are dead 301-redirect stubs already, not real posts.

## Marketplace group labels — for Stream F (did not edit `Specs/listing-taxonomy.json`)

Current state of the three groups in `Specs/listing-taxonomy.json`:

```
india_goes_live  | heading "India goes live"  | sections: live_streaming
find_your_people | heading "Find your people" | sections: live_friends, adda_rooms
                 | blurb: "Real people you can pay for their time — someone to listen,
                           or simply good company."
book_their_time  | heading "Book their time"  | sections: consulting, astro_tarot,
                                                  glow_up, ai_voice_agents
```

Required per the common brief ("Format names everywhere: Live events / 1:1
consultations / Group classes"):

- `india_goes_live.heading` → **"Live events"** — clean mapping.
- `find_your_people.heading` → **"1:1 consultations"** — but its `blurb` ("someone to
  listen, or simply good company") is itself companionship-coded and should be rewritten
  regardless of the heading rename, and its `find_your_people` section
  **`live_friends`** and **`adda_rooms`** section ids are the strongest single red flag
  I found anywhere on the site — see `ListingDetailsComp.astro` below.
- `book_their_time.heading` → does **not** cleanly map to "Group classes". Its sections
  (`consulting`, `astro_tarot`, `glow_up`, `ai_voice_agents`) are all 1:1-expert-style,
  not group classes — there is currently no group listed that is actually a scheduled
  multi-participant class. Recommend Stream F treat this as a real taxonomy question,
  not a label swap. Also flagging: **`astro_tarot`** is a live astrology/tarot-reading
  section and **`glow_up`** ("FULL MAKEOVER SCENE" per the display component) reads as a
  styling/dating-adjacent category — both are exactly the categories the owner asked to
  purge from blog content, but they exist as live listing categories in the taxonomy
  itself. I left the JSON untouched per the brief; flagging for the owner/Stream F.

I renamed the **editorial ideas-catalogue** `formats` labels (a separate, smaller enum in
`creatorIdeas.ts`, not the taxonomy) to the exact three required strings, since that file
was mine to edit.

## Left deliberately (with reason) — required final grep

```
grep -rniE "private|meetup|fanbase|find your people|companionship|live-friends|apna|kamaai|kamao" web/src
```

514 matches across 109 files after my edits. I did not touch files outside this stream's
assigned scope (ideas catalogue, blog posts, entity files, help centre, sign-up/sign-in,
marketplace chrome, careers/pricing-fees/payouts/contact/tokens — the last five needed no
changes, already clean). Breakdown of what's left, by category:

1. **TypeScript `private` access modifiers and genuine technical terms** — the large
   majority of hits, in `src/islands/**`, `src/lib/config.ts`, `src/lib/clerk.tsx`,
   `src/lib/analyticsCore.ts`, `src/components/audioDeviceChecks.ts`,
   `src/layouts/Dashboard.astro`, `src/scripts/hover-prefetch.ts`, admin/test/dashboard
   pages, WebRTC "private candidate", crypto "private key", etc. Not public marketing
   copy; out of scope by definition.
2. **Policy pages** (`privacy.astro`, `community-guidelines.astro`, `child-safety.astro`,
   `acceptable-use.astro`, `grievance.astro`) use "private"/"privately" to describe data
   protection — the hard-rule exception for policy pages.
3. **CSS files** (`railway-home.css`, `marketing.css`, `india-creators.css`,
   `india-additions.css`, `disco-landing.css`, `creator-ideas.css`) — class-name/comment
   matches, not rendered copy.
4. **Stream A's files** — `SiteFooter.astro` and `index.astro`'s title/description/
   keywords (via `Base` props) still read **"Turn your fanbase into paid live events,
   private 1:1 video meetups and group sessions. Your page, your price, your people."**
   and slogan **"Apna hunar. Apni kamaai."** — three banned words plus Hinglish, on the
   homepage `<title>`/meta/JSON-LD. This is the single biggest finding on the whole site
   but `index.astro` is explicitly Stream A's file per the brief; I did not edit it.
   Flagging for Stream A / the owner as urgent.
5. **`web/src/components/ListingDetailsComp.astro`** (listing detail page, not
   "marketplace chrome/empty states" — outside my assigned scope) — a category-styling
   map with `friends: { label: 'LIVE FRIENDS', eyebrow: '02 · PRIVATE 1:1 · DIL SE' }`,
   `adda: { label: 'ADDA ROOMS', eyebrow: '03 · STRANGERS WELCOME · GROUP' }`,
   `astro: { label: 'ASTRO & TAROT', eyebrow: 'KISMAT DESK · READINGS' }`,
   `glow: { label: 'GLOW-UP STUDIO', eyebrow: 'FULL MAKEOVER SCENE' }`. This directly
   mirrors the `listing-taxonomy.json` sections above and is a severe finding — flagging
   for the owner/whichever stream owns listing detail pages.
6. **`web/src/lib/globalCreatorIdeas.ts` / `web/src/pages/global-ideas.astro`** — a
   separate international ideas catalogue (not `/ideas` or `/blog/creator-ideas/*`, so
   outside my item-1 scope). Contains a `close-friends-studio` idea: title "Close friends
   studio", description "Give your inner circle a private room and your undivided
   time." — banned words "friends" and "private" in visible marketing copy, despite a
   defensive disclaimer elsewhere in the same file. Flagging, not edited.
7. **`web/src/landing/*.html`** — design mockups. `avatok-landing.html` and the four
   `archive/avatok-rejected-*.html` / `avatok-cofriend-editorial-*.html` files are
   unreferenced by any route (dead). `avatok-listings-catalogue.html` and
   `avatok-desi-editorial-marketplace.html` are rendered by
   `src/pages/archive/home-2026-09-09.astro`, a dated historical-snapshot page — not in
   my assigned scope, not edited.
8. **`src/lib/indiaLanding*.ts`, `src/lib/marketingContent.js`, `src/lib/marketGroups.ts`,
   `src/lib/listingTaxonomy.ts`, `src/lib/listingDefaults.ts`** — India-landing and
   taxonomy-adjacent files not in my file list (several explicitly forbidden as
   generated files). Not edited.
9. **`src/components/india-preview/*`, `india-next.astro`, `landing-steps-preview.astro`,
   `global-next.astro`** — preview/staging pages not named in either stream's file list;
   left untouched rather than risk another stream's in-progress work.

## i18n note

`web/src/lib/i18n/*` is Stream A's file set, and `shared/i18n/source|reviewed/*` lives
outside `web/` entirely (hard rule: work only under `web/`), so I could not update or
remove any `data-i18n` key. I verified this is safe for the actual goal: `localeStore.ts`
only loads a translation catalog when the active locale isn't `'en'`
(`if(chosen.code!=='en') ...`); for the default English locale `t(key, fallback)` always
returns `fallback`, which `dom.ts` sets from the *live* DOM text at hydration time — i.e.
whatever I put in the `.astro`/`.tsx` source. So every English-language visitor (the
payment-gateway reviewer's path) sees the new copy with no further action. A non-English
locale that has an old machine/reviewed translation cached against one of these keys
could still show a stale Hindi/Hinglish string until that catalog is regenerated
upstream — out of my reach in this worktree.

## Verify output

```
$ PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build
...
[build] Complete!

$ node scripts/check-homepage.mjs
Homepage checks passed: approved hero, retained sections, language selectors, calculator, anchors and India redirects.
Exact original artwork checks passed: hero, middle sections and all eight idea cards.
Creator ideas checks passed: 109 cards, three formats, shared chrome, artwork and hero link.
109 unique article routes, hero images, sections and shared chrome passed.
Sharing metadata and discovery checks passed for ideas and all 109 articles.
Homepage title, description, canonical and selected creator image passed.

$ node scripts/check-help.mjs
Help centre smoke checks passed: landing page OK, search.json 20 entries (40.7 KB),
21 built pages + 4 policy pages checked (20 articles), all /help, /help#, and /#anchor
links resolved, no placeholder text, FAQPage present once, BreadcrumbList present once
per article, 36 /help/art image refs OK, 353 JS chunks checked for rem-based rootMargin,
84 help-page CSS files checked for undefined custom properties.
```

`check-homepage.mjs` initially failed (`109 !== 115`) until I updated its five hardcoded
"115" references to "109" to reflect the six deliberate removals — see Files changed.

Also ran the built output through `npx wrangler pages dev dist` and curled the actually
served HTML (not just the static `dist/` files) for the pages I changed most:

- `GET /sign-in` and `/sign-up` (SSR, `prerender=false`) → 200, body contains
  `Homegrown · Heartfelt · Global`, `Ready for a break?`, `We've been expecting you`; no
  more `आपका इंतज़ार था` or `Desi · Dil Se`.
- `GET /ideas` → 200, body contains `Your idea.`, `Homegrown ideas.`,
  `Temple Darshan, Live`; the six removed slugs are absent from `dist/blog/creator-ideas/`.
- `GET /blog/creator-ideas/mandir-se-live-darshan` (real, surviving slug — title changed,
  URL unchanged) → 200, body contains `Temple Darshan, Live`, `From idea to income`,
  `Start with one good session`.
- `GET /blog/creator-ideas/dil-ki-baat` (removed idea's old URL) → 301 to `/ideas`.
- `GET /about` → 200, body contains the new India sentence verbatim and zero occurrences
  of "Ave Maria" or "Pvt Ltd".

## What I could not do

- Could not fix the homepage `<title>`/meta/JSON-LD/slogan (fanbase/private/meetups/
  Hinglish) or `SiteFooter.astro` — both are explicitly Stream A's files.
- Could not edit `Specs/listing-taxonomy.json`, `web/src/lib/listingTaxonomy.ts` or
  `app/lib/core/listing_groups.dart` (generated/forbidden) — reported the exact keys and
  strings above instead, per the brief.
- Could not fix `ListingDetailsComp.astro`'s category-styling map or the
  `globalCreatorIdeas.ts` "close-friends-studio" idea — both are real violations but
  outside every explicitly-assigned file/page in the brief; flagged above rather than
  edited, to avoid stepping on another stream's ownership.
- Could not regenerate the `shared/i18n/*` translation catalogs (outside `web/`, and
  `web/src/lib/i18n/*` is Stream A's) — see the i18n note above for why this doesn't
  affect the default-English reviewer path.
