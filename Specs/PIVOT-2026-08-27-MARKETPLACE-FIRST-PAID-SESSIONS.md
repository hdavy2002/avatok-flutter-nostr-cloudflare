# PIVOT — Marketplace first, paid GetStream sessions

**Date:** 2026-08-27 · **Owner decision, this session** · **Status:** decision recorded; no code changed, no flag flipped
**Supersedes:** every earlier rule that conflicts, including sections of `CLAUDE.md`,
`Specs/AVATALK-CLOUDFLARE-RULEBOOK.md`, `Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md`,
`Specs/SPEC-2026-08-24-MESSENGER-1TO1-CALL-BILLING-GATE.md` and
`Specs/SPEC-2026-08-09-personal-did-virtual-number.md`.

---

## 1. The decision, in the owner's terms

1. **The core product is paid live streaming and paid 1:1 consultations.** Both go through
   **GetStream**, region **Mumbai**.
2. **The app's default landing screen is Marketplace.**
3. **Messenger audio and video calling is being killed** — the functionality is disabled and
   the UI for audio and video is hidden.
4. **AI features inside chat go dark**: Ava in chat, call translation, AvaBrain ingestion.
5. **Every user's real phone number is masked behind an AvaTOK number.** Free AvaTOK number
   for everyone; paid numbers purchasable with tokens.
6. **All payments happen on the web.** The app is read-only for money.
7. **Listings are identical on web and app.** A creator creates a live-stream listing or a
   1:1 consultation service, marks availability on the calendar, and publishes.
8. The app is therefore **live streaming + paid 1:1 video + simple messaging**. Nothing else.

---

## 2. What the app becomes

| Surface | Before | After |
|---|---|---|
| Landing screen | `ChatListScreen` (messenger) | **Marketplace** |
| Messenger 1:1 audio/video | GetStream, live in prod | **Gone — functionality killed, UI hidden** |
| Group conference ≤25 | Cloudflare Realtime, `conferenceEnabled=true` | **Off** (see §6 open question) |
| Paid live streaming | built, dark | **Core product — GetStream, Mumbai** |
| Paid 1:1 consultation | built, dark | **Core product — GetStream, Mumbai** |
| AI in chat | `aiEnabled=true` in prod | **Dark** |
| Money in app | Play Billing top-up live | **Read-only — balance + receipts only** |
| Public identity | real number leaks on free plan | **AvaTOK number only** |

---

## 3. Media providers — the final rule

**GetStream carries all paid session media: live streaming and 1:1 consultations. Region: Mumbai (`ap-south`).**

**Cloudflare carries no user-facing real-time media at all** once Messenger calling is
killed. It remains the application platform: Workers, D1, Durable Objects, R2, Queues, KV,
STUN/TURN/ICE, and every non-media service.

Call types, ids minted server-side (`worker/src/lib/commercial_stream_sessions.ts:30-55`):

| Product | Call type | Call id |
|---|---|---|
| Paid live event | `avatok_livestream` | `live_<listingId>_<sessionVersion>` |
| Paid 1:1 consultation | `avatok_consult_1to1` | `consult_<bookingId>` |

**Region is NOT set in code.** No region, edge or geo setting exists in
`stream_video_calls.ts`, `commercial_stream_sessions.ts`, `stream_lane.dart` or
`wrangler.toml`. Mumbai must be configured in the **GetStream dashboard** and verified
there. Do not assert the region from the codebase.

**No Cloudflare media fallback in the paid lane, ever.** Failing closed is specified
behaviour — an unmetered session is a money bug
(`Specs/SPEC-2026-08-24-PHASE-2-GETSTREAM-LIVE-CONSULT-MARKETPLACE.md` §1).

---

## 4. Killing Messenger calling

**Mechanism (owner decision): a new kill switch, `messengerCallingEnabled`, default `false`.**

**Do NOT disable calling by flipping `streamCallsEnabled` off.** That flag only *routes*.
Turning it off makes every entry point fall through to the legacy Cloudflare `CallScreen`,
which has failed 100% of calls since build 10612 (`getUserMedia(): unknown factoryId null`,
`Specs/AUDIT-2026-08-21-build-10612-getusermedia-factoryid.md`). Using it as a disable
mechanism would ship a broken calling experience rather than no calling experience.

### 4.1 The engine change is one line; the UI change is not

`routeToStreamCallIfEnabled` (`app/lib/features/avatok/place_1to1_call.dart:53`) is the
single choke point every human 1:1 dial already passes through. Making it refuse when
`messengerCallingEnabled == false` kills the functionality.

