# AvaTalk — Build Proposal (Backend-First, Android-First)

**Prepared:** 2026-06-02
**Source of truth:** `specs-final.md` (v2.0). Where this proposal and the spec
disagree, the spec wins — flag it and we reconcile.
**Scope of this document:** a phased plan for review. **No code is written yet.**

---

## 1. What I studied

**Spec (`specs-final.md`, 1458 lines)** — read end to end. It is the authoritative
master spec: 10 apps + AvaLibrary, Clerk+Nostr identity, MLS-over-NIP-17 messaging,
Blossom-on-R2 media, Bunny video, Cloudflare Workers/D1/R2/Calls/Stream backend,
two-tier human verification, defense-in-depth moderation, full build phasing and
cost model.

**Design (`mobile-design/AvaTOK (standalone).html`)** — a compiled React/Tailwind
prototype (1.8 MB; UI lives in a gzipped JS bundle, not the static DOM). It is a
**visual reference only** — per the spec, the real app must be built in **Flutter,
never React**. What I extracted from it:

- **Brand color:** teal `#08C4C4` (`brand`), with `brand-50` `#E2FCFC`.
- **Ink/neutrals:** `#0F1115` (ink), `#737A86` (sub), `#ECEEF1` (lines), `#F4F5F7`
  (soft), page bg `#E7E9EE`.
- **Type:** Comfortaa (titles/headings), Nunito (body), Pacifico (accent script).
- **Shape language:** large radii (18–28px), pill buttons, chat bubbles with one
  squared corner (`18px 18px 18px 4px`), soft card shadows.
- **Motion:** fade/slide/drawer/toast/heart/wave keyframes — i.e. messaging, a
  dating "heart" interaction, and voice-wave affordances are all in the prototype.
- **Surfaces present:** the bundle references the whole suite — AvaChat, AvaTok,
  AvaTweet, AvaBook, AvaGram, AvaTube, AvaMatri, plus AvaVoice / AvaVerse /
  AvaAgent / AvaNote. So the prototype is a launcher over many apps, not just Tok.

I'll treat the HTML as the **look-and-feel spec** and rebuild it as a Flutter
design system (theme, tokens, component kit), not port it.

---

## 2. Guiding decisions (CONFIRMED with you 2026-06-03)

1. **Backend-first, then build up.** Stand up and smoke-test the Cloudflare backend
   (relay, auth, media, push) before building real product UI.
2. **First milestone = backend wired + a calling SHELL app.** Not a polished UI —
   just enough of a Flutter shell to exercise **both** call paths end to end:
   **P2P** (AvaTok 1:1 WebRTC) **and SFU** (group voice/video via Cloudflare Calls +
   Durable Object). Everything else is built on top of this proven core.
3. **Domain is `avatok.ai`** (single domain; the spec's `abertalk.ai` was wrong and
   has been corrected everywhere). New subdomains: `relay.avatok.ai`,
   `video.avatok.ai`, `blossom.avatok.ai`, `app.avatok.ai`.
4. **Clerk: REUSE the existing avatok.ai tenant.** Not a new one. (Old *infra* —
   workers/KV/buckets — still gets decommissioned later; tenant + domain stay.)
5. **Cloudflare: use the current account** (`hdavy2005@gmail.com`) — it already holds
   the avatok resources. Verify no second CF account exists via dashboard.
6. **Android-only first cut.** Flutter, Android only until the core is proven.
   iOS/desktop later (calling shell is the expensive per-platform piece).
7. **All app builds run on GitHub Actions — nothing builds on the Mac.** CI produces
   the Android `.apk`/`.aab`. (`gh` is already authenticated as `hdavy2002` with
   `repo` + `workflow` scopes, so CI + push are ready.)
8. **FCM/Firebase push is Phase 1**, not deferred.

---

## 3. Backend foundation (Phase 0 + Phase B), before any UI

Everything here is Cloudflare-native per spec §2/§7/§11. Order is dependency-driven.

