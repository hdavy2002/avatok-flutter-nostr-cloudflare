# HF-WALLET-TOPUP — add money to the HF wallet through any payment gateway

Issue HF-TOPUP-1. Real money stays OFF until the owner picks a gateway and flips two flags. Nothing here changes the main app's
retired payment rails (`MONEY_IN_DISABLED`, `PERMANENTLY_DISABLED_PAYMENT_FLAGS` are untouched and not consulted).

## What exists
| Piece | Where |
|---|---|
| Flags `hfTopupEnabled` (false), `hfTopupGateway` ("none"), `hfTopupPacks` ("100,200,500,1000"), `hfTopupMinRupees` (50), `hfTopupMaxRupees` (5000) | `worker/src/routes/config.ts` |
| Sanitised reader + "is it live" check (flag on AND gateway chosen AND adapter has keys) | `worker/src/lib/hf_topup_config.ts` |
| Settle / reconcile / expire (the only code that credits a wallet) | `worker/src/lib/hf_topup.ts` |
| Routes | `worker/src/routes/hf_topup.ts` |
| Table `hf_topups` | `worker/migrations/2026-10-09-hf-topups.sql` (DB_META) |
| Web | `/wallet` -> `web/src/islands/wallet/TopupPanel.tsx`, `web/src/lib/hfTopupApi.ts` |

Public `/api/config` gives the browser only `hfTopup: {enabled, gateway, packs, minRupees, maxRupees, testMode}`. `enabled` already
means flag on + gateway chosen + that gateway's keys present. The raw `hfTopup*` flags are not sent.

Supported gateways: `razorpay`, `cashfree`, `paytm` (all INR). Stripe in this codebase is non-INR only, and `hdfc_sms` is the internal
smoke rail, so both are rejected (`hfTopupGateway` falls back to "none"; `flags.sh set` of any other value answers 400).

## API
- `POST /api/hf/wallet/topup {amount}` signed in, header `Idempotency-Key`, 5 per hour per user. Whole rupees between min and max.
  Returns `{topupId, gateway, client_payload, testMode, amountRupees}`; `503 {reason:"topup_unavailable"}` when off.
- `GET /api/hf/wallet/topup/:id` owner only. While the row is still `created` it re-asks the gateway (at most every 4 s) and settles if paid.
- `POST /api/hf/wallet/topup/webhook/<gateway>` signature checked over the RAW body first (401 if bad). Unknown order, wrong amount,
  not-paid-at-gateway, refund events all answer 200 `ignored` (logged) so the gateway does not retry for ever. 503 only when the gateway
  read-back or the wallet is unreachable (a retry helps).
- The existing `POST /api/pay/<gateway>/webhook` also forwards any order whose id starts `hftop_` to the same settler, so either URL works.
- Admin: `GET /api/admin/hf/topups?status=&limit=&offset=`, `POST /api/admin/hf/topups/:id/reconcile` (asks the gateway, settles if paid).
- Cron (existing `scheduled()`): `created` top-ups older than 24 h become `expired`.

## Money safety (why a rupee can only land once)
1. The webhook alone never credits. After the signature and the amount/currency match, `adapter.fetchOrder` must say paid for exactly
   the expected paise; otherwise nothing is credited.
2. The credit is a WalletDO `credit` (type `hf_topup`, app `hf_call`) with op_id `hftop:<id>`, which the DO dedupes. Only after it
   succeeds does the row become `paid`, `credited=1`. A crash in between is healed by the next webhook/poll/reconcile, never doubled.
3. Amounts are whole rupees, 1 token = Rs 1, and are fixed server-side from our own row, never from the browser.
4. Refund webhooks are only recorded (`raw_status='refunded'`) and logged for a person to handle; nothing is debited automatically. [HF-WALLET-EXIT-1] Refunds WE start (hf_refund_requests, HF-PAY-15) debit the wallet once, when the admin-approved refund is consumed; the matching gateway webhook is then only confirmed, never debited again.

## How to switch on a gateway
Do it with TEST keys first. Nothing below is done by code; each step is the owner's.
1. **Secrets** (per adapter, `scripts/cf.sh worker secret put NAME`):
   - Razorpay: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. `rzp_test_` keys = test mode.
   - Cashfree: `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_WEBHOOK_SECRET`, `CASHFREE_ENV` (`sandbox` or `production`), and
     `CASHFREE_RETURN_URL` = `<web origin>/wallet?topup={order_id}`.
   - Paytm: `PAYTM_MID`, `PAYTM_MERCHANT_KEY`, `PAYTM_WEBSITE`, `PAYTM_ENV` (`staging`/`production`), `PAYTM_HOST` if needed, and
     `PAYTM_CALLBACK_URL` = the webhook URL below (the form POST is answered with a redirect back to `/wallet?topup=<id>`).
2. **Migration** (once): `scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-topups.sql`.
3. **Webhook URL** in the gateway dashboard: `<apiOrigin>/api/hf/wallet/topup/webhook/<gateway>` (apiOrigin is `BRAND.apiOrigin`).
   Razorpay events: `payment.captured`, `payment.failed`, `order.paid`. Cashfree: payment success/failed. Use the same secret as step 1.
4. **Flags**: `ALLOW_PROD=1 scripts/flags.sh set hfTopupGateway=<id> hfTopupEnabled=true`. Check `scripts/flags.sh effective`.
5. **Test**: open `/wallet`, the panel shows "Test mode — no real money" when the keys are test keys. Pay Rs 50 with a gateway test
   card/UPI, see the balance rise once, then replay the webhook from the dashboard and confirm it does not rise again.
6. **Go live**: swap to live keys (step 1), re-check the webhook secret, make one small real payment, then
   `GET /api/admin/hf/topups` should show it `paid`, `credited`.
Switch off at any time with `ALLOW_PROD=1 scripts/flags.sh set hfTopupEnabled=false`; in-flight payments still settle through the webhook.

## Adding a fourth gateway later
Write a `GatewayAdapter` (`createOrder` must accept `kind:"wallet_topup"` and echo our order id back as receipt/notes/order id),
register it in `lib/payments/registry.ts`, add its id to `HF_TOPUP_GATEWAYS`, and add one loader to `LOADERS` in `web/src/lib/hfTopupApi.ts`.

## Risks to know before turning it on
- Adapters were written from each gateway's documented contract and never run against a live sandbox (see `lib/payments/types.ts`). The
  test-key run in step 5 is what proves the field names; do not skip it.
- Paytm's hosted-page and Cashfree's modal return paths are the least exercised; Razorpay Checkout is the simplest to verify first.
- GST/invoicing on top-ups is not part of this change. (There is no daily spending limit: HF-PAY-7 was dropped, HF-NOLIMITS-1.)