But **no flag today hides the buttons**. There are ~19 human A/V call affordances that stay
visible and would fail with a snackbar. Every one must be hidden:

| Site | File:line |
|---|---|
| 1:1 chat header — audio | `app/lib/features/avatok/chat_thread.dart:1335` |
| 1:1 chat header — video | `app/lib/features/avatok/chat_thread.dart:1337` |
| Group header — conference audio | `chat_thread.dart:1343` |
| Group header — conference video | `chat_thread.dart:1347` |
| "Join live conference" in-thread card | `chat_thread/special_content.dart:539-543` |
| Ongoing-conference join banner | `chat_thread/calls.dart:794,806` |
| Recents / Calls tab — call back | `features/avatok/calls_screen.dart:396` |
| Dialpad — dial + search result | `features/avadial/dialpad_search_tab.dart:383,477` |
| Contact detail — Call | `features/avadial/contact_detail_screen.dart:226,249` |
| Contact row menu — Call | `features/avadial/contact_row_menu.dart:94` |
| AvaPhone dialer ×3 | `features/avaphone/ava_phone_screen.dart:515,690,1148` |
| AvaPhone contacts ×2 | `features/avaphone/ava_phone_contacts.dart:131,306` |
| ShellV2 AvaDial root ×4 | `shell/v2/avadial_root.dart:918,1030,1084,1721` |
| Team inbox — Call back | `features/team/team_inbox.dart:164` |
| Team IVR warm transfer | `features/team/team_ivr_screen.dart:133` |
| Marketplace listing — call seller | `features/explore/listing_detail.dart:614,1432` |
| AskAva "Call <name>" chip | `features/askava/askava_screen.dart:1110` |
| Post-call "Call again" ×5 | `features/avatok/call_screen.dart:909,1513,2169,2229,2918` |
| Incoming accept paths | `incoming_business_call_screen.dart:768`, `streamlane/stream_incoming_screen.dart:271`, `push/push_service.dart:3119,6895` |
| Call overlay re-mount | `core/calls/call_overlay.dart:139` |

**The model to copy** is the group-conference pattern at `chat_thread.dart:1340`, which
already hides its affordance behind `conferenceEnabled`.

**Also required:** the incoming side. `push/push_service.dart` must stop presenting an
incoming-call screen for Messenger calls, or a caller on an old build can still ring a
phone on the new build.

### 4.2 What is NOT killed

The GetStream SDK, `stream_lane.dart`, the token route and the push wiring all stay — the
paid session lane depends on them. `streamCallsEnabled` stays `true`. The legacy Cloudflare
call engine stays compiled but becomes permanently unreachable.

---

## 5. AI in chat goes dark

Owner selected: **Ava in chat**, **call translation**, **AvaBrain ingestion**.
(Receptionist and voicemail were not selected — but they are call-dependent and die with
Messenger calling in practice. See §6.)

### 5.1 Flags that work today

| Surface | Flag | Prod default | Action |
|---|---|---|---|
| Ava in-thread `@ava`/`#ava`, catch-up, generation | `aiEnabled` | **`true`** | set `false` |
| Call translation 1:1 | `callTranslationEnabled` | `false` | already off |
| Call translation master | `translationEnabled` | `false` | already off |
| Group translation | `groupTranslationEnabled` | `false` | already off |
| Smart-reply chips | `smartRepliesEnabled` | **`true`** | set `false` |
| Per-chat Ava toggle | `avaDmToggleEnabled` | `false` | already off |
| AvaChat voice | `aiVoiceCallEnabled` | `false` | already off |

> ⚠️ **`aiEnabled` is a sledgehammer with no client half.** It is enforced only server-side
> (`worker/src/lib/ai_gate.ts:471`) and **no Flutter file reads it**. Flipping it off leaves
> every AI affordance visibly present in the composer and thread menu, silently failing.
> The UI must be hidden separately — same problem as the call buttons.

### 5.2 Switches that DO NOT WORK — must be built before anything can be called dark

This is the critical finding. These are declared in `config.ts` DEFAULTS but have **zero
consumers**, so flipping them changes nothing:

| Flag | Default | Reality |
|---|---|---|
| **`brainEnabled`** | `false` | **AvaBrain ingestion cannot be switched off platform-wide.** `worker/src/lib/brain_ingest.ts` reads no platform config at all — it gates only on per-user consent. The only surviving reference is a comment at `worker/src/routes/messaging.ts:871`. **The owner asked for AvaBrain ingestion to go dark and there is currently no way to do it.** |
| `avaStreamPlainEnabled` | **`true`** | Dead. 0 references outside `config.ts`. The AvaChat streaming lane it claims to gate is not killable. |
| `companionEnabled` | **`true`** | Dead. 0 consumers. `CompanionHome` renders unconditionally from `ava_shell.dart:456` and `chat_list.dart:2113`. |
| `avaMessageSearchEnabled` | `false` | Dead. 0 consumers. |

And two AI surfaces have **no flag at all**:

| Surface | Where | Problem |
|---|---|---|
| **"Discuss with Ava"** | `chat_thread/menus.dart:69-71`, gated by compile-time const `kDiscussWithAvaEnabled = true` (`core/feature_flags.dart:84`) | Disabling it needs a new APK and a store rollout. No KV path. |
| **AskAva** | `features/askava/askava_screen.dart:62`, mounted from `shell/shell_v2.dart:606-615` | No flag. Only accidentally dark because `shellV2=false`. **Flipping `shellV2` on for the Marketplace landing (§7) ships AskAva with no way to turn it off.** |

**Required work before the AI-dark decision is real:** wire `brainEnabled` into
`brain_ingest.ts`, give `kDiscussWithAvaEnabled` and AskAva real remote flags, and add
client-side reads so the UI hides rather than fails.

---

## 6. Call-dependent features that die by implication

Not explicitly selected by the owner, but they cannot function without Messenger calling.
Each needs an explicit decision before launch:

- **Ava Receptionist** (`receptionistEnabled`, prod `true`) — answers unanswered calls.
- **Voicemail** (`voicemailEnabled` `true`, `avatokVoicemailFree` `true`).
- **Group conference ≤25** (`conferenceEnabled`, prod `false` — already off, but the UI
  affordances at `chat_thread.dart:1343,1347` still need hiding).
- **AvaDial / AvaPhone / AvaCalls dialer surfaces** — an entire dialer UI with no dial.
- **Team inbox + Team IVR** — call-back and warm transfer.
- **PSTN / vobiz** — already fully dark (`avaDialer`, `avaSms`, `pstnVoicemail`,
  `pstnAgentEnabled`, `avaCallsPstnOutboundEnabled` all `false`).

---

## 7. Marketplace as the default landing screen

**Today the app lands on `ChatListScreen`** (`shell/ava_shell.dart:662`), whose navigation is
a hardcoded 3-chip top strip — Chats, Groups, Calls (`chat_list.dart:2794-2798`). There is
no Marketplace tab in the live shell; Marketplace is reachable only from the sidebar drawer
and only when `marketplaceEnabled` (default **`false`**).

Making Marketplace the landing screen requires flipping **`shellV2`** to `true`
(`config.ts:1964`, default `false`) — a **whole-shell swap that has never shipped to
production**. That is the risk in this pivot, not the Marketplace part.

Minimum change set:

1. `shellV2 = true` — swaps the entire app shell to the 3-root bottom-nav shell.
2. `marketplaceEnabled = true` — so the Services slot renders and labels as Marketplace
   (`shell/v2/app_switcher_bar.dart:117`, `shell/v2/services_root.dart:11-13`).
3. Reorder the default so `RootId.services` is first — edit
   `shell/v2/root_order_store.dart:34-38` **and** the initial value at `shell_v2.dart:183`.
   **Both are needed**, and the persisted key `shellv2_root_order_v1` must be version-bumped,
   or existing users keep their saved order and never see the change.
4. Keep `avaAffiliateEnabled = false`, or Affiliate hijacks the Services slot
   (`app_switcher_bar.dart:82,110`).
5. The root→(icon,label) map is **duplicated in three files** —
   `app_switcher_bar.dart:124`, `shell/v2/app_order_screen.dart:26`, `shell/v2/shell_chrome.dart`.

**ShellV2 also carries AskAva with no kill switch (§5.2).** That must be resolved first.

Note that with Messenger calling dead, ShellV2's second root — **AvaCalls** — is an empty
dialer. The 3-root bar likely becomes two: Marketplace and Messages.

---

## 8. AvaTOK numbers

**Decision: the AvaTOK number replaces the real number publicly.** The real number is
collected for signup/verification only and is never shown to anyone. Every user gets a free
AvaTOK number as their public identity; paid numbers (vanity/short) cost tokens.

### 8.1 What already exists and works

