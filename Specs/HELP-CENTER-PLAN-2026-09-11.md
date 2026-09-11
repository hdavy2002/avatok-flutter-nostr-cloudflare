# avatok.ai Help Centre — implementation plan

Tag: `[WEB-HELP-1]` · Date: 2026-09-11 · Surface: `web/` (Astro 5 + Cloudflare Pages, project `avatok-app`)

## 1. Decision

Build the help centre inside the existing Astro site, not as a separate wiki product.

- Lives at **`avatok.ai/help`**. Same header, footer, fonts and tokens as every other page — no new visual language.
- Content is **markdown files in the repo**, validated by an Astro Content Collection. Editing copy = editing a `.md` file and pushing to `main`; the existing `web-deploy.yml` ships it.
- Every help page is **prerendered** (`export const prerender = true`). No SSR, no Clerk, no KV, no worker code touched. Zero runtime cost.
- **Search is built at build time with no new dependency** (see §6). Pagefind is a later upgrade, not phase 1, because it needs a lockfile change and a `_routes.json` exclusion — both are known ways to turn a green commit into a failed deploy on this project.
- Hosted wikis (Wiki.js, BookStack, Outline) are ruled out: they need a server + DB, not Cloudflare Pages. Docs generators (Starlight, Docusaurus) are ruled out: separate site, separate look, second pipeline.

## 2. What "same design" means concretely

Reuse, don't re-create:

- Layout: `src/layouts/Content.astro` (the editorial layout used by /about, /terms, /tokens, /refunds, /payouts). It already provides `.editorial-page`, the tone backgrounds, the kicker/h1/lead header, `.prose` article styling and `<SiteHeader/>`/`<SiteFooter/>`.
- Fonts: whatever Base.astro already loads (Comfortaa display, Instrument Sans body, Playfair serif accents, self-hosted Nunito / Space Mono). **Do not add a font.**
- Tokens: the `--paper / --ink / --blue / --sky / --lime / --pink` set on `.editorial-page`. Help gets its own `tone` value (`tone="cream"` default; `sky` for billing pages is fine) — pick from the existing four, do not invent a colour.
- Type sizing in `rem` only (site-wide `html { font-size: clamp(...) }` rule).
- New CSS is limited to the two-column help shell (sidebar + article), the section index cards, and the search box. Put it in `src/layouts/Help.astro` `<style>`; do not touch `global.css` (its `@import` order is fragile — see the [UI-MOTION-1] note in that file).

## 3. Files to add / change

```
web/
  src/
    content.config.ts                    NEW  — collection + zod schema
    content/help/
      getting-started/*.md               NEW  — see §5 for the page list
      booking-and-paying/*.md
      creators/*.md
      billing/*.md
      account-and-safety/*.md
    lib/help.ts                          NEW  — SECTIONS map, getHelpTree(), buildSearchIndex()
    layouts/Help.astro                   NEW  — wraps Content.astro, adds sidebar + search + prev/next
    pages/help/index.astro               NEW  — landing: search box, section cards, "popular" list
    pages/help/[...slug].astro           NEW  — one route for every article (getStaticPaths)
    pages/help/search.json.ts            NEW  — prerendered search index (static endpoint)
    pages/sitemap-pages.xml.ts           EDIT — append help routes from the collection
    components/SiteFooter.astro          EDIT — add "Help centre" link (Company column) and to the policy strip
  scripts/check-help.mjs                 NEW  — post-build smoke check (see §9)
  package.json                           EDIT — add check-help to the build:check chain only if web-deploy.yml calls it explicitly (see §8)
.github/workflows/web-deploy.yml         EDIT — run `node scripts/check-help.mjs` after check-homepage
```

## 4. Content model

`src/content.config.ts`:

```ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const help = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/help' }),
  schema: z.object({
    title: z.string().min(4).max(90),
    description: z.string().min(20).max(200),   // meta description + card blurb
    section: z.enum(['getting-started', 'booking-and-paying', 'creators', 'billing', 'account-and-safety']),
    order: z.number().int().min(1),             // position within section
    updated: z.coerce.date(),
    keywords: z.array(z.string()).default([]),  // extra search terms, e.g. ["UPI","withdraw"]
    audience: z.enum(['buyer', 'creator', 'both']).default('both'),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]), // optional FAQPage JSON-LD
    draft: z.boolean().default(false),          // excluded from build, sitemap, search
  }),
});
export const collections = { help };
```

