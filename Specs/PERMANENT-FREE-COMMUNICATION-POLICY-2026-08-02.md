# Permanent Free Communication Policy

**Owner decision:** 2026-08-02  
**Status:** Permanent product rule  
**Applies to:** AvaTOK and AvaTalk

## Free for every account and subscription tier

- human-to-human chat messaging;
- 1:1 human audio calls;
- 1:1 human video calls;
- AvaTalk group audio and video conferences, up to 25 participants;
- unlimited call and conference duration, subject only to safety, abuse, and technical reliability controls.

These surfaces must never require tokens, wallet balance, escrow, a published call rate, a paid subscription, a daily minute allowance, or a smaller participant cap for free-tier users.

## Separate paid/provider-backed products

This decision does not remove pricing from services that consume third-party or AI resources: AI voice/video agents, AI receptionist, PSTN/carrier calling, live translation, paid events, marketplace services, storage overage, AI media generation, and similar explicitly priced products.

Human chat is distinct from AI-generated chat. Ordinary messages between people are free. AI features inside a conversation follow their own AI pricing and fair-use policy unless the owner explicitly makes those services free too.

## Enforcement contract

- Server configuration permanently forces `paidCalls=false`, `conferenceBillingEnabled=false`, and `conferenceVideoTokensPerHour=0`, ignoring stale KV overrides.
- Admin config cannot re-enable those legacy charging keys.
- Installed clients cannot reopen the paid-call prompt from stale cached configuration.
- Every subscription tier reports unlimited group-conference minutes and the same 25-person cap.
- Legacy paid-call and conference-billing requests cannot hold or settle funds.
- Existing legacy human-call escrow must be reconciled and refunded idempotently; no additional minute may be settled during retirement.
- Production rollout, stale-KV cleanup, reconciliation, and refunds require explicit production approval.

This policy supersedes every older paid-human-call, conference-minute, and tier-based conference-size proposal.
