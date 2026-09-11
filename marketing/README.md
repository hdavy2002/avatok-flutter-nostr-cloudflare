# avaTOK marketing site

Static React (Vite) marketing site for **avatok.ai** (the public landing page).
No backend — product infrastructure lives on `avatok.ai` subdomains (`blossom.`,
relay, api) and Workers; this page never calls them.

## Develop
```
cd marketing
npm install
npm run dev        # local
npm run build      # → dist/
npm run deploy     # wrangler pages deploy dist --project-name=avatok-web
```

## Deployed
- Cloudflare Pages project: **avatok-web**
- Live: https://avatok-web.pages.dev  (latest deploy printed by wrangler)

## Custom domain (manual, one-time)
The site should serve from **avatok.ai** (apex) and **www.avatok.ai**. The
`avatok.ai` zone already exists in this Cloudflare account.
1. Pages → project **avatok-web** → Custom domains → add `avatok.ai` and `www.avatok.ai`.
2. Cloudflare provisions the cert automatically. (Infra subdomains like
   `blossom.avatok.ai` are unaffected — only the apex/`www` route to Pages.)

## Environment variables (Pages project **avatok-web**)
Set these on the Pages project (dashboard → **avatok-web** → Settings →
Environment variables), not in this repo — `marketing/public/_worker.js` reads
them from `env` at request time. There is no CI workflow for this project (see
below), so a var/secret change here only takes effect after it is set in the
dashboard **and** the next `npm run deploy`.

`/api/waitlist` adds the contact to Brevo's list (unchanged) and sends the
thank-you email Cloudflare-first, Brevo-fallback — see
`Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md`.

| Var | Kind | Required | Purpose |
|---|---|---|---|
| `BREVO_API_KEY` | encrypted secret | yes | Brevo contact list add (`/api/waitlist`) and the Brevo fallback send. |
| `BREVO_LIST_ID` | plain var | no | Comma-separated Brevo list id(s) to add new contacts to. |
| `BREVO_SENDER_NAME` | plain var | no | Thank-you email sender display name. Default `AvaTOK Joinlist`. |
| `BREVO_SENDER_EMAIL` | plain var | no | Thank-you email sender address. Default `hello@avatok.ai`. |
| `CF_ACCOUNT_ID` | plain var | no (recommended) | Cloudflare account id for the Email Sending REST API. Value: `fd3dbf43f8e6d8bf65bd36b02eb0abb0`. |
| `CF_EMAIL_API_TOKEN` | encrypted secret | no (recommended) | Cloudflare API token, scoped to **Account → Email Sending → Edit** only, used to send the thank-you email via Cloudflare first. |
| `ASSETLINKS_SHA256` | plain var | no | Comma-separated Android release-key SHA-256 fingerprint(s) for `/.well-known/assetlinks.json`. |

If `CF_ACCOUNT_ID` / `CF_EMAIL_API_TOKEN` are unset, the thank-you email sends
via Brevo only (today's behaviour) — the Brevo contact list add is unaffected
either way.

## Deploy mechanism (important for anyone changing env vars)
This site is **not** wired to any GitHub Actions workflow — no CI job deploys
`marketing/`. It ships only via a developer running `npm run deploy` (wrangler
CLI) from this directory, or by pushing directly to the Pages project through
the Cloudflare dashboard's own git integration if that is ever enabled. So:
setting `CF_ACCOUNT_ID` / `CF_EMAIL_API_TOKEN` on the Pages project takes
effect on the *next* manual deploy, not on the next `git push` to `main`.

Note: the separately-deployed `web/` app (Astro; Pages project **avatok-app**,
deployed by `.github/workflows/web-deploy.yml` on every push to `main`) is a
newer build of the avatok.ai site with its own `/api/*` routes. Confirm which
Pages project actually owns the `avatok.ai` custom domain before assuming this
worker is still live — see that workflow and the Pages dashboard's Custom
domains tab for both projects.