Rules enforced by the schema (a violation fails `astro build`, so it never ships):
- every page has a section, an order, a description, and an `updated` date;
- slugs come from the file path: `content/help/billing/platform-fee.md` → `/help/billing/platform-fee`;
- `draft: true` pages are filtered out everywhere (`getCollection('help', e => !e.data.draft)`).

Section labels, order and intro blurbs live in one place, `src/lib/help.ts`:

```ts
export const SECTIONS = {
  'getting-started':     { label: 'Getting started',     order: 1, blurb: '…' },
  'booking-and-paying':  { label: 'Booking & paying',    order: 2, blurb: '…' },
  'creators':            { label: 'For creators',        order: 3, blurb: '…' },
  'billing':             { label: 'Billing & payouts',   order: 4, blurb: '…' },
  'account-and-safety':  { label: 'Account & safety',    order: 5, blurb: '…' },
} as const;
```

Markdown body conventions: one `#`-less body (the layout renders `title` as h1), `##` for sections, `###` sparingly. Internal links are root-relative (`/help/billing/platform-fee`, `/refunds`). Images go in `public/help/` and are referenced as `/help/<name>.png`; keep them under 200 KB.

## 5. Initial page set (v1)

Write these from what the code and existing pages actually say — not from memory. Sources are named per page. Where the source is a policy page (/tokens, /refunds, /payouts, /marketplace-terms), the help article is the **plain-English version that links to the policy**, never a second copy of the policy.

**Getting started**
1. `what-is-avatok` — what the platform is, buyer vs creator, web vs app. Source: `components/EntityFaq.astro`, `lib/org.ts`.
2. `create-your-account` — web sign-up (email code + +91 SMS OTP), then onboarding in the app; why the app assigns your number. Source: `pages/sign-up.astro`, memory notes "web signs up, the app onboards".
3. `web-vs-app` — what you can do on avatok.ai vs in the app (web: browse, book, pay, watch; app: messaging, calls, onboarding, number). Source: `web/package.json` description, `pages/`.

**Booking & paying**
4. `find-a-creator-or-show` — marketplace, groups (`india_goes_live`, `find_your_people`, `book_their_time`), listing pages. Source: `pages/marketplace.astro`, `lib/marketGroups.ts`.
5. `book-a-1-1-session` — slots, what happens after paying, where the session runs. Source: `pages/book/`, `lib/commercialSessions.ts`.
6. `join-a-live-show` — join flow, when a show is "over", what happens if the creator never starts. Source: `worker/src/lib/listing_schedule.ts` (the single authority on expiry) and the orphan-sweep refund rule.
7. `tokens-explained` — 1 token = ₹1, top-ups, what tokens can't do, balance. Source: `pages/tokens.astro`.
8. `how-to-contact-a-creator` — web has no messaging; you get the creator's AvaTOK number + app link. Source: memory note "web has no messaging".

**For creators**
9. `create-a-listing` — the listing types, what makes a listing publishable (mirror `listing_blockers.ts` in prose: the single rule set), review verdicts. Source: `worker/src/lib/listing_blockers.ts`, `lib/listingErrors.ts`.
10. `listing-review-and-approval` — what "in review / approved / rejected" mean, that admins can edit a listing and you'll see the diff. Source: admin listing edit route, memory notes.
11. `pricing-your-listing` — how session pricing is computed and displayed. Source: `worker/src/lib/session_pricing.ts`.
12. `going-live-and-running-a-session` — device checks, the waiting room, what ends a session. Source: `components/DeviceChecks.tsx`, Specs/AUDIT-2026-09-11-PAID-SESSION-WAITING-AND-BILLING.md.

