# SPEC — Just-in-Time Identity Gating

**Date:** 2026-07-10 (rev. 3)
**Status:** BUILT (dark). Counsel review of §10 + published retention schedule required
before `identityGatingEnabled` is flipped on.

## 0. Implementation index (as built)

| Piece | Where |
|---|---|
| Gate + consent + legal hold | `worker/src/lib/identity_gate.ts` |
| Consent endpoint | `POST /api/liveness/consent` → `routes/liveness_didit.ts:livenessConsent` |
| Gated: listing / post / live | `routes/listings.ts` (`social`→post, `live_event`→live) |
| Gated: public upload | `routes/media.ts:uploadPublic` |
| Gated: going live | `routes/live.ts:liveStart` |
| Gated: DM-to-stranger, group post | `routes/messaging.ts:sendMsg` (after `dmPreexisted` resolves) |
| Legacy routes closed (410) | `worker/src/index.ts:LEGACY_GONE` |
| Legal hold enforced | `consumers/src/deletion.ts`, `routes/liveness_audit.ts` |
| Legal hold set on CSAM | `consumers/src/csam.ts:handleCsam` |
| Migrations | `worker/migrations/2026-07-10-identity-gating{,-backfill}.sql` |
| Client gate | `app/lib/features/identity/public_action_gate.dart` |
| BIPA consent screen | `app/lib/features/identity/biometric_consent_screen.dart` |

### ⚠️ Bug caught at migration time — `clerk_account_link` DOES NOT EXIST ON PROD

The first implementation stored `liveness_passed_at` on `clerk_account_link`, because
`auth.ts:requireVerifiedKV()` reads that table. Verifying against the live databases
before the migration showed:

| | prod `avatok-meta` | staging |
|---|---|---|
| `clerk_account_link` | **table does not exist** | exists, **0 rows** |
| `identity_proofs` (liveness) | 1 | 1 |
| `users` | 18 | 0 |

`cfnative.sql` says the table is dropped in the re-key pass. Nothing inserts into it.
`requireVerifiedKV()` has **zero callers**, which is why nobody noticed the table under
it was gone.

Had this shipped, `readLiveness()` would have thrown on every gate call. The gate fails
closed, so **every user would have been 403'd on every public action** the moment
`identityGatingEnabled` was flipped.

Liveness now lives in **`identity_proofs` (uid, proof='liveness')**, which
`applyDiditPass()` already writes: `verified_at` is the 90-day clock, `provider` is
`'didit' | 'grandfathered'`, `evidence_ref` is the session. No parallel columns.

**Second bug, same check:** `users` has **no `email` column** — only `email_hash`, by
design. `SELECT email FROM users` threw silently on every telemetry call and shipped
`null`, violating the project rule that every event carries the user's email. The
canonical lookup is `emailFor()` (`lib/identity.ts`), a KV-cached Clerk call.

Lesson: verify the schema against the live database before writing code that reads it.
Reading `auth.ts` was not enough — the code was live, the table was not.

### Naming hazards discovered during the build — read before touching this

1. **`authz.ts` already exports `requireLiveness()`.** It is the OLD onboarding gate:
   different flag (`livenessOnboardingGate`), reads `kyc_status`, returns `AuthFail`, and
   **fails OPEN when no row exists.** The new gate is `gatePublicAction()` in
   `lib/identity_gate.ts`: different flag, reads `liveness_passed_at`, returns a `Response`,
   **fails CLOSED**. Two gates, similar names, opposite failure modes. Do not merge them
   without deciding which failure mode you want.
2. **`app/lib/features/identity/identity_gate.dart` already exists** and is the **Stripe KYC
   payout gate** (Tier 2). The new client gate is `public_action_gate.dart`. Naming the new
   file `identity_gate.dart` would have overwritten the payout gate; emitting
   `identity_gate_shown` from it would have merged two unrelated PostHog funnels.
3. **Fast2SMS was never implemented.** It appears only in specs. Nothing to remove.
**Supersedes:** `SPEC-2026-07-10-whatsapp-verification.md`
**Target:** `prod` (build on `staging`, promote to `main`)

---

## 1. Scope

**One job: gate a user before their first public interaction with a Didit liveness check.**

### In scope

