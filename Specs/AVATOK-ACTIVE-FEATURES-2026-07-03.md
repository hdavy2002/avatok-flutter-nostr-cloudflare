# AvaTOK — Active Feature Inventory (2026-07-03)

Compiled from worker code (`worker/src/routes/config.ts` flag defaults, route files), Flutter client
(`app/lib/core/remote_config.dart`, `feature_flags.dart`, `app_registry.dart`), and Specs/. Verified by
Fable against code on 2026-07-03. "Active" = flag ON in code defaults + UI reachable. Free-launch context:
`betaFreePremium: true` (everyone premium, no metering), `billingEnabled: false`.

---

## 1. Messaging (AvaTOK core)

**ACTIVE** — durable messaging via per-user **InboxDO** (hibernatable WebSocket + DO-local SQLite),
`worker/src/routes/messaging.ts`. Ably fully removed (routes/ably.ts deleted); PartyKit ephemeral layer
(`do/party.ts`) is built but **dark** (`PARTY_ENABLED` secret unset).

User-facing capabilities (`app/lib/features/avatok/`):
- Text, media (image/video/audio/file), voice notes with live Whisper transcription
- Stickers / emoji / GIF (`richInputEnabled: true`), polls, live + one-shot location, contact cards
- Reactions (floating pill, double-tap heart, reacted-by sheet), forwarding (`unlimitedForwardEnabled: true`)
- In-thread search + global search, link previews, in-chat AI image generation (`imageGenEnabled: true`)
- Smart replies (`smartRepliesEnabled: true`), scam auto-scan (`scamAutoScanEnabled: true`),
  stranger-safety gate (`strangerGateEnabled: true`), auto-responder
- Groups: server-backed (D1 `conversation_members`), full messaging feature set; group invites and
  group translation are **OFF** (`groupInvitesEnabled/groupTranslationEnabled: false`)

Dormant: R2 cold archive + restore-v2 (`chatArchiveV2/restoreV2: false`), D1 state mirror
(`MSG_STATE_STORE` dark).

## 2. Voice & Video Calls

- **1:1 calls — ACTIVE.** P2P via CallRoom DO, 2-peer cap (rulebook: never raise). Video toggle in
  `call_screen.dart`. Wakelock keeps screen on during calls.
- **Group conferences — ACTIVE.** LiveKit, ≤25 participants (`conferenceEnabled: true`;
  `worker/src/routes/conference.ts` + `app/lib/features/conference/`). Client gate at
  `chat_thread.dart:1971`; server rejects >25; LiveKit `max_participants=25` backstop.
- **CF-native SFU group audio (≤32) — DORMANT.** Built (`routes/groupcall.ts`, GroupCallRoom DO) but
  `groupAudioSfuEnabled: false`; LiveKit remains the live group path.
- **AI ringback tones — ACTIVE** (`ringbackEnabled: true`).
- Call recording: not implemented. In-call live translation: **OFF** (`translationEnabled: false`).

## 3. Phone / AvaTOK Number

**ACTIVE** — virtual number (`numberFeatureEnabled: true`, `routes/number.ts`,
`features/avatok/ava_number.dart` + number settings), dialpad in AvaTOK bottom nav, AvaPhone screen
(Calls / Messages / Contacts tabs), SIM-only phone verification (`simOnlyPhoneEnabled: true`),
device-contacts integration (flutter_contacts).

## 4. AI Receptionist

**ACTIVE** — personal AI receptionist (`receptionistEnabled: true`, Gemini Live engine,
`routes/receptionist.ts`; settings UI in `settings/sections/receptionist_section.dart`). Answers missed
calls, takes messages, handles unknown callers (shows caller number, save-as-contact), 30-voice picker.
Free-launch: available to everyone (was premium-only in v3).

Dormant: **Team Receptionist / IVR** (`teamIvrEnabled: false`, hard 503 — "OFF until dogfood passes"),
AI front-desk NL IVR (`ivrAiFrontDesk: false`), CF-native receptionist engine path (unselected).

## 5. AI Assistant (Ava)

**ACTIVE**: basic Ava chat (AvaChat/Companion tile visible), Guardian (`guardianEnabled: true`),
Discuss-with-Ava, generative features (`kGenerativeEnabledDefault: true`), image generation, Focus Mode
(default on). Fair-use caps still enforced: 25 Ava turns/day, 100 images/day.

**DORMANT** (cost control during free launch): web search, file analysis, uncapped chat
(`kWebSearchEnabledDefault/kFileAnalysisEnabledDefault/kOpenChatUncappedDefault: false`), **AvaBrain**
(`brainEnabled: false` — contradicts rulebook "ON by default"; settings page exists, re-promoted
2026-07-03), AvaVoice, AvaVision, live translation, AI voice call (`aiVoiceCallEnabled: false`).