**Billing & payouts**
13. `platform-fee` — the fee split as it is actually charged today. ⚠ The ₹25 + 20% split is shown and validated in the UI but settlement still runs on the older snapshot (memory note "hourly fee is not wired to settlement"). **Write the article to what settlement really does, and add a `keywords`/TODO line so it is updated when the fee is wired.** Source: `session_pricing.ts`, `commercial_refund_rail.ts`, `pages/pricing-fees.astro`.
14. `refunds` — plain-English refund cases: creator no-show, buyer no-show, show cancelled, app-store purchases, chargebacks. Source: `pages/refunds.astro`, `commercial_refund_rail.ts`.
15. `withdrawing-your-earnings` — UPI payouts in India, verification, minimum balance, timelines, transfer fee/GST, failed payouts. Source: `pages/payouts.astro`.
16. `gst-and-tax` — what is withheld, what invoices you get. Source: `pages/payouts.astro` §6–7. Keep it factual; link to a CA, don't advise.

**Account & safety**
17. `verification-and-kyc` — face/ID verification, biometric retention. Source: `pages/biometric-retention.astro`, Didit flow.
18. `recording-and-consent` — Source: `pages/recording.astro`.
19. `report-a-problem` — grievance officer, contact routes, what to include. Source: `pages/grievance.astro`, `pages/contact.astro`.
20. `delete-your-account` — what is deleted, timelines. Source: BUG-account-delete-not-cascading.md — **only document current behaviour; if deletion doesn't cascade yet, say what actually happens.**

Plus a `faq` entry on the landing page built from the `faq:` arrays of all articles (rendered as an accordion + one FAQPage JSON-LD on `/help` only — not per article, same reasoning as [WEB-SEO-6]).

## 6. Search (phase 1, zero dependencies)

`src/pages/help/search.json.ts` is a prerendered static endpoint that emits one JSON document:

```json
[{ "url": "/help/billing/platform-fee", "title": "…", "section": "Billing & payouts",
   "description": "…", "keywords": ["fee","commission"], "headings": ["How the split works", "…"],
   "body": "first ~1,500 chars of plain text" }]
```

Built by `buildSearchIndex()` in `lib/help.ts` from `getCollection('help')` — strip markdown to text with a small regex pass (no library), collect `##` headings, truncate body. At 20–40 articles this is ~60–100 KB, cached a year under `/_astro`-style rules? No — it lives at `/help/search.json`, so it falls under the HTML `max-age=0, must-revalidate` rule in `public/_headers`. That is correct: it must never outlive a deploy either.

Client (`<script>` in `Help.astro`, vanilla, ~60 lines): fetch the index on first focus of the search box, score by title match > keyword match > heading match > body match, show top 8 results in a listbox with keyboard nav, `Enter` navigates. Progressive: with JS off the box is a plain form that submits to `/help?q=` and the landing page shows the section index (no server search).