- Remove **all** phone verification: Firebase Phone Auth **and** Fast2SMS, deleted. Can be
  reinstalled later if ever needed.
- Onboarding has **no phone OTP and no liveness step**. Both removed. Signup is Clerk only.
- Gate every public action (§3.1) on a valid Didit liveness pass.
- Mark the user **video verified**, raise their trust level.
- Liveness valid **90 days**; expiry re-triggers on the next public action.

### Explicitly OUT of scope — separate projects

- **Payout / AML / KYC.** Not built here. `kyc.ts` is not touched.
- **CSAM scanning.** Separate project. (Note: it is currently a no-op — see `csam.ts`.)
- **The profile page.** Not touched at all.
- **DMs between existing contacts**, and the optional personal phone-number field. Both stay
  exactly as they are. The personal phone number is user-supplied contact data — never
  verified, never used for safety, never a gate.
- Contact discovery. Dead with the phone number; revisit separately.

---

## 2. Accepted gaps — deliberate, not oversights

Recorded so a future reader does not mistake these for things the design covers.

### 2.1 Ban evasion is not prevented

Liveness proves *a live human is present*. It does not prove *which* human, and cannot
recognise someone already banned. A banned user can register a new email, pass a fresh
liveness check, and return within minutes.

Face-search against a blocklist would close this. **Considered and removed by owner decision
2026-07-10**, because enrolling banned users' faces indefinitely is special-category
biometric data (GDPR Art. 9; Illinois BIPA / Texas CUBI statutory damages) and was the
largest legal exposure in the design. Removing it removes that exposure.

**Do not assume ban evasion is handled.**

### 2.2 What deterrence still provides

- A real, live face on file, bound to the account and timestamped.
- A response path for a lawful request: a face, an email, timestamps.
- Visible friction at the moment of intent — the offender knows the camera captured him
  before he posted.

A genuine deterrent. **Not** an identification system, and no copy may imply it is.

### 2.3 Account takeover after a pass

A pass is valid 90 days regardless of what happens in between. An account sold on day 2 is
trusted for 88 more. Device-change and IP-country re-checks would catch this; both were
removed with Device & IP Analysis. Accepted. The 90-day window bounds the damage.

### 2.4 No phone number on record

Lawful-request response is face + email + timestamps. Weaker in India, where a registered
SIM was the strong link. Accepted; Fast2SMS can be reinstalled if that changes.

---

## 3. The gate

### 3.1 Public actions — all of these, first pass

- create a post
- create an AvaMarketplace listing
- comment publicly
- go live
- **send a DM to a non-contact**
- create or join a group; post into a group

DMs **between existing contacts are not gated.** Enforced **server-side** in the Worker; a
client-side check is a suggestion.

> ⚠️ **`/upload/public` is NOT gated (corrected 2026-07-10).** An earlier version gated the
> raw byte-upload endpoint as `'upload'`. That broke SIGNUP: a profile avatar is a required
> onboarding field and uploads through `/upload/public`, so every new user 403'd before they
> could finish. The gate is redundant anyway — uploaded bytes land in R2 as `pending`,
> attached to nothing; the PUBLIC ACTION that exposes them (create post/listing/live) is
> gated at its own endpoint. Gate the action, not the byte transfer. CSAM/nudity scanning
> still runs on every upload. `'upload'` stays in the `PublicAction` union, currently unused.

### 3.2 Gate once per 90 days

One pass unlocks every public action for 90 days. On expiry the next public action
re-triggers liveness. Flat rule — no device check, no IP check.

### 3.3 Authz — CORRECTED after call-site audit (2026-07-10)

An earlier draft claimed `requireVerifiedKV()` gates on phone-verified and that a new
`403 → trigger` contract had to be built. **Both were wrong.**

**What exists (`worker/src/auth.ts:68`):** `requireVerifiedKV()` reads KV `verified:{uid}`
(1h TTL), falling back to D1 `clerk_account_link.tier === 'verified'`. It never touches the
phone. It is **already a liveness gate**.

`setVerifiedCache(uid, true)` is called from six places:

| Caller | What passed |
|---|---|
| `routes/liveness_didit.ts:471` | Didit liveness — **the live provider** |
| `routes/liveness_v3.ts:982` | legacy V3 pipeline |
| `routes/liveness.ts:995` | legacy Workers-AI liveness |
| `routes/id.ts:148` | legacy Rekognition liveness |
| `routes/kyc.ts:137` | Stripe Identity KYC — **out of scope, do not touch** |
| `routes/account.ts:36` | sets **false** on account deletion |

**The only phone gate is `routes/listings.ts:273-284`** — a direct query of
`contact_verification.phone_verified` returning `403 {error:'phone_required'}`.

**The 403→trigger contract already exists.** `app/lib/features/identity/
listing_liveness_gate.dart` intercepts that 403 and opens the flow. Rename the error and
generalise the widget; do not reinvent it.

### 3.4 Trust representation

Add **`liveness_passed_at`** (timestamp). The gate reads *only* this for the 90-day rule.

Liveness **also writes `tier='verified'`** so every existing reader keeps working — but it
**never clears it.**

> ⚠️ **Why never clear it.** `kyc.ts:137` sets the *same* `tier='verified'` boolean.
> Clearing `tier` on liveness expiry would silently revoke the tier of users who passed a
> full KYC, and could re-gate their payouts. `tier` is write-only and additive here.
> `liveness_passed_at` is the sole source of truth for expiry. Do not conflate them.

### 3.5 What actually has to change

1. **`listings.ts:273-284`** — drop the `phone_verified` query, call the new gate. Error
   becomes `403 { error: "identity_required", reason: "expired" | "never_passed" }`.
2. **`listing_liveness_gate.dart`** — retarget from `phone_required` to `identity_required`,
   lift it out of `listings` so every public action reuses it.
3. **Add `liveness_passed_at`** + a `requireLiveness()` helper wrapping `requireVerifiedKV()`
   with the 90-day check. KV cache holds a bare `"1"` on a 1h TTL, so worst-case revocation
   lag is 1 hour. Acceptable.
4. **Extend the gate to all of §3.1.** Today only listings gate. Posts, comments, go-live,
   DM-to-non-contact, group posts, public uploads do not. **This is the bulk of the diff.**

### 3.6 Kill the legacy liveness doors — security, not cleanup

`liveness.ts`, `liveness_v3.ts` and `id.ts` all still call `setVerifiedCache(uid, true)`.
Didit replaced them, but each remains a door onto the same switch: a bug, an old client
still calling the endpoint, or a direct request can mark a user verified **without any Didit
liveness check ever running.**

The entire deterrence model rests on that flag being true only when a real face was really
seen. Three unused paths that can set it anyway are the weak point.

- [ ] **First: check `index.ts` — are these routes still registered?** If routed, this is a
      live bypass and it is urgent. If unrouted, it is cleanup.
- [ ] Remove the routes and their `setVerifiedCache` calls.

---

## 4. What gets deleted

- `firebase_options.dart` phone-auth path; all `FirebaseAuth.verifyPhoneNumber` call sites
- **Fast2SMS** integration (India) — removed; reinstall later if needed
- `phone_stage.dart` — `PhoneNumberStage`, `OtpConfirmStage`, `_ResendRow`, `_PhoneField`
- `verification_api.dart` — Firebase SMS OTP path
- **The phone OTP step AND the liveness step in onboarding** — `verify_identity_step.dart`,
  the phone stage in `liveness_v2_screen.dart`, the corresponding steps in
  `onboarding_flow.dart`. Onboarding is Clerk only.
- The `contact_verification.phone_verified` gate in `listings.ts`
- Firebase Phone sign-in provider, disabled in console (project `avatok-e19ef`)
- Legacy liveness routes per §3.6

**Not touched:** the profile page, DMs between contacts, the optional personal phone-number
field and its QR/share-card usage. Label the personal number in the UI as unverified contact
data so nobody downstream mistakes it for a verified number.

**Do not use FCM as a phone-verification mechanism.** It addresses a device token from the
already-installed app; tapping the notification proves the user has the app open, which we
already knew. It never touches the SIM or carrier network.

---

## 5. UI

### 5.1 The gate screen

Shown when a public action is attempted without a valid pass. Full-screen, unskippable.

