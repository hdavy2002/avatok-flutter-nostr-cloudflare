# HF Play Billing runbook (`HF-TOK-PLAY-1`)

Server side of buying HF tokens with Google Play Billing. Owner brief 2026-10-10; spec section 11.5 of the HF Android app spec.
Everything here is dark until `hfTokensEnabled` is switched on. Never type the brand name or domain in code; hosts below come from `Specs/brand.json` (`hosts.api`).

## 1. What was built

| Piece | Where |
|---|---|
| Play API calls for an explicit package id | `worker/src/play.ts`: `verifyPlayProductFor`, `acknowledgeProductFor`, `consumeProductFor`, `listVoidedFor`, `refundOrderFor` (the avaTOK functions are unchanged) |
| Purchase logic, RTDN, refunds, cron | `worker/src/lib/hf_play.ts` |
| Routes + cron entry | `worker/src/routes/hf_tokens_play.ts` (`hfTokensPlayRoute`, `runHfPlayCron`), wired in `worker/src/index.ts` |
| Obfuscated account id to uid map | table `hf_play_accounts`, migration `worker/migrations/2026-10-10-hf-play-accounts.sql` (CREATE only, **not applied yet**) |
| Exported for the EXIT agent | `applyPlayRefund(env, orderId, source, purchaseToken?)` and `refundOrderFor(env, packageId, orderId)` |

## 2. Secrets and config (owner action)

Worker secrets (`scripts/cf.sh worker secret put NAME`):

| Name | Value | Notes |
|---|---|---|
| `PLAY_SERVICE_ACCOUNT_JSON` | already set | The Play API key JSON. Its service account must be invited to the **HF app** in Play Console with at least "View app information", "View financial data" and "Manage orders and subscriptions" (acknowledge, consume, refund, voided purchases). Today it only has "Release to testing tracks" on that app. |
| `HF_PLAY_ACCOUNT_SALT` | new: `openssl rand -base64 32` | HMAC key for the `obfuscatedAccountId`. Min 16 chars. **Back it up and never change it**: every user's account id would change and purchases made under the old id could no longer be matched. Unset = prepare and verify fail closed (503). |
| `HF_RTDN_AUDIENCE` | new: the exact audience string set on the push subscription (section 3, step 5) | Unset = the RTDN route answers 503. |
| `HF_RTDN_PUSH_SA` | new: the push subscription's service-account email | Unset = the RTDN route answers 503. |

Flags (already declared): `hfTokensEnabled` (false), `hfCheckoutProvider` (`google_play`), `hfPricingVersion` (`gp-v1`), `hfPlayPackageId` (`com.hellofraands.app`), `hfTopupConfirmAboveRupees` (1000, returned to the app as `confirmAbovePaise`).
Daily / monthly limits: `hfDailySpendLimitRupees` (2000) / `hfMonthlySpendLimitRupees` (15000), per-user overrides in `hf_spend_limits`.

D1: apply `2026-10-10-hf-play-accounts.sql` with `cf.sh worker d1 execute` (it only CREATEs).

## 3. RTDN setup, step by step

Use the Google Cloud project that owns the Play API service account (the one behind `PLAY_SERVICE_ACCOUNT_JSON`). Below, `<project>` is its id and `<api-host>` is `hosts.api` from `Specs/brand.json`.

