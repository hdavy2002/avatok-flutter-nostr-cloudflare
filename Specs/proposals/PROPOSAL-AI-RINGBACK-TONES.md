# Proposal — AI Ringback Tones + Busy Tone

**Status:** Draft · **Owner:** davy · **Date:** 2026-06-19
**Scope (locked this session):** Caller-side ringback (CRBT) + busy tone only.
**Funding (locked this session):** Free to users — generated on our Cloudflare
Workers AI server key, absorbed as a platform cost. No AvaWallet charge.

---

## 0. Summary

Let a user generate a custom ringtone with Workers AI (`minimax/music-2.6`) and set
it as their **ringback** — the tune the *caller* hears while the call is ringing.
When the user is already on another 1:1 call, a second caller hears a **busy tone**.

This is delivered as **local playback on the caller's device**, not carrier-style
early media. The caller's app fetches the callee's ringtone URL (carried in the call
invite), caches it per-account, and plays it during the existing `ringing` phase.
No change to the WebRTC media path and no change to `CallRoom`'s 1:1 signaling role.

### Why this is mostly additive, not a rebuild
- `CallRoom` (`worker/src/do/call_room.ts`) stays pure signaling. **Untouched.**
- The caller already has a `ringing` phase with a 35s no-answer timeout
  (`call_screen.dart:97-102`) — today it is **silent**. We give it sound.
- Busy is **already detected** on two layers (see §5); we only add the *tone*.