### Phase 0 — Accounts, domains, skeleton (the "can we deploy?" gate)
- Confirm/establish the Cloudflare account for the new app; wire `avatok.ai` DNS.
- New Clerk tenant (or explicitly-scoped reuse) with phone-OTP + email.
- Bare Workers project (`worker/`) with `wrangler`, CI deploy, health route.
- Provision the **18-database D1 topology** (16 per-user shards + relay + moderation),
  R2 buckets (`avatalk-blobs`, separate `avatalk-verification`), KV (push tokens,
  NIP-05 cache), all under new names.
- Secrets management: Clerk JWKS, Bunny, Stripe, OpenAI moderation, Novu.

### Phase B — Core backend services
1. **Nosflare relay** at `relay.avatok.ai` (fork): event allowlist, NIP-42 AUTH,
   and the **`onEventSaved` push hooks** for NIP-17 DMs + kind 25050 calls. This is
   the keystone — the "Nostr push gap" fix.
2. **Auth Worker** — Clerk JWT verify + NIP-98 verify + tier check on every
   state-changing call; `clerk_nostr_link` table; NIP-05 `/.well-known/nostr.json`.
3. **Push bridge Worker** — relay hook → Novu → FCM (Android first). Token registry in KV.
4. **Blossom-on-R2** — presign + Workers-AI image moderation gate + GET-by-hash;
   `user_media` (AvaLibrary) rows.
5. **AvaTweet moderation path** — OpenAI text moderation + 20/day rate limit.
6. **Calling backend (the milestone keystone):**
   - **STUN/TURN credential Worker** — Cloudflare Calls TURN for P2P NAT fallback.
   - **SFU + Durable Object call room** — one DO per group call (WebSocket
     Hibernation), coordinating Cloudflare Calls SFU for group voice/video.
   - **NIP-100 signaling** (kind 25050) flows through the relay; the relay push hook
     wakes callees via FCM. This is what the shell app will drive.
7. **FCM/Firebase push (Phase 1):** new Firebase project; Android FCM via Novu;
   CallStyle + `USE_FULL_SCREEN_INTENT` wiring designed in from the start.
8. **`ava_mls` package (Rust→FFI)** — start the OpenMLS cross-compile EARLY (spec
   calls this the single hardest task). Android (NDK) target first. Round-trip tests
   in isolation. (Not needed for the calling milestone, but it's the long pole, so
   it runs in parallel.)

**Backend exit criteria:** from a script/curl + the shell app I can register
identity, publish/read a kind-1 note through our relay, upload a moderated blob, sign
a NIP-98 request, trigger an FCM push from a relay event, and **complete both a 1:1
P2P call and a group SFU call** — all on `avatok.ai`. Only then do we build real UI.

---

## 4. Flutter phases (Android, on top of the proven backend)

- **Phase A0 — Calling SHELL app (the milestone):** minimal Flutter Android shell:
  bare onboarding (Clerk login → client-side keygen → npub), a contacts/dial stub,
  `flutter_webrtc` + NIP-100 signaling, native Android calling shell
  (Telecom/ConnectionService, `USE_FULL_SCREEN_INTENT`, CallStyle), FCM wake. Goal:
  **place a 1:1 P2P call AND join a group SFU call.** Test on Xiaomi/Samsung/Oppo/Vivo
  (OEM battery-killers). Built and shipped as an `.apk` **by GitHub Actions**.
- **Phase A1 — Design system & full shell:** rebuild the mockup as a Flutter theme
  (teal `#08C4C4`, Comfortaa/Nunito, component kit), Riverpod, secure storage, full
  onboarding incl. NIP-49 nsec backup.
- **Phase A2 — AvaTok proper:** polish the 1:1 experience, opt-in recording → Bunny.
- **Phase A3 — AvaChat:** NIP-17 DMs with **MLS** inner encryption, message-request
  paradigm, forwarding (zero re-upload), group chat. KeyPackage monitoring.
- **Phase A4 — AvaTweet:** kind-1 feed, compose, reactions/reposts, moderation UX,
  rate limit — validates the public Nostr surface.

Then later phases follow the spec: Tier-2 verification + AvaBook/Gram/Linked →
video (Bunny) AvaTube/AvaLive → AvaDate/AvaMatri → iOS/desktop.

---

## 5. Tooling & access — what I have vs. what I need

