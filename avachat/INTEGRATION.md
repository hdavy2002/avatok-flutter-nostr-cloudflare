# AvaChat × 0xchat — Integration guide (Option B graft)

This module repoints the **0xchat** Nostr client onto the **AvaTalk Cloudflare
backend**. It is the concrete implementation of
`Specs/proposals/AVACHAT-0XCHAT-INTEGRATION-PROPOSAL.md` (decisions locked
2026-06-08): Option B now, private groups only, full 0xchat UI incl. call room
on our CallRoom, AvaWallet only, LGPL-as-library.

## How it fits together

```
external/0xchat-app-main   (MIT)   ── full UI, incl. call room   ┐
external/0xchat-core       (LGPL)  ── protocol/business engine    ├─ unmodified
external/nostr-dart        (LGPL)  ── Nostr/NIP-42/NIP-98 crypto  ┘
            ▲
            │ depends on (path)
avachat/   (proprietary)   ── repoints relay/identity/calls/wallet/brain
            │
            └─ AvaChatBootstrap.init()  ← one line injected into 0xchat main()
```

The trick that keeps 0xchat **unpatched**: its `Relays` singleton exposes relay
lists as public mutable fields and it drives networking through `Connect` /
`Account` singletons. `AvaChatBootstrap` overwrites those at runtime, before
`runApp()`. No submodule source is edited.

## The one seam

`avachat/integration/inject_bootstrap.sh` (run by CI) adds:

```dart
import 'package:avachat/avachat.dart';
// ...
await AvaChatBootstrap.init();   // before runApp(...)
```

and an `avachat` path dependency to the 0xchat app's pubspec.

## What each adapter does (and what's wired vs TODO)

| Adapter | Role | Status |
|---|---|---|
| `avachat_config` | endpoints + locked feature flags | ✅ real values (mirrors app/lib/core/config.dart) |
| `avachat_bootstrap` | relay repoint + init order | ✅ real `Relays` field overrides |
| `avachat_identity` | Clerk→per-account-scoped nsec, `loginWithPriKey` | ✅ login wired · ⛏ Clerk-link POST = TODO(build) |
| `avachat_transport` | NIP-42 (relay) + NIP-98 (HTTP) + Clerk JWT | ⛏ bind to 0xchat NIP-98 signer at build |
| `avachat_calls` | full 0xchat call UI → CallRoom + Cloudflare TURN, 1:1 guard | ✅ kind-25050 signaling already matches our relay · ⛏ ICE mint = TODO(build) |
| `avachat_wallet` | AvaWallet/AvaCoins replaces Cashu | ⛏ wallet endpoints = TODO(build) |
| `avachat_brain` | on-device DM fact extraction → /api/brain/remember | ⛏ stream hook + extractor = TODO(build) |
| `avachat_feature_gate` | hide NIP-29/channels/cashu/zaps; 1:1 call buttons | ✅ scope flags |

`⛏ TODO(build)` = needs a Flutter compile pass to bind to the exact upstream
symbol. They are isolated and labelled; none block the relay/DM/call **transport**,
which is already protocol-compatible.

## Verifying (the build loop this repo needs)

1. `git submodule update --init --recursive --depth 1`
2. `bash avachat/integration/inject_bootstrap.sh`
3. `cd external/0xchat-app-main && sh ox_pub_get.sh && flutter build apk --debug`
4. Run, log in (a keypair is auto-provisioned per account), send a DM to another
   AvaChat user → confirm the kind-1059 gift wrap round-trips through
   `wss://avatok-relay...` and that NIP-42 AUTH + push fire (relay logs).

CI runs 1–3 automatically on the `feat/avachat-0xchat-graft` branch.

## Honest status

This module was authored **without a Flutter toolchain** (this repo builds in CI,
not locally). The adapters target **real, source-verified 0xchat APIs**, but have
**not been compiled**. CI is the first compile gate; expect to resolve the
`TODO(build)` seams there. `main` and `app/` are untouched — everything is on the
branch behind submodules + a new `avachat/` module.
