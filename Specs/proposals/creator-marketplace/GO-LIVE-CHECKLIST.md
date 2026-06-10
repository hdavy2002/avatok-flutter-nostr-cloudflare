# Go-Live Checklist — updated 2026-06-10

## ✅ Done by Claude (this session)
- Phases 3–10 consolidated: committed `c136abf`, branch pushed, **main fast-
  forwarded + pushed** → CI is building the APK.
- Secrets set on avatok-api + avatok-consumers: `LIVEKIT_API_KEY/SECRET`,
  `JOIN_LINK_SECRET`, `GCAL_TOKEN_KEY` (generated, saved in
  `secrets/secret-values.env`).
- Deployed avatok-api + avatok-consumers, **prod AND staging** (ships the
  pending P3/P5/P7/P10 code). Smoke-verified: `/api/time` 200, guest
  `/api/explore` 200.
- **2026-06-10 key audit:** searched all 213 past session transcripts + repo +
  wrangler. Already-provided keys now ALL set: LiveKit, **RealtimeKit
  (RTK_ORG_ID/RTK_API_KEY → consult SFU unblocked)**, TURN, Brevo, PostHog
  project key, Clerk, Bunny, FCM. Confirmed NEVER provided (no record
  anywhere): Stripe keys, Stripe Identity webhook secret, Google OAuth
  client, OpenAI key, PostHog PERSONAL key — items 1–5 below stand.

## 🔑 DAVY — accounts & keys (Claude can't create these)
| # | Action | Unblocks |
|---|---|---|
| 1 | Stripe TEST keys → `wrangler secret put STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` `--env staging`; set `WALLET_TOPUP_ENABLED=1` staging | P2 acceptance: test top-up |
| 2 | Stripe Identity: enable in dashboard, get `STRIPE_IDENTITY_WEBHOOK_SECRET` (point webhook at `https://api.avatok.ai/webhooks/stripe-identity`), apply for production access (lead time) | KYC → creator publishing |
| 3 | Google Cloud Console: OAuth client (Calendar API) → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on both workers | gcal sync |
| 4 | `OPENAI_API_KEY` → secret on avatok-consumers | Whisper voicemail search |
| 5 | PostHog **personal** API key → `POSTHOG_PERSONAL_API_KEY` on avatok-api (project key ≠ personal key) | AvaVerse audience funnel |
| 6 | LiveKit Cloud dashboard: point webhook at `https://api.avatok.ai/api/conference/webhook` | conference system messages/push |
| 7 | Cloudflare Stream/Realtime: confirm Stream Live enabled on the account; webhook → `/webhooks/stream` | AvaLive go-live |
| 8 | Wise Platform/KYB onboarding (longest lead time — start now) | real payouts |
| 9 | Release-keystore SHA-256 → `ASSETLINKS_SHA256` on the Pages project | App Links (join links open the app) |
| 10 | Upload creator agreement markdown to R2 `agreements/creator-agreement/v1.md` | first withdrawal flow |
| 11 | Legal sign-off → flip `WALLET_TOPUP_ENABLED=1` in prod | REAL MONEY ON |

## 📱 DAVY — device QA (needs the CI APK + 2-3 phones)
1. P2: staging top-up; run `ADMIN_TOKEN=<jwt> BASE=https://api-staging.avatok.ai node worker/scripts/ledger_invariants.mjs`.
2. Happy path: verify (KYC sandbox) → create listing → second account books →
   join consult → complete → check settlement in wallet + Verse + statement.
3. Live: go live, second phone joins, send flyer/sticker, donate, end →
   settlement; check AvaStorage live graph while sending a chat image.
4. P10: 3-phone group conference; 26-member group shows greyed icon + notice;
   1:1 call regression (incl. zombie-call fix: kill callee app → caller ends ≤10 s).
5. Perf budget: open 5 apps → home → `adb shell dumpsys meminfo` within +30 MB.

## 🎛 DAVY — product decisions
- Prod kill-switch states in `platform_config` (suggest: staging all ON; prod
  `liveEnabled/consultEnabled/donationsEnabled` OFF until QA passes, flip one
  at a time).
- Storage pricing: confirm 20 coins/GB/mo = $0.20/GB/mo is intended.
- Categories: review the 10 seeded AvaExplore categories.

## Known small gaps (next build session)
- Inbox snippets/unread are feed-based (P8 note).
- Whisper indexing fully lights up when chat media moves off the legacy
  encrypted upload path (P9 note).
- `cal/engine.ts` pre-existing tsc error mentioned by P3 — verify it was
  resolved by P5's rewrite (CI will tell).
