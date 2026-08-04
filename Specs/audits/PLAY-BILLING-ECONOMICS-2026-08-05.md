# AUDIT — Play Billing economics vs the ₹1 = 1 token promise

**Date:** 2026-08-05 · **Ticket:** `[AFF-PLAY-ECON-1]` · **Type:** analysis only, no code changed
**Context:** `Specs/proposals/PROPOSAL-AFFILIATE-UPI-2026-08-05.md` §1.1 and §B3
**Repo state audited:** `0fc253f9` (`worker/src/routes/wallet.ts`, `worker/src/play.ts`,
`worker/src/routes/affiliate.ts`, `worker/src/routes/wallet_statement.ts`,
`worker/src/lib/fx_rates.ts`, `app/lib/core/wallet_topup_billing.dart`,
`app/lib/features/wallet/wallet_screen.dart`)

---

## ⚠️ READ THIS FIRST — what this audit can and cannot tell you

**Two of the three inputs to Play-rail margin are not in this repo and were not
invented for this document.**

| Input | Status | Where the owner gets it |
|---|---|---|
| `P_inr(sku)` — the Play Console INR price tier for each `avatok_topup_*` SKU | **UNKNOWN** | Play Console → Monetise → Products → In-app products → each `avatok_topup_*` → Regional prices → India |
| Whether AvaTOK's Play developer entity is **India-located or foreign-located** | **UNKNOWN** | Play Console → Payments profile → business address |
| Google service fee tier currently applied (15% vs 30%) | **Inferred** — 15% assumed, see §3 | Play Console → Financial reports → Earnings → "service fee" column on a real INR transaction |

Everything below is therefore a **model with `P_inr` as a free variable**, plus
worked examples at plausible tier values that are explicitly labelled as
illustrations. **Do not quote a rupee figure from the worked examples as fact.**
§8 is the exact list of numbers to read off the Play Console to close this out.

A second, larger caveat: this is a **money-in** margin audit. It says nothing
about what a token *costs AvaTOK when it is spent* (AI inference, PSTN minutes,
Cloudflare Realtime). A rail can look profitable here and still lose money once
the tokens are redeemed. That is a separate audit.

---

## 1. What the code actually does (verified, not inferred)

### 1.1 Three money-in rails, three different currency behaviours

| Rail | Route | Currency | Tokens granted | ₹1 = 1 token? |
|---|---|---|---|---|
| **Stripe PaymentSheet** (India) | `walletTopupIntent`, `wallet.ts:280` | `inr`, amount in paise, client-chosen | `Math.round(paise / 100)` — exact rupees | ✅ **Yes, exactly** |
| **Stripe PaymentSheet** (RoW) | same route, `currency: "usd"` | `usd` cents | `round(cents * 100 / 100)` = cents | n/a (canonical $1 = 100 tokens) |
| **Google Play Billing** | `walletTopupPlayVerify` → `creditPlayTopup`, `wallet.ts:353/401` | **hardcoded `'usd'` in D1** | **fixed per SKU** from `PLAY_TOPUP_PRODUCTS` | ❌ **No — Google's tier decides** |
| **Stripe Checkout** (legacy web) | `walletTopup`, `wallet.ts:207` | hardcoded `"usd"` (`wallet.ts:238`) | `amountUsdCents` == tokens | ❌ **No — USD only, no INR path** |

The SKU map (`wallet.ts:342`), mirrored client-side in
`app/lib/core/wallet_topup_billing.dart:19`:

```
avatok_topup_5   → 500 Tokens
avatok_topup_10  → 1,000
avatok_topup_25  → 2,500
avatok_topup_50  → 5,000
avatok_topup_100 → 10,000
```

The names encode **USD**. There is no INR SKU, no per-country SKU, and no
`PLAY_TOPUP_PRODUCTS` variant. Every user in every country who buys
`avatok_topup_5` gets exactly 500 tokens, whatever Google charged them.

### 1.2 The app already admits this in user-facing copy

`wallet_screen.dart:682-691` — on the Play flow the region quote is fetched
**purely to print an apology**:

> "₹ pricing (1 Token = ₹1) is coming to Google Play — for now these tiers are
> charged at Google Play's local rate."

and the sheet header hardcodes `'$1 = 100 Tokens'` regardless of country. So the
Indian Android user is shown a **USD ladder** with a note that the promised INR
ladder does not apply. This is honest, but it means the ₹1 = 1 token promise in
§1.1 of the proposal is **not what an Indian Android user experiences today** —
and Android is the only shipped client.

