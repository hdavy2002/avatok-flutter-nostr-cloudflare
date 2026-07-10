# SPEC — WhatsApp Reverse-OTP Verification (replaces Firebase phone OTP)

> ## ⛔ SUPERSEDED 2026-07-10 — NOT BUILT
>
> Owner decided the same day to **remove phone verification app-wide** rather than migrate
> it. Replaced by **`SPEC-2026-07-10-identity-gating.md`** (just-in-time liveness at first
> public action; full AML/KYC at payout enablement).
>
> Kept as a decision record. Three findings in here remain live regardless:
>
> - **§12 legal-hold bug** — `handleDeletion()` and `purgeLivenessEvidence()` can destroy
>   evidence on an account under a filed CSAM report. Still a real bug. Carried forward.
> - **§7a** — why per-country SIM-registration tiering was rejected. Do not re-litigate.
> - **§13** — Aadhaar–SIM linking was struck down in 2018; no private company traces a
>   number to a person in any jurisdiction. Do not build on either premise.
>
> Nothing below was implemented. No Meta Business Account was created.

**Date:** 2026-07-10
**Status:** Superseded — never built
**Owner decision:** Blocking onboarding step, after the profile form
**Target:** `prod` (build on `staging` first, promote to `main`)

---

## 1. Goal

Remove all SMS OTP spend while still capturing a **verified** phone number for every
user. Replace Firebase Phone Auth with a WhatsApp *reverse-OTP* flow: the user sends
us a message instead of us sending them a code.

Clerk remains the identity provider. Email/password + Google sign-in are unchanged.
WhatsApp verification is a **post-signup, pre-app onboarding step**, not a login method.

## 1a. Why we ask — two purposes, both stated

**Purpose 1 — contact discovery.** AvaTalk is a messaging product. A verified number lets
a user's contacts find them, and lets them find contacts already on AvaTok.
*Contact discovery must actually ship,* or this half of the notice becomes false. Owner
confirmed 2026-07-10 that it is planned.

**Purpose 2 — safety, deterrence, and lawful-request response.** Every account is bound to
a verified phone number *and* a liveness check. AvaTok does not trace anyone — no private
company can resolve a phone number to a person in any jurisdiction; subscriber data sits
with the telco and is disclosed only to law enforcement on lawful request. What the record
provides is (a) a **deterrent**, visible to anyone contemplating posting CSAM or other
serious harm, and (b) a **response path** when a lawful request arrives.

### The disclosure is the feature

A deterrent nobody knows about deters nobody. If deterrence is a purpose, then stating it
prominently on the screen *is* the mechanism — it is not a compliance tax on the design, it
is the design. This also resolves the original framing question: there is no pretext to
invent, because the true reason is the more persuasive one.

Both purposes go in the notice. Under GDPR Art. 5(1)(b) and India's DPDP Act the stated
purpose must be the actual purpose. Collecting under purpose 1 while operating under
purpose 2 is a compliance defect, not a copywriting choice.

### Approved onboarding copy

> **Verify your WhatsApp**
>
> Two reasons, both worth knowing:
>
> **Find your people.** Friends already on AvaTok can find you, and you can find them.
>
> **Keep AvaTok safe.** Every account is tied to a verified phone number and a liveness
> check. We don't share this with anyone — but if we're ever legally required to, by a
> court or law enforcement, we can. People who come here to harm children should know that
> before they start.
>
> `[Connect WhatsApp]`

**Do not add** claims we cannot support: no "we will report you to the police," no assertion
that we can identify a user from their number. Over-claiming is both untrue and a liability.

---

## 2. Mechanic

```
Profile form submitted
   ↓
[Screen 1: Pre-warn]  "We'll open WhatsApp with a message ready to go.
                       Just press send — then come straight back here."
   ↓ tap [Open WhatsApp]
Deep link: https://wa.me/<BIZ_NUMBER>?text=AVA-7F3K9Q2M
   ↓ WhatsApp opens, text pre-filled, user taps ➤
Meta webhook → Worker → Queue → Consumer
   Consumer reads `from` (E.164, verified by WhatsApp) + nonce
   ↓
   a) binds number to Clerk userId
   b) auto-replies in WhatsApp: "✅ Verified. Tap to return → avatok://onboarding/whatsapp"
   c) pushes `wa.verified` over the user's InboxDO websocket
   ↓
[Screen 2: Waiting] flips to [Screen 3: Success] with no user action
```