The AvaTOK number is a **virtual, non-PSTN handle formatted like a real local number**
(`worker/src/lib/numbering.ts:1-17`) — never routed over the PSTN. Registry
`avatok_numbers` (`worker/migrations/avatok_numbers.sql:13-27`), one active number per uid.
Routes at `worker/src/routes/number.ts` (`available`, `reserve`, `assign`, `me`, `release`,
`share-card`, `privacy`). Kill switch `numberFeatureEnabled`, default `true`.

**A mandatory "choose your number" gate already ships**: `ava_shell.dart:618-636` blocks the
app behind `NumberSettingsScreen(gate: true)`, which already has a country picker and a
vanity `pattern` search. **The paid-number step slots straight into that screen.**

Real phone numbers are stored only as `sha256(E.164)` (`users.phone_hash`), and there is no
phone verification at all any more — `personal_phone_field.dart:9-29`: *"THIS NUMBER IS NOT
VERIFIED AND MUST NOT GATE ANYTHING."* Phone OTP was unrouted 2026-07-10 (410).

### 8.2 Three things that violate the new rule and must be fixed

1. **The free plan shares the user's REAL number.** `worker/src/routes/number.ts:340-343`:
   *"Paid users share their AvaTOK number; free users their real number."* Consumed at
   `app/lib/core/deep_links.dart:111-112` and `features/avatok/ava_number.dart:103`.
   **This is the exact opposite of the decision and is the single most important fix.**
2. **`users.private_number` stores raw digits** (`number.ts:487-492`,
   `migrations/private_number.sql:13`) with an opt-in `show_private_number` exposure. Under
   the new rule this should go, or become permanently non-exposable.
3. **`assign-own` is unverified by design** (`number.ts:233-239`) — a user can bind any
   well-formatted number as their identity, and `GET /api/add?n=` resolves it publicly
   (`number.ts:377-393`). Someone can claim a real person's number and be findable by it.

### 8.3 Conflict to resolve

`Specs/SPEC-2026-08-09-personal-did-virtual-number.md` is an earlier owner decision to
**retire free AvaTOK numbers entirely** and sell a paid personal DID at 600 tokens/month.
**The 2026-08-27 decision (free number for all + paid upgrade) supersedes it.** That spec
should be marked superseded rather than half-implemented.

There are also **three overlapping number systems**: legacy `avatok_numbers` (live),
`virtual_lines` (dark, `kind IN ('did','avatok')`), and `user_dids` (campaign only).
`number.ts` does **not** check `virtual_lines`, so a collision is possible if
`virtualNumberFreeEnabled` is ever flipped on. Pick one system before building.

### 8.4 Buying a paid number with tokens — the pattern already exists

`virtualDidPurchase` (`worker/src/routes/virtual_lines.ts:109-138`) is literally "buy a
number with tokens": `chargeAmount(...)` with a stable `opId`, `402 insufficient_balance`
on empty wallet, and an explicit **refund via `walletOp` credit** if the provider step
fails. Reuse it verbatim. `telephony_tiers.ts` is the template for monthly renewal
(lazy renewal, no cron, `past_due` + 3-day grace).

### 8.5 Web onboarding parity

The web signup (`web/src/islands/auth/SignUpIsland.tsx:50`) has **two stages only** — form
and email verify — and **no number step at all**. A web signup currently gets its number
only when it first opens the app. A third stage must be added after `'verify'`.

---

## 9. Payments move to the web

**Decision: the app is read-only for money.** It shows token balance and receipts; it
cannot top up. Top-up, checkout and payout all move to the web.

### 9.1 What must be removed from the app

| Surface | File | Rail |
|---|---|---|
| Wallet top-up (Android) — **live today** | `features/wallet/wallet_screen.dart:1337-1341` → `core/wallet_topup_billing.dart:102` | **Google Play Billing**, SKUs `avatok_topup_5/10/25/50/100` |
| Wallet top-up (other) | `wallet_screen.dart:1341` → `:521` | Stripe PaymentSheet |
| Subscription | `features/subscribe/subscribe_screen.dart` → `core/play_billing.dart:59` | Play Billing / Stripe |

`in_app_purchase: ^3.2.0` (`app/pubspec.yaml:213`) and `flutter_stripe: ^11.1.0` (`:113`)
become removable dependencies.

> ⚠️ **`playTopupEnabled` defaults to `true` and is deliberately independent of
> `billingEnabled`.** The Android Play top-up button is **live in production right now**.
> Removing it is a real user-facing change and a Play Store listing change, not a no-op.

**Upside:** removing in-app purchase of digital goods materially simplifies Play compliance
and removes Google's cut.

### 9.2 What the web must gain first

