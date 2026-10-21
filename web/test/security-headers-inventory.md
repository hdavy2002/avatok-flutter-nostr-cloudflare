# HF-SEC-HEADERS-1 delivery and CSP inventory

Phase one enforces object-src none, base-uri self, frame-ancestors self,
SAMEORIGIN, nosniff and strict-origin-when-cross-origin. Canonical production
HTTPS receives one-day HSTS, without includeSubDomains/preload.
The full resource policy is **report-only**. It does not prevent script XSS.
Reports are visible in the browser console; no report endpoint is configured
because it would create a new collection/retention surface requiring review.

## Source inventory (not a browser-network verification)

| Dependency | Evidence | Policy treatment |
| --- | --- | --- |
| Clerk | src/lib/clerk.tsx; src/lib/brand.ts authOrigin; publishable key supplied by deployment | exact configured brand Clerk host; actual key-derived host must be checked in browser |
| Turnstile | src/pages/api/contact.ts; contact challenge | challenges.cloudflare.com script/frame/connect |
| PostHog | src/lib/analyticsCore.ts default eu.i.posthog.com, configurable PUBLIC_POSTHOG_HOST | EU ingest + EU assets; overrides must be inventoried before enforcement |
| Cashfree | src/lib/hfTopupApi.ts sdk.cashfree.com/js/v3/cashfree.js | SDK, API and payment frame candidates; checkout may navigate to separate approved host |
| Razorpay | src/lib/hfTopupApi.ts checkout.razorpay.com/v1/checkout.js | checkout script and API/frame candidates |
| YouTube | components/dash2/YouTubeGuardedPlayer.tsx | www.youtube.com iframe API; youtube-nocookie frame; i.ytimg.com thumbnails |
| Instagram | remote reel embeds | www.instagram.com frame candidate; source/network verification still required |
| Images/media | generated BRAND.mediaOrigin and public image pipeline | same-origin, configured media, blob/data for images, Clerk avatar host |
| Styles/fonts | Astro styles, inline styles, self-hosted fonts | style unsafe-inline retained; fonts self/data |
| KYC, other API/media/embeds | runtime/provider URLs, legacy pages | incomplete dynamic origin inventory; violations expected, never wildcard-allow scripts |

No active requirement for cross-origin embedding of our own document was found;
/embed/listing is explicitly retired in middleware. Third-party frames embedded
inside our page are distinct from frame-ancestors, which controls who embeds us.

## Delivery and verification gates

- Middleware wraps every return, including cache HIT/MISS, redirects, 410,
  non-cacheable responses, and caught failures (generic 500/no-store).
- Pages static assets bypass Functions: public/_headers mirrors the policy;
  the node test checks parity after existing brand token substitution.
- Platform-level redirects/errors produced before middleware/static delivery may
  bypass these controls. Probe _redirects routes and Cloudflare-generated errors
  after deployment; platform configuration may be needed for those responses.
- Unit tests are prepared in security_headers.test.ts, not executed locally.
- HEADERS-01 still needs CI and deployed samples of static CSS, SSR, HIT/MISS,
  /rituals redirect and /vision 410. Preserve ETag/cache/cookies/body behavior.
- HEADERS-02 still needs a cross-origin browser iframe attempt proving blocking.
- HEADERS-03 remains unverified: inspect browser console/network through login,
  contact challenge, top-up, KYC, media and embeds with authorized fixture flows.
- HEADERS-04 remains incomplete: inline Astro/JSON-LD scripts and handlers need
  supported hashes or extraction before script enforcement. Never use shared
  cached per-request nonces. No unsafe-inline/unsafe-eval in report-only scripts.
- Do not promote report-only until all intended origins and inline scripts are
  accounted for and auth/payment/KYC/embed flow evidence is attached.
