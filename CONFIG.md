# AvaTalk — Non-secret configuration

Public identifiers and endpoints. **Secrets** (Clerk secret key, Bunny API key,
RealtimeKit org key) live only in Cloudflare Worker secrets / the gitignored
`secrets/` folder — never here.

## Cloudflare
- Account ID: `fd3dbf43f8e6d8bf65bd36b02eb0abb0` (hdavy2005@gmail.com)
- Signaling Worker (temp, calls): `https://avatok-call-signaling.getmystuffme.workers.dev`
- **Nostr relay (NIP-01):** `wss://avatok-relay.getmystuffme.workers.dev` → maps to `relay.avatok.ai` later
- **"Cloudflare Realtime" = three separate products:** **(1) Realtime TURN** (per-GB relay for 1:1/mesh
  calls), **(2) Realtime SFU / "Calls"** (per-GB media hub for paid AvaConsult/AvaVision group sessions),
  **(3) RealtimeKit** (ready-made SDK — *legacy/unwired*). None of these carry chat presence.
- **ICE (STUN+TURN) for 1:1 & free mesh (≤5):** `https://avatok-call-signaling.getmystuffme.workers.dev/ice`
  (Cloudflare **Realtime TURN**, key `add95c6c…`, token in Worker secrets). TURN keys in account:
  `avatok-turn-prod`, `avaflutter` (`add95c6c…`), `empty-hall-65c1`.
- **Group sessions (AvaConsult / AvaVision, paid) — Realtime SFU / "Calls":** proxied by avatok-api
  `routes/consult.ts` → `rtc.live.cloudflare.com/v1/apps/{CALLS_APP_ID}`. Live Calls app: `shiny-thunder-2e45`
  (`5bda30a75bbaf90578422dbb429e8cbd`). Gated by `CALLS_APP_ID`/`CALLS_APP_SECRET` (503 if unset).
- **Group calls (AvaTalk, ≤25, paid) — LiveKit, *not* Cloudflare:** avatok-api `routes/conference.ts`
  (secrets `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`).
- **RealtimeKit (legacy/unwired):** old `avatok-calls` worker `…/join` + standalone `avaconsult/` app.
  App `avatok-flutter`: `7e5b20c0-da74-4848-9884-73af53bb3fb0` (presets `group_call_host/participant/guest`,
  `livestream_host/viewer`; auth via Worker secret `CF_API_TOKEN`). **Superseded — kept as dead code only.**

## Clerk (existing avatok.ai tenant)
- Publishable key (public): `pk_live_Y2xlcmsuc2FhdGh1bS5jb20k`

## Firebase / FCM
- Project: `avatok-e19ef` · Android package: `com.saathum.app` — ⚠️ **not yet registered.**
  `firebase/google-services.json` still only registers the OLD `ai.avatok.avatok_call`
  package. A new Firebase Android app for `com.saathum.app` (and `.staging`) must be
  added to a Firebase project and a fresh `google-services.json` dropped in before FCM
  will work. See `REPORT.md`.

## Bunny.net Stream
- Library ID: `553793` · CDN: `vz-837d504e-6a8.b-cdn.net` · Pull zone: `vz-837d504e-6a8`

## Email
- Primary: Cloudflare Email Service via the `EMAIL` send_email binding in avatok-consumers
  (REST API from the web Pages functions). Fallback: Brevo (`BREVO_API_KEY`). Switch: consumer
  var `EMAIL_PROVIDER` (`brevo` | `cloudflare` | `cloudflare_then_brevo`).
- Sending domain `avatok.ai` onboarded to Email Sending 2026-09-06. Zone: `ae74ddf95ebf8c401d254ae3d308d4b5`.
- Delivery events: Queue `email-events` (`675d68f675a44a5195eedd98c2c5e6d9`, event subscription
  `3ca78989f397496ab3a12f460f61d14b`) → `email_outbox.delivered_at`/`bounced_at` + `email_suppressions`.
  Only one event subscription is allowed per sending domain, so `email-events-staging` gets no
  delivery events.

