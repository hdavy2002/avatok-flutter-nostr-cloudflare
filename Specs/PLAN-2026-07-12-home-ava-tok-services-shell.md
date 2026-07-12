# Plan — Home · AvaDial · AvaTalk · Services shell + AvaDial PSTN dialer

> **Naming (owner, 2026-07-12):** the PSTN app is **AvaDial** (was "Ava"), the
> messenger is **AvaTalk** (was "Tok"). Older text below may still say Ava/Tok —
> read them as AvaDial/AvaTalk.

**Date:** 2026-07-12 · **Status:** DRAFT for owner review · **Owner:** Humphrey
**Session target:** prod (feature ships dark behind flags; staging first as always)

---

## 1. The big idea, in one paragraph

AvaTOK stops being "a messenger with apps pushed on top" and becomes **four sibling
apps in one shell**: **Home** (dashboard of cards), **Ava** (a Truecaller-style PSTN
phone world: dialpad, device phone book, call log, SMS, spam shield, block list),
**Tok** (a WhatsApp-style messenger: the current AvaTOK chat, in-network calls,
AvaTOK numbers only), and **Services** (marketplace, wallet, payout). PSTN and
in-network worlds are **fully separated** — separate dialpads, separate contacts,
separate logs. The footer is the app switcher only on Home; inside Ava/Tok/Services
the footer belongs to that app and the sidebar carries the cross-app links.

Naming bonus: the brand literally splits into its two halves — **Ava** (phone) and
**Tok** (messenger).

---

## 2. Navigation model (the one rule that keeps this sane)

- **Footer on Home** = app switcher (`Home · AvaDial · AvaTalk · Services`) plus
  **AI as a global ACTION** — the fifth footer item opens the universal Ask Ava
  overlay; it is not an app root (no navigator stack of its own, dismisses back
  to wherever the user was).
- **Footer inside a sub-app** = that app's own tabs (Ava: Dialpad/Contacts/Logs/
  Messages/Block · Tok: Chat/Dialer/Contacts/Logs · Services: TBD).
- **Sidebar** always carries the app switcher (Home, Ava, Tok, Services) plus the
  app-specific menu, so the user is never trapped inside a sub-app.
- Each sub-app is its own `Navigator` (state preserved when switching apps);
  the shell holds them in an `IndexedStack`. Current `AvaShell` "push apps on top
  of chat" model is replaced by this 4-root model.

| App | Footer tabs | Sidebar |
|---|---|---|
| **Home** | Home · AvaDial · AvaTalk · Services · **AI (global action)** | Cards, Identity, Settings, Backup, About, Update |
| **AvaDial** | Dialpad · Contacts · Logs · Messages · Block | Home, AvaTalk, Services, **Ask Ava**, Settings |
| **AvaTalk** | Chat (default) · Dialer · Contacts · Logs | Home, AvaDial, Services, **Ask Ava**, Library, Connectors, Settings |

The AI assistant ("Ask Ava", §4.6) is UNIVERSAL: a footer tab on Home, a sidebar
entry inside every sub-app (opens the same assistant, pre-loaded with that app's
context/tools). Services sidebar gains the same Ask Ava entry.
| **Services** | Marketplace landing (tabs TBD) | Home, Marketplace (submenus), Wallet, Payout, Settings |

---

## 3. Home — the dashboard

A scrollable column of **cards**, each individually toggleable.

**Cards (v1):**

1. **Messages** — two tabs: *SMS* · *Talk* (top 5 unread each), tap-through into
   the owning app. **Phase 1 correction:** the existing `ava_sms_inbox.dart` is
   in-network messaging, NOT carrier SMS — so the v1 card ships the *Talk* tab
   only; the *SMS* tab shows an explicit "SMS available once Ava is your SMS
   app" state until the SMS role is built (Phase 3).
2. **Analytics** — headline PostHog-derived numbers (calls today, messages, etc.).
3. **Call logs** — most recent calls (merged Ava + Tok, labelled).
4. **Wallet** — current balance (tokens), tap → Services wallet.
5. **Earnings** — today / week / month with small graphs (existing earnings data
   from paid calls/listings).
6. **Visitors** — listing traffic with country/city split (source: existing worker
   analytics events → new aggregate endpoint).
7. **Listings** — top-performing marketplace listings (only if user has listings).

