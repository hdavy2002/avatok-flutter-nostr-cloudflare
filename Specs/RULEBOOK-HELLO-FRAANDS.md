# Hello Fraands — Site Rulebook

**Owner:** Davy · **Started:** 2026-10-08 · **Status:** living document

This is the single record of what we decided for Hello Fraands, what we have
built so far, and what is still waiting. Every time the owner adds, changes or
drops a rule, it is recorded here **in the same change**, with a line in the
Change log at the bottom. Nothing is deleted silently: a dropped rule is marked
`DROPPED` with the date and reason, so we can always see what was first planned
and what was done.

> **For AI agents:** read this file before touching any Hello Fraands page,
> policy, help article, call flow, wallet or safety feature. If your change needs
> a rule that is not here, ask the owner and add it here in the same commit.
> Never write the brand name or domain in code — use `Specs/brand.json`.

### How to read a rule

Each rule has an ID (`HF-<area>-<n>`), the rule itself, and three status marks:

| Mark | Meaning |
|---|---|
| **Decision** | `ADOPTED` (owner decided) · `PROPOSED` (suggested, owner has not decided) · `DROPPED` |
| **Pages** | what the public website says today: `DONE` · `TODO` · `N/A` |
| **Backend** | whether the system actually does it: `DONE` · `TODO` · `N/A` |

The backend is not built yet (Oct 2026). Public pages describe how the service
works; the backend must be built to match these rules before calls go live.

---