Upgrade path: swap the client for Pagefind (`npm i -D pagefind`, `postbuild: pagefind --site dist`, and `adapter: cloudflare({ routes: { extend: { exclude: [{ pattern: '/pagefind/*' }] } } })` so the worker doesn't swallow the index files). Do this only if the article count passes ~80 or you want highlighted snippets; it requires a lockfile commit made with a working local `npm install`.

## 7. Layout & routes

`src/layouts/Help.astro` — props: `entry`, `tree`, `prev`, `next`. Renders `<Content width="wide" kicker={section label} title … updated …>` and inside the slot:

- left rail (sticky on ≥ 1024px, collapses to a `<details>` "Browse help" on mobile): section list with the current article highlighted;
- search box at the top of the rail (and on the landing hero);
- article body (`<Content />` from `render(entry)`), then "Was this helpful?" — **skip in v1**, it needs a backend;
- prev / next within section; "Related policy" links from a `related:` frontmatter field if you add one later;
- "Last updated" already comes from Content.astro via the `updated` prop.

`src/pages/help/[...slug].astro`:

```ts
export const prerender = true;
export async function getStaticPaths() {
  const entries = await getCollection('help', e => !e.data.draft);
  return entries.map(e => ({ params: { slug: e.id }, props: { entry: e } }));
}
```

`src/pages/help/index.astro`: hero with search, five section cards (label, blurb, top 3 articles by `order`), FAQ accordion, links to the policy pages.

Breadcrumb JSON-LD on every article (`Help › Section › Title`) via the existing `lib/org.ts` `ORG.url`; no FAQPage JSON-LD on articles.

## 8. Wiring the rest of the site

- **Footer**: add `Help centre → /help` to the Company column of `SiteFooter.astro` and to the policy strip. The footer click tracking already covers any link (it reads `textContent`).
- **Header**: no change in v1. If a nav item is wanted, it is a product decision — flag, don't do it.
- **Policy pages**: add a one-line "Looking for the plain-English version? See the help centre →" under the h1 of /tokens, /refunds, /payouts, /pricing-fees. That is the only edit to those pages.
- **Sitemap**: `sitemap-pages.xml.ts` currently hardcodes routes. Extend it to `import { getCollection } from 'astro:content'` and append `['/help', 'weekly', '0.8']` plus every non-draft article as `[url, 'monthly', '0.6']`. This is the one place the "keep in sync with src/pages" comment gets cheaper.
- **robots / llms.txt**: `/help/*` is public and indexable — add a `## Help` block to `public/llms.txt` listing the section index URLs.
- **CI**: in `web-deploy.yml`, after `node scripts/check-homepage.mjs`, add `node scripts/check-help.mjs`. Do not add it as `postbuild` — keep the build step byte-identical to today and let the workflow own the checks, as it does now.

## 9. Verification (must all pass before merge)

`scripts/check-help.mjs` (same shape as `check-homepage.mjs`, runs against `dist/`):
- `dist/help/index.html` exists and contains exactly one `<h1>`;
- every article listed in `dist/help/search.json` has a matching `dist/<url>/index.html`;
- every internal `href="/help/…"` inside any help page resolves to a built file (catches renamed slugs);
- every `href="/#…"` inside help pages resolves to an id on the homepage (extends the existing anchor rule);
- `search.json` is < 250 KB and has ≥ 15 entries (guards against an empty collection silently building green);
- no help page HTML contains the string `TODO` or `lorem`.

Manual, on the deploy preview (not a laptop build — see the memory note about local Pages deploys breaking sign-in):
- open `/help`, `/help/billing/platform-fee`, and one draft page URL (must 404);
- search "UPI" from the landing box → payouts article is the first result; keyboard-only path works;
- 400 px width: rail collapses, no horizontal scroll, search usable;
- view-source on an article: one h1, breadcrumb JSON-LD present, no FAQPage JSON-LD;
- Lighthouse on an article ≥ 95 performance (it is static HTML; anything lower means an island leaked in).

## 10. Phases

1. **Scaffold (½ day, one PR)** — content config, `help.ts`, `Help.astro`, index + slug routes, search endpoint + client, footer link, sitemap, `check-help.mjs`, workflow step. Ship with 5 placeholder-free articles (1, 2, 7, 14, 15) so the check passes and the section is real.
2. **Content (1–2 days, several small PRs)** — the remaining 15 articles, each written from its named source, each reviewed against the code before merge. Billing articles get reviewed against `session_pricing.ts` and `commercial_refund_rail.ts` line by line; that is where wrong copy costs money.
3. **Polish (later)** — Pagefind, "was this helpful" (needs a worker endpoint + D1 table), Hindi versions (`content/help/hi/**` with a `lang` field; do not plan the i18n routing until there is Hindi copy to route).

## 11. Guardrails for the implementing agent

- Do not add npm dependencies in phase 1. If you believe one is needed, stop and say why.
- Do not touch `astro.config.mjs`, `wrangler.toml`, `global.css`, `Base.astro`, or any `prerender = false` route.
- Every new file starts with a `[WEB-HELP-1 2026-09-11]` comment explaining what it is and why, in the same style as the rest of `web/`.
- Copy must describe **current** behaviour. Where the code and the marketing disagree (fee settlement, account deletion, "rates coming soon" on the calculator), the code wins and the article says so plainly.
- Never deploy from a laptop; open a PR and let `web-deploy.yml` produce the preview.
