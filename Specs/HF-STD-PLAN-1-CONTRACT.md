# HF-STD-PLAN-1 — Standard calling plan + rupee wallet (contract)

Owner decision 2026-10-11. Issue id for every commit: `[HF-STD-PLAN-1]`.
Plan doc (approved): project doc `claude/hello-fraands-standard-plan-rupee-wallet-plan.md`.

## The rules

1. **No tokens, no coins anywhere a person can see.** Customers top up money; calls deduct rupees. All balances,
   charges, transactions, refunds and host earnings are shown as rupees with two decimals and Indian grouping:
   `₹101.69`, `₹120.00`, `₹1,016.95`. No token packs, token icons or conversion text in active customer flows.
2. **Top-up (Google Play, GST included in the price).** wallet credit = paid ÷ 1.18, rounded half up to the paisa;
   GST = paid − credit. ₹120 → GST ₹18.31, wallet ₹101.69. ₹118 → ₹18.00 / ₹100.00. Packs: ₹120 → ₹101.69,
   ₹240 → ₹203.39, ₹600 → ₹508.47, ₹1,200 → ₹1,016.95. Never ₹102 for ₹120; never "18% off" the total.
   Before checkout show **Total payment · GST included · Added to wallet**; the success record and receipt show the same three.
   Client formula when Play's own price differs from the catalogue: `wallet = (2*paid*10000 + d) ~/ (2*d)` with
   `d = 10000 + gstBps` (integer paise, half up), `gst = paid - wallet`. `gstBps` comes from `/api/hf/tokens/products`
   or `/api/config` → `hfStdPlan.gstBps` (1800). Credit happens only on the server after Play verification, once per order.
3. **Standard plan — one rate for every host** (hosts no longer set prices). Progressive per connected second:
   first 30 min ₹3.99/min, next 30 min ₹3.50/min, after 60 min ₹3.25/min. Only time after a threshold gets the lower
   rate. 30 min ₹119.70 · 60 min ₹224.70 · 90 min ₹322.20 · 120 min ₹419.70. Charged per second (prorated), the cumulative
   total rounded once. The product has no advertised duration limit: a call runs until hang-up or until the wallet is used up
   (spoken "one minute left" warning first). A 24-hour server ceiling is an operational failsafe, not a customer plan limit.
   Starting needs 2 minutes = ₹7.98.
4. **Host earns ₹2.00 per connected minute** throughout (prorated per second, floored to the paisa). Hosts see only
   their rupee earnings and payout status. **Admin only:** estimated phone cost ₹1/min (two legs × ₹0.50), estimated
   platform retention (₹0.99 / ₹0.50 / ₹0.25 per minute by band) = before other expenses, NOT profit; actual Vobiz cost when known.
   60-min call: customer ₹224.70 · host ₹120.00 · phone est. ₹60.00 · platform est. ₹44.70.
5. Billing starts only when both people are connected; ringing, declines, failures and waiting are ₹0.
6. Call-charge corrections (billing error) go back to the wallet, traceable to the call, once per call; the host's
   earning for that call is reversed only while it is still inside the 7-day hold, else the platform absorbs it.
   Top-up refunds (through Google) are a different thing and remove the unspent wallet money of that purchase.
7. GST: the monthly "platform share" tax invoice is switched off while top-ups are GST-inclusive (no second GST on
   spending). No GSTIN or registration details are invented. The GSTIN goes on receipts once the owner has the number.

## Config (server, `worker/src/routes/config.ts`)

`hfStdPlanEnabled` (**false by default; explicit rollout only**), `hfStdTier1PaisePerMin` 399, `hfStdTier2PaisePerMin` 350, `hfStdTier3PaisePerMin` 325,
`hfStdTier1EndMin` 30, `hfStdTier2EndMin` 60, `hfStdHostPaisePerMin` 200, `hfStdPhoneCostPaisePerMin` 100,
`hfTopupGstBps` 1800, `hfTopupGstInclusive` true. Public: `GET /api/config` → `hfStdPlan`:

```json
{ "enabled": false, "startPaisePerMin": 399, "gstBps": 1800, "gstInclusive": true,
  "tiers": [ {"fromMin":0,"toMin":30,"paisePerMin":399,"rupeesPerMin":"3.99"},
             {"fromMin":30,"toMin":60,"paisePerMin":350,"rupeesPerMin":"3.50"},
             {"fromMin":60,"toMin":null,"paisePerMin":325,"rupeesPerMin":"3.25"} ] }
```

## API shapes (worker, already implemented)

**Host cards (only while the flag is enabled)** — `GET /api/hf/hosts`, `GET /api/hosts/public[/:slug]` each card has:
`plan: "standard"`, `pricePerMin: 3.99` (a NUMBER, may be fractional — never parse as int), `pricePaisePerMin: 399`,
`priceLabel: "₹3.99/min"`, `priceTiers: [{fromMin,toMin,paisePerMin}]`. Price filters/sort are ignored under the plan.
With the flag off, existing host prices, token-wallet responses, price selection, filters and call billing remain functional.

**Packs** — `GET /api/hf/tokens/products` → `{ enabled, gstBps, gstInclusive, currency:"INR", products:[{ productId,
pricePaise:12000, gstPaise:1831, walletPaise:10169, price:"₹120.00", gst:"₹18.31", wallet:"₹101.69", creditPaise:10169, ...legacy }] }`.
**Verify** — `POST /api/hf/tokens/play/verify` → adds `paidPaise, gstPaise, walletPaise, paid, gst, wallet`, and
`balance: { balancePaise, availablePaise, ...legacy }`.

**Wallet** — `GET /api/hf/wallet` (token-lot mode) →
```json
{ "mode": "rupees",
  "wallet": { "currency":"INR", "balancePaise":10169, "availablePaise":10169, "reservedPaise":0, "paidPaise":10169,
              "testPaise":0, "debtPaise":0, "balance":"₹101.69", "available":"₹101.69", "test":"₹0.00", "debt":"₹0.00", "debtOpen":false },
  "plan": { ...hfStdPlan },
  "history": [ { "at": 0, "kind": "purchase|call_spent|admin_adjust|refund_revoke|debt_create|debt_clear|call_refund",
                 "amountPaise": -2247, "amount": "-₹22.47", "label": "Call with Asha (5 min 38 s)", "callId": "...",
                 "purchase": { "paidPaise":12000, "gstPaise":1831, "walletPaise":10169, "orderId":"GPA..." } } ],
  "host": { "currency":"INR", "pendingPaise", "availablePaise", "totalEarnedPaise", "testEarningsPaise", "openPayoutPaise",
            "paidOutPaise", "perCall":[{callId,at,earnedPaise,paidPaise,testPaise,availableAt}], "payouts":[{id,amountPaise,status,createdAt,paidAt}] },
  "tokens": { ...legacy, now the same rupee figures } }
```

**Estimate** — `GET /api/hf/wallet/estimate?host=<slug>` → `{ mode:"rupees", plan:"standard", tiers, ratePerMinRupees:"3.99",
ratePaisePerMin:399, aboutText:"about 25 min 29 s", affordableSeconds, affordableChargePaise, canStart, startNeedPaise:798,
startNeed:"₹7.98", balancePaise, balance, hasDebt }`.

**Start call** — `POST /api/hf/calls` → adds `plan:"standard"`; `402 low_balance` extra = `{ shortfallPaise, shortfallRupees:"₹3.20" }`.
**Call detail** — `GET /api/hf/calls/:id` → caller: `chargedPaise, charged:"₹224.70", billableSeconds, plan, tiers:[{fromMin,toMin,
paisePerMin,seconds,amountPaise}]` (lines add up to chargedPaise); host: `earningPaise, earning:"₹120.00", billableSeconds`.

## Display helpers to use

Worker `formatRupees(paise)` in `worker/src/lib/hf_token_math.ts`. Web: one helper (add `formatPaise` next to the existing
money helper in `web/src/lib/money.ts` if needed). Flutter: `hf-flutter/lib/core/format/money.dart`.