### ✅ Confirmed working right now
- **Cloudflare MCP** — verified: can list Workers, D1, R2, KV (read/manage). This is ~80% of the backend.
- **Stripe MCP** — verified: account `acct_1TPECFA05rLa7En1` ("FynextLabs sandbox" — note: sandbox, not production).
- **Novu MCP** — verified: API key loaded, US region.
- **Context7 MCP** — available for fetching current library/SDK docs (NDK, flutter_webrtc, OpenMLS, etc.).
- **PostHog MCP** — available (analytics; create a fresh project keyed by npub).
- **Sandbox shell** — Python/Node/CLI for scripts, codegen, decompiling, testing.

### ⚠️ Gaps / things you'll need to provide or decide
- **Clerk (REUSE existing avatok.ai tenant):** no management MCP connected — only a
  code-snippet helper. I'll need a Clerk **API key / dashboard access** to wire the
  new Workers to the existing tenant.
- **Bunny.net:** no MCP and no API key yet. Needed at the video phase (not the milestone).
- **OpenAI Moderation API key:** needed for text moderation in AvaTweet/AvaChat-adjacent paths.
- **FCM / Firebase project:** **Phase 1.** Need a new Firebase project + the
  `google-services.json` for Android push.
- **Flutter/Rust toolchains:** **not needed locally** — per your call, ALL builds run
  on **GitHub Actions**, nothing on the Mac. I scaffold code + workflows; CI compiles.
- **Wise:** Phase-3 payouts; no MCP; defer.

### ✅ Now resolved
- **GitHub:** `gh` is authenticated on your Mac as **hdavy2002** with `repo` +
  `workflow` scopes (verified via Desktop Commander). I can init, push, and create
  Actions workflows directly — no extra grant needed. Repo:
  `github.com/hdavy2002/avatok-flutter-nostr-cloudflare`.

### 🚫 Connected but NOT to be used (per spec)
- **Supabase MCPs** and **Vercel MCP** are connected, but the spec explicitly removes
  both from the stack (Workers IS the backend). I will not use them unless you override.

---

## 6. Old avatok.ai — what I already found (full list in `OLD_AVATOK_DECOMMISSION.md`)
- 🔴 Confirmed old: Worker `avatok-comms-bridge`, Worker `avatok-video-proxy`, KV `avatok-comms-tokens`.
- 🟡 Likely old (ambiguous names — need your confirm): `upload-api-production`,
  `moderation-callback-production`, `content-ingestion-video-processor`,
  `cleanup-cron(-production)`, `pipeline-orchestrator`, `unitedcockroachesofindia`.
- ⚪ Different projects (leave alone): `jonji-*`, `humphi-*`, `immernah-*`.
- I'll keep appending as I discover more (DNS, Bunny, Clerk tenant, PostHog project).

---

## 7. Decisions — RESOLVED (2026-06-03)

1. **Clerk:** ✅ reuse the existing avatok.ai tenant.
2. **First milestone:** ✅ backend wired + a calling shell app that proves P2P **and**
   SFU voice/video. Build on top after.
3. **Cloudflare account:** ✅ use the current account (`hdavy2005@gmail.com`); verify
   no second account from the dashboard.
4. **GitHub:** ✅ `gh` already authenticated (hdavy2002); I drive init/push/Actions.
5. **Builds:** ✅ GitHub Actions only — nothing on the Mac.
6. **Push:** ✅ FCM/Firebase is Phase 1.

**Still open (not blocking the milestone):** Clerk API key, Firebase project +
`google-services.json`, OpenAI moderation key, Bunny (video phase), and confirmation
of a separate Stripe **prod** account (current one is a sandbox).

---

## 8. Honest risk notes
- **MLS FFI** is the long pole. Worth starting in Phase B even though UI is later.
- **Android OEM push reliability** (Xiaomi/Oppo/Vivo killing background services) is a
  real, testing-heavy problem — budget device-testing time.
- **Self-custody key UX** (nsec backup) is the biggest consumer-UX cliff; spec wants
  NIP-49 from day one — agreed.
- **Verification + moderation are launch-gating** for any public/Tier-2 app; the
  Tier-1 trio lets us build and learn before that burden lands.