> **Quick check before you post**
>
> AvaTok asks everyone to verify they're a real person before posting publicly. It takes a
> few seconds and you'll only do it once every few months.
>
> Every account is tied to a liveness check. We don't share this with anyone — but if we're
> ever legally required to, by a court or law enforcement, we can. People who come here to
> harm children should know that before they start.
>
> **State of residence:** `[ dropdown ]`
>
> ☐ I agree that AvaTok may collect and store a scan of my facial geometry to verify I am a
> real person, and may keep it for up to 256 days after I delete my account.
> [Read our biometric retention schedule]
>
> `[Verify with camera]` — disabled until the box is ticked and a state is selected

The safety paragraph is not a compliance tax — **it is the deterrent.** A record nobody knows
about deters nobody. Do not soften it, and do not add claims we cannot support: no "we will
report you to the police," no implication that we can identify a user from their face.

**The consent checkbox is not optional and must not be pre-ticked** (BIPA §15(b), §10.4).
It must appear *before* the camera opens, name what is collected and the retention period,
and be recorded with a timestamp and policy version (`biometric_consent_at`,
`biometric_consent_version`). An inferred consent, a pre-ticked box, or a buried ToS link
does not satisfy the statute. If the user declines, they do not pass the gate — but nothing
is captured.

The state-of-residence field drives §10.2. Not selected ⇒ `retention_track='protective'`.

### 5.2 Identity section

Show **"Video verified"** with a check, and the trust level. On expiry, show
"Verification expired — you'll be asked again next time you post."

---

## 6. Schema (D1)

```sql
ALTER TABLE clerk_account_link ADD COLUMN liveness_passed_at INTEGER; -- 90d validity
ALTER TABLE clerk_account_link ADD COLUMN liveness_ref       TEXT;    -- Didit session ref
-- 'didit' = a real check ran. 'grandfathered' = no check ever ran. See §11.1.
ALTER TABLE clerk_account_link ADD COLUMN liveness_source    TEXT;
ALTER TABLE users ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;   -- §10.5
-- §10.2 — retention track. Unknown residency ⇒ 'protective', never 'extended'.
ALTER TABLE users ADD COLUMN residency_state    TEXT;    -- self-declared, §10.4
ALTER TABLE users ADD COLUMN retention_track    TEXT NOT NULL DEFAULT 'protective';
ALTER TABLE users ADD COLUMN biometric_consent_at INTEGER;  -- BIPA §15(b), §10.4
ALTER TABLE users ADD COLUMN biometric_consent_version TEXT;
```

`tier` is left alone (§3.4). No KYC columns — out of scope.

Per the rulebook: per-account state is namespaced via `scopedKey(...)` / `AccountScope.id`.
**Liveness state is per-account, never global** — a parent passing liveness must not silently
verify a child account on the same phone.

---

## 7. Feature flags (`worker/src/routes/config.ts` DEFAULTS)

| Flag | Default | Purpose |
|---|---|---|
| `identityGatingEnabled` | `false` | Master kill switch |
| `livenessValidityDays` | `90` | Owner decision |
| `phoneVerifyEnabled` | `false` | **Dead. Delete flag after soak.** |

Set via `scripts/flags.sh set …`. Never `wrangler kv key put` — that silently hits prod.
KV holds overrides only; never re-materialize the full `DEFAULTS` blob.

---

## 8. Telemetry — PostHog (comprehensive)

Server events go through `trackUserContact()` (`worker/src/hooks.ts`), which stamps `email`
(and `phone` where known) as both an event property and a `$set` person property — so
support can pull any user's whole history by email. **Every event below must carry `email`.**
That is a project rule, not a nicety: it is how a production issue gets traced back to a
person.

Client events use `Analytics.capture()`. Both sides emit; the server is authoritative.

`app_name: "avatok"`, `service_name: "avatok-api"` are added by the helper.

### 8.1 Gate events (server — `worker/src/lib/identity_gate.ts`)

| Event | When | Key props |
|---|---|---|
| `identity_gate_hit` | Gate blocks a public action | `action`, `reason`, `days_since_pass` |
| `identity_gate_passed` | Gate allows a public action | `action`, `days_since_pass`, `liveness_source` |
| `identity_gate_flag_off` | Gate skipped, flag disabled | `action` |
| `identity_gate_error` | Gate lookup threw → fail-closed | `action`, `err` |

