# 12-sms-dark — HDFC UPI SMS payment rail: dark end to end

## Scope

Task: dark the internal ₹1 HDFC UPI SMS smoke harness end to end, reversibly, via
a flag. It is never the commercial gateway (that's Cashfree/the generic
`/api/pay/:gateway/*` lane — see `web/src/islands/checkout/GatewayPicker.tsx:99`,
which already fail-closed filters `hdfc_sms` out of the commercial picker in an
earlier phase).

Starting state in this worktree: lane `saathum/07-takedowns` (already merged into
this branch, commit `8fc1b41f`) had unregistered the HDFC routes from the Worker
router entirely (handlers left in place but unimported) and hard-404'd the two
`/test/upi*` web pages. That is a real dark, but restoring it means reverting a
commit, not flipping a flag — this task's explicit ask was a flag-driven 410 gate
instead, so the routes are re-registered but now refuse to do anything unless
`hdfcSmsRailEnabled` is true.

## 1. New flag: `hdfcSmsRailEnabled`

`worker/src/routes/config.ts` — declared in **both** `PlatformConfig` (line ~109)
and `DEFAULTS` (line ~2028), default `false`, right next to the pre-existing
`hdfcSmsEnabled`. These are two different switches, both must stay:

- `hdfcSmsEnabled` (pre-existing) — an *internal* pause inside the route handlers
  themselves (`worker/src/lib/hdfc_sms_smoke.ts:92-93`): when off, GETs/reads and
  signed SMS ingestion still work per the v2 plan, only creation/claiming pauses.
- `hdfcSmsRailEnabled` (new, this task) — a *router-level* kill switch. When off,
  **every** request under the family 410s immediately, before any handler code
  runs at all — no `requireAdmin`, no HMAC/device-secret check, nothing.

Boolean flag, no `numericKeys` entry needed.

## 2. Routes gated (worker/src/index.ts)

All four HDFC route modules are re-imported (they were unimported by lane 07) and
registered inside one guarded block, matching the existing `/api/v2/` pattern at
`index.ts:779-786`. The gate:

```ts
if (p.startsWith("/api/pay/hdfc-sms/") || p === "/api/sms/incoming" || p === "/api/sms/heartbeat") {
  const hdfcCfg = await readConfig(env);
  if (!hdfcCfg.hdfcSmsRailEnabled) return json({ error: "gone", reason: "hdfc_sms_rail_disabled" }, 410);
  ... route table ...
}
```

Routes gated (18 total):

