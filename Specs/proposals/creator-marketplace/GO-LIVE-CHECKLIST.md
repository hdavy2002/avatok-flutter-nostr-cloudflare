# Go-Live Checklist — rewritten 2026-06-10 (evening)

Single source of truth for what stands between "all 10 phases built" and
"creators earning money". Update in place as items close.

---

## ✅ DONE (2026-06-10)

**Code & git**
- Phases 1–10 built. Consolidation commit `c136abf` + follow-up `4b903af`
  pushed to `main` → CI building APK.
- Whisper voicemail transcription falls back to Workers AI
  (`@cf/openai/whisper`) — no OpenAI key required.
- `WALLET_TOPUP_ENABLED=1` on STAGING (prod stays 0 pending legal).

**Deploys** — avatok-api + avatok-consumers, prod AND staging, all current.
Smoke: `/api/time` 200, guest `/api/explore` 200.

**Secrets set on workers** (values recoverable in `secrets/secret-values.env`):
LIVEKIT_API_KEY/SECRET · RTK_ORG_ID/RTK_API_KEY · TURN keys ·
JOIN_LINK_SECRET · GCAL_TOKEN_KEY · STRIPE_SECRET_KEY (test, prod+staging) ·
STRIPE_WEBHOOK_SECRET + STRIPE_IDENTITY_WEBHOOK_SECRET (4 fresh endpoints
created via Stripe API: wallet+identity × staging+prod) ·
GOOGLE_CLIENT_ID/SECRET (prod+staging) · POSTHOG_PERSONAL_API_KEY ·
BREVO_API_KEY · POSTHOG_API_KEY · FCM_SERVICE_ACCOUNT (consumers).

---

## 🤖 CLAUDE — queue for the next session (no davy input needed)

| # | Task | Notes |
|---|---|---|
| C1 | Compute release-keystore SHA-256 (`websites/avatok/secrets/avatok-chat-release.keystore`, passwords in adjacent .txt) → set `ASSETLINKS_SHA256` on the Pages project → verify `https://avatok.ai/.well-known/assetlinks.json` | Unblocks App Links |
| C2 | Verify CI APK built green for `4b903af`; if red, fix build errors | gate for ALL device QA |
| C3 | Staging smoke suite: `/api/config` flags, create staging test account, `POST /api/wallet/topup` with Stripe test card via PaymentSheet flow (or curl PaymentIntent), confirm webhook → ledger row → balance | proves the whole money pipe |
| C4 | Run `worker/scripts/ledger_invariants.mjs` against staging (needs admin Clerk JWT — generate via Clerk API with CLERK_SECRET_KEY from credentials.local.md) | P2 acceptance |
| C5 | Verify Stripe Identity TEST session end-to-end on staging (create session via API, simulate verified webhook, check `verification_status` flips) | P3 acceptance without dashboard |
| C6 | Seed staging demo data: 2 creators, 4 listings (2 live events, 2 consults), bookings — so device QA has something to click | speeds up QA day |
| C7 | gcal: attempt OAuth round-trip on staging once davy adds redirect URI (D1); verify outbound export + inbound import | P5 acceptance |
| C8 | Confirm reminder cron fired on a seeded T-60 booking (staging, test clock) + join-link fallback page renders | P5 acceptance |
| C9 | PostHog: verify analytics envelope events arriving from staging worker (`track`/`metric`) + audience funnel query returns with the personal key | P8 acceptance |
| C10 | Check Vectorize `uid`/`kind` metadata indexes exist on staging twin too (P9 tenant-isolation fix was prod) | security parity |
| C11 | After davy's LiveKit webhook (D2): start a staging conference via API, assert webhook lands + system message row | P10 partial |
| C12 | Update STATUS_REPORT.md + Graphiti after each of the above | handover hygiene |

## 🔑 DAVY — dashboard tasks (Claude has no login)

| # | Task | Unblocks |
|---|---|---|
| D1 | Google Cloud console → the OAuth client (from old Vercel app): add our gcal redirect URI (the exact URI is in `worker/src/cal/gcal.ts` — Claude will paste it in chat on request) + add yourself as test user if consent screen unverified | gcal sync |
| D2 | LiveKit Cloud dashboard → webhook `https://api.avatok.ai/api/conference/webhook` | conference msgs/push |
| D3 | Cloudflare dash → confirm Stream Live enabled; Stream webhook → `https://api.avatok.ai/webhooks/stream` | AvaLive |
| D4 | Write/approve the creator agreement text (Claude can draft; you approve) → Claude uploads to R2 | withdrawals |
| D5 | Stripe dashboard: confirm Identity is enabled for TEST mode; apply for production access | KYC prod |
| D6 | Wise Platform/KYB onboarding — DEFERRED per davy 2026-06-10; revisit before real payouts | payouts |
| D7 | Legal sign-off on real money → tell Claude to flip `WALLET_TOPUP_ENABLED=1` prod + create LIVE-mode Stripe keys/webhooks | 💰 REAL MONEY |

## 📱 DAVY — device QA (needs CI APK + 2–3 phones, ~half a day)

1. Wallet: staging top-up with test card; ledger row + receipt email.
2. Money happy path: KYC (test) → create consult listing → phone B books →
   both join room → complete → settlement in wallet + Verse + statement CSV.
3. Live: go live → phone B joins & pays → flyer/sticker/emoji → donate →
   end → settlement; watch AvaStorage graph live-update during a chat image send.
4. Refund rules: creator no-show (R1) and buyer no-show (R2) via staging test
   clock; check exact emails + ledger rows.
5. Conference: 3-phone group call; 26-member group → greyed icon + notice;
   1:1 call regression incl. zombie-call fix (kill callee app → caller ends ≤10 s).
6. Calendar: double-book attempt greyed "occupied by AvaLive"; reschedule flow;
   reminder emails T-24/T-60/T-10 with working join links.
7. Perf: open 5 apps → home → `adb shell dumpsys meminfo` within +30 MB; APK
   size < 60 MB/ABI (CI artifact).

## 🎛 DAVY — product decisions

- Prod kill-switch states (suggest: everything ON in staging; in prod keep
  `liveEnabled/consultEnabled/donationsEnabled/conferenceEnabled` OFF until QA
  passes, then flip one at a time).
- Confirm storage pricing 20 coins/GB/mo = $0.20/GB/mo.
- Review the 10 seeded AvaExplore categories.
- Set the date for flipping prod real money (after D7 + QA).

## ⚠️ Known gaps / tech debt (next build session, post-QA)

- Inbox snippets/unread are feed-based (P8 note) — wire to InboxDO counts.
- Voice notes still use the legacy encrypted upload path → Whisper indexing
  only fully lights up after chat media moves to the server-readable path.
- Stripe webhooks are TEST-mode endpoints; re-create LIVE-mode endpoints at D7.
- LiveKit conference device acceptance not yet run (C11/QA-5).
- `npub→uid` migration applied for calendar; grep for any remaining npub
  references in newer routes during QA week.
