# SPEC — Saa Thum Shop (Hindu T-shirts) · 2026-10-01

Owner approved the layout mockup (v2) on 2026-10-01: **"I need exact replicas built, not an inspired one. What you showed me, this is what I want."**
Reference mockup (self-contained, open in a browser): `Specs/shop-mockup/saathum-shop-mockup.html`.
Readable sources of that mockup: `Specs/shop-mockup/shop.css`, `shop-main.html`, `shop.js`.
Published copy: https://claude.ai/artifact/82U5GyTgJ2XWp3YDxT215v (version 2).

## 0. Rules that override everything below

1. **Exact replica.** Every visible element in the mockup (sizes, colours, radii, borders, shadows, spacing, fonts, copy, order of sections, hover states, breakpoints at 1100/820/640px) is reproduced. Port the CSS from `shop.css` **verbatim** (same values, same class names prefixed `sh-` are fine to keep). Do not "improve", restyle, re-space or re-word. If something in the mockup cannot work with real data, ask the coordinator — never invent.
2. **What is NOT copied from the mockup:** the dark-teal "Mockup views" switcher bar (`.sh-switch`); the simplified `.mk-head` header and `.mk-foot` footer — the real pages use the site's real `SiteHeader folk` / `SiteFooter folk` (with a Shop link and a cart button added, §5.1); the sample data (everything comes from the API). Image placeholders (`.sh-ph` striped boxes) are kept ONLY as the empty-state when a product/collection/hero has no photo uploaded yet; when a photo exists it fills the same box (`object-fit:cover`).
3. **Owner shop rules (2026-10-01):** print-on-demand by **Printrove**; personal T-shirt business sold on the site; **ship pan India only, no international**; **shipping is free** (price includes shipping — never a shipping fee); **GST 18% is ADDED at checkout** on (subtotal − coupon), same math as events (`computeGstRupees`, whole rupees, half-up), rate from config `gstRatePct` / `saathumGstEnabled`; **no returns, exchanges or refunds**, except when we sent the wrong (or damaged) item — reported within 48 h of delivery with a photo → replace or refund by hand (refund UTR entered in admin); the buyer **must tick "I agree to the Terms & Conditions" and "I agree to the Refund policy"** before payment — server rejects without both.
4. Brand: never type the brand name/domain — `BRAND.*`, `brandUrl()` (`scripts/check_brand_literals.py` enforces). Do not touch the baseline.
5. PostHog on every new surface (§9). No silent `catch {}`.
6. Repo rules from CLAUDE.md apply: own worktree, commit with `scripts/git_safe_commit.py "<[ISSUE-ID]> msg" <paths>`, never `npm install`, never deploy, never apply a migration to production, never push. The coordinator lands and deploys.
7. Web speed rule: non-critical things load later (`client:idle` / `client:visible` where the mockup allows; cart button `client:idle`).

## 1. Work split (issue ids — prefix every commit)

| Issue | Owner area | Files it owns (others must not edit) |
|---|---|---|
| `SAATHUM-SHOP-API-CATALOG-1` | worker: schema for ALL shop tables, public catalog API, admin catalog API, slots, settings, coupons | `worker/migrations/2026-10-01-saathum-shop.sql`, `worker/src/lib/shop_logic.ts`, `worker/src/routes/shop.ts`, `worker/src/routes/admin2_shop_catalog.ts`, one line in `worker/src/index.ts` (`/api/shop/` → `shopRoute`), spreads of BOTH `ADMIN2_SHOP_CATALOG_ROUTES` and `ADMIN2_SHOP_ORDER_ROUTES` in `worker/src/routes/admin2.ts` |
| `SAATHUM-SHOP-API-ORDERS-1` | worker: orders, UPI payment integration, notifications, receipts, admin orders API, KPIs, Billing union | `worker/src/routes/shop_orders.ts`, `worker/src/routes/admin2_shop_orders.ts`, `worker/src/lib/shop_orders_logic.ts`, `worker/src/lib/shop_notify.ts`; edits in `saathum_checkout.ts` (matching), `hdfc_sms_payments.ts`, `sms_forwarder.ts`, `saathum_upi3.ts`, `saathum_payment_review.ts`, `whatsapp_notify.ts`, `me_dashboard_data.ts`, `me_dashboard.ts`, `lib/me_receipt_pdf.ts` (only if needed) |
| `SAATHUM-SHOP-WEB-STORE-1` | web: /shop, /shop/all, /shop/c/:slug, /shop/p/:slug, cart drawer, header cart button + Shop link, footer link, wishlist store, SEO/sitemap | `web/src/pages/shop/index.astro`, `all.astro`, `c/[slug].astro`, `p/[slug].astro`, `web/src/islands/shop/*`, `web/src/styles/shop.css`, `web/src/lib/shopCart.ts`, `web/src/lib/shopWish.ts`, `web/src/lib/shopApi.ts`, `web/src/lib/homeNavigation.ts`, `SiteHeader.astro`, SEO files (`lib/seo/policy.ts`, `lib/seo/catalog.ts`, `pages/sitemap-pages.xml.ts`, `scripts/check-seo.mjs`), the telemetry catalog shop section |
| `SAATHUM-SHOP-WEB-CHECKOUT-1` | web: /shop/checkout island, terms + refunds Shop sections | `web/src/pages/shop/checkout.astro`, `web/src/islands/shop-checkout/*`, `web/src/pages/terms.astro`, `web/src/pages/refunds.astro` |
| `SAATHUM-SHOP-ADMIN-1` | web admin: Shop group in admin nav + 6 screens | `web/src/pages/admin/shop/*`, `web/src/islands/admin2/shop/*`, `web/src/islands/admin2/nav.ts`, `AdminNav.tsx` (group heading only) |
| `SAATHUM-SHOP-DASH-1` | web dashboard: My orders, Wishlist, Billing Shop/Event tag | `web/src/pages/dashboard/orders.astro`, `wishlist.astro`, `web/src/islands/dashboard2/shop/*`, `web/src/islands/dashboard2/nav.ts`, `Billing.tsx` (tag + shop detail only) |

