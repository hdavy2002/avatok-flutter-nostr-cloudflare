# AbrTalk marketing site

Static React (Vite) marketing site for the **brand domain `abertalk.ai`**. No
backend — all product infrastructure lives on `avatok.ai` and is never referenced
here (per spec §1 domain rule).

## Develop
```
cd marketing
npm install
npm run dev        # local
npm run build      # → dist/
npm run deploy     # wrangler pages deploy dist --project-name=abertalk
```

## Deployed
- Cloudflare Pages project: **abertalk**
- Live: https://abertalk.pages.dev  (latest deploy printed by wrangler)

## Custom domain (manual, one-time)
`abertalk.ai` is a brand domain. To attach it:
1. Add `abertalk.ai` as a zone in this Cloudflare account (or use an external
   registrar pointing NS to Cloudflare).
2. Pages → project **abertalk** → Custom domains → add `abertalk.ai` + `www`.
3. Cloudflare provisions the cert automatically.

Do **not** put any API/infra hostnames on this domain — those stay on `avatok.ai`.
