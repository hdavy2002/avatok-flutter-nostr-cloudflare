# Third-Party Licenses & Compliance — AvaChat (0xchat graft)

_Not legal advice. This records how we stay compliant; have an IP lawyer confirm
before commercial release._

## The short version

- **You do NOT have to open-source your own code, menus, or other apps.**
- Keep the LGPL libraries (`0xchat-core`, `nostr-dart`) as **separate, unmodified
  dependencies** (they live in `external/…` as submodules; our code lives in
  `avachat/`). Publish only changes we make **to those libraries**.
- Your **Cloudflare backend** (Workers, R2, DOs, KV, AvaBrain) carries **no
  obligation** — open-source licenses trigger on *distributing software*, and
  server code is never distributed.

## What we use and under which license

| Component | Where | License | Obligation on us |
|---|---|---|---|
| `0xchat-app-main` (the app shell) | `external/0xchat-app-main` | **MIT** | Keep copyright notice. Our changes can stay closed. |
| `0xchat-core` (`chatcore`, the engine) | `…/packages/0xchat-core` | **LGPL-3.0** | Keep as a separable library; if we modify it, publish those modifications; allow relinking. |
| `nostr-dart` (`nostr_core_dart`) | `…/packages/nostr-dart` | **LGPL-3.0** | Same as above. |
| `nostr-mls-package` | `…/packages/nostr-mls-package` | **MIT** | Notice only (currently disabled in build). |
| `cashu-dart` | `…/packages/cashu-dart` | **LGPL-3.0** | Not used — AvaWallet replaces it. If we ship it, treat as LGPL. |
| `tor` Flutter plugin (Rust) | pub dependency | Audit before ship | Pulls a Rust crate; confirm its license (MIT/Apache/BSD expected) during legal review. |
| Our integration (`avachat/`) | `avachat/` | **Proprietary (yours)** | None — your closed code. |
| Cloudflare backend | `worker/`, `relay/`, `calls/`, … | **Proprietary (yours)** | None — server code, never distributed. |

## The three rules that keep our code proprietary

1. **Separation.** `0xchat-core` and `nostr-dart` stay as their own packages. We
   never copy their source into `avachat/` or into our backend. (Already true.)
2. **Publish library changes only.** Any bug fix or change we make *inside* those
   two LGPL packages gets contributed upstream / published. Our app, UI, wallet,
   and backend are untouched by this.
3. **Notices.** Ship the MIT + LGPL license texts and an attribution screen in the
   app ("Open-source licenses").

## The one nuance to confirm with a lawyer

LGPL's "let a user relink with their own version of the library" clause predates
single-binary mobile apps (Flutter compiles everything together). The standard,
solved approach: keep the LGPL libs unmodified and be prepared to provide the
means to rebuild. Confirm the exact mechanism with counsel before commercial launch.

## Other apps in the ecosystem

An AvaVerse app only has an obligation if it **bundles** an LGPL library. Apps that
don't include `0xchat-core` / `nostr-dart` are entirely unaffected.