**Web checkout currently quotes USD.** `web/src/islands/checkout/PayStep.tsx` calls
`POST /api/wallet/topup` with `amountUsdCents` and prints `$`, while
`worker/src/routes/wallet.ts` hard-writes `currency:'usd'` on that legacy route. The INR
route `POST /api/wallet/topup/intent` already exists and the app uses it. Backend receipt
emails already print ₹.

**Payments cannot move to the web until this is fixed** — otherwise every buyer is quoted
dollars and receives a rupee receipt. See `WEB-PLATFORM-AUDIT-2026-08-25.md` Gap 2.

---

## 10. Listings are identical on web and app

Both already read the same backend (`api.avatok.ai`, 127 route modules) and the same
`listings` table, whose `kind` is already `live_event | consult`
(`worker/migrations/listings.sql:26-50`). Creator profiles, reviews, promotions,
availability (`worker/src/cal/engine.ts`), bookings, escrow and orders all exist.

**Gap:** production has **no listings**. `GET /api/explore/search?limit=3` returns
`{"listings":[]}`, and everything visible on the homepage is hard-coded demo copy in
`web/src/lib/marketingContent.js`. This is a supply problem, not an engineering one, and it
blocks launch as surely as any code gap.

---

## 11. Sequenced plan

Nothing here is a production flag flip yet. Each step is independently reversible.

| # | Work | Effort |
|---|---|---|
| 1 | Configure GetStream: call types `avatok_livestream` + `avatok_consult_1to1`, role permissions, signed webhook, **set region to Mumbai and verify in the dashboard** | 0.5 day |
| 2 | Set `STREAM_VIDEO_API_KEY` / `_SECRET` as Worker secrets, staging then prod | 1 hour |
| 3 | Apply the 4 commercial migrations to prod D1 (staging-only today) | 1 hour |
| 4 | **INR checkout on web** (blocks §9) | 1–2 days |
| 5 | **GetStream web viewer** — replace Cloudflare WHEP/SFU internals in `web/src/islands/live/` and `.../consult/` | 4–6 days |
| 6 | Smart link + `/j/` page; emailed links currently 404 in a browser | 1 day |
| 7 | Two ticket emails (confirmed, starting-soon), ₹, linking `/l/<id>` | 1 day |
| 8 | **Build the missing kill switches** — `brainEnabled` into `brain_ingest.ts`, real flags for Discuss-with-Ava and AskAva, client-side reads so UI hides | 2–3 days |
| 9 | **`messengerCallingEnabled` kill switch** + hide ~19 call affordances + incoming-push path | 3–4 days |
| 10 | **Fix the free-plan real-number leak** (`number.ts:340-343`) + paid-number purchase via `chargeAmount` | 2–3 days |
| 11 | Web onboarding number step | 1–2 days |
| 12 | Remove in-app top-up / subscription; drop `in_app_purchase` + `flutter_stripe` | 2 days |
| 13 | **ShellV2 + Marketplace landing** — flag flip, default root reorder, key version bump | 2–3 days + soak |
| 14 | Seed real creator listings; two physical accounts; device scenarios on staging | 2 days |
| 15 | Prod flag ladder, one flip at a time | staged |

**Rough total: 5–6 weeks**, dominated by the web viewer, the call teardown, and the ShellV2 swap.

---

## 12. Open questions for the owner

1. **Group conference ≤25** — kill it too, or keep it as a free messenger feature? It is
   already off in prod (`conferenceEnabled=false`) but its UI affordances remain.
2. **Receptionist and voicemail** — they exist to answer calls that will no longer happen.
   Kill, or keep for the paid-consultation lane?
3. **AvaDial / AvaPhone / AvaCalls** — an entire dialer UI with nothing to dial. Remove the
   surfaces, or leave them dark?
4. **Consultation extensions** — `commercialConsultExtensionMinutes` and `...Rate` are both
   `0`. Built but unpriced. Launch with or without?
5. **Old Cloudflare AvaLive** (`worker/src/routes/live.ts` + `app/lib/features/avalive/`) —
   a complete second live stack, dark. Delete after the GetStream lane ships clean?
6. **iOS** — there is no `app/ios/`, no AASA, no Associated Domains. On iPhone the web
   viewer is the *only* experience, which raises its priority above everything else here.

---

## 13. Method

Graphify, Graphiti (`group_id=proj_avaflutterapp`), four parallel read-only code sweeps, and
a cache-busted read of live production config. Every claim was verified against a file per
the ship-gate rule that a memory note is a hint and never a citation. No code was changed,
no flag was flipped, and no production value was written.