### Key constraint (read before building)
This is a **caller ringback tone (CRBT)**, NOT a normal device ringtone. The caller
hears the callee's tune via local playback the instant the invite is sent — it is
**not** synced to the callee's device actually ringing (no early media over P2P).
In practice this is indistinguishable to users and is how WhatsApp-style apps behave.
Callee-side custom ringtone (the callee's *own* phone playing a custom tune) is
explicitly **out of scope** this round (it needs Android raw-resource/file-path work).

### Model facts (verified)
`minimax/music-2.6` is live on Workers AI: `env.AI.run('minimax/music-2.6', {...})`
returns `{ result: { audio: "<mp3|wav url>" }, state: "Completed" }`. Supports
`is_instrumental`, `lyrics`/`lyrics_optimizer`, `format` (mp3|wav), `sample_rate`,
BPM/key control. Zero data retention. Default to `is_instrumental: true` and short
clips (see §7 licensing note).

### Ringtone duration (decided)
Each ringtone is stored as a **30-second clip** (`kRingtoneSeconds = 30`). The model
returns a full-length song; the Worker **trims it to the first 30s** before storing.
Rationale: the caller's ring phase times out at **35s** (`call_screen.dart:99`), so a
30s clip **looped once** comfortably covers the whole ring window without a long
unused tail wasting R2 + bandwidth and without raising licensing exposure. Value is
a single source-of-truth constant so it can be tuned later.

### Hard rules locked this session
- **Max 5 saved ringtones per account.** Generating a 6th **deletes the oldest**
  (FIFO eviction) — both its D1 row **and** its R2 object.
- **Deleting a ringtone deletes it from storage (R2), not just the list.**
- **Exactly one ringtone is the default** at a time; the default is what callers hear.
- **No ringtone data lives in any Durable Object.** DOs are coordination only
  (`CallRoom` persists nothing). Audio → R2; metadata → D1 `avatok-meta`.
- All of the above is **per active account** (parent/child share a phone).

---

## 1. Phasing at a glance

| Phase | Title | Surface | Ships |
|-------|-------|---------|-------|
| 0 | Foundations & flags | flag + config | kill switch, defaults |
| 1 | Generation + 5-item library (server) | Worker + R2 + D1 | generate, list, set-default, delete, FIFO evict |
| 2 | Carry default ringtone URL in the call invite | Worker push | caller receives callee's default |
| 3 | Caller-side ringback playback | Flutter `call_screen` | caller hears the tune |
| 4 | Busy tone | Flutter `call_screen` | second caller hears busy |
| 5 | Settings UI — library / generate / set-default / delete | Flutter settings | self-serve |
| 6 | Hardening, observability, go-live | cross-cutting | metrics + checklist |

Each phase is independently shippable behind the kill switch.

---

## 2. Phase 0 — Foundations & flags

**Objective:** lock the kill switch, defaults, and per-account storage key before any
audio code lands.

- Add `kRingbackEnabled` to `app/lib/core/feature_flags.dart` (mirror the existing
  `conferenceEnabled`-style gating pattern). Server-side mirror via `routes/config.ts`.
- Per the Rulebook, ALL per-user state is account-scoped. Reserve a scoped key now:
  `scopedKey('ringback.url')` and `scopedKey('ringback.localPath')` via
  `app/lib/core/account_storage.dart`. A raw global key would leak the tone across
  parent/child accounts sharing the phone — do not use one.
- Ship a bundled default busy-tone asset (`assets/audio/busy_tone.ogg`) and a
  bundled default ringback (`assets/audio/ringback_default.ogg`) so the feature has
  a fallback when no custom tone is set or the network is down.
- Decision locked: **no AvaWallet charge**. Generation runs on the platform server
  key. Add a per-user generation rate limit instead (see §6) to cap cost/abuse.

**Done when:** flag exists on client + server, default assets bundled, scoped keys
reserved. No user-visible change yet.

---

## 3. Phase 1 — Generation + storage (server)

**Objective:** one Worker route that turns a prompt into a stored, per-account
ringtone, holds a **library of up to 5** per account, tracks which one is the
default, and deletes from R2 on delete/eviction. This is the only genuinely new
backend piece.

### 3.1 Data model — library, not a single column
Audio bytes live in **R2**; metadata lives in **D1 `avatok-meta`**. Nothing in a DO.

New migration (via REST API per the established workflow):

```sql
CREATE TABLE IF NOT EXISTS ringtones (
  id          TEXT PRIMARY KEY,          -- uuid
  account_id  TEXT NOT NULL,             -- AccountScope.id (per-account scoping)
  name        TEXT NOT NULL,             -- shown in settings (e.g. "Calm piano 1")
  r2_key      TEXT NOT NULL,             -- ringtones/<account_id>/<id>.mp3
  url         TEXT NOT NULL,             -- served URL
  seconds     INTEGER NOT NULL,          -- 30
  is_default  INTEGER NOT NULL DEFAULT 0,-- exactly one =1 per account
  created_at  INTEGER NOT NULL           -- epoch; FIFO eviction key
);
CREATE INDEX IF NOT EXISTS ix_ringtones_acct ON ringtones(account_id, created_at);
```

Invariants enforced server-side in a transaction:
- **≤ 5 rows per `account_id`.** On insert, if count would exceed 5, select the
  **oldest by `created_at`**, delete its **R2 object** (`env.BUCKET.delete(r2_key)`),
  then delete its row — then insert the new one.
- **Exactly one `is_default = 1`** per account. Setting a new default clears the
  others in the same statement. If the deleted/evicted row was the default, promote
  the **newest remaining** row to default automatically (never leave an account with
  rows but no default).

### 3.2 Route module `worker/src/routes/ringtone.ts` (mounted in `index.ts`, `/api/ringtone/*`)

- `POST /api/ringtone/generate` → body `{ prompt, name?, instrumental?: bool }`.
  - Rate-limit per account (KV counter — see §6).
  - `env.AI.run('minimax/music-2.6', { prompt, is_instrumental: true, format: 'mp3' })`.
  - Fetch `result.audio`, **trim to `kRingtoneSeconds = 30`** server-side.
    IMPLEMENTED in `worker/src/lib/mp3.ts` (`trimMp3ToSeconds`): a pure-JS MP3
    frame-boundary cut (no ffmpeg / no re-encode) that keeps any ID3 tag + frames
    up to 30s and drops the rest; falls back to the full bytes if the audio
    doesn't parse as MPEG.
  - Upload to R2 `ringtones/<account_id>/<id>.mp3`.
  - Insert row (running the §3.1 FIFO + default invariants). First-ever ringtone for
    the account becomes default automatically. Return the new ringtone record.
- `GET /api/ringtone/list` → this account's ≤5 ringtones, newest first, with
  `is_default` flags. Drives the settings library.
- `POST /api/ringtone/:id/default` → make `:id` the default (clears the others).
- `DELETE /api/ringtone/:id` → delete the **R2 object first**, then the row. If it
  was the default, promote the newest remaining (or none if the list is now empty).
- `GET /api/ringtone/user/:userId/default` → the **default** ringtone URL for a
  callee (used by the caller in Phase 2). Returns empty → caller uses bundled default.

**Caching/serving:** serve via R2 public path behind the existing Cloudflare asset
caching convention; the audio is non-sensitive (it's a ringback others hear).

**Done when:** an account can generate multiple ringtones (capped at 5 with oldest
evicted from R2 + D1), list them, set any one as default, and delete any one with the
R2 object actually removed.

---

## 4. Phase 2 — Carry the ringtone URL in the call invite

**Objective:** when A calls B, A's app learns B's ringback URL so it can play it.

- Server-side: wherever the call FCM push is built, include B's `ringbackUrl` in the
  data payload alongside the existing `callId / fromPub / fromName / kind` fields.
  The client already reads this map in `push_service.dart` `_showIncoming(d)` /
  the call-status path — add one field, no new transport.
- Caller path: the caller is the one who needs B's tone. Two options (pick in-session):
  1. **Push-carried:** the invite/ack the caller receives includes `ringbackUrl`.
  2. **Profile fetch:** caller calls `GET /api/ringtone/user/:id/default` when
     dialing.
  Push-carried is fewer round-trips and works on cold start; profile-fetch is
  simpler to secure. Recommend push-carried with profile-fetch fallback. Either way
  the caller resolves the callee's **current default** ringtone (so changing the
  default later takes effect on the next call with no client redeploy).
- `CallScreen` gains an optional `ringbackUrl` constructor field (sibling to the
  existing `avatarUrl`, `seed`, `outgoing` fields at `call_screen.dart:27-42`).

**Done when:** the caller's `CallScreen` is constructed with a non-empty
`ringbackUrl` for callees who have set one.

---

## 5. Phase 3 — Caller-side ringback playback

**Objective:** make the existing `ringing` phase audible.

- Add an audio package (`just_audio` recommended; nothing is wired today — grep
  shows no `AudioPlayer` in the call path, the `ringing` phase is visual only).
- In `_CallScreenState` (`call_screen.dart`), when `widget.outgoing` and
  `_phase == 'ringing'`:
  - Resolve audio source: cached local file → else download `ringbackUrl` to the
    per-account media cache (`…/media/<AccountScope.id>/<hash>` per the Rulebook
    media-cache rule, so it's instant on repeat calls) → else bundled
    `ringback_default.ogg`.
  - Play looped at low latency. Respect the device silent/vibrate switch and route
    to earpiece/speaker consistent with the existing `_speaker` logic.
- **Stop the ringback on every exit path.** `_endWith(...)` (`call_screen.dart:121`)
  is already the single funnel for `connected` / `declined` / `busy` / `no-answer` /
  hangup — stop and dispose the player there (the file's own comment at L390 notes
  "ringtone on EVERY end path" — reuse that discipline).

**Done when:** dialing a user who set a ringback plays their tune; it stops cleanly
on answer, decline, busy, no-answer, and hangup, with no lingering audio.

---

## 6. Phase 4 — Busy tone

**Objective:** the second caller hears a busy tone. Detection already exists — only
playback is new.

Existing detection (no change needed):
- `push_service.dart:201` — if `gInCall` is true, auto-replies `'busy'`.
- `call_room.ts:35` — a 3rd peer is rejected with `{type:"busy"}`.
- `call_screen.dart:303-304` — `case 'busy': _endWith('busy')` already handled;
  `callStatusBus` surfaces it.

Add:
- When `_phase` becomes `busy` on the **caller**, play the bundled
  `busy_tone.ogg` once (or 2-3 short cycles), then proceed with the existing
  1.4s end-and-pop delay (`call_screen.dart:130`).
- Keep it bundled/standard — a custom AI busy tone is unnecessary and adds cost.

**Done when:** calling someone already on a call plays a busy tone, then the call
screen ends as it does today.

---

## 7. Phase 5 — Settings UI (generate / preview / set)

**Objective:** self-serve creation and selection.

- New "Ringback tone" row in the main Settings (registered alongside the other
  per-app settings entries).
- **Library list (the core of this screen).** Renders `GET /api/ringtone/list` —
  the account's saved ringtones (up to 5), newest first. Each row shows:
  - the ringtone **name**,
  - a **preview/play** tap (plays the 30s clip in-app),
  - a **"Set as default"** button — the currently-default row shows a filled/locked
    state instead (calls `POST /api/ringtone/:id/default`),
  - a **delete** button (trash) → confirm → `DELETE /api/ringtone/:id`, which
    removes the R2 object **and** the row, then refreshes the list. Deleting the
    default auto-promotes the newest remaining (server-side), reflected on refresh.
- **Generate** action (prompt field or preset chips: "calm piano", "upbeat synth",
  "lo-fi") → `POST /api/ringtone/generate` → new tone appears at the top of the list.
  - Show generation state (multi-second model call) and remaining daily quota.
  - **At 5 saved:** warn that generating a new one will **replace the oldest**
    (matches the server FIFO eviction) before the call goes out.
- Default the `is_instrumental: true` toggle. Explicit, clearly-labelled opt-in for
  vocal/lyrics with a copyright reminder.

**Done when:** a user can generate, see all saved ringtones in a list, preview any,
set any as default (one at a time), and delete any (with the R2 object gone) — all
scoped to the active account, capped at 5 with oldest-evicted behaviour.

---

## 8. Phase 6 — Hardening, observability, go-live

- **Rate limit & cost:** per-account KV counter on `/api/ringtone/generate`
  (e.g. 5/day). Log Workers AI usage; alarm on spend anomalies. (This replaces the
  per-generation AvaWallet charge we chose not to levy.)
- **Licensing/abuse:** default instrumental; cap clip length ~30s; keep a content
  check on prompts. Document MiniMax terms link in the proposal appendix.
- **Telemetry:** extend `CallTelemetry` (`call_screen.dart:75`) with
  `ringback_played` / `ringback_source` (custom|default|none) and `busy_tone_played`.
  Add PostHog events `ringtone_generated`, `ringback_set`, `ringback_cleared`.
- **Edge cases to test:** no ringback set (bundled default plays); offline caller
  (cached or default); silent-switch on; rapid decline before audio loads;
  second-call busy while first ringback still playing; parent/child account switch
  (no tone leak); **6th generation evicts the oldest in both R2 and D1**; **deleting
  the default auto-promotes the newest remaining**; deleting the last ringtone leaves
  the account on the bundled default; R2-delete failure must not orphan a live row
  (delete R2 first, then row; reconcile on failure).
- **Kill switch:** verify flipping `kRingbackEnabled` off restores today's silent
  ringing + system busy behaviour with no dead UI.

**Go-live checklist:** flag default, migration applied to prod + staging
`avatok-meta`, R2 path live, default audio assets shipped in the APK (built via CI —
no local Flutter toolchain), telemetry visible, rate limit verified.

---

## 9. Effort & sequencing

- **Phases 1-2** (server) can proceed in parallel with **Phase 0**.
- **Phase 3** depends on 2. **Phase 4** depends only on bundled assets (can ship
  before 3 if desired — it's the smallest, highest-certainty win).
- **Phase 5** depends on 1. **Phase 6** is cross-cutting, finalised last.
- Smallest shippable slice that delivers value: **Phase 4 (busy tone)** alone, since
  detection is already built.

## 10. Out of scope (named so it's not assumed)
- Callee-side custom device ringtone (Android raw-resource/file-path work).
- Carrier-style early media / true CRBT synced to the callee's device ringing.
- Per-contact ringbacks, ringtone **sharing** between users, monetization (future).
  (A per-account **library of up to 5** IS in scope — see Phase 1/5.)
- Group conference call tones (conferences are LiveKit; this is 1:1 only).

## 11. Files touched (reference)
- `worker/src/routes/ringtone.ts` (new), `worker/src/index.ts`,
  `worker/src/routes/config.ts`, `worker/src/routes/api.ts` (invite payload),
  D1 `avatok-meta` migration (new `ringtones` table — NOT a `users` column).
- `app/lib/core/feature_flags.dart`, `app/lib/core/account_storage.dart`,
  `app/lib/push/push_service.dart`, `app/lib/features/avatok/call_screen.dart`,
  new settings screen, `assets/audio/{busy_tone,ringback_default}.ogg`,
  `pubspec.yaml` (audio package + assets).