## 1. Product and positioning

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-PROD-1 | Brand is **Hello Fraands** at hellofraands.com (from 2026-10-08). Earlier names CallVaal, Aum Fe (aumfe.com), Saa Thum (saathum.com) are retired; never shown on the site. | ADOPTED | DONE | N/A |
| HF-PROD-2 | India only: Indian numbers, UPI, Indian KYC, Indian languages. | ADOPTED | DONE | TODO |
| HF-PROD-3 | One product: "talk to someone" — real people, per-minute phone calls, mood-based (exam ki tension, can't sleep, naye dost, bas baat…). No service categories. | ADOPTED | DONE | TODO |
| HF-PROD-4 | Friendship and "regulars" (calling the same host again) is part of the offer — but it is friendship, never romance. See HF-WELL-5. | ADOPTED | DONE | TODO |
| HF-PROD-5 | Not therapy, counselling, crisis line, dating, adult chat or professional (medical, legal, money) advice. Said on the home page, FAQ, help centre and terms. | ADOPTED | DONE | N/A |
| HF-PROD-6 | 18+ only, for callers and hosts. | ADOPTED | DONE | TODO (caller age gate, see HF-WELL-10) |

## 2. How calls work

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-CALL-1 | We are a **switch**: the host's phone rings first with a private announcement (caller handle, past call count). Host presses 1 to accept, 2 to decline; 10 s silence = decline. Only then the caller is dialled, and the two calls are joined through a platform number. | ADOPTED | DONE | TODO (Vobiz PSTN) |
| HF-CALL-2 | Neither person ever sees the other's real phone number. | ADOPTED | DONE | TODO |
| HF-CALL-3 | No app needed for calls; the Android app is optional. Calls come to the normal phone number. Wallet, favourites and history live on the website. | ADOPTED | DONE | TODO |
| HF-CALL-4 | Either person can hang up any time. **#** at any time ends the call, blocks the other person and reports the incident. | ADOPTED | DONE | TODO |
| HF-CALL-5 | Both people hear a short **safety notice** before connecting (not a recording notice). Proposed wording: *"This is a friendly chat, not counselling. In crisis, dial 14416."* | ADOPTED (wording PROPOSED) | DONE (wording in terms) | TODO |
| HF-CALL-6 | **Notify me, no queue** (owner decision 2026-10-09). When a host is busy or offline, the caller sees "Busy — Notify me" / "Offline — Notify me". We send one WhatsApp when the host goes online (at most one per 24 h per caller), then the subscription ends. Nobody waits in a line. If a host declines or misses a call, the caller is offered the same Notify me. | ADOPTED | DONE (HF-CALLS-1, behind hfCallsEnabled) | TODO (HF-CALLS-1) |

## 3. Privacy and recording

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-PRIV-1 | **No call recording. No stored call audio. No transcripts.** | ADOPTED | DONE (all policy pages updated 2026-10-08) | TODO |
| HF-PRIV-2 | **No human monitors or listens** to live calls. | ADOPTED | DONE | N/A |
| HF-PRIV-3 | We keep only call metadata: account IDs, time, duration, price, how the call ended (person or safety action). | ADOPTED | DONE | TODO |
| HF-PRIV-4 | We keep a **safety log** without audio: AI flags, welfare flags, crisis numbers shown, strikes, blocks — each with a time. This is our proof that the safety system worked. | PROPOSED | TODO | TODO |
| HF-PRIV-5 | We never sell personal data. Legal name, Aadhaar details and phone number are never shown to the other person. | ADOPTED | DONE | TODO |

## 4. AI safety and spam

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-AI-1 | AI follows every live call and understands **intention**, not keywords. No word triggers. | ADOPTED | DONE | TODO |
| HF-AI-2 | AI ends the call automatically on harassment, abuse, threats, sexual pressure, or scams (OTP, UPI PIN, card, bank, Aadhaar, "verify" links, fake bank/police/courier, loans, investments, remedies). | ADOPTED | DONE | TODO |
| HF-AI-3 | Spammers and scammers are blocked **across the whole platform**; repeat attempts from new accounts are matched and blocked. | ADOPTED | DONE | TODO |
| HF-AI-4 | The platform never asks for OTP, UPI PIN, password or bank details — on any channel. | ADOPTED | DONE | N/A |
| HF-AI-5 | Women-only lane: AI is tuned so health and intimate-wellness talk, or describing a bad experience, is never treated as misconduct. | ADOPTED | DONE | TODO |
| HF-AI-6 | Self-harm mentions are **never a strike** — they go to welfare follow-up (HF-WELL-2). | ADOPTED | DONE | TODO |

## 5. Conduct

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-CON-1 | No sexual or suggestive talk. Only exception: a genuine health conversation with a host who has consented to that topic (shown on the profile), e.g. women-only lane or a host listing sexual-health discussion. Explicit or erotic talk is never allowed. | ADOPTED | DONE | TODO |
| HF-CON-2 | Not allowed: abuse, threats, gaali; sharing or asking for numbers, WhatsApp, Instagram, UPI IDs; meeting; selling anything; asking for money or payment outside the platform; recording the other person. | ADOPTED | DONE | TODO |
| HF-CON-3 | Hosts choose and publish the topics they consent to talk about. | ADOPTED | DONE | TODO |
| HF-CON-4 | Strikes: AI flags and reports are reviewed by the team before a strike is confirmed. 3 confirmed strikes = permanent ban. Threats, sexual harassment or fraud can mean an immediate ban. AI never bans on its own. | ADOPTED | DONE | TODO |
| HF-CON-5 | A banned account cannot make calls or re-register with the same number, but **can still sign in and request a refund of its unused purchased tokens through Google Play (HF-PAY-15)**. Money is never forfeited as a penalty. | ADOPTED | DONE | TODO |

## 6. Women's safety

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-WOM-1 | Women's safety is the main design goal: masked numbers, verified hosts, AI ends abusive calls, # ends and blocks instantly. Payment never buys permission to cross a boundary. | ADOPTED | DONE | TODO |
| HF-WOM-2 | Women-only lane: only women talk to women; hidden from everyone else. **Both** caller and host must pass Aadhaar verification (and the host the selfie video check) showing they are women before the lane appears. (Wording updated 2026-10-09: India KYC is Aadhaar OTP, with DigiLocker as fallback, + selfie video, not Didit.) | ADOPTED | DONE | DONE (HF-LANE-VERIFY-1: caller side; calls pending) |

## 7. Money

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-PAY-1 | Prepaid talk-time wallet, topped up by UPI. **Under tokens (HF-TOK-EXIT-1, flag `hfTokensEnabled`): callers add money to a rupee wallet through Google Play (no UPI top-up); the wallet holds rupees, no tokens are shown to people (HF-WALLET-RUPEES); calls charge the host rate in rupees.** Rates from ₹5/min (general-lane floor); host sets own rate, shown before the call. | ADOPTED | DONE | TODO |
| HF-PAY-2 | Billing per started minute of connected time. Ringing, decline, timeout, failed connection = ₹0. Need 2 minutes of balance to start. **Under tokens: billed per second of connected time, in tokens, at the host's rate; 2 minutes of spendable value to start.** Max 60 min per call, warning ~60 s before the end. Balance never goes negative. | ADOPTED | DONE | TODO |
| HF-PAY-3 | **No refunds for connected calls.** We are not responsible for a caller's experience with a particular host. | ADOPTED | DONE | N/A |
| HF-PAY-4 | Billing errors (charged for a call that never connected, double charge) are corrected back to the wallet — this is not a refund. | ADOPTED | DONE | TODO |
| HF-PAY-5 | ~~Unused wallet balance is always the user's: withdraw to own UPI ID any time.~~ **DROPPED 2026-10-10 (HF-TOK-EXIT-1):** a balance can no longer be transferred back to UPI, because callers now pay Google Play for tokens and money can only go back the way it came. Replaced by HF-PAY-15: unused purchased tokens are refunded on request through Google Play within 180 days (also after a ban, and first when closing the account, HF-PAY-14). | DROPPED | N/A | N/A |
| HF-PAY-6 | Platform share per minute: ₹2 + 40% of the amount above ₹2, 18% GST included in the platform share. ₹5 → host ₹1.80; ₹10 → ₹4.80; ₹20 → ₹10.80; ₹30 → ₹16.80. Host earnings paid to a UPI ID in the host's own name. Payouts: minimum ₹500, 7-day hold, manual (HF-PAY-12). | ADOPTED | DONE | TODO |
| HF-PAY-7 | **DROPPED 2026-10-10 (HF-NOLIMITS-1): no daily or monthly spending limits for callers.** Owner decision: a big spender can use up a ₹100 / 100 USD budget in a day, so a cap makes no sense. Callers can top up and spend without any daily or monthly cap; per-user admin overrides are gone. Only the "Are you sure?" step on a top-up of ₹1,000 or more stays (`hfTopupConfirmAboveRupees`). Old text, kept for the record: (HF-WALLET-LIMITS-1). Real money only (test credits never count): **₹2,000 a day and ₹15,000 a calendar month** per caller, on India time (the day resets at midnight, the month on the 1st). A call can only use as much paid money as is left under the limits; test credits still work beyond them, and the call ends when the limit is reached (the usual time/balance warning applies). With nothing left to use, the caller sees "You've reached today's limit of ₹2,000. It resets at midnight." (or the monthly version) — a rule of the service, never worded as a host's choice (HF-WELL-3). Adding money is not spending and is never blocked, but a top-up of ₹1,000 or more asks "Are you sure?" first, with a link to /wellbeing. An admin can raise or lower the limits for one user (with a note, audit-logged). Amounts are config: `hfDailySpendLimitRupees`, `hfMonthlySpendLimitRupees`, `hfTopupConfirmAboveRupees`. **Under tokens the limits count the rupees paid to Google Play** (`basis: paid_for_tokens`), not tokens spent. | DROPPED | REMOVED (/terms, /wellbeing, FAQ and help no longer mention spending limits) | REMOVED (limit code, admin editor and flags deleted) |
| HF-PAY-8 | **Test credits before real top-up** (owner decision 2026-10-09). Until money-in is built, the only way to get balance is credits added by an admin (₹1–2000 each, logged). The call screen says "Test credits only for now". Real UPI top-up (HF-PAY-1) comes later and stays off until then. **[HF-WALLET-1 2026-10-09] Test credits are spend-only:** they live in `hf_credits` (not the withdrawable wallet), are used before paid balance on a call, and can never be withdrawn. A host's share of a call paid with test credits is recorded in `hf_host_test_earnings` and is never withdrawable; only the share from paid money reaches the host wallet (7-day hold). | ADOPTED | DONE (HF-CALLS-1, admin form + call screen) | TODO (HF-CALLS-1) |
| HF-PAY-9 | **Any gateway can plug in** (HF-TOPUP-1, 2026-10-09). Wallet top-up goes through a gateway-agnostic layer: the owner adds one gateway's keys, sets `hfTopupGateway=<razorpay\|cashfree\|paytm>` and flips `hfTopupEnabled`. Until both are done the /wallet page says "Adding money opens soon" and nothing is clickable. Real money is OFF by default; the main-app payment rails stay retired. Spec: Specs/HF-WALLET-TOPUP.md. | ADOPTED | DONE (dark) | TODO |
| HF-PAY-10 | **A top-up credits exactly once, only from the gateway's own word.** The webhook is signature-checked over the raw body, the amount and currency must match our stored order, and the gateway is asked server-to-server before any rupee moves; the wallet credit is deduped by `hftop:<id>`. Wrong amount / unknown order = ignored and logged. Unpaid top-ups expire after 24 h. Refunds of a top-up are handled by a person, never automatically. | ADOPTED | DONE (dark) | N/A |
| HF-PAY-11 | Top-up amounts are whole rupees between `hfTopupMinRupees` (50) and `hfTopupMaxRupees` (5000), quick packs from `hfTopupPacks`, 5 attempts per user per hour. The page shows "Test mode — no real money" whenever the gateway keys in use are test keys. | ADOPTED | DONE (dark) | TODO |
| HF-PAY-12 | **Host withdrawals are manual** (owner decision 2026-10-09; HF-PAYOUT-1). The host asks, an admin approves, the owner pays the host's verified bank account or UPI himself and enters the bank reference (UTR); only then is the request "paid". Minimum ₹500. Earnings are withdrawable 7 days after the call (the wallet hold). At most 2 requests a week. The host needs a verified Aadhaar and a verified bank account whose name matches it (HF-KYC-4). The asked amount is set aside in the wallet when the host asks and given back if the request is cancelled or rejected (the host sees the reason). Paid requests keep amount, UTR and dates for 8 years; on account deletion the host's identity is removed from them. Dark behind `hfPayoutsEnabled`. | ADOPTED | DONE (worker + dashboard + admin queue) | TODO |
| HF-PAY-13 | **Only money earned from calls the caller paid for with real money can be withdrawn.** Test-credit earnings (HF-PAY-8) and a host's own top-ups never can. Earnings from calls made before the wallet split (no paid/test record) are not shown as withdrawable; the admin settles those by hand if ever needed. | ADOPTED | DONE | N/A |
| HF-PAY-14 | **Pay out first, then delete** (owner decision 2026-10-10; HF-WALLET-EXIT-1). A user with real money (paid wallet balance, held earnings, or an open payout/refund) cannot delete the account until it is settled: deletion is PAUSED and the user is sent to `/account/close`. Starting it creates automatically a **final payout** for a host's withdrawable earnings (skips the ₹500 minimum and the weekly cap; still needs admin approval and a UTR) and a **refund** for a caller's unused top-up money (HF-PAY-15). Earnings still inside the 7-day hold: deletion waits, and the final payout is created when the hold ends. A host with no verified bank account must add one or explicitly give the earnings up. Test credits and test-credit earnings are simply dropped. While a closure is open the user cannot start calls, a closing host is taken offline and cannot go online, and no new top-ups are accepted. Once every final payout/refund is paid, or rejected by an admin with a reason, the normal deletion starts (30-day grace as today). The user can cancel while nothing has been approved. Users with no real money delete as before. The pages say: deletion completes after the money is settled. Gate on by default (`hfExitGateEnabled`); it only acts when real money exists. | ADOPTED | DONE | DONE (/account/close) |
| HF-PAY-15 | **Refunds of unused top-up money** (owner decision 2026-10-10; HF-WALLET-EXIT-1). A caller asks from `/wallet`; an admin approves; the money goes back to the ORIGINAL payment through the gateway, newest top-up first. Each top-up is refundable only within 180 days of paying (`hfRefundWindowDays`) and only up to its unspent part. Spending is assumed to use the oldest top-ups first, so the refundable amount is the smaller of (wallet paid balance minus the host-earnings part) and the in-window unspent top-ups. Money already spent on calls and test credits are never refundable; host earnings are withdrawn through payouts, never refunded. If the gateway refuses or the top-up is older than 180 days, an admin can mark the refund "paid by hand" with a UTR. Closing the account (HF-PAY-14) has no 180-day limit: older money is paid by hand. Dark behind `hfRefundsEnabled` (the `/wallet` section shows nothing while off). **Under tokens (HF-TOK-EXIT-1, flag `hfTokensEnabled`):** the refund is of unused PURCHASED tokens only, one request per purchase, amount = the unspent share of the rupees paid to Google (`paid × unused ÷ bought`), within 180 days of buying; test tokens are never refundable. An admin approves; if the whole order is unspent it is refunded through Google (Orders API), otherwise the admin refunds that share in the Play Console and records the rupees here. Only then the unused tokens are removed, once (op `hfrefund:<id>`). Token refunds do not wait for `hfRefundsEnabled`. Closing the account (HF-PAY-14) under tokens: every purchase with unused tokens becomes a refund request, test tokens are removed, open debts are written off (recorded), a host's INR earnings are paid out first (no ₹500 minimum, after the 7-day hold), closing is refused while the user is on a call, and an admin deleting an account with money left needs force + a note (audit logged). | ADOPTED | DONE (dark) | DONE (/wallet, /admin/hosts/refunds) |
| HF-PAY-16 | **Receipts now, GST tax invoices when a GSTIN is set** (owner decision 2026-10-10; HF-WALLET-LIMITS-1). The company is not GST-registered yet, so every paid top-up gets a plain numbered payment receipt (**under tokens: every purchase gets a "Purchase record — paid via Google Play" with order id, tokens, rupees paid and value per token; no GST, tax mode none_unregistered**; monthly tax invoices, once a GSTIN is set, use the platform share of token-era calls) (`<prefix>/R/<financial year>/<n>`, e.g. HF/R/2026-27/12), printable from /wallet, headed "Payment receipt — not a tax invoice". Once `hfGstin` (with `hfLegalName`, `hfLegalAddress`, `hfStateCode`, `hfInvoicePrefix`) is set in config, a monthly GST tax invoice (`<prefix>/I/<yy-yy>/<n>`) is issued per caller on the 1st (India time) for the PREVIOUS month: taxable value = the platform share of that caller's paid calls ÷ 1.18, GST 18% (the 18% is already inside the platform share, HF-PAY-6); CGST 9% + SGST 9%, or IGST 18% when the caller's state differs from the company's. The caller's state is not collected, so every caller is treated as in the company's state for now. Host charges are not on the invoice; a top-up itself carries no GST (it is money in the caller's own wallet). Numbers are gapless per financial year and never reused. With no GSTIN: receipts only, no invoices. | ADOPTED | TODO | DONE (dark with top-ups) |
| HF-PAY-17 | **Money reconciliation for the admin** (owner decision 2026-10-10). `/admin/hosts/reconciliation` shows, per India day: top-ups paid by gateway, wallet credits for top-ups, call charges paid vs test credits, host earnings and platform share (paid vs test), payouts paid with their UTR, refunds, and what is still owed (approximate, from the ledger). It lists anything that does not match: a paid top-up with no wallet credit, a wallet credit with no paid top-up, an amount that differs. A CSV download is available. Read only. | ADOPTED | N/A | DONE |
| HF-PAY-18 | **We keep our own proof of every rupee Vobiz takes** (owner decision 2026-10-10; HF-VOBIZ-SPEND-1). Every Vobiz leg of every call (host leg and caller leg, plus any call we did not make) is saved from the hangup webhook and checked again against Vobiz's own call record (CDR); rows are append-only and hash-chained so a changed row is detectable. Every 5 minutes the Vobiz balance is saved and compared with call costs (each call's cost is saved the moment it ends); money that no call explains is an "unexplained charge". Alerts by WhatsApp and email to the owner: unexplained charge over ₹20, balance under ₹500, a call we did not make, a cost per minute above the expected rate, account inactive/risk flag, Vobiz not answering, webhook vs CDR mismatch, broken chain. **Alerts only — calls are never paused automatically.** Records are kept **8 years** and are not part of the 1-year purge (HF-PRIV-6); full phone numbers are kept and shown to admins only (admin reads audited). `/admin/hosts/phone-costs` shows it live, per user, with PDF and CSV downloads; every night (23:55 IST) and on the 1st of the month a PDF + CSV + Vobiz's own CSV export are emailed to the owner's Gmail so the proof lives outside Vobiz and outside our servers. Recharges into Vobiz are typed in by the owner (Vobiz has no recharge API); a balance jump is recorded as a "detected" recharge for him to confirm. Plan: Specs/PLAN-2026-10-10-HF-VOBIZ-SPEND-MONITOR.md. | ADOPTED | N/A (admin only) | DONE |
| HF-PAY-19 | **Pack prices say they include 18% GST** (owner decision 2026-10-11; HF-GST-NOTE-1). The app's Add money section says "The price shown includes 18% GST." under the title, each pack shows "Includes 18% GST" under its price, the line under the packs reads "All prices shown include 18% GST. You pay through Google Play.", and the "Are you sure?" step says the price includes 18% GST. The owner has applied for a GSTIN and will claim the GST; the GSTIN goes on receipts once the number arrives (HF-PAY-16). **Open question for the owner:** HF-PAY-16 still says "a top-up itself carries no GST" — that line has not been changed and needs his decision now that pack prices are shown as GST-inclusive. | ADOPTED | N/A (app only) | N/A |