**Sidebar → Cards** screen: master list of all card types with on/off switches;
active cards render on Home in user-chosen order (drag to reorder, stored scoped
per account via `scopedKey`).

**Sidebar → Settings** adds three personalisation options: font size, colour theme,
wallpaper (applies to Home; per-account scoped).

---

## 4. AvaDial — the PSTN world (the new build)

Ava deals **only** with the real phone network: PSTN calls via the SIM, the device
phone book, carrier SMS, spam protection. It never touches AvaTOK numbers or the
messenger.

**Reality check (review 2026-07-12):** the "~90% exists" claim applies to
PRESENTATION only. `avaphone/` is explicitly AvaTOK-to-AvaTOK in-network
(ava_phone_screen.dart header), and `MainActivity.kt` has zero telecom code —
no InCallService, no ConnectionService, no screening, no call-log/contacts
providers. **Phase 2 is a native Android product**, opened by a technical
spike covering: default-dialer role lifecycle + rollback; InCallService /
ConnectionService integration + screening behavior; call-log, contacts,
blocked-number and runtime-permission behavior; an OEM/Android-version test
matrix; and a defined fallback UX when Ava is NOT the default dialer.

### 4.1 Footer tabs

- **Dialpad** — dials PSTN numbers via the carrier (`TelecomManager.placeCall`).
  **Long-press paste works** (see bug fixes §7). Dialing NEVER opens messenger UI.
- **Contacts** — the device phone book (read/write via contacts permission).
  This is the user's real address book, Truecaller-style.
- **Logs** — the device call log (default-dialer role grants `READ_CALL_LOG`),
  with spam/friend labels applied from the reputation store.
- **Messages** — carrier SMS inbox. `ava_sms_inbox.dart` is a LAYOUT/interaction
  reference only (it is in-network messaging, not SMS); the functionality is new
  and requires the SMS role (Phase 3, see Open Questions).
- **Block** — the block list. Every blocked number, with per-entry actions:
  unblock, **report as spam** (feeds the community pool).

### 4.2 Onboarding: default dialer opt-in

During onboarding (and later from Ava settings) the user is offered **"Make Ava
your phone app"** → Android `RoleManager.ROLE_DIALER` request. Requires a native
Kotlin layer implementing `InCallService` (incoming + in-call UI) and an
`ACTION_DIAL` activity. Declining keeps Ava useful as dialpad+contacts; the
spam screen then comes from `CallScreeningService` (a separate, lighter role —
we request it even when the user declines full dialer).

iOS: no default dialer exists. Ava on iOS = dialpad (hands off to native call),
contacts, and later a Live Caller ID Lookup extension (phase 3).

### 4.3 The AI-powered call screen (spam shield)

Every incoming PSTN call is checked against the reputation store and painted:

- 🔴 **RED — known spammer** (community score over threshold): full-screen warning,
  default action Decline; options: Answer anyway · Block.
- 🟢 **GREEN — in the user's contacts**: friendly screen, name + avatar.
- 🔵 **BLUE — unknown**: neutral screen with caller info we have (region, carrier)
  and actions: Answer · Decline · Block · **Report spam**.

Post-call, unknown numbers get a one-tap "Was this spam?" prompt — that prompt is
the flywheel that builds the dataset.

### 4.4 Community spam pool — architecture (the 1M-user design)

Owner's instinct: pool all user reports centrally, search fast, cache locally.
Correct — with one engineering correction: **phone-number lookup is exact-match,
not semantic**, so the lookup index is a key-value hit on the E.164 number, not a
vector search. AI Search/vectors would be slower and more expensive for this shape
of query. Where AI *does* earn its keep is **scoring**, not lookup:

1. **Report ingest:** `POST /api/spam/report {number, verdict, reason?}` → queue →
   append-only reports table in D1 (reporter uid, number E.164-normalised, ts).
   Rate-limited per user; recent-contact heuristics to damp abuse/brigading.