1. **Enable Pub/Sub.** Cloud Console, APIs and services, enable "Cloud Pub/Sub API".
2. **Create the topic.** Pub/Sub, Topics, Create topic. Topic id `hf-play-rtdn`, leave "Add a default subscription" off. Full name: `projects/<project>/topics/hf-play-rtdn`.
3. **Let Play publish.** Open the topic, Permissions, Add principal `google-play-developer-notifications@system.gserviceaccount.com`, role **Pub/Sub Publisher**. (Without this Play's "Send test notification" fails.)
4. **Create the push identity.** IAM, Service accounts, create `hf-rtdn-push` (no roles needed). Its email is `hf-rtdn-push@<project>.iam.gserviceaccount.com`: this is `HF_RTDN_PUSH_SA`. Pub/Sub must be allowed to mint tokens for it: on that service account, Permissions, add principal `service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com` with role **Service Account Token Creator** (the console offers to do this when you save the subscription).
5. **Create the push subscription.** Topic `hf-play-rtdn`, Create subscription:
   - Subscription id `hf-play-rtdn-push`, delivery type **Push**.
   - Endpoint URL `https://<api-host>/api/hf/tokens/play/rtdn`.
   - Enable authentication: service account = the one from step 4; **Audience** = the same URL as the endpoint (any exact string works; whatever you type here is `HF_RTDN_AUDIENCE`).
   - Acknowledgement deadline 30 s. Retry policy **Exponential backoff** (minimum 10 s, maximum 600 s). Message retention 7 days. Expiration never.
6. **Set the secrets** `HF_RTDN_AUDIENCE` and `HF_RTDN_PUSH_SA` (section 2), then deploy the worker (owner approval needed for deploys).
7. **Point Play at the topic.** Play Console, select the HF app, **Monetize with Play, Monetization setup**, section "Real-time developer notifications": Topic name `projects/<project>/topics/hf-play-rtdn`. Notification content: choose the option that includes **one-time products** ("All notifications" or "Subscriptions, voided purchases, and all one-time products"). Save.
8. **Test.** Click "Send test notification" in the same section. Expected: the worker logs an RTDN request answered 200 with `ignored: "test"`. A 401 means the audience or service-account email does not match the secrets; a 503 means a secret is missing.
9. **Create the in-app products** (Monetize with Play, Products, In-app products): `hf_tokens_100`, `hf_tokens_200`, `hf_tokens_500`, `hf_tokens_1000`, consumable, active, INR price Rs 100 / 200 / 500 / 1,000. The server only credits product ids that are active in `hf_token_products`.
10. **Invite the service account to the app** (section 2, `PLAY_SERVICE_ACCOUNT_JSON` row). Google can take hours to apply new permissions.

Pub/Sub retries any non-2xx answer. The worker answers 503 only when Play itself is unreachable for a PURCHASED notification; everything else (handled, ignored, unknown order, other package) is 200 so it is never redelivered.

## 4. API contract for the Flutter app

All routes are under `https://<api-host>`; signed-in routes need the normal `Authorization: Bearer <session token>`. Errors are `{error, message}`; show `message` when present.

### 4.1 Packs: `GET /api/hf/tokens/products` (no sign-in)
`{ok, enabled, products:[{productId, tokens, pricingVersion, redemptionPaisePerToken, purchasePaisePerToken}]}`.
Query Play `ProductDetails` for those `productId`s and show **Play's** localized price. Never show a price from this response and never type a price beside the buy button. If `enabled` is false, hide the buy buttons.

### 4.2 Before the Play sheet: `POST /api/hf/tokens/play/prepare {productId}`
- 200: `{ok, obfuscatedAccountId, productId, tokens, confirmAbovePaise, dayRemainingPaise, monthRemainingPaise}`.
  - If the pack's Play price in paise is at or above `confirmAbovePaise` (Rs 1,000 by default), show "Are you sure?" first.
  - Keep `obfuscatedAccountId` for the next step.
- 403 `{error:'limit', message, binding:'day'|'month', resetsAt}`: show `message` ("You've reached today's limit of Rs 2,000. It resets at midnight."), do not open the Play sheet.
- 503 `disabled` / `unconfigured`: purchases are off, show a friendly "not available right now".
- 429: rate limited, retry later.

### 4.3 Launch billing
Start the Play Billing flow for that product with `BillingFlowParams.setObfuscatedAccountId(obfuscatedAccountId)` (do **not** set an obfuscated profile id). The server rejects any purchase whose account id is not the signed-in user's, so skipping this loses the purchase (it is auto-refunded by Google after 3 days).
Do **not** acknowledge or consume on the device: the server does both after crediting.

### 4.4 After Play reports a purchase: `POST /api/hf/tokens/play/verify {productId, purchaseToken}`
Send it as soon as the purchase update arrives with `PurchaseState.PURCHASED`. It is idempotent: calling it again (retry, app restart) returns the same answer and never a second credit.
- 200 `{ok:true, status:'consumed'|'credited', duplicate, orderId, productId, tokens, paidPaise, consumed, balance}`: tokens are credited, show the new balance. `credited` (not yet consumed) is also success: the server finishes acknowledging and consuming by cron.
- 200 `{ok:true, status:'pending', orderId, balance}`: the payment is still processing (cash / delayed method). **Nothing is credited.** Tell the buyer "Payment pending, tokens arrive when it completes", keep the purchase token, and call verify again on the next app start or when Play sends the purchase update. The server also re-checks pending purchases and credits them by itself.
- 200 `{status:'canceled'|'refunded'}`: nothing credited (canceled pending purchase, or already refunded by Google).
- `balance` is `{totalTokens, availableTokens, debtValuePaise, byValue:[{valuePaisePerToken, tokens}]}`. A non-zero `debtValuePaise` means an earlier Google refund covered tokens that were already spent: calls are blocked until the next purchase clears it (it is cleared automatically from the next purchase).
- 400 `unknown_product` / `invalid_purchase` / `bad_token`: do not retry.
- 403 `account_mismatch`: the purchase belongs to a different account (shared phone); do not retry.
- 503 with `retry:true` (`unavailable`, `internal`): temporary, retry with backoff (a few seconds, then on next app start).
- 503 `disabled` / `unconfigured`: keep the purchase token and retry later.

### 4.5 Recovery on start
On every app start, after sign-in: `queryPurchasesAsync(ProductType.INAPP)`. For each purchase in `PURCHASED` state (still unconsumed, so Play still lists it) or `PENDING`, call verify with its product id and purchase token. This recovers a purchase whose verify call never reached the server. Handle `onPurchasesUpdated` with the same code path. A purchase the server has already consumed no longer appears in the list.

### 4.6 What the user sees
Tokens are spent on calls only inside the app (HF-TOK-D7). Balances show tokens; the rupee value per token comes from `byValue`.

## 5. Server behaviour reference

- **Credit rule:** Play `purchases.products.get` on `hfPlayPackageId`; credits only when `purchaseState = 0`, product known and active, `obfuscatedExternalAccountId` equals HMAC-SHA256(uid) keyed by `HF_PLAY_ACCOUNT_SALT`, and the order id is new. `paid_paise` is Play's `priceAmountMicros / 10000` when the currency is INR, else tokens x purchase price.
- **Idempotency:** `hf_play_purchases` has UNIQUE `purchase_token` and `order_id`; the lot is created with ledger op id `hfplay:<orderId>`. The row is written (state `verified`) before the lot and promoted to `credited` after it; the cron resumes any row left in `verified`, so a crash heals without a second lot.
- **Then** acknowledge and consume (state `consumed`). If either fails the credit stands and the cron retries every tick for rows older than 5 minutes.
- **Refund / void** (RTDN `voidedPurchaseNotification` or the voided-purchases sweep, about hourly, cursor in KV `hf_play_void_sweep`): op id `hfvoid:<orderId>`, once. Unspent tokens (reserved included) are removed; the spent part becomes an open debt (`hf_token_debts`). Host earnings are untouched.
- **Cron** (`scheduled()`): (a) retry acknowledge + consume, (b) voided sweep, (c) re-check pending and half-credited purchases. It does no Play calls when there are no purchase rows or no service account. Refunds and acknowledgements continue even if `hfTokensEnabled` is turned off; crediting does not.
- **Note on MONEY_IN_DISABLED:** the old avaTOK Play functions are blocked by `MONEY_IN_DISABLED = true` in `worker/src/money.ts`. The HF "...For" functions deliberately ignore it; HF is gated only by `hfTokensEnabled`.

## 6. First real-money test (owner, after deploy and flag)

1. Apply the migration, set the three secrets, grant the service account, create the products, set up RTDN (section 3) and send the test notification.
2. Install the app from the internal testing link, sign in, buy `hf_tokens_100` (Rs 100) with a **license tester** account first (no charge), then once with real money.
3. Expect: `hf_token_purchase_prepared`, then `hf_token_purchase_verified` with `duplicate=false`, `tokens=100`; a lot of 100 tokens at Rs 0.82; the Play order shows acknowledged and the purchase no longer in `queryPurchases`.
4. Refund the order in Play Console. Expect `hf_token_refund_applied` within seconds (RTDN) or within the hour (sweep), lot revoked, no debt if nothing was spent.

> [HF-TOK-PLAY-2 2026-10-10] The avatok-api Worker is at the 128 text-binding limit, so `HF_PLAY_ACCOUNT_SALT` was NOT set; the account hash key is derived from `HF_PII_KEY` with a fixed label. Never rotate `HF_PII_KEY`. RTDN (`HF_RTDN_AUDIENCE`, `HF_RTDN_PUSH_SA`) is also unset for the same reason; refunds are caught by the hourly voided-purchases sweep until bindings are freed.
