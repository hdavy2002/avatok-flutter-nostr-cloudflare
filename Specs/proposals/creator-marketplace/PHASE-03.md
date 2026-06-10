# Phase 3 — AvaIdentity (Stripe Identity KYC) + AvaPayout (Wise)

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §5 (gating matrix), §4. Prereq: Phase 2.

## Objective
AvaIdentity = reusable video-KYC gateway (Stripe Identity) any app can call.
AvaPayout = withdraw wallet → bank via Wise, allowed only after KYC passes.

## Part A — AvaIdentity

### Backend (`routes/identity.ts`)
- Uses existing scaffolding: D1 `verification_requests`, `account_status.kyc`,
  R2 `avatok-verification` (locked bucket).
- `POST /api/identity/session` → create Stripe Identity VerificationSession
  (`document + selfie` with liveness) → return client secret + ephemeral key.
- Webhook `/api/identity/stripe-webhook`: `verification_session.verified` ⇒
  `account_status.kyc='verified'`; `requires_input` ⇒ `pending_input`;
  store report id in `verification_requests`. Never store raw doc images ourselves
  (Stripe holds them); only store report references.
- `GET /api/identity/status` → {kyc, lastUpdated, failureReason?}.
- **Gate helper** `requireKyc(ctx)` in `worker/src/authz.ts` — used by payout
  (Phase 3), consult-listing + live-listing creation (Phase 6).

### Flutter (`app/lib/features/identity/`)
- `IdentityGate` widget: wrap any gated action; if not verified → explainer sheet
  ("We need to verify your identity before you can …") → launches Stripe Identity
  native flow (`stripe_identity` / web fallback) → polls status.
- AvaIdentity app screen: current status (Verified ✓ / Pending / Not started /
  Failed + reason), restart button, what-we-check explainer.
- Note: onboarding already collects age/phone/email OTP (`verify_identity_step.dart`)
  — that stays; AvaIdentity is the stronger video-KYC layered on top, on demand.
- Signup, browsing, booking, and wallet top-up NEVER require video KYC — only the
  gated creator/payout actions in the matrix (universal §5). Buyers stay friction-free.

## Part B — AvaPayout

### Backend (`routes/payout.ts`, existing `wise.ts` wrapper: createRecipient/Quote/Transfer)
```sql
CREATE TABLE payout_accounts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  wise_recipient_id TEXT NOT NULL,
  currency TEXT, last4 TEXT, holder_name TEXT, verified INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE payouts (
  id TEXT PRIMARY KEY, user_id TEXT, amount INTEGER, -- coins
  wise_transfer_id TEXT, status TEXT,  -- pending|processing|sent|failed|cancelled
  failure_reason TEXT, created_at INTEGER, updated_at INTEGER
);
```
- `POST /api/payout/bank` — **requireKyc** BEFORE accepting bank details. Creates
  Wise recipient; verify via Wise account-requirements validation.
- `POST /api/payout/withdraw` {amount} — requireKyc; checks balance; ledger row
  `user → external:wise` type `payout` (hold), create Wise quote+transfer; on Wise
  webhook/poll `outgoing_payment_sent` ⇒ status `sent`; on failure ⇒ refund row.
- `GET /api/payout/history`, `GET /api/payout/banks`.
- Flag-gated like today (no Wise creds ⇒ 503); fee handling: Wise fees deducted
  from amount, shown before confirm.

### Flutter (`app/lib/features/payout/`)
- Cards on top: wallet balance, "available to withdraw".
- Flow: choose/add bank → (KYC gate fires here if unverified) → enter amount →
  quote preview (Wise fee, you'll receive ≈X in CUR) → confirm → history list
  with statuses. Email (Brevo) on sent/failed.

## Acceptance criteria
- [ ] Unverified user tapping "Add bank" is routed through Stripe Identity; after
      test-mode verification, the same tap proceeds.
- [ ] `requireKyc` rejects API calls directly (not just UI-gated).
- [ ] Withdraw in Wise sandbox: ledger holds, transfer created, history updates,
      failure path refunds coins.
- [ ] Payout/bank state is per-account scoped on device.
- [ ] Status emails delivered via Brevo.

## Folded from audit (build in this phase)

### A1. Compliance runway [SHOULD — start the paperwork NOW, code is small]
- **ToS/creator-agreement acceptance logging:** `agreement_acceptances(user_id,
  doc_id, version, accepted_at, ip)` — recorded when a user first creates a
  listing (Phase 6 calls it) and before first withdrawal. Versioned markdown docs
  served from R2; bump version ⇒ re-acceptance required.
- **Tax data capture at payout setup:** extend `payout_accounts` with
  `country, tax_id_type, tax_id_last4, tax_form_status` — collected in the
  add-bank flow (after KYC, before first withdrawal). No tax MATH yet; we store
  what year-end reporting (1099-K / DAC7) will need. Annual export = admin route
  `GET /api/admin/tax-export?year=` (CSV of creator earnings).
- **Non-code (davy):** open Wise Platform/KYB onboarding and Stripe Identity
  production access in parallel — both have multi-week lead times; sandbox is
  enough to build against meanwhile.
- Acceptance: first withdrawal blocked until tax fields + agreement v-current
  accepted; export CSV reconciles with settled ledger totals.

## Definition of done
Deploy (staging then prod), secrets recorded, Graphiti episode,
STATUS_REPORT.md, push.