### 1.3 The financial record for a Play top-up is wrong by construction

`creditPlayTopup` (`wallet.ts:412-417`):

```ts
const cents = usdCentsForTokens(coins);   // == coins, i.e. 500 tokens → 500
await env.DB_WALLET.prepare(
  "INSERT INTO topup_records (... amount_cents, currency, status ...) VALUES (?1,...,?5,'usd','paid',...)"
).bind(id, uid, orderRef, coins, cents, Date.now()).run();
```

Every Play top-up is recorded as **`currency = 'usd'`, `amount_cents = tokens`** —
i.e. "this user paid $5.00". For an Indian user who paid an INR tier, that row is
fiction: the currency is wrong, the amount is wrong, and Google's cut is not
recorded anywhere.

**Consequence: the INR actually received on the Play rail cannot be reconstructed
from `DB_WALLET` at all.** It exists only in Google's Play Console earnings
reports. Any margin dashboard built on `topup_records` will silently overstate
Play revenue by the store cut *and* by the tier delta. This is the single most
actionable defect in this audit, and it is a two-line fix (persist the real
`priceCurrencyCode` / `priceAmountMicros`), not a repricing exercise.

### 1.4 Refunds and voided purchases are NOT handled — commission leaks

Verified by search across `worker/src`: there is **no** Play RTDN / Pub/Sub
endpoint, **no** call to `purchases.voidedpurchases`, and `verifyPlayProduct`
(`play.ts:166`) is a one-shot check at purchase time. `reverseAffiliate()`
(`affiliate.ts:1054`) is reachable **only** from `admin_money.ts:75` — a manual
admin refund.

This directly undercuts the design intent stated in `affiliate.ts:841-844`:

> "The gates below are evaluated HERE, at promotion time … because that is the
> whole point of the 30-day window: **a refund, a chargeback, a suspension or a
> clustering signal that arrives on day 20 must still be able to stop the money.**"

For the Play rail nothing ever arrives. A user can buy `avatok_topup_100`
(10,000 tokens), have their affiliate accrue 1,000 tokens of commission, refund
the purchase through Google on day 3, and on day 30 the commission promotes
anyway — because AvaTOK never learns about the refund. Google reverses the
developer's revenue for a refunded purchase; AvaTOK still pays ₹1,000.

**Play refunds are an uncapped, silent commission liability.** This matters more
than the tier mismatch, because it is not a margin haircut — it is a 100% loss
on the affected transaction plus the clawback of Google's revenue.

### 1.5 Minimum top-up is inconsistent across rails

`MIN_TOPUP = 100` tokens (`wallet.ts:46`); the quote endpoint offers India
presets `₹100 / ₹200 / ₹500 / ₹1000` (`wallet_statement.ts:673`). The smallest
Play SKU is 500 tokens. So the advertised ₹100 entry point is **unreachable on
Android**, which is the only shipped platform.

---

## 2. The affiliate liability is rail-blind by design

`payAffiliateOnTopup` (`affiliate.ts:781`) takes `coins` and computes:

```ts
const aff = Math.floor(gross * TOPUP_AFFILIATE_RATE);   // TOPUP_AFFILIATE_RATE = 0.10
```

It never sees currency, rail, or price paid. Combined with §1.1 of the proposal
(payout at a fixed ₹1/token, `inr_per_token_paise = 100`), the liability per
top-up is:

```
affiliate_liability_inr = 0.10 × tokens_granted × ₹1
```

That is exact, deterministic and identical on every rail. **The revenue side is
not.** The whole of this audit is the gap between a fixed-in-tokens cost and a
rail-dependent, currency-dependent, store-cut-dependent revenue.

Proposal §B3 is correct that this "does not block the affiliate work". It is
also correct that it is a margin question. This document quantifies it.

---

## 3. Verified fee inputs (with sources)

### 3.1 Google Play service fee — India is on the OLD structure until 2027-09-30

Google announced a new fee model on 2026-03-04, but it is **regionally staggered**:

| Rollout date | Regions |
|---|---|
| 2026-06-30 | EEA, UK, US |
| 2026-09-30 | AU |
| 2026-12-31 | JP, KR |
| **2027-09-30** | **Rest of World — which includes India** |

