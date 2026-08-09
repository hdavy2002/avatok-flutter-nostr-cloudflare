# SPEC — Personal DID Virtual Number (replaces free AvaTOK numbers)

Owner decisions 2026-08-09. Supersedes `Specs/AVATOK-NUMBER-FEATURE-SPEC.md` (free
number feature is RETIRED — it was only ever used by a handful of testers).

## Owner decisions (canonical)

1. **Remove ALL free/virtual AvaTOK numbers.** The onboarding number gate goes away.
   Identity reverts to the user's personal number until they buy a DID.
2. **Price: 600 tokens/month** per personal DID (wholesale is ₹300/mo with the new
   provider, so ₹600 retail is ~50% margin). NOT 700 — 700 stays only for the
   legacy campaign DID key until migrated.
3. **Verification pipeline before purchase: video → Aadhaar → pay.**
   - Video = existing Didit liveness (`routes/liveness_didit.ts`). If the user is
     already video-verified anywhere in the app (central `verification_status` /
     `identity_proofs` / verified KV), SKIP the step.
   - **Aadhaar = PLACEHOLDER for now.** Owner has not yet paid for the Aadhaar API.
     Build the step as a no-op behind `aadhaarVerificationEnabled=false`; when the
     API key lands, wire it and flip the flag. Skip-if-already-done applies the
     same way once real.
4. **WhatsApp model for identity visibility:**
   - Personal numbers are PUBLIC on the network by default (searchable, shown on
     contact cards) — like WhatsApp.
   - An ACTIVE paid DID is the ONLY way to hide the personal number. DID active →
     search by personal number returns "not on AvaTOK"; search by DID finds the
     user; contact sharing (card/QR/WhatsApp share) emits the DID.
   - No DID (or DID lapsed/released) → personal number is public again and is what
     gets shared. Search accepts BOTH personal numbers and DIDs as inputs.
5. **Onboarding:** the number step is replaced by an INFO page — "you can buy a
   virtual number for any country and use it as a front for your personal number;
   find it in Settings → Virtual Number."
6. **Settings → Virtual Number:** new section — browse provider inventory by
   country, buy (verification-gated), see status/renewal, release.
7. **Post-purchase email** to the user: "your virtual number is +XX…".
8. **Call routing:** inbound PSTN call TO the DID → Ava PA (existing
   voicemail/agent lanes in `routes/pstn.ts` / `pstn_agent.ts` /
   `do/vobiz_agent_room.ts`). In-app AvaTOK calls → existing in-app receptionist
   pipeline. Both already exist; only owner-resolution by called-DID is new.

## What already exists (verified in code 2026-08-09 — reuse, don't rebuild)

- **DID purchase machinery:** `routes/campaign_dids_route.ts` — provider search /
  charge-then-provision with refund-on-failure / `user_dids` D1 table / release /
  lazy renewal (`lib/campaign_did_renewal.ts`). Re-scope with `purpose='personal'`,
  price 600, no campaigns gate.
- **Provider abstraction:** `lib/telephony_provider.ts` (`getTelephonyProvider`).
  The new ₹300/mo provider slots in here as a second implementation.
- **Monthly billing pattern:** `routes/telephony_tiers.ts` — idempotent per-month
  op_ids, lazy renewal, past_due grace. Copy the pattern.
- **Verification central state:** `verification_status`, `kyc_status`,
  `identity_proofs`, verified KV, `recordLivenessPass` (`lib/identity_gate.ts`).
- **Search/matching:** `matchAvatokPhones` (`routes/api.ts` ~L2764) matches on
  `users.phone_hash`.
- **Inbound PSTN:** `resolveOwner` (`routes/pstn.ts` L145) — extend to look up
  `user_dids` by the CALLED number first; forwarded-from stays the fallback.
- **Onboarding gate to remove:** `shell/ava_shell.dart` `_needsNumber` →
  `NumberSettingsScreen(gate:true)`; backend `routes/number.ts` behind
  `numberFeatureEnabled`.
- **Transactional email:** existing senders in `routes/id.ts`, `routes/invite.ts`,
  `ledger.ts`, `cal/emails.ts` — reuse the same path for the purchase email.

## Phases

**P1 — Retire free numbers.** Remove the `_needsNumber` gate; add the onboarding
info page; flip `numberFeatureEnabled=false` in prod (owner-approved); clear
`users.avatok_number_display`; leave `avatok_numbers` table in place (read-only
history) — no data copy, no hard delete in the same change.

**P2 — Personal DID purchase backend.** New route (e.g. `/api/vnumber/*`):
search / buy / status / release with `purpose='personal'`, 600 tokens/mo
(`vnumber_month` featureKey + wallet-statement label), lazy renewal; on lapse past
grace → unhide personal number, release at provider. Flags declared in
`config.ts` DEFAULTS **in the same change** (fake-flag rule):
`virtualNumberEnabled` (bool kill switch), `didMonthlyTokens` (numeric — add to
`numericKeys`, default 600), `aadhaarVerificationEnabled` (bool, false).

**P3 — Verification-gated purchase flow.** Server-side eligibility endpoint:
`{video: done|required, aadhaar: done|required|disabled, can_pay: bool}` computed
from central state. Client wizard: video (Didit, skip-if-verified) → Aadhaar
(placeholder step, auto-passes while flag is false, UI shows it in the stepper) →
pay. Purchase endpoint MUST re-check eligibility server-side — never trust the
client stepper.

**P4 — Identity visibility + search + sharing.** Add DID identity fields (e.g.
`users.did_e164`, `did_hash`, kept in sync from `user_dids` on
buy/lapse/release). `matchAvatokPhones`: match on `phone_hash` OR `did_hash`;
EXCLUDE `phone_hash` rows where an active personal DID exists (hidden). Contact
card / QR / share: emit DID when active, else personal number. Client caches of
contact matches must revalidate (per-account scoped stores).

**P5 — Inbound routing.** `resolveOwner`: called-number lookup in `user_dids`
(purpose='personal', status='active') → owner uid → existing PA lanes. No engine
imports into pstn.ts (hard rule stands).

**P6 — Purchase email + telemetry + ship gate.** Confirmation email with the
number. PostHog events tagged with user email at every pipeline step
(`vnumber_purchase_started/verified_video/verified_aadhaar/paid/provisioned/
renewed/lapsed/released`). `tool/ship_manifest.json` entries with success-value
assertions (rule 3): e.g. `vnumber_provisioned` with `status=active` present for
a real buyer, and a search-by-personal-number for that buyer returning no match.

## Guardrails

- Wholesale ₹300 is context only — never expose or use in code (same rule as the
  ₹600/channel note in telephony_tiers.ts).
- `user_dids` wire/column names are frozen where already shipped; new columns are
  additive.
- Production writes (flag flips, deploys, migrations) are each confirmed with the
  owner; worker: `npx tsc --noEmit` before deploy, commit before deploy,
  clean-tree check, cache-busted config verification.
- Legacy campaign DID path (700 tokens, `campaignsEnabled` gate) stays untouched
  until owner says otherwise.
