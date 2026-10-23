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
