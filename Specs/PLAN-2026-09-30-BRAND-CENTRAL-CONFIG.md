# PLAN 2026-09-30 — One place for the brand name and domain ([SAATHUM-BRAND-CENTRAL-*])

**Owner goal:** if Saa Thum / saathum.com changes, edit ONE file, rebuild, point
the new domain, and every page, email, WhatsApp message, backend link and app
screen follows.

## ARCHIVED issue id — never reuse `SAATHUM-BRAND-1`

`[SAATHUM-BRAND-1]` belongs to the 2026-09-20 avaTOK → Saathum rename
(commit `6ebe247a`, and the `[SAATHUM-BRAND-1 2026-09-20]` comments in the code).
It is closed. This centralisation work is `[SAATHUM-BRAND-CENTRAL-*]`. Reusing the old
id would make `git_safe_push.py` treat two unrelated pieces of work as one owner.

## Source of truth

`Specs/brand.json` → `python3 scripts/gen_brand.py` → committed mirrors:

| Surface | Mirror | Import |
|---|---|---|
| Website | `web/src/lib/brand.ts` | `import { BRAND, brandUrl, isBrandHost } from '../lib/brand'` |
| Worker | `worker/src/lib/brand.ts` | same API |
| Consumers | `consumers/src/brand.ts` | same API |
| Flutter | `app/lib/core/brand.dart` | `Brand.name`, `Brand.url('/l/x')` |

Never hand-edit a mirror. `typecheck.yml` runs `gen_brand.py --check` on every PR.

## What moves onto BRAND (customer-visible only)

- The display name in any spelling: `Saa Thum`, `SAA THUM`, `Saathum`, `सा थम`.
- `saathum.com` and its hosts (`api.`, `media.`, `clerk.`, `mail.`) in URLs.
- Mailboxes `support@ / noreply@ / hello@saathum.com` and the email sender name.
- i18n catalogs (`shared/i18n`): literal name → `{brand}` placeholder, filled from BRAND.

## What does NOT move (leave as-is)

- Code identifiers (`SaathumCheckout`, `saathumGstEnabled`, …), D1 tables/columns,
  migrations, KV flag keys — internal, renaming is pure risk.
- `com.saathum.app` — Play package ids are permanent.
- `SaathumApp/1` UA marker and `SaathumHost` JS channel — wire protocol between
  shipped apps and the site; changing them breaks old builds.
- Old docs, reports, audits.

## Rollout

1. ✅ **[SAATHUM-BRAND-CENTRAL-1]** brand.json + generator + mirrors + CI check. No behaviour change.
2. ✅ **[SAATHUM-BRAND-CENTRAL-WORKER-1/-2]** worker + consumers: URLs, emails, WhatsApp text → BRAND.
   wrangler vars (`WEB_BASE_URL`, `BLOSSOM_BASE_URL`, `CLERK_*`, `WALLET_RETURN_URL`)
   generated from brand.json too, so wrangler.toml is not a second place to edit.
3. ✅ **[SAATHUM-BRAND-CENTRAL-WEB-1/-2/-3]** website: layouts, header/footer, SEO, `org.ts`, `config.ts`,
   legal pages, `astro.config.mjs site:` → BRAND.
4. ✅ **[SAATHUM-BRAND-CENTRAL-I18N-1]** i18n: literal name → `{brand}`.
5. ✅ **[SAATHUM-BRAND-CENTRAL-APP-1]** Flutter: `config.dart` hosts + visible strings → `Brand`.
6. ✅ **[SAATHUM-BRAND-CENTRAL-GUARD-1]** CI guard `scripts/check_brand_literals.py`: fails on a
   literal `Saa Thum` / `saathum.com` / `@saathum.com` outside brand.json, mirrors,
   migrations and docs. Baselined like the design guard; debt only shrinks.
7. ✅ Test (2026-09-30): preview build with `name: "Test Brand"`, click through site, emails, app.

Steps 2–5 are independent (parallel agents, one worktree each); 6 after they land.

## Domain-switch day checklist (outside the code)

1. DNS + Cloudflare: new zone; attach to the Pages project and Worker routes (`api.`, `media.`).
2. Clerk: new custom auth domain + allowed origins.
3. Email: verify new domain in Cloudflare Email + Brevo (SPF/DKIM/DMARC); mailroom on `mail.`.
4. Keep saathum.com alive with path-preserving 301s to the new domain.
5. Google Search Console "Change of address".
6. HDFC/UPI merchant display name, Razorpay website URL, any gateway application.
7. Play Store listing name + website link.
8. Logo artwork (name is drawn inside images).
9. Re-read legal pages.

## Status 2026-09-30 — all steps done

- Dummy rename ("Test Brand" / testbrand.example) verified: worker + consumers bundles contain zero old-brand
  strings; the website build + every check passes and dist has zero old-brand text outside code comments.
- Where the brand now comes from: TS `BRAND` (web/worker/consumers), Dart `Brand`, i18n tokens `{brand}`
  (= nameCompact) `{brandCompactUpper}` `{brandDomain}` `{brandSupportEmail}`, help markdown `{{brand.name}}`
  etc. (remarkBrand + fillBrandTokens), web/public `%BRAND_*%` (postbuild brandify-public.mjs), web check
  scripts `web/scripts/brand.mjs`, wrangler vars synced by gen_brand.py (worker prod vars + api route,
  consumers EMAIL_FROM_DEFAULT).
- Guard: `scripts/check_brand_literals.py` + `tool/brand_literals_baseline.json` (leftover comments/ids).
  [SAATHUM-BRAND-CENTRAL-GUARD-2] It runs where agents cannot skip it: shared pre-push hook on the Mac
  (`bash scripts/hooks/install-brand-guard.sh`, checks the pushed commit via `--rev`), `git_safe_push.py`,
  `scripts/cf.sh … deploy`, `web-deploy.yml` (before build), and `typecheck.yml` on PRs.

## Rename-day procedure (code side)

1. Edit `Specs/brand.json`; run `python3 scripts/gen_brand.py`; commit.
2. Deploy worker, consumers, website; ship the app.
3. Then the external checklist above (DNS, Clerk, email, 301s, Search Console, gateway, Play, logo).
Notes: Astro's content cache (`web/node_modules/.astro/data-store.json`) can serve stale help pages
locally — delete it before a local build (CI starts clean). Help-page `data-i18n` hash keys change with the
name. Preeti keeps her own admin brand override (`brand_settings` in D1) — set it to match, or clear it.
