# AvaTOK Launch Flag Matrix

**Source of truth for launch flag values.** Generated Phase 0 (`[P0-CLEAN-4]`), 2026-07-02.
Covers 100% of `PlatformConfig` keys in `worker/src/routes/config.ts` (interface lines 11–100,
`DEFAULTS` lines 108–150) plus the `partyEnabled` secret injected by `getConfig` (line 167).

- **Current default** = value in `DEFAULTS` (or secret state) as of this commit.
- **Launch value** = target value at go-live per `Specs/MASTER-PROMPT-LAUNCH-READINESS-2026-07-02.md`.
- **Flip owner** = which phase flips it (or "—" if it already equals launch).
- Flags are stored in KV `platform_config` and merged over `DEFAULTS`; flip via KV, no redeploy.
- `partyEnabled` is NOT in `DEFAULTS` — it is derived from the `PARTY_ENABLED` Worker secret.

## Core `PlatformConfig` keys

| Flag | Type | Current default | Launch value | Flip owner / notes |
|---|---|---|---|---|
| `walletRealMoney` | bool | `false` | `false` | — money-in OFF pending legal (§10.1) |
| `donationsEnabled` | bool | `true` | `true` | — not in launch plan; leave |
| `liveEnabled` | bool | `false` | `false` | — marketplace/AvaLive hidden (free launch) |
| `consultEnabled` | bool | `false` | `false` | — paid consulting hidden |
| `conferenceEnabled` | bool | `true` | `true` → `false` | **P3** — LiveKit group path; set `false` once CF-SFU flip completes |
| `groupAudioSfuEnabled` | bool | `false` | `true` | **P3** — CF Realtime SFU group audio; ON after device test |
| `brainEnabled` | bool | `false` | `true` | **P7** — AvaBrain; flip ON as last commit of P7 |
| `verseEnabled` | bool | `false` | `false` | — creator dashboard hidden |
| `identityLadderEnabled` | bool | `true` | `true` | — progressive identity gating |
| `guestTierEnabled` | bool | `true` | `true` | — L0 handle-only visitors |
| `workersAiLivenessEnabled` | bool | `false` | `false` | — Rekognition stays default liveness (P4) |
| `simOnlyPhoneEnabled` | bool | `true` | `true` | — block VoIP/temp numbers |
| `translationEnabled` | bool | `false` | `false` | — Gemini-Live cost; hidden |
| `translationGroupEnabled` | bool | `false` | `false` | — hidden |
| `avavoiceEnabled` | bool | `false` | `false` | — agent builder hidden |
| `avavisionEnabled` | bool | `false` | `false` | — agent builder hidden |
| `receptionistEnabled` | bool | `true` | `true` | — AI receptionist ON (P2/P12 refine) |
| `receptionistRings` | number | `4` | `4` | — tunable; P1 raises min ring window in client |
| `receptionistUseCf` | bool | `false` | `false` | — engine = Gemini Live (default) |
| `receptTakeoverGuard` | bool | `false` | `true` (after device test) | **P1** — gate Ava takeover on FCM ring-ack; ships dark |
| `avaAffiliateEnabled` | bool | `false` | `false` | — flip after affiliate fraud checks (post-launch) |
| `affiliateAssetKitEnabled` | bool | `false` | `false` | — v2 asset kit, not built |
| `aiEnabled` | bool | `true` | `true` | — master Ava switch / panic button |
| `focusMode` | bool | `true` | `true` | — hide non-AvaTOK apps in drawer |
| `webSearchEnabled` | bool | `false` | `false` | — premium AI cost; hidden |
| `fileAnalysisEnabled` | bool | `false` | `false` | — premium unlocks |
| `openChatUncapped` | bool | `false` | `false` | — premium removes cap |
| `dailyAvaTurnLimit` | number | `25` | `25` | — free-tier Ava turns/account/day |
| `guardianEnabled` | bool | `true` | `true` | — safety shield (free) |
| `companionEnabled` | bool | `true` | `true` | — basic free Ava chat |
| `generativeEnabled` | bool | `false` | `false` | — premium image gen hidden |
| `imageDailyCap` | number | `100` | `100` | — per-user/day image fair-use backstop |
| `ringbackEnabled` | bool | `true` | `true` | — AI ringback + busy tone (free) |
| `betaFreePremium` | bool | `true` | `true` | — no paywalls; everyone premium |
| `billingEnabled` | bool | `false` | `false` | — subscriptions/checkout off |
| `numberFeatureEnabled` | bool | `true` | `true` | — AvaTOK Number |
| `teamIvrEnabled` | bool | `false` | `false` | — Team Receptionist IVR off until dogfood |
| `ivrAiFrontDesk` | bool | `false` | `false` | — tap-menu default; AI front desk future |
| `groupInvitesEnabled` | bool | `false` | `false` | — pending-membership invites off until migration+test |
| `minAppBuild` | number | `0` | `0` | — min build gate; bump when forcing upgrade |

## Secret-derived key

| Flag | Source | Current state | Launch value | Flip owner / notes |
|---|---|---|---|---|
| `partyEnabled` | Worker secret `PARTY_ENABLED === "1"` | OFF (unset) | ON | **P13** — PartyKit ephemeral realtime; `wrangler secret put PARTY_ENABLED=1` staging→prod after 24h clean `party_*` telemetry |

## Flags to be added by later phases

These do not exist in `config.ts` yet; the owning phase appends its row here when it adds the flag.

| Flag | Type | Default at add | Launch value | Owner phase |
|---|---|---|---|---|
| `listingLivenessGate` | bool | `false` | `true` | P4 — block listing creation unless liveness-verified |
| `agentDailyCap` | number | `10` | `10` | P5 — per-user daily marketplace agent-conversation cap |
| `safetyScanEnabled` | bool | `true` (ships ON) | `true` | P6 — per-message Nemotron safety scan + red bubbles |
| `chatArchiveV2` | bool | `false` | `true` | P8 Stage 1 — R2 cold archive |
| `restoreV2` | bool | `false` | `true` | P8 Stage 2 — new-phone restore |
| `driveAutoBackup` | bool | `false` | `true` | P8 Stage 3 — daily Drive backup |
| `profileCompletionGate` | bool | `false` | `true` | P11 — mandatory + AI-vetted profile |

## Notes

- **Nostr shim purge is DEFERRED** (Phase 0 step 1): `app/pubspec.yaml` = `0.1.17+27`, below the
  `≥ 0.1.18+27` one-release compat-window threshold, so shims and `pointycastle`/`bip340` deps
  are retained and only reported this phase. Re-run the purge once a build ≥ `0.1.18+27` ships.
- **Ably** is functionally removed; only a single dead `'AblyException'` suppression string
  remained in `app/lib/main.dart` (removed in `[P0-CLEAN-3]`). Remaining `Ably` grep hits are
  history comments and the `ABLY-R2` archive rollout phase names (a real feature, not Ably).