| Method | Path | Handler |
|---|---|---|
| GET | `/api/pay/hdfc-sms/qr` | `hdfcSmsQr` |
| POST | `/api/pay/hdfc-sms/public/order` | `hdfcPublicOrder` |
| GET | `/api/pay/hdfc-sms/public/status` | `hdfcPublicStatus` |
| POST | `/api/pay/hdfc-sms/public/claim` | `hdfcPublicClaim` |
| POST | `/api/pay/hdfc-sms/public/recheck` | `hdfcPublicRecheck` |
| POST | `/api/pay/hdfc-sms/customer/redeem` | `hdfcCustomerRedeem` |
| GET | `/api/pay/hdfc-sms/customer/current` | `hdfcCustomerCurrent` |
| POST | `/api/pay/hdfc-sms/customer/order` | `hdfcCustomerOrder` |
| GET | `/api/pay/hdfc-sms/customer/status` | `hdfcCustomerStatus` |
| POST | `/api/pay/hdfc-sms/customer/claim` | `hdfcCustomerClaim` |
| POST | `/api/pay/hdfc-sms/customer/recheck` | `hdfcCustomerRecheck` |
| GET | `/api/pay/hdfc-sms/current` | `hdfcSmsCurrent` |
| POST | `/api/pay/hdfc-sms/claim` | `hdfcSmsClaim` |
| POST | `/api/pay/hdfc-sms/recheck` | `hdfcSmsRecheck` |
| POST | `/api/pay/hdfc-sms/order` | `hdfcSmsCreateOrder` |
| GET | `/api/pay/hdfc-sms/method` | `hdfcSmsMethod` |
| GET | `/api/pay/hdfc-sms/status` | `hdfcSmsStatus` |
| POST | `/api/sms/incoming` | `hdfcSmsIncoming` (companion's signed webhook) |
| POST | `/api/sms/heartbeat` | `hdfcSmsHeartbeat` (companion's signed heartbeat) |

Any unmatched method/path under those three prefixes still falls through to a
plain 404 inside the same guarded block (unchanged from before), but only once
the flag is on — while it's off nothing inside the block executes past the 410.

No commercial code path touches this family: `hdfc_sms` was already removed from
`worker/src/lib/payments/registry.ts` / the picker in an earlier phase (see
`Specs/PLAN-HDFC-UPI-SMS-FIX.md` Phase 1), and that removal is untouched here.

## 3. Android companion (`sms-companion/`)

Correction acknowledged: the companion **is** in this repo, at
`sms-companion/` — it's a separate nested git repo (own remote
`upeo-sms-gateway`, own `.git`) that is gitignored by the parent
(`.gitignore:118`), so it doesn't get copied into a `git worktree add` checkout.
It only physically exists at the one location it was cloned:
`/Users/davy/Documents/websites/avaTOK-2-Flutter/sms-companion` (the main
checkout). I edited and committed it there — commit `7ea6330` on its `main`
branch, HEAD before this change was `5a3acf0` (matches the "Companion revision"
recorded in `Specs/HANDOVER-HDFC-UPI-SMS-PAYMENT.md`). **Not pushed** — same
"never push unless asked" posture as the parent repo, and this is a different
remote/repo entirely so the parent's `git_safe_push.py` doesn't apply to it.

Made inert at two layers, both mirrors of a single boolean, both defaulting to
"disabled":

- **Dart**: `K.railDisabled = true` (`lib/src/core/constants.dart`).
  - `main.dart` `_Bootstrap._startup()` returns immediately — never schedules the
    WorkManager backstop, never calls `NativeBridge().startService()`.
  - `main.dart` `backgroundMain()` (the isolate the Kotlin foreground service
    hosts) returns immediately, before wiring up the `onSmsReceived`/`onSweep`
    method-call handler — so even if the native side did start the service and
    call into Dart, the isolate does nothing.
  - `lib/src/ui/app.dart` short-circuits `UpeoApp.build` to always show the new
    `lib/src/ui/screens/disabled_screen.dart` ("This app is disabled") instead of
    ever reaching `SetupScreen`/`HomeShell` — no config screen, no dashboard, no
    manual "start service" button reachable.
- **Kotlin** (defense in depth, in case a receiver fires before Dart runs):
  `CompanionRail.disabled = true`
  (`android/app/.../CompanionRail.kt`, new file).
  - `SmsReceiver.onReceive` returns before calling `SmsParser.fromIntent` — an
    incoming `SMS_RECEIVED` broadcast is never parsed or forwarded.
  - `BootReceiver.onReceive` returns before starting the foreground service on
    boot/app-update.
  - `MainActivity.kt`'s native `startService`/`readInbox` channel methods were
    left untouched, since they're only reachable from Dart screens that are now
    unreachable (`SetupScreen`/`DashboardScreen`); no separate gate was needed
    there without adding an unused code path.

Net effect: install the current APK, and it opens straight to a static disabled
notice, never requests SMS permission through app flow, never starts the
foreground service, never reads or posts anything.

**Not verified by a build** — this Mac has no local Flutter/Android toolchain
(deliberately removed 2026-09-10, per the parent repo's `CLAUDE.md`), and the
companion has its own separate CI (`sms-companion/.github/workflows`) that I did
not trigger. This is source-level work only; the owner's own CI or a manual
`flutter analyze`/build elsewhere is the real compile net for the Dart change, and
Kotlin compiles as part of the Android Gradle build the same CI runs.

## 4. Web smoke pages

Both `web/src/pages/test/upi.astro` and `web/src/pages/test/upi/admin.astro` were
already a hard `export const prerender = false; return new Response('Not found', {status: 404})`
from lane 07 — genuinely unreachable regardless of any flag. I only corrected
their header comments (they referenced "unregistered from the Worker router",
which is no longer accurate now that the routes are registered-but-410-gated).
No other reachable link to `/test/upi*` exists — checked nav/footer/sitemap
sources; the only other reference is a path-matching entry in
`web/src/lib/analyticsCore.ts:84` (an analytics allowlist check, not a link).

I deliberately left these pages as static 404s rather than making them read
`hdfcSmsRailEnabled` and conditionally render: the task's explicit ask (item 4)
was to remove reachability, which was already true; making the web UI itself
flag-restorable was not asked for and would be new scope on top of a page that
was already intentionally killed by a separate, deliberate lane.

## Verification

- `npx tsc --noEmit -p worker/tsconfig.json` (via a temporary symlink to the main
  checkout's `worker/node_modules`, removed immediately after — this worktree has
  no `node_modules` of its own and `npm install` is forbidden in a sandbox per
  `CLAUDE.md`) → **0 diagnostics**.
- Read-through of `worker/src/lib/payments/registry.ts` and
  `web/src/islands/checkout/GatewayPicker.tsx` confirmed the commercial checkout
  path already excludes `hdfc_sms` (pre-existing containment from
  `Specs/PLAN-HDFC-UPI-SMS-FIX.md` Phase 1) — untouched by this change.
- Did not run `wrangler dev`/curl a live Worker (no deploy, per instructions) —
  the 410 behavior is asserted from source review of the gate, not a live probe.
- Did not run the companion's Dart/Kotlin test suites or a Flutter build (no
  local toolchain; see above).

## Not done / out of scope

- Withdrawing the companion from Google Play (Internal Testing track) and
  rotating `HDFC_SMS_DEVICE_SECRET` are operational steps outside a worktree —
  same gap lane 07 already flagged, still outstanding, still not this task's ask
  (the router-level 410 already makes the currently-installed APK's signed
  requests fail closed even without a secret rotation).
- No D1 migration, no deploy, no flag write to KV — none were requested and none
  were run.

## How to turn the rail back on

1. Worker: `ALLOW_PROD=1 scripts/flags.sh set hdfcSmsRailEnabled=true` (staging:
   drop `ALLOW_PROD=1`, mind the `cf.sh`-in-a-worktree-resolves-to-staging trap —
   set `AVATOK_TARGET=prod` explicitly if running from a worktree with no
   `.avatok-target`). This alone restores every Worker route with no code change.
2. Companion: flip `K.railDisabled` to `false` in `sms-companion/lib/src/core/constants.dart`
   and `CompanionRail.disabled` to `false` in
   `sms-companion/android/app/src/main/kotlin/com/upeo/upeo_sms_gateway/CompanionRail.kt`,
   then cut a new signed release through the companion's own CI/Play track.
3. Web: revert `web/src/pages/test/upi.astro` and
   `web/src/pages/test/upi/admin.astro` to a real page (lane 07's commit `8fc1b41f`
   has the last working version before the 404 stub) if the smoke UI itself is
   wanted back — not required just to re-enable the API.
