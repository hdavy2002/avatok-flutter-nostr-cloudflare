# SPEC — Shop Studio + print-on-demand automation (Printrove, swappable) · 2026-10-01

Owner approved on 2026-10-01 ("ok go ahead"). The brand is now **Aum Fe / aumfe.com** — never type it; use `BRAND.*` / `brandUrl()` (`scripts/check_brand_literals.py` enforces).

**Mockup = the contract for every screen.** `Specs/studio-mockup/*.dc.html` (one file per screen; open in a browser or read the markup). Published canvas: https://claude.ai/artifact/PFnpghTVED4LsNVbvvqVbc. Build **exact replicas** inside the real `Admin2` layout (its sidebar, gate, toaster): same sections, order, copy, colours, radii, sizes. The mockup's sidebar is a stand-in for the real `AdminNav`; its CSS uses the same tokens as `Specs/shop-mockup/shop.css` (scope it under `.studio-admin`). Bracketed values like `[FROM PRINTROVE]` are real data from the API at runtime. Plan with the reasoning: `claude/printrove-pod-studio-plan.md` in the project (summary in §9 here).

Screens (mockup file → page):
| Mockup | Page | Issue |
|---|---|---|
| `Main.dc.html` | `/admin/shop/studio` | STUDIO-WEB |
| `Upload.dc.html` | `/admin/shop/studio/new` and `/admin/shop/studio/<id>/upload` | STUDIO-WEB |
| `Product.dc.html` | `/admin/shop/studio/<id>/product` | STUDIO-WEB |
| `Editor.dc.html` | `/admin/shop/studio/<id>/design` | STUDIO-WEB |
| `Photos.dc.html` ("Your photos") | `/admin/shop/studio/<id>/photos` | STUDIO-WEB |
| `Publish.dc.html` | `/admin/shop/studio/<id>/publish` | STUDIO-WEB |
| `Orders.dc.html` | existing `/admin/shop` Orders panel (changed) | FULFIL |
| `PrintPartner.dc.html` | `/admin/shop/partner` | FULFIL |

One page can serve all studio steps (`/admin/shop/studio/[id].astro` with `?step=`) if `_routes.json` (100-rule limit) needs it — `/admin/*` is already routed; do NOT add rules.

## 0. Rules that override everything below

