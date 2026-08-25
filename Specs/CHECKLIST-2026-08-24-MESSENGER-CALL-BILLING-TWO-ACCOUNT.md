# Messenger Call Billing — Two-Account Staging Checklist

**Scope:** Phase 1 Messenger 1:1 audio/video billing only

**Environment:** Staging only. No production activation is permitted by this checklist.

**Participants:** Two physical devices, two distinct AvaTOK accounts. The caller is the payer; the callee must never be charged.

## Before testing

- [ ] Worker and app build contain the same Phase 1 contract version.
- [ ] `messengerCallBillingEnabled` remains false in production.
- [ ] Staging has non-zero test prices for paid audio, SD, HD, 2K and 4K where provider caps are proven.
- [ ] The five prices and `messengerCallPriceVersion` are recorded with the test run.
- [ ] Both devices use separate accounts and have known wallet balances.
- [ ] PostHog/event query access is available for both accounts.

## Audio allowance

- [ ] A fresh UTC day starts with exactly 28,800 free participant-seconds for the caller.
- [ ] A 60-second connected 1:1 audio call consumes exactly 120 participant-seconds.
- [ ] Ringing, permission prompts, setup and unanswered calls consume zero allowance.
- [ ] Multiple calls share the caller's daily allowance.
- [ ] The allowance resets at 00:00:00 UTC and does not roll over.
- [ ] The callee's allowance and wallet remain unchanged.

## Paid audio

- [ ] At least one free second remains before the boundary; the final connected tick applies only the remaining free seconds.
- [ ] Once free allowance is exhausted, the Cloudflare call ends and the caller sees paid GetStream-audio confirmation before any paid provider work.
- [ ] Accepting continuation creates a fresh attempt ID, authorization ID, server call ID and GetStream session; the Cloudflare session is never reused or silently migrated.
- [ ] Cancelling paid confirmation does not ring/create a paid call and does not debit/reserve tokens.
- [ ] Accepting paid audio records a short-lived consent challenge bound to GetStream, the exact rate and price version.
- [ ] Cloudflare audio always has rate zero, no paid reservation and no wallet-token debit.
- [ ] Initial runway reservation succeeds before paid ringing.
- [ ] Low-balance warning appears before the configured runway is exhausted.
- [ ] Reservation renewal is idempotent.
- [ ] Insufficient balance ends paid media cleanly and releases unused reservation.

## Video quality and charging

- [ ] Video always shows the quality/rate consent sheet before provider work.
- [ ] SD, HD, 2K and 4K each show their remote-configured rate.
- [ ] Video is charged from the first genuinely connected participant-second.
- [ ] Requested quality and actual observed quality are recorded separately.
- [ ] Downshift is non-billable as setup/reconnect time and does not overstate delivered quality.
- [ ] A quality upgrade requires fresh consent and server authorization.
- [ ] Unsupported or zero-priced SKUs are unavailable, never silently free.
- [ ] 2K/4K remain disabled until physical-device provider-cap evidence exists.

## Reconnect, termination and replay

- [ ] Disconnecting either participant closes the current billable interval.
- [ ] Reconnect gaps are not billed.
- [ ] Rejoining opens a new generation/interval only after both participants are genuinely connected again.
- [ ] Caller hang-up, callee hang-up, provider-ended, app-killed and reaper paths all finalize once.
- [ ] Replayed/out-of-order provider webhooks do not duplicate ticks, debits or receipts.
- [ ] Every usage tick is present once in the usage ledger.
- [ ] Final receipt totals equal ledger totals exactly.
- [ ] A fully free audio call still produces a zero-cost call receipt.

## Evidence to retain

- [ ] Two account IDs, device models and app builds.
- [ ] Call ID, authorization ID, consent ID, reservation reference and price version.
- [ ] Provider connected/disconnected timestamps.
- [ ] Usage-ledger rows and final receipt.
- [ ] Caller wallet before/after; callee wallet before/after.
- [ ] Screenshots/video of consent, warning, connection and receipt UI.
- [ ] PostHog trace for authorization, consent, connection, quality, usage and settlement.
- [ ] Confirmation that no provider token, secret or raw wallet object entered telemetry.

## Release decision

- [ ] Every item above passes on both accounts.
- [ ] No unexplained wallet difference remains.
- [ ] No paid charge exists without matching consent and authorization.
- [ ] No charge exists for ringing, setup or reconnect gaps.
- [ ] Root reviewer signs off before any production migration, deployment or flag change.