The user reads no code and types nothing. Sending the message **is** the verification.

**Cost: £0.** A user-initiated message opens a 24-hour *service* window, which Meta has
made free and unlimited since 2024-11-01. Our auto-reply lands inside that window and is
therefore also free. The only paid path is the fallback in §6.1.

---

## 3. Nonce design

- Format: `AVA-` + 10 chars Crockford base32 (`0`/`O`, `1`/`I` excluded) = **50 bits**.
- Prefill text is **the code and nothing else**. Every extra word is a word the user
  might delete along with the code. Friendly framing lives on Screen 1, not in the box.
- TTL **10 minutes**. Single-use. Consumed atomically on first match.
- Bound at creation to `{clerkUserId, accountId, deviceId}`. A nonce can only ever
  verify the session that minted it.
- **No fuzzy matching.** A nonce is a bearer token; edit-distance matching multiplies the
  guessable space. If the code is absent or malformed we do not guess — we recover (§6.3).

**Guessing resistance:** 50 bits, ≤10 min lifetime, ≤~1e5 live nonces at peak
→ ~1e-10 per blind attempt. The attacker must also send each guess as a real WhatsApp
message from a real number, which Meta rate-limits and which we rate-limit per sender
(10 inbound/min, then drop silently). Adequate.

---

## 4. Backend architecture (built for 1M users)

### 4.1 Webhook ingress — never do work in the handler

Meta disables a webhook that is slow or errors. The handler does exactly three things:

1. Verify `X-Hub-Signature-256` (HMAC-SHA256 over the raw body with the Meta app secret).
   Constant-time compare. Reject early on mismatch.
2. `env.WA_QUEUE.send(payload)`.
3. Return `200` immediately.

All matching, DB writes, and auto-replies happen in the **queue consumer**. This is the
single most important scale decision here: it decouples our p99 from Meta's 5s timeout.

### 4.2 Nonce store — Durable Object keyed by nonce

`env.WA_VERIFY.get(env.WA_VERIFY.idFromName(nonce))`

Chosen over KV because **KV is eventually consistent**. The nonce is written by the app's
Worker request and read by the webhook consumer perhaps 3 seconds later, very likely in a
different colo. KV will intermittently miss it, producing a verification failure that is
unreproducible and blames the user. A DO addressed by the nonce is strongly consistent and
auto-shards perfectly — 1M nonces are 1M cold objects, which cost nothing idle.

Each nonce DO sets an `alarm()` at `+10min` to self-destruct its state.

D1 holds only the durable outcome, not the in-flight nonce.

### 4.3 Idempotency

Meta retries webhooks aggressively. Dedupe on `message.id` in the consumer:
`INSERT OR IGNORE INTO wa_seen (msg_id, seen_at)`, TTL-pruned at 7 days. A duplicate
delivery must not send a second auto-reply.

### 4.4 Auto-reply rate

Cloud API caps outbound at 80 msg/s by default. A signup burst can exceed this. The
consumer sends replies through the same queue with a concurrency cap and retries on
`131056` / `130429`. A dropped auto-reply is not fatal — verification already succeeded
server-side; the reply is purely the return path.

### 4.5 Schema (D1)

```sql
ALTER TABLE users ADD COLUMN whatsapp_e164        TEXT;
ALTER TABLE users ADD COLUMN whatsapp_wa_id       TEXT;
ALTER TABLE users ADD COLUMN whatsapp_verified_at INTEGER;
ALTER TABLE users ADD COLUMN whatsapp_discoverable INTEGER NOT NULL DEFAULT 0;
-- 1|2|3 per §7a. Metadata for lawful-request review. NEVER branched on in code.
ALTER TABLE users ADD COLUMN phone_registration_tier INTEGER;

CREATE INDEX idx_users_wa ON users(whatsapp_e164);

CREATE TABLE wa_seen (msg_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
```

