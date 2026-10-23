# Hello Fraands — Influencer Merch Shop · build spec (2026-10-23)

Owner plan (plain English, approved 2026-10-23): https://claude.ai/artifact/4HoRBv7y836ptfESQg7ma3
Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` §19 (HF-MERCH-*). Design: `Specs/HF-DESIGN-SYSTEM.md` (read the ★ section first).

Influencers upload art, place it on a Printrove T-shirt, set a markup and publish (admin reviews first). Fans buy on the
influencer's public page (web or app), pay from the Hello Fraands rupee wallet OR Cashfree, get email receipt + WhatsApp.
Admin approves each paid order (sees live Printrove cost vs money split) → order goes to Printrove → tracking shows for
admin, influencer and fan. Influencer gets 60% of the markup, withdrawable 7 days after delivery.

This file is the CONTRACT between five parallel packages. If you must change a field name or route, change it HERE in
your commit and say so in your final report.

| Package | Issue id | Branch / worktree | Owns |
|---|---|---|---|
| Server core | `HF-MERCH-CORE-1` | `issue/hf-merch-core-1` · `../wt-hf-merch-core-1` | `worker/**`, migrations, `config.ts`, rulebook §19, telemetry catalog |
| Admin web | `HF-MERCH-ADMIN-1` | `../wt-hf-merch-admin-1` | `web/src/pages/admin/merch/**`, `web/src/islands/admin2/merch/**`, `admin2/nav.ts` |
| Influencer web | `HF-MERCH-CREATOR-WEB-1` | `../wt-hf-merch-creator-web-1` | `web/src/islands/dashboard-hf/merch/**`, the Merch entry in dashboard-hf v3 Shell |
| Fan web + SEO | `HF-MERCH-FAN-WEB-1` | `../wt-hf-merch-fan-web-1` | `web/src/pages/h/**`, `web/src/islands/merch/**`, fan "My orders" in dashboard-hf, sitemaps, `llms.txt`, `robots.txt` |
| App | `HF-MERCH-APP-1` | `../wt-hf-merch-app-1` | `hf-flutter/**` |

Front-end packages never edit `worker/`. Core never edits `web/` or `hf-flutter/`. Shared files you may append to only:
`tool/ship_manifest.json` (your own entry), `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` (core writes the merch section;
others append their events under it).

## 1. Money (owner decision 2026-10-23)

All money is integer **paise** in the server, rupees on screen.

- `base_paise` (per variant) = Printrove print + shipping cost for that catalogue product/colour/size (`pod_catalog.variants_json`
  `base_cost_paise` + print cost for the chosen side, + shipping if Printrove quotes it separately) + `hfMerchBaseBufferRupees*100`.
  Rounded UP to whole rupees. Shown to the influencer per size as "Base price".
- Influencer sets ONE `markup_rupees` per product (≥ `hfMerchMinMarkupRupees`, default 10; ≤ 5000).
- Fan price per size = base + markup (whole rupees, all-in, free delivery in India). No GST line at checkout.
- `influencer_paise` = floor(markup_paise × (10000 − share_bps) / 10000). `platform_paise` = markup_paise − influencer_paise.
  `share_bps` = `hfMerchPlatformShareBps` (default 4000 = 40%).
- Platform ABSORBS Cashfree fee and GST: report-only estimates `cashfree_fee_est_paise` = round(total × `hfMerchCashfreeFeeBps`/10000)
  only when paid by Cashfree (default 350); `gst_est_paise` = round(platform_paise × `hfMerchGstBps`/10000) (default 1800).
  `platform_net_paise` = platform_paise − cashfree_fee_est − gst_est. These NEVER change influencer_paise.
- ALL of the above are frozen into `shop_orders.merch_json` at checkout (snapshot). Later setting changes never touch old orders.
- Approval re-quotes Printrove live: `live_base_paise`. `platform_net_after = platform_net_paise − (live_base − frozen_base)`.
  If `platform_net_after < 0` → approve is refused `409 cost_rose` and admin is offered reject + refund (owner decision).
- Influencer earning is credited to `hf_host_ledger` kind `merch_earning`, `available_at = delivered_at + hfMerchHoldDays` (default 7),
  op_id `hfmerch:earn:<order_id>`. Refunded/cancelled orders earn nothing; a refund after delivery but before `available_at` writes
  the reversing `admin_adjust` row (same pattern as the call-correction reversal in `lib/hf_host_ledger.ts`).
- Platform ledger (new table `hf_platform_ledger`): on approve write `merch_share +platform_paise`, `printrove_cost −base` (payable),
  `cashfree_fee −est` (if cashfree), `gst −est`; on refund write the reversals. op_ids `hfplat:<kind>:<order_id>`, UNIQUE.

Pure maths lives in `worker/src/lib/hf_merch_math.ts` with unit tests (the worked example: base 500, markup 200, cashfree →
fan 700, influencer 120, platform 80, cashfree est 24.50, gst 14.40, net 41.10).

## 2. Flags (declare in `config.ts` PlatformConfig + DEFAULTS + numericKeys — fake-flag rule)

| Key | Default | Meaning |
|---|---|---|
| `hfMerchEnabled` | false | whole feature; off → every merch route 404 `not_enabled`, public page shows no Merch strip |
| `hfMerchCheckoutEnabled` | false | fans can pay; off → checkout 403 `checkout_off`, product page shows "Coming soon" |
| `hfMerchAutoApprove` | false | paid orders skip admin approval |
| `hfMerchProductReview` | true | new/edited art waits for admin review |
| `hfMerchPlatformShareBps` | 4000 | platform share of markup |
| `hfMerchMinMarkupRupees` | 10 | |
| `hfMerchBaseBufferRupees` | 0 | added to Printrove cost in base price |
| `hfMerchCashfreeFeeBps` | 350 | report-only |
| `hfMerchGstBps` | 1800 | report-only |
| `hfMerchHoldDays` | 7 | days after delivery before earning is withdrawable |

`/api/config` exposes them (clients read `hfMerchEnabled` / `hfMerchCheckoutEnabled`).

## 3. Data model (reuse the shop tables so the Printrove pipeline, notifications and admin orders just work)

Migration files (ALTER and CREATE in SEPARATE files — `d1_apply_alters.py` trap):
`worker/migrations/2026-10-23-hf-merch-alters.sql`, `worker/migrations/2026-10-23-hf-merch-tables.sql`.

- `shop_products` + `seller_uid TEXT` (NULL = house product), `review_status TEXT` ('draft','pending','live','rejected','hidden'),
  `review_note TEXT`, `markup_rupees INTEGER`, `design_id TEXT` (studio_designs.id), `deleted_at INTEGER`. Index (seller_uid, review_status).
- `studio_designs` reused for influencer designs; `created_by` = influencer uid.
- `shop_orders` + `seller_uid TEXT`, `pay_method TEXT` ('wallet'|'cashfree'|NULL legacy), `merch_json TEXT` (snapshot §1 + product
  title, colour, size, qty, image, design_id/version, provider_variant_id), `approval_status TEXT` ('pending','approved','rejected'),
  `approved_by`, `approved_at`, `reject_reason`, `cashfree_order_id`, `wallet_op_id`, `refund_status TEXT` ('none','done','pending_manual'),
  `delivered_at INTEGER`, `earning_credited_at INTEGER`. Index (seller_uid, created_at), (approval_status, created_at).
  Merch orders set `receiving_account_key` = 'hf_wallet' | 'cashfree', `confirm_source` = 'wallet' | 'cashfree', and must satisfy the
  existing NOT NULL columns (terms/refund timestamps, expires_at, request_key, amount_paise, gst fields = 0).
- NEW `hf_platform_ledger(id TEXT PK, kind TEXT, amount_paise INTEGER, order_id TEXT, seller_uid TEXT, op_id TEXT UNIQUE, note TEXT, created_at INTEGER)`.
- NEW `hf_merch_addresses(id TEXT PK, uid TEXT, name, phone, line1, line2, city, state, pincode, created_at, updated_at)` (max 5 per uid).
- `hf_host_ledger` gains kind `merch_earning` (check whether `kind` has a CHECK constraint; if it does, write the table-rebuild migration).

**Fulfilment gate:** `pod_fulfil.ts` must never queue/auto-send a merch order whose `approval_status != 'approved'`. Approval is the
only thing that queues it. Delivered status (auto poll or manual) sets `delivered_at` and credits the earning (idempotent).

## 4. Privacy (HF-MERCH-7)

Influencer-facing responses are built by ONE function `maskOrderForSeller(row)` in `lib/hf_merch_mask.ts` with a test that fails if
any of these keys/values appear in its output: phone, email, utr, payer_vpa, payer_reference, cashfree ids, wallet op ids, full line1/line2,
full pincode, buyer uid. Output: `buyer: { firstName, city, state, addressMasked }` e.g. `"H-12 •••••, Dehradun 2480••"`.

## 5. API (worker). Every response `{ ok:true, ... }` or `{ ok:false, error, message }`. All behind `hfMerchEnabled`.

### Influencer (requireUser; caller must be a live host in `hf_hosts`; else 403 `not_a_host`)
- `GET  /api/hf/merch/catalog` → `{ items:[{ id, kind, name, side:['front','back'], printArea:{wIn,hIn}, colours:[{name,hex}], sizes:[{size, basePaise, baseRupees}], mockupUrl? }] }` (T-shirt kinds only at launch)
- `POST /api/hf/merch/art` raw body image (PNG/JPEG ≤ 15 MB), header `x-file-name` (ASCII-safe; see upload-filename trap) → `{ artId, url, width, height, checks:{ok, dpiAtFullWidth, warnings[]} }`; runs moderation
- `POST /api/hf/merch/print-file` raw body PNG (the art clipped to the frame, rendered client-side at 300 DPI, ≤ 5000 px) + header `x-art-id` → `{ printFileId, url, width, height }`
- `POST /api/hf/merch/products` `{ title, description?, catalogId, colours:[name], sizes:[size], side, placement:{frame:'none'|'square'|'circle'|'rect', x, y, w, h, zoom}, artId, printFileId, markupRupees, ownArtConfirmed:true }` → `{ product }` (status 'pending' when review on, else 'live')
- `GET  /api/hf/merch/products` → `{ products:[Product] }`
- `PATCH /api/hf/merch/products/:id` `{ markupRupees?, title?, description?, hidden?:boolean }` → `{ product }` (art/placement change = new product)
- `DELETE /api/hf/merch/products/:id` → `{ ok }`; 409 `open_orders` while an order is not delivered/cancelled
- `GET  /api/hf/merch/orders?status=new|processing|shipped|delivered|cancelled` → `{ orders:[SellerOrder] }`
- `GET  /api/hf/merch/orders/:id` → `{ order: SellerOrder & { timeline:[{at, label}] } }`
- `GET  /api/hf/merch/summary` → `{ products:{live,pending,hidden}, orders:{new,processing,shipped,delivered}, earnings:{pendingPaise, availablePaise, lifetimePaise} }`

`Product` = `{ id, slug, title, description, status:'pending'|'live'|'rejected'|'hidden', reviewNote, imageUrl, mockups:[url], catalogName, colours:[{name,hex}], sizes:[{size, basePaise, pricePaise, youEarnPaise}], markupRupees, soldCount, publicUrl, createdAt }`
`SellerOrder` = `{ id, orderNo, createdAt, status:'new'|'processing'|'shipped'|'delivered'|'cancelled', product:{title, imageUrl, colour, size, qty}, money:{ pricePaise, basePaise, youEarnPaise, availableAt|null, credited:boolean }, buyer:{firstName, city, state, addressMasked}, shipping:{courier, awb, trackingUrl}|null }`

### Public (no auth)
- `GET /api/hf/merch/public/:hostSlug` → `{ host:{slug, displayName, avatarUrl}, products:[PublicProduct] }` (live only)
- `GET /api/hf/merch/public/:hostSlug/:productSlug` → `{ host, product: PublicProduct & { photos:[url], sizeChart?, description } }`; 410 `gone` if hidden/deleted
- `GET /api/hf/merch/pincode/:pin` → `{ ok, deliverable, etaDays|null }` (cached 24 h)
- `GET /api/hf/merch/sitemap` → `{ hosts:[{slug, updatedAt}], products:[{hostSlug, slug, updatedAt, imageUrl, title}] }` (for sitemaps + llms.txt)
`PublicProduct` = `{ id, slug, title, imageUrl, colours:[{name,hex}], sizes:[{size, pricePaise, inStock}], fromPricePaise, url }`

### Fan (requireUser; WhatsApp-verified like other HF purchases)
- `POST /api/hf/merch/checkout` `{ productId, colour, size, qty (1–3), address:{name, phone(10 digits), line1, line2, city, state, pincode}, saveAddress?, acceptTerms:true, acceptRefund:true, method:'wallet'|'cashfree', requestKey }`
  → wallet: `{ ok, orderId, orderNo, status:'paid' }`; `402 insufficient_balance { shortPaise, balancePaise }`
  → cashfree: `{ ok, orderId, orderNo, status:'awaiting_payment', checkoutUrl }` (the avatok.ai checkout host, same as top-up; return lands on `/dashboard/orders?order=<id>` web, deep link `hellofraands://orders/<id>` app)
  Idempotent on `requestKey`. Address lines kept ≤ 50 chars each (Printrove), phone required.
- `GET  /api/hf/merch/my-orders` → `{ orders:[FanOrder] }`; `GET /api/hf/merch/my-orders/:id` → `{ order: FanOrder & {timeline} }`
- `POST /api/hf/merch/my-orders/:id/problem` `{ kind:'wrong'|'damaged', note, photoKey }` (≤ 48 h after delivery)
- `GET  /api/hf/merch/addresses` → `{ addresses:[...] }`; `DELETE /api/hf/merch/addresses/:id`
`FanOrder` = `{ id, orderNo, createdAt, status:'awaiting_payment'|'placed'|'approved'|'printing'|'shipped'|'delivered'|'cancelled'|'refunded', product:{title, imageUrl, colour, size, qty, hostName, hostSlug}, totalPaise, payMethod, shipping:{courier,awb,trackingUrl}|null, receiptUrl|null, canReportProblem }`

### Admin (requireAdmin)
- `GET  /api/admin/merch/orders?tab=pending|printer|shipped|delivered|problem|cancelled` → `{ orders:[AdminOrder], counts }`
- `GET  /api/admin/merch/orders/:id?quote=1` → `{ order: AdminOrder & { liveQuote:{ liveBasePaise, platformNetAfterPaise, costRose:boolean, canApprove:boolean } } }`
- `POST /api/admin/merch/orders/:id/approve` → `{ ok, fulfilment }` ; 409 `cost_rose`
- `POST /api/admin/merch/orders/:id/reject` `{ reason }` → `{ ok, refund:'done'|'pending_manual' }`
- `POST /api/admin/merch/orders/:id/tracking` `{ courier, awb, trackingUrl }` ; `POST .../delivered`
- `GET  /api/admin/merch/products?status=pending|live|hidden|rejected` → `{ products:[Product & {seller:{uid, slug, displayName}}] }`
- `POST /api/admin/merch/products/:id/review` `{ decision:'approve'|'reject'|'hide', note }`
- `GET/PUT /api/admin/merch/settings` → the ten flags of §2 (PUT writes KV overrides in ONE write)
- `GET  /api/admin/merch/platform-wallet?month=YYYY-MM[&format=csv]` → `{ totals:{ sharePaise, cashfeePaise, gstPaise, netPaise, printroveOwedPaise, refundsPaise }, bySeller:[...], rows:[...] }`
`AdminOrder` = full order incl. buyer contact + address, payMethod + reference, merch snapshot, seller, approval, fulfilment status, courier/awb.

## 6. Messages
On paid: fan email receipt (PDF, existing receipt pipeline) + WhatsApp "Order <no> placed"; influencer push + in-app "New order: <title>, size L — you earn ₹X"; owner WhatsApp alert.
On approved / shipped / delivered / rejected+refunded: fan WhatsApp + email + push; influencer push. Use existing senders
(`lib/shop_notify.ts`, `lib/hf_notify.ts`, `lib/hf_push.ts`), brand from `lib/brand`.

## 7. Web (HF design system; Nunito/Comfortaa; no boxy cards; no green UI; no peacocks; phones centred)
- Admin: `/admin/merch` (orders queue, tabs, slide-down card with breakdown + live quote, Approve / Reject), `/admin/merch/products` (review),
  `/admin/merch/settings`, `/admin/merch/wallet`. Nav group "Merch" in `admin2/nav.ts`.
- Influencer: dashboard-hf v3 "Merch" section: Products (grid, status chips, edit markup, hide, delete), "+ New product" 4-step wizard
  (Upload art → Pick shirt → Place art → Price & publish) reusing `web/src/islands/admin2/studio/EditorStep.tsx` + `artAnalysis.ts` logic
  (copy into the merch folder if it is admin-coupled), Orders list with status chips; tap → slides down details (§5 SellerOrder).
- Fan: `/h/<slug>` Merch strip under Book a call; `/h/<slug>/merch/<product>` product page (SSR, photos, colours, sizes, price, pincode
  check, Buy now); checkout island (address → pay wallet / Cashfree → done); "My orders" in the fan dashboard (tracker, tracking link, receipt, report problem).
- SEO: JSON-LD `ProfilePage`+`Person` on `/h/<slug>`, `Product`+`Offer` (INR, InStock, `shippingDetails` free in IN, brand = host name) on product pages;
  canonical + OG/Twitter image; `sitemap-influencers.xml` + `sitemap-merch.xml` from `/api/hf/merch/sitemap` + hosts list, linked from `sitemap.xml`
  index and robots.txt; `llms.txt` section listing influencers + products in plain sentences; 410 for gone products; share button with UTM.

## 8. App (`hf-flutter`)
- Repo `lib/data/repos/merch_repo.dart` + models. Router entries in `lib/demo/router.dart`.
- Influencer: Me → "My merch" card (counts); screen with tabs Products / Orders; "+ New product" wizard (image_picker art, pick shirt,
  drag/pinch placement rendered to PNG at 300 DPI with `dart:ui` `PictureRecorder`, markup with live "you earn"); orders expand in place.
- Fan: influencer page Merch row; product sheet; checkout (address form, wallet or Cashfree via existing `lib/data/cashfree_checkout.dart`);
  Me → "My orders" with tracker.
- Hidden unless `/api/config` `hfMerchEnabled` true. Desi kit widgets (`lib/demo/desi.dart`, `money_kit.dart`). No raw colour literals beyond the
  existing theme tokens in `lib/demo/theme.dart`. No local Flutter toolchain: read your own diff carefully; CI is the compiler.

## 9. Telemetry (PostHog, every surface; include email super-property)
Server: `merch_product_created`, `merch_product_reviewed`, `merch_checkout_started`, `merch_order_paid`, `merch_order_approved`,
`merch_order_rejected`, `merch_order_shipped`, `merch_order_delivered`, `merch_earning_credited`, `merch_cost_rose`; `$exception` on failures.
Web/app: `merch_strip_viewed`, `merch_product_viewed`, `merch_buy_clicked`, `merch_pay_method_chosen`, `merch_studio_step`, `merch_order_opened`.

## 10. Done means (each package)
`npx tsc --noEmit` (worker and/or web), unit tests for maths + masking (core), `python3 scripts/check_brand_literals.py`,
`python3 tool/check_design_guard.py --check all` (app), `python3 tool/check_ship_readiness.py --check all`, a `tool/ship_manifest.json`
entry with success assertions, commits via `scripts/git_safe_commit.py` with explicit paths, one issue id per commit. NO deploys,
NO prod D1 migration, NO flag writes, NO `gh workflow run`. The coordinator lands branches on `main`.

## 11. As built by HF-MERCH-CORE-1 (contract additions and clarifications; none of these removes or renames anything above)

Added routes (all `{ ok, ... }`):
- `GET /api/hf/merch/quote?catalogId&colours=a,b&side=front|back&w=<in>&h=<in>[&sizes=S,M]` (influencer) → `{ sizes:[{size, basePaise, baseRupees}] }`. The live base price while the influencer resizes the print.
- `POST /api/hf/merch/mockup` raw PNG/JPEG/WebP ≤ 3 MB (influencer) → `{ url }`; pass the urls as `mockupUrls[]` (max 6) when creating a product.
- `POST /api/hf/merch/my-orders/:id/problem-photo` raw image ≤ 5 MB (buyer) → `{ photoKey }`; send it as `photoKey` to `.../problem`.
- `POST /api/hf/merch/webhook/cashfree`, and the existing `/api/hf/wallet/topup/webhook/cashfree` URL also settles `shp_` ids. The signature is checked on the raw body, then the order is re-read from Cashfree before anything is confirmed.
- Admin: `POST /api/admin/merch/orders/:id/refund {reason}` (problem order after the printer has it or after delivery), `POST .../refund-done {note?}` (the manual refund was sent), `GET /api/admin/merch/problem-photo?key=`.

Clarifications:
- Admin merch routes are NOT behind `hfMerchEnabled` (the Settings page is how it is switched on). Influencer, public and fan routes 404 `not_enabled` when off; checkout 403 `checkout_off`.
- `printFileId` is the art id (`dsn-xxxxxxxx`); `artId` and `printFileId` must be equal. The art row is a `studio_designs` row with `step='merch'` (hidden from Admin > Studio).
- `placement`: `x`, `y` = inches from the top-left of the shirt's print area; `w`, `h` = the print's size in inches; `zoom` = percent (default 100); `frame` = `none|square|circle|rect`. The print file is rendered at 300 DPI, so its pixel size ≈ `w*300` by `h*300`.
- `/api/config` exposes `hfMerchEnabled`, `hfMerchCheckoutEnabled`, `hfMerchMinMarkupRupees`, `hfMerchHoldDays`. The other six flags (auto-approve, share, buffer, fee, gst, product review) are server-only and are read through `GET /api/admin/merch/settings`.
- Public host and product responses add `checkoutEnabled:boolean`; public product adds `side` and `maxQty`. Fan orders add `refundStatus` (`none|refunding|done|pending_manual`), `rejectReason`, `deepLink`. Checkout (Cashfree) also returns `paymentSessionId`. A retry with the same `requestKey` returns the same order (`status:'paid'` once paid).
- Checkout errors: 400 field errors (`field` set), 402 `insufficient_balance {shortPaise, balancePaise}`, 403 `checkout_off | whatsapp_required | own_product`, 409 `account_closing | wallet_debt | order_closed`, 410 `gone`, 502 `gateway_error`, 503 `payments_unavailable`.
- Approve: 409 `cost_rose` (with `liveQuote`), 503 `quote_unavailable` (send `{force:true}` to approve on the frozen price; never used by auto-approve). `liveQuote` = `{ quoteAvailable, liveBasePaise, platformNetAfterPaise, costRose, canApprove, risePaise, stale, source }`.
- Influencer summary earnings are merch earnings only (`kind='merch_earning'` rows in `hf_host_ledger`; the column has no CHECK, so no table rebuild).
- Platform wallet totals (rupee amounts in paise): `sharePaise` platform share (net of reversals), `cashfeePaise` and `gstPaise` report-only estimates (positive = cost), `printroveOwedPaise` the print partner's amount payable, `refundsPaise` share given back plus any influencer earning the platform absorbed after the hold, `netPaise = sharePaise - cashfeePaise - gstPaise`. Months are IST.
- Settings PUT accepts only the ten keys of section 2, integers within sane ranges, and writes them in ONE KV write.
- A fan problem report: `{ kind:'wrong'|'damaged', note (10-1000 chars), photoKey? }`, once per order, ≤ 48 h after delivery; it appears in the admin `problem` tab.
- Refund on reject: wallet money returns instantly (idempotent op ids); Cashfree uses the refund API with a stable `refund_id`; if that fails the order shows `refund_status='pending_manual'`, the owner is alerted by WhatsApp, and `refund-done` closes it. A cron tick retries stuck refunds. An order that was refunded never earns; a reversal before the 7-day hold removes the earning, after the hold the platform absorbs it.

### 11.1 Review fixes (HF-MERCH-CORE-1, second pass)
- Merch is paid from PURCHASE wallet lots only. Free test credit is never spent on merch; checkout 402 `insufficient_balance` carries `balancePaise` = purchase-only balance and `testCreditNotUsable:true` when test credit exists (clients should say "Free test credit cannot be used for merch").
- `refund` in the reject / refund responses and `refundStatus` on fan orders can now be `pending_gateway`: Cashfree accepted the refund but it has not finished. The tick (and Cashfree's refund webhook) moves it to `done`, or to `pending_manual` with an owner alert if Cashfree reports it failed or lost it. `refund-done` accepts both `pending_manual` and `pending_gateway`. Admin UIs: show `pending_gateway` as "Refund started, waiting for Cashfree".
- Cashfree's fee is kept by Cashfree, so a refund never reverses the `cashfree_fee` ledger row; `printrove_cost` is reversed only for an order that never reached the printer.
- The settings ranges are ONE table (`MERCH_CFG_RANGES`): share 0-9000 bps, min markup 0-5000, base buffer 0-2000, Cashfree fee 0-1000 bps, GST 0-2800 bps, hold days 0-60. The PUT validates against it and the reader clamps to it.
- Placement: for `frame:'square'|'circle'` the frame box is `min(w,h)` square (centred on the print rectangle); `w`,`h` stay the print rectangle's size. Rectangular and `none` frames use `w` x `h`.
- Turning `hfMerchEnabled` off does NOT stop the Cashfree webhook or the cron tick (payment polling, wallet-charge recovery, refunds, earnings).
- A wallet order that was charged but not confirmed (worker died in between) is confirmed by the tick, never expired without a refund. A retry of a Cashfree checkout returns the same checkout link instead of a gateway error.

### 11.2 Price labels (HF-MERCH-PRICE-LABELS-1, owner decision 2026-10-23)
Prices stay ALL-IN (no extra GST line; the platform keeps absorbing GST on its share). The breakdown is shown, and every fan price is labelled "incl. GST & delivery". Example, Premium Oversized tee, black, small print, markup Rs 200: shirt 285 + print 90 + Printrove 5% GST 18.75 = printing (incl. GST) Rs 393.75; shipping Rs 50; base Rs 444 (rounded UP, plus the admin buffer); fan pays Rs 644; you earn Rs 120.
- `GET /api/hf/merch/quote` and `GET /api/hf/merch/catalog`: every size object gains `printingPaise` (garment + print incl. Printrove GST, unrounded paise) and `shippingPaise` (live reference shipping). `basePaise` / `baseRupees` are still ceil(printing + shipping) + buffer. Both responses also gain top-level `shippingPaise` and `bufferPaise`.
- Influencer `Product.sizes[]` (GET / POST / PATCH `/api/hf/merch/products`) gains `printingPaise`, `shippingPaise`, `bufferPaise`, frozen in `merch_json` with the base at creation. printing + shipping + buffer is within one rupee below `basePaise` (the round-up). Products made before this change have no frozen split: `shippingPaise` is today's reference shipping, `bufferPaise` is the product's stored buffer, `printingPaise = basePaise - shippingPaise - bufferPaise` (never negative, so the three add up to the base), and the product carries `breakdownEstimated: true` (false when every size is frozen).
- Public product and public host product list (`/api/hf/merch/public/:host` and `/:host/:product`) gain `priceIncludes: ["printing","gst","delivery"]`; no cost numbers go to fans.
- Pure maths: `splitBase` and `sizeBreakdown` in `lib/hf_merch_math.ts`; the split reuses `computeSizeCosts` (printing = total - shipping).
- Web: studio step 4 table Size | Printing (incl. GST) | Shipping | Base | Your markup | Fan pays (incl. GST & delivery) | You earn (shared `PriceTable`, also in the edit dialog); step 2 shows "From Rs X incl. delivery" for the largest print; admin screens label fan prices "Fan pays (incl. GST & delivery)" and the profit table column reads "Printrove cost (incl. GST)".

### 11.3 Platform is the seller: 5% GST, invoice, cap (HF-MERCH-GST-1, owner decision 2026-10-23; rules HF-MERCH-13 and 14)
Supersedes the old "platform absorbs 18% GST on its share" estimate for NEW orders (old snapshots keep `gstEstPaise` and still read; `merchGstOf` in `lib/hf_merch_math.ts` normalises both).
- **Maths** (`lib/hf_merch_math.ts`, pure): `gstInclusiveSplit(totalPaise, rateBps=500)` -> `{taxablePaise, gstPaise}` (GST = round(total x r / (10000 + r)), taxable = total - GST). Input credit per unit = printing x 5/105 (`printroveInputGstPaise`; printing is the GST-inclusive `printingPaise` frozen with the base). Order money block gains `gstRateBps, taxablePaise, outputGstPaise, inputGstPaise, netGstPaise`; `gstBps` = rate and `gstEstPaise` = net GST for old readers; `platformNetPaise` = platform share - Cashfree estimate - net GST. Example fan Rs 644: GST 3,067 paise, taxable 61,333, credit 1,875, net 1,192.
- **Flags** (config.ts, server-only): `hfMerchGstRateBps` 500, `hfMerchPriceCapRupees` 2500, `hfMerchHsn` "6109" (string), `hfMerchRequireGstin` true. The admin settings PUT accepts all four (rate 0-2800, cap 1-100000, HSN 4-8 digits). `hfMerchGstBps` is legacy and unused by the maths.
- **Cap**: `POST/PATCH /api/hf/merch/products` -> 400 `over_price_cap {field:'markupRupees', maxMarkupRupees, priceCapPaise}` when any size's base + markup > cap. `GET /catalog` and `GET /quote` return top-level `priceCapPaise` and `gstRateBps` and, per size, `maxMarkupRupees` (the product's limit is the smallest across its sizes). The product list/create/patch responses carry `gstRateBps`, `priceCapPaise` and per-size `maxMarkupRupees`. Public host and product responses carry top-level `gstRateBps`. Checkout re-checks: 409 `over_price_cap {maxMarkupRupees, priceCapPaise}`.
- **Checkout guard**: `hfMerchRequireGstin` true and `hfGstin` empty -> `POST /api/hf/merch/checkout` 403 `gst_not_ready` ("Merch checkout opens soon"), after the `checkout_off` check.
- **Documents** (`lib/hf_merch_invoice.ts`, reuses `hf_receipts.ts`): on payment confirmation (and lazily when the fan opens the receipt) one document per order, source `merch_order`. GSTIN set: kind `tax_invoice`, number `<prefix>/I/<short FY>/<seq>`, CGST + SGST half each when the buyer's state code (`lib/gst_states.ts`) equals `hfStateCode`, else IGST; unknown buyer state = intra-state, flagged. No GSTIN: kind `receipt` ("GSTIN: applied for"), split kept in `hf_receipts.data`; setting a GSTIN later makes the next look at the receipt issue the tax invoice. The fan's existing `receiptUrl` (`/api/shop/orders/:id/receipt.pdf`) and the confirmation email attach it; merch PDFs are never cached.
- **Platform ledger**: new orders write `gst_output` (-output) and `gst_input` (+input credit) instead of `gst`; reject reverses them as `refund_gst_output` / `refund_gst_input` (the input credit is kept once Printrove has the order, like `printrove_cost`). Platform wallet totals: `gstPaise` = net GST, plus `outputGstPaise`, `inputGstPaise`.
- **Admin**: `GET /api/admin/merch/gst-report?month=YYYY-MM[&format=csv]` -> `{month, gstinConfigured, supplierStateCode, gstRateBps, hsn, totals:{orders, cancelledOrders, taxablePaise, cgstPaise, sgstPaise, igstPaise, gstCollectedPaise, totalPaise, inputGstPaise, netPayablePaise}, orders:[{orderId, orderNo, date, invoiceNo, buyerState, buyerStateCode, taxablePaise, cgstPaise, sgstPaise, igstPaise, totalPaise, inputGstPaise, cancelled}]}`; cancelled / refunded orders are listed but not in the totals (credit notes are manual for now). ProfitTable "Fees" = net GST + Cashfree. Order detail gains `invoice {number, kind}` and `sellerTax {gstin}`.
- **Influencer GSTIN** (optional, record only): `GET|PUT /api/hf/merch/tax {gstin}` (15-char GSTIN format, empty clears), table `hf_merch_seller_tax` (migration `2026-10-23-hf-merch-gst-tables.sql`, CREATE only; the route tolerates the table being absent). Payouts do not change.
- **Wording**: influencer money is a "design royalty" ("You earn (royalty)"); studio table header "Fan pays (incl. 5% GST & delivery)".