2. **Nightly scoring job — DETERMINISTIC formula, not LLM-decided (review
   2026-07-12):** whether a real phone number is marked a scammer must be
   explainable, reproducible, and appealable. The score is a **versioned,
   deterministic weighted formula** over aggregate signals — distinct trusted
   reporters, report velocity, call-pattern stats, number age, line type —
   producing `score 0-100 + formula_version`; RED/BLUE thresholds are config
   flags. Every red verdict can be replayed from its inputs (disputes audit the
   exact formula version + inputs). **AI's only role:** classifying optional
   free-text report reasons into categories (scam/telemarketer/robocall) that
   feed the formula as one weighted input — never deciding the verdict.
   **Consensus rules (one report NEVER marks spam):**
   - RED requires ≥N distinct, unrelated reporters in a rolling window
     (N config-flagged; propose 5) AND/OR corroborating behavioral signals
     (mass short-duration calling pattern, VoIP line type, fresh number).
   - 1..N-1 reports → number stays BLUE with an honest "Reported by K users" line.
   - **Reporter trust weights:** reporters earn weight by agreement history;
     new accounts start low, so brigading (burst of fresh accounts reporting one
     victim) barely moves the score. Reports on recent two-way contacts damped.
   - **Decay + redemption:** scores decay over months without fresh reports
     (carriers recycle numbers); dispute/unblock path so a wrongly-flagged
     number recovers. Red screens always show the why: "47 reports · robocall
     pattern".
3. **Published index (read path) — CORRECTED 2026-07-12 (rulebook compliance):**
   KV is banned for queryable data (rulebook: KV restricted to 5 ephemeral uses;
   "can Cache API handle this?"). Scored numbers live in **D1** with an indexed
   E.164-hash column; the lookup route (`GET /api/spam/lookup/<e164>`) serves
   through the **Cache API** (edge-cached per number, TTL ≈ 24h — scores change
   nightly, so cache hits are the norm and D1 only sees cold numbers). The
   signed **Bloom filter + version manifest distribute from R2** (no egress
   fees, CDN-cached).
4. **On-device cache (the fast path):** the app ships a compact **Bloom filter /
   top-N spam list** (~the few hundred thousand worst numbers compress to a few MB),
   refreshed daily. Screening decision is **local-first**: bloom-filter miss =
   definitely not a known spammer → paint blue/green with zero network. Hit →
   confirm with one call to the edge-cached D1 lookup endpoint. Works offline;
   call screen never waits on the network.
5. **Cold start:** seed with public robocall complaint datasets (FTC/FCC) so the
   filter is useful on day one, before user reports accumulate.