`reason` ∈ `never_passed` · `expired` · `grandfather_expired`
`action` ∈ `post` · `listing` · `comment` · `live` · `dm_stranger` · `group_post` · `upload`

### 8.2 Liveness flow (server + client)

| Event | Side | Key props |
|---|---|---|
| `liveness_consent_shown` | client | `action`, `policy_version` |
| `liveness_consent_declined` | client | `action` — **watch this one**, it is the true refusal rate |
| `liveness_consent_granted` | server | `policy_version`, `residency_state`, `retention_track` |
| `liveness_started` | server | `session_id`, `action` |
| `liveness_camera_opened` | client | `session_id` |
| `liveness_passed` | server | `session_id`, `duration_ms`, `attempt`, `liveness_source` |
| `liveness_failed` | server | `session_id`, `didit_status`, `attempts_remaining` |
| `liveness_abandoned` | client | `session_id`, `last_step`, `seconds_on_screen` |
| `liveness_expired_recheck` | server | `days_since_pass`, `was_grandfathered` |
| `liveness_retry` | client | `session_id`, `attempt` |

### 8.3 Security / integrity events — alert on these

| Event | Why it matters |
|---|---|
| `legacy_liveness_route_called` | A removed route was hit. **Should be zero.** Non-zero ⇒ an old client, or someone probing the bypass (§3.6). |
| `verified_set_by` (props: `caller`) | Emitted at every `setVerifiedCache(uid,true)`. Tells you *what* minted trust. Anything other than `didit` or `kyc` is a bug. |
| `identity_gate_error` | Fail-closed fired. A spike means the gate is rejecting real users on infra noise. |
| `grandfather_applied` | Migration marked a user verified without a check (§11.1). One per user, once. |

### 8.4 Retention / compliance events

| Event | Key props |
|---|---|
| `biometric_consent_recorded` | `policy_version`, `residency_state`, `retention_track` |
| `retention_track_assigned` | `track`, `basis` (`self_declared` \| `unknown_default`) |
| `liveness_video_deleted` | `track`, `reason` (`account_deleted` \| `sweep_256d`) |
| `legal_hold_blocked_deletion` | `uid`, `hold_reason` — **must never be zero if holds exist** |
| `retention_sweep_ran` | `rows_deleted`, `videos_deleted`, `duration_ms` |

### 8.5 Cost

| Event | Key props |
|---|---|
| `didit_call_billed` | `check_type`, `month_to_date_count` |
| `didit_quota_warning` | fired at **400 checks/month** (80% of the free cap, §9) |

### 8.6 What to actually watch

**Funnel (day one):**
`identity_gate_hit → liveness_consent_shown → liveness_consent_granted → liveness_started → liveness_passed`

Two drop-offs carry all the signal:

- **`consent_shown → consent_granted`.** People refusing to hand over a face scan. If this is
  high, the copy is the problem, not the flow. It is also the number a regulator would ask
  about, so it is worth knowing honestly.
- **`liveness_started → liveness_passed`.** Didit failing real users. If this is high the
  problem is the provider or lighting/UX, and no copy change will fix it.

**`legacy_liveness_route_called` must be zero.** Anything else means the bypass is being
reached. Alert immediately, do not batch.

**`liveness_expired_recheck` at day 30–90.** The grandfathered cohort (§11.1) starts
expiring. Backdating spreads it, but watch the curve — a spike means the random offset
didn't spread as intended, and a support wave is arriving.

**`didit_quota_warning`.** The only warning before the free tier ends (§9).

### 8.7 Person properties (`$set`)

Set server-side on pass so PostHog person profiles are queryable without joins:

`liveness_verified` (bool) · `liveness_passed_at` · `liveness_source` (`didit`|`grandfathered`)
· `retention_track` · `residency_state` · `biometric_consent_version`

Existing Firebase telemetry (`otp_sent` etc.) stays until that code is deleted.

---

## 9. Didit cost — NOT a blocker at MVP (owner decision 2026-07-10)

Proceed without a quote. At MVP volume the **500 FREE/MO** allowance likely covers us
outright — 500 liveness checks/month is a lot of first-public-actions for an early product.

