# AvaChat × 0xchat — Phase Log

Companion to `AVACHAT-0XCHAT-INTEGRATION-PROPOSAL.md`. Tracks what was delivered
per phase and what CI/dev must verify. Branch: `feat/avachat-0xchat-graft`.
`main` / `app/` / Workers untouched.

## Environment constraint (read first)
The authoring environment has **no Flutter toolchain** (this project builds in
GitHub Actions). All adapter code below targets **source-verified 0xchat APIs**
but is **not compiled here** — `.github/workflows/avachat-build.yml` is the
compile/verify gate. Code is intentionally pushed for CI verification per the
agreed "write all code, push once" approach.

## Backup / recovery
- Git tag + branch: `backup/pre-0xchat-graft-20260608-103044` (at HEAD `16589c8`).
- Full-tree tarball: `outputs/backups/avatok-backup-20260608-103044.tar.gz`
  (3,133 files, includes `.git`). Recover: `git checkout backup/...` or untar.

## Phase 0 — vendor + CI ✅ (delivered)
- Branch `feat/avachat-0xchat-graft`.
- `.gitmodules` pins 0xchat-app-main `0a674a3` (MIT), 0xchat-core `76675e7`
  (LGPL), nostr-dart `41fe8f7` (LGPL) under `external/`. Materialized by CI
  (mount restrictions blocked in-repo cloning here).
- Relay repoint: `AvaChatBootstrap` overrides `Relays.sharedInstance.recommend*`
  → `wss://avatok-relay.getmystuffme.workers.dev/`. No submodule edits.
- `avachat-build.yml` CI: submodules → inject bootstrap → pub get → build APK.

## Phase 1 — identity + transport ✅ code / ⛏ build-bind
- `avachat_identity`: Clerk → per-account-scoped nsec (`scopedKey` contract),
  auto-provision on first login, `Account.loginWithPriKey`. Scoping enforced
  (throws without a bound scope). Clerk-link POST = TODO(build).
- `avachat_transport`: NIP-42 already handled by 0xchat `Connect`; NIP-98 + Clerk
  JWT header builder present, signer binding = TODO(build).

## Phase 2 — UI graft config ✅ code
- `avachat_feature_gate`: private NIP-17 groups ON; NIP-29 relay groups, NIP-28
  channels, Cashu, zaps OFF. Call buttons hidden on group threads.
- Full 0xchat UI used as-is via submodule; scope enforced by gate, not by forking.

## Phase 3 — calls → CallRoom + TURN ✅ code / ⛏ build-bind
- Alignment confirmed: 0xchat NIP-100 signaling is **kind 25050**, already gated
  + push-enqueued by our relay → signaling flows unchanged.
- `avachat_calls`: Cloudflare TURN ICE config (mint at `/api/ice` = TODO(build)),
  `assertOneToOne()` + `callButtonAllowed()` enforce the 1:1 rule client-side;
  server CallRoom DO independently caps at 2 peers.

## Phase 4 — AvaWallet + AvaBrain ✅ code / ⛏ build-bind
- `avachat_wallet`: AvaCoins balance/transfer seam; Cashu + zaps disabled.
- `avachat_brain`: on-device DM fact extraction → `/api/brain/remember`,
  consent-gated (default ON), raw DM never leaves device. Stream hook +
  extractor = TODO(build).

## Remaining to a running app (the `TODO(build)` set)
1. Bind `avachat_transport` to 0xchat's NIP-98 signer.
2. Mint Cloudflare TURN creds in `avachat_calls.configureIceServers()`.
3. Wire `avachat_brain.attach()` to 0xchat's decrypted-message callback.
4. Implement wallet + identity-link HTTP calls.
5. Host app injects `AvaChatSecureScope` (real per-account storage) +
   `AvaBrainConsent` (settings toggles).
6. Green CI build → device smoke test (DM round-trip, 1:1 call, wallet send).

## Phase 6 — Option C (later)
Retire `app/lib/nostr/nostr_client.dart` once the graft is stable; 0xchat-core
becomes the single Nostr engine.