## 8. Wellbeing, mental health and attachment (added 2026-10-08)

The risk: a caller in a low state, or one who becomes attached to a host, is
refused or blocked and harms himself — and police or family blame the platform
or the host. We cannot remove this risk, but we must be able to show that we
took reasonable care, every time, with records. A disclaimer alone is not enough.

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-WELL-1 | Crisis numbers are visible on every key page and in every help area: **Tele-MANAS 14416** (free, 24×7) and **112**. We are not an emergency service. | ADOPTED | DONE | N/A |
| HF-WELL-2 | **Welfare detection:** when AI hears hopelessness or self-harm talk, it (a) plays a short message with 14416 and 112 during the call, (b) sends the same by WhatsApp after the call, (c) writes a welfare entry in the safety log. Never a strike. | PROPOSED | TODO | TODO |
| HF-WELL-3 | **A block is never shown as a rejection.** A blocked or limited caller only ever sees "This host isn't available right now." The host's name is never attached to a refusal. | PROPOSED | DONE (described: /wellbeing, terms, help, FAQ) | TODO |
| HF-WELL-4 | **Attachment detection:** AI and usage patterns flag a caller who calls the same host daily, long late-night calls, rising spend, or talk of love / "I can't live without you". | PROPOSED | DONE (described in host guide) | TODO |
| HF-WELL-5 | **Healthy-use limits on one host:** a daily minutes cap with the same host and a cooling-off gap; a gentle reminder that hosts offer friendly conversation, not relationships. The platform — not the host — ends the pairing if it continues. Numbers to be decided. | PROPOSED | DONE (described as coming at launch; numbers TBD) | TODO |
| HF-WELL-6 | **Host welfare training** (with the scam training): warning signs, what to do, what never to do, attachment boundaries, how to flag. See Appendix A. | ADOPTED (content PROPOSED) | DONE (/hosts/crisis-script = Welfare & crisis guide; help article) | N/A |
| HF-WELL-7 | **No misguiding:** hosts give no medical, medicine, legal, money or relationship advice, and never keep a vulnerable caller on the line for money. Doing so is a removal offence in the host agreement. | ADOPTED | DONE (host guide + host agreement clause) | N/A |
| HF-WELL-8 | **Signup acknowledgement** (checkbox) for callers. Proposed text in Appendix B. | PROPOSED | DONE (text published in terms) | TODO |
| HF-WELL-9 | **Terms and host agreement clauses** on: platform only connects calls; hosts are independent; not a crisis line; user responsible for own decisions; platform may limit any account for its wellbeing; host follows welfare script and indemnifies breaches. Lawyer to review. | PROPOSED | DONE (terms, disclaimer, host agreement — lawyer review pending) | N/A |
| HF-WELL-10 | **Caller age gate:** callers confirm 18+ at signup; minors are suspended. (Hosts already KYC.) | PROPOSED | DONE (stated) / TODO (signup step) | TODO |
| HF-WELL-11 | **Welfare page** for users: "Using Hello Fraands in a healthy way" — limits, attachment, where to get real help. | PROPOSED | DONE (/wellbeing) | N/A |