## 6. Storage & Backup

- **AvaLibrary / AvaStorage — ACTIVE** (visible tiles, in Focus Mode). Universal per-account
  content-addressed storage pool.
- **Google Drive auto-backup — ACTIVE** for ALL users, no premium gate (`driveAutoBackup: true`).
  Back-up & restore panel lives in AvaStorage (Settings Backup tile hidden 2026-06-29,
  `settings_screen.dart:381-398`). New-phone restore pipeline fixed 2026-07-02 (passphrase escrow,
  incremental encrypted media backup).
- R2 encrypted backup lane (BackupDO): gated off (`isEntitled=false`); restore-v2 dark.

## 7. Identity & Accounts

**ACTIVE**: Progressive Identity ladder L0–L3 + guest handle-first onboarding, AvaIdentity tile
(unhidden 2026-06-30), Workers AI liveness (`workersAiLivenessEnabled: true` — **ON 2026-07-03**,
CF-native, no AWS), listing liveness gate (`listingLivenessGate: true` — ON 2026-07-03: one-time
liveness to publish a listing), per-account scoping (parent + child on one phone), App Links
(`avatok.ai/add` → app or Play Store).

Dormant: onboarding hard liveness gate, profile completion gate, account-type/add-AI signup steps,
Facebook/LinkedIn social auth (all false).

## 8. Wallet / Billing / Monetization — FREE LAUNCH STATE

Everything money-related is effectively **OFF for users**:
- `betaFreePremium: true` — whole client renders premium, `chargeFeature` no-ops
- `billingEnabled: false` — subscriptions/checkout 503; paywall/upgrade/top-up UI hidden
- `walletRealMoney: false` — real money-in blocked (Stripe keys are test-mode); AvaWallet tile hidden
  (deep-link routable only); AvaPayout idle
- `donationsEnabled: true` in flag but blocked in practice by walletRealMoney
- AvaAffiliate: DORMANT (`avaAffiliateEnabled: false`)
- AvaConsult (paid consulting): DORMANT (`consultEnabled: false`)

## 9. Marketplace / Social

- **Marketplace/listings**: tile visible, but destination gated by `marketplaceEnabled: false` (client)
  — effectively dormant during free launch; listing-liveness gate active server-side. Listing photos
  (1–5 mandatory) + creator analytics built. AI negotiation / marketplace agent settings flags true
  but moot while marketplace is off.
- **AvaLive** (streaming): DORMANT (`liveEnabled: false`).
- **AvaVerse creator dashboard**: DORMANT (`verseEnabled: false`).
- Explore (legacy creator grid): hidden tier, deep-link only.
- Placeholder apps (AvaTweet, AvaGram, AvaTube, etc.): route stubs → ComingSoon.

## 10. Integrations

- **AvaApps (Klavis MCP) — visible tile**: connect Gmail/Calendar/Drive etc.; functional pending
  KLAVIS_API_KEY.
- Web: avatok.ai marketing/legal pages live; contact → Brevo → support@avatok.ai.

## 11. Deprecated (do not resurrect)

Nostr relay, NIP-17/44/59 gift-wrap E2E messaging, keypair identity, the relay Worker
(archived `_ARCHIVE-2026-06-10/`). Ably transport (removed 2026-07-01; PartyKit is the dark successor).

---

## Summary — what a user gets today

Messaging (full-featured 1:1 + groups) · 1:1 P2P voice/video calls · LiveKit group conferences ≤25 ·
free virtual number + dialpad + SIM verification + AI ringback · personal AI receptionist · basic Ava
AI chat + Guardian (capped) · AvaLibrary/AvaStorage with Drive auto-backup · progressive identity with
CF liveness · everything free (no paywalls, billing off).

### Discrepancies flagged for owner
1. **CLAUDE.md/memory stale on Ably**: `MSG_TRANSPORT`/`messagingProvider` kill switch no longer exists
   in code — Ably code was deleted and replaced by dark PartyKit (`PARTY_ENABLED`). Docs pending rewrite.
2. **AvaBrain**: rulebook says "ON by default (opt-out)" but `brainEnabled: false` in code. Intentional
   for free launch, or gap?
3. **Live translation**: shipped 2026-06-11 but `translationEnabled: false` — currently OFF for users.
4. Code defaults shown here can be overridden at runtime via KV `platform_config`; this report reflects
   code defaults verified 2026-07-03 plus known KV state from project memory.