### 4.6 Multi-account (parent + child share one phone)

**One number → many accounts, but only the first-verified is discoverable.**

`whatsapp_e164` is a *verified attribute*, not a unique key. On verify:

```
if no other account holds this number  → discoverable = 1
else                                   → discoverable = 0   (verified, but not findable)
```

This preserves the shared-phone model already built for, and keeps child accounts out of
contact discovery by default — the correct child-safety posture. Per-account scoping rules
in the rulebook apply: the number is stored per `AccountScope.id`, never in a global key.

---

## 5. Client architecture

- New full-screen onboarding step **after** the profile form, not a field inside it.
  A verify-button dressed as a text field invites people to type in it.
- Delete the phone-number text input entirely. **The user never types their number.**
  The webhook `from` field is the sole source of truth. Anything typed is unverified data.
- `phone_stage.dart` (`PhoneNumberStage`, `OtpConfirmStage`) is retired from the onboarding
  path. Keep the file until the Firebase fallback flag is removed, then delete.
- `verification_api.dart` gains `startWhatsAppVerify()` / `pollWhatsAppVerify()`.
- Live update via the existing InboxDO hibernatable websocket, with a 3s poll as backstop
  for when the socket is asleep or the app was backgrounded.
- `profile_screen.dart`: `PhoneVerifyCard` / `PhoneNudgeCard` re-point at the WhatsApp flow.

### Deep link back

Register `avatok://onboarding/whatsapp` (Android intent filter + iOS universal link).
This is the **only programmatic route back from WhatsApp on iOS** — you cannot force
foreground an app. It goes in the auto-reply.

---

## 6. Edge cases — resolutions

### 6.1 WhatsApp not installed

`canLaunchUrl(Uri.parse('whatsapp://send'))` **before** rendering the button. On Android
some OEMs fail the deep link silently, so also arm a 2s "did we background?" check via
`AppLifecycleState`; if we never lost focus, the launch failed.

Fallback: **WhatsApp OTP template** (authentication category, Cloud API). This is a
business-initiated message and is **billed per message** — a fraction of a cent, and it
only fires for the minority without the app installed. User reads a code and types it.

> Owner chose *Blocking*, globally (§7a). **The fallback is therefore mandatory, not a
> nice-to-have.** Blocking with no fallback locks out every user without WhatsApp — a large
> population in the US, Japan and South Korea, which are precisely the markets global
> blocking exists to cover. It is what turns "blocking" into ~100% capture instead of a
> signup wall, and a wall does not stop a determined offender, it only diverts them.
> If the fallback is rejected, we need an explicit accepted-loss number before launch.

Firebase Phone Auth is retained only behind `firebaseOtpFallbackEnabled` (default **false**),
as a break-glass switch. Removed entirely once WhatsApp verify is stable in prod.

### 6.2 User sends, then force-quits WhatsApp

Already handled. Verification completed server-side the moment the webhook fired. On next
app open, `GET /me` returns `whatsapp_verified_at` and the step is skipped. Nothing to do.

### 6.3 User edits or deletes the prefilled text

Parse `/AVA-[0-9A-HJ-NP-TV-Z]{10}/i` from the body. If **absent or unmatched**:

- Do **not** guess.
- Auto-reply (free, service window): *"That didn't quite work — tap here to try again →
  avatok://onboarding/whatsapp?retry=1"*.
- The client, on `retry=1`, mints a fresh nonce and re-opens WhatsApp.

Prevention beats recovery: keeping the prefill to the bare code is why this case stays rare.

### 6.4 User never sends

Screen 2 shows a determinate 90s countdown, not an indeterminate spinner — an unbounded
spinner reads as "broken". At timeout:

> **Still waiting?**  `[Try again]`  `[I don't have WhatsApp]`

