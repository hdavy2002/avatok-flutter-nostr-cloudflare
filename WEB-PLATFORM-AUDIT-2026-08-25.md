# avatok.ai web platform audit — is Cloudflare Pages the right tech?

**Date:** 2026-08-25 · **Scope:** production feature planning · **Type:** written recommendation, no code changed

---

## The short answer

**Cloudflare is the right platform. Cloudflare *Pages* is the wrong product on it — move to Workers Static Assets.**

But that is the small half of the answer. The bigger finding is this:

> **avatok.ai is already a dynamic site.** Log-in, marketplace, paid booking, live-event
> watching and 1:1 video calls are all *built and deployed today*. What is missing is not
> technology. It is **inventory, the rupee payment rail on web, and an automatic deploy.**

Rebuilding the website would throw away working code and fix none of the three things
that actually make it feel static.

---

## What is actually live right now (verified, not remembered)

The site at avatok.ai is **not** a static brochure. It is an Astro 5 "hybrid" app in
`web/`, deployed to the Cloudflare **Pages** project `avatok-app`, with React islands
and Tailwind.

| Capability you asked for | Status | Where it lives |
|---|---|---|
| Users can log in | **Built** | `@clerk/clerk-react` 5.61 · `src/islands/auth/` · `/sign-in`, `/sign-up` |
| Pay for marketplace services | **Built, wrong currency** — see Gap 2 | `src/islands/checkout/` (SlotPicker → PayStep → Confirmation) |
| Book shows | **Built** | `/book/[id]`, `/dashboard/bookings`, `/dashboard/calendar` |
| Watch live events | **Built** | `/watch/[id]`, `/e/[event]` · WHEP WebRTC player + HLS fallback |
| 1:1 video call chats | **Built** | `/consult/[booking]` · native `RTCPeerConnection` against Cloudflare Realtime SFU |
| Creator dashboard | **Built** | 20 pages under `/dashboard` — wallet, payout, listings, storage, affiliate, identity |
| Admin console | **Built** | 7 pages under `/admin` — money, users, creators, live, system |

**Scale of what exists:** 70 `.astro` pages, of which **45 are server-rendered on demand**
(`export const prerender = false`), plus 3 server API endpoints and 11 island directories
of React components.

**Proof it is genuinely dynamic, not cached HTML** — probed live today:

```
GET https://avatok.ai/dashboard/wallet
  cache-control: private, no-store
  cf-cache-status: BYPASS          ← rendered per request at the edge
```

**Proof the backend is real:**

```
GET https://api.avatok.ai/api/explore/categories   → HTTP 200, 10+ live categories
```

The API Worker (`worker/`) exposes **127 route modules** — wallet, payout, UPI payout,
booking, calendar, listings, marketplace, live, consult, conference, KYC, subscribe.
The website is talking to the same backend the Flutter app does.

---

## The four real gaps

### Gap 1 — The marketplace has no stock (this is the big one)

```
GET https://api.avatok.ai/api/explore/search?limit=3
→ {"vertical":"commerce","listings":[],"cursor":null}
```

**Empty.** In production, right now.

Everything a visitor sees on the homepage — Meher's chai chat at ₹149, the Badrinath
temple tour at ₹50, Riya After Hours at ₹8/min — is hard-coded demo copy in
`web/src/lib/marketingContent.js`. The site's own footer admits it:
*"Demo listings for preview."*

So you have a fully working storefront with nothing on the shelves. A user who signs
up, clicks through to `/marketplace`, and finds it empty concludes the site is fake —
which reads exactly like "the site isn't dynamic," even though the machinery is fine.

**This is a supply problem, not an engineering problem.** No amount of re-platforming
fixes it. You need real creators publishing real listings.

### Gap 2 — Web checkout quotes dollars; your app charges rupees

Your 2026-08-05 decision was **1 Token = ₹1, India only**. The Flutter app honours it.
The website does not.

`web/src/islands/checkout/PayStep.tsx` still:

- calls `POST /api/wallet/topup` with `{ amountUsdCents }`
- formats every amount as `` `$${(coins / 100).toFixed(2)}` ``
- hands off to **Stripe Checkout**

And `worker/src/routes/wallet.ts` hard-writes `currency:'usd'` on that legacy route.

Meanwhile the *newer* route `POST /api/wallet/topup/intent` **already supports INR** —
it accepts `currency:'inr'` and converts paise → whole rupees → tokens at ₹1 = 1 Token.
The app uses it. The web client was never migrated.

**Net effect:** an Indian visitor browses listings priced in ₹, clicks pay, and is
quoted US dollars through Stripe. That is a conversion-killer and, for the Indian
market, a compliance-adjacent problem too (UPI is the rail your payouts already use —
`worker/src/routes/upi_payout.ts`).

### Gap 3 — The website does not deploy itself

`.github/workflows/web-deploy.yml` has its `push:` trigger **commented out**, disabled
2026-06-24 with the note *"no web, just apk."* It is `workflow_dispatch` only, and the
Pages project is not wired to Cloudflare's git integration.

Consequence: **`web/` changes go into git and never reach avatok.ai** until someone
manually runs the workflow. `web/` was last committed *today*
(`4617f5f7 [WEB-CARD-PAGINATION]`). What is live may well be older than what is in the repo.

