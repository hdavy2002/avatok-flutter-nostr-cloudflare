# SPEC 2026-09-26 — Saa Thum event page, checkout, chadhava, UPI payment

Owner: Davy. Coordinator: Opus session. Issue ids (one commit each, coordinator commits):
`SAATHUM-CHECKOUT-API` (A1), `SAATHUM-CHADHAVA` (A2), `SAATHUM-EVENT-PAGE` (B2),
`SAATHUM-CHECKOUT-UI` (B3), `SAATHUM-DASH-DOWNLOAD` (B4).

Mockup the owner approved: `Claude outputs/booking-page-layout.html` (repo root). Match it:
same colours, fonts (Comfortaa headings, Nunito body), white-bordered "sticker" cards, the
Book-now card tokens in `web/src/islands/home/BookNowShelf.css`.

## Owner decisions (2026-09-26) — do not re-litigate
1. "7-day replay" is renamed **"Video download"**. Tooltip on the customer card: *"You can download your video anytime."*
2. New event option **Public / Private**. Tooltip: *"Public: many devotees join the same havan together. Private: a 1:1 session just for your family."* Private = capacity locked to 1.
3. Prasad courier price is **per event**, default **₹99 anywhere in India**, editable in the event form.
4. **Chadhava products** are a catalogue managed in admin (add/edit/delete; image, title, description, price). Seed 2. Every event offers all active products.
5. Checkout steps: **You** (existing email-code sign-in — NO passwords; then verify mobile by the existing SMS OTP, copy says the live link is sent 30 min before by SMS and email; "WhatsApp" wording is NOT used until a WhatsApp sender exists) → **Sankalp** (name, gotra optional, family names optional, wish optional) → **Offerings** (chadhava qty, dakshina for the priest, prasad courier toggle; if prasad on, shipping address REQUIRED; copy: "Prasad ships the same day as the havan. You can change this address any time before it starts.") → **Review** (all lines, then GST 18%, then total; two REQUIRED checkboxes: "I agree to the Terms" link /terms and "I have read the Refund policy" link /refunds) → **Pay** (UPI QR for the exact total + UPI app buttons; customer enters the 12-digit UPI transaction number (UTR); backend verifies against the bank SMS) → **Done** (download PDF receipt; confirmation + receipt emailed).
6. **GST 18% is shown and charged now** on the whole cart (owner's choice). Controlled by a new config flag `saathumGstEnabled` (default `true`) using existing `gstRatePct` (prod = 18).
7. Sankalp details and the shipping address are saved to the user's profile. The address on a booking can be changed until the event starts.
8. Past events in the customer dashboard get a **Download video** button (link the admin pastes on the event after it ends: `attrs.video_download_url`).
9. The event page photo strip: hide the thumbnails row when only one image exists.

## Data (all money in whole rupees; 1 token = ₹1)
### listings.attrs keys (written by A2's admin form, read by everyone)
| key | type | default when absent |
|---|---|---|
| `prasad_courier` | bool | true |
| `prasad_price_rupees` | int 0..5000 | 99 |
| `video_download` | bool (replaces `replay`) | `attrs.replay ?? true` |
| `visibility` | `'public'|'private'` | `'public'` |
| `video_download_url` | https URL ≤500 | none |
| existing: `intention`, `guide_slug`, `deity`, `seo`, `ad_hook` | | |

### Table `saathum_chadhava` (A2; migration `worker/migrations/2026-09-26-saathum-chadhava.sql`)
`id TEXT PK, title TEXT NOT NULL, description TEXT, price_rupees INTEGER NOT NULL CHECK(price_rupees BETWEEN 1 AND 100000), image_url TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`.
Seed (INSERT OR IGNORE): `chadhava-marigold-garland` "Marigold garland" ₹51, image `/assets/saathum-chadhava/marigold-garland.jpg`; `chadhava-havan-samagri` "Havan wood & samagri" ₹101, image `/assets/saathum-chadhava/havan-samagri.jpg`. (The owner will generate those photos; UIs must fall back gracefully when an image 404s.)

### Tables `saathum_checkouts` (+ lines) (A1; migration `worker/migrations/2026-09-26-saathum-checkout.sql`)
A1 designs these. Must store: checkout_id (uuid), uid, listing_id, request_key (unique per uid), frozen quote JSON (lines, subtotal, gst, total), sankalp JSON, prasad bool, address JSON, status, intent_id (hdfc_sms_smoke_intents), utr, commercial order id once provisioned, receipt_no, created/updated/confirmed timestamps, email_sent_at.

## HTTP contract
All JSON. Auth = the existing Clerk bearer (`requireUser` pattern). Errors: `{error, message, field?}`.

### Public (no auth)
- `GET /api/saathum/chadhava` (A2 handler `saathumChadhavaPublic` in `routes/saathum_chadhava.ts`; A1 registers it in index.ts) → `{items:[{id,title,description,price_rupees,image_url}]}` active only, sorted.
- `GET /api/saathum/checkout/config?listing_id=` (A1) → `{listing:{id,title,starts_at,duration_min,price_rupees,prasad_available,prasad_price_rupees,visibility,cover_url,deity,location}, chadhava:[…same as above], dakshina_presets:[21,51,101,251], gst:{enabled,rate_pct}, bookable:bool, reason?:string}`
- `POST /api/saathum/checkout/quote` (A1) body `{listing_id, chadhava:[{id,qty}], dakshina_rupees, prasad:bool}` → `Quote`:
  `{lines:[{kind:'ticket'|'chadhava'|'dakshina'|'prasad', id?:string, label, qty, unit_rupees, amount_rupees}], subtotal_rupees, gst_rate_pct, gst_rupees, total_rupees}`. GST = round(subtotal × rate / 100) to whole rupees (0 when disabled). qty 0..20 per chadhava; dakshina 0..100000 whole rupees; prasad only if the listing has prasad.

### Signed in (A1)
- `POST /api/saathum/checkout` body `{listing_id, request_key(uuid), chadhava, dakshina_rupees, prasad, sankalp:{name, gotra?, family?:string[], wish?}, address?:Address, accept_terms:true, accept_refund:true}` → `{checkout: Checkout}`. Idempotent on (uid, request_key). Saves sankalp + address to the profile.
- `GET /api/saathum/checkout/:id` → `{checkout}` (read also finalises a confirmed payment, idempotently).
- `POST /api/saathum/checkout/:id/utr` body `{utr:'123456789012', expected_reference_revision}` → `{checkout}`.
- `GET /api/saathum/checkout/:id/receipt.pdf` → PDF (only when confirmed).
- `PUT /api/saathum/checkout/:id/address` body `{address:Address}` → `{checkout}`; 409 `address_locked` once the event has started. Also updates the profile address.
- `GET /api/saathum/my-checkouts` → `{items: CheckoutSummary[]}` newest first.

`Address = {name, phone, line1, line2?, city, state, pincode(6 digits)}` (India only).
`Checkout = {checkout_id, listing:{id,title,starts_at,duration_min,cover_url}, status:'awaiting_payment'|'confirmed'|'review_pending'|'expired', quote:Quote, sankalp, prasad:bool, address:Address|null, can_edit_address:bool, payment:{upi_url|null, vpa, payee_name, amount_rupees, expires_at, utr|null, reference_revision, reason_code|null}, receipt_url|null, confirmed_at|null, created_at}`.
`CheckoutSummary = Checkout minus payment.upi_url, plus video_download_url|null (only when confirmed and the event has ended)`.

## Payment rail (A1) — reuse, do not reinvent
The HDFC UPI SMS engine in `worker/src/lib/hdfc_sms_smoke.ts` (intents, `saveReference`, `matchIntent`, `claimStatement`, SMS ingress in `routes/hdfc_sms_payments.ts hdfcSmsIncoming`) is the verification authority. Create intents with the REAL `amount_paise` (= total × 100), per-uid concurrent like `createPublicConcurrentIntent`, bank_reference (UTR) matching mode (payer_vpa NULL). Never match on amount alone. Build the `upi://pay` URL with `am` = the exact total. When an intent is confirmed: provision the seat through the existing commercial path (`freezeCommercialPurchaseQuote` + `provisionFromGatewayPurchase`, gateway `'hdfc_sms'`, ticket only) and mirror a `hdfc_sms_payment_intents` row (status confirmed, bank_reference = UTR, commercial_order_id) so Dashboard 2 billing, admin payments and refunds keep working. Finalise idempotently from BOTH the customer's GET/UTR path AND `hdfcSmsIncoming` after a match. Then send the confirmation email with the PDF receipt (reuse `lib/me_receipt_pdf.ts`, extended with line items + GST + UTR).

## Rules for every agent
- Repo: `/Users/davy/Documents/websites/avaTOK-2-Flutter` on the owner's Mac. Read/edit/typecheck with `mcp__remote-devices__device_bash` (mounted at `$HOME/mnt/avaTOK-2-Flutter`; a Linux VM — `npx tsc` works, `wrangler`/`vitest`/`astro` do NOT). Run vitest with `mcp__remote-devices__Desktop_Commander__start_process` (`cd /Users/davy/Documents/websites/avaTOK-2-Flutter/worker && npx vitest run test/<file>`).
- NEVER: `npm install`, `git add/commit/push`, deploy, `flags.sh`, remote D1 writes, touching files another agent owns. The coordinator commits, migrates and deploys.
- Typecheck: `cd worker && node_modules/.bin/tsc --noEmit -p .` must exit 0. Web: `cd web && node_modules/.bin/tsc --noEmit -p .` must show NO errors in your files (5 pre-existing errors elsewhere are known).
- PostHog telemetry on every new path (web: `capture`/`captureException` from `web/src/lib/analytics.ts`; worker: `track`/`trackException` from `worker/src/hooks.ts`). No silent catch.
- New remote-config keys go in the `PlatformConfig` interface AND `DEFAULTS` in `worker/src/routes/config.ts`.
- Copy: warm, plain English, "Saa Thum" (two words) as the brand, no guaranteed outcomes, prices always from the backend.
- Keep the owner's existing designs; new UI follows the mockup and BookNowShelf.css tokens.