`[Try again]` mints a fresh nonce (the old one is now dead). `[I don't have WhatsApp]`
routes to the §6.1 fallback. Because the step is blocking, there is deliberately no
"Skip" — but there is always a door.

### 6.5 iOS return path

Cannot be forced. Three layers, all of them:

1. **Pre-warn on Screen 1** — "then come straight back here." Setting the expectation
   before they leave is worth more than any recovery after. This is the highest-leverage
   line in the flow.
2. **Auto-reply deep link** — the one programmatic route back.
3. **State already correct** — however they return (app switcher, back gesture, the link),
   Screen 2 has already flipped to Success. They never re-tap anything.

---

## 7. Feature flags (`worker/src/routes/config.ts` DEFAULTS)

| Flag | Default | Purpose |
|---|---|---|
| `whatsappVerifyEnabled` | `false` | Master kill switch. |
| `whatsappVerifyBlocking` | `true` | **Global boolean. Not per-country** — see §7a. |
| `whatsappOtpFallbackEnabled` | `true` | Paid template for users without WhatsApp. Mandatory: see §7a. |
| `firebaseOtpFallbackEnabled` | `false` | Break-glass. Delete after soak. |

## 7a. Blocking is global. Per-country tiering was considered and rejected.

An earlier draft proposed gating by SIM-registration strictness: block in India/Indonesia/
Nigeria (mandatory registration, strong ID), skip in the US/UK/Canada/Netherlands/Sweden
(no registration requirement — a number proves nothing about identity). Roughly 160 of ~245
territories mandate registration; most Anglosphere and Nordic markets do not.

**That reasoning was derived from a tracing purpose we do not have, and it is rejected.**
Under the actual purposes (§1a) it inverts:

1. **Deterrence operates on belief, not on traceability.** A US prepaid SIM bought with cash
   is near-untraceable in practice. The person contemplating uploading CSAM does not know
   that and will not bet on it. The record exists; that is the deterrent.
2. **A weak record still beats no record.** A number plus timestamps plus carrier logs is
   something we can hand to a court. Weaker than India. Not nothing.
3. **A gap is a destination.** An unverified signup path in Tier-3 markets is precisely where
   an offender relocates. Selective enforcement of a child-safety control creates the hole it
   was meant to close. This is the decisive argument.

Therefore: **verify globally, blocking, in every market.** No country branching in the flow.

**Consequence — the §6.1 fallback is now mandatory, not optional.** The markets with no SIM
registration (US, Japan, South Korea) are also the markets with the *lowest* WhatsApp
penetration. Global blocking without a fallback would wall out exactly those users. And a
signup wall does not stop a determined offender — it diverts them to whatever path lacks the
wall. Ship the fallback.

**Store the tier, do not branch on it.** Persist a `phone_registration_tier` (1/2/3) derived
from the number's region alongside the record, so a reviewer or a lawful-request response
knows how strong a given record is. It is metadata for humans, never a conditional in code.

Set via `scripts/flags.sh set …`. Never `wrangler kv key put` — that hits prod silently.
KV holds overrides only; never re-materialize the full blob.

---

## 8. Migration

1M existing users must **not** be forced to re-verify.

- Users with a Firebase-verified number → `phone_verified` stays true, grandfathered.
  `whatsapp_verified_at` remains null. No nag, no block.
- The blocking gate applies to **new signups only** (`created_at > cutover_ts`).
- `requireVerifiedKV()` in `worker/src/auth.ts` must pass for *either* proof. This is the
  gate AvaMarketplace uses to allow publishing a listing — it must not regress.
- Existing "private phone number" field, the `Find me by my real phone number` privacy
  toggle, and the QR/share card all read from the same resolved number. Audit each.

---

## 9. Telemetry (PostHog — required by project rules)

Every event carries `email`, `phone` (once known), `account_id`, `platform`.

`wa_verify_shown` · `wa_verify_deeplink_tapped` · `wa_verify_launch_failed`
`wa_verify_webhook_received` · `wa_verify_nonce_matched` · `wa_verify_nonce_missing`
`wa_verify_succeeded` · `wa_verify_timeout` · `wa_verify_retry`
`wa_verify_fallback_shown` · `wa_verify_fallback_succeeded`

