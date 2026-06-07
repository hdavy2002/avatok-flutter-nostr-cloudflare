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
