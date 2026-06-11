# PROPOSAL — Progressive Identity (AvaIdentity Trust Ladder)

**Date:** 2026-06-11 · **Status:** PROPOSAL (awaiting owner approval)
**Owner decision inputs:** server-backed guest tier · Workers AI for liveness clip · keep Clerk for credentials.

---

## 1. Problem

Today a new user hits the full onboarding wall (Clerk email signup, profile, etc.) before seeing anything. That kills conversion. The fix: **identity is earned lazily** — each app/action demands only the identity level it actually needs, and AvaIdentity is the single ledger that records what the user has proven so far.

## 2. The Trust Ladder

| Level | Name | What the user provides | Unlocks |
|---|---|---|---|
| **L0** | Visitor | Unique `@handle` only (server-reserved) | Browse everything read-only: feeds, listings, events, profiles |
| **L1** | Member | Email + password (Clerk) — email verified via OTP | Messaging, add contacts, book events, book consultations, wallet top-up, social posting |
| **L2** | Verified Human | 5–10s selfie liveness clip → Workers AI challenge check | Create live-event listings, offer AvaConsult consultations, sell on AvaOLX, go live, **and use the next-gen social apps (AvaBook, AvaGram, AvaTweet — human-verified networks, no bots)** |
| **L3** | KYC Verified | Stripe Identity: gov-ID document + face match + doc checks | Payouts / withdrawals, payment-agreement signing |
| **L4+** | App-specific IDs (future) | Per-app credentials (e.g. professional license for AvaConsult experts, business reg for enterprise) | App-specific privileges |

Levels are strictly cumulative: L3 requires L2 requires L1 requires L0. The AvaIdentity screen shows the ladder as a checklist — green ticks for completed proofs (handle, email, liveness clip thumbnail, Stripe KYC), grey locks with "what this unlocks" for the rest. Password change lives here too (Clerk-managed).

## 3. Level 0 — Visitor (handle-only entry)

**UX:** first launch → one screen: "Pick your handle" → availability check as they type → land on the app feed. Nothing else asked. Time-to-app < 15 seconds.

**Mechanics (server-backed guest):**

- Device generates a keypair; Worker issues a signed **guest token** (`guest:<uuid>` uid) on `POST /api/identity/guest { handle }`.
- Handle is reserved in `DB_META.users` immediately (row with `level=0`, `guest=1`). Globally unique from second one — `getResolve` already covers `@handle` lookup.
- Guest rows expire after **90 days of inactivity** (cron purge) so squatted handles recycle.
- Rate-limit guest creation per IP/device (e.g. 3/day) to stop handle-squatting bots.
- L0 is **read-only**: the Worker rejects all write routes for `guest:` uids with `{ error, reason: "identity_level", required: 1 }` — the canonical gating error shape used at every level (client maps it to the right upgrade sheet).

## 4. Level 1 — Member (email + password)

Triggered the moment a visitor tries any write action (add contact, send message, book). Bottom-sheet: "To message people, secure your account" → email + new password + email OTP confirm. That's all — no name, no phone, no photo.

- Clerk remains the credential store (signup, password change, sessions). The Clerk client token stays device-global per the rulebook; everything else is account-scoped.
- **Guest merge:** on Clerk signup we call `POST /api/identity/upgrade` with the guest token + Clerk JWT → Worker re-keys the `users` row from `guest:<uuid>` to the Clerk uid, keeping the handle and any L0 state. One-way, atomic, idempotent.
- AvaIdentity ledger records: handle ✅, email ✅ (hash only in D1, per current `email_hash` pattern), password ✅ (held by Clerk, never by us).

## 5. Level 2 — Verified Human (Workers AI liveness clip)

Triggered when an L1 user tries to **create** supply: list a live event, open an AvaConsult offering, go live, sell.

**Challenge design (anti-replay):** the Worker generates a random challenge set per attempt — 2 actions drawn from {turn left, turn right, smile, sad face, raise eyebrows, open mouth} **plus** one spoken element: a random 3-word phrase or 4-digit number to say aloud. The user only sees the challenge when recording starts, so no pre-prepared clip works. Clip length 5–10s.

**Pipeline (all Cloudflare-native):**

1. `POST /api/id/session {provider:'workersai'}` → returns `{challenge: [...], phrase, upload_url}` (R2 presigned, private bucket, 60s TTL). Reuses the existing 3/24h rate limit in `routes/id.ts`.
2. App records the clip with on-screen prompts → uploads to R2 → `POST /api/id/result {session_id}`.
3. Worker enqueues to the verification queue; **avatok-consumers** processes: extract ~6 keyframes + audio track (container-side ffmpeg-wasm or Media Transformations), run frames through a Workers AI vision model (LLaVA-class) asking structured yes/no per challenge action + same-face consistency across frames, and run audio through Whisper (Workers AI) to confirm the spoken phrase/number.
4. **Pass** (all challenge items + face consistency): write `kyc_status` row `('verified','workersai_liveness')` exactly like the Rekognition path, keep ONE thumbnail frame in R2 for the AvaIdentity green-tick card, **delete the clip**.
   **Fail:** delete clip + frames immediately, return reasons ("we didn't see a smile"), allow retry within the rate limit. 3 fails/24h → cooldown.
5. Emit `brainFact(identity_verified)` as today.

**Provider note:** this slots in as a third provider beside the existing `rekognition` and `stripe` switches in `routes/id.ts` — nothing is thrown away. If Workers AI spoof-resistance proves weak in practice, the kill-switch flips L2 back to Rekognition with zero client change.

## 6. Level 3 — KYC Verified (Stripe Identity)

Triggered on first payout/withdrawal attempt. `payout.ts` already calls `requireKyc` — we tighten it to require **provider = stripe** specifically for payouts, while L2 (liveness) remains sufficient for creating listings.

