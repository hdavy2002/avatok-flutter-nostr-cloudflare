# Free Launch — Stage 1 readiness checklist (2026-06-28)

Tracks `Specs/FREE-LAUNCH-DIRECTION.md` §5. ✅ = done this session, ⏳ = built
but needs CI/device verification, 🔜 = handed to the CF-SFU build session.

## Done this session

- ✅ **Flags flipped LIVE in KV** `platform_config` (account `fd3dbf…`, prod KV
  `ab462ef0…`) AND in `worker/src/routes/config.ts` DEFAULTS:
  - ON: `conferenceEnabled`, `numberFeatureEnabled`, `ringbackEnabled`,
    `guardianEnabled`, `aiEnabled`, `companionEnabled`, `receptionistEnabled`.
  - OFF/hidden: `billingEnabled`(false), `betaFreePremium`(true),
    `liveEnabled`, `consultEnabled`, `avavoiceEnabled`, `avavisionEnabled`,
    `translationEnabled`, `translationGroupEnabled`, `avaAffiliateEnabled`,
    `affiliateAssetKitEnabled`, `webSearchEnabled`, `fileAnalysisEnabled`,
    `generativeEnabled`, `brainEnabled`, `verseEnabled`, `teamIvrEnabled`.
  - Live KV takes effect within the 60 s edge cache; clients pick it up on their
    next 15-min `RemoteConfig` poll. (Worker DEFAULTS only matter after a
    redeploy / on KV miss — both now match the launch posture.)
- ✅ **Client flag mirror** `app/lib/core/remote_config.dart`: hidden-feature
  defaults flipped to FALSE (focused product even on a config-fetch failure);
  added `betaFreePremium`, `billingEnabled`, `receptionistEnabled`,
  `verseEnabled`, `groupAudioSfuEnabled` getters.
- ✅ **No paywalls / hidden UI** (client):
  - Subscribe CTA + plan-chip upgrade hidden while `billingEnabled` is false
    (`ava_sidebar.dart`); chip shows a plain "FREE PLAN" pill.
  - Wallet "Top up" replaced by a "Everything is free right now" note while
    billing is off (`wallet_screen.dart`).
  - Shell router (`ava_shell.dart`) defensively sends any hidden feature
    (avalive/consult/avavoice/avavision/affiliate/verse/subscribe) to ComingSoon.
  - Marketplace/agent-builder/consult/translate/affiliate/verse apps were
    already `AppTier.hidden` in `app_registry.dart` → absent from the sidebar.
- ✅ **1:1 + dialpad Opus tuning** (`call_screen.dart`, shared by the AvaPhone
  dialpad): explicit `getUserMedia` AEC + noise-suppression + auto-gain
  constraints (W3C + legacy goog keys), and `_tuneOpusSdp()` adds
  `useinbandfec=1;usedtx=1;maxaveragebitrate=40000;stereo=0` to the Opus
  `a=fmtp` on every local offer/answer (initial, ICE-restart, relay-fallback,
  reconnect, video-upgrade). 1:1 video stays P2P, unchanged.
- ✅ **Receptionist ON** in KV (`receptionistEnabled:true`, already live) — Gemini
  Live AI receptionist available for the free launch.
- ✅ **CF-SFU scaffolding**: dormant `groupAudioSfuEnabled` flag (server + client)
  + full build spec `Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md`.

## Handed to the CF-SFU build session (🔜)

- 🔜 Build CF Realtime SFU group-audio path (worker `groupcall.ts` +
  `GroupCallRoom` DO + Flutter client + active-speaker pull), drop `conf_min`
  cap for free, telemetry `provider="cloudflare_sfu"`, ops backstops. Until then
  group calls keep working on the **existing LiveKit path** (free ≤5 / 60 min/day),
  so the app is launchable now; the 32-party/unlimited CF-SFU upgrade is a
  fast-follow. Flip `groupAudioSfuEnabled` on only after CI + 2-device tests.

## Telemetry

- PostHog conference dashboard **779066** stays valid (transport-agnostic). The
  new group path will stamp `provider:"cloudflare_sfu"`; dormant LiveKit events
  remain `livekit_cloud`/`livekit_selfhost`. Per CLAUDE.md, all new events carry
  the user email (+ phone if available) via `trackUser`.

## Stage-1 regression pass (run after the CI build of these changes)

1. 1:1 audio: connects, clear two-way audio; AEC/NS/AGC on; opus `a=fmtp` shows
   FEC+DTX+40 kbps.
2. 1:1 video: works (P2P, unchanged).
3. Group audio: works via LiveKit fallback (≤5) until CF-SFU ships.
4. AvaTOK number + dialpad + receptionist pickup: all work.
5. Basic free Ava chat: works (capped free key); no web-search/file/image-gen UI.
6. No paywalls anywhere: no Subscribe, no upgrade chip, no wallet top-up,
   premium pill reads BETA-FREE.
7. Sidebar shows only the focused set (AvaTOK, AvaChat, Library, Storage,
   Connectors, Wallet); no marketplace/AvaVoice/Vision/Consult/Translate/
   Affiliate/Verse entries.

## Notes / reversibility

Everything is one KV flip from reverting — set the flags back in
`platform_config` (no redeploy). The client default flips and UI guards also
revert automatically when the matching flag returns to true.