This is invisible and it makes the site feel frozen.

### Gap 4 — Pages is now the legacy product

Cloudflare's own documentation, as of this month, is unambiguous. From
*Workers Best Practices*:

> **Use Workers Static Assets for new projects.** […] If you are starting a new project,
> use Workers instead of Pages. **Pages continues to work, but new features and
> optimizations are focused on Workers.**

Every page in the Pages documentation now carries a banner reading *"Are you sure you
want to use Pages?"*

Nothing is breaking, and there is no deadline. But you are on the product that stopped
receiving investment.

---

## Recommendation: Astro on Cloudflare **Workers** (not Pages), same repo, same backend

### Why Workers over Pages

| | Pages (today) | Workers Static Assets |
|---|---|---|
| Durable Objects binding | limited | **full** — matters: your `InboxDO`, `CallRoom`, conference rooms are all DOs |
| Cron triggers | no | yes |
| Observability / logs / traces | thinner | full Workers Logs + Traces |
| Cloudflare's investment | maintenance | **active** |
| Cost | — | *same* — static asset requests are free on both; function invocations bill identically |

The migration is genuinely small. In `web/wrangler.toml`:

```toml
# before (Pages)
pages_build_output_dir = "./dist"

# after (Workers)
main = "./dist/_worker.js"
[assets]
directory = "./dist"
```

…plus swapping the deploy command in `web-deploy.yml` from
`pages deploy dist --project-name=avatok-app` to `deploy`. The Astro Cloudflare
adapter already emits `_worker.js`; the KV `SESSION` binding carries over unchanged.

Budget roughly **half a day plus a careful cutover**, not a rewrite. It can wait behind
Gaps 1–3 — it is the least urgent of the four.

### Why *not* the alternatives

**Flutter Web — no.** It is the tempting answer because your app is Flutter, and it is
the wrong one:

- **SEO.** A creator marketplace lives or dies on Google indexing individual listings.
  Flutter Web renders into a canvas; there is no crawlable HTML. Your 48 SSR Astro
  pages are indexable today. You would be trading away your entire organic acquisition
  channel.
- **Payload.** Flutter Web ships a multi-megabyte CanvasKit runtime before anything
  renders. On a mid-range Android phone on Indian mobile data — your actual market —
  that is a punishing first visit.
- **You would delete 70 working pages** to gain code reuse you do not need: the one
  thing sharing would buy you (call UI) you already solved *better* on web with ~100
  lines of native `RTCPeerConnection`, no SDK, in `src/islands/consult/SfuClient.ts`
  and `src/islands/live/WhepPlayer.ts`.

**Next.js on Vercel — no.** Your entire backend is Cloudflare-native: D1, Durable
Objects, R2, Queues, KV, Realtime SFU, Stream Live, AI Gateway. Moving the frontend to
Vercel splits the stack across two vendors, adds a network hop between your pages and
your data, adds a second bill, and buys you nothing Astro-on-Cloudflare lacks. Your
architecture pivot doc (`Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`) chose
Cloudflare-native deliberately. Keep it.

**Stay on Pages — defensible.** If Gaps 1–3 consume all your time, doing nothing about
Gap 4 costs you nothing this quarter. Just do not build the *next* thing on Pages.

---

## Suggested order of work

| # | Work | Why first | Rough size |
|---|---|---|---|
| **1** | **Get real listings into `/api/explore/search`** — creator onboarding, seed the marketplace, replace `marketingContent.js` demo cards with live API data | Nothing else matters while the shelves are empty | Ongoing / product |
| **2** | **Move web checkout to the INR rail** — point `PayStep.tsx` at `/api/wallet/topup/intent` with `currency:'inr'`, format `₹`, add UPI | Web currently quotes `$` to Indian buyers | ~1–2 days |
| **3** | **Re-enable web auto-deploy** — restore the `push:` trigger on `web-deploy.yml` for `web/**` | The site silently drifts from the repo | ~1 hour |
| **4** | **Pages → Workers Static Assets** | Get off the legacy product before building more | ~half a day + cutover |

Items 2, 3 and 4 all touch production and are gated on your explicit go-ahead.

---

## What I did not verify

- **Whether the live deployment matches current `web/` source.** The deploy is manual,
  so it may be stale. Checking needs the Cloudflare Pages deployment history
  (`gh run list --workflow=web-deploy.yml`), which was not reachable from this session's
  sandbox.
- **Whether Clerk sign-in completes end-to-end on web.** The islands are present and the
  pages return 200; an actual sign-up→book→pay run on a real account was out of scope
  for a read-only audit.
- **Exact Cloudflare billing figures.** The Pages/Workers cost comparison above is from
  Cloudflare's own migration guide ("a similar cost structure"), not from your invoices.

---

## Sources

- Live probes of `https://avatok.ai` and `https://api.avatok.ai`, 2026-08-25
- `web/wrangler.toml`, `web/astro.config.mjs`, `web/package.json`
- `web/src/islands/checkout/PayStep.tsx`, `web/src/islands/consult/SfuClient.ts`, `web/src/islands/live/WhepPlayer.ts`
- `worker/src/routes/wallet.ts`, `worker/src/index.ts`, `worker/wrangler.toml`
- `.github/workflows/web-deploy.yml`
- [Cloudflare — Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare — Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
