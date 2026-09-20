# WEB-GATEWAY-RESTORE-TEXT — text-only safety pass (Sonnet implementer brief)

You are working in the git worktree `/Users/davy/.cache/deepastra/webgw-20260918/restore`,
branch `webgw/restore`. HEAD (`c3f7344b`) restored `web/` byte-for-byte to the pre-rollout
site (commit `76003bb2`, "BASELINE") except the generated `web/src/lib/listingTaxonomy.ts`.
That restored site is LIVE right now. Your job is a **text-only** safety pass on top of it.

Read first: `Specs/WEBGW-COMMON.md` (banned words, verify commands). The reviewed English
wording you should reuse lives in the previous rollout, commit `a42f2a41` — read it with
`git show a42f2a41:web/src/pages/index.astro` etc. **Never `git checkout a42f2a41 -- <file>`**:
those files changed markup; you may only copy STRINGS out of them.

## THE ABSOLUTE RULE (the owner's instruction, verbatim intent)

"Revert back to what it was and only change the texts to make it play safe. The rest I will
deal with later."

So: **no layout, structure, component, CSS, image, section-order, navigation, route, href,
attribute-name, class, id, or behaviour changes. Zero new sections, zero removed sections, no
new components, no deleted components, no class changes, no new files under `web/src`.**
Only human-readable strings may change:

- text nodes, headings, button/link labels
- `alt`, `aria-label`, `title`, `placeholder` attribute VALUES
- `<meta>` title / description / keywords / OG / Twitter VALUES, `<title>`
- JSON-LD text values (name, description, slogan…), never keys or `@type`
- string literals in `.ts`/`.tsx`/`.js` that are rendered as copy (`copy.ts`, `org.ts`,
  `creatorIdeas.ts`, `creatorGuides.ts`, `listingDefaults.ts`, island label strings…)
- Markdown body text in `web/src/content/help/**.md` (not front-matter keys, not slugs)
- the English catalog VALUES in `shared/i18n/source/<namespace>.json` for keys whose
  markup string you changed (same key, new value — never add/remove/rename keys)

Keep every changed string close to the original's length so nothing wraps differently.
Keep `data-i18n="…"` keys exactly as they are. Do not touch `hrefs`, `data-*` ids,
`lang=` attributes, `class=`, `id=`, `style=`, image paths, `srcset`, widths/heights.
The language picker stays exactly as it is (do NOT bring back the `setUiLocale` change
from `a42f2a41`).

If a requested change cannot be done without touching markup, DO NOT do it — leave the
original and list it under "Could not do" in your report.

## What to change

1. **Homepage hero** (`web/src/pages/index.astro`, the two `<h1>` spans, the `<p>`, the
   kicker, the two CTAs, the three format chips):
   - H1 reads "Turn your skill into income." — split across the two existing spans as
     `Turn your skill` / `into income.` (the second span is the accent line; keep both spans).
   - Description paragraph text, EXACTLY this sentence set, split so the existing `<ui-copy>`
     holds the first two sentences and the existing `<strong>` holds the third:
     "avaTOK is a marketplace where verified creators sell tickets to live online events, 1:1
     video consultations and small-group classes. Customers book and pay in rupees. Creators
     are paid to their bank account."
   - Kicker/eyebrow: "Creator marketplace · India"
   - CTAs: "Start selling, free" (the `/sign-up` link) / "Browse sessions" (the `/ideas`
     link — the href stays `/ideas`; do not change it).
   - Format chips: the labels must be truthful for the href they already carry under the
     current taxonomy: `?group=india_goes_live` → "Live events",
     `?group=find_your_people` → "Group classes", `?group=book_their_time` →
     "1:1 consultations". Do not reorder or re-link the anchors.
   - Everything else in the hero (the "● Live around the world" badge, "you keep", "Find your
     first earning idea", `aria-label`s, `alt`s, `<title>`/description meta in the `<Base>`
     props) → plain English, no Hinglish, no banned words.