Shared contracts below are FIXED. If you need a change, ask the coordinator — the other side is being built in parallel against this text.

## 2. Data model (D1 `DB_META`) — one CREATE-only file, owned by API-CATALOG

`worker/migrations/2026-10-01-saathum-shop.sql` — all `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, header comment with the apply command (`scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-saathum-shop.sql`). Times are epoch ms INTEGER. Money in whole rupees unless named `_paise`.

```
shop_collections(id TEXT PK 'col-'+8hex, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '',
  image_url TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at, updated_at)

shop_products(id TEXT PK 'prd-'+8hex, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, collection_id TEXT,
  description TEXT NOT NULL DEFAULT '', fit TEXT NOT NULL DEFAULT 'Regular' CHECK(fit IN('Regular','Oversized')),
  print_type TEXT NOT NULL DEFAULT 'Big front print', -- 'Chest print'|'Big front print'|'Back print'|'Embroidery'
  audience TEXT NOT NULL DEFAULT 'Adults' CHECK(audience IN('Adults','Kids')),
  price_rupees INTEGER NOT NULL CHECK(price_rupees BETWEEN 1 AND 100000), mrp_rupees INTEGER,
  colours_json TEXT NOT NULL DEFAULT '[]',  -- [{"name":"Black","hex":"#222222"}]
  sizes_json TEXT NOT NULL DEFAULT '[]',    -- ["S","M","L","XL","XXL"] or kids ["2-3Y",...]
  images_json TEXT NOT NULL DEFAULT '[]',   -- [{"url":"https://media…","label":"Front"}] first = card image
  badge TEXT NOT NULL DEFAULT '' CHECK(badge IN('','new','best','sale')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('live','draft','hidden','archived')),
  printrove_ref TEXT, sold_count INTEGER NOT NULL DEFAULT 0, seo_title TEXT, seo_description TEXT,
  archived_at INTEGER, created_at, updated_at)
  idx (status, collection_id), idx (status, created_at)

shop_slots(slot TEXT NOT NULL, product_id TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, until_at INTEGER, PRIMARY KEY(slot, product_id))
  -- slot ∈ 'hero_hotspots','new_arrivals','featured_banner','bestsellers','sale','also_like'

shop_settings(key TEXT PK, value_json TEXT NOT NULL, updated_at INTEGER)
  -- 'hero'   {image_url, eyebrow, title, title_em, lead, cta_label, second_cta_collection, ticks:[...], promise:[{title,sub}x3], hotspots:[{product_id,x,y}]}  (x,y = % of hero)
  -- 'featured_banner' {product_id, eyebrow, title, text, cta_label, image_url}
  -- 'policy' {delivery_text:'5–8 days', report_window_hours:48, print_partner:'Printrove', alerts_whatsapp:true}

shop_coupons(code TEXT PK (UPPERCASE), kind TEXT CHECK(kind IN('pct','flat')), value INTEGER NOT NULL,
  min_order_rupees INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0,
  valid_until INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at, updated_at)

