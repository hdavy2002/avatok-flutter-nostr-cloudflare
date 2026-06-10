# AvaTOK Creator Marketplace — Universal Proposal

**Date:** 2026-06-10 · **Owner:** davy · **Status:** APPROVED DIRECTION
**Arch base:** `Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md` (Cloudflare-native, Nostr nulled)

This is the single master file. Each phase below has its own self-contained `.md`
(`PHASE-01.md` … `PHASE-10.md`). For a fresh session: upload THIS file + the one
phase file being worked on. Nothing else is required.

---

## 1. The goal (one paragraph)

AvaTOK is a **creator-economy marketplace**. Creators publish **live streaming
events** (1-to-many, AvaLive) and **paid consultation sessions** (1:1 or 1:10/1:20,
AvaConsult). Users browse the **AvaExplore** marketplace, book/join, and pay from
their **AvaWallet** (AvaCoins backed by USD, topped up via Stripe). Money sits in
**escrow** until the session completes, then settles to the creator's wallet minus
a **20% platform fee**. Creators withdraw via **AvaPayout** (Wise API), gated by
**AvaIdentity** (Stripe Identity video KYC). Everything the creator does is visible
in one dashboard (**AvaVerse**), one calendar (**AvaCalendar/AvaBooking** — conflict-aware
across all apps), one inbox (**AvaInbox**), one file pool (**AvaStorage/AvaLibrary**),
and one personal AI (**AvaChat → AvaBrain**).

## 2. Standard apps (build these; hide the rest)