## 9. Legal protection (business)

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-LEG-1 | Register the Indian company **before calls go live**, so liability sits with the company, not the owner personally. Until then the site must not claim a company exists. | PROPOSED | N/A | N/A |
| HF-LEG-2 | Keep intermediary "due diligence" (IT Act s.79, IT Rules 2021): grievance officer, published rules, act on complaints. | ADOPTED | DONE (grievance, guidelines, intermediary pages) | TODO (complaint handling) |
| HF-LEG-3 | An Indian lawyer reviews the terms, host agreement, disclaimer and the wellbeing wording before launch. Ask about abetment-of-suicide exposure and a police-response plan. | PROPOSED | N/A | N/A |
| HF-LEG-4 | Consider liability insurance once the company exists. | PROPOSED | N/A | N/A |

## 10. Hosts

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-HOST-1 | Host onboarding (changed 2026-10-09): WhatsApp OTP → Aadhaar OTP (DigiLocker as fallback) → 10-second selfie video → UPI/bank check → avatar, about, languages, style, topics (max 6), one price, hours → AI profile media → host approves → admin approves → live. Own Indian number; the verified WhatsApp number is the number calls come to. Was: WhatsApp OTP → video KYC (Didit) → Aadhaar OTP. | ADOPTED | DONE (/hosts/join, /hosts/kyc) | TODO (mock at /hosts/onboarding, not deployed) |
| HF-HOST-2 | Regular host training on spam, scam and fraud calls (OTP asks, "KYC update", sextortion, emotional money stories). | ADOPTED | DONE | N/A |
| HF-HOST-3 | Hosts go online/offline any time and may decline any call. Never ask callers for money outside the platform (removal). | ADOPTED | DONE | TODO |