Source: [Understanding Google Play's lower service fees — Play Console Help](https://support.google.com/googleplay/android-developer/answer/16954621?hl=en)

**Therefore, for an Indian transaction today (2026-08-05), the applicable
structure is the 2021 one:** 15% on the first US$1M of annual earnings per
account group, 30% thereafter.
Source: [Changes to Google Play's service fee in 2021](https://support.google.com/googleplay/android-developer/answer/10632485?hl=en) ·
[Understanding Google Play's Service Fee](https://support.google.com/googleplay/android-developer/answer/11131145?hl=en)

> **ASSUMPTION A1 — 15%, not 30%.** AvaTOK is pre-revenue on this rail, so annual
> earnings are far below $1M and 15% applies. This must be confirmed against a
> real Play earnings report; the 15% tier is also **not automatic** — it depends
> on the account group's enrolment state. Verify in Play Console before relying
> on any number here.

> **NOTE — US/UK/EEA users are already on the NEW structure.** A US Android user
> buying `avatok_topup_5` today falls under 10% service fee + 5% billing fee on
> the first $1M = **15% combined**, which happens to land in the same place as
> India's 15%. Convenient, but coincidental — and it diverges above $1M and for
> "existing install" users (25% + billing fee at standard rate). Modelled at 15%
> throughout; flag for re-check at scale.

### 3.2 India alternative billing — a real 4pp lever, not currently used

For users in India, offering an alternative billing system alongside Play's
reduces the service fee by **4 percentage points** (15% → 11%).
Source: [Changes to Google Play's billing requirements for developers serving users in India](https://support.google.com/googleplay/android-developer/answer/13306652?hl=en)

AvaTOK does not use this. It requires PCI DSS certification, Play Console
enrolment, and 24-hour transaction reporting via the alternative-billing APIs.
Noted as an option in §7, not recommended at current volume.

### 3.3 GST — 18%, and it comes out of the displayed price on BOTH rails

Play prices in India are **tax-inclusive**: "The price for apps and games in
Google Play must include all taxes, including GST."
Source: [Tax rates and value-added tax (VAT) — Play Console Help](https://support.google.com/googleplay/android-developer/answer/138000?hl=en)

Who remits depends on the developer's location:

- **Developer outside India:** "Google as a marketplace service provider is
  responsible for determining, charging, and remitting GST on your behalf for
  all Google Play Store paid apps and in-app purchases made by customers in
  India… Google will deduct such GST from your proceeds."
- **Developer in India:** the developer determines and pays GST; Google withholds
  income TDS and GST TCS on the payout.

Source: [India tax information — Google payments centre help](https://support.google.com/paymentscenter/answer/15152449?hl=en-IN)

> **ASSUMPTION A2 — 18% GST, deducted from the gross price.** The tax-inclusive
> price `P` therefore yields ex-tax revenue `P / 1.18`. **This applies to the
> Stripe INR rail too** — `walletTopupIntent` charges ₹100 for 100 tokens with
> **no tax handling anywhere in the code**, so if GST is owed on that supply it
> comes out of the same ₹100. Nothing in the repo computes, records or remits it.
> **This needs the CA's confirmation** (same CA already engaged per proposal §8.2)
> and is the single biggest swing factor in every number below.

> **ASSUMPTION A3 — ordering.** Modelled as: GST stripped first, service fee
> applied to the ex-tax amount (`N = P/1.18 × (1 − f)`). Google's documented
> behaviour is that the service fee is charged on the price excluding taxes, but
> **confirm against a real INR earnings line** — if the fee is instead applied to
> the gross, net drops by a further ~2.3% of `P`.

### 3.4 Stripe processing fees

- **India, domestic cards/UPI:** ~2% per transaction, plus 18% GST on the fee →
  ~2.36% effective.
- **International cards charged in INR:** ~3% (+1% international) plus ~1.5%
  conversion, plus GST on fees.
- **US/standard:** 2.9% + $0.30.

Sources: [Stripe India pricing](https://stripe.com/in/pricing) ·
[Stripe fees in India (2026) — Skydo](https://www.skydo.com/compare/stripe-pricing)

> **ASSUMPTION A4 — 2.36% all-in on the Stripe INR rail.** Stripe's actual
> negotiated Indian rate is not in the repo. Also unverified: **whether AvaTOK's
> Stripe account can even accept domestic INR** — Stripe India has been
> invite-only since May 2024 and requires an Indian entity. If INR is being
> charged as a foreign-currency transaction on a non-India Stripe account, the
> real cost is ~4–6%, not 2.36%, and every Stripe-INR figure below is optimistic
> by 2–4 points. **Verify before quoting.**

---

## 4. The model

### 4.1 Notation

| Symbol | Meaning |
|---|---|
| `P` | price the user actually pays, tax-inclusive, in the user's currency |
| `T` | tokens granted |
| `g` | GST divisor = 1.18 (assumption A2) |
| `f` | store/processor fee rate |
| `N` | net received by AvaTOK, ex-tax, after fees |
| `n = N / T` | **effective received per token** — the key metric |
| `A = 0.10 × T` | affiliate liability in ₹ (₹1/token, fixed) |
| `r*` | break-even affiliate rate = `n` expressed in ₹/token |

### 4.2 Per-rail formulas

```
Play (India):      N = P_inr / 1.18 × (1 − 0.15)  =  P_inr × 0.7203
Play (US):         N = P_usd × (1 − 0.15)          =  P_usd × 0.85     (no GST; US sales tax handled by Google)
Stripe INR sheet:  N = P_inr / 1.18 − 0.0236 × P_inr = P_inr × 0.8239
Stripe USD legacy: N = P_usd − (0.029 × P_usd + 0.30)
```

**Break-even affiliate rate is simply `r* = n` when the payout is ₹1/token**, and
`r* = n_usd / (1 / FX)` when a USD-rail top-up funds an INR payout.

---

## 5. Rail-by-rail results

### 5.1 Stripe PaymentSheet, INR — the reference rail (exact, no unknowns)

`P` is chosen by the user; `T = P` exactly (`wallet.ts:295-296`).

| User pays | Tokens | Ex-GST | Stripe fee | **Net ₹** | **₹/token** | Affiliate @10% | Margin after commission | **Break-even rate** |
|---|---|---|---|---|---|---|---|---|
| ₹100 | 100 | ₹84.75 | ₹2.36 | **₹82.39** | **₹0.8239** | ₹10 | ₹72.39 | **82.4%** |
| ₹200 | 200 | ₹169.49 | ₹4.72 | **₹164.77** | ₹0.8239 | ₹20 | ₹144.77 | 82.4% |
| ₹500 | 500 | ₹423.73 | ₹11.80 | **₹411.93** | ₹0.8239 | ₹50 | ₹361.93 | 82.4% |
| ₹1,000 | 1,000 | ₹847.46 | ₹23.60 | **₹823.86** | ₹0.8239 | ₹100 | ₹723.86 | 82.4% |

**Linear and scale-invariant.** ₹0.8239 received per ₹1 of promise.

If GST turns out **not** to apply (assumption A2 fails the other way):
`n = ₹0.9764`, break-even 97.6%.

### 5.2 Google Play, India — the rail with the unknowns

`n = P_inr(sku) × 0.7203 / T`. Since `T` is fixed by
`PLAY_TOPUP_PRODUCTS`, **`n` is a pure function of the Play Console tier.**

**Sensitivity table for `avatok_topup_5` (T = 500 tokens).** The ₹ prices below
are *illustrative inputs*, not Play Console readings:

| If the India tier is… | Net to AvaTOK | **₹/token** | Affiliate @10% | Margin after commission | **Break-even rate** | vs Stripe INR |
|---|---|---|---|---|---|---|
| ₹399 | ₹287.40 | **₹0.575** | ₹50 | ₹237.40 | 57.5% | −30% |
| ₹430 | ₹309.73 | **₹0.619** | ₹50 | ₹259.73 | 61.9% | −25% |
| ₹450 | ₹324.14 | **₹0.648** | ₹50 | ₹274.14 | 64.8% | −21% |
| ₹499 | ₹359.43 | **₹0.719** | ₹50 | ₹309.43 | 71.9% | −13% |
| **₹500** (= ₹1/token gross, the "promise" tier) | ₹360.15 | **₹0.720** | ₹50 | ₹310.15 | **72.0%** | **−13%** |
| ₹550 | ₹396.17 | ₹0.792 | ₹50 | ₹346.17 | 79.2% | −4% |
| ₹599 | ₹431.46 | ₹0.863 | ₹50 | ₹381.46 | 86.3% | +5% |

**Generalised to every SKU** — because `n` depends only on the ₹-per-token ratio
of the tier, one formula covers all five:

```
n_play_india  =  0.7203 × (P_inr(sku) / T(sku))
r*_play_india =  n_play_india          (as a fraction, payout being ₹1/token)
```

So: **whatever the tier, the Play rail keeps 72.03% of the gross ₹-per-token,
against 82.39% on Stripe.** The store cut alone is a fixed **10.4 percentage
point** disadvantage per token, before any tier mismatch.

The tier mismatch is then additive. Google's auto-conversion for a $5 SKU at
prevailing INR rates (the repo's own informational fallback is ₹96.4/USD,
`fx_rates.ts:20`) would land the tier somewhere below ₹500 — meaning the Indian
Android user very likely pays **less** than the ₹1/token promise for the same
tokens, while AvaTOK also pays a 15% cut on it. Both effects push the same
direction.

### 5.3 Google Play, USD (US/RoW users)

`N = P × 0.85`, `n = $0.0085/token` for every SKU (all SKUs are $0.01/token gross).

| SKU | User pays | Tokens | Net | $/token | ₹/token @96.4 | Affiliate @10% (₹) | Break-even rate |
|---|---|---|---|---|---|---|---|
| `_5` | $5 | 500 | $4.25 | $0.0085 | ₹0.819 | ₹50 | **81.9%** |
| `_10` | $10 | 1,000 | $8.50 | $0.0085 | ₹0.819 | ₹100 | 81.9% |
| `_25` | $25 | 2,500 | $21.25 | $0.0085 | ₹0.819 | ₹250 | 81.9% |
| `_50` | $50 | 5,000 | $42.50 | $0.0085 | ₹0.819 | ₹500 | 81.9% |
| `_100` | $100 | 10,000 | $85.00 | $0.0085 | ₹0.819 | ₹1,000 | 81.9% |

**This row contains a cross-currency exposure worth naming.** A US user's top-up
generates a liability payable in **rupees at a fixed ₹1/token**. Gross revenue is
$0.01/token; the liability is ₹1/token ≈ $0.0104 at ₹96.4/USD. So the *nominal*
₹ value of the promise already exceeds the gross USD price per token, and the
break-even rate on this rail moves with FX:

| INR/USD | ₹/token received (Play USD) | Break-even affiliate rate |
|---|---|---|
| 80 | ₹0.680 | 68.0% |
| 90 | ₹0.765 | 76.5% |
| 96.4 | ₹0.819 | 81.9% |
| 105 | ₹0.893 | 89.3% |

At a 10% commission this is nowhere near dangerous — but it is an **unhedged
short rupee position that scales linearly with affiliate volume**, and it is the
one place where FX genuinely enters the money path despite `fx_rates.ts` insisting
FX is informational only. Worth a line in the risk register, not a design change.

### 5.4 Stripe Checkout, USD legacy (`walletTopup`)

Fixed `$0.30` makes this rail regressive at small amounts.

| Tokens | User pays | Stripe fee (2.9% + $0.30) | Net | $/token | ₹/token @96.4 | Affiliate @10% (₹) | Break-even rate |
|---|---|---|---|---|---|---|---|
| 100 | $1.00 | $0.329 | $0.671 | $0.00671 | ₹0.647 | ₹10 | **64.7%** |
| 500 | $5.00 | $0.445 | $4.555 | $0.00911 | ₹0.878 | ₹50 | 87.8% |
| 1,000 | $10.00 | $0.590 | $9.410 | $0.00941 | ₹0.907 | ₹100 | 90.7% |
| 5,000 | $50.00 | $1.750 | $48.25 | $0.00965 | ₹0.930 | ₹500 | 93.0% |
| 10,000 | $100.00 | $3.200 | $96.80 | $0.00968 | ₹0.933 | ₹1,000 | 93.3% |

The `MIN_TOPUP = 100` token ($1) floor on this rail nets **67%** — the worst cell
in this entire audit. This is a legacy web rail with no INR support at all
(`wallet.ts:238` hardcodes `"usd"`); if it is still reachable it should either
raise its floor or be retired.

### 5.5 Summary — effective ₹ received per token

| Rail | ₹/token received | Break-even affiliate rate | Margin @10% |
|---|---|---|---|
| Stripe PaymentSheet INR | **₹0.824** | 82.4% | ₹0.724/token |
| Play, USD (@₹96.4) | **₹0.819** | 81.9% | ₹0.719/token |
| Stripe Checkout USD, $10+ | ₹0.907–0.933 | 90.7–93.3% | ₹0.807–0.833 |
| Stripe Checkout USD, $1 floor | ₹0.647 | 64.7% | ₹0.547 |
| **Play, India** | **₹0.7203 × (tier ÷ tokens)** — likely **₹0.58–0.72** | **58–72%** | **₹0.48–0.62/token** |
| Play, India, refunded purchase | **₹0 (Google claws revenue back)** | **0%** | **−₹0.10/token, uncapped** |

---

## 6. Where the ₹1 = 1 token promise holds and where it breaks

**Be precise about which rail is which — the proposal's §1.1 claim is true of
exactly one of four code paths.**

| # | Path | Promise status |
|---|---|---|
| 1 | `walletTopupIntent` with `currency:"inr"` (Stripe PaymentSheet, India) | ✅ **HOLDS EXACTLY.** `coins = round(paise/100)`. No FX, no rounding drift. ₹100 → 100 tokens → 10 token commission → ₹10 payout. Proposal §1.1 is correct here and only here. |
| 2 | `walletTopupPlayVerify` → `creditPlayTopup` (Play, India) | ❌ **BREAKS ON PRICE.** Tokens are fixed by SKU; the rupee price is Google's localised tier for a USD-named SKU. AvaTOK does not set it and does not record it. |
| 3 | `walletTopup` (Stripe Checkout, legacy web) | ❌ **NO INR PATH AT ALL.** `currency` hardcoded `"usd"` (`wallet.ts:238`). An Indian user on this rail gets the USD ladder. |
| 4 | `/api/wallet/topup-quote` (`wallet_statement.ts:661`) | ⚠️ **PROMISES ON ALL RAILS, DELIVERS ON ONE.** Returns `tokens_per_unit: 1`, `min_amount: 100`, and the note *"1 Token = ₹1 (fixed for India)"* purely from `cf.country === "IN"`. The Android client then fetches this quote, discards the ladder, and prints an apology (`wallet_screen.dart:686-690`). |

**And a fifth break, on the net side, that holds on *no* rail:**
₹1 = 1 token is a **gross price** promise. Net of GST and store/processor fees,
AvaTOK receives **₹0.58–₹0.82** per token everywhere. The promise to the *user*
can be kept; the promise cannot be read as "a token is worth ₹1 to the platform".
The affiliate payout is denominated against the *gross* promise while the revenue
is *net* — that spread is the entire economics of this document.

**Practical upshot for launch:** because Android is the only shipped client and
`_playTopupFlow` is what an Indian user actually sees, **the ₹1 = 1 token
experience does not currently exist in production for the users the affiliate
program is aimed at.** The Stripe INR sheet exists in code and is correct; it is
reachable on web and (per `wallet_screen.dart`) not on the Play flow.

---

## 7. Break-even affiliate rates — consolidated

At a ₹1/token payout, break-even rate = the ₹/token received. Restated:

| Rail | Break-even commission rate | Headroom above the 10% rate |
|---|---|---|
| Stripe Checkout USD ($100) | 93.3% | 9.3× |
| Stripe Checkout USD ($10) | 90.7% | 9.1× |
| Stripe PaymentSheet INR | 82.4% | 8.2× |
| Play USD @₹96.4 | 81.9% | 8.2× |
| Play India @ ₹500 tier | 72.0% | 7.2× |
| Play India @ ₹450 tier | 64.8% | 6.5× |
| Stripe Checkout USD ($1) | 64.7% | 6.5× |
| Play India @ ₹399 tier | 57.5% | 5.8× |
| **Play India, refunded** | **0%** | **negative, unbounded** |

**Headline: at 10%, no rail is close to break-even on money-in — the worst case
still keeps ~₹0.48 of every ₹1 promised.** The affiliate rate is not the risk.

The three real risks, in order:

1. **Un-clawed-back Play refunds (§1.4).** Loses 110% of the transaction. No
   volume of margin analysis fixes a missing refund webhook.
2. **Un-modelled token redemption cost.** ₹0.48–0.72/token of gross margin is
   only margin if a token costs less than that to honour. Not audited here.
3. **The ~10 pp Play-vs-Stripe gap**, which is a real but survivable haircut and
   the only thing repricing the SKUs would fix.

---

## 8. What the owner must read off the Play Console to finalise this

Nothing below can be answered from the repo. All of it is a few minutes of
clicking.

1. **India price tier for each of the five SKUs.**
   Play Console → Monetise with Play → Products → In-app products → open each
   `avatok_topup_5 / _10 / _25 / _50 / _100` → Regional prices → **India (INR)**.
   Record the exact ₹ figure and whether it is marked tax-inclusive.
   → substitute into `n = 0.7203 × (P_inr / T)` in §5.2.
2. **Developer entity location.** Payments profile → business address.
   India-located ⇒ AvaTOK owes GST and Google withholds TDS + GST TCS on payouts.
   Foreign-located ⇒ Google remits GST from proceeds. Changes who bears A2.
3. **The actual service fee on a real INR transaction.** Financial reports →
   Earnings → export → the service-fee column of any completed India order.
   Confirms 15% vs 30% and confirms whether the fee is taken pre- or post-GST (A3).
4. **One real India earnings line, end to end:** charge amount, tax withheld,
   service fee, net payout. That single row collapses assumptions A1, A2 and A3
   at once and turns §5.2 from a model into a number.
5. **Stripe: confirm the INR rail is live and its real rate** (A4) — whether
   domestic INR acquiring is enabled on the account, and the effective %.

---

## 9. Recommendation

The four options in the brief, with honest trade-offs. **The recommendation is
(d) + a mandatory fix, then (a) later — not a repricing exercise now.**

### (a) Create INR-priced Play SKUs so the ladder matches

**What it is:** add `avatok_topup_inr_100/200/500/1000` (or set explicit India
regional prices of ₹500/₹1000/₹2500/₹5000/₹10000 on the existing SKUs, which is
cheaper) so the Indian Play user sees the same ladder as the Stripe sheet.

| Pros | Cons |
|---|---|
| Makes the promise in `topup-quote`, the proposal, and the marketing copy literally true on the only shipped client | Play Console price edits are per-SKU per-country manual work, and must stay in lock-step with `PLAY_TOPUP_PRODUCTS` and `kTopupTiers` — a three-place map that has already drifted once |
| Recovers up to ~13 pp of the gap (raises `n` from ~₹0.62 to ~₹0.72) | **Raises the price for Indian users**, probably by 10–20%. That is a conversion hit on a pre-revenue product, and conversion beats margin at this stage |
| Removes the apology string from `wallet_screen.dart` | Explicit regional pricing opts out of Google's auto-FX, so it must be re-reviewed whenever INR moves materially |
| Enables the ₹100 minimum on Android (currently unreachable, §1.5) | Does not touch the 15% cut, which is the larger half of the gap |

**Verdict: right eventually, wrong first.** Do it once there is enough India Play
volume to measure the conversion elasticity — and do the ₹100-minimum SKU first,
since that is a pure gain (it unlocks the advertised entry point rather than
raising a price).

### (b) Adjust the token grant per SKU

**What it is:** change `PLAY_TOPUP_PRODUCTS` so Play SKUs grant fewer tokens,
compensating for the store cut.

| Pros | Cons |
|---|---|
| Pure server-side, one-line, no store work | **Breaks the invariant that a token is worth the same everywhere.** The whole token model rests on that |
| Restores per-token margin without a visible price rise | The map is global — you cannot lower the grant for India without lowering it for the US too, since the SKU is the same product |
| | Users compare: "$5 gives 500 tokens on web and 425 on Android" is a support burden and looks like a bug |
| | Silently devalues existing balances' implied purchase power |

**Verdict: reject.** It solves a pricing problem by corrupting the unit of
account. If the price needs to change, change the price.

### (c) Cap or reduce affiliate commission on Play-origin top-ups

**What it is:** pass rail into `payAffiliateOnTopup` and apply a lower rate (or a
cap) for `source: "play"`.

| Pros | Cons |
|---|---|
| Directly targets the rail with the thinnest margin | **Solves a problem that does not exist.** Break-even is 58–72% on the worst Play case; 10% is nowhere near it |
| Cheap to implement (the `method: "google_play"` metadata is already at the call site, `wallet.ts:425`) | Destroys the single cleanest property of the affiliate design — *"10% of tokens, rail-independent and exact on every rail"* (proposal §B3) |
| | Makes affiliate earnings non-deterministic from the affiliate's point of view: the same referred user topping up the same amount pays differently depending on which button they pressed. That is a trust and support nightmare for a public program |
| | Requires a rail column on `affiliate_commissions` and complicates §6.1's already-delicate promotion logic |

**Verdict: reject for the general case.** With one exception worth keeping in the
back pocket: a **per-referred-user cap** (`affiliatePerReferredCapCoins` already
exists, `affiliate.ts:871`) is the correct blunt instrument if abuse appears, and
it is rail-blind.

### (d) ✅ Accept the margin as-is — and fix the two things that actually leak

**Recommended.**

The Play rail is ~10 percentage points per token worse than Stripe, plus whatever
the tier delta turns out to be. At a 10% commission every rail retains **≥ ₹0.48
per ₹1 of promise**, i.e. **5.8× to 9.3× the break-even rate**. Repricing SKUs to
recover 10 pp of a margin you are not spending is optimising the wrong variable
while two uncapped leaks are open.

**Do these instead, in this order:**

1. **[BLOCKER for enabling payouts] Handle Play refunds and voided purchases
   (§1.4).** Either a Play RTDN Pub/Sub endpoint or a scheduled
   `purchases.voidedpurchases` sweep, feeding `reverseAffiliate()` on the matching
   `topup_records.id`. The 30-day qualification window is *designed* to catch
   this (`affiliate.ts:841-844`) and currently catches nothing on the Play rail.
   Without it, "10% of every top-up forever" includes top-ups that were refunded.
   **Do not enable `avaAffiliateEnabled` in production until this exists.**
2. **[2-line fix, do it now] Record the real money on Play top-ups (§1.3).**
   `verifyPlayProduct` can return Google's `priceCurrencyCode` and
   `priceAmountMicros`; persist them instead of `'usd'` + `usdCentsForTokens()`.
   Until this lands, **no dashboard can measure the thing this audit is about**,
   and re-running this analysis on real data is impossible.
3. **Close out §8** — read the five Play Console figures and pin `n_play_india`
   to a real number rather than a range.
4. **Then, with real data, revisit (a)** — starting with an India SKU at the ₹100
   minimum, which is additive rather than a price rise.
5. **Retire or floor the legacy Stripe Checkout rail (§5.4).** The $1 tier nets
   67% — the worst rail in this audit — and it has no INR path.

**One thing to decide independently of all of the above:** the user-facing copy.
Today an Indian Android user is told "₹ pricing is coming to Google Play" while
the affiliate program advertises "1 token = ₹1, so a ₹100 top-up earns you ₹10"
(proposal §1.1). Those two strings are both live, both honest in isolation, and
mutually confusing. Either align the Play ladder (option a) or soften the
affiliate copy to describe the *payout* rate rather than the *purchase* rate,
before the program opens.

---

## 10. Sources

- [Understanding Google Play's lower service fees — Play Console Help](https://support.google.com/googleplay/android-developer/answer/16954621?hl=en) — 2026 fee restructure, regional rollout table (India = Rest of World, 2027-09-30)
- [Understanding Google Play's Service Fee — Play Console Help](https://support.google.com/googleplay/android-developer/answer/11131145?hl=en)
- [Changes to Google Play's service fee in 2021 — Play Console Help](https://support.google.com/googleplay/android-developer/answer/10632485?hl=en) — 15% first $1M / 30% thereafter
- [Changes to Google Play's billing requirements for developers serving users in India — Play Console Help](https://support.google.com/googleplay/android-developer/answer/13306652?hl=en) — alternative billing, −4pp
- [India tax information — Google payments centre help](https://support.google.com/paymentscenter/answer/15152449?hl=en-IN) — GST/TDS/TCS by developer location
- [Tax rates and value-added tax (VAT) — Play Console Help](https://support.google.com/googleplay/android-developer/answer/138000?hl=en) — Play prices are tax-inclusive
- [Service fees — Play Console Help](https://support.google.com/googleplay/android-developer/answer/112622?hl=en)
- [Stripe India pricing](https://stripe.com/in/pricing)
- [Stripe fees in India (2026) — Skydo](https://www.skydo.com/compare/stripe-pricing)
- [Android Developers Blog — Expanded billing choice and lower fees on Google Play](https://android-developers.googleblog.com/2026/06/play-expanded-billing.html)

**Not verified / explicitly assumed:** A1 (15% tier applies), A2 (18% GST out of
gross, both rails), A3 (fee applied post-GST), A4 (Stripe INR at ~2.36% and that
domestic INR acquiring is even enabled), and every `P_inr` value in §5.2. Nothing
in this document should be treated as final until §8 is answered.