1. **The owner makes the artwork AND the model photos himself** (owner decision 2026-10-01, after the first mockup). No AI image generation anywhere in this feature. AI (Gemini text) is used only for the best-match product suggestion text and the product copy draft.
2. **The print file is what the owner saw.** The editor renders the artwork clipped to the chosen frame (none / rectangle / square / circle) at 300 DPI into a transparent PNG **in the browser** (canvas/OffscreenCanvas), capped at 5000 px per side, and uploads it. That PNG is the ONLY file a print partner ever receives. Never re-render or re-generate it on the server, never ask an image model to redraw it.
3. **Photos are for the shop page only.** The owner uploads his model photos and tags each with the shirt colour it shows. Nothing is ever taken from a photo for printing — printing always uses the Step 3 print file. Plain-shirt pictures (print on a flat shirt per colour + a print close-up) are generated in the browser from the print file, so every sold colour has at least one picture.
4. **Nothing is sent to a print partner until the money is confirmed** (`shop_orders.pay_status='confirmed'`). Sending is idempotent: one `shop_fulfilments` row per order, `reference_number = order_no`, check-before-create at the partner.
5. **All partner talk lives in `worker/src/lib/pod/`.** No Printrove field name outside it. Default provider is `manual` (today's hand workflow) until the owner gives the Printrove login and flips `shopPodProvider`.
6. Secrets (`PRINTROVE_EMAIL`, `PRINTROVE_PASSWORD`) are Worker secrets, never in code, KV, logs, PostHog or the browser. The bearer token is cached in KV `pod:printrove:token` until 1 h before `expires_at`.
7. Repo rules (CLAUDE.md): own worktree + `issue/*` branch; commits via `scripts/git_safe_commit.py "[ISSUE] msg" <paths>`; never `npm install` (symlink node_modules); never deploy, never apply migrations to prod, never set flags, never push — the coordinator lands and deploys. PostHog on every surface, no silent `catch {}`. Every new config key declared in `DEFAULTS` + interface (fake-flag rule). `tool/ship_manifest.json` entry per issue.
8. No tiny fonts (≥13 px), Nunito labels 700–900, never negative letter-spacing.

## 1. Work split

| Issue | Owns (others must not edit) |
|---|---|
| `AUMFE-POD-CORE-1` | `worker/migrations/2026-10-01-aumfe-pod.sql` (ALL new tables §2), `worker/src/lib/pod/*` (types, registry, `printrove.ts`, `manual.ts`, `specs.ts`, `address.ts`), `worker/src/routes/admin2_pod_partner.ts` (export `ADMIN2_POD_PARTNER_ROUTES`), config keys in `worker/src/routes/config.ts`, the route spreads for ALL three new route arrays in `worker/src/routes/admin2.ts` (`ADMIN2_POD_PARTNER_ROUTES`, `ADMIN2_STUDIO_ROUTES`, `ADMIN2_POD_FULFIL_ROUTES`), `scripts/printrove_probe.mjs`, `worker/src/lib/pod/*.test.ts` |
| `AUMFE-POD-STUDIO-API-1` | `worker/src/routes/admin2_studio.ts` (export `ADMIN2_STUDIO_ROUTES`), `worker/src/lib/studio_logic.ts` (+ test) |
| `AUMFE-POD-STUDIO-WEB-1` | `web/src/pages/admin/shop/studio/**`, `web/src/islands/admin2/studio/**`, `web/src/lib/studioApi.ts`, `web/src/lib/printFile.ts` (clip + export), `web/src/lib/composite.ts` (plain-shirt pictures) |
| `AUMFE-POD-FULFIL-1` | `worker/src/routes/admin2_pod_fulfil.ts` (export `ADMIN2_POD_FULFIL_ROUTES`), `worker/src/lib/pod_fulfil.ts` (send + poll + status mapping), the cron hook in `worker/src/index.ts` (one call in `scheduled`), edits to `worker/src/routes/admin2_shop_orders.ts` (money fields in list/detail), `web/src/islands/admin2/shop/OrdersPanel.tsx`, `web/src/pages/admin/shop/partner.astro`, `web/src/islands/admin2/shop/PartnerPanel.tsx`, `web/src/islands/admin2/nav.ts` (+ `AdminNav.tsx` only if needed) — nav adds **Studio** (`/admin/shop/studio`, after Orders, pill "New") and **Print partner** (`/admin/shop/partner`, last in Shop group, pill "New") |

STUDIO-API and FULFIL import from `lib/pod/index.ts` exactly as typed in §3 — CORE builds it in parallel to that text. If a contract must change, ask the coordinator.

## 2. Data model — `worker/migrations/2026-10-01-aumfe-pod.sql` (CORE). CREATE-only, `IF NOT EXISTS`, epoch-ms INTEGER times. Apply command in the header comment (`scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-aumfe-pod.sql`).

```
pod_catalog(provider TEXT, provider_product_id TEXT, kind TEXT,          -- kind: mens_tee|womens_tee|kids_tee|toddler_tee|hoodie|sweatshirt|polo|crop_top|crop_hoodie|other
  name TEXT NOT NULL, category TEXT, variants_json TEXT NOT NULL DEFAULT '[]', -- [{provider_variant_id, colour, colour_hex, size, base_cost_paise, sku?}]
  size_chart_json TEXT, raw_json TEXT, synced_at INTEGER NOT NULL, PRIMARY KEY(provider, provider_product_id))

studio_designs(id TEXT PK 'dsn-'+8hex, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','ready','live','retired')),
  step TEXT NOT NULL DEFAULT 'upload',                                     -- upload|product|design|photos|publish
  art_key TEXT, art_w INTEGER, art_h INTEGER, art_bytes INTEGER, art_mime TEXT, art_checks_json TEXT, art_preview_url TEXT,
  products_json TEXT NOT NULL DEFAULT '[]',                                -- chosen [{kind, provider_product_id, side}]
  placement_json TEXT,                                                     -- see §4 Placement
  print_key TEXT, print_w INTEGER, print_h INTEGER, print_sha256 TEXT, print_preview_url TEXT,
  version INTEGER NOT NULL DEFAULT 1, locked_at INTEGER,                   -- print file locked once published; edits → version+1
  colours_json TEXT NOT NULL DEFAULT '[]',
  copy_json TEXT, prices_json TEXT, product_id TEXT,                       -- shop_products.id after publish
  created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)

studio_photos(id TEXT PK 'sph-'+8hex, design_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('model','flat','closeup')),
  colour TEXT, url TEXT NOT NULL, width INTEGER, height INTEGER, checks_json TEXT, status TEXT NOT NULL DEFAULT 'kept' CHECK(status IN('kept','removed')),
  sort INTEGER NOT NULL DEFAULT 0, is_main INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)   idx(design_id, kind)

pod_listings(product_id TEXT, provider TEXT, design_id TEXT, design_version INTEGER, provider_design_ref TEXT, provider_listing_ref TEXT,
  status TEXT NOT NULL, error TEXT, published_at INTEGER, PRIMARY KEY(product_id, provider))

pod_variant_map(product_id TEXT, colour TEXT, size TEXT, provider TEXT, provider_variant_id TEXT NOT NULL, base_cost_paise INTEGER, sku TEXT,
  active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(product_id, colour, size, provider))

shop_fulfilments(order_id TEXT PK, provider TEXT NOT NULL, reference_number TEXT NOT NULL UNIQUE, provider_order_id TEXT,
  status TEXT NOT NULL CHECK(status IN('queued','sending','sent','printing','shipped','delivered','problem','cancelled')),
  request_json TEXT, last_response_json TEXT, provider_status TEXT, courier TEXT, awb TEXT, tracking_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_polled_at INTEGER, last_error TEXT, sent_by TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)   idx(status, next_attempt_at), idx(status, last_polled_at)

shop_fulfilment_events(id INTEGER PK AUTOINCREMENT, order_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, provider_status TEXT, note TEXT)  idx(order_id, at)
```
R2 keys (private `DIGITAL`): `studio/<design_id>/art-<sha8>.<ext>`, `studio/<design_id>/print-v<version>-<sha8>.png`. Previews (public `BLOBS`, through the existing image CDN helpers): downscaled ≤ 1600 px copies uploaded by the browser alongside. Owner photos and plain-shirt pictures: public `BLOBS` (they go on the shop page).

## 3. `worker/src/lib/pod/` — the swappable boundary (CORE)

```ts
// lib/pod/types.ts
export type PodProviderId = 'manual' | 'printrove';
export type PrintSide = 'front' | 'back';
export type CatalogVariant = { provider_variant_id: string; colour: string; colour_hex: string | null; size: string; base_cost_paise: number | null; sku?: string };
export type CatalogProduct = { provider: PodProviderId; provider_product_id: string; kind: string; name: string; category: string | null;
  variants: CatalogVariant[]; size_chart: Array<{ size: string; chest_in?: number; length_in?: number }> | null };
export type PrintPlacement = { side: PrintSide; width_in: number; height_in: number; top_in: number; left_in: number }; // relative to the print area's top-left
export type ListingInput = { name: string; provider_product_id: string; design_ref: string; placement: PrintPlacement;
  variants: Array<{ provider_variant_id: string; sku: string }> };
export type FulfilmentOrder = { reference_number: string; retail_price_rupees: number;
  customer: { name: string; email: string | null; phone10: string; address1: string; address2: string; address3?: string; city: string; state: string; pincode: string; country: 'India' };
  lines: Array<{ provider_variant_id: string; quantity: number; provider_listing_ref?: string; design_ref?: string; placement?: PrintPlacement }>;
  invoice_url?: string };
export type NormalisedState = 'sent' | 'printing' | 'shipped' | 'delivered' | 'problem' | 'cancelled';
export type NormalisedStatus = { provider_order_id: string; state: NormalisedState; provider_status: string; courier: string | null; awb: string | null;
  tracking_url: string | null; eta_text: string | null; problem: string | null; raw: unknown };
export class PodError extends Error { constructor(public code: 'not_configured'|'auth_failed'|'rejected'|'unavailable'|'not_found', message: string, public detail?: unknown) { super(message); } }

export interface PodProvider {
  id: PodProviderId;
  label: string;                                   // shown in admin
  supportsApi: boolean;                            // manual = false
  testConnection(): Promise<{ ok: boolean; message: string; token_expires_at?: number }>;
  syncCatalog(): Promise<CatalogProduct[]>;
  uploadDesign(file: Uint8Array, name: string): Promise<{ design_ref: string }>;
  createListing(input: ListingInput): Promise<{ listing_ref: string; variant_refs: Record<string, string> }>; // provider_variant_id → listing variant id
  serviceability(pincode: string, weight_g: number): Promise<{ ok: boolean; eta_days: number | null }>;
  findOrderByReference(reference_number: string): Promise<{ provider_order_id: string } | null>;
  createOrder(order: FulfilmentOrder): Promise<{ provider_order_id: string; raw: unknown }>;
  getOrder(provider_order_id: string): Promise<NormalisedStatus>;
}

// lib/pod/index.ts
export function getPodProvider(env: Env, id?: PodProviderId): Promise<PodProvider>; // default: config shopPodProvider
export { PRINT_SPECS, maxSharpInches, fitForProduct } from './specs';
export { splitAddressForPartner, deliveryPhone10 } from './address';
```

`specs.ts` — Printrove KB "How to prepare design files for apparel products" (RGB only, ≥ 300 DPI, max 5000 × 5000 px, PNG/JPEG, transparent edges auto-trimmed, API upload ≤ 15 MB):
```ts
export const PRINT_SPECS = { min_dpi: 300, max_px: 5000, max_upload_bytes: 15 * 1024 * 1024, areas: {
  mens_tee:    { front: [15.6, 19.6], back: [15.6, 19.6], label: "Men's T-shirt" },
  womens_tee:  { front: [11.6, 14.5], back: [11.6, 14.5], label: "Women's T-shirt" },
  kids_tee:    { front: [11.6, 14.5], back: [11.6, 14.5], label: 'Kids T-shirt' },
  toddler_tee: { front: [7, 7.8],     back: [7, 7.8],     label: 'Toddler T-shirt' },
  hoodie:      { front: [12, 10.5],   back: [14, 16],     label: 'Hoodie' },
  sweatshirt:  { front: [11.6, 14.5], back: [11.6, 14.5], label: 'Sweatshirt' },
  polo:        { front: [4, 4],       back: [14, 16],     label: 'Polo T-shirt' },
  crop_top:    { front: [12, 10],     back: [12, 10],     label: 'Crop top' },
  crop_hoodie: { front: [10.6, 10.6], back: [10.6, 10.6], label: 'Crop hoodie' } } } as const; // [w_in, h_in]
export function maxSharpInches(px_w: number, px_h: number): { w: number; h: number };       // px / 300, 1 decimal
export function fitForProduct(px_w: number, px_h: number, kind, side): { full_area_dpi: number; sharp_w_in: number; verdict: 'great'|'good'|'small_only'|'too_small'; note: string };
```
(great ≥ 300 DPI at full area width; good 250–299; small_only = sharp only as a smaller chest print; too_small < 150 at 4 in.) Keep these as data; provider overrides allowed later.

`address.ts`: `splitAddressForPartner(addr)` → `{address1, address2, address3?}` each 3–50 chars on word boundaries from line1 + line2 (+ landmark), never cutting a word unless a single word > 50; returns `{ok:false, reason}` if it cannot fit in 150 chars. `deliveryPhone10(addr.phone, verifiedWhatsAppE164)` → the address phone, else the verified WhatsApp number if it is +91, else null. Unit tests for both.

`printrove.ts`: base `https://api.printrove.com/api/external/`; `POST token {email,password}` → `{access_token, expires_at}`; `GET categories`, `GET categories/{id}`, `GET categories/{id}/products/{pid}`; `POST designs` (multipart `file`) / `POST designs/url {url,name}`; `POST products {name, product_id, design:{front|back:{id, dimensions:{width,height,top,left}}}, variants:[{product_id, sku}], is_plain:false}`; `GET serviceability?country=India&pincode=&weight=&cod=false`; `GET orders?reference_number=`; `POST orders {reference_number, retail_price, customer:{name,email,number,address1,address2,address3,pincode,state,city,country}, order_products:[{variant_id, quantity}], cod:false, invoice_url?}`; `GET orders/{id}`. Lists max 20/page — paginate. **Response shapes and the units of `dimensions` are NOT documented** — write the mapping defensively (look for several plausible keys, keep `raw`), mark every guessed field `// PROBE:` and make `scripts/printrove_probe.mjs` call each endpoint read-only (plus an optional `--create-test-order` flag, off by default) and print the real shapes, so the mapping can be corrected the day the owner gives the login. Map unknown provider statuses to `sent` and keep `provider_status` verbatim. Rate: ≤ 2 req/s, retry 429/5xx with backoff (3 tries).

`manual.ts`: `supportsApi=false`; `createOrder` throws `PodError('not_configured')`; `syncCatalog` returns a built-in catalogue from `PRINT_SPECS` (one product per kind, colours Black/Maroon/Navy/Bottle green/Off-white/White, sizes S–3XL, cost null) so the Studio works before Printrove is connected.

Config keys (CORE, `config.ts` interface + DEFAULTS; strings are allowed): `shopPodProvider: 'manual'` (string, `'manual'|'printrove'`), `shopPodAutoSend: false`, `shopPodPollMinutes: 30` (numericKeys). Prove each with the fake-flag contract (`tool/check_ship_readiness.py --check flags`).

### Partner admin API (CORE) — `ADMIN2_POD_PARTNER_ROUTES`, under `/api/admin/v2/shop/partner/`, `adminGuard`, writes → `admin_audit` + `safeTrack`
- `GET partner` → `{ provider: PodProviderId, providers:[{id,label,supportsApi,configured:boolean}], connection:{ok,message,token_expires_at}|null, auto_send, poll_minutes, catalog:{count, synced_at}, notify_buyer:true, alert_owner:true }` (configured = secrets present; never return secret values).
- `POST partner/test` → `testConnection()` result.
- `POST partner/sync` → syncs catalogue into `pod_catalog`, returns `{count, synced_at}`.
- `PUT partner/settings {provider?, auto_send?, poll_minutes?}` → 409 `not_configured` when selecting printrove without secrets. Writes the KV overrides through the SAME helper `putConfig` uses (one read, one write — never two back-to-back sets).
- `GET catalog?kind=` → `{items: CatalogProduct[]}` from `pod_catalog` (falls back to `manual` built-ins when empty).

## 4. Studio API (STUDIO-API) — `ADMIN2_STUDIO_ROUTES`, under `/api/admin/v2/shop/studio/`, `adminGuard`, writes audited + `safeTrack('admin2_studio_*')`

`Design` JSON = the `studio_designs` row with parsed JSON columns, plus `photos: StudioPhoto[]`, `art_url` (short-lived signed URL to the private original for the editor), `print_url` (signed), `fits` (see product).

- `GET designs?status=` → `{items: DesignCard[], counts}`; `DesignCard = {id, name, status, step, art_preview_url, print_preview_url, products_label, colours, updated_at, product_slug|null}`.
- `POST designs {name}` → `{design}`.
- `GET designs/:id` → `{design}` · `PUT designs/:id {name?, step?, colours?, copy?, prices?}` · `DELETE designs/:id` → status `retired` (never deletes a live product's design).
- `POST designs/:id/art` (raw body, `content-type` image/png|image/jpeg, header `x-file-name` ASCII-safe-encoded per `upload-filename-header-encoding`; ≤ 25 MB) → stores original in DIGITAL, reads width/height from the PNG/JPEG header server-side, records checks `{w,h,bytes,mime, rgb:boolean|null, has_alpha:boolean|null}`; `POST designs/:id/art-preview` (≤ 3 MB webp/png) → BLOBS URL. The browser computes and sends `PUT designs/:id {art_checks: {trimmed_px, soft_edge_pct, dominant_colours:[hex], cmyk_converted}}` (merged into art_checks_json).
- `GET designs/:id/fits` → `{ items:[{kind, label, side, area_in:[w,h], full_area_dpi, sharp_w_in, verdict, note, catalog:{provider_product_id, colours:[{name,hex}], sizes:[], cost_from_paise|null}|null}], best: {kind, side, colours:[names], text} }` — `best.text` from Gemini (`gemini` text via the existing helper used by `admin2_ai.ts`), given dims, verdicts and dominant colours; deterministic fallback text when AI fails. Garment colours "look faded" when contrast(dominant art colour, garment) < 3:1.
- `PUT designs/:id/products {products:[{kind, provider_product_id, side}]}`.
- `PUT designs/:id/placement {placement}` with `placement = {kind, side, shape:'none'|'rect'|'square'|'circle', frame_w_in, frame_h_in, frame_top_in, zoom_pct, nudge_x_in, nudge_y_in, print_w_in, print_h_in, dpi}` — server validates against `PRINT_SPECS` (frame inside the area; dpi ≥ 150 else 400 `too_blurry`).
- `POST designs/:id/print` (raw PNG, ≤ 15 MB, ≤ 5000 px/side, must have alpha) + `POST designs/:id/print-preview` → stores, sets print_key/w/h/sha256, `step='photos'`. 409 `locked` if `locked_at` set and version not bumped (`POST designs/:id/new-version` bumps version, clears locked_at).
- `POST designs/:id/photos` (raw JPG/PNG/WebP ≤ 15 MB; headers `x-kind: model|flat|closeup`, `x-colour`, `x-file-name`) → stores to BLOBS, reads width/height from the header, inserts `studio_photos` with `checks_json = {size_ok (short side ≥ 1200 px), colour_sold (x-colour is one of the design's chosen colours)}`; returns `{photo}`. `PUT photos/:pid {colour?, status?, sort?, is_main?}` recomputes checks. `GET designs/:id` includes `photo_coverage: [{colour, photos:n}]` for every chosen colour.
- `POST designs/:id/copy-ai` → `{name, description, seo_title}` drafted by Gemini from design name + product + colours (no invented fabric facts; use catalog data or a `[FABRIC]` gap).
- `POST designs/:id/publish {collection_id, badge, prices:{[size]:rupees}, slots:[]}` → runs steps in order, each idempotent and resumable, persisting progress in `studio_designs.copy_json.publish_steps`:
  1. `uploadDesign(print file)` → `pod_listings.provider_design_ref` (manual: skipped, ref = design id),
  2. `createListing` per chosen product (manual: skipped),
  3. write `pod_variant_map` rows for every colour × size from the catalogue,
  4. create/update the `shop_products` row through the SAME insert/update helpers `admin2_shop_catalog.ts` uses (status `live`, images = kept photos in sort order with main first (owner photos, then plain-shirt pictures), colours/sizes from the chosen variants, `price_rupees` = lowest size price; per-size prices stored in `prices_json` for display — **shop checkout pricing stays per product as today**, so if sizes differ in price, publish one price = the owner's S–XL price and show the note "2XL/3XL priced the same for now" — do NOT change `shop_logic.ts` in this issue),
  5. slots. Sets `status='live'`, `locked_at`, `product_id`. Returns `{design, steps:[{key, label, status:'done'|'skipped'|'failed', note}]}`; a failed step returns 200 with that step `failed` (retry = call again).

## 5. Web Studio (STUDIO-WEB)

Pages are thin Astro shells (`prerender=false`, `Admin2` layout, noindex) mounting islands under `islands/admin2/studio/`. Replicate each mockup screen exactly; the step pills navigate. Behaviour beyond the mockup:
- **Upload:** file input + drag-drop; client decodes the image (createImageBitmap), computes: has alpha, trimmed transparent edge (bbox of alpha > 8), soft-edge % (alpha 1–254 pixels / non-transparent pixels), 3 dominant colours (k-means on a 64 px thumbnail), CMYK JPEGs → drawn to canvas = converted to RGB. Trims transparent edges before upload. Shows the checks list and "prints sharp up to W × H in" from `maxSharpInches` (mirror the formula client-side).
- **Product:** table from `GET fits`, best-match card, ticks → `PUT products`.
- **Editor:** port the mockup's editor logic (`Editor.dc.html` script) to a real island over the actual artwork image (not the placeholder): shirt SVG, print area from `PRINT_SPECS` for the chosen product/side, frame shapes none/rect/square/circle, frame size, zoom (40–300 %), nudge ½ in, frame height, shirt colour from the chosen colours, front/back, live DPI chip (≥300 Sharp, 200–299 Good, 150–199 OK, <150 blocks "Looks good"). Also allow pointer-drag of the art inside the frame. "Looks good →": `lib/printFile.ts` renders the clipped print at 300 DPI (`px = inches × 300`, both sides ≤ 5000 → scale down and report the real DPI), transparent outside the frame, uploads print + preview, saves placement.
- **Your photos:** multi-file upload (drag-drop), each card with a colour select (the design's chosen colours), size and colour-sold chips, Set as main / Remove, drag to reorder; the coverage panel ("every colour you sell has a photo?") from `photo_coverage`. Plain-shirt pictures: `lib/composite.ts` draws the print file onto the shirt silhouette (same SVG/geometry as the editor) per chosen colour + a print close-up, uploads them as `flat`/`closeup` automatically when the step opens (re-made if the print version changes).
- **Publish:** mockup screen; prices table per size (chest/length/cost from catalogue when present, else `[FROM PRINTROVE]` text); "Publish now" calls publish and renders each returned step with ✓ / ✗ + retry.
- Studio home = `GET designs` cards + counts; "+ New product from my artwork" → `POST designs` → upload step.
- Telemetry (`lib/analytics.ts`): `studio_viewed`, `studio_design_created`, `studio_art_uploaded {w,h,has_alpha}`, `studio_placement_saved {shape,dpi}`, `studio_photo_uploaded {kind, size_ok}`, `studio_published {steps_failed}`; errors via `captureException`.

## 6. Orders: money + Send to production + status sync (FULFIL)

### 6.1 Money state on every order (list + detail) — add to `AdminShopOrder` in `admin2_shop_orders.ts`
`money = { state: 'bank_confirmed'|'owner_confirmed'|'customer_claimed'|'awaiting'|'expired'|'rejected', label, amount_expected_rupees, amount_received_rupees|null, received_at|null, utr_last4|null, payer_vpa_masked|null, matched:'auto'|'manual'|null, buyer_notified_at|null }`:
- `bank_confirmed` = `pay_status='confirmed'` AND `confirm_source='sms_auto'` (the HDFC credit alert matched; amount/time from the matched SMS row via `matched_message_hash`),
- `owner_confirmed` = confirmed by admin (any other confirm_source),
- `customer_claimed` = awaiting/review_pending with `paid_claimed_at` or a UTR,
- `awaiting`, `expired`, `rejected` otherwise. Labels exactly as the mockup ("Paid · bank confirmed ✓", "Paid · confirmed by you ✓", "Customer says paid", "Awaiting payment").
Also `production = { state: 'not_sent'|'queued'|'sending'|'sent'|'printing'|'shipped'|'delivered'|'problem'|'cancelled', provider, provider_order_id, courier, awb, tracking_url, problem, can_send:boolean, send_blocked_reason|null }` from `shop_fulfilments` (+ `fulfil_status`). `can_send` only when money is bank/owner confirmed, not yet sent, and the address splits and a phone10 exists.

### 6.2 `ADMIN2_POD_FULFIL_ROUTES` under `/api/admin/v2/shop/`
- `POST orders/:id/send-to-production {confirm:true}` → `sendOrderToPartner(env, orderId, actorUid)` in `lib/pod_fulfil.ts`: requires money confirmed (409 `not_paid`); first-writer-wins insert `shop_fulfilments(status='sending')` (409 `already_sent` if a row exists and is not `problem`); build `FulfilmentOrder` from the order's frozen `items_json` + `pod_variant_map` (400 `variant_unmapped` naming the line) + `splitAddressForPartner` + `deliveryPhone10`; `findOrderByReference` first (adopt if exists); `createOrder`; on success status `sent`, `shop_orders.fulfil_status='at_printer'`, `printrove_order_ref`, `sent_to_printer_at`, order event, **reuse the existing at-printer notifications** (`notifyShopWhatsApp(...'shop_order_printing')` — exactly what `admin2_shop_orders` `at-printer` does today; extract a shared helper rather than duplicating). On partner error: status `problem`, `last_error`, owner WhatsApp alert (`sendAdminAlert`), 502 with `{error:'partner_error', message}`. With provider `manual`: returns 409 `manual_provider` with message "Place this order in the partner's dashboard, then use 'Sent to Printrove'." (the existing manual buttons stay).
- `POST orders/:id/production/retry`, `POST orders/:id/production/resolve {action:'resend'|'manual'|'cancel'}`.
- `GET orders/:id/production` → `{production, events:[...]}`.
- Auto-send: when `shopPodAutoSend` is true, `confirmShopOrder` is NOT edited; instead the cron picks up confirmed orders with no fulfilment row (paid ≥ 2 min ago) and sends them (≤ 10 per tick).

### 6.3 Status sync — one call from `scheduled` in `index.ts`: `await runPodFulfilmentTick(env, ctx)` (wrapped in try/catch + `trackException`)
Every tick: (a) retry `problem`/`sending` rows whose `next_attempt_at` passed (backoff 5 min → 30 min → 2 h, max 3, then leave for the owner), (b) auto-send per 6.2, (c) poll `sent|printing|shipped` rows whose `last_polled_at` is older than `shopPodPollMinutes` (≤ 20 per tick) via `getOrder`, map `printing → fulfil_status at_printer` (no new message), `shipped → fulfil_status shipped` + courier/AWB/tracking + **reuse the existing shipped notifications** (WhatsApp + email, the same helper path as the admin `shipped` action), `delivered → fulfil_status delivered` + existing delivered message (opens the 48 h report window), `problem → owner alert only`. Every change → `shop_fulfilment_events` + `shop_order_events` + `track('shop_fulfilment_status', {from,to,provider})`. Skips entirely when the provider is `manual`.

### 6.4 Web (FULFIL)
- `OrdersPanel.tsx`: replicate `Orders.dc.html` — KPI tiles (Paid ready to send / Waiting for bank / At Printrove / Shipped this week — extend `GET kpis` in `admin2_shop_orders.ts` accordingly), new tabs, the **Money** column (chip + small line: bank, amount, time, UTR last 4), the **Production** column, the red **Send to production** button (disabled with reason otherwise; confirm dialog naming item/colour/size/address), the money panel and the send panel in the order detail. Keep every existing action (match payment, mark shipped by hand, delivered, cancel, refund).
- `/admin/shop/partner` = `PrintPartner.dc.html` on the partner API.
- `nav.ts`: Studio + Print partner entries as in §1.

## 7. Checks before "done" (each agent, in its worktree)
`cd worker && npx tsc --noEmit` (device_bash works) · `cd web && npx tsc --noEmit -p .` if it runs, else read the diff carefully · `python3 scripts/check_brand_literals.py` · `python3 tool/check_ship_readiness.py --check all` · `python3 tool/check_design_guard.py --check all` · unit tests next to pure logic (vitest runs only on the macOS host via Desktop Commander; device_bash cannot). Report deliberate differences from the mockup.

## 8. Telemetry catalog
Add a "Studio + POD" section to `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` (STUDIO-WEB owns that edit): web events in §5, worker `admin2_studio_*`, `pod_partner_*`, `shop_fulfilment_sent {provider, ms}`, `shop_fulfilment_failed {code}`, `shop_fulfilment_status {from,to}`, `$ai_generation` for the copy and best-match text.

## 9. Why (short)
Printrove's API (docs dated 2021) has token login by email+password, catalogue, design upload, product library, pincode serviceability, orders and order lookup — but **no documented webhooks, no response examples, no cancel**. So: polling, defensive mapping with a probe script, and a `manual` provider that keeps today's flow working. Masters and placements live with us, so moving to another partner = a new adapter + "Move all products" (later issue). Address lines must be 3–50 chars (we allow 200) and a 10-digit phone is required (our checkout makes it optional) — handled in `address.ts`.
