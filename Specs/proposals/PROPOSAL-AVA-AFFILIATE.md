# PROPOSAL — AvaAffiliate

**Status:** PROPOSAL (awaiting owner approval)
**Date:** 2026-06-11
**Author:** Claude (with owner decisions captured 2026-06-11)
**Depends on:** Wallet/settlement engine (Q_MONEY), Trust Ladder (Progressive Identity), listings/orders escrow, PostHog `track()` helper
**Kill switch:** `avaAffiliateEnabled` (default OFF until launch)

---

## 1. Summary

AvaAffiliate lets **anyone** become an affiliate with nothing more than a **verified email + password** (Trust Ladder **L1**). An affiliate picks a specific creator **listing** in AvaLive, AvaConsult, or AvaVoice, gets a unique **link + QR code**, and earns a **10% commission on every payment a referred user ever makes on that listing — for life**. The commission is **deducted from the platform/admin share** at settlement time (the creator's earnings are untouched) and credited **atomically, in the same settlement transaction**, to the affiliate's AvaWallet.

### Owner decisions (locked 2026-06-11)

| Decision | Choice |
|---|---|
| Commission duration | **Lifetime** — every purchase the referred user makes on the promoted listing |
| Attribution | **Bind at signup / first open** via link or QR; **last affiliate link wins** before binding |
| Payout timing | **Instant at settlement** — same atomic ledger transaction as the creator/platform split |
| Link scope | **Per product listing** — one link/QR per (affiliate, listing) pair; most granular stats |
| Eligibility | **L1** (verified email + password). No KYC needed to *earn*; withdrawal follows existing AvaPayout rules |

---

## 2. The money rule (canonical)

> **`affiliate_coins = floor(gross_coins × 0.10)`, capped at `platform_coins`. It is subtracted from the platform share. Creator share is never touched.**

```
gross_coins      = what the buyer paid (existing)
creator_coins    = gross − platform_cut          (existing, UNCHANGED)
platform_cut     = gross × commission_rate       (existing rate per app)
affiliate_coins  = min(floor(gross × 0.10), platform_cut)   (NEW)
admin_coins      = platform_cut − affiliate_coins            (NEW)
```

### Worked examples (current seeded `commission_rates`)

| Product | Gross | Platform rate | Creator gets | Platform cut | Affiliate (10% of gross) | Admin keeps |
|---|---|---|---|---|---|---|
| AvaLive ticket/entry | 1,000 | 30% | 700 | 300 | 100 | 200 |
| AvaConsult order | 1,000 | 25% | 750 | 250 | 100 | 150 |
| AvaVoice session | 1,000 | 50% | 500 | 500 | 100 | 400 |

> **CONFIRMED (owner, 2026-06-11): 10% of gross**, funded entirely out of the admin share. The cap (`min(…, platform_cut)`) guarantees the platform can never go negative even if a future product has a sub-10% rate. The 10% figure lives in `commission_rates` as `affiliate_default` so it is tunable without a deploy.

### Commissionable payments (owner decision 2026-06-11)

Only the **core purchase of the promoted listing** earns commission:

| App | Commissionable | NOT commissionable |
|---|---|---|
| AvaLive | **Ticket/entry purchase only** | Gifts during the stream, live-translation charges, any add-ons |
| AvaConsult | The listing order/booking payment | Tips, add-ons |
| AvaVoice | Agent session payment | Add-ons |

Implementation: the settlement step checks `order.kind` against an allowlist (`live_ticket`, `consult_order`, `voice_session`). Gift and translation settlements skip the affiliate branch entirely.

### Refunds

If an order refunds, the settlement reversal claws back proportionally from all three legs (creator, admin, affiliate) using the same `settlement_log` entry. Affiliate earnings respect the existing **7-day `earning_holds`** window, so refund-eligible commissions are never withdrawable early. (Holds piggyback on the existing mechanism — no new code path.)

---

## 3. Identity gateway

- **Become an affiliate:** requires Trust Ladder **L1** (Clerk email+password, email verified). That's the entire bar — exactly the existing `/api/identity/upgrade` L0→L1 flow. L0 guests see the affiliate page but get an "verify your email to start" upsell.
- **Earn:** L1 is sufficient. Commissions accumulate in the affiliate's AvaWallet.
- **Withdraw:** unchanged — AvaPayout's existing requirements apply (L2/L3 as already enforced for creators). AvaAffiliate adds **no new identity machinery**.
- Per-account scoping is mandatory as everywhere: all affiliate local state keyed with `scopedKey(...)` / `AccountScope.id` (parent + child share a phone).

---

## 4. Data model (D1 — `avatok-wallet` for money, `avatok-meta` for links/attribution)

```sql
-- avatok-meta -----------------------------------------------------------
CREATE TABLE affiliates (
  uid           TEXT PRIMARY KEY,          -- user id (one affiliate account per user)
  code          TEXT UNIQUE NOT NULL,      -- short public handle, e.g. 'dvy7k2'
  status        TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  created_at    INTEGER NOT NULL
);

CREATE TABLE affiliate_links (
  id            TEXT PRIMARY KEY,          -- link id, used in URL: avatok.ai/a/<id>
  affiliate_uid TEXT NOT NULL REFERENCES affiliates(uid),
  listing_id    TEXT NOT NULL,             -- listings.id (kind: live | consult | voice)
  app           TEXT NOT NULL,             -- 'avalive' | 'avaconsult' | 'avavoice'
  status        TEXT NOT NULL DEFAULT 'active',  -- active | paused | listing_dead
  created_at    INTEGER NOT NULL,
  UNIQUE(affiliate_uid, listing_id)        -- one link per affiliate per listing
);
CREATE INDEX idx_aff_links_affiliate ON affiliate_links(affiliate_uid);
CREATE INDEX idx_aff_links_listing  ON affiliate_links(listing_id);

CREATE TABLE affiliate_attributions (      -- the lifetime binding
  referred_uid  TEXT NOT NULL,
  listing_id    TEXT NOT NULL,
  link_id       TEXT NOT NULL REFERENCES affiliate_links(id),
  affiliate_uid TEXT NOT NULL,
  bound_at      INTEGER NOT NULL,
  source        TEXT NOT NULL,             -- 'qr' | 'link' | 'share'
  PRIMARY KEY (referred_uid, listing_id)   -- one affiliate per user per listing, set once
);
CREATE INDEX idx_aff_attr_link ON affiliate_attributions(link_id);

-- pending clicks before signup (KV, not D1): aff_pending:<device_or_session> →
--   { link_id, ts }  TTL 30 days; LAST write wins (= "last link wins" rule).

-- avatok-wallet ----------------------------------------------------------
CREATE TABLE affiliate_commissions (       -- one row per commission event (reporting)
  id             TEXT PRIMARY KEY,         -- = settlement_log id + ':aff' (idempotent)
  link_id        TEXT NOT NULL,
  affiliate_uid  TEXT NOT NULL,
  referred_uid   TEXT NOT NULL,
  listing_id     TEXT NOT NULL,
  app            TEXT NOT NULL,
  gross_coins    INTEGER NOT NULL,
  affiliate_coins INTEGER NOT NULL,
  admin_coins    INTEGER NOT NULL,
  status         TEXT NOT NULL,            -- held | settled | reversed
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_aff_comm_affiliate ON affiliate_commissions(affiliate_uid, created_at);

-- commission_rates: add row  (service='affiliate_default', rate=0.10)
```

Money itself flows through the existing **double-entry `wallet_ledger`** — `affiliate_commissions` is a reporting/projection table, not a balance source.

---

## 5. Link & QR pipeline

**URL:** `https://avatok.ai/a/<link_id>` — a Worker route that:

1. Fires `affiliate_link_click` to PostHog (server-side, with link_id, app, listing_id, referrer, country, device class).
2. Sets the **pending-attribution KV** entry for the visitor (cookie/device token), overwriting any previous one (**last link wins**).
3. Redirects: app installed → deep link `avatok://listing/<id>?aff=<link_id>`; else → listing web preview page with store badges (deferred deep link carries `aff` through install via the existing notification-style `deeplink` param + install referrer).

**QR:** generated client-side with the already-bundled `qr_flutter ^4.1.0` from the same URL — center-branded, exportable as PNG for print/stories. No server QR service needed.

**Binding:** at signup (or first authenticated open), the Worker reads the pending KV entry and writes `affiliate_attributions` — permanent for that (user, listing). Self-referral (`referred_uid == affiliate_uid`) and creator-self-promo (`affiliate_uid == listing.creator_id`) are rejected at bind time.

---

## 6. Settlement integration (Q_MONEY)

One new step inside the existing rules engine — **no new queue, no new consumer**:

```
on settle(order):                          # existing entry point, idempotent via settlement_log
  split = computeSplit(order)              # existing creator/platform math — unchanged
  attr  = lookup affiliate_attributions(order.buyer_id, order.listing_id)
  if attr and avaAffiliateEnabled and affiliate.status == 'active':
      aff = min(floor(order.gross * rate('affiliate_default')), split.platform)
      ledger: platform:fees  -aff   →  wallet:<affiliate_uid>  +aff   (type='affiliate_commission', ref=settlement_id)
      insert affiliate_commissions (status follows order: held → settled)
      track('affiliate_commission_earned', ...)
  credit creator + platform as today (platform now receives split.platform - aff)
```

Applies to **AvaLive ticket/entry purchases only** (gifts and live-translation charges are excluded per §2 allowlist), **AvaConsult** listing orders, and **AvaVoice** agent session settlements. Reversal path mirrors it. All inside the same DB transaction as the existing split — instant, atomic, idempotent.

---

## 7. Flutter UI (app/lib/features/affiliate/)

Seven screens, all per-account scoped, all gated by `avaAffiliateEnabled`:

1. **Affiliate Home (landing)** — if not yet an affiliate: value-prop hero ("Earn 10% for life"), single CTA *Become an Affiliate* (auto-runs the L1 email-verify flow if needed). If already an affiliate: the Dashboard (below).
2. **Product Picker** — browse/search promotable listings across the 3 apps with tabs `AvaLive | AvaConsult | AvaVoice`; each card shows price, creator, rating, **estimated commission per sale** (computed live from `commission_rates`). Tap → *Create my link*.
3. **Link Created sheet** — big QR (qr_flutter), copyable short URL, native share sheet, "post to AvaTok feed" shortcut.
4. **Dashboard** — headline cards: *Lifetime earned*, *This month*, *Held (refund window)*, *Referred users*. Below: per-link performance list sorted by earnings.
5. **Link Detail (analytics)** — the "give the affiliate as much information as possible" screen. Funnel viz: **Scans/Clicks → Installs → Signups (bound) → First purchase → Repeat purchases**, each step with counts + conversion %. Charts: clicks & earnings over time (7/30/90d), top sources (qr vs link vs share), top countries. Recent conversions feed (anonymized buyer: "User •••42 purchased — you earned 25 coins"). Pause/resume link.
6. **Subscribers list** — per link: how many users are bound, when, lifetime value each has generated, your cumulative commission from each (anonymized handles).
7. **Earnings & Payout** — ledger view filtered to `affiliate_commission` entries; held vs available; *Withdraw* hands off to the existing AvaPayout flow.

Dashboard numbers come from the Worker (`affiliate_commissions` + attribution counts), **not** from PostHog — PostHog powers the funnel/click analytics via server-proxied HogQL queries (the app never holds a PostHog key).

---

## 8. Worker API (worker/src/routes/affiliate.ts)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/affiliate/register` | L1+ | Create affiliate row + code |
| `GET  /api/affiliate/me` | affiliate | Profile, totals, status |
| `GET  /api/affiliate/listings?app=&q=` | affiliate | Promotable listings (active, public) |
| `POST /api/affiliate/links` | affiliate | Create link for listing (idempotent per pair) |
| `GET  /api/affiliate/links` | affiliate | All links + headline stats |
| `GET  /api/affiliate/links/:id/stats?range=` | affiliate | Funnel + timeseries (D1 + proxied HogQL) |
| `GET  /api/affiliate/links/:id/subscribers` | affiliate | Bound users (anonymized) + LTV |
| `POST /api/affiliate/links/:id/pause` | affiliate | Pause/resume |
| `GET  /a/:linkId` | public | Click → telemetry → KV pending attr → redirect |
| `POST /api/affiliate/bind` | authed | Called on signup/first-open; consumes pending KV |
| Admin: `GET /api/admin/affiliates`, `POST /api/admin/affiliates/:uid/suspend`, rate update via existing `commission_rates` admin path | admin | Program management |

---

## 9. PostHog telemetry plan

All server-side via the existing `track(env, uid, event, app_name, props)` helper (`app_name: 'avaaffiliate'`, plus the standard `trace_id`, `service_name`, `worker: true`). Client-side mirrors only for pure-UI events.

### Event catalog

| Event | When | Key props |
|---|---|---|
| `affiliate_signup_started` / `affiliate_signup_completed` | registration funnel | `identity_level` |
| `affiliate_link_created` | link minted | `link_id, listing_id, app, listing_price` |
| `affiliate_link_click` | `/a/:id` hit | `link_id, affiliate_uid, listing_id, app, source(qr/link/share), referrer, country, device, is_app_installed` |
| `affiliate_qr_generated` / `affiliate_link_shared` | client UI | `link_id, share_channel` |
| `affiliate_attribution_bound` | signup binding | `link_id, referred_uid, source, hours_since_click` |
| `affiliate_attribution_rejected` | self-referral / fraud block | `reason` |
| `affiliate_first_purchase` | referred user's first order on listing | `link_id, gross_coins, app` |
| `affiliate_commission_earned` | every settlement | `link_id, affiliate_uid, referred_uid_hash, listing_id, app, gross_coins, affiliate_coins, admin_coins, is_repeat` |
| `affiliate_commission_reversed` | refund clawback | same + `reason` |
| `affiliate_payout_requested` | withdrawal handoff | `amount_coins` |
| `affiliate_dashboard_viewed` / `affiliate_link_stats_viewed` | engagement | `link_id, range` |
| `affiliate_link_paused` / `resumed` | management | `link_id` |

### Admin dashboards (PostHog)

1. **Program overview** — affiliates (total/active/new), links created, total commission paid vs admin share retained, trend.
2. **Conversion funnel** — click → bind → first purchase → repeat, segmented by app, source (QR vs link), country.
3. **Top affiliates leaderboard** — earnings, conversion rate, fraud-signal flags (bind rate >90% of clicks, self-cluster IPs).
4. **Unit economics** — effective platform margin per app after affiliate cost; alert if `admin_coins/gross` drops below threshold.
5. **Listing performance** — which creator products convert best through affiliates (feeds the Product Picker "trending" sort).

Affiliate-facing funnel charts reuse the same events through the Worker HogQL proxy — one event schema serves both audiences.

---

## 10. Anti-fraud & guardrails

- Self-referral and creator-self-promo blocked at bind (and re-checked at settle).
- Commission only ever moves money **from `platform:fees`** — a bug can shortchange the admin, never mint coins or touch creators. Cap at `platform_cut` enforces this structurally.
- Rate limiting on `/a/:id` (existing Worker limiter); click events deduped per device per hour for funnel integrity (raw clicks still logged).
- 7-day `earning_holds` on commissions = refund-fraud window.
- `affiliates.status='suspended'` instantly stops new bindings and new commissions (existing attributions stay recorded; payouts freezable via admin).
- Kill switch `avaAffiliateEnabled` (routes/config.ts pattern): OFF stops link resolution (redirects still work, no attribution), registration, and the settlement step — without breaking wallets.

---

## 11. Build plan

| Phase | Scope | Est. |
|---|---|---|
| **A1 — Rails** | D1 migrations, `affiliate.ts` routes (register/links/click/bind), KV pending-attr, kill switch, PostHog events | 1 session |
| **A2 — Money** | Settlement-engine step + reversal, `affiliate_commissions`, holds, idempotency tests (staging Q_MONEY) | 1 session |
| **A3 — Flutter** | All 7 screens, QR generation, share flows, per-account scoping | 1–2 sessions |
| **A4 — Analytics** | HogQL proxy endpoints, funnel UI, admin PostHog dashboards, leaderboard | 1 session |
| **A5 — Launch** | Web preview page for non-installed clicks, deferred deep-link verify, fraud checks, flag ON staging → prod | 1 session |

### Resolved items (owner, 2026-06-11)

1. ~~10%-of-gross vs 10%-of-admin-share~~ → **CONFIRMED: 10% of gross** (§2).
2. ~~AvaLive gifts vs tickets~~ → **Ticket/entry only.** Gifts, live-translation costs, and add-ons never earn commission (§2 allowlist).
3. Multi-level referrals (affiliates recruiting affiliates for a cut of *their* commissions, MLM-style): **out of scope permanently unless owner re-opens** — pending owner familiarization (explained in chat 2026-06-11).
4. **Marketing-asset kit → v2, via Gemini "Nano Banana 2" image generation** using the platform's existing Gemini API key (same key as Live Translate). Worker endpoint `POST /api/affiliate/links/:id/assets` generates branded promo images (story/post/banner sizes) from the listing's title, price, creator avatar, and the link QR — affiliate downloads/shares from the Link Detail screen. Gated by its own flag `affiliateAssetKitEnabled`.

---

*Conforms to AVAVERSE-CLOUDFLARE-NATIVE-ARCH (DO/D1/Queues, no Nostr), the rulebook's per-account scoping and kill-switch rules, and reuses: Trust Ladder L1, wallet_ledger double-entry, Q_MONEY settlement_log idempotency, earning_holds, AvaPayout, qr_flutter, PostHog `track()`.*
