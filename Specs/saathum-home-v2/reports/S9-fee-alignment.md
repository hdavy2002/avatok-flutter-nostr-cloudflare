# S9 — Fee alignment audit (D1, AC-16)

Read-only audit. Nothing in this section was changed. Repo root is the S9 worktree
(`/Users/davy/.cache/deepastra/saathum-home-v2/s9`); paths below are relative to it
unless stated otherwise. `node_modules` excluded from all searches.

## 0. What D1 actually requires (contracts §4 / spec A6.1)

```
SLOT_MINUTES = 30
TIME_FEE_PER_SLOT_INR = 50   (= ₹100/hour, additive, per participant, per booked slot)
PLATFORM_SHARE = 0.20        (of the organiser's own price A; independent of length)
```

`ticketPrice T = baseForHours(H) + A` where `A` is the organiser's price. The platform
keeps `baseForHours(H)` (the time fee, 100% of it) **plus** `0.20 * A`. The organiser
keeps `0.80 * A`. This is additive: the buyer pays the organiser's price *plus* a
separate time fee, and the organiser's own cut is untouched by event length.

This is **not the same formula** as any of the three legacy implementations found below
— none of them add a separate time fee on top of the price; all of them carve the
platform's cut out of a single price number. Treat "matches D1" below as "produces the
same headline numbers for the A6.3 vectors", not "is the same formula".

## 1. Audit table

