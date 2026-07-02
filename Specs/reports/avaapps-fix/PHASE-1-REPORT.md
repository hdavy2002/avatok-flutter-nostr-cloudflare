# Phase 1 Report — Server-side KV caches            Date: 2026-07-02

Fixes review items **#6** (tool declarations re-fetched every query) and **#8** (`connectedToolkits` hit on every run and every screen open).

## What I did (bullet per change, with file:line)

- **Cached tool declarations per toolkit in KV** (`worker/src/lib/composio.ts`):
  - New `declsForToolkit(env, slug, on, onRetry?, emit?)` — key `avaapps:decls:<slug>:v1`, value = the curated declarations array `geminiTools` builds for that toolkit, `expirationTtl: 86400` (24h). Miss → fetch from Composio (unchanged logic) → put. KV read error or Composio error → fall through / return `[]`, never throws.
  - Code comment states the `:v1` bump rule if `CURATED[slug]` changes.
- **Rewrote `geminiTools`** to call `declsForToolkit` for every slug **concurrently** with `Promise.all` and flatten — decls for different toolkits now fetch in parallel (was a sequential `for` loop). Signature `geminiTools(env, slugs, onRetry?, emit?)`.
- **Cached `connectedToolkits(uid)` in KV** (`composio.ts`):
  - New `cachedConnectedToolkits(env, uid, {fresh?, onRetry?, emit?})` — key `avaapps:conn:<uid>`, TTL 300s. `fresh` bypasses the read and refreshes. Any KV error → live Composio call.
  - New `invalidateConnCache(env, uid, emit?)` — deletes the key.
- **Wired the caches into both agent loops** (`composio.ts`): `runAppsToolLoop` uses `cachedConnectedToolkits` + `geminiTools(..., emit)`; `runAgentLoop` (in-chat @ava) uses `cachedConnectedToolkits` + cached `geminiTools`. Setup timing (`stats.setup_ms`) now measures cache-warm setup.
- **Routes** (`worker/src/routes/ava_apps.ts`):
  - `avaAppsStatus` reads `?fresh=1` → `cachedConnectedToolkits(env, uid, {fresh, emit})`; emits `avaapps_conn_cache` via `emit`.
  - `avaAppsRun` sets `stats.emit` so cache events carry email/phone.
  - `avaAppsConnect` and `avaAppsDisconnect` call `invalidateConnCache` on success.
  - `avaGenuiAction` gate reads `cachedConnectedToolkits`.
  - Removed the now-unused `connectedToolkits` import.
- **Client `?fresh=1` after OAuth** (`app/lib/core/apps_service.dart`, `app/lib/features/avaapps/avaapps_screen.dart`): `AppsService.status({fresh})` appends `?fresh=1`; the screen passes `fresh: true` from the post-OAuth poll (`_pollConnected`) and the app-resume reload (`didChangeAppLifecycleState → _load(fresh: true)`).

## Before/after hop diagram

```
BEFORE (every run):
 run → Composio GET connected_accounts          (network hop)
     → Composio GET /tools?toolkit=gmail         (hop)   ] sequential,
     → Composio GET /tools?toolkit=googledocs    (hop)   ]  one per
     → Composio GET /tools?toolkit=…             (hop)   ]  toolkit
 (same connected_accounts hop ALSO on every screen open)

AFTER (warm caches, repeat run within TTL):
 run → KV get avaapps:conn:<uid>                 (KV, ~1ms, no Composio)
     → KV get avaapps:decls:gmail:v1  ┐
     → KV get avaapps:decls:docs:v1   ├ Promise.all (parallel, all KV)
     → KV get avaapps:decls:…:v1      ┘
 (cold miss: same Composio fetches as before, but decls fetch in PARALLEL,
  then populate KV so the next run within 24h/5min is hop-free)
```

## Flags / env / secrets introduced (name, default, where read)

- **`AVAAPPS_KV_CACHE`** (env var; default **on** when unset). Read via `kvCacheOn(env)` in `composio.ts`. `"off"` bypasses every new cache (reads + writes skipped) and telemetry logs `cache:"bypass"`. **No wrangler.toml change required** — unset ⇒ enabled, and the total fallback-to-Composio means a missing value is always safe. To disable in prod: `wrangler secret put AVAAPPS_KV_CACHE` → `off` (or a `[vars]` entry).
- **No new KV namespace** — reuses the existing `TOKENS` binding (`wrangler.toml:123`).
- No new secrets.

## KV key schema

| Key | Value | TTL | Invalidated by |
|---|---|---|---|
| `avaapps:decls:<toolkit_slug>:v1` | JSON array of curated function decls | 24h | `:v1` bump on CURATED change; natural TTL |
| `avaapps:conn:<uid>` | JSON array of connected toolkit slugs | 300s | connect/disconnect success; `?fresh=1`; natural TTL |

## Telemetry added (event name → properties → where fired)

- `avaapps_decls_cache` → `{toolkit, cache: hit|miss|bypass|error, ms, email, phone}` → `declsForToolkit` (via `emit`).
- `avaapps_conn_cache` → `{cache: hit|miss|bypass|invalidated, ms, email, phone}` → `cachedConnectedToolkits` + `invalidateConnCache`.
- `avaapps_status_ok` now also carries `fresh`.

## PostHog annotation ID

- **95969** (project 139917, EU).

## What I verified and HOW

- Re-read every hunk. Confirmed: on any KV `get`/`put`/`delete` throw, code falls through to the live Composio path (wrapped in try/catch) — the cache is never load-bearing; a KV outage degrades to exactly today's behavior.
- Confirmed `AVAAPPS_KV_CACHE=off` skips both read and write and emits `cache:"bypass"` on both cache types (grep of the `on` branches).
- Confirmed invalidation is wired on BOTH connect and disconnect success paths and that `?fresh=1` threads client → `AppsService.status` → route → `cachedConnectedToolkits`.
- Confirmed decl parallelism: `Promise.all(slugs.map(declsForToolkit))`.
- Confirmed the removed `connectedToolkits` import leaves no remaining reference in `ava_apps.ts` (grep).

## What I could NOT verify (needs CI build / device test / owner action)

- No local TS/Flutter build (repo rule). Cache hit-rate numbers come from PostHog after deploy (`avaapps_decls_cache`/`avaapps_conn_cache`).
- Real invalidation timing (OAuth completion → cache drop → green dot) needs a device test.

## Deviations from the phase prompt (and why)

- None material. Used the existing `TOKENS` namespace (prompt allowed `env.TOKENS` or a dedicated namespace) to avoid a wrangler namespace change and its deploy coordination.

## Risks & rollback

- Rollback: set `AVAAPPS_KV_CACHE=off` → all new caches bypass, behavior reverts to pre-Phase-1 live fetches. Or revert the commits.
- Residual risk: a connection completing between a cache write and its TTL could be up to 5 min stale IF the invalidation path is missed — mitigated by invalidate-on-connect/disconnect AND client `?fresh=1` post-OAuth AND the 300s TTL ceiling.

## Handoff notes for the next phase

- Phase 3's result cache should follow the same key convention (`avaapps:res:<uid>:<tool>:<hash>`) and the same "KV error → fall through" discipline, and gate on its own flag (`AVAAPPS_RESULT_CACHE`), independent of `AVAAPPS_KV_CACHE`.
- `stats.emit` is available for any further cache telemetry with email enrichment.
