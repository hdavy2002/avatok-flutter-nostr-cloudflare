# Phase 2 Report — Device-side cache (scoping critical)            Date: 2026-07-02

Fixes review item **#9** (device half) and the **200–500 ms status fetch on screen open** (L1/L2/L3).

## Store table (scoping is the first thing to check)

| Store | Key / namespace | Scoping mechanism | Eviction | Cleared on sign-out? |
|---|---|---|---|---|
| Connection status | `…/avaapps/<accountId>/status.json` | **Per-account subdir** using `AccountScope.id` (falls back to `_device` when no account) | Overwritten each refresh (single file) | **Yes** — `AvaAppsCache.clearCurrentAccount()` deletes the account's `avaapps/<id>/` dir |
| Read-only run result | `…/avaapps/<accountId>/run_<fnv1a(query)>.json` | **Per-account subdir** using `AccountScope.id` | **LRU cap 50** (`kAvaAppsMaxRunSnapshots`), oldest by `fetched_at` deleted on write | **Yes** — same dir wipe |

Every store lives under `getApplicationSupportDirectory()/avaapps/<AccountScope.id>/`, so a parent and a child sharing one phone get **physically separate directories** — cached email/calendar snapshots cannot leak across accounts. This is the exact "per-account subdir" mechanism allowed by rulebook rule 3 (I did not reuse the shared drift `db.dart`, which is also being edited by another agent concurrently, to avoid both a merge collision and blast radius).

## What I did (bullet per change, with file:line)

- **New store `app/lib/core/avaapps_cache.dart`:** `AvaAppsCache` with `readStatus`/`writeStatus`, `readRun`/`writeRun`, `clearCurrentAccount`/`clearForAccount`, LRU `_evict`, and an `AvaAppsSnapshot { json, fetchedAt, isStale, ageSeconds, ageLabel }`. `kAvaAppsDeviceCache` (default `true`) checked at every read AND write. `kAvaAppsSnapshotTtl = 10 min` (named/documented). Filesystem key via a pure-Dart FNV-1a hash (no new package dependency — `crypto` is not a direct dep, so I avoided it).
- **Persistence wired in `apps_service.dart`:** `status()` writes the connected set to the device cache on every successful fetch; `run()` writes read-only answers (same `_isReadOnly` gate that already governs the in-memory cache) so a repeat survives an app restart.
- **Stale-while-revalidate in `avaapps_screen.dart`:**
  - `_load()`: on open (non-fresh), reads `AvaAppsCache.readStatus()` and renders the green dots **instantly with zero awaited network**, then the existing `Future.wait` refreshes and replaces. Emits `avaapps_snapshot_render {kind:"status"}` + `avaapps_bg_refresh_ok {kind:"status"}`.
  - `_run()`: shows a cached answer for the exact query immediately with an **"as of <time> · refreshing…"** banner (spinner), then replaces it with the fresh result. Emits `avaapps_snapshot_render {kind:"run_result"}`; `avaapps_bg_refresh_error` on failure.
- **Sign-out clear (`settings_screen.dart`):** the Log-out button now `await AvaAppsCache.clearCurrentAccount()` **before** `clerk.signOut()` (while `AccountScope.id` still points at the departing account).
- **Catalog logos (item 4):** already local-first. The grid renders via `AppIconCache` (`app/lib/core/app_icon_cache.dart`), which is the icon-equivalent of `AvatarCache` — it disk-caches under `getApplicationSupportDirectory()/app_icons` and serves from disk on every later open (the screen comment at the SliverGrid documents this). Composio logos are hosted on `logos.composio.dev`, not `avatok.ai`, so the CF `/cdn-cgi/image` transform does not apply to them (it only works on the avatok.ai zone) — matching `AvatarCache.getAny`'s own host check. **No change needed**; requirement already satisfied.

## Flags / env / secrets introduced

- **`kAvaAppsDeviceCache`** (Dart `const bool`, default `true`, `avaapps_cache.dart`). Checked at every read/write; set to `false` to disable the entire device cache in one line (AvaApps reverts to network-only).
- No env/secrets.

## Telemetry added (event name → properties → where fired)

- `avaapps_snapshot_render` → `{kind: status|run_result, age_s, cache:"hit"}` → screen `_load` / `_run`.
- `avaapps_bg_refresh_ok` → `{kind, ms}` → screen `_load`.
- `avaapps_bg_refresh_error` → `{kind, ms}` → screen `_run` catch.
  (Client events inherit the identified PostHog person = uid via `Analytics._base`.)

## PostHog annotation ID

- **95975** (project 139917, EU).

## What I verified and HOW

- **Scoping audit (the reviewer's first check):** every path in `avaapps_cache.dart` builds under `avaapps/<_accountId>/` where `_accountId = AccountScope.id ?? '_device'`. There is NO raw global filename. `grep` of the file confirms no path omits the account segment.
- Confirmed `kAvaAppsDeviceCache` guards `writeStatus`, `readStatus`, `writeRun`, `readRun` (early `return`/`return null`).
- Confirmed SWR ordering: cached render happens before the awaited network call; the fresh result unconditionally overwrites `_answer` and clears `_answerAsOf`.
- Confirmed sign-out clears BEFORE `signOut()` so `AccountScope.id` is still valid.
- Confirmed no new package: replaced the initial `crypto` import with an inline FNV-1a after checking `app/pubspec.yaml` (crypto is not a direct dependency).
- Confirmed I did NOT touch `db.dart`/`ava_contracts.dart` (both dirty from other agents).

## What I could NOT verify (needs CI build / device test / owner action)

- No local Flutter build/analyze (repo rule). Verified by reading.
- Real cross-account isolation and the instant-render feel need a device test with a parent+child account on one phone.
- LRU eviction under load (>50 distinct read queries) needs a device/emulator run.

## Deviations from the phase prompt (and why)

- **Did NOT extend the drift SQLite `db.dart`** (prompt step 1 preferred reusing it). Reason: `db.dart` is being modified by another agent right now (dirty working tree), and adding tables there would (a) risk sweeping their changes into my commit and (b) widen blast radius. A dedicated per-account file store gives the same guarantees (scoping, eviction, SWR) with zero shared-file contention. The report's store table documents the mechanism as required.
- Logo caching left as-is (already satisfied) — see item 4 above.

## Risks & rollback

- Set `kAvaAppsDeviceCache = false` → device cache fully bypassed, network-only behavior. Or revert the commits.
- Worst case a stale snapshot renders for ≤ the refresh round-trip; the fresh result always replaces it, and status also has the server-side 5-min TTL behind it.

## Handoff notes for the next phase

- The device cache is answer-level; Phase 3's server result cache is tool-level — they compound (device instant-render + server 90s tool cache) without conflicting.
- `AvaAppsCache.clearForAccount(id)` is available if a full account-deletion cascade is later wired (I hooked sign-out; account-removal cascade was not found as a central client hook).