**But "500 FREE/MO" is a cap, not a free tier, and the ceiling arrives without warning.**
The 90-day renewal (§3.2) means it is not one check per user — it is up to four per active
user per year. Growth compounds it, and the grandfathered cohort (§11.1) lands as a wave.

Ship it. Instrument it. Do not discover the bill.

- [ ] **Spend alarm at 400 checks/month** (80% of the cap) → alert, do not block.
- [ ] Dashboard: liveness checks/month, and projected next-month total.
- [ ] **Before any growth push or paid acquisition**, get Didit's per-call price above the
      cap. That is when this stops being free, and it will not be gradual.

Contingency when it bites: narrow §3.1 (drop comments), or lengthen `livenessValidityDays`.
Both are flag flips, no code. That is why they are flags.

Rough shape for later: at $0.10/check ≈ $5k/mo at 1M users. At $0.50/check ≈ $25k/mo.

---

## 10. Biometric retention (owner decisions 2026-07-10)

**Owner intent:** retain liveness video **1.6 years (256 days)** after account deletion, for
government requests. AvaTok is a US company. Illinois and Texas residents excluded from
extended video retention.

### 10.0 "US company" does not mean "US law only"

Recorded because the decision was made on this premise:

- **GDPR Art. 3(2)** applies to any company offering goods or services to people in the EU,
  regardless of incorporation. No lighter regime for US entities. If we take EU signups, we
  are likely in scope.
- **India's DPDP Act** applies on the same logic. (Fast2SMS was planned for India.)
- **BIPA (740 ILCS 14)** applies to Illinois residents regardless of where we are
  incorporated. It is the **only** biometric law with a private right of action: $1,000 per
  negligent violation, $5,000 per intentional. It produced the $650M Facebook settlement.
  Being a US company makes BIPA *more* relevant, not less.
- Texas CUBI (AG enforcement, no private right), Washington, and CCPA/CPRA (biometrics =
  sensitive personal information) also apply.

**BIPA's retention rule is the binding constraint:** destroy *"when the initial purpose for
collection has been satisfied, **or** within three years of the last interaction, **whichever
comes first**."* 256 days is inside the 3-year bound. The exposure is the *first* clause —
for a liveness check, the purpose is arguably satisfied the moment verification completes.
Retention past that point is defensible **only** with §10.4's consent + published schedule.

### 10.1 Three tracks

| Track | Who | Video | Metadata |
|---|---|---|---|
| **A — Extended** | Deleted account, confirmed **not** IL/TX resident | 256 days | 256 days |
| **B — Protective** | Deleted account, IL/TX resident **or residency unknown** | deleted at account deletion | 256 days |
| **C — Legal hold** | `legal_hold = 1`, any residency | **retained, never deleted** | retained |

Metadata = `liveness_passed_at`, `liveness_source`, `liveness_ref`, account id, email hash,
`created_at`, `deleted_at`. This is what a lawful request actually asks for — who, when,
verified how — and it is retained on **every** track. Losing the video does not lose the
response path.

Scheduled sweep hard-deletes Track A/B rows at +256 days.

### 10.2 ⚠️ Unknown residency fails PROTECTIVE, never permissive

**IP geolocation tells you where a device is, not where a person resides.** BIPA protects
Illinois *residents* — including one on holiday in Florida, or on a VPN. A single
misgeolocated Illinois resident whose face video we kept is a live claim with statutory
damages and a private right of action.

Therefore: extended video retention (Track A) applies **only where we have positive evidence
the user is not an IL/TX resident.** Absent that, Track B. Signals, in order:

1. Self-declared state of residence, captured at the consent step (§10.4)
2. IP geolocation at capture, as corroboration only

Conflict, or either signal missing → **Track B.** Do not "resolve" it toward retention.

### 10.3 ⚠️ A two-tier evidence policy must be explainable

We will retain video on some deleted users and not others, on the basis of state residency.
Write this down, in the published schedule, before it is questioned in a deposition. It is
defensible — it is compliance with a state statute — but only if it was a documented policy
in advance rather than a pattern discovered afterwards.

### 10.4 Consent + published schedule — HARD REQUIREMENT, this project

BIPA requires **both**, and without them *any* retention period is exposed regardless of
length. Owner approved building both here.