## 11. Site design and pages (added 2026-10-08)

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-SITE-1 | The help centre uses the **old "help skin v2" design** (terracotta hero, photo topic tiles, plum FAQ band, white panels, rail + on-this-page). Do not re-skin it. Only the art and copy are Hello Fraands; header/footer are the shared site ones. | ADOPTED | DONE | N/A |
| HF-SITE-2 | Old Aum Fe pages are **archived, not deleted** (kept for reuse): /rituals, /shop, /temples, /pandit, /guides, /desk, /watch, /book, /free-videos, /marketplace/page. Archived = URL still works, noindex, out of sitemap and menus (`web/src/lib/archivedPages.ts`). Archived pages wear the **Hello Fraands header and footer** — never the old brand's logo or menus (owner 2026-10-08, HF-ARCHIVE-RESKIN-1). | ADOPTED | DONE | N/A |
| HF-SITE-3 | /marketplace stays live and will be **re-skinned** for Hello Fraands. What it should list is to be confirmed. | ADOPTED | DONE (/marketplace = Explore: all hosts, mood/language/price/online filters, same cards as home; real cards replace samples later) | TODO |
| HF-SITE-4 | All other pages (content/legal pages, FAQ, wellbeing) get the **same full-width, responsive treatment as the front page**. Mock first, owner approves, then exact rollout. | ADOPTED | DONE (all HelloFraandsPage content/legal pages, FAQ, wellbeing) | N/A |
| HF-SITE-5 | Logged-in dashboard: give it the **new-look shell now** (front-page width, fonts, colours, menu); real Hello Fraands screens (wallet, favourites, call history, host earnings) are built when the backend is ready. | ADOPTED | DONE (shell: palette, fonts, width, logo, menu: Explore hosts, Favourites, Wallet, Billing, Profile) | TODO |
| HF-SITE-6 | **One standard type size on every page, matching the front page.** Root font size is a fixed 16px everywhere (no growing on wide monitors), header and footer are identical on every page, and no text is smaller than 14px. Never make tiny fonts. | ADOPTED | DONE (HF-TYPE-SCALE-1: global root fixed, help centre labels 11–13px → 14px, home/explore card labels → 14px, /talk-safely uses the shared header/footer) | N/A |
| HF-SITE-7 | **Two fonts only: Nunito for headlines, Comfortaa for everything else** (body, links, buttons, labels, forms). No Instrument Sans, Baloo, Kalam or other faces. Enforced in `web/src/styles/callvaal-chrome.css` (HF-FONTS-1). | ADOPTED | DONE | N/A |
| HF-NAV-1 | **Header must have "Explore" → /marketplace** (first item). | ADOPTED | DONE | N/A |
| HF-NAV-2 | **Every new public page gets a relevant link in the header or footer** in the same change (and the footer link-count checks in web/scripts are updated with it). Footer columns: Company · Hosts · Trust & Safety · Legal & Payments · Explore. | ADOPTED | DONE (so far) | N/A |

---

## 12. Host profiles and reviews (added 2026-10-09)

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-PROF-1 | Every host card has a full profile page (/people/<id>). The page shows everything the card shows — tagline, people talked to, regulars, voice introduction, languages, conversation style, topics, price per minute and the 10-minute estimate — plus About, a quote, reviews and "Before you call". Card and page read the same data so they never disagree. | ADOPTED | DONE (8 sample profiles) | TODO |
| HF-REV-1 | Callers can rate a host 1–5 stars and write a short review, optionally tagging the topic they talked about. | ADOPTED | DONE (demo form, nothing saved) | TODO |
| HF-REV-2 | Only a caller who has completed a paid call with that host can review them (one review per call). | PROPOSED | DONE (stated on page) | TODO |
| HF-REV-3 | Reviews are checked before they appear; phone numbers, emails, addresses and abusive text are blocked. Only the reviewer's first name is shown. | PROPOSED | DONE (stated on page; demo blocks numbers/emails) | TODO |
| HF-REV-4 | A review shows the reviewer's first name, stars, date, topic (if given), call length and a "Regular" tag for repeat callers; the page shows the average and a 5-to-1 star breakdown. | PROPOSED | DONE | TODO |

---