shop_orders(order_id TEXT PK 'shp_'+20hex, order_no TEXT UNIQUE NOT NULL,   -- 'SHP-' + 8 upper hex of order_id
  uid TEXT NOT NULL, request_key TEXT NOT NULL, UNIQUE(uid, request_key),
  items_json TEXT NOT NULL,      -- frozen snapshot [{product_id,slug,name,colour,size,qty,unit_rupees,image_url}]
  subtotal_rupees INTEGER NOT NULL, discount_rupees INTEGER NOT NULL DEFAULT 0, coupon_code TEXT,
  gst_rate_pct INTEGER NOT NULL, gst_rupees INTEGER NOT NULL, total_rupees INTEGER NOT NULL CHECK(total_rupees>0),
  address_json TEXT NOT NULL, contact_name TEXT,
  terms_accepted_at INTEGER NOT NULL, refund_policy_accepted_at INTEGER NOT NULL, refund_policy_version TEXT NOT NULL,
  -- payment (mirrors saathum_checkouts so the UPI rail can match either table)
  pay_status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK(pay_status IN('awaiting_payment','confirmed','review_pending','expired','cancelled')),
  receiving_account_key TEXT NOT NULL, amount_paise INTEGER NOT NULL CHECK(amount_paise>0), rounding_discount_paise INTEGER NOT NULL DEFAULT 0,
  payer_reference TEXT, reference_revision INTEGER NOT NULL DEFAULT 0, reason_code TEXT, utr TEXT, payer_vpa TEXT,
  matched_message_hash TEXT, confirm_source TEXT, paid_claimed_at INTEGER, reviewed_by TEXT, review_note TEXT,
  reviewed_at INTEGER, review_alerted_at INTEGER, receipt_no TEXT, confirmed_at INTEGER, expires_at INTEGER NOT NULL,
  email_sent_at INTEGER,
  -- fulfilment
  fulfil_status TEXT NOT NULL DEFAULT 'new' CHECK(fulfil_status IN('new','at_printer','shipped','delivered','cancelled','refunded')),
  printrove_order_ref TEXT, courier TEXT, awb TEXT, tracking_url TEXT, eta_text TEXT,
  sent_to_printer_at INTEGER, shipped_at INTEGER, delivered_at INTEGER,
  cancel_reason TEXT, refund_utr TEXT, refunded_at INTEGER, problem_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
  UNIQUE partial idx (receiving_account_key, payer_reference) WHERE payer_reference IS NOT NULL
  idx (receiving_account_key, amount_paise, pay_status), idx (uid, created_at), idx (pay_status, fulfil_status, created_at)

shop_order_events(id INTEGER PK AUTOINCREMENT, order_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, note TEXT)
  idx (order_id, at)   -- kinds: created, paid_claimed, confirmed, rejected, at_printer, shipped, delivered, cancelled, refunded, problem_reported
```

Customer-visible order steps (tracker): **Ordered → Paid → Printing → Shipped → Delivered** (Printing = `fulfil_status='at_printer'`).

## 3. Money (pure, `worker/src/lib/shop_logic.ts`, owned by API-CATALOG, imported by API-ORDERS)

```ts
export type ShopCartItem = { product_id: string; colour: string; size: string; qty: number };
export type ShopQuoteLine = { product_id, slug, name, colour, size, qty, unit_rupees, amount_rupees, image_url };
export type ShopQuote = { lines: ShopQuoteLine[]; subtotal_rupees; discount_rupees; coupon_code: string|null;
  taxable_rupees; gst_rate_pct; gst_rupees; shipping_rupees: 0; total_rupees };
export function computeShopQuote(input: { items: ShopCartItem[]; products: Map<string, ProductRow>; coupon: CouponRow|null;
  gstRatePct: number; now: number }): { ok: true; quote: ShopQuote } | { ok: false; error: string; field?: string; line?: number };
```
Rules: 1..20 lines, qty 1..10 each, product must be `status='live'`, colour must be one of the product's colours, size one of its sizes, merge duplicate (product,colour,size). discount: pct → `Math.round(subtotal*value/100)`, flat → `min(value, subtotal-1)`; coupon must be active, not expired, under max_uses, subtotal ≥ min_order (errors `coupon_invalid`, `coupon_expired`, `coupon_min_order`). taxable = subtotal − discount. gst = `Math.round(taxable*rate/100)` (or 0 when `saathumGstEnabled` false). shipping 0 always. total = taxable + gst. Unit tests next to it are welcome (vitest only runs on macOS host).

## 4. HTTP API (contracts both sides build against)

Errors: `{error:"<code>", message:"<human>"}` with 4xx. All responses JSON unless PDF.

### 4.1 Public catalog — `routes/shop.ts` (API-CATALOG), `Cache-Control: public, max-age=60` on GETs

Card shape:
```
ShopCard = { id, slug, name, price_rupees, mrp_rupees|null, off_pct|null, badge:''|'new'|'best'|'sale',
  colours:[{name,hex}], sizes:string[], image_url|null, collection:{slug,name}|null }
```
- `GET /api/shop/home` → `{ hero: {...settings.hero, hotspots:[{x,y,product:ShopCard}]}, collections:[{id,slug,name,blurb,image_url,count}], new_arrivals:ShopCard[≤4], featured_banner:{eyebrow,title,text,cta_label,image_url,product:ShopCard}|null, bestsellers:ShopCard[≤4] }`. Slots with an empty `shop_slots` list fall back: new_arrivals = newest 4 live, bestsellers = top 4 by sold_count.
- `GET /api/shop/products?collection=&colour=&size=&fit=&print=&for=&min=&max=&sort=feat|new|lo|hi|best&tag=new|best|sale&ids=a,b&q=` (multi-value params comma-separated) → `{ items: ShopCard[], total, facets:{ collections:[{slug,name,count}], colours:[{name,hex,count}], sizes:[{size,count}], fits:[{value,count}], prints:[{value,count}], audiences:[{value,count}], price:{min,max} } }`. Facet counts are over ALL live products (as the mockup shows) not the filtered set. `ids=` is used by Wishlist.
- `GET /api/shop/products/:slug` → `{ product: ShopCard & { description, fit, print_type, audience, images:[{url,label}], seo_title, seo_description }, also_like: ShopCard[≤4] }` — 404 `not_found` unless live.
- `POST /api/shop/quote` body `{items:ShopCartItem[], coupon?:string}` → `{quote:ShopQuote}` or 400 with `{error, message, line?}`. Public (cart drawer + checkout summary use it).

### 4.2 Orders — `routes/shop_orders.ts` (API-ORDERS). Signed in (`requireUser`); creation also `requireVerifiedWhatsApp`.

Export `shopOrdersRoute(req, env, p): Promise<Response|null>`; `shopRoute` (catalog) delegates any `/api/shop/orders*`, `/api/shop/my-orders` path to it.

- `POST /api/shop/orders` body `{request_key(uuid), items, coupon?, address:{name,phone?,line1,line2?,city,state,pincode}, accept_terms:true, refund_policy_accepted:true}` → `{order: ShopOrder}`. 400 `terms_required` if either flag not true. Quote recomputed server-side (never trust client prices). Address India only (reuse `validateAddress`), saved to profile (`saveToProfile` pattern). Reserves a unique amount with `reserveUniqueAmount(env,{account, totalRupees, checkoutId: order_id, now, expiresAt})` (503 `amount_pool_exhausted`), `expires_at = now + CHECKOUT_EXPIRY_MS`. Idempotent on (uid, request_key). Rate-limited like events. `refund_policy_version = "shop-refunds-2026-10-01"`.
- `GET /api/shop/orders/:id` → `{order}` (runs reconcile/match like `saathumCheckoutGet`).
- `POST /api/shop/orders/:id/paid`, `POST /api/shop/orders/:id/utr {utr, expected_reference_revision}` — same semantics/errors as the event endpoints.
- `GET /api/shop/orders/:id/receipt.pdf` — confirmed only; `renderSaathumReceiptPdf` with `item:{title:"Shop order SHP-…", startsAt:null}`, lines = items + "Shipping (free)"; cached in R2 `DIGITAL` at `shop-receipts/<uid>/<receipt_no>.pdf`. receipt_no `SS-<year>-<10 hex>`.
- `GET /api/shop/my-orders` → `{items: ShopOrder[]}` (newest first, excluding `pay_status IN('expired','cancelled')` that were never paid).
- `POST /api/shop/orders/:id/problem {message (10..1000), photo_url?}` — only when `fulfil_status='delivered'` and within `policy.report_window_hours`; stores `problem_json`, event `problem_reported`, admin WhatsApp alert. 409 `window_closed`.

```
ShopOrder = { order_id, order_no, status: 'awaiting_payment'|'confirmed'|'review_pending'|'expired',  // external pay status (same rules as events incl. 180 s → review_pending awaiting_bank)
  reason_code|null, fulfil_status, step: 'ordered'|'paid'|'printing'|'shipped'|'delivered'|'cancelled'|'refunded',
  items: ShopQuoteLine[], quote: ShopQuote, address, created_at, confirmed_at|null,
  payment:{upi_url, vpa, payee_name, amount_rupees, amount_paise, expires_at, utr, reference_revision, reason_code},
  upi:{vpa, payee_name, uri}, pay_amount_paise, rounding_discount_paise, paid_claimed_at|null,
  receipt_url|null, shipment:{courier, awb, tracking_url, eta_text, shipped_at, delivered_at}|null,
  timeline:[{kind, at}], can_report_problem:boolean }
```
`payment`/`upi`/`pay_amount_paise`/`rounding_discount_paise`/`paid_claimed_at` have EXACTLY the event `Checkout` semantics so the web can reuse PayStep logic. UPI note text: `"<BRAND.name> shop order"`.

### 4.3 Payment rail integration (API-ORDERS) — must not break events
- `matchSaathumReceipt`: "already claimed" check and candidate search cover `saathum_checkouts` **and** `shop_orders` (same account, `amount_paise`, open status, same time window). Exactly one candidate across both → confirm via the right function; else leave for admin. Write a small dispatcher; keep event behaviour byte-identical.
- Ingest hooks in `hdfc_sms_payments.ts` and `sms_forwarder.ts`: the UTR-waiting lookup and the confirmed-ack lookup also check `shop_orders` (`finalizeShopOrderByIntent`).
- `reserveUniqueAmount` reuse guard: also `NOT EXISTS (shop_orders … pay_status='review_pending')`. `persistAwaitingBank` / `alertStaleReviews` also sweep `shop_orders`.
- `GET /api/admin/saathum/payments/review`: unmatched-SMS filter excludes SMS claimed by shop orders; response gains `shop_orders:[...]` (review_pending/awaiting).
- `confirmShopOrder(env, orderId, ev: ConfirmEvidence)`: first-writer-wins UPDATE; sets receipt_no, `releaseAmount`, `sold_count += qty` per product, coupon `used_count += 1`, event row, `track("shop_order_confirmed")`, email (confirmation + PDF, `enqueueEmail` outboxKey `shop-order-confirmed:<id>`), buyer WhatsApp, owner WhatsApp alert (export the private `alert()` from `saathum_upi3.ts` as `sendAdminAlert`). `rejectShopOrder` mirrors `rejectSaathumCheckout` (soft wording: contact support with the 12-digit UPI reference or a screenshot).
- WhatsApp: extend `NotifyKind` with `shop_order_confirmed | shop_order_rejected | shop_order_printing | shop_order_shipped | shop_order_delivered | shop_order_refunded`; `whatsapp_outbox.listing_id` is NOT NULL → use the literal `'shop'`. Shipped message includes courier, AWB and tracking link; all messages link to `brandUrl('/dashboard/orders')`. Emails for confirmed, shipped, refunded.
- Billing: `me_dashboard_data.ts` PAYMENT_LINES_CTE gets a `UNION ALL` branch for confirmed shop orders; payment rows gain `kind:'event'|'shop'` (events = 'event'), shop rows use `event_title = "Shop order SHP-…"`, `category='shop'`, `category_label='Shop'`, `event_starts_at=null`. `GET /api/me/payments/:id` for a `shp_` id returns `{…, kind:'shop', items, receipt_url:'/api/shop/orders/:id/receipt.pdf', can_request_refund:false}`.

### 4.4 Admin catalog — `routes/admin2_shop_catalog.ts` (API-CATALOG), export `ADMIN2_SHOP_CATALOG_ROUTES: Admin2RouteDef[]`, all under `/api/admin/v2/shop/`, `adminGuard`, every write → `admin_audit` + `safeTrack`
- `GET products?status=live|draft|hidden|archived|all` → `{items:[ShopCard & {status, collection_id, promoted_on:string[], printrove_ref, updated_at}], counts:{all,live,draft,hidden,archived}}`
- `POST products` / `PUT products/:id` body `{name, slug?, collection_id, description, fit, print_type, audience, price_rupees, mrp_rupees?, colours:[{name,hex}], sizes:[], images:[{url,label}], badge, status, printrove_ref?}` → `{product}`. slug auto from name, unique. SEO title/description auto-filled from name/collection/description when empty.
- `DELETE products/:id` → archive (`status='archived'`, `archived_at`), removes from all slots. `POST products/:id/restore` (within 30 days → `draft`).
- `PUT products/:id/promote {slots:string[], badge}` → replaces that product's slot membership.
- `GET collections` → `{items:[{id,slug,name,blurb,image_url,sort,active,count}]}`; `POST collections {name, blurb?, image_url?}`; `PUT collections/:id`; `DELETE collections/:id` (409 `collection_not_empty`); `POST collections/reorder {ids:[]}`.
- `GET slots` → `{slots:{hero_hotspots:[ids], new_arrivals:[...], featured_banner:[...], bestsellers:[...], sale:[...], also_like:[...]}}`; `PUT slots/:slot {product_ids:[]}` (order = sort).
- `GET settings` → `{hero, featured_banner, policy}`; `PUT settings/:key {value}` (key ∈ hero, featured_banner, policy; validated).
- `GET coupons`, `POST coupons`, `PUT coupons/:code`.

### 4.5 Admin orders — `routes/admin2_shop_orders.ts` (API-ORDERS), export `ADMIN2_SHOP_ORDER_ROUTES`
- `GET orders?tab=all|awaiting|to_print|at_printer|shipped|delivered|cancelled&q=&cursor=` → `{items:[AdminShopOrder], next_cursor, counts:{…per tab}}`. Tabs: awaiting = pay_status awaiting/review_pending; to_print = confirmed & new; at_printer; shipped; delivered; cancelled = cancelled/refunded/rejected.
- `GET orders/:id` → `{order: AdminShopOrder & {timeline, problem, sms_candidates:[{message_hash, amount_paise, bank_reference, received_at}]}}`
- `POST orders/:id/confirm-payment {message_hash?, utr?, note?}` · `POST orders/:id/reject-payment {reason}`
- `POST orders/:id/at-printer {printrove_order_ref?}` · `POST orders/:id/shipped {courier, awb, tracking_url?, eta_text?, notify:boolean}` · `POST orders/:id/delivered` · `POST orders/:id/cancel {reason}` · `POST orders/:id/refund {refund_utr(12 digits), note}`
  Illegal transitions → 409 `bad_transition`. Each writes `shop_order_events`, audit, buyer WhatsApp (+email for shipped/refunded) when `notify` true (default true).
- `GET kpis` → `{orders_today, orders_yesterday, revenue_30d_rupees, orders_30d, to_print, to_ship, stale_48h}` (KPI tiles in the mockup: "Orders today +N vs yesterday", "Revenue (30 days) · N orders", "To ship · N older than 48h", "To send to Printrove · paid, not placed yet").
```
AdminShopOrder = { order_id, order_no, created_at, customer:{uid,name,email,phone_masked,city}, items, total_rupees,
  pay_status, payer_reference|null, utr_last4|null, fulfil_status, courier, awb, tracking_url, eta_text }
```

## 5. Web (Astro `web/`)

### 5.1 Header, footer, navigation (WEB-STORE)
- `HOME_HEADER_LINKS`: insert `{ href:'/shop', label:'Shop' }` right after Explore. Footer "Browse" column: add Shop after Explore. Do not remove any existing link (`check-homepage.mjs`).
- Cart button: `.avh-cart` exactly as the mockup (46×46, radius 14, white, 2px `#5a1f14` border, red count badge), placed as its own element in `.avh-bar` **outside** `.avh-right` (which hides ≤1100px) so it shows at every width, left of Dashboard/Sign-in on desktop and left of the burger on phones. It is a tiny `client:idle` island (`islands/shop/CartButton.tsx`) that reads `shopCart` and opens the drawer. The Shop nav link gets `.is-active` styling (red, 3px underline, offset 6px) on /shop pages.
- Cart drawer island (`islands/shop/CartDrawer.tsx`) is mounted once per page by `SiteHeader` next to the button (lazy), identical to the mockup drawer: header "Your cart", the static free-shipping line "🚚 **Free shipping** on every order, pan India", items, qty ±, remove, Subtotal / Shipping Free / GST (18%) / Total (from `POST /api/shop/quote`), "Checkout · Pay by UPI →" (→ `/shop/checkout`), "Keep shopping", empty state. Toast "Added: <name> (<size>)".

### 5.2 Shared web libs (WEB-STORE owns; others import — exact API)
```ts
// web/src/lib/shopCart.ts   localStorage key 'saathum_shop_cart_v1' (try/catch everything)
export type CartLine = { product_id:string; slug:string; name:string; colour:string; colour_hex:string; size:string; qty:number; unit_rupees:number; image_url:string|null };
export function getCart(): CartLine[]; export function cartCount(): number;
export function addToCart(l: CartLine): void;            // merges same product+colour+size, qty cap 10
export function setQty(index:number, qty:number): void;  // qty<1 removes
export function removeLine(index:number): void; export function clearCart(): void;
export function onCartChange(cb:(c:CartLine[])=>void): () => void;   // window event 'shop:cart' + storage event
export function openCart(): void;                        // dispatches 'shop:cart-open'
// web/src/lib/shopWish.ts   key 'saathum_shop_wish_v1' — getWish(): string[] (product ids); toggleWish(id): boolean; onWishChange(cb)
// web/src/lib/shopApi.ts    getHome(), listProducts(params), getProduct(slug), getQuote(items, coupon?) — thin wrappers on request() from lib/apiClient
```

### 5.3 Pages (WEB-STORE) — real `Base` + folk shell exactly like `temples.astro`/`marketplace.astro`, `prerender = false`, fetch with `withDeadline`, `Cache-Control: public, max-age=60, stale-while-revalidate=300`
- `/shop` = mockup "Shop home" view: hero (image from settings; hotspot dots with the white pop card; frosted card with eyebrow/title/em/lead/2 CTAs/ticks; white promise bar with 3 items + "Tap a dot to shop the stack →"), Shop by collection (6-col grid, tiles), New arrivals (4-col cards), Featured banner (red, 2 columns), Bestsellers. Product card markup/behaviour exactly as `card()` in `shop.js` (badge, heart, hover Quick add with default size = 2nd size, title, price, MRP strike, −% pill, colour dots).
- `/shop/all` and `/shop/c/:slug` = mockup "All T-shirts" view: crumb, sticky filter sidebar (Price dual range + Min/Max inputs + label; Collection, Colour with swatches, Size chips, Fit, Print type, For; counts; Clear all), toolbar (count + Sort select), active-filter chips, 3-col grid, empty state. Filters live in the URL query (shareable/crawlable); the island updates results client-side via `listProducts`. ≤1100px: "Filters" button opens the full-screen sheet with "Show results".
- `/shop/p/:slug` = mockup "Product page": crumb, gallery (thumb rail + main, labels Front/Back/Print close-up/On model come from image labels), eyebrow "<Collection> collection", title, price row, tax line "+ 18% GST at checkout · Free shipping, pan India" (rate from config), colour buttons, size chips + "Size guide" modal (table in mockup), error "Please pick a size first.", qty, Add to cart / Buy now (Buy now → add + /shop/checkout), perks (3), pincode check (client-side 6-digit validation; message "✓ Delivers to <pin> in 5–8 days · free shipping"), accordions About this design / Fabric & care / Shipping & returns (mockup text), "You may also like".
- SEO: `/shop`, `/shop/all` in `PUBLIC_EXACT`/catalog + `sitemap-pages`; product pages `content.visibility:'public'` with product SEO title/description and og:image = first photo; add `dynamicCoverage` entries in `check-seo.mjs`; keep `_routes.json` ≤ 100 rules (prefer one `/shop/*` rule).

### 5.4 Checkout (WEB-CHECKOUT) — `/shop/checkout`, noindex, real folk header/footer, island `ShopCheckout`
Visual = mockup "Checkout" view exactly (crumb, step pills `1 · You`, `2 · Delivery address`, `3 · Review`, `4 · Pay with UPI` with done/active states, white panels, sticky Order summary with coupon box, rows Subtotal / Coupon / Shipping Free / GST (18%) / Total and the note "Free shipping, pan India. No returns — wrong item? We replace it or refund you."). Logic reused from `islands/saathum-checkout/*`: `IslandBoundary` + `ClerkIsland`, `checkGate` / `YouStep` sign-in (WhatsApp → email → Google) and the green "WhatsApp … verified" row, address form + `addressFromProfile` (saved address shown as the selected radio card, "+ Use a new address"), request-key/resume pattern (`sshop:request_key`, `?order=<id>` resume), token refresh, PayStep screens (pay → waiting → verifying → notfound/expired → confirmed) rendered with the mockup's pay layout (QR box with Save QR, yellow amount box with "UPI rounding discount −₹N (helps us match your payment)", UPI ID row with Copy, How-to list, "I've paid →", 30-minute note, waiting list with 3 states, 12-digit UTR box). Review step has the two REQUIRED checkboxes with links `/terms#shop` and `/refunds#shop`, and the error "Please agree to the Terms & Conditions and the Refund policy to continue."; order is created (POST /api/shop/orders) when moving from Review to Pay. Done = mockup confirmation (green tick, "Order SHP-… confirmed", "Thank you, <first name>!", text, buttons Track in My orders → `/dashboard/orders`, Download receipt (PDF), Keep shopping) and clears the cart. Empty cart state as mockup.
- `terms.astro` + `refunds.astro`: add a numbered section `id="shop"` "Shop orders (T-shirts)" with toc entry, renumber following sections, bump `updated`. Content (plain, no entity names, emails as "support (@) {BRAND.domain}"): printed to order by our print partner; India only; free shipping; GST 18% added at checkout; no returns, exchanges or cancellations once paid (printing starts); wrong or damaged item → tell us within 48 hours of delivery with a photo from My orders ("Wrong item? Report it") or support → replacement or full refund to the paying UPI account, sent by hand with the refund UTR; delivery usually 5–8 days, courier delays possible. Also add the missing `charawa` toc entry in refunds.

### 5.5 Admin (ADMIN) — inside the real `Admin2` layout (its sidebar, gate, toaster)
- Nav: add a **Shop** group to `ADMIN_NAV` (heading "SHOP" like the mockup) with: Orders `/admin/shop` (badge "N to print" from kpis), Products `/admin/shop/products`, Categories `/admin/shop/collections`, Promote to cards `/admin/shop/promote`, Coupons `/admin/shop/coupons`, Shop settings `/admin/shop/settings`. Render the group heading in `AdminNav` (sidebar + phone More sheet). Lucide icons.
- Each page's content = the mockup "Admin: Shop" view exactly: title "Shop" + subtitle + red "+ Add product"; 4 KPI tiles; then the panel for that page (Orders tabs + table with per-status action buttons; Products tabs + table with Edit/Promote/Delete; Categories panel with reorder handle, Edit/Delete, add box; Promote slot cards; Coupons table; Settings form). Modals exactly as mockup: Mark shipped (courier select of Printrove couriers, AWB, tracking link, expected delivery, "Send tracking on WhatsApp + email", Cancel / Mark shipped), Match payment (UTR / pick SMS candidate, Confirm payment, soft-reject note), Delete product (archive 30 days text), Promote (slot checkboxes, badge, show until), Add/Edit product (fields per mockup + photo drop zone using `uploadCover`, colours editor with hex, sizes, Printrove product/design ID, status). Port the mockup CSS scoped under `.shop-admin` so it looks identical inside the admin shell. Add editors for the shop-home hero (photo, texts, hotspot positions) and featured banner as cards on the Promote page in the same slot-card style. Also "Sent to Printrove" (`at-printer`), "Mark delivered", Cancel, Refund (UTR) actions. Order row click opens a detail drawer (timeline, address, items, problem report).

### 5.6 Customer dashboard (DASH) — inside the real `Dashboard2` layout
- `DASH_NAV`: add **My orders** `/dashboard/orders` (after Past events, with the gold "New" pill) and **Wishlist** `/dashboard/wishlist` (after My orders). Keep everything else.
- `/dashboard/orders` = mockup "Customer: My orders": title, subtitle, red "Shop again"; order cards (order no, "Placed <date> · ₹<total> paid by UPI", status chip colours per mockup, item chips, 5-step tracker with AWB under Shipped, buttons Track parcel (<courier>) → tracking_url, Receipt PDF, "Wrong item? Report it" (only `can_report_problem`; modal: message + optional photo via `/upload/public`), Need help? → `/contact`). Empty state "No shop orders yet" + Browse T-shirts.
- `/dashboard/wishlist`: grid of the same product cards for `getWish()` ids (`listProducts({ids})`), empty state.
- `Billing.tsx`: add the type tag (`.sh-bill-src` red "SHOP" / teal "EVENT") on each row from `kind`; shop rows' detail shows items + receipt; no refund-request button for shop.

## 6. Order of landing (coordinator)
1 API-CATALOG → 2 API-ORDERS → 3 WEB-STORE → 4 WEB-CHECKOUT → 5 ADMIN → 6 DASH. Then production: D1 migration, worker deploy, web deploy — only after the owner says so.

## 7. Checks each agent runs before saying "done"
- worker: `cd worker && npx tsc --noEmit` (device_bash works) — zero new errors.
- web: `cd web && npx tsc --noEmit -p .` if it runs; at minimum read your diff for type errors; `python3 scripts/check_brand_literals.py` from repo root.
- `python3 tool/check_ship_readiness.py --check all` and `python3 tool/check_design_guard.py --check all`.
- Visual: open the mockup and your page side by side at 1440 and 390 px (Playwright or the coordinator will do it). Report any deliberate difference.

## 8. Telemetry (PostHog — catalog section added by WEB-STORE in `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md`)
Web (`capture` from `lib/analytics.ts`): `shop_home_viewed`, `shop_list_viewed {filters}`, `shop_filter_changed {group,value}`, `shop_product_viewed {product_id}`, `shop_add_to_cart {product_id,size,colour,qty,source:'card'|'pdp'|'buy_now'}`, `shop_cart_opened {count}`, `shop_wish_toggled {product_id,on}`, `shop_checkout_step {step}`, `shop_checkout_terms_blocked`, `shop_order_created {order_id,total}`, `shop_pay_paid_claimed`, `shop_pay_utr`, `shop_order_confirmed_seen`, `dash_orders_viewed`, `dash_order_problem_reported`, `admin2_shop_*` (product_saved/deleted/promoted, order_status_changed, payment_confirmed). Worker (`track`): `shop_order_created`, `shop_order_confirmed {via}`, `shop_order_rejected`, `shop_order_status_changed {from,to}`, `shop_problem_reported`. Errors via `captureException` / `trackException`.