| App | Role | Phase |
|---|---|---|
| AvaWallet | AvaCoins balance, Stripe top-up, full transaction trail (paginated + filters) | 2 |
| AvaIdentity | Stripe Identity video-KYC gateway; gates payout, consult listings, live listings | 3 |
| AvaPayout | Withdraw wallet → bank via Wise; bank-details flow; KYC-gated | 3 |
| AvaStorage | Usage dashboard: per-type counts + colored graphs/bars, live-updating; 5 GB free quota | 4 |
| AvaLibrary | Every file/picture/PDF from ANY app, one content-addressed pool | 4 |
| AvaCalendar | ONE availability engine for the whole platform; Google Calendar sync | 5 |
| AvaBooking | Creator's bookings calendar (blips → detail cards) | 5 |
| AvaExplore | Marketplace: categories, event/consult cards, details, creator channels, live-now | 6 |
| AvaLive | Live event creation pipeline + streaming (Cloudflare Stream Live) | 7 |
| AvaConsult | Paid sessions: 1:1 P2P, 1:10/1:20 via Cloudflare Realtime SFU | 7 |
| AvaVerse | Creator bird's-eye dashboard: earnings, projections, analytics, top reviews | 8 |
| AvaInbox | Universal inbox: messages from event pages, channel pages, any future app | 8 |
| AvaChat | ChatGPT-like interface to AvaBrain (personal AI over the user's own content) | 9 |
| AvaTalk (existing messenger) | Gets group conferencing ≤25 via LiveKit (RULE CHANGE) | 10 |

**Hidden until later:** AvaTweet, AvaBook, AvaGram, AvaWeb, AvaNote, AvaTube,
AvaAds, AvaLinked, AvaTind, AvaMatri, AvaVoice, AvaAgent, AvaAI (sidebar registry
keeps them; UI filter hides them). A signup ends with exactly the standard apps.

## 3. Two immediate product decisions

1. **Onboarding account-type step DISABLED.** The Single/Parent/Enterprise step
   (step 0 of `app/lib/features/onboarding/onboarding_flow.dart`) is skipped behind
   a flag, default `AccountKind.personal`. Code stays for later re-enable. (Phase 1)
2. **AvaTalk group-call rule CHANGED (owner decision 2026-06-10).** Groups may hold
   audio/video conferences, max 25 participants, via LiveKit. >25 members ⇒ call icon
   disabled + notice popup. 1:1 calls stay P2P (CallRoom DO). CLAUDE.md + rulebook
   must be updated in Phase 10.

## 4. Money model (canonical — every phase obeys this)

- **Currency:** AvaCoins, backed 1:1-pegged by USD via Stripe top-ups (user funds any
  amount). All marketplace prices displayed in $ and charged in coins.
- **Ledger:** double-entry rows in D1 `wallet_ledger`; every movement has
  `type` (topup, purchase_hold, escrow_release, refund, fee, payout, storage_charge),
  `ref` (order/event/booking id), and is immutable. Wallet balance = derived + cached.
- **Escrow:** purchase moves coins `user wallet → escrow account` (a platform-owned
  ledger bucket per order). Nothing reaches the creator until settlement.
- **Settlement:** after event/consult completes → 80% to creator wallet, 20% platform
  fee row. Trigger: stream ended + grace window, or consult marked complete.
- **Refund rules (engine in Phase 7, rules data-driven):**
  - Creator no-show 20 min after start ⇒ 100% auto-refund + email to both.
  - User no-show, creator waited 20 min ⇒ creator gets 20-min pro-rata of the price,
    remainder refunded + "you never showed up" email.
  - User cancels ≥24 h before ⇒ 100% refund. <24 h ⇒ 50% (configurable).
  - Creator cancels anytime ⇒ 100% refund + strike on creator account.
  - Platform/system failure ⇒ 100% refund, no fee.
- **Live donations/tips:** viewers donate from their wallet during a stream;
  ledger type `donation`, settles to the creator INSTANTLY minus the 20% fee
  (no escrow — it's a gift, not a deliverable). Shown on-stream as a banner.
- **Projections (AvaVerse):** `joined × price × 0.80` shown as "you may earn ~$X".
- **Transactional emails (Brevo, templates in Phase 5):** booking confirmed,
  **1-hour-before reminder with join link** (events AND consults), refund issued
  (per rule, incl. no-show wording), settlement paid, payout sent/failed,
  cancellation. Every money/booking state change = an email + push.

## 5. KYC gating matrix (AvaIdentity = Stripe Identity)

| Action | Requires verified KYC |
|---|---|
| Browse, buy, join events, top up wallet | No |
| Add bank details / withdraw (AvaPayout) | **Yes — checked before adding bank** |
| Create AvaConsult listing | **Yes** |
| Create AvaLive event listing | **Yes** |

KYC status lives in existing D1 `account_status.kyc`; docs in `avatok-verification` R2.

## 6. Architecture invariants (from the Cloudflare-native arch — do not violate)

- Backend = `avatok-api` Worker + Durable Objects + D1 (low-write global surfaces
  only) + R2 + Queues + `avatok-consumers`. No new central high-write D1 stores.
- Messages/inbox per user = `InboxDO` (DO-local SQLite). AvaInbox rides on it.
- Identity = Clerk user id. **Per-account scoping is mandatory** on device:
  `scopedKey(...)` / `AccountScope.id` for every new local store (rulebook §1).
- Public images: `/upload/public` → `/cdn-cgi/image/...` AVIF → on-device cache.
- Client = local-first SQLite (drift) + one indexed query per screen.
- Emails: Brevo (already wired on `avatok-consumers`). Push: FCM via Q_PUSH.
- Analytics: PostHog per `ANALYTICS-OBSERVABILITY.md` (BINDING — envelope on
  every event, per-app catalogs, worker-side mirror events, per-phase
  verification query). That file also records the scheduling/realtime decision:
  Cloudflare Cron Triggers + DO Alarms for all timing, DO WebSockets for all
  realtime — **no Ably, no third-party cron**.
- Video: AvaLive = Cloudflare Stream Live; AvaConsult group = Cloudflare Realtime
  (RealtimeKit already used in `avaconsult/`); AvaConsult 1:1 = P2P (CallRoom DO
  pattern); AvaTalk group conf = LiveKit (≤25).
- AvaBrain consent: master switch + per-app guardrail toggles (default ON), checked
  by the ingestion pipeline before anything is indexed.

## 7. Phase index

| Phase | File | Delivers |
|---|---|---|
| 1 | PHASE-01.md | Groundwork: onboarding step off, standard-apps sidebar, app registry, D1 migration scaffold |
| 2 | PHASE-02.md | AvaWallet: ledger, Stripe top-up, escrow buckets, transaction UI (pagination+filters) |
| 3 | PHASE-03.md | AvaIdentity (Stripe Identity) + AvaPayout (Wise) |
| 4 | PHASE-04.md | AvaStorage + AvaLibrary: universal pool, 5 GB quota, live usage graphs |
| 5 | PHASE-05.md | AvaCalendar + AvaBooking: conflict engine, Google sync, blip calendar |
| 6 | PHASE-06.md | Listings pipeline + AvaExplore marketplace + creator channel pages + reviews |
| 7 | PHASE-07.md | AvaLive + AvaConsult delivery: streaming, sessions, escrow settle, refund engine |
| 8 | PHASE-08.md | AvaVerse dashboard + AvaInbox universal inbox |
| 9 | PHASE-09.md | AvaChat ⇄ AvaBrain: chat UI, guardrails screen, Whisper voicemail → Vectorize |
| 10 | PHASE-10.md | AvaTalk group conferencing (LiveKit, ≤25) + rulebook updates |

**Dependency chain:** 1 → 2 → 3; 4 independent after 1; 5 after 1; 6 needs 2+5;
7 needs 2+3+5+6; 8 needs 6+7; 9 after 4; 10 independent after 1.

## 8. Performance & memory (BINDING)

`PERF-MEMORY-BUDGET.md` applies to every phase: one shared libwebrtc for ALL
video (Cloudflare SFU used via plain flutter_webrtc — no Dyte/RealtimeKit SDK),
one multiplexed WebSocket for all realtime, capped image/media caches, paginated
lists everywhere, screens release memory on close, all AI server-side, and hard
budgets (APK < 60 MB/ABI, steady-state RSS < 220 MB, +30 MB max after opening 5
apps). Upload that file along with each phase file at session handover.

## 9. UI mandate — no demo screens survive

Every phase ships REAL, functional Flutter UI wired to the live backend. Existing
demo/dummy screens (AvaExplore mock cards, placeholder dashboards, etc.) are
REPLACED, not styled. A phase is not done if any of its screens render hardcoded
data. The only allowed placeholder is the Phase-1 `ComingSoonScreen` for apps
whose phase hasn't shipped yet — and each phase deletes its own. Acceptance
criteria in every phase must be demonstrated against deployed worker APIs.

## 10. Existing-code reconciliation (2026-06-10)

Phases 2–10 were audited against the repo: **every phase file now opens with an
"ALREADY BUILT" section** listing what exists and must be extended, not redone.
Headlines: Phase 1 kill switches shipped (`routes/config.ts`); wallet =
WalletDO authority + D1 `avatok-wallet` ledger; KYC = existing AvaID gateway
(`routes/id.ts`, Rekognition) gaining Stripe Identity as a second provider;
payout routes complete (`routes/payout.ts`, min $10, spendable-only); file
index = `user_media` (+library extension), not a new table; calendar slots/
bookings exist but are **npub-keyed → must migrate to Clerk uid** (Phase 5 first
task); AvaOLX marketplace patterns reusable; donations = existing
StreamSessionDO gift engine; AvaBrain has UserBrainDO + knowledge graph +
`brain_consent` guardrails + agent conversation plumbing; GDPR deletion
consumer exists. Trust the phase files' ALREADY-BUILT sections over older
wording elsewhere in the same file.

## 11. Audit addendum

The 2026-06-10 three-perspective audit's **[MUST] and [SHOULD] items are folded
into the phase files** as "Folded from audit" sections — they are part of each
phase's scope and acceptance criteria, not optional extras.
`AUDIT-SUGGESTIONS.md` now serves only as the **[LATER]** backlog (replays,
waitlists, gift bookings, co-hosts, tiered tickets, memberships, multi-currency,
API versioning, load tests) — revisit post-launch.

## 12. Session-handover protocol

Each phase file is self-contained: objective, prerequisites, schema, endpoints,
Flutter screens, acceptance criteria, and "definition of done". At the end of every
phase: deploy, log a Graphiti episode (`group_id="proj_avaflutterapp"`), update
STATUS_REPORT.md, and commit. Start the next session with this file + next phase file.