## 13. Verification, data protection, avatars and lanes (added 2026-10-09)

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-KYC-1 | India vendors: WhatsApp OTP through **WasenderAPI**; **Aadhaar OTP first, DigiLocker as fallback** (OTP: the person enters their Aadhaar number, we send an OTP to the mobile linked to it; the number is used only to request the OTP and is not stored. DigiLocker fallback, used when OTP is unavailable, no mobile is linked or attempts are exhausted: the person signs in and approves sharing their e-Aadhaar. We receive name, DOB, gender, address, guardian name and photo) and bank/UPI checks, both through **Sandbox.co.in** (about ₹1 per Aadhaar check, ₹0.75 per bank check). Changed 2026-10-09: DigiLocker only, then the same day to OTP first with DigiLocker as fallback (owner decision). **Didit is kept only for future international hosts.** | ADOPTED | DONE (/hosts/kyc names "licensed verification partner") | TODO |
| HF-KYC-2 | We keep **only the last 4 digits of Aadhaar** plus the partner's verification reference — never the full number. We keep name, gender, DOB, address, father's/guardian's name and photo received from UIDAI (OTP) or DigiLocker, encrypted, in private storage, access logged. | ADOPTED | DONE (/hosts/kyc, /privacy) | TODO |
| HF-KYC-3 | Liveness = our own **10-second selfie video** where the host reads a random code shown on screen; an admin compares it with the Aadhaar photo. Private storage, consent required, deleted when no longer needed. | ADOPTED | DONE (/hosts/kyc) | TODO |
| HF-KYC-4 | Host payouts: **UPI ID + bank account (account no. + IFSC)** checked with a no-deposit bank check; the account name must match the Aadhaar name (from OTP or DigiLocker). | ADOPTED | DONE (/hosts/kyc) | TODO |
| HF-KYC-5 | **Callers**: WhatsApp number (OTP) + the number they receive calls on (may be the same), wallet top-ups by UPI. No Aadhaar unless they join a protected lane or become a host. | ADOPTED | DONE (/privacy) | TODO |
| HF-PRIV-6 | We follow India's **DPDP Act 2023 and DPDP Rules 2025**: clear notice + consent, never sell data, encrypted and access-logged, keep host data while hosting + 1 year (records at least 1 year), rights to see/correct/delete/withdraw consent/nominate/complain (reply within the legal limit, 90 days), breach notice to users and the Data Protection Board. Pages say we *follow* the law — never "certified". Every promise on a page must be built before launch. | ADOPTED | DONE (/hosts/kyc, /privacy, FAQ, help article) | DONE (HF-RETENTION-1) |
| HF-AVA-1 | Everything AI-generated is labelled: "AI avatar chosen by the host", "AI images". (The host's own voice introduction is labelled "Recorded by the host", not AI.) Labels small but never under 14px and never hidden (IT Rules 2026). Privacy line on home, join and profile: number masked + AI avatar. | ADOPTED | DONE (privacy line, FAQ) | TODO |
| HF-AVA-2 | Host's own recorded introduction (30 s–5 min, about 1 min suggested), admin-reviewed, plays on the card and the profile page, labelled "Recorded by the host". Gemini transcribes it and flags contact details. No voice cloning. Example scripts in Hindi and English are shown in onboarding. (Owner 2026-10-09, HF-VOICE-INTRO-1; replaces the earlier voice-clone rule.) | ADOPTED | DONE (/privacy, /hosts/kyc, FAQ, help) | TODO |
| HF-AVA-3 | ~~Sample conversation is labelled "Sample conversation — AI voices, not a real call".~~ **DROPPED 2026-10-09:** the AI sample conversation is removed; hosts record their own introduction instead (see HF-AVA-2). | DROPPED | N/A | N/A |
| HF-AVA-4 | Avatar catalogue: chosen by gender, age, look, style; fully clothed everyday images; no body-shape filters; fully synthetic; exclusive to one host. | ADOPTED | N/A | TODO |
| HF-AVA-5 | **No real photos of hosts, ever** (stalking risk). Profile image + gallery are AI only. Photo avatars, not video (owner 2026-10-09; video parked). | ADOPTED | DONE (FAQ) | TODO |
| HF-LIST-1 | **One price per host for all topics**, ₹5 floor. | ADOPTED | DONE | TODO |
| HF-LIST-2 | Per host we generate 1 profile image + 5 gallery images (the host records their own voice introduction, see HF-AVA-2; no AI sample conversation since 2026-10-09). Regeneration limits TBD. | ADOPTED | N/A | TODO |
| HF-LGBT-1 | **LGBTQ+ space**: a private lane where LGBTQ+ callers talk to LGBTQ+ hosts; hidden from everyone else. Friendship and conversation only; all conduct rules apply. | ADOPTED | DONE (/lgbtq, FAQ, help) | TODO |
| HF-LGBT-2 | Joining is **self-declared and private by default** — we never guess. Showing "LGBTQ+ friendly" on the public profile is a **separate opt-in**, changeable any time. Orientation is sensitive data: private storage, never sold. | ADOPTED | DONE (/lgbtq) | TODO (mock toggles built) |
| HF-LGBT-3 | **Callers in the lane must be verified** (Aadhaar OTP, DigiLocker as fallback), because the lane is a known target for extortion. | ADOPTED | DONE (/lgbtq) | DONE (HF-LANE-VERIFY-1: caller side; calls pending) |
| HF-LGBT-4 | AI safety in the lane watches for threats, money demands and "outing" threats; # ends and blocks; reports go to priority review. | ADOPTED | DONE (/lgbtq safety section) | TODO |

---

## 14. Android app (added 2026-10-10)

The app is the website inside an Android shell (Capacitor). Spec: `Specs/SPEC-2026-10-10-HF-ANDROID-APP.md`. Decisions D1 to D11 of that spec are adopted with the owner's approval of the spec (2026-10-10); each row below carries the spec's decision id.

| ID | Rule | Decision | Pages | Backend |
|---|---|---|---|---|
| HF-APP-1 | **Wrap the website with Capacitor** (spec D1): no Flutter rebuild, no page rebuild. Project in `hf-app/`, built only in CI (`.github/workflows/hf-android.yml`, started by hand; magic words "ship hf"). | ADOPTED | N/A | TODO |
| HF-APP-2 | **Package `com.hellofraands.app`** (spec D2), permanent. Never reuse `com.saathum.app`. Stored as `hfPlayPackageId` in `Specs/brand.json`. | ADOPTED | N/A | TODO |
| HF-APP-3 | **First track is Play Internal testing**, tester `hdavy2005@gmail.com` only (spec D3). | ADOPTED | N/A | TODO |
| HF-APP-4 | **Play Console work only in the `hdavy2005@gmail.com` account** (developer account AvaGlobal Inc, reached at `/console/u/1/`), checked every time (spec D4). Never act in another Google account. | ADOPTED | N/A | N/A |
| HF-APP-5 | **The app loads the live site**, not a bundled copy (spec D5); a small bundled offline page shows when there is no network. | ADOPTED | N/A | TODO |
| HF-APP-6 | **Calls stay normal phone calls.** The app adds no phone, SMS, contacts, call-log or location permissions (spec D6). Complete permission list: INTERNET, CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, POST_NOTIFICATIONS. | ADOPTED | N/A | TODO |
| HF-APP-7 | **Admin pages stay web-only**; the app never links to `/admin/*` (spec D7). | ADOPTED | N/A | TODO |
| HF-APP-8 | **Callers buy tokens with Google Play Billing inside the app** (spec D8, supersedes "top-up hidden in the app"). The website says "Download the app to add tokens". Full token model in spec section 11. | ADOPTED | N/A | TODO |
| HF-APP-9 | **Push notifications are added**, with WhatsApp kept as the fallback for people on the website (spec D9). | ADOPTED | N/A | TODO |
| HF-APP-10 | **A new upload key for this app only** (`hf-upload.jks`); Google Play App Signing holds the real app key (spec D10). The key and its passwords are never committed. | ADOPTED | N/A | N/A |
| HF-APP-11 | **Calls paid with Play tokens start only in the app** (spec D11). On the website the Call button says "Open the app to call"; admin test credits still work on the web. | ADOPTED | N/A | TODO |

---

## Implementation plan — public pages first (backend not ready)

**Phase 1 — public pages (can do now):**

1. **Host welfare training** — expand `/hosts/crisis-script` into a full welfare
   and attachment guide (Appendix A). Link from host rules, join page and the
   help article on rude/scam callers. → HF-WELL-6, HF-WELL-7
2. **Wellbeing page for users** — new `/wellbeing` page ("use it in a healthy
   way"), linked from the footer, safety centre, FAQ and help. → HF-WELL-11
3. **Terms, disclaimer and host agreement clauses** — add the wellbeing,
   not-a-relationship, independent-host and no-misguiding clauses; mark for
   legal review. → HF-WELL-7, HF-WELL-9
4. **Publish the signup acknowledgement and pre-call notice text** in the terms
   and FAQ so it is on record before the backend shows it. → HF-WELL-8, HF-CALL-5
5. **Help centre** — new articles: "Hosts are friends, not partners",
   "Healthy limits and cooling-off", "For hosts: spotting distress and
   attachment". Add matching FAQ entries. → HF-WELL-3/4/5/6
6. **Mark planned features honestly** — daily time caps are
   described as "coming with launch", not as live.

**Phase 2 — backend (later, build to these rules):** safety log (HF-PRIV-4),
welfare detection (HF-WELL-2), block-as-unavailable (HF-WELL-3), attachment
detection and limits (HF-WELL-4/5), signup checkbox and
age gate (HF-WELL-8/10), pre-call notice (HF-CALL-5).

**Phase 3 — business:** company registration (HF-LEG-1), lawyer review
(HF-LEG-3), insurance (HF-LEG-4).

---

## Appendix A — Host welfare training (draft content)

**Warning signs of distress:** "No one will miss me", "I won't be here
tomorrow", saying goodbye, giving things away, talk of a method or a date,
sudden calm after deep sadness, "you are the only reason I am alive".

**What to do:** stay calm and kind · listen, don't argue · don't counsel or
diagnose · don't promise to keep it secret · give **Tele-MANAS 14416** and
**112** · flag the call as a welfare concern after it ends.

**Signs of attachment:** calls you every day, wants only you, says "I love you",
asks for your number, photo or meeting, gets angry when you are offline, spends
far more than before.

**What to do:** never flirt or say "I love you too" · never promise "I'll always
be there" · never share contact details or meet · keep it friendly and general ·
flag the caller early — **the platform limits or ends the pairing, not you**,
and he only sees "host not available".

**Never:** give medical, medicine, legal, money or relationship advice · keep a
caller on the line for money · encourage dependence.

## Appendix B — Proposed wording (for lawyer review)

**Signup checkbox (callers):** "I understand Hello Fraands is friendly
conversation, not counselling, therapy or a relationship service. Hosts are
independent people and are not mental-health professionals. If I am in crisis I
will call Tele-MANAS 14416 or 112. I am 18 or older."

**Pre-call spoken notice:** "This is a friendly chat, not counselling. In
crisis, dial 14416."

**Limit message:** "This host isn't available right now. You can talk to someone
else, or come back later."

---

## Change log

| Date | Change |
|---|---|
| 2026-10-10 | HF-PAY-18 changed (HF-VOBIZ-SPEND-2): the Vobiz balance check runs every 5 minutes, not every minute — adding a 1-minute cron trigger stopped every scheduled job on the worker, so it was removed. Each call's cost is still saved the moment the call ends. |
| 2026-10-10 | HF-PAY-18 added (HF-VOBIZ-SPEND-1): Vobiz spend monitor — hash-chained ledger of every Vobiz leg, every-minute balance check, WhatsApp/email alerts (alerts only, no auto-pause), admin Phone costs page with PDF/CSV, nightly and monthly emailed proof. Records kept 8 years with full numbers (admin only). |
| 2026-10-10 | HF-APP-1: Android app (Capacitor wrapper of the live website) approved and scaffolded in `hf-app/`; new section 14 (HF-APP-1 to HF-APP-11 = spec decisions D1 to D11); HF-CALL-3 reworded to "No app needed for calls; the Android app is optional". Spec: Specs/SPEC-2026-10-10-HF-ANDROID-APP.md. |
| 2026-10-10 | HF-TOK-EXIT-1: tokens exit side behind hfTokensEnabled. "Balance can be transferred back to UPI" (HF-PAY-5) DROPPED: refunds now go back through Google Play (HF-PAY-15, 180 days), account closing refunds unused purchased tokens first (HF-PAY-14), per-second billing and limits on rupees paid to Google (HF-PAY-2, HF-PAY-7), purchase records instead of top-up receipts (HF-PAY-16), token reconciliation (HF-PAY-17), 8-year retention of hashed token money records. Public pages reworded: /terms, /wellbeing (limits ₹2,000 a day and ₹15,000 a month), /wallet-terms, /refunds, /community-guidelines, /faq, /data-deletion and the help articles. |
| 2026-10-10 | HF-WALLET-EXIT-1: pay-out-first account closure (HF-PAY-14) and refunds of unused top-ups to the original payment (HF-PAY-15). New /account/close, /wallet refund section, admin Wallet refunds page, exit badge on host payouts. Refunds dark behind hfRefundsEnabled; the closure gate is on (hfExitGateEnabled) but acts only when real money exists. |
| 2026-10-09 | HF-PRIV-6 backend DONE (HF-RETENTION-1): daily purge deletes call records and safety incidents after 1 year, KYC OTP ledger after 30 days, notifications after 90 days, abandoned host drafts and idle lane callers after 1 year; account deletion now removes all verification records, voice intro and profile media. |
| 2026-10-09 | HF-TOPUP-1: gateway-agnostic wallet top-up built, dark (HF-PAY-9/10/11). Needs a gateway's keys + `hfTopupGateway` + `hfTopupEnabled`; see Specs/HF-WALLET-TOPUP.md. |
| 2026-10-10 | HF-WALLET-LIMITS-1: owner decided the spending limits (HF-PAY-7 ADOPTED: ₹2,000 a day, ₹15,000 a month, real money only; confirm step from ₹1,000); receipts now and GST tax invoices once a GSTIN is set (HF-PAY-16); admin reconciliation report (HF-PAY-17). Dark with calls and top-ups. |
| 2026-10-09 | HF-PAYOUT-1: manual host withdrawals (HF-PAY-12, HF-PAY-13): request, admin approval, owner pays and enters the UTR; ₹500 minimum, 7-day hold, paid-funded earnings only. Dark behind hfPayoutsEnabled. |
| 2026-10-09 | HF-WALLET-1: test credits moved out of the paid wallet into hf_credits (spend-only); host share from test-credit calls is non-withdrawable (HF-PAY-8). New /wallet page. |
| 2026-10-09 | HF-CALLS-1 (web): call button + call flow, Notify me (HF-CALL-6) and test credits (HF-PAY-8) added; host dashboard /hosts/dashboard, review page /review/<token>, ratings on cards and profile pages, admin call reviews and calls/credits pages. All behind hfCallsEnabled. |
| 2026-10-09 | HF-KYC-1 changed: Aadhaar OTP → DigiLocker (owner decision; UIDAI deprecated OKYC). Site copy updated on /hosts/kyc, /hosts/join, /privacy, /lgbtq, women-only dialog and help articles; HF-WOM-2, HF-HOST-1, HF-LGBT-3 wording follows. Everything else in KYC unchanged. |
| 2026-10-09 | Section 13 added (HF-DPDP-COPY-1): India KYC = WasenderAPI WhatsApp OTP + Sandbox.co.in Aadhaar OTP + own selfie video + UPI/bank check; Didit kept for international. Only last 4 Aadhaar digits kept. DPDP Act 2023 wording on /hosts/kyc, /privacy, FAQ, new help article. AI-avatar rules, one price, LGBTQ+ lane (new /lgbtq page, footer link). HF-HOST-1 and HF-WOM-2 updated (Didit removed). |
| 2026-10-09 | HF-KYC-1 changed: Aadhaar OTP first, DigiLocker as fallback (owner decision). Web onboarding Aadhaar step is two-mode; site copy and HF-KYC-2/4, HF-WOM-2, HF-HOST-1, HF-LGBT-3 wording follow. |
| 2026-10-09 | HF-VOICE-INTRO-1 (owner): voice cloning and the AI sample conversation dropped. Hosts record their OWN introduction (30 s min, ~1 min suggested, 5 min max) with Hindi/English example scripts; admin reviews it with a Gemini transcript and contact-detail flags; once approved it plays on the card and profile as "Recorded by the host". HF-AVA-1 label list no longer has "AI voice clip"; HF-AVA-2 rewritten; HF-AVA-3 DROPPED; HF-LIST-2 updated. |
| 2026-10-09 | Section 12 added (HF-PROFILE-DETAIL-2): profile pages now show every card field, sample reviews with star breakdown and a demo "Write a review" form; all 8 sample cards link to a profile page. HF-PROF-1 and HF-REV-1 adopted (owner asked for them); HF-REV-2..4 proposed — owner to confirm. |
| 2026-10-08 | Full-site consistency pass (HF-CONSISTENCY-1): every page audited at desktop and phone width — all text Comfortaa/Nunito, nothing under 14px, help-centre reading text raised to the front page's 18px, green help pills and the mint safety card recoloured, 404 and "page removed" pages given the Hello Fraands header/footer, fonts and copy (they still mentioned havans and pujas). |
| 2026-10-08 | HF-SITE-7 added (owner): Nunito for headlines, Comfortaa for all other text on every page (HF-FONTS-1). |
| 2026-10-08 | Sign in / Sign up pages: old Ganesh, lotus and Suswagatam artwork replaced with Hello Fraands art (friendship collage, notebook + chai) on cream/lilac panels; old "Creator Marketplace" and "Light a diya" text replaced (HF-AUTH-ART-1). |
| 2026-10-08 | HF-SITE-2: archived pages (/free-videos, /pandit, /temples, /guides, /shop) re-skinned with the Hello Fraands header and footer; old logo and menus gone (HF-ARCHIVE-RESKIN-1). |
| 2026-10-08 | HF-SITE-6 added (owner: one standard font size like the front page). Help/blog/dashboard pages no longer grow header, footer and text on wide monitors; tiny labels raised to 14px; /talk-safely got the real header/footer (HF-TYPE-SCALE-1). |
| 2026-10-08 | Full-width front-page look rolled out to content pages, FAQ and wellbeing (HELLO-FRAANDS-WIDE-1); /marketplace re-skinned as Explore (HELLO-FRAANDS-EXPLORE-1); header "Explore" + footer "Explore all hosts" added, HF-NAV-1/2 recorded; dashboard new-look shell (HELLO-FRAANDS-DASH-SHELL-1). |
| 2026-10-08 | Section 11 added. Help centre restored to the old help skin v2 design with Hello Fraands art/copy (HELLO-FRAANDS-HELP-RESTORE-1); old Aum Fe pages archived (HELLO-FRAANDS-ARCHIVE-1). Site-wide front-page treatment, marketplace re-skin and dashboard shell pending owner approval of mocks. |
| 2026-10-08 | Footer: added "Help centre" (/help) to the Company column (HELLO-FRAANDS-FOOTER-HELP-1). |
| 2026-10-08 | Owner decision: limit numbers (daily minutes with one host, cooling-off gap, daily spending cap) are deliberately left open for now — pages keep saying they will be published before launch. Do not invent numbers. (HF-WELL-5, HF-PAY-7) |
| 2026-10-08 | Phase 1 public pages for wellbeing done (HELLO-FRAANDS-WELL-1): new /wellbeing page; /hosts/crisis-script expanded into the Welfare & crisis guide (footer label renamed); wellbeing, healthy-use-limit and acknowledgement clauses in terms; not-a-relationship/crisis section in disclaimer (Hindi recording text fixed); wellbeing duties in host agreement; 2 help articles; 4 FAQ entries. Backend items unchanged (TODO). Limit numbers still to be decided by owner. |
| 2026-10-08 | Rulebook created. Sections 1–7, 9–10 record decisions already made and shipped on the public site (FAQ, policy pages, help centre deployed 2026-10-08). Section 8 (wellbeing) added from the owner's mental-health concern; most items PROPOSED pending owner decisions on numbers. |
| 2026-10-09 | HF-LANE-VERIFY-1: caller verification for the women-only and LGBTQ+ lanes is built (/verify/lane, /api/hf/lanes/*, hf_lane_access). Women lane needs Aadhaar F/T; LGBTQ+ needs a private self-declaration + Aadhaar. HF-WOM-2, HF-LGBT-3 Backend DONE; calls to lane hosts still pending. |
| 2026-10-10 | HF-NATIVE-13: owner replaced the Capacitor wrapper (too slow) with the native Flutter app in `hf-flutter/` (same package com.hellofraands.app, built by `.github/workflows/hf-flutter.yml`). `hf-app/` and `hf-android.yml` deleted at the owner's request. Decision HF-APP-D1 (wrap the website) is SUPERSEDED. |
| 2026-10-10 | HF-NOLIMITS-1: daily/monthly spend limits removed by owner decision. HF-PAY-7 DROPPED; `hfDailySpendLimitRupees` / `hfMonthlySpendLimitRupees` flags, admin per-user limit override and the `limit` / `spend_limit` errors deleted; limit text removed from /terms, /wellbeing, FAQ, help and the wallet screens. The "Are you sure?" top-up step stays. The `hf_spend_limits` table and `hf_calls.limit_cap_rupees` column are left in D1, unused. |
| 2026-10-10 | HF-WALLET-RUPEES: no tokens; wallet is rupees. Packs ₹120/240/600/1200 add ₹102/204/510/1020. Calls charge the host rate in rupees. |
| 2026-10-11 | HF-GST-NOTE-1: the app's Add money section now says the pack price includes 18% GST (HF-PAY-19). GSTIN on receipts waits for the number. HF-PAY-16's "a top-up carries no GST" line flagged for the owner, not changed. |
