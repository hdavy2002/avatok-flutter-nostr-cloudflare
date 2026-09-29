# PLAN — Saathum UPI 3-layer payment confirmation (2026-09-29)

Owner decision (Davy, 2026-09-29): payments to the HDFC account are confirmed by three layers:
1. **Google Messages watcher** — Go daemon on the Mac mini (libgm from mautrix-gmessages) that sees new HDFC SMS via Google Messages web pairing and posts them to the SMS webhook.
2. **SMS companion app** (sms-companion/, Android) — existing forwarder with inbox catch-up + heartbeat.
3. **Manual verification** — when neither automated layer confirms in time, the checkout goes to an admin review queue; admin confirms/rejects by hand.

Both automated layers post to the SAME endpoint `/api/sms/incoming`; the server dedupes by message_hash and (account, bank_reference), so double delivery is safe and the first arrival confirms.

## Problem being fixed
Today `saathum_checkouts.amount_paise = total_rupees*100` (round) and `finalizeSaathumCheckoutByIntent` only confirms when the buyer typed the 12-digit UTR. Owner rejected mandatory UTR. Without it the SMS lands "unmatched" and nothing confirms.

## Core rule: unique amount per open checkout
- On checkout create, reserve `amount_paise = total_rupees*100 - k`, k in 1..199 (i.e. ₹199.01–₹199.99, then ₹198.01–₹198.99 for a ₹200 bill). Buyer always pays slightly LESS; difference shown as "UPI rounding discount".
- k must be unique per receiving_account_key among checkouts that are `awaiting_payment` / `review_pending`, OR expired/cancelled less than 2 h ago (cooldown so late payments never hit a new holder). Enforce in SQL (unique partial index or guarded INSERT … WHERE NOT EXISTS with retry on another k). If all 199 slots taken → 503 `amount_pool_exhausted` (log it).
- Receipt + GST computed on the amount actually collected; receipt line "UPI rounding discount −₹0.xx".
- QR/intent `am=` uses the exact amount_paise.

## Matching (server)
On every accepted SMS receipt (disposition 'accepted', HDFC sender, account suffix OK):
- candidates = saathum_checkouts on same account with amount_paise == SMS amount, status in (awaiting_payment, review_pending), created_at <= SMS received_at_end, SMS received_at <= expires_at + 24h, not yet confirmed.
- exactly 1 candidate → confirm (existing first-writer-wins UPDATE), store bank_reference as utr, payer_vpa; send confirmation email + WhatsApp receipt (existing outbox paths).
- 0 or >1 → SMS stays unmatched and shows in the admin queue.
- Buyer-typed UTR stays as an OPTIONAL fast path (existing /utr endpoint keeps working).
- Bank reference already claimed by another checkout → never double confirm.

## Timing / states (buyer facing)
- Checkout window stays 30 min (CHECKOUT_EXPIRY_MS).
- Buyer taps "I've paid" → `POST /api/saathum/checkout/:id/paid` sets `paid_claimed_at`. Page shows "Waiting for bank to confirm" with a 3-minute countdown, polling status every 3 s.
- If confirmed → "Payment received" + receipt link + "also in your dashboard; sign in with WhatsApp or email".
- If 3 min pass (server-side: now - paid_claimed_at > 180 s and still unconfirmed) → external status `review_pending`, reason `awaiting_bank`. Page: "Our team will verify your payment and send your receipt and booking confirmation on WhatsApp and email." Automatic matching KEEPS running; a late SMS still auto-confirms and notifies.
- Admin WhatsApp alert when a review_pending item is older than 10 min (one alert per item).

## Multi-source ingest
- `/api/sms/incoming` and `/api/sms/heartbeat` accept either device:
  - companion: `HDFC_SMS_DEVICE_ID` / `HDFC_SMS_DEVICE_SECRET` (existing)
  - watcher: `HDFC_SMS_WATCHER_DEVICE_ID` / `HDFC_SMS_WATCHER_DEVICE_SECRET` (new, optional)
- Same canonical HMAC string as today: `[device_id, sender, message, received_at, sim_slot??'', message_hash, nonce, sent_at].join('\n')`, message_hash = sha256(`${sender}|${message}|${received_at}`), timestamps ISO-8601, sent_at within ±5 min.
- New table `sms_source_health(device_id PK, source TEXT, last_heartbeat_at, last_sms_at, last_error)` updated on every heartbeat/incoming.
- Cron (existing scheduled handler): if a configured source's last_heartbeat_at older than 15 min → one WhatsApp alert to owner (ADMIN_ALERT_WHATSAPP env or existing admin number config), re-alert at most hourly; "recovered" message when it comes back.

## API contract (shared by backend, admin UI, confirmation page)
Buyer:
- `POST /api/saathum/checkout` → existing envelope + `pay_amount_paise`, `rounding_discount_paise`.
- `GET /api/saathum/checkout/:id` → envelope fields: `status` ∈ awaiting_payment | confirmed | review_pending | expired, `reason_code` (awaiting_bank | provisioning_failed | …), `pay_amount_paise`, `paid_claimed_at`, `receipt_url`, `confirmed_at`, `upi` {vpa, payee_name, uri}.
- `POST /api/saathum/checkout/:id/paid` → envelope.
- `POST /api/saathum/checkout/:id/utr` → unchanged (optional).
Admin (requires existing admin auth):
- `GET /api/admin/saathum/payments/review` → `{ checkouts: [{checkout_id, uid, buyer_name, whatsapp, email, listing_title, pay_amount_paise, status, reason_code, created_at, paid_claimed_at, utr}], unmatched_sms: [{message_hash, amount_paise, payer_vpa, bank_reference, received_at_ms, source_device}], sources: [{device_id, source, last_heartbeat_at, last_sms_at, healthy}] }`
- `POST /api/admin/saathum/checkout/:id/confirm` body `{ message_hash?: string, note?: string }` → confirms (links SMS if given), logs admin uid, sends same notifications.
- `POST /api/admin/saathum/checkout/:id/reject` body `{ reason: string }` → status cancelled + reason; WhatsApp/email "we could not find your payment, contact support".

## Out of scope
Deploying, applying migrations to prod, turning flags on — owner approves after review. Confirmation page UI is MOCK FIRST (owner rule: mock page for approval, then exact replica).
