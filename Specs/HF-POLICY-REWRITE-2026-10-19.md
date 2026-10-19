# HF-WIRE-15: policy, help and FAQ copy rewrite (2026-10-19)

Source of truth: `Specs/RULEBOOK-HELLO-FRAANDS.md` HF-REEL-30..36, HF-CALL-1..6, section 7 (Money).
Scope: copy only. No logic, layouts or design changes. Pages that were edited now show "Last updated: 2026-10-19"
(the shared default in `web/src/layouts/HelloFraandsPage.astro` also moved to 2026-10-19).

Rules now stated everywhere they apply: masked calls placed by us; at least ₹20 in the wallet to start; a call is made once both are rung and joined, billed per minute spoken; ₹1 if a joined call breaks in the first minute; nothing if the influencer declines, cancels or does not answer; booked calls hold 10 minutes, free cancel until 1 hour before, full hold back if the influencer does not pick up or cancels; no refunds for calls that were made; all refunds go to the wallet; anyone can withdraw with Payout after a one-time ID (KYC) and UPI check; test credits spend-only; influencer earnings held 7 days; top-up from ₹10 with 18% GST (wallet gets amount / 1.18), gateway never named; embeds only; influencers join free, YouTube by sign-in, Instagram by bio code, 10+ followers; we keep ₹2 a minute plus 40% of the rate above ₹2.

## Files changed

| File | What was wrong | What it says now |
|---|---|---|
| `web/src/pages/refunds.astro` | Refund of unused balance within 180 days; "connected" wording; fan refunds implied to payment source | Rewritten: no refunds for calls made; pay nothing on decline/cancel/no answer; first-minute ₹1 rule; booked-call hold rules; all refunds to wallet; Payout with one-time KYC + UPI check; test credits; 7-day hold |
| `web/src/pages/wallet-terms.astro` | "Two minutes of balance", fixed packs wording, refunds within 180 days, bank/UPI payout, "no fixed time limit" | Any amount from ₹10 (amount / 1.18), ₹20 minimum, call-made definition, first-minute rule, booked calls, refunds to wallet, Payout, influencer split, ban wording |
| `web/src/pages/terms.astro` | 2-minute balance, 180-day refund, "failed connection" billing | ₹20 minimum, call-made rule, ₹1 rule, refunds to wallet, Payout after a ban |
| `web/src/pages/faq.astro` | Pooja's bill footer said "keep 2 minutes in the wallet" | "keep at least ₹20 in the wallet" |
| `web/src/lib/faqData.ts` | Whole payments section and partner refund answer used 180 days, 2 minutes, 60% minus ₹2, ₹500 minimum, bank payout | Payments section rewritten (13 answers); new videos-are-embeds answer; influencer join/earn/payout answers; call-dropped answer; deletion answer; partner refund answer |
| `web/src/pages/how-it-works.astro` | Step 2 lacked amount rule; "₹0 if you don't connect"; "enough money to start" | Any amount from ₹10, ₹20 minimum, call-made rule, first-minute safety line |
| `web/src/pages/hosts/join.astro` | 60% minus ₹2 split, calculator, illustration and coins (₹600/₹10,000/₹30,000) | ₹2 + 40% above ₹2; split strip, coins (₹648/₹10,800/₹32,400) and calculator follow the new rule; join steps (free, YouTube sign-in, Instagram code, 10+ followers, ID once before first payout) |
| `web/src/pages/hosts/rates.astro` | 60% minus ₹2; ₹500 minimum; team-approved bank/UPI payout | New split and ₹20 example (you earn ₹10.80); 7-day hold; Payout to own UPI after one-time KYC + UPI check |
| `web/src/pages/hosts/kyc.astro` | Presented Aadhaar/selfie/bank checks as part of joining | Joining needs no ID check; ID (KYC) and UPI checked once before the first payout; bank account references changed to UPI |
| `web/src/pages/hosts/requirements.astro` | Silent on followers/connection/ID timing | Added 10+ followers, YouTube sign-in / Instagram bio code, no ID to join |
| `web/src/pages/data-deletion.astro` | Refund/bank payout of unused balance; 180 days | Withdraw with Payout first; refunds go to wallet |
| `web/src/pages/community-guidelines.astro` | Banned users: refund within 180 days | Banned users can still withdraw with Payout |
| `web/src/pages/wellbeing.astro` | "not refunded"; 180 days | Calls made are not refunded; unused wallet money can be withdrawn with Payout |
| `web/src/pages/age-policy.astro` | Remaining balance returned to original payment source | Balance can be withdrawn with Payout after usual ID/UPI checks |
| `web/src/pages/help/index.astro` | "Calls are not refunded" footer | Calls made are not refunded; refunds go to wallet |
| `web/src/layouts/HelloFraandsPage.astro` | Default "Last updated" 2026-10-18 | 2026-10-19 |
| Help: `wallet-and-payments/no-refunds.md`, `withdraw-your-balance.md`, `top-up-your-wallet.md`, `low-balance-and-call-limit.md`, `billing-errors.md` | 180-day refund to the way you paid, 2-minute balance, "second by second", "never connected" wording | Rewritten to the rules above |
| Help: `calling/price-and-minutes.md`, `make-your-first-call.md`, `call-problems.md`, `favourites-and-calling-again.md` | 2-minute balance, "no fixed time limit", 180 days | ₹20 minimum, call-made rule, ₹1 rule |
| Help: `hosts/getting-paid.md`, `host-earnings.md`, `become-a-host.md` | ₹500 minimum, team approval, bank account, 60% minus ₹2 (example ₹150) | Payout button, UPI, 7-day hold, one-time KYC; ₹2 + 40% above ₹2 (example ₹162); join steps with YouTube/Instagram and 10+ followers |
| Help: `account-and-help/delete-your-account.md`, `complaints-and-grievance.md`, `getting-started/create-your-account.md`, `how-a-call-works.md`, `safety-and-privacy/strikes-and-bans.md` | 180-day refunds, "refunded to you first", "ringing... all cost ₹0" | Withdraw via Payout; call-made rule; banned users can still withdraw |
| `web/src/islands/dashboard-hf/v3/Support.tsx`, `v3/Calls.tsx` | Static help text: refund to original payment in 180 days, 2 minutes, "calls are not recorded" (against HF-PRIV-1) | Rewritten to the rules; recording mention removed |
| `web/src/islands/dashboard-hf/sections/Earnings.tsx`, `wallet/HfWallet.tsx`, `v3/Become.tsx`, `host-onboarding/data.ts`, `admin2/hosts/CreatorListings.tsx` | "60% minus ₹2" lines (Become.tsx also "paid by the second") | New split wording. `Become.tsx` estimate function `hostPaisePerMin` now returns 60% of (rate - ₹2), so the on-screen estimate matches the text (display-only maths) |
| `hf-flutter/lib/ui/strings/help_strings.dart` | Refund to same payment within 180 days; no ₹20, Payout, videos or booking-refund rules | 7 answers covering every rule; no gateway named |
| `hf-flutter/lib/demo/screens/call_real.dart`, `sheets.dart` | "Top up to talk for at least 3 minutes" | "You need at least ₹20 in your wallet to start a call." |
| `hf-flutter/test/ui/settings_test.dart` | Asserted 5 answers and "same payment" | Asserts 7 answers, "back to your wallet", "₹20", no "180 days" |
| `web/scripts/check-hello-fraands-pages.mjs` | Contract strings pinned the old copy (60%, two minutes, ₹600 coins) | Contract strings and coin values pinned to the new copy |