Per-account scoping rules apply to all local state (rulebook rule 1); the shared
pool is global by design (it's community data, no per-user content in it).

**Cost check:** entire pipeline is Workers + D1 + Cache API + R2 + one nightly
AI job — no per-user marginal cost worth mentioning. This is the free product.

### 4.5 Explicitly out of scope for Ava v1

- PSTN voicemail / AI receptionist via call forwarding (separate initiative;
  geo-dependent per the 2026-07-12 discussion — US/Canada first via wholesale
  DIDs, India excluded).
- iOS Live Caller ID Lookup (needs Apple's PIR server stack — phase 3).
- Being an SMS *default* app (see Open Questions).

### 4.6 Universal AI assistant ("Ask Ava")

**Placement (owner, 2026-07-12):** universal, not AvaDial-only. Footer tab on
Home; sidebar entry in AvaDial, AvaTalk, and Services. One assistant, one thread
history; opening it from inside an app seeds it with that app's context and
tool set (from AvaDial → dialer tools primed; from AvaTalk → messenger search;
from Services → listings/wallet queries).

A ChatAVA-style chat surface that makes the whole app AI-powered — for the
dialer especially:
"call the plumber from last Tuesday", "find Ramesh's second number", "what did
the bank SMS me about my card?", "who called me most this month?".

**Architecture — the brain is personal, not central.** The community spam pool
(§4.4) stays the only centralized dataset. Contacts/call-history/SMS are
PERSONAL data and are NOT bulk-uploaded to any central brain (Truecaller's
contact-harvesting is a Play-policy + GDPR minefield; we don't copy it).
Instead, reuse the two patterns we already have:

1. **Tool-calling over local SQLite (primary, works for everyone).** The
   assistant is an LLM session (existing `ava_ai_client.dart` stack) with
   device-side tools: `search_contacts(q)`, `search_call_log(q, range)`,
   `search_sms(q, range)`, `dial(number)`, `block(number)`,
   `spam_lookup(number)` (the one CENTRAL tool — hits the §4.4 edge-cached D1
   lookup endpoint).
   Only the user's query + the few matching rows transit to the model;
   nothing is stored server-side. Fuzzy/semantic matching runs on-device
   (SQLite FTS5 over names/SMS bodies; optional small on-device embedding
   later).
2. **RagService lane — HARD BOUNDARY (corrected 2026-07-12).** `rag_service.dart`
   today ingests into a SERVER-PROVISIONED Cloudflare AI Search store even
   without a BYO key (premium-gated). That is fine for files/chats the user
   explicitly shares with @ava — but **AvaDial data (SMS bodies, contacts,
   call logs) must NEVER be auto-ingested into any server store.** Rule:
   local tools may return minimal matching rows to the model per-query;
   ingestion of AvaDial data requires a separate, explicit, per-category
   opt-in that is OFF by default and clearly labelled.

**Action safety:** `dial`, `block`, and `report_spam` tool calls always render a
confirmation chip — the assistant never dials/blocks/reports autonomously.

**Consent:** this is an AvaBrain surface — per-app guardrail toggle registered in
main Settings (rulebook rule 3, default ON, master switch honoured). SMS/contacts
tool access additionally requires the OS permissions AvaDial already holds.

**UX:** chat interface identical to ChatAVA (reuse composer/thread widgets);
answers render actionable chips — a found contact renders Call/Message buttons,
a found SMS deep-links into Messages. Assistant threads are scoped SQLite →
ride the §4.7 backup automatically.

### 4.7 Backup & restore of AvaDial data

Rule (two tiers, consistent with the §4.7 device-data boundary):

- **Ava-owned metadata backs up AUTOMATICALLY** — block labels, spam-report
  history, assistant threads, Home card layout, theme prefs. These live in the
  per-account scoped SQLite and ride the existing `BackupService` encrypted
  blob (AVBK1: premium R2 sync lane + free user-own Google Drive lane).
- **OS-owned data (contacts, call log, SMS) backs up ONLY after the explicit
  per-account import choice** (§4.7 item 3). Until the user opts a category in,
  it is read live and never enters any account's backup.

No new backup infrastructure either way.

Two pieces of real work / decisions:

1. **Restore-to-system (Phase 2 feature):** restoring OUR database is automatic;
   pushing data back into Android needs explicit user-triggered actions —
   re-insert contacts via the contacts provider, re-apply block list via
   `BlockedNumberContract` (default-dialer privilege), re-insert call log rows
   (`WRITE_CALL_LOG`). SMS restore requires the SMS role. UI: "Restore to phone"
   with per-category checkboxes.
2. **RESOLVED (was stale) — lost-phone recovery already exists.** The AVBK1
   passphrase is ALREADY server-escrowed: `POST /api/keybackup?kind=bk`
   (worker/src/routes/keybackup.ts) stores it wrapped under KEY_WRAP_MASTER,
   Clerk-session gated, first-write-wins; `backup_service.dart` adopts the
   escrowed value on reinstall. Model is deliberate server-escrow (not
   zero-knowledge): Drive/R2 holds ciphertext, D1 holds the wrapped key,
   neither alone readable; a Clerk sign-in recovers both. No new work needed —
   AvaDial data inherits working new-phone restore.

3. **Device-data boundary (per-account scoping vs device-global data).**
   Contacts, carrier SMS, and call logs are DEVICE-GLOBAL; accounts are not
   (shared parent/child phone — rulebook rule 1). Naive per-account snapshots
   would duplicate a parent's private call history into a child's encrypted
   backup. Rules:
   - OS data is read LIVE and never silently imported into an account backup.
   - Any snapshot/archive into scoped SQLite requires an explicit per-account
     "import to this account" choice.
   - Block labels, spam reports, Home layout, and AvaDial metadata ARE
     account-scoped as normal.
   - Account switching immediately clears in-memory OS-derived data.

---

## 5. AvaTalk — the messenger (mostly a move)

Current AvaTOK messenger moves under the Tok tab wholesale. Changes:

- **Footer:** Chat (default) · Dialer · Contacts · Logs.
- **Chat** = current chat list; add a **Groups** header tab inside Chat.
- **Dialer** dials **AvaTOK numbers only** (existing in-network dialpad —
  the current AvaPhone screen minus any PSTN ambitions). Copy-paste works here too.
- **Contacts** = AvaTOK contacts only (in-network friends), never the device book.
- **Logs** = in-network call history (existing `call_log_store.dart`).
- All existing business-call / receptionist / voicemail flows stay exactly where
  they are — they are Tok/AvaTOK-number features and are untouched.

---

## 6. Services

- Landing = **marketplace browse** (existing `marketplace_browse.dart`).
- Sidebar: Home · Marketplace (submenus: My Listings, Sell, Archived) · Wallet ·
  Payout · Settings.
- Wallet/Payout screens already exist — they rehome here from the current sidebar.

---

## 7. Bug fixes that ship FIRST (independent of the restructure)

These two are live irritations and don't need to wait for the shell work:

1. **Paste into dialpad.** Long-press paste + a paste icon on the dialpad input;
   normalise pasted junk (`spaces, dashes, (), +`) into digits.
2. **Dialing opens messenger UI.** Today a manual dial lands in the messenger
   thread/interactive UI. Dial must go straight to the full-screen call UI
   (the business-call screen already built) and never into a chat surface.

---

## 8. Build phases

- **Phase 0 — quick wins:** §7 bug fixes on the existing dialpad. Small, ships now.
- **Phase 1 — shell restructure:** 4-root shell + footer/sidebar model; move
  messenger → AvaTalk, marketplace/wallet/payout → Services; Home v1 with
  Wallet + Call-logs + Messages(Talk-only) cards. Flag: `shellV2`.
  **Prerequisite — navigation contract (review P1-7):** before building the
  4-root shell, write down: deep-link + notification routing per root (an
  incoming AvaTalk call / marketplace push must land in the right navigator,
  never duplicate screens), Android back behavior per root, per-root
  restoration IDs, and whether switching roots preserves nested routes
  (decision: yes — IndexedStack keeps state).
  **Card contract (review P1-8):** every Home card defines: API endpoint
  (server-precomputed aggregate — Home rendering NEVER queries PostHog
  directly), empty state, loading budget, freshness window, eligibility, and
  failure fallback. Rollout telemetry for `shellV2`: selected root, card render
  latency, card taps, permission/role conversion, screening lookup latency,
  false-positive disputes, role-removal rate.
- **Phase 2 — AvaDial PSTN core (Android) — a native product, spike first
  (§4 reality check):** the spike de-risks the telecom layer; then ROLE_DIALER
  + InCallService + CallScreeningService, device contacts, device call log,
  block list, red/green/blue screens backed by the reputation store (§4.4).
  Flags: `avaDialer`, `spamShield`.
- **Phase 3 — polish + breadth:** remaining Home cards (earnings, visitors,
  listings, analytics), card manager + drag-reorder, themes/wallpaper; iOS Live
  Caller ID Lookup; SMS role + real SMS Messages tab.

Everything ships dark; flags default false in `config.ts` DEFAULTS per the
staging/prod protocol. Worker changes (spam routes, scoring job, card aggregate
endpoints) deploy before app builds.

---

## 9. Open questions for the owner

1. **RESOLVED (proposed):** SMS role deferred to Phase 3; Home Messages card
   ships Talk-only in Phase 1 with an explicit SMS-unavailable state (§3).
2. **RESOLVED (proposed):** open to the LAST-USED root; Home is the first-run
   default.
3. ~~AvaDial footer over budget~~ **RESOLVED 2026-07-12:** Ask Ava is universal —
   Home footer tab + sidebar entry in each sub-app. AvaDial footer stays
   Dialpad · Contacts · Logs · Messages · Block.
4. **RESOLVED (proposed):** Groups = a FILTER on the existing chat list, not a
   second chat-list implementation.
5. **RESOLVED (proposed):** fixed default card order in v1; drag/reorder in
   Phase 3 once usage data shows which cards matter.
6. **RESOLVED (stale):** lost-phone recovery already exists — server escrow via
   `/api/keybackup?kind=bk` (§4.7). No decision needed.
7. Services: Wallet/Payout entries hide wherever their existing feature flags
   disable them (route group stays).

---

## 10. What this plan deliberately does NOT change

Per-account scoping, image/media pipeline, universal storage, AvaBrain consent
(rulebook rules 1–3), the AVA-BIZCALL stack, AvaTOK number system, group
conference rules, and the manual-build/git protocols all stay as-is.