- **Informed written consent before capture.** Electronic signature satisfies "written"
  (Public Act 103-0769, effective 2024-08-02). On the liveness screen, before the camera
  opens, an explicit checkbox — not an inferred consent, not a buried ToS link. It must name:
  what is collected (a scan of facial geometry), the purpose, and **the retention period**.
- **State-of-residence question** at the same step (§10.2).
- **Publicly available written retention and destruction schedule** on the website, matching
  exactly what the code does. Publishing a schedule you do not follow is worse than not
  publishing one.

### 10.5 Legal-hold track (C) — accounts under a filed report

`legal_hold = 1` (schema §6). Set by `handleCsam()` and any CSAM / serious-harm report.

- **Nothing is deleted.** Not the video, not the media, not the account row. Residency
  carve-outs do not apply — preservation for a filed report is exactly the purpose the
  statutes contemplate, and is the strongest ground we have.
- `handleDeletion()` and `purgeLivenessEvidence()` **must check `legal_hold` and refuse.**
- Bytes to a locked evidence bucket; access restricted to those handling legal requests.

### 10.6 Still a live bug today

`handleDeletion()` (`consumers/src/deletion.ts`) and `purgeLivenessEvidence()`
(`worker/src/routes/liveness_audit.ts`) destroy account data with **no legal-hold check at
all**. `handleCsam()` (`consumers/src/csam.ts:70`) deletes the bytes before any evidence
copy, with a `TODO(legal)` sitting above it. Fix as part of this work.

### 10.7 Still needs counsel — before launch

Owner has set the periods; engineering has implemented them in the least-exposed available
form. These remain legal questions:

- Does 256-day post-deletion video retention survive BIPA's "purpose satisfied, whichever
  comes first" clause, given a published schedule and explicit consent?
- Is residency self-declaration a sufficient basis for the IL/TX carve-out?
- Do we target EU or Indian users such that GDPR / DPDP apply?
- Exact consent language, and the wording of the published schedule.

Engineering implements what counsel specifies. Engineering does not choose it.

---

## 11. Rollout

1. Build on `staging`, `identityGatingEnabled=false`.
2. Enable on staging. Verify the gate fires on **every** action in §3.1, that a DM to an
   existing contact is **not** gated, and that backdating `liveness_passed_at` >90d
   re-triggers correctly.
3. Merge `staging` → `main`. Deploy prod with `ALLOW_PROD=1`. Run the D1 migration as a
   deliberate, separate step.
4. Prod: `identityGatingEnabled=true`. Watch the funnel 48h.
5. Disable Firebase Phone provider. Delete phone code after 2 weeks clean.

**Code and migrations promote. Data does not.** Never copy staging D1 rows or the KV flag
blob to prod — the blob copy would wipe every real user's config.

## 11.1 Migration — grandfather all existing users (owner decision 2026-07-10)

Existing users must **not** be gated. They are marked liveness-passed and verified on
migration so the change is invisible to them.

```sql
UPDATE clerk_account_link
   SET liveness_passed_at = :cutover - (ABS(RANDOM()) % 5184000000),  -- minus 0–60 days
       liveness_source    = 'grandfathered',
       tier               = 'verified'
 WHERE liveness_passed_at IS NULL;

-- Users who really did pass: record the truth, not the grandfather.
UPDATE clerk_account_link
   SET liveness_passed_at = <their last real pass>,
       liveness_source    = 'didit'
 WHERE <a passing Didit / liveness_v3 record exists>;
```

### Why `liveness_source`

Setting `liveness_passed_at` on a user who never faced a camera makes the database assert
that a liveness check happened. **That record is what gets handed to law enforcement.**
Recording a check that never ran is a false record, and it undermines every downstream claim
built on the field. `liveness_source='grandfathered'` keeps the evidence honest at the cost
of one column. Non-negotiable.

It is also the only way to later answer "how much of our user base has actually been
verified?" — a question you will be asked.

### Why the random backdate

A flat `liveness_passed_at = cutover` expires the **entire user base on the same day**, 90
days later: a million liveness checks in 24 hours, a Didit invoice to match, and a support
queue. Backdating each row by a random 0–60 days spreads expiry across days 30–90, so:

- nobody is gated for at least 30 days (the change stays invisible, as intended)
- renewals arrive as a smooth curve, not a wall
- peak daily Didit spend is ~1/60th of the cliff

### Consequence, stated plainly

**The deterrent applies to new users only, for the first 30–90 days.** Every existing
account — including any bad actor already on the platform — is trusted without ever having
faced a camera. This is the accepted cost of not disrupting the existing base. It resolves
itself as the grandfathered window expires. Alert on the first `liveness_expired_recheck`
cohort (§8).

---

## 12. Open items

- [x] **§3.6 — legacy liveness routes were STILL REGISTERED. Confirmed live bypass.**
      `/api/id/session`, `/api/id/result`, `/api/id/liveness/*`, `/api/liveness/v3/*` all
      called `setVerifiedCache(uid,true)`. Now 410 + `legacy_liveness_route_called`.
- [x] §10.6 — `legal_hold` check added to `handleDeletion()` + `purgeLivenessEvidence()`,
      both fail CLOSED. `handleCsam()` sets the hold **before** deleting anything.
- [x] §10.4 — biometric consent checkbox + state-of-residence field, before the camera.
      Enforced server-side too: `diditSession()` 403s `consent_required`.
- [x] §3.1 — all seven public actions gated.

- [x] §10.1 — **retention sweep BUILT.** `consumers/src/retention.ts`.
      `recordDeletionRetention()` snapshots the track before the deletion cascade destroys
      the rows it reads; `sweepRetention()` drains on the 15-min cron. Protective track drops
      the video at deletion; extended track holds it 256 days. Bounded 200/run, idempotent
      (bytes deleted before the row, so a mid-run failure retries rather than orphaning R2).
- [x] §10.4 — **retention schedule PUBLISHED.** `web/src/pages/biometric-retention.astro`,
      linked from the consent screen, the site footer, and the privacy policy.
- [x] Retention period **584 → 256 days** (owner decision 2026-07-10). Consent version bumped
      `v1 → v2`, which invalidates prior consent so nobody is held to a period they never saw.

> ⚠️ **Four places state the retention period. They must never diverge.**
> `app/lib/features/identity/biometric_consent_screen.dart:_kRetentionDays` ·
> `consumers/src/retention.ts:RETENTION_DAYS` ·
> `web/src/pages/biometric-retention.astro` ·
> `worker/src/routes/config.ts:biometricConsentVersion` (bump on any change).
> A published schedule you do not follow is evidence against you, not a defence.

- [x] §11.1 — **migrations RUN on staging and PROD, 2026-07-10.** Verified:
      0 users without a verified liveness proof; 1 `didit` + 17 `grandfathered`;
      expiry spread across days 36–88 (backdated 2–54 days), so no cliff and nobody
      gated for at least 36 days. Prod had **18 users**, not 1M.

**Still open — these block turning the flag on:**

- [ ] **Deploy the worker + consumers.** The gate code, the 410 routes, the consent
      endpoint and the retention sweep are all committed but **not deployed**. The
      schema is live; the code that reads it is not. `scripts/cf.sh worker deploy` /
      `consumers deploy` with `ALLOW_PROD=1`.
- [ ] **Deploy the web build.** `web-deploy.yml` is `workflow_dispatch` only — a push does
      NOT publish the site. The schedule page is committed but **not live** until someone
      runs that workflow. The app links to it. Until it deploys, the link 404s.
- [ ] §9 — spend alarm at 400 checks/month; `didit_call_billed` / `didit_quota_warning`
      are specced but not emitted.
- [ ] §10.7 — counsel review before launch. Non-negotiable: BIPA carries a private right of
      action and statutory damages, and §10.1's extended track is the exposed surface.
- [ ] `comment` is defined as a `PublicAction` but there is no comment route in the Worker
      to gate. Confirm comments do not exist yet, or find where they live.
- [ ] Extend the gate from listings-only to all of §3.1 — the bulk of the diff
- [ ] Stagger the first 90-day renewal cohort (§8)
- [ ] Does a parent's pass satisfy a child account on the same device?
      **Proposed: no.** Per-account scoping is mandatory, and a shared pass would let an
      adult vouch for a child's public posting.