| # | File:line | Current value / claim | What D1 requires | Category | Proposed change |
|---|---|---|---|---|---|
| 1 | `worker/src/lib/session_pricing.ts:135,138,143,158-162` | `FLAT_TOKENS_PER_HOUR=25`, `COMMISSION_PCT=20`; `sessionFeeFor(price)` = `fee = 25 + round((price-25)*20/100)`, carved out of one price number, not additive | `TIME_FEE_PER_SLOT_INR=50`/30min additive + `PLATFORM_SHARE=0.20` of A | worker logic (module exists, but **not called by any live route** — see finding 1a) | Retire `sessionFeeFor`/`sessionSplitFor`/`FLAT_TOKENS_PER_HOUR`/`COMMISSION_PCT` once nothing depends on the comment/test contract below, or repoint them at the new formula. Do not touch without Gate G4. |
| 1a | `worker/test/session_fee_settlement_split.test.ts` (whole file) | Locks `sessionFeeFor(600)==={fee:140,creator:460}` etc. — the only caller of `sessionFeeFor`/`sessionSplitFor` in the repo | N/A | test | Tests currently guard dead-for-checkout code (see finding 2). Confirm with coordinator whether this module is still load-bearing for anything (e.g. a future settlement path) before deleting; if not, retire test + module together. |
| 2 | `worker/src/routes/config.ts:37,2028` | `sessionFeeRuleEnabled: boolean`, default `true` in `DEFAULTS`. Comment (`config.ts:31-35`) says `commercialCreatorFeePct` is now only the **fallback** used when this flag is `false`. | N/A directly, but this is the switch Gate G4 must flip/extend | config flag | See Gate G4 §3. |
| 3 | `worker/src/routes/config.ts:24-25,2024` | `commercialCreatorFeePct: number`, default `80` — pure percentage-of-subtotal split, used only when `sessionFeeRuleEnabled===false` (`feePolicy:"legacy_percentage"`) | Not used by D1 at all (D1 has no pure-percentage lane) | config | Leave as the historical fallback; do not repurpose it to hold `PLATFORM_SHARE`. |
| 4 | `worker/src/lib/session_pricing.ts:64-96` (`commercialQuoteFor`) — **this is the function real checkouts call today** | `feePolicy:"creator_subtotal_plus_fee"` (the live default, since finding 2's flag defaults `true`): `platformFeePerSeat = roundMoneyRatio(100, bookedMinutes, 60)` (**= ₹100/hour = ₹50/30min already**), `grossAmount = subtotal + platformFeeAmount` (**additive, already matches D1's `T = base + A` shape**) but `creatorAmount = subtotal` — **the organiser keeps 100% of their price, no 20% commission is deducted anywhere in this policy.** | Time fee ✅ already correct. Missing: the `0.20 * A` platform commission on top of the time fee. | worker logic — **this is the one real gap, not the ₹25 figure** | See Gate G4 §1. This is the actual "move live checkout to D1" change — the time-fee half is already done; only the 20%-of-A commission is missing from `creator_subtotal_plus_fee`. |
| 5 | `worker/src/routes/commercial_checkout.ts:188` | `feePolicy: config.sessionFeeRuleEnabled === false ? "legacy_percentage" : "creator_subtotal_plus_fee"` | — | worker logic (call site) | Same policy selection would carry a new `"creator_subtotal_plus_commission"` policy if Gate G4 is approved. |
| 6 | `worker/src/routes/commercial_stream_sessions.ts:991-998` | Same feePolicy selection, for live-event ticket extension pricing | — | worker logic (call site) | Same as #5. |
| 7 | `worker/src/money_engine.ts:138` | `const feeRate = ((o as any)?.fee_pct ?? 20) / 100;` — a silent **20%-of-gross** fallback if an order's `fee_pct` column is ever null | Not D1-shaped (D1's 20% applies to A only, not to gross which includes the time fee) | worker logic | Flag for the coordinator: this fallback pre-dates the additive time-fee model and would misprice release() for any order missing `fee_pct`. Out of scope to fix here. |
| 8 | `worker/migrations/phase7.sql:8` | `ALTER TABLE orders ADD COLUMN fee_pct INTEGER DEFAULT 20;` — D1 column default | — | D1 migration | Historical; a `DEFAULT` only applies to a column value at insert time when omitted — every current insert path sets `fee_pct` explicitly (`commercial_checkout.ts`, `commercial_stream_sessions.ts`, `listings.ts:4601`), so this default is effectively dead but not misleading in a way that needs an ALTER. Report only. |
| 9 | `worker/migrations/2026-08-24-commercial-stream-sessions.sql:19` | `creator_fee_pct INTEGER NOT NULL CHECK (creator_fee_pct BETWEEN 0 AND 100)` — schema, no default value | — | D1 migration | No change needed; schema is policy-agnostic. |
| 10 | `web/src/lib/listingTaxonomy.ts:135-192` (**generated**, from `scripts/gen_listing_taxonomy.py:110-154`) | `PRICING.flatTokensPerHour=25`, `PRICING.commissionPct=20`, `PRICING.minPriceTokensPerHour=49`; `feeSplit()` mirrors `sessionFeeFor` exactly. Comment at `listingTaxonomy.ts:137-140,182-185` labels this "FOR DISPLAY ONLY" | Time fee ₹50/30min + 20% of A | generated (PRICING fallback + its Python generator) | Do not hand-edit `listingTaxonomy.ts` (generated-file rule). If Gate G4 is approved, the generator source (`scripts/gen_listing_taxonomy.py`) and whatever source-of-truth JSON it reads must change together, then regenerate. |
| 11 | `web/src/islands/dashboard/listing-form/steps.tsx:471-474,538,552,570` | Wizard copy: `"At ₹{price}/hr, Saathum takes ₹{split.fee} and you keep ₹{split.creator}."`, `"₹{PRICING.flatTokensPerHour} flat + {PRICING.commissionPct}% of what's left. A 2-hour booking bills the flat fee twice."`, a worked `₹250 → ₹205` example | Would need to become an additive-time-fee-plus-20%-of-A explanation if Gate G4 ships | app/web listing wizard (creator-facing, not owned by S9) | Out of S9's file ownership (`web/src/pages/pricing-fees.astro` only). Flag for whichever agent/gate owns the wizard once G4 is decided. |
| 12 | `web/src/islands/dashboard/listing-form/wizardLogic.ts:343-347` | Price-floor error: `"The lowest price is ₹{PRICING.minPriceTokensPerHour}/hour — below that, Saathum's flat fee leaves you with nothing."` | The ₹49 floor rationale is specific to the ₹25-flat formula; D1's additive time fee never leaves the organiser with ₹0 the same way (organiser always keeps 80% of whatever `A` they set, even `A`→0 is fine per A6.1 "if A=0, show all-zero results") | app/web listing wizard | Out of ownership. Flag: this floor and its message would need to be re-derived (or dropped) if G4 ships, since D1 has no equivalent "flat fee eats everything" failure mode. |
| 13 | `worker/src/lib/listing_promos.ts:93,114-115` | Comment: `"MIN_PRICE_TOKENS_PER_HOUR (49) exists because sessionFeeFor charges a ₹25 FLAT fee"`; promo-discount clamp uses the same floor | Same as #12 | worker logic | Comment + clamp both encode the ₹25/20% rationale; would need re-deriving under G4. |
| 14 | `app/lib/core/listing_groups.dart:182-184,281-286` | Flutter: `kListingPricingFlatTokensPerHour=25`, `kListingPricingCommissionPct=20`, `kListingPricingMinPriceTokensPerHour=49` — third independent copy of the same formula | Same gap as #10 | app (Flutter, read-only per brief) | Flag only — Flutter changes are out of scope for every Saathum-home-v2 agent. |
| 15 | `app/lib/features/marketplace/native_listing/native_listing_wizard_screen.dart:1523-1530,2051` | Flutter: `_kFlatTokensPerHour=25`, `_kCommissionPct=20`, plus the same wizard sentence (`UiMessage.m_the_platform_fee_is_kflattokensperhour...`) — a **fourth** copy | Same gap | app (Flutter, read-only) | Flag only. |
| 16 | `app/lib/core/localization/ui_messages.dart:4905,6540` + `app/localization-followup-coverage.json:3767-3772,3924` | Two localized template strings embedding `{kFlatTokensPerHour}`/`{kCommissionPct}` and `₹{flatFee} flat + {commission}%...` | Same gap | app (Flutter, read-only) | Flag only. |
| 17 | `web/src/pages/index.astro:71`, `web/src/pages/landing-steps-preview.astro:69`, `web/src/components/OriginalGlobalSections.astro:36,44,47` | `"<strong>80%</strong> you keep"` / `"Local currency. Direct to your bank. You keep 80%."` — an **"80% you keep"-style claim**, matching `commercialCreatorFeePct` default (finding #3), **not** the D1 organiser-share number (D1's organiser share is also 80% of `A`, so the headline number happens to coincide, but the underlying mechanic these pages describe — a flat 80/20 split of the whole listing price, with no separate time fee — is not what D1 specifies) | If D1 ships, "you keep 80%" is still numerically true of the *A* leg only; these pages don't distinguish "80% of your price" from "80% of the whole charge" | public copy (homepage — **owned by S4**, `OriginalGlobalSections.astro` — **unowned/legacy**, `landing-steps-preview.astro` — **unowned preview page**) | Out of S9 ownership (S9 owns only `pricing-fees.astro`). Flag for S4/coordinator: today's "you keep 80%" claim is ambiguous between the legacy flat-80/20 split and D1's "80% of your own price plus a separate time fee"; worth a wording pass once G4 ships. |
| 18 | `web/src/content/help/billing/platform-fee.md` (whole file) | Deliberately prints **no percentage** — explicitly says Saathum is "moving to a new fee structure" and the number shown while pricing a listing "isn't yet the one used at payout" | N/A | public copy (help article) | No violation found — this article already hedges correctly and needs no change. Linked from `pricing-fees.astro`'s `helpHref`. |
| 19 | `web/src/pages/pricing.astro`, `web/src/pages/pricing-preview.astro` | Checked — no ₹25/hour, no 20%/80% commission claim, no session-fee content of any kind (these pages describe unrelated per-minute video/calling/token pricing, all still "coming soon" placeholders) | N/A | public copy | No violation found. |
| 20 | `worker/src/cal/emails.ts`, `worker/src/lib/agent_live/emails.ts` | Checked — no fee-percentage or ₹25/hour language in either email template module | N/A | emails | No violation found. |

## 2. Gate G4 proposal (describing only — NOT applying)

**Scope:** move the *live checkout* additive-time-fee-plus-commission gap (finding #4)
so a real booking bills `baseForHours(H) + A` with the platform keeping
`baseForHours(H) + 0.20*A` and the organiser keeping `0.80*A`, matching D1 exactly.

**The change is smaller than it looks**, because `commercialQuoteFor`'s
`"creator_subtotal_plus_fee"` policy already does the additive ₹100/hour time fee
(finding #4) — the missing piece is a second deduction of `0.20 * subtotal` from
`creatorAmount` before it is returned, i.e. either:

- (a) add a new `feePolicy` value, e.g. `"creator_subtotal_plus_fee_and_commission"`,
  that computes `commissionAmount = roundMoneyRatio(subtotal, 20, 100)` and sets
  `creatorAmount = subtotal - commissionAmount`, `platformFeeAmount =
  timeFee + commissionAmount`, `grossAmount = subtotal + timeFee` (unchanged); or
- (b) fold the 20% into the existing `"creator_subtotal_plus_fee"` policy directly.

(a) is safer — it does not change the meaning of the policy string already stored on
every `commercial_policy_snapshots` row written since `creator_subtotal_plus_fee`
became the default, so old snapshots keep re-verifying under
`commercialQuoteError`/`authorityError` without a migration. (b) is a silent
retroactive-looking change if anyone ever re-derives a quote from policy metadata
instead of the frozen snapshot (the code comments say snapshots are the only source of
truth, but the safer option costs nothing).

**Risks:**

1. **Settlement snapshot immutability.** `commercial_policy_snapshots` freezes
   `creator_fee_pct`/`platform_fee_amount`/`creator_amount` at checkout
   (`session_pricing.ts:196-209` docstring, `commercial_checkout.ts:1330`,
   `commercial_stream_sessions.ts:1132`). A new fee policy must **only** apply to
   quotes computed at a **new** checkout — it must never re-price an existing held
   order. Since `commercialQuoteFor` is called fresh at every checkout and the result
   is written once, this is safe by construction *as long as* the extension-pricing
   path (`commercial_stream_sessions.ts:990-992`) keeps reading `feePolicy` off the
   **base order's frozen snapshot** (`basePricing?.feePolicy`) rather than
   recomputing from `config.sessionFeeRuleEnabled` — which it already does. Existing
   held/settled orders are unaffected either way.
2. **Existing bookings mid-flight.** Any booking already checked out under
   `"creator_subtotal_plus_fee"` keeps its frozen 100%-of-subtotal creator amount
   forever (by design — snapshots are immutable). No backfill is implied or should be
   attempted.
3. **Wizard price floor (`MIN_PRICE_TOKENS_PER_HOUR=49`, findings #10-14).** That
   floor exists to stop the *old* ₹25-flat formula from leaving a creator with ₹0. It
   is disconnected from `commercialQuoteFor` already (nothing in the checkout path
   reads it), so G4 does not need to touch it for checkout correctness — but the
   wizard's displayed number (findings #10, #11) would become actively misleading
   (it shows a different formula than what checkout actually bills) the moment G4
   ships, unless that copy is updated in the same release. That is wizard-ownership
   work, not S9's.
4. **Flutter app (findings #14-16).** The app shows the same stale ₹25/20% formula in
   its own wizard and would need a build to catch up; there is no way to hotfix
   compiled Dart strings. A G4 rollout should treat the app-side copy mismatch as an
   accepted lag (server is the money authority; client copy is cosmetic and already
   documented as display-only) rather than a blocker.
5. **`money_engine.ts:138`'s `fee_pct ?? 20` fallback (finding #7).** Any order
   created through a path that does not set `fee_pct` explicitly would silently get
   priced under the old flat-20%-of-gross assumption at `release()` time. Worth a
   follow-up audit of every order-insert path before G4 ships, but no such path was
   found missing `fee_pct` in this read-only pass (`commercial_checkout.ts:1323`,
   `commercial_stream_sessions.ts:1115`, `listings.ts:4601` all set it).
6. **`sessionFeeRuleEnabled` naming collision.** The flag's own name and its `true`
   value already select `"creator_subtotal_plus_fee"` — i.e. the flag currently means
   "use the additive-time-fee policy" (`true`) vs. "use the legacy flat-percentage
   fallback" (`false`). G4 would need a **third** state (or a new flag) to distinguish
   "time fee only, no commission" (today's live behaviour) from "time fee plus
   commission" (D1). Reusing the same boolean to mean something new is the kind of
   silent redefinition this repo's CLAUDE.md explicitly warns against for flags.

## 3. Canonical fee sentence — CONFIRMED

> Contracts §4: "Saathum adds a time fee of ₹50 per participant for every 30 minutes
> booked (₹100 per hour) and keeps 20% of your price. The 20% does not change with
> event length."

**CONFIRMED.** It is internally consistent with A6.1's model (`baseForHours(H) = 100*H
= 50*S`, `platformShare = 0.20*A` independent of `H`) and with the A6.3 test vectors
(row 1: A=400, H=1 → time fee ₹100, commission ₹80, i.e. 20% of 400 — matches "keeps
20% of your price"). No alternative wording proposed.

## 4. `/pricing-fees.astro` — what was found there

`web/src/pages/pricing-fees.astro` (as of base commit `3344d79d`) is an **unrelated
page**: a client-side "Video and audio pricing calculator" for AvaTOK's per-minute
call/streaming/audio-room product (participants × duration × sessions × add-ons), with
every rate placeholder-only ("Rates coming soon" / "Pricing values are being
finalized." / "Pricing soon"). It contains **no organiser/creator fee content of any
kind** — no ₹25, no 20%, no 80%, no session/booking language. All numeric logic is
client-side JS computing participant-minutes for display only; nothing is read from
`config`/`PRICING` at build or runtime for this page (confirmed: no import of
`listingTaxonomy`, no fetch to `/api/config`, on this page). So the "if pricing-fees
reads numbers from config/PRICING at build time, do not change the plumbing" caveat in
the brief does not apply — there is no existing plumbing to disturb.

The canonical D1 sentence and a worked example (A6.3 row 1) do not fit naturally into
"Video and audio pricing calculator" without inventing a new section, since the page
currently says nothing about organiser/creator economics at all. §5 below documents
the copy-only section added.

## 5. Public copy change made

Added one new, self-contained `<section>` to `web/src/pages/pricing-fees.astro`
(no config/worker/generated/app files touched):

- Placed after `.pricing-notes` (the last existing section), before the closing
  `<style>` block.
- Copy: the canonical fee sentence from contracts §4, **verbatim**, plus a worked
  example using A6.3 row 1 (A=₹400, 50 participants, 1 hour → ticket ₹500, ticket
  sales ₹25,000, platform time fee ₹5,000, commission ₹4,000, organiser proceeds
  ₹16,000 before other costs), phrased as illustrative/example — not a live quote —
  consistent with A6.2's "This is a planning example, not a checkout quote or a
  payout promise."
- Styling reuses the existing `.pricing-notes`/`.pricing-intro` card pattern already
  defined in this file's own `<style is:global>` block (border/shadow/radius/colour
  variables already present on this page) — no new hex/font-family/box-shadow/
  border-radius value introduced.
- No `data-i18n` key reused from old creator copy; new keys, if any, follow this
  page's existing `web-pricing-fees.<hash>` naming.

## 6. Summary for the coordinator

- The "old ₹25/hour (+20%)" formula is **not** what live checkout bills today. Live
  checkout (`commercialQuoteFor`, `feePolicy:"creator_subtotal_plus_fee"`, default
  since `sessionFeeRuleEnabled:true`) already bills the D1 time fee correctly
  (₹50/30min, additive). The only real gap is the missing 20%-of-organiser's-price
  commission (finding #4) — a much smaller change than "replace the whole formula."
- The ₹25-flat+20% arithmetic survives only in **display-only** code: the web wizard
  (`listingTaxonomy.ts` generated PRICING, `steps.tsx`, `wizardLogic.ts`), its Python
  generator, the Flutter app (three separate copies), and a dead worker module
  (`session_pricing.ts`'s `sessionFeeFor`/`sessionSplitFor`, exercised only by its own
  test file). None of these move real money.
- The "80% you keep" claim on the homepage and two other pages describes
  `commercialCreatorFeePct`'s legacy flat-percentage fallback (default 80), not D1's
  additive model — numerically compatible today by coincidence, but worth a follow-up
  wording pass once G4 ships. Out of S9 ownership to fix.
- `/pricing-fees` had zero organiser-fee content before this change; §5 adds it.