**Funnel to watch on day one:** `shown → deeplink_tapped → webhook_received → succeeded`.
The `deeplink_tapped → webhook_received` drop is the real number — it is every user who
opened WhatsApp and did not press send. If it exceeds ~15%, Screen 1's copy is failing and
the fix is copy, not code.

Existing Firebase telemetry (`otp_sent` etc.) stays in place; we add, never replace.

---

## 10. Meta prerequisites (long lead time — start now)

These gate the launch date more than the code does:

- WhatsApp Business Account + **Business verification** (can take 1–2 weeks).
- Display name approval for the sending number.
- Dedicated phone number, not one already on consumer WhatsApp.
- Webhook subscribed to `messages`, HTTPS, signature verification live.
- **Authentication message template** approved (for the §6.1 fallback only).
- Quality rating monitoring — a flood of inbound verifies is legitimate, but a sudden
  block would take down signup entirely. Alert on quality tier drop.

---

## 11. Rollout

1. Build on `staging`, staging backend, `whatsappVerifyEnabled=false`.
2. Enable on staging, verify the full funnel with real devices on iOS + Android.
3. Merge `staging` → `main`. Deploy prod with `ALLOW_PROD=1`. Run the D1 migration as a
   deliberate, separate step.
4. Prod launch with `whatsappVerifyEnabled=true`, **`whatsappVerifyBlocking=false`** for
   48h. Watch the funnel. Only then flip blocking on.
5. Firebase phone OTP disabled after 2 weeks clean. Deleted after 4.

**Code and migrations promote. Data does not.** Never copy staging D1 rows or the KV flag
blob into prod — the blob copy would wipe every real user's config.

---

## 12. Legal hold and retention — NEEDS A LAWYER, DO NOT GUESS

The safety purpose (§1a) makes the phone record potential **evidence**. This creates
obligations that engineering must not invent. Flagged, unresolved, blocking on counsel:

- **Deletion must be suppressible under legal hold.** `handleDeletion()`
  (`consumers/src/deletion.ts`) and `purgeLivenessEvidence()`
  (`worker/src/routes/liveness_audit.ts`) currently destroy account data on request. If a
  CSAM report has been filed against an account, destroying the phone record and liveness
  evidence may constitute spoliation. **Audit both call paths and add a legal-hold check.**
  This is a real work item, not a note.
- **Retention period** for `whatsapp_e164` after account deletion. State a basis
  (GDPR Art. 6(1)(c) legal obligation, or 6(1)(f) legitimate interests). Pick the number
  with counsel.
- **CSAM reporting duty** is jurisdiction-specific (e.g. NCMEC in the US) and carries
  criminal exposure if mishandled. `consumers/src/csam.ts` exists; its obligations must be
  reviewed against where AvaTok is incorporated.
- **Which jurisdiction can compel us,** and by what process. Decides the response path.

Engineering will implement whatever counsel specifies. Engineering will not choose it.

## 13. Open risks

- **Contact discovery must ship**, or half of §1a's notice is false and must change first.
- **Single point of failure:** if Meta blocks our number, signup stops dead *worldwide* now
  that blocking is global. The `whatsappVerifyBlocking=false` flag is the instant
  mitigation. **Rehearse flipping it before launch, not during the incident.**
- **India:** Fast2SMS was being introduced for Indian users pending approval. Confirm
  whether that work is now moot or still wanted as a regional fallback.
- **Aadhaar assumption corrected:** India's Supreme Court struck down mandatory Aadhaar–SIM
  linking and §57 of the Aadhaar Act in 2018 (*Puttaswamy*). Indian SIM registration remains
  mandatory via accepted ID, but the Aadhaar linkage is weaker than commonly assumed. Do not
  build any claim on it.
- **No private company can trace a number to a person, anywhere.** Any feature or copy that
  assumes otherwise is wrong. See §1a.
