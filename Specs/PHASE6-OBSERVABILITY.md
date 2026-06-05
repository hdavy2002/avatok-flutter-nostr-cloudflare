# Phase 6 — Platform wiring (events, brain hooks, dashboards)

_v5.2 §21 / §26 Phase 6. The platform apps (AvaID, AvaWallet, AvaCalendar,
AvaPayout, AvaOLX) are now observable + brain-aware. This document is the
authoritative catalog._

## Three-system split (§21, unchanged)

- **PostHog** — product/user/agent events + errors. Batched via `Q_ANALYTICS` →
  `avatok-consumers` `/batch`. No-ops until `POSTHOG_API_KEY` is set.
- **Analytics Engine** (`avatok_metrics`) — ops metrics (`writeDataPoint`).
- **Workers Logs** — raw/debug, 7-day.

Every PostHog event carries the **5 required fields** (§27.11): `trace_id`,
`user_id` (npub = `distinct_id`), `app_name`, `app_version`, `service_name`.
These are injected centrally by `worker/src/hooks.ts → track()`, so any route that
calls `track()` is automatically compliant. Lifecycle events emitted from
`avatok-consumers` (e.g. `account_deleted`) set the same fields inline.

## Event count: 29 → ~52 (target ~55)

The 29 previously-wired events (Auth, Messaging, Calls, Uploads, Brain, Push,
Journey) are unchanged. Phase 6 adds the platform events below.

### Wallet (`avawallet`)
`wallet_topup_initiated`, `wallet_topup_completed`, `wallet_spend`

### Identity (`avaid`)
`id_session_started`, `id_verified`, `id_verification_failed`

### Calendar (`avacalendar`)
`calendar_slot_created`, `calendar_booked`, `calendar_cancelled`

### Payout (`avapayout`)
`payout_account_linked`, `payout_requested` (+ `payout_completed`/`payout_failed`
surfaced via brain hooks + Analytics Engine on the Wise webhook)

### OLX (`avaolx`)
`olx_listing_created`, `olx_purchase`, `olx_download`, `olx_refund`

### Lifecycle (`platform`)
`account_deletion_requested`, `account_deletion_cancelled`,
`account_deleted` (emitted by the cascade consumer when all stores are wiped)

> Agent events (8) + remaining OLX/marketplace events land in Phases 7-8, reaching
> the ~55 target. Errors(1) is the existing error-capture path.

## Brain hooks (§7 — "brain learns from platform apps")

`worker/src/hooks.ts → brainFact()` feeds derived facts to `Q_BRAIN` (public/
platform scope; never DM plaintext). Wired:

| App | Fact event_type | When |
|---|---|---|
| AvaID | `identity_verified` | Rekognition ≥90% pass |
| AvaWallet | `wallet_topup` | Stripe webhook credit |
| AvaWallet | `wallet_spent` / `wallet_earned` | spend (both sides) |
| AvaCalendar | `calendar_booked` / `calendar_hosted` | booking confirmed |
| AvaPayout | `payout_requested` / `payout_completed` | request / Wise webhook |
| AvaOLX | `olx_listed` / `olx_purchased` | listing created / bought |

The brain consumer (`avatok-consumers/src/brain.ts`) extracts entities/facts from
these into `DB_BRAIN`, so a user's AvaBrain can answer "how much did I earn last
week?", "what did I buy?", "when am I verified-since?", etc.

## Dashboards (8–13)

Built in PostHog once events flow (define as insights on the catalog above). The
13-dashboard set (§21); Phase 6 owns 8–11, with 12–13 stubbed for Phases 7-8.

8. **Wallet** — top-ups (count/coins), spend by app, commission collected,
   held vs released coins, balance distribution. Source: `wallet_*`.
9. **Payout** — requests, funded vs failed vs refunded, payout latency
   (requested→completed), total withdrawn. Source: `payout_*` + Wise webhook.
10. **Verification** — sessions started, pass rate, avg confidence, attempts-to-
    pass, 3/24h rate-limit hits. Source: `id_*`.
11. **Calendar** — slots created, booking rate, paid vs free, cancellations,
    reminder delivery. Source: `calendar_*`.
12. **Agent** _(Phase 7-8)_ — conversations/app/day, match rate, llama-guard
    blocks, neuron-budget trips, inbox actions, TTS listens.
13. **OLX** — listings by kind, purchase conversion, refund rate, GMV (digital),
    commission. Source: `olx_*`.

Operational counterparts (System Health, queue depth, AI cost/latency) read from
the `avatok_metrics` Analytics Engine dataset via `metric()`.

## Verification

- Every platform mutation route calls `track()` (5-field compliant) — confirmed by
  source audit (17 platform `track()` events + 10 `brainFact()` types).
- `Q_ANALYTICS` is a no-op sink until `POSTHOG_API_KEY` is set on
  `avatok-consumers`; events still enqueue safely (batched, acked).
- `account_deleted` lifecycle event emitted from the cascade (consumers is now a
  producer of `analytics`).

**Remaining to light up live:** set `POSTHOG_API_KEY` (+ `POSTHOG_HOST`) on
`avatok-consumers`; build the 13 insights/dashboards in the PostHog UI from this
catalog. No code blocks this — events are already flowing into the queue.