## App
- Android applicationId: `com.saathum.app` (changed from `ai.avatok.avatok_call` — new,
  separate Play Store listing; see `REPORT.md`)
- Direct test APK: GitHub release `calltest-latest`

## Razorpay — ⚠️ PRODUCTION IS RUNNING IN **TEST MODE** (2026-09-13)

**`razorpayEnabled=true` in prod KV, with `rzp_test_…` keys.** Production buyers are
offered a Razorpay button that ONLY accepts Razorpay's test cards — a real card will be
declined. This is deliberate, for testing; it must be switched to live keys or switched
off before any real buyer is pointed at it.

- Key id (public, test): `rzp_test_TbM0H5hnewQZR5`. Key secret and
  `RAZORPAY_WEBHOOK_SECRET` are Worker secrets on `avatok-api` and are mirrored in the
  gitignored `secrets/secret-values.env` — never here.
- Webhook endpoint the dashboard must point at:
  `https://api.avatok.ai/api/pay/razorpay/webhook`
  (events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`).
- Test cards (read off Razorpay Docs 2026-09-14, "Test Cards Details to Test Payments
  and Subscriptions", India): Visa `4100 2800 0000 1007`, Mastercard
  `5555 5100 0008 1006`, RuPay `6527 6589 0000 1005`. **Any random CVV and any future
  expiry.** Test mode then shows a MOCK BANK PAGE with **Success** and **Failure**
  buttons — that is how you test a declined payment.
  Test UPI success `success@razorpay`, failure `failure@razorpay`.
  ⚠️ This line used to read `4111 1111 1111 1111` with OTP `1111`. **Neither appears in
  Razorpay's current documentation** — there is no OTP field in test mode any more. Do
  not restore them from an older note; re-read the docs. The same details are printed to
  buyers by `web/src/islands/checkout/BetaTestNotice.tsx`, so the two must not drift.
- Switch the rail off again with:
  `ALLOW_PROD=1 scripts/flags.sh set razorpayEnabled=false`
- Going live later is only: new keys into `wrangler secret put RAZORPAY_KEY_ID/…SECRET`,
  a new webhook + secret in live mode, and nothing in the code changes.

See `Specs/REPORT-2026-09-13-RAZORPAY-WIRE-UP.md`.

## Remote config flags — AI voice agent listings (`[AGENT-LIVE-1]`, 2026-09-12)

Declared in `PlatformConfig` + `DEFAULTS` in `worker/src/routes/config.ts` per
`Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md` §2 — not secrets, flip with
`scripts/flags.sh set <key>=<value>` per the CLAUDE.md flags rules (never
re-materialize the whole blob; obey `.avatok-target`).

| Flag | Type | Default |
|---|---|---|
| `agentListingsEnabled` | bool | `false` |
| `agentCheckoutEnabled` | bool | `false` |
| `agentTalkEnabled` | bool | `false` |
| `agentEmergencyStop` | bool | `false` |
| `agentImageReadingEnabled` | bool | `true` |
| `agentMemoryEnabled` | bool | `true` |
| `agentLiveModel` | string | `gpt-live-1` |
| `agentBackendModel` | string | `gpt-6-astra` |
| `agentSlotMinutes` | string | `5,10,20,30,40,60` |
| `agentPlatformMaxConcurrent` | number | `20` |
| `agentMinPricePerMin` | number | `10` |

Server-only env (not a flag, `worker/src/types.ts` `Env`): `OPENAI_API_KEY?`,
`AGENT_ADMIN_UIDS?` (wrangler var — exactly one uid, resolved from
`hdavy2002@gmail.com`; never an email allowlist in remote config),
`JOIN_LINK_SECRET`, DO bindings `AGENT_SEAT_AUTHORITY` / `AGENT_LIVE_ROOMS`,
R2 binding `DIGITAL` (existing, private bucket).