- Reuses existing `stripeKycSession` flow (`routes/kyc.ts`): Stripe hosts document capture + selfie match + doc validity checks; webhook updates `kyc_status ('verified','stripe_identity')`.
- AvaIdentity shows it as the final green tick: "Payout identity — verified by Stripe".
- Country/document failures surface Stripe's reason; retry handled by Stripe's session, not us.

## 7. AvaIdentity = the ledger (single source of truth)

One new D1 (DB_META) table, plus the existing `users` and `kyc_status`:

```sql
CREATE TABLE identity_proofs (
  uid TEXT NOT NULL,
  proof TEXT NOT NULL,          -- 'handle'|'email'|'password'|'liveness'|'stripe_kyc'|future app IDs
  status TEXT NOT NULL,         -- 'pending'|'verified'|'rejected'|'expired'
  provider TEXT,                -- 'clerk'|'workersai'|'rekognition'|'stripe'
  evidence_ref TEXT,            -- R2 key of liveness thumbnail, stripe session id, etc.
  verified_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, proof)
);
```

`GET /api/identity/level` → `{ level, proofs: {...} }` — computed, cached in KV (60s). Every gated route calls a shared `requireLevel(env, uid, n)` helper (one place, like `requireKyc`); the client caches the level per account (scoped key, per the rulebook) and renders locks/CTAs without a round trip.

**Gating matrix (initial):** browse L0 · message/contacts/booking/top-up L1 · create listings/consult offerings/go-live/sell **+ entry to AvaBook/AvaGram/AvaTweet** L2 · payout/withdraw L3. All thresholds live in `routes/config.ts` as remote config so we can tune per app without app releases, each with its own kill switch.

## 7b. AvaIdentity screen = one-stop identity hub (replaces Profile)

The **Profile menu is removed from the sidebar**. AvaIdentity is the single place for everything about who the user is:

- **Editable by the user:** profile picture (upload → `/upload/public` → CF AVIF pipeline per rulebook), display name/bio, email (change → OTP to new address → re-verify), password (Clerk flow), phone number (change → SMS OTP to the NEW number → swap only on success).
- **Visible but NOT deletable:** liveness verification (green tick + the single kept thumbnail) and Stripe KYC (green tick, "verified by Stripe"). No delete button on either — they are trust assets, removing them would silently de-verify the account.
- **Account deletion (the only way to remove verification media):** a clearly-worded flow — "Deleting your account wipes EVERYTHING: profile, messages, wallet, listings, your liveness verification and KYC records including any stored video/thumbnails." Confirm → full GDPR purge: D1 rows (`users`, `identity_proofs`, `kyc_status`, …), R2 evidence objects, Clerk user, per-account device caches. Irreversible; re-signup starts at L0.

**Phone proof — real SIM numbers only.** Temp/virtual OTP numbers (web services that hand out disposable numbers) must be blocked:

1. On phone add/change, before sending the OTP, run a **carrier line-type lookup** (Twilio Lookup `line_type_intelligence` or equivalent) from the Worker.
2. Accept only `mobile` (real SIM). Reject `voip`, `landline`, `premium`, `shared-cost`, `tollFree`, unknown → `{ error, reason: "phone_type_blocked" }` with a friendly "please use a real mobile number" message.
3. Maintain a KV denylist of known temp-number prefixes/ranges as a second layer (updatable without deploy), plus per-number global uniqueness (one phone → one account) and rate limits on OTP sends (3/number/24h, 5/account/24h).
4. Store only `phone_hash` in D1 (existing `contact_phone_index` pattern); the raw number never persists outside the lookup call.

## 8. Build phases

1. **P1 — Ledger + gating helper** (2–3 d): `identity_proofs` table, `requireLevel`, level endpoint, config thresholds. Backfill existing users (Clerk → L1; `kyc_status` verified → L2/L3 by provider).
2. **P2 — Guest tier** (2–3 d): guest token issuance, handle reserve, read-only enforcement, merge-on-signup, expiry cron, rate limits. Flutter: handle-first onboarding screen replacing the current wall.
3. **P3 — Workers AI liveness** (4–5 d): challenge generator, R2 upload, consumer pipeline (frames + Whisper), provider switch in `routes/id.ts`, AvaIdentity green-tick card. Flag-gated; Rekognition stays as fallback.
4. **P4 — AvaIdentity hub + payout tightening** (3–4 d): remove Profile from sidebar; AvaIdentity screen = ladder ticks + profile pic + email/password/phone change (with SIM-only enforcement) + account-deletion wipe flow; payout requires `stripe` provider.
5. **P5 — App-specific IDs** (later): pluggable `proof` types per app (AvaConsult pro license, etc.); AvaBook/AvaGram/AvaTweet read L2 from the same ledger at launch.

## 9. Risks / open questions

- **Workers AI spoofing:** a vision LLM on keyframes is weaker than dedicated 3D liveness (photo-of-screen attacks). Mitigations: random spoken phrase (Whisper check), frame-consistency check, and the L3 Stripe gate before any money leaves. Decision: acceptable for L2 (reputation risk only), money stays behind Stripe.
- **Handle squatting at L0:** mitigated by rate limits + 90-day expiry; consider reserving premium/brand handles.
- **Clerk guest gap:** Clerk has no anonymous tier, so guests live entirely in our Worker (signed device token). Merge path must be atomic — covered in P2 tests.
- **Privacy:** clips deleted on pass/fail (only one thumbnail kept, user-deletable from AvaIdentity); GDPR delete must purge `identity_proofs` evidence + R2 objects.
- **Per-account scoping:** every cached level/proof on device uses `scopedKey(...)` — parent and child on one phone must never see each other's ladder.
