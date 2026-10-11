# Native app redesign — HF-NATIVE-REDESIGN-1

Approved 2026-10-11. Implementation is confined to `hf-flutter/` and the minimal server access/KYC corrections required by its journeys. The website is not the visual template.

## Visual system

Off-white pages (#F7F8FC), white cards, soft visible shadows, 28 dp card corners and pill controls. Nunito headings and Comfortaa body text are bundled. Mint, sky, lavender, yellow, pink and coral/red accents sit alongside dark ink. Decorative scenes are native vector paintings with optional ambient motion and reduced-motion support. Body text is 14 sp or larger; only the discreet AI avatar caption is smaller.

## Pages and pipelines

| Journey | Pages and important states |
| --- | --- |
| Open app | Animated splash; restore session and queued links; resume active call; otherwise Browse |
| Browse | Marketplace home, search within loaded hosts, filters, languages, price, online status, mood cards, loading/error/empty/load more |
| Public host | Portrait/gallery, small AI avatar label, languages/topics/style, availability, server price, reviews/regulars, host-recorded voice introduction, Call or Notify |
| Register/login | Contextual WhatsApp login, OTP/resend/error, account consent for the current version, name for newly created accounts, cancel back to browsing, safe return to the intended action |
| Call | Fresh server estimate and wallet balance, explicit confirmation, top-up or space verification detour, calling/live/ended/error, summary, review |
| Wallet | Balance, Google Play packs and GST copy, confirmation, pending/cancelled/failed/verified purchase, recovery, history, receipts, refund/debt states, explicit return to call |
| Profile/settings | Account name, phone, spaces and leaving, host upgrade/dashboard, notifications, help/legal/safety, sign-out, version, update prompts |
| Account exit | Server-selected deletion or settlement, active-call/payout/refund/forfeit states, pending deletion and cancellation |
| Women-only space | Public explanation before registration; current Aadhaar eligibility policy; verification, join, ineligible and continuation states |
| LGBTQ+ space | Public explanation; private declaration separate from identity; Aadhaar, ten-second video, pending/approved/rejected/re-record, explicit continuation |
| Host upgrade | Welcome, phone, Aadhaar, selfie, payout identity, avatar, about, languages/style, topics, price, hours/comfort, recorded voice, agreements/review, generation, preview, submitted |
| Host dashboard | Draft/pending/rejected/live/paused, presence heartbeat, daily totals, paid/test calls, available/held earnings, withdrawal request/cancel/history |
| Shared states | Permission explainers, push opt-in/banner, loading/error/empty, reviews, crisis/help strip, soft/forced update |

Browse and ordinary public profiles remain available to guests. Wallet, Me and calling require registration. A host upgrade is separate. Registration, top-up and KYC never automatically start a call or payment. Only an explicit confirmation does.

## Account and access corrections

Consent, incomplete registration and pending actions are account-scoped. Safe continuations have an allowlist and expiration and clear on cancellation/sign-out/manual tab changes. A consent POST or name save cannot retry with a different account's credentials.

Only explicitly public profile payloads enter the public offline cache. Protected-space profiles use authenticated, uncached requests. Latest video review (created time, then ID) is authoritative across listing, profile, call and KYC routes. Pending or rejected video cannot unlock LGBTQ+ access. Reusable verified Aadhaar and approved video do not force a second verification.

## Review and release status

Source inspection and whitespace checks completed. Brand literals introduce no new violations; generated brand mirrors match; the feature-flag contract passes. The whole-repository release manifest check is blocked by pre-existing missing entries and malformed comparisons in earlier issues; this issue has its own success entry. No baseline was expanded.

Regression coverage was added for continuation sanitization, account-scoped registration/consent, private-profile caching, latest video access, direct-call gating and KYC reuse. Real-font layout review cases cover 320×640 and 412×915 with normal and 2× text, plus reduced-motion scenes.

The owner explicitly authorized CI checks. Flutter analysis, the full test suite and real-font layout captures passed for source commit `53f20192`: https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/38099866914. Captures use test data and placeholder host portraits; they are rendered Flutter screens, not generated mockups.

Worker type-checking and all 43 targeted protected-space/KYC tests passed in https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/38098970032. That broader workflow remains red on pre-existing AvaWallet contract failures, a missing website listing-defaults file and earlier release-manifest gaps. Those unrelated guards were not weakened.

CI exposed and corrected wrapped presence labels, a visible ringing-call Cancel action, notification prompting before Navigator mounting, lazy-viewport test navigation, and screenshot test I/O. Review captures now load bundled text/icon fonts and use current pack prices.

No release build, production deployment, flag change or database write occurred. Actual phone testing of PSTN calls, Google Play purchase/refund recovery, DigiLocker and video capture remains required before release. Backend access corrections must be deployed together with the native rollout (server first); the new client fails closed against older protected-space responses.
