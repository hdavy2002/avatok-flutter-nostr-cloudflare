# Server-side hardening & Google-only auth — plan

**Principle:** the app is a **thin client** — it renders UI and calls APIs.
Every trust decision (money, entitlement, safety, identity, pricing) is the
**server's** job. Anything a patched client build could change must NOT be
trusted by the backend.

Status legend: **[DONE today]** · **[DO]** (build it) · **[VERIFY]** (confirm
it's already enforced) · **[DECISION]** (needs your call).

---

## 1. Money — server-authoritative (highest priority)

**Audit result (good news):** the *dangerous direction — creating money — is
already blocked.* Coins are credited only by the Stripe webhook
(signature-verified, against a server-recorded pending top-up, idempotent); there
is **no client-callable "add money" path**, and balances live server-side in
`WalletDO` (the client only reads them). The real purchase endpoints already
price server-side: AvaOLX uses `listing.price_coins`, AvaBooking/Calendar use
`slot.price_coins`, AvaVision/AvaVoice meter server-side, AvaTranslate uses a
server constant.

**The two real gaps (now FIXED 2026-06-18):**

- **Gap 1 — `/api/wallet/spend` trusted the client's `amount`** (and an arbitrary
  `to_npub`). It couldn't *add* money, but a patched client could **underpay**.
  No client flow used it. **[DONE]** The endpoint now returns `410` and the client
  helper was removed (`worker/src/routes/wallet.ts`, `app/lib/core/platform_api.dart`).
  All spending must go through the dedicated, server-priced endpoints.
- **Gap 2 — top-ups could be enabled without `STRIPE_WEBHOOK_SECRET`**, leaving
  forged webhooks as a free-coins path. **[DONE]** `topupEnabled()` now also
  requires the secret (fail-closed), and the webhook handler refuses unsigned
  calls (`503`) instead of falling through. Top-ups stay flag-gated off
  (`WALLET_TOPUP_ENABLED`) until you set the secret.

- **1.1 [DO] Server owns prices.** The client sends an *intent* — a feature id,
  or a listing/slot id + quantity — **never the charge amount**. The server looks
  the price up from its own source of truth:
  - Ava premium features → a server-side `FEATURE_COSTS` table
    (e.g. `delegate_monthly`, `image_gen`, `voice_reply`, `vision_snapshot`,
    `mcp_tool`).
  - Marketplace purchases (OLX / booking / listing) → the **listing's stored
    price**, not the buyer's request.
  `spend()` computes `amount` server-side from these and ignores any client value.
- **1.2 [DO] Entitlement re-checked server-side** on every premium endpoint. The
  client `PaidFeature` gate stays as **UX only**; the server independently
  verifies balance and deducts. Never run a paid action because the client said
  it could.
- **1.3 [VERIFY] Idempotent spends** — every spend keyed by a server-validated
  `op_id` (replay / double-charge protection). Confirm `walletOp` enforces this.
- **1.4 [VERIFY] Top-up truth = Stripe webhook.** Coins are credited only when
  the Stripe webhook confirms payment, never a client "success" callback. Confirm
  `topup_records` flips to paid via webhook.
- **1.5 [DO] Server-side spend caps / velocity limits** per account (anti-fraud),
  independent of the client's min-top-up UI.
- **1.6 [VERIFY] Commission / payout math stays server-side** (already in
  `wallet.ts`) — keep it there; the client never computes splits.

## 2. Thin-client sweep — keep authority on the server

Audit each; the server decides, the client only displays the result.

- Pricing & cost tables → server (see §1).
- Premium / entitlement gating → server.
- Safety verdicts (Guardian scam/grooming) → **already server** (`/api/ava/guardian/scan`). Keep.
- Delegate disclosure ("Ava — for X") → **already server-stamped**. Keep.
- Moderation (image/text) → server.
- Age / identity gating → server. Onboarding age-group + `birth_year` are client
  inputs = **advisory**; gate sensitive features on server-verified identity
  (liveness / verification), never on a client toggle.
- Rate limits / abuse / spam → server, on all public + mutation endpoints.
- Feature flags & kill switches → already `/api/config`. Keep client read-only.
- Affiliate / reward attribution → already server KV. Keep.
- **Rule:** anything that grants access, money, or trust → server.

## 3. Auth — Google-only (Gmail); remove password / OTP / bypass

- **3.1 [DONE today] Review-login bypass removed** — client
  (`kReviewerEmail`, `kReviewLoginUrl`, the bypass branch + `_tryReviewTicket` in
  `clerk_client.dart`) and server (`/api/review/login` route + import removed,
  `routes/review.ts` gutted to a tombstone). Worker typechecks clean.
- **3.2 [DO] Google OAuth as the ONLY login** (Clerk Google social connection /
  one-tap). Single "Continue with Google" entry point.
- **3.3 [DO] Remove password sign-in** (Clerk password strategy): the
  `signIn` password path + `reset_password` flows; and remove the **email-code
  (OTP)** second-factor login path once Google is live.
- **3.4 [DO] Clerk dashboard config:** enable Google social connection; **disable
  email/password and email-code** as sign-in methods.
- **3.5 [VERIFY] Identity email OTP** (`/api/id/email/start|verify`, Brevo):
  Google returns a verified email, so the separate email-confirm step in
  onboarding likely becomes redundant — remove or repurpose. Phone OTP (Firebase)
  is a separate identity signal; keep only if still wanted.
- **3.6 Reviewer access (resolved):** Google login has no OTP, so app-store
  reviewers sign in with a **Gmail test account** listed in the store console —
  no bypass needed. (Exactly why 3.1 was safe to remove.)
- **3.7 [DECIDED → hard cutover] Existing email/password users:** password
  accounts are retired; everyone re-onboards with Google. No email→Google linking
  logic needed. Disable email/password in Clerk and treat Google as the only
  sign-in. (Acceptable because there are no meaningful existing accounts to
  preserve.)
- **3.8 [DO] Update onboarding/login UI** to the single Google button; delete the
  password / reset / OTP screens.

## 4. Sequencing (so nothing breaks in production)

- **Phase A (now):** §3.1 done. Do **§1 money hardening** next — biggest financial
  risk; land it before any wider release.
- **Phase B:** build §3.2 Google OAuth, choose §3.7 migration, configure Clerk
  (§3.4), then remove password/OTP (§3.3) and the redundant identity OTP (§3.5).
- **Phase C:** §2 sweep — verify every trust decision is server-side.

## 5. Deploy preconditions / warnings

- **No Play review is currently in flight** (confirmed) → deploying the worker
  with the bypass removed is safe now. Before the *next* submission, add a
  **Gmail test account** in Play Console → App access so reviewers can log in.
- **Rotate the old `REVIEW_PASSWORD` secret** (it was git-tracked); you can delete
  the secret entirely once the new worker is deployed.
- The §3.1 changes take effect only when you **build/deploy** (CI APK +
  `wrangler deploy` of `avatok-api`). They're staged in the working tree now.
