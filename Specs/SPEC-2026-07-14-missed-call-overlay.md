# [AVA-MISSEDCALL-1] Truecaller-style missed-call overlay

Owner request 2026-07-14. Ships **DARK** behind the `missedCallOverlay` platform flag.

## What it does
When the user misses an incoming call, a card is drawn **over every app**
(`SYSTEM_ALERT_WINDOW`) showing who called — mirroring Truecaller's after-call popup:

- avatar initial + caller name (or number) + "Missed call · rang Ns" + ✕
- a full-width **View profile** button (opens the caller in AvaTOK)
- **RESPOND WITH MESSAGE** chips: "Call me back?", "Sorry I'm busy", "Type custom…"
- action row: **CALL · MESSAGE · AVATOK** (no WhatsApp — owner request). The AvaTOK
  badge is **bright green when the caller is on AvaTOK, greyed out otherwise**.

## ⚠️ Privacy decision reversal
Lighting the AvaTOK icon requires resolving membership from the caller's real phone
number. On **2026-06-27** phone-presence matching was deliberately disabled
(`/api/contacts/match` returned nothing) to prevent a presence oracle. On
**2026-07-14 the owner explicitly reversed this**: membership is now looked up by the
caller's real number (private or not). The reversal is:

- **gated** by the `missedCallOverlay` flag — while it is `false`, `/api/contacts/match`
  returns nothing and the old privacy behaviour is intact;
- **matches all** accounts by `phone_hash` regardless of `phone_discoverable`.

Flip `missedCallOverlay:false` in KV `platform_config` to instantly restore the lock.

## Architecture (cache then backend)
- **Backend** — `worker/src/routes/api.ts::contactsMatch` un-stubbed: `POST {hashes[]|numbers[]}`
  → `{matched:[{hash,uid,name,avatar_url,avatok_number}]}`, matching `users.phone_hash`
  (sha256 of E.164 via `normalizePhone`). Chunked `IN(...)`, capped 500. Flag: `config.ts`
  `missedCallOverlay` (DEFAULTS `false`); client mirror `RemoteConfig.missedCallOverlay`.
- **Native (`ai.avatok.avadial`)**
  - `AvaMissedCallReceiver` — `PHONE_STATE` state machine (RINGING→IDLE without OFFHOOK
    = missed). Reads number from `EXTRA_INCOMING_NUMBER` or the newest MISSED call-log
    row. Looks caller up in the on-device directory snapshot (name + AvaTOK flag), shows
    the overlay, emits `onMissedCall` to Dart. **No network on this path.** Early-returns
    unless Dart wrote `{enabled:true}` into `missedcall_config.json`.
  - `AvaMissedCallOverlay` — programmatic card (mirrors `AvaOtpOverlay`); `update()`
    re-paints the AvaTOK badge/name when a late backend confirm arrives.
  - `AvaMissedCallActions` — call-back / SMS quick-reply / open-in-AvaTOK intents.
  - `AvaDialPlugin` — companion `missedCallConfigFile` / `avatokDirFile` / `notifyOpenDial`;
    channel methods `canDrawOverlay`, `requestOverlayPermission`, `setMissedCallEnabled`,
    `writeAvatokDirectory`, `missedCallResolved`, `showMissedCallPreview`, `getPendingOpenDial`.
  - Manifest: `AvaMissedCallReceiver` registered for `android.intent.action.PHONE_STATE`.
    Reuses the already-declared `SYSTEM_ALERT_WINDOW` / `READ_PHONE_STATE` / `READ_CALL_LOG`.
- **Dart** — `MissedCallService` (`lib/features/avadial/missed_call_service.dart`):
  keeps the on-device directory fresh (contacts + recent call log names, AvaTOK flags from a
  batched match — the **cache**), and on `onMissedCall` does a single-number live match and
  repaints via `missedCallResolved` (the **backend**). Directory key = `sha256(last-10-digits)`
  so contact/call-log formatting differences collide. Wired in `shell_v2._wireMissedCall`
  and a task in the AvaDial setup sheet (shares the "appear on top" permission).

## Cold-start membership confirm (app swiped off)
The `PHONE_STATE` receiver is manifest-registered, so it fires and draws the overlay even
when the app is swiped off (process cold-started, no Flutter engine). The overlay paints
from the on-device cache instantly. To also confirm the **bright AvaTOK icon while the app
is dead**, the receiver does a tiny background-thread HTTPS lookup:

- **Device token** — `MissedCallService` mints a 30-day HMAC token from
  `POST /api/missedcall/token` (Clerk-authed) and the plugin stores `{enabled, token, base}`
  in `missedcall_config.json`. Token is stateless (`{u:uid, exp}` + HMAC), mirrors the
  join-link token in `cal/ics.ts`. Secret: `MISSEDCALL_TOKEN_SECRET` (falls back to
  `JOIN_LINK_SECRET`). Revoke all tokens by rotating that secret.
- **Lookup** — `AvaMissedCallReceiver.confirmViaBackend` POSTs `{token, numbers:[n]}` to
  `POST /api/missedcall/lookup` (token-auth, no Clerk) on a background thread and calls
  `AvaMissedCallOverlay.update(...)` to re-paint the badge bright on a hit. Best-effort:
  offline / expired token / 401 just leaves the cached grey badge. Both endpoints are gated
  by `missedCallOverlay` and share the `matchAvatokPhones` core with `/api/contacts/match`.

## To ship
1. Set the token secret (once): `wrangler secret put MISSEDCALL_TOKEN_SECRET` (staging + prod).
   Omitting it falls back to `JOIN_LINK_SECRET`, which also works.
2. Device-test with `AvaDialChannel.I.showMissedCallPreview(...)` and real missed calls
   (including with the app swiped off recents).
3. Flip `missedCallOverlay:true` in KV `platform_config` (staging first) via `scripts/flags.sh`.
4. Build is manual (`workflow_dispatch`) — owner triggers it explicitly.

## Telemetry
`missed_call_overlay_shown`, `missed_call_directory_synced`, `missed_call_avatok_confirmed`
(no raw numbers — only ring duration + cache/confirm verdicts).