## Found and deliberately left

| Place | Why left |
|---|---|
| `web/src/islands/wallet/RefundPanel.tsx`, `dashboard-hf/v3/Wallet.tsx`, `wallet/AccountClose.tsx`, `dashboard-hf/v3/Close.tsx`, `hf-flutter/.../settings_real.dart` (+ `settings_test.dart` "refunded to the payment you used"), `lib/data/services.dart` comment | These describe a working refund-to-original-payment / 180-day flow driven by the money engine. Changing words without changing the flow would mislead. Needs HF-WIRE-13 to move refunds and account closure to wallet + Payout, then update the words. |
| `web/src/islands/calls/HostCallActions.tsx`, `dashboard-hf/v3/Calls.tsx` ("up to 60 minutes") | Strings are produced by call logic (`startNeedText`, tariff lines, 60-minute cap). Logic owner is HF-WIRE-13. |
| `hf-flutter/lib/demo/screens/money.dart` ("minimum payout ₹500", "we check every request by hand") and the payout screen | Driven by server values; the ₹500 minimum and manual approval are not in the owner rules. I did not state them on any page. Owner decision needed. |
| `worker/src/lib/hf_topup_notify.ts`, `hf_receipts.ts`, `hf_play*.ts`, `hf_exit*.ts` | Receipt/WhatsApp text names the payment channel ("via Cashfree", "Google Play") and Play-billing token paths. These are generated from data and tied to money logic. They do not state refund rules. Owner decision: drop "via ..." from the WhatsApp text and email (rule: never name the gateway). |
| `web/src/pages/women-only.astro`, `lgbtq.astro`, help `for-women/*`, `safety-and-privacy/lgbtq-space.md`, FAQ "women" section, safety/FAQ quick links | They describe "Verified customers only" for monthly-plan influencers (HF-VERIFIED-ONLY-1), not the old women-only/LGBTQ lanes. Removing pages is a product decision and would break check-hello-fraands-pages route list. Owner decision. |
| FAQ/terms/help mention "monthly influencer plan" and "full KYC" for verified-only callers | Same feature as above; not KYC to join. |
| `web/src/pages/hosts/kyc.astro` selfie-video and Aadhaar/DigiLocker steps | Kept as the description of the first-payout ID check. Owner should confirm the real first-payout flow includes the selfie video. |
| `web/src/pages/privacy.astro`, `about.astro` and other pages with their own `updated` date | No money-rule content; dates left as they were. |
| Homepage `desi-home-body.html` Google Play store buttons | App download links, not billing. |
| "No fixed time limit" wording | Removed from pages I rewrote because HF-PAY-2 says calls stop at 60 minutes. Not an owner rule, so the 60-minute cap is not stated. |

## Verification

- `astro build` in `web/` completes (using the main checkout's node_modules, temporarily linked).
- `checkHelloFraandsPages('dist')` passes (28 pages, contracts updated for new copy).
- `scripts/check_brand_literals.py` OK (no new literals).
- `scripts/check-config-contract.mjs` fails on `WORKER_FAKE_FLAG ts`; this is not from this change (worker files untouched).
- hf-flutter check: run in CI (see commit/branch in the report).
