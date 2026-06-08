# external/ — vendored 0xchat (LGPL/MIT, kept separate)

These are the upstream 0xchat repositories, pinned as **git submodules** and
consumed **unmodified** so AvaChat's proprietary code stays cleanly separated
from the LGPL libraries (see the licensing note in the proposal).

| Submodule | Upstream | License | Pinned commit |
|---|---|---|---|
| `external/0xchat-app-main` | 0xchat-app/0xchat-app-main | MIT | `0a674a3` |
| `external/0xchat-core` | 0xchat-app/0xchat-core | LGPL-3.0 | `76675e7` |
| `external/nostr-dart` (pkg `nostr_core_dart`) | 0xchat-app/nostr-dart | LGPL-3.0 | `41fe8f7` |

## Materialize them

The authoring environment could not clone into the repo (restricted mount), so
the submodules are declared in `.gitmodules` and pinned, but you fetch the
contents with:

```bash
git submodule update --init --recursive --depth 1
```

CI (`.github/workflows/avachat-build.yml`) does this automatically.

## Rules

- **Do not edit files under `external/`.** All integration lives in `avachat/`.
  The only seam into 0xchat is `avachat/integration/inject_bootstrap.sh`, applied
  at build time (one import + one `AvaChatBootstrap.init()` line).
- To update upstream: bump the submodule pointer, re-run CI.
- Fixes that belong in 0xchat-core / nostr-dart are contributed upstream (LGPL).