2. **Homepage ideas section** (same file): eyebrow and `<h2>` in English (e.g. "What will you
   offer?" / "Ideas you can" + "earn from."). The `<p class="rail-note">` footnote
   ("Listening sessions: adults 18+ · Companionship, not therapy…") keeps its element but its
   text becomes empty (`></p>` with nothing inside). The section keeps six cards from
   `creatorIdeas.slice(0, 6)`: after step 6 below the Dil Ki Baat slot must be filled by an
   existing, published, SAFE idea (a live event / class / consultation idea in plain English)
   — reorder the `creatorIdeas` array entries if needed so the sixth card is safe; do not add
   a new idea.
3. **All other default English copy**: header, footer, marketplace (`MarketplaceBrowse.astro`,
   `BazaarHero.astro`, `BazaarSearchStrip.astro`, `islands/marketplace/*` labels &
   placeholders, `lib/marketGroups.ts`, `lib/copy.ts`, `lib/listingDefaults.ts`,
   `lib/card.ts`), listing details (`ListingDetailsComp.astro` labels/eyebrows/CTA text,
   `listing/ReviewsSection.astro`, `pages/[username]/[slug].astro`, `pages/l/[id].astro`,
   `pages/e/[event].astro`), sign-in/sign-up (`pages/sign-in.astro`, `pages/sign-up.astro`,
   `islands/auth/*`), about, pricing, payouts, contact, ideas (`pages/ideas.astro`,
   `pages/blog/creator-ideas/[slug].astro`, `pages/blog/index.astro`,
   `pages/blog/ai-in-every-chat.astro`, `lib/creatorGuides.ts`, `lib/globalCreatorIdeas.ts`),
   help centre markdown (`content/help/**`), and `layouts/Base.astro` default meta keywords:
   plain English in the default locale, no Hinglish, no Devanagari, none of the banned words
   from COMMON (private, meetup, fanbase, fans, find your people, friends, companionship,
   lonely, chat with, date/dating) except inside policy pages that PROHIBIT those things, and
   "private" is allowed on `/privacy` in its data-protection sense. Format names everywhere:
   "Live events", "1:1 consultations", "Group classes". Footer Hindi slogans → short English
   equivalents of similar length, or empty text in the same element. The nav label "Wiki" may
   stay. Sign-up role picker: display text "Friend" → "Customer", but the option value/id stays
   `'friend'`.
4. **Listing details labels/eyebrows** (`ListingDetailsComp.astro` maps, `copy.ts`,
   `listingDefaults.ts`, `ReviewsSection.astro`): neutral English strings only — same keys,
   same styling. Use the wording from `a42f2a41` ("FIRST SHOW", "NEW HOST", "Reviews",
   "PAYMENT PROTECTED", …).
5. **Entity text** — only "Ava Global International, Inc." may be named. No "Ave Maria", no
   "Pvt Ltd" anywhere in rendered text or meta. India is mentioned with EXACTLY this
   sentence: "An Indian subsidiary is being incorporated in Mumbai; its details will be
   published here once registered." Edits stay INSIDE the BASELINE structure of
   `lib/org.ts`, `components/LegalStatus.astro`, `components/EntityFaq.astro`,
   `pages/about.astro`, `pages/careers.astro`, `layouts/Base.astro` (meta keywords):
   - `org.ts`: `indianEntity.name` → `''` (empty string; keep the object and its keys),
     `description` / `foundersDescription` / `slogan` / any JSON-LD text → plain English with
     no founders phrasing ("Founded by American and Indian founders" → e.g. "Founded in 2025"
     of similar length), no "Delaware company, American and Indian founders" in keywords.
     Do NOT remove the `indianEntity` field, do not change `legalName`, address, governing
     law or jurisdiction wording.
   - `LegalStatus.astro`: the `<strong>Our Indian operating entity.</strong>` text → "India."
     and the following `<ui-copy>` text → the exact India sentence above; the "American and
     Indian founders" phrases → neutral wording of similar length; keep every `<p>`,
     `<strong>`, `<ui-copy>`, `{ORG.…}` expression and `data-i18n` key in place.
   - `EntityFaq.astro`: answer strings only; drop founders phrasing and "be a home friend,
     listen" style wording.
   - `about.astro`: the `lead` string and the founders heading/paragraph text and the
     Pvt Ltd mention → neutral English; the "Indian operating entity" heading text → a neutral
     heading of similar length, section stays.
6. **Content safety** — the six creator-idea guides removed by Stream C stay unpublished:
   ids `idea-29` Dil Ki Baat, `idea-31` NRI Homesick Adda, `idea-50` Saree Draping Help,
   `idea-51` Style Your Own Wardrobe, `idea-83` Saree Draping Circle, and `Shaam Ka Adda`
   (find its id). Do this the way `a42f2a41` did in `lib/creatorIdeas.ts` (filter them out of
   the exported array; keep all other ids/slugs/image paths) and `lib/creatorGuides.ts`
   (delete only those six guide bodies). Add the six `/blog/creator-ideas/<slug>  /ideas  301`
   lines to `web/public/_redirects` exactly as in `git show a42f2a41:web/public/_redirects`
   (the six lines only — NOT the close-friends-studio page; do not create any new page).
   After the build, confirm each of the six slugs is in `dist/_redirects` and that
   `dist/_routes.json` has fewer than 100 `exclude` entries (Cloudflare drops entries past the
   cap silently). Clean meta keywords wherever they carry the Hinglish/founders/companionship
   terms. `web/scripts/check-homepage.mjs` hardcodes 115 ideas and the old hero strings —
   update those assertions (numbers and the expected strings) so the script checks the NEW
   copy; that script is not shipped, so it is the one place non-string edits are allowed.
7. **i18n**: apply ONLY the one-line `t()` change from
   `git show a42f2a41:web/src/lib/i18n/localeStore.ts` (live markup fallback beats the stale
   catalog for `en`), with its comment. Do NOT apply the `setUiLocale` change (locale
   switching must keep working). Then, for every `data-i18n` key whose English string you
   changed, update that key's value in `shared/i18n/source/<namespace>.json` to the new
   English (same key). Do not add or remove keys; do not touch `reviewed/`, `locales.json`
   or the inventory/coverage JSON files.

## Verify before every commit (from `web/`)

```
PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA PUBLIC_API_BASE=https://api.avatok.ai npm run build \
 && node scripts/check-homepage.mjs && node scripts/check-help.mjs \
 && node scripts/check-image-urls.mjs && node scripts/check-performance.mjs
```

Structural-identity check (mandatory, paste the result in your report): a BASELINE build
already exists at `/tmp/webgw-baseline/web/dist`. For `dist/index.html` and `dist/ideas/index.html`
(prerendered) run the same text-strip on both and diff:

```
strip() { python3 -c "import re,sys;h=open(sys.argv[1],encoding='utf8').read();h=re.sub(r'<script[^>]*>.*?</script>','',h,flags=re.S);h=re.sub(r'>[^<]*<','><',h);h=re.sub(r'(alt|aria-label|title|content|placeholder)=\"[^\"]*\"',r'\1=\"\"',h);print(h)" "$1"; }
diff <(strip /tmp/webgw-baseline/web/dist/index.html) <(strip dist/index.html) && echo HOME-STRUCT-IDENTICAL
diff <(strip /tmp/webgw-baseline/web/dist/ideas/index.html) <(strip dist/ideas/index.html) && echo IDEAS-STRUCT-IDENTICAL
```
(`/ideas` will legitimately differ by six removed `<article>` cards — show the diff and
confirm it is ONLY those six cards.) For the SSR pages run `npx astro preview` (or
`npx astro dev`) and curl `/marketplace`, `/sign-in`, `/about`, `/l/avatok-upi-smoke-2026`
and one `/[username]/[slug]`; grep each for banned words and Hinglish, and eyeball that the
tag structure is unchanged versus the same curl against the baseline build served from
`/tmp/webgw-baseline/web` (`npx astro preview` there on another port).

Finally `git diff --stat HEAD` must list only files under `web/src`, `web/public/_redirects`,
`web/scripts/check-homepage.mjs`, `shared/i18n/source/` and `Specs/`. Run
`git diff HEAD -- web/src | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)'` and read every line:
every `-`/`+` pair must differ only inside a quoted string, a text node, or a comment.

## Git

- Commit with `python3 scripts/git_safe_commit.py "[WEB-GATEWAY-RESTORE-TEXT] <what>" <paths…>`
  — always pass explicit paths. One or a few commits is fine.
- NEVER `git push`, never deploy, never run `wrangler`, `cf.sh`, `flags.sh` or `gh`.
- Do not touch `worker/`, `app/`, `migrations/`, `Specs/listing-taxonomy.json`,
  `web/src/lib/listingTaxonomy.ts`.

## Report

Write `Specs/WEBGW-RESTORE-TEXT-REPORT.md`: files changed, the before→after of the key
strings (hero, chips, footer slogans, entity paragraph), the six unpublished ids and their
redirect lines, the exact verify output including the structural-identity results, and a
"Could not do without touching markup" list. Do not push.
