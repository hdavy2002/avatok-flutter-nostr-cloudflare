# Human call participant-minute pool — 2026-08-19

This is a deliberate, staged override to the earlier “ordinary human calls are
free” launch policy. It is disabled by default and does not change messaging,
Cloudflare call signalling, receptionist calls, Vobiz/PSTN calls, or the retired
paid-call escrow paths.

## Decision

- Each account receives 200 combined audio/video participant-minutes per UTC
  calendar month.
- After the pool is exhausted, audio costs 0.05 token/minute and video costs
  0.10 token/minute.
- A group call consumes minutes independently for each connected participant;
  ten people connected for one minute consume ten participant-minutes.
- The new `humanCallParticipantBillingEnabled` flag is false by default. Flip it
  only in staging while the matching client/server pilot is being tested.
- WalletDO is the authority. It records monthly participant seconds and a
  persistent prepaid fractional-credit bucket. One wallet token funds 100
  centitokens; sub-minute ticks retain extra precision internally.
- If an account cannot fund the next whole token at an overage boundary, only
  that participant is sent `billing_exhausted` and disconnected in a group. The
  other participants stay in the call.

## Deliberate compatibility choices

The existing `paidCalls`, `conferenceBillingEnabled`, and legacy call escrow
state remain unchanged and continue to be forced free/retired. The new flag is
independent so a stale override cannot accidentally turn old billing back on.
No new public wallet or client API shape is required; call rooms use an internal
WalletDO operation with idempotent operation IDs.

## Risks to validate in staging

1. This is prepaid whole-token funding: the first overage tick may reserve one
   wallet token even though only a fraction is consumed; the unused credit stays
   in the account bucket for later calls.
2. Existing clients that do not present authenticated 1:1 room-side tags cannot
   be safely attributed to caller/callee accounts and are not metered by the
   1:1 room until the authenticated room path is enabled.
3. `audio_video` group calls use the video rate for the participant because the
   room authority knows the call media mode, not per-frame camera state.
4. Config-read failure fails open for billing, preserving the dark rollout but
   creating a possible short platform-loss window. WalletDO remains the only
   debit authority and every successful/blocked tick emits telemetry.
5. Funding uses WalletDO `spendable` (free + welcome bonus + paid balance),
   matching internal feature-cost semantics. Change to paid-only if the owner
   wants overage to consume real top-ups exclusively.
