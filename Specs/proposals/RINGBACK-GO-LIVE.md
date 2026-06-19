# AI Ringback Tones + Busy Tone — Go-Live Checklist

Implementation of `PROPOSAL-AI-RINGBACK-TONES.md`. All six phases are committed on
`main` (not pushed). This file is the deploy/runbook + what's intentionally left as
a manual step. Nothing here has been applied to production.

## Commits (Phases 0–6)
- P0 `flags + config mirror + bundled fallback tones`
- P1 `ringtone Worker route + 5-item library`
- P2 `carry callee default ringtone to caller`
- P3 `caller-side ringback playback`
- P4 `busy tone for the caller`
- P5 `Ringback tone settings library UI`
- P6 `telemetry + go-live` (this doc)

## Required manual steps before it works in prod

1. **D1 migration (DB_META, prod AND staging).** Apply `worker/migrations/ringtones.sql`
   via the REST migration workflow (the repo's standard — DB_META is under-migrated on
   staging historically, so do both). Creates the `ringtones` table. Until applied,
   `/api/ringtone/*` errors and `call()`'s best-effort lookup just returns an empty
   `ringbackUrl` (callers fall back to the bundled default — no breakage).

2. **Deploy the Worker** (`avatok-api`). New route `/api/ringtone/*` + the `call()`
   response now carries `ringbackUrl`. Use the proven path: install `wrangler@^4` in
   `/tmp`, deploy with `CLOUDFLARE_API_TOKEN` from `secrets/cf_token`.
   - No consumer change needed: the ringback URL rides the **`/api/call` response**
     to the caller, not the FCM push, so `avatok-consumers` is untouched.

3. **R2.** Uses the existing `BLOBS` public bucket (served by `blossom.avatok.ai`),
   key layout `u/<uid>/ringtones/<id>.mp3`. No new binding.

4. **App build.** The bundled fallbacks `assets/audio/{ringback_default,busy_tone}.wav`
   ship in the APK (built in CI on push — no local Flutter toolchain). `audioplayers`
   and `path_provider` were already dependencies; no pubspec dep added.

5. **Kill switch.** `PlatformConfig.ringbackEnabled` defaults `true`. To disable:
   `PUT /api/admin/config { "ringbackEnabled": false }` → generation 503s and callers
   revert to today's silent ring + system busy within ~15 min (RemoteConfig poll).

## Cost controls (built in)
- Free to users; runs on our Workers AI key, routed through the AI Gateway when
  `AI_GATEWAY_ID` is set (cost logging + spend cap).
- Per-account **daily generation limit** (KV `rtgen:<uid>:<day>`, `DAILY_GEN_LIMIT=5`).
- **5 ringtones max per account**; a 6th evicts the oldest from R2 + D1 (no unbounded
  storage growth).
- Stored `seconds = 30` (the model returns a full song; we store the bytes as-is for
  v1 — see "known limitations"). Refused if > 8 MB.

## Telemetry to watch (PostHog)
- `ringtone_generated` (settings) — generation volume.
- `ringback_set` / `ringback_cleared` — adoption.
- `ringback_played` `{source: custom|default, video}` — fires on every outgoing call.
- `busy_tone_played` — busy-tone exposure.

## Verification / QA
- Generate → appears top of list; set default → `/api/ringtone/user/:uid/default` returns it.
- Call a user with a default set → caller hears their tune; stops on answer / decline /
  busy / no-answer / hangup (no lingering audio).
- Call a user with NO ringtone → bundled default plays.
- Offline caller → cached file or default (never a hang).
- Call a user already on a call → busy tone, screen pops after ~2.6s.
- Generate a 6th → oldest gone from BOTH the list and R2 (404 on its old URL).
- Delete the default → newest remaining auto-promoted; delete last → bundled default.
- Parent/child account switch on one phone → no ringtone/cache leak (per-account scoped).
- Flip `ringbackEnabled` off → silent ring + system busy, no dead UI.

## Known limitations (v1, acceptable)
- **Server-side trim: DONE.** MiniMax returns a full song; `routes/ringtone.ts` now
  trims it to `RINGTONE_SECONDS` (30s) via `lib/mp3.ts` — a pure-JS frame-boundary
  cut (no ffmpeg, no re-encode), with a safe fallback to the full bytes if the
  audio doesn't parse as MPEG. Cuts R2 size to ~30s of audio.
- **Caller-side, not carrier early media.** The ringback starts when the invite is
  sent, not synced to the callee's device actually ringing.
- **Callee-side custom device ringtone is out of scope** (would need Android
  raw-resource/file-path handling); the incoming-call UI still uses the system tone.

## Files
Worker: `routes/ringtone.ts`, `routes/api.ts` (call response), `routes/config.ts`
(flag), `index.ts` (dispatch), `migrations/ringtones.sql`.
App: `core/feature_flags.dart`, `core/remote_config.dart`, `core/ringback_player.dart`,
`core/ringtone_api.dart`, `core/ava_bootstrap.dart`,
`features/avatok/call_screen.dart`, `features/avatok/chat_thread.dart`,
`features/settings/sections/ringtone_section.dart`,
`assets/audio/{ringback_default,busy_tone}.wav`, `pubspec.yaml`.
