# PLAN — Personal DID Virtual Number implementation

Companion to `Specs/SPEC-2026-08-09-personal-did-virtual-number.md` ([VNUM-SPEC-1]).
Status: **ON HOLD — waiting on two external APIs from the owner:**

- **DID provider API** (the ₹300/mo wholesale provider — name + API docs + credentials)
- **Aadhaar verification API** (owner will pay for and supply the key)

Nothing here ships until the owner says go. When the APIs land, phases run in the
order below. Each phase = its own `[ISSUE-ID]` commits via `git_safe_commit.py`,
pushed via `git_safe_push.py`; builds only on explicit owner request.

## Dependency map — what needs which API

| Phase | Needs DID API | Needs Aadhaar API | Could build today |
|---|---|---|---|
| P1 gate removal + info page | no | no | yes |
| P2 backend purchase route | **yes** (provider impl) | no | scaffold only |
| P3 verification wizard | no | no (placeholder step) | yes |
| P4 identity/search/sharing | no (schema yes) | no | yes |
| P5 inbound routing | **yes** (webhook shape) | no | partial |
| P6 email + telemetry + ship gate | no | no | yes |

Owner chose to hold ALL phases until the DID API arrives — one coherent build
rather than shipping a Settings section that can't sell anything.

## P1 — Retire free numbers `[VNUM-P1]`

- `app/lib/shell/ava_shell.dart`: delete the `_needsNumber` gate + the
  "Choose my number" sheet (~L495–545); keep `_kHasNumberFlag` reads harmless.
- New onboarding info page (one screen, static): virtual numbers for any country,
  front for your personal number, available in Settings → Virtual Number.
  Design-guard: AD.* tokens + Phosphor icons only.
- `onboarding_flow.dart` L469 copy update ("set a private AvaTOK number later" →
  virtual-number wording).
- Prod flag flip `numberFeatureEnabled=false` (owner-confirmed, ALLOW_PROD=1 via
  scripts/flags.sh) — routes/number.ts then 503s; client paths must degrade
  silently (verify NumberSettingsScreen isn't reachable elsewhere:
  settings_screen.dart:302 is already commented out).
- D1 (deliberate, owner-confirmed step): `UPDATE users SET
  avatok_number_display=NULL` + leave `avatok_numbers` rows as history. No drops.

## P2 — Personal DID backend `[VNUM-P2]`

- `worker/src/lib/telephony_provider.ts`: add the new provider implementation
  (searchNumbers / purchaseNumber / releaseNumber) once docs arrive. Keep Vobiz
  impl untouched (campaigns still use it).
- New `worker/src/routes/vnumber.ts` modeled on `campaign_dids_route.ts`:
  - `GET  /api/vnumber/search?country=` — inventory browse (no charge)
  - `POST /api/vnumber/buy {e164}` — eligibility check (P3) → charge 600
    (`chargeAmount`, featureKey `vnumber_month`, op_id `vnum:<uid>:<e164>:<YYYY-MM>`)
    → provision → `user_dids` insert `purpose='personal'` → sync users.did fields
    (P4) → email (P6). Charge-then-provision with refund-on-failure, exactly the
    campaign_dids pattern.
  - `GET  /api/vnumber/status` — row + renewal, renew-on-read via a
    `maybeRenewDid`-style helper parameterized by price/featureKey.
  - `DELETE /api/vnumber` — release at provider, mark released, unhide (P4).
  - One personal DID per account initially (409 on second buy) — cheapest rule;
    relax later if the owner wants multi-country numbers.
- Lapse: past `next_renewal_at` + 3-day grace → status `lapsed`, unhide personal
  number, release at provider. Renew-on-read only (lazy, no cron) — same
  admission points as telephony_tiers.
- Flags in `routes/config.ts` DEFAULTS same commit (fake-flag rule):
  `virtualNumberEnabled:false`, `didMonthlyTokens:600` (+`numericKeys`),
  `aadhaarVerificationEnabled:false`. Prove with `ALLOW_PROD=1 flags.sh set` no-400
  + cache-busted /api/config read.
- `wallet_statement.ts` FEATURE_LABELS entry for `vnumber_month`.
- `npx tsc --noEmit` in worker/ before any deploy.

## P3 — Verification-gated purchase flow `[VNUM-P3]`

- Server: `GET /api/vnumber/eligibility` → `{video:"done"|"required",
  aadhaar:"done"|"required"|"disabled", can_pay:bool}` from central state
  (`identity_proofs`/`verification_status`/verified KV via lib/identity_gate).
  While `aadhaarVerificationEnabled=false` → `"disabled"` and it never blocks.
- `buy` re-derives eligibility server-side; 403 `verification_required` if not.
- Client wizard (inside the new Settings section): stepper Video → Aadhaar →
  Pay. Video step reuses the existing Didit liveness screen/flow; skip states
  render as pre-checked. Aadhaar step shows "coming soon / not required yet"
  while disabled.
- **Aadhaar placeholder contract** (fill when API arrives): a
  `lib/aadhaar_verify.ts` module exposing `aadhaarStatus(uid)` +
  `startAadhaar(uid)`; records into `identity_proofs` with proof type `aadhaar`
  so skip-if-done works identically to video. Until then the module returns
  `disabled`.

## P4 — Identity visibility, search, sharing `[VNUM-P4]`

- Schema (additive): `users.did_e164`, `users.did_hash` (sha256 of E.164, same
  hashing as phone_hash). Written on buy; cleared on lapse/release. D1 migration
  for meta shard, staging first, prod as deliberate step.
- `matchAvatokPhones` (routes/api.ts): query `phone_hash IN (...) OR did_hash IN
  (...)`; drop personal-number matches for rows whose `did_hash` is set (active
  DID = hidden). DID lookups always match. Contact-sync endpoint unchanged
  client-side — same hashes in, richer matching server-side.
- Share surfaces (client): contact card / QR / WhatsApp share emit
  `did_e164` when present, else personal number. Find every share site via
  graphify before editing (facts say share-via-WhatsApp exists on contacts).
- Client contact-match caches are per-account scoped stores — bump their cache
  key/version so hidden numbers actually disappear for existing installs.
- Two-sided ship-gate note: hiding is only provable with a SECOND account
  searching the buyer's personal number → no match, and the DID → match.

## P5 — Inbound call routing `[VNUM-P5]`

- `resolveOwner` (routes/pstn.ts L145): FIRST try called-number (the DID the
  provider says was dialed — field name depends on the new provider's webhook)
  against `user_dids` `purpose='personal' AND status='active'` → owner uid.
  Forwarded-from / caller heuristics stay as fallbacks.
- New provider's inbound webhooks: either it speaks the same XML dialect (then
  just point it at the existing endpoints + secret) or pstn.ts needs a thin
  adapter. UNKNOWN until docs arrive — this is the main P5 risk.
- No engine imports into pstn.ts (hard rule). Wallet/channel gates already apply.
- In-app calls: no change — receptionist pipeline already handles AvaTOK-side.

## P6 — Email, telemetry, ship gate `[VNUM-P6]`

- Purchase email via the existing transactional path (as used by
  routes/invite.ts / ledger.ts): "Your AvaTOK virtual number is +XX…".
- PostHog events (all tagged with user email via contactFor):
  `vnumber_purchase_started / vnumber_video_done / vnumber_aadhaar_done /
  vnumber_paid / vnumber_provisioned / vnumber_renewed / vnumber_lapsed /
  vnumber_released / vnumber_hidden_lookup` (a personal-number search suppressed
  by a DID — proves P4 live).
- `tool/ship_manifest.json` entries per phase with success VALUES, e.g.
  `vnumber_provisioned` with `status=active` from a real (owner) purchase;
  `vnumber_hidden_lookup` observed from a second tester device.

## Rollout order

1. Merge P1–P6 on staging; staging worker deploy; owner tests purchase end-to-end
   on staging with the provider's test credentials (if any).
2. Promote code + migrations to prod (`ALLOW_PROD=1`, clean tree, tsc, commit-
   before-deploy). Flags stay OFF.
3. Owner "ship it" → client build with the new screens (dark until flags flip).
4. Flip `virtualNumberEnabled=true` in prod KV; owner buys the first real DID
   (both sides of the two-phone rule); verify manifest assertions in PostHog.
5. Flip `numberFeatureEnabled=false` + run the P1 cleanup UPDATE (this ordering —
   new path proven live BEFORE the old one is removed — is deliberate).
6. Aadhaar: separate mini-cycle when the owner supplies the API — implement
   `lib/aadhaar_verify.ts`, flip `aadhaarVerificationEnabled=true`.

## Open questions for the owner (answer when handing over the APIs)

1. Which DID provider, and does it have test/sandbox numbers?
2. Countries to offer at launch — India only, or the full provider inventory?
3. One DID per account, or multiple (per-country)?
4. Existing free-number testers: any comms before their numbers go away?
5. Aadhaar API vendor (DigiLocker-based? Didit's India ID flow?) — affects
   whether the placeholder wires to Didit or a new vendor module.
