# CF-CALL-006/007 — Cutover & LiveKit Removal Runbook

**Date:** 2026-07-24
**Owns:** the operational sequence that follows
`Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md` (Phase 0 →
Phase 4, acceptance matrix, and the appended `groupAudioSfuEnabled`-SUPERSEDED
note) from "both providers coexist in code" to "LiveKit is gone." This document
is the runbook only — it does not itself flip a flag, run a build, or delete
code. Every step below states who/what authorizes it before it happens.

---

## 1. Current state (post CF-CALL-001..005)

Both providers coexist in the shipped Worker and are reachable at the same
time. Nothing here is dormant by accident — each gate is a deliberate flag or
missing secret:

- **LiveKit path** (`worker/src/routes/conference.ts`, `/api/conference/*`) is
  live and is what every installed client actually uses today. It is gated by
  `livekitConferenceEnabled` (KV `platform_config`, default **true** — see
  `livekitConferenceEnabled()` in `conference.ts`). Per the Phase-0 assertion
  actually shipped (adapted from the literal proposal text, see the comment
  above `livekitConferenceEnabled()`), LiveKit issuance is refused **only**
  when this flag is explicitly `false` — it is *not* also gated on
  `cloudflareConferenceEnabled`, so both can be on at once during migration
  without breaking old clients.
- **Cloudflare Realtime path** (`worker/src/routes/groupcall.ts` +
  `worker/src/do/group_call_room.ts`, `/api/groupcall/*`) is gated by
  `cloudflareConferenceEnabled` (KV `platform_config`, default **false** per
  `cloudflareConferenceEnabled()` in `conference.ts` / `DEFAULTS` in
  `worker/src/routes/config.ts`).
- **`CONF_TICKET_SECRET`** is a dedicated Worker secret (`worker/src/types.ts`
  line ~248, consumed in `groupcall.ts` `mintJoinTicket`/`verifyJoinTicket`).
  Since CF-CALL-001 (commit `707337f`), every `/api/groupcall/*` WebSocket
  upgrade requires a valid ticket signed with this secret — if it is unset,
  ticket minting returns `null` and the join path fails closed (`groupcall.ts`
  line ~325, `reason: "CONF_TICKET_SECRET unset"`). It does **not** fall back
  to any other secret.
- **The shipped Flutter client is audio-only and pre-ticket**
  (`sfu_group_call_api.dart`, per the SUPERSEDED note appended to the
  proposal). It does not mint or send a join ticket and does not parse the
  ticket-authenticated response shape (`join_ticket`, `ws_url`, `call_id`,
  `call_trace_id`, `generation`, `session_id`). It cannot speak to the current
  `/api/groupcall` endpoints at all. The Cloudflare **audio/video** client
  (Phase 3: `cloudflare_conference_api.dart`, `cloudflare_conference_screen.dart`,
  `cloudflare_conference_telemetry.dart`, `conference_media_controller.dart`)
  does not exist in the tree yet.

**Net effect: the Cloudflare path is dormant in practice, not just in flag
state.** It only becomes reachable when ALL THREE are simultaneously true:

1. `cloudflareConferenceEnabled=true` in that environment's KV, AND
2. a build that actually contains the ticket-minting/`ws_url`-parsing Flutter
   client has shipped to the cohort being flipped (Phase 3 client — not yet
   built), AND
3. `CONF_TICKET_SECRET` is set via `wrangler secret put` in that environment
   (see §1.1) — without it, `/api/groupcall/*` fails closed for 100% of
   requests in that environment, flag state notwithstanding.

Flipping `cloudflareConferenceEnabled=true` today, before (2) and (3), does not
"softly" degrade — every group call in the affected cohort fails immediately
(see the SUPERSEDED note). Do not do it.

### 1.1 Setting `CONF_TICKET_SECRET`

No `scripts/flags.sh` support exists for Worker **secrets** (only the KV
`platform_config` blob) — secrets are `wrangler secret put`, which `scripts/cf.sh`
forwards generically (`exec npx wrangler "$@" ...`), so the same staging/prod
convention that gates `worker deploy` and `kv key put` applies unchanged:

```bash
# staging (default target — resolves via .avatok-target / git branch)
scripts/cf.sh worker secret put CONF_TICKET_SECRET
# prompts for the secret value on stdin; use a fresh random 32+ byte value,
# e.g.: openssl rand -base64 32 | scripts/cf.sh worker secret put CONF_TICKET_SECRET

# production — requires the explicit ALLOW_PROD=1 exception, same as any
# other prod-touching cf.sh call; nothing bypasses cf.sh's prod gate for secrets
ALLOW_PROD=1 scripts/cf.sh worker secret put CONF_TICKET_SECRET
```

Verify it landed (does not print the value back — `wrangler secret list` only
confirms the key exists):

```bash
scripts/cf.sh worker secret list              # staging
ALLOW_PROD=1 scripts/cf.sh worker secret list # prod
```

Never run `npx wrangler secret put` directly in `worker/` — same footgun as
`wrangler deploy`: no `--env` means it silently resolves the top-level
(production) `wrangler.toml` block.

---

## 2. Staging acceptance checklist (from the proposal's acceptance matrix)

Reproduced from `Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md`
§"Acceptance matrix before disabling LiveKit". Every row must pass on staging,
with the Phase 3 Cloudflare Flutter client installed, before touching
`livekitConferenceEnabled` anywhere. PostHog dashboard **id 845814** is the
verification surface for all rows — query it with cache-busted, staging-scoped
filters (`app_release` = the staging build under test, `group_id_hash` /
`call_id` scoped to the manual test session where relevant).

| # | Test | Required result | PostHog verification (dashboard 845814 / HogQL) |
|---|---|---|---|
| 1 | 1:1 video Wi-Fi | clear audio/video, camera flip, no renderer race | `cloudflare_renderer_state` shows no repeated `renderer_bound→unbound` flapping for the test `call_id`; `cloudflare_media_health` reaches `renderer_frame_progressing` + `audio_playout_progressing` within a few seconds of join |
| 2 | 1:1 video cellular | bounded bitrate, adaptation, recovery, measured Cloudflare relay | `cloudflare_route_state` shows `relay_used=true` when forced off Wi-Fi; `cloudflare_reconnect_started/completed` pairs with no orphaned `_started` (i.e. every `_started` has a matching `_completed` or `_failed` for the same `call_id`+`generation`) |
| 3 | CF group audio 2/5/10/25 | stable active-speaker selection and recovery | `cloudflare_participant_joined/left` count converges to the expected roster size per `call_id`; no `cloudflare_conference_error` spike correlated with those `call_id`s |
| 4 | CF group video 2/5/10/25 | viewport-aware subscriptions, no mobile memory runaway | `cloudflare_track_pull_started/completed` — pulled-track count stays bounded (not ~25 simultaneous full-quality pulls per client); pair with an on-device memory check (manual, not PostHog) |
| 5 | camera off/on | video track state changes without audio interruption or new session | `cloudflare_track_publish_*` shows a `video` track toggle event with the **same** `session_id`/`generation` before and after — no new `cloudflare_conference_join_started` in between |
| 6 | participant join/leave | roster and track state converge on every device | `cloudflare_participant_joined`/`left` counts match across every device's own event stream for the same `call_id` |
| 7 | background/foreground | signaling reattach and billing reconcile correctly | `cloudflare_reconnect_started/completed` around the backgrounding window; `cloudflare_billing_beat/reconciled` shows no gap/double-count in elapsed minutes for the `call_id` |
| 8 | expired/replayed ticket | WebSocket rejected | Worker-side: no successful `cloudflare_conference_joined` for a `call_id` whose ticket was deliberately replayed/expired; check Worker logs / `cloudflare_conference_error` with a ticket-rejection reason |
| 9 | non-member/unauthenticated | HTTP and WebSocket rejected | same as above — no `cloudflare_conference_ticket_issued` or `_joined` event for the disallowed uid/group pair |
| 10 | forced relay | Cloudflare ICE relay candidate confirmed | `cloudflare_route_state` with `relay_used=true` and `ice_type` reflecting TURN |
| 11 | provider outage | clear retry UX, grouped PostHog Issue, no mesh fallback | `cloudflare_conference_error` produces one deduplicated Error Tracking Issue (dedup key `call_id + transport + stage + generation`); confirm NO `conference_provider_selected` event with `decided_provider=disabled` silently followed by a raw P2P mesh join (`MeshRoom` telemetry) for the same session |
| 12 | LiveKit disabled | no LiveKit token, room, import, or provider event remains | HogQL below (§3, step 3) shows `count() = 0` for `conference_provider_selected` where `decided_provider = 'livekit'` over the observation window |

Do not check off row 12 from code inspection alone (e.g. "the flag is off, so
it must be zero") — confirm it live in PostHog, per the CLAUDE.md rule that an
effective flag/behavior claim must be read from production telemetry, not
inferred from source. The same discipline applies here to staging: read the
dashboard.

---

## 3. Cutover sequence (staging first, prod only on owner request)

1. **Verify Cloudflare acceptance.** All 12 rows in §2 pass on staging with the
   Phase 3 Flutter client. `cloudflareConferenceEnabled=true` and
   `CONF_TICKET_SECRET` set in staging (§1.1) are prerequisites, not part of
   this step.

2. **Set `livekitConferenceEnabled=false` in staging** — through the flag
   wrapper, never a raw KV write:

   ```bash
   scripts/flags.sh set livekitConferenceEnabled=false
   ```

   This is a delta write; it does not touch `cloudflareConferenceEnabled` or
   any other key. Confirm it landed with a cache-busted read (edge cache is
   60s — see CLAUDE.md's "four ways flags and deploys will lie to you"):

   ```bash
   scripts/flags.sh get livekitConferenceEnabled
   curl -s -H 'Cache-Control: no-cache' "https://<staging-api-host>/api/config?cb=$RANDOM"
   ```

3. **Verify zero LiveKit tokens issued** over a 48-hour staging observation
   window. HogQL against dashboard 845814 / the `conference_provider_selected`
   event:

   ```sql
   SELECT count() AS livekit_token_count
   FROM events
   WHERE event = 'conference_provider_selected'
     AND properties.decided_provider = 'livekit'
     AND timestamp > now() - INTERVAL 48 HOUR
   ```

   Expected: `livekit_token_count = 0`. With `livekitConferenceEnabled=false`,
   `issue()` in `conference.ts` returns `410` before ever calling `lkApi`
   (CreateRoom/ListParticipants) or minting an `lkToken`, and it still emits
   `conference_provider_selected` with `decision="rejected_disabled"` /
   `decided_provider="disabled"` on the way out — so a nonzero
   `decided_provider='livekit'` count in this window means either an
   un-updated client is hitting a *different*, stale code path, or the flag
   write didn't actually land (re-check with the cache-busted curl in step 2,
   and wait out the ~30–60s propagation window before concluding a flip
   failed).

   Also confirm the **negative-space** signal: no unexpected rise in raw P2P
   `MeshRoom` fallback telemetry for group calls in the same window (row 11 in
   §2) — a LiveKit-token count of zero is not proof of success if calls are
   silently mesh-falling-back instead.

4. **Prod flip — only on explicit owner request**, per CLAUDE.md's staging/prod
   rules (never inferred from `.avatok-target` or branch for a flag flip that
   affects live users; confirm environment with the owner first if not already
   stated). Same command shape, with `ALLOW_PROD=1`:

   ```bash
   ALLOW_PROD=1 scripts/flags.sh set livekitConferenceEnabled=false
   ```

   Then repeat step 3's HogQL query scoped to prod `app_release`s over the
   next 48 hours before considering LiveKit "off" in production.

---

## 4. CF-CALL-007 — LiveKit removal checklist (NOT executed now)

This section is a plan, not an action taken by this commit. Do not run any of
it until: (a) staging has run on the Cloudflare path for **two clean weeks**
with `livekitConferenceEnabled=false` and zero LiveKit tokens (§3), (b) a
rollback tag exists (§4.0), and (c) the owner explicitly authorizes removal.
Each numbered item below is its own commit — do not combine them, per the
"one issue per commit" git protocol (all should carry `[CF-CALL-007]` in the
message; use a suffix to keep them distinguishable in history if the wrapper
requires unique subjects, e.g. `[CF-CALL-007] Remove LiveKit issuance routes`).

**4.0 — Rollback tag first.** Before touching any removal commit, tag the
last-known-good commit where LiveKit code still exists and staging behavior is
proven (post the two-week clean window):

```bash
# on host, via Desktop Commander — not part of this commit's scope
git tag cf-call-007-rollback-point <commit-sha>
python3 scripts/git_safe_push.py CF-CALL-007 --dry-run   # confirm ownership before any real push
```

**4.1 — Remove `/api/conference/*` LiveKit issuance and webhook routes.**
`worker/src/routes/conference.ts` (`conferenceStart`, `conferenceJoin`,
`conferenceEnd`, `conferenceBeat`, `conferenceStatus`, `conferenceWebhook`, and
all the LiveKit-specific helpers: `regionsConfig`, `pickRegion`, `credsFor`,
`lkToken`, `lkApi`, `verifyLkJwt`) plus the route wiring in `worker/src/index.ts`.
Only after the retention window the proposal specifies for the webhook path
(so any in-flight LiveKit room events from before the flip have already
drained).

**4.2 — Remove `livekit_client` from `app/pubspec.yaml`** and re-run
`flutter pub get` (that step happens in CI, not locally — CLAUDE.md: no local
builds).

**4.3 — Remove `ConferenceScreen`, `ConferenceTelemetry`, `ConferenceApi`**
(the LiveKit-specific Flutter classes — find with Graphify
`graphify-avatok-2-flutter`, not grep, per the project's search convention) and
any remaining `livekit_client` import in the group-call path (Phase 3 already
required zero imports in the *new* code; this step removes the *old* code that
still has them).

**4.4 — Remove LiveKit secrets and wrangler vars.** `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_REGIONS` (`worker/src/types.ts`
`Env` interface entries + the corresponding `wrangler secret delete` per
environment, through `scripts/cf.sh`, e.g.
`scripts/cf.sh worker secret delete LIVEKIT_API_SECRET` staging,
`ALLOW_PROD=1 scripts/cf.sh worker secret delete LIVEKIT_API_SECRET` prod).

**4.5 — Remove region-routing code.** `regionKvKey`, `roomRegion`,
`conf_region:<groupId>` KV usage, `CONTINENT_REGION`, and the
`Specs/AVA-SFU-SELFHOST-PLAYBOOK.md` region-pin machinery that only existed to
route LiveKit rooms to self-hosted clusters — the Cloudflare Realtime path has
no equivalent multi-region pinning requirement per the proposal.

**4.6 — Rename Cloudflare-specific paths only after telemetry/dashboards are
migrated** (proposal Phase 4, item 7) — e.g. dropping the `cloudflare_`
prefix from event names or file names, if desired, is cosmetic and strictly
last, so dashboard 845814 and any saved HogQL keep resolving during the whole
removal sequence.

**4.7 — Delete the now-fully-superseded `groupAudioSfuEnabled` flag and the
audio-only `sfu_group_call_api.dart` client**, since by this point the Phase 3
CF A/V client fully replaces it — confirm no reference remains
(`DEFAULTS` in `worker/src/routes/config.ts`, `numericKeys` if applicable, and
the Flutter `RemoteConfig` getter) before deleting, per CLAUDE.md's rule that a
declared-but-unreferenced flag is fine to remove but a referenced-and-then-
undeclared one creates a fake flag in the other direction.

---

## 5. Rollback plan at every stage

- **During §2 (staging acceptance testing):** no rollback needed — LiveKit is
  still the default provider (`livekitConferenceEnabled` untouched); the
  Cloudflare path is additive and gated. If a Cloudflare test fails, just fix
  it; nothing user-facing changed.

- **After §3 step 2 (staging `livekitConferenceEnabled=false`):** immediate
  rollback is a single flag write:

  ```bash
  scripts/flags.sh set livekitConferenceEnabled=true
  ```

  This is instantaneous (subject to the ~60s edge cache — CLAUDE.md's
  propagation-window warning applies) and requires no deploy, no build, no
  code change. This is the primary reason the flag-based cutover (rather than
  removing code first) is the correct order.

- **After §3 step 4 (prod `livekitConferenceEnabled=false`):** same rollback,
  with `ALLOW_PROD=1 scripts/flags.sh set livekitConferenceEnabled=true`. Since
  no LiveKit code has been removed yet at this stage (removal is §4, gated
  separately), the rollback is guaranteed to work — the old code path still
  exists and is simply re-enabled.

- **During/after §4 (code removal commits):** this is why §4.0's rollback tag
  exists. If removal turns out to be premature (e.g. an edge case in the CF
  path surfaces after code deletion), `git revert` the specific `[CF-CALL-007]`
  removal commit(s) — since each is scoped to one concern (routes, pubspec,
  Flutter screens, secrets, region code), a partial revert is possible without
  reverting the whole batch. Re-adding a deleted Worker secret requires
  `wrangler secret put` again (the value itself is not recoverable from git —
  keep it in a password manager before `secret delete` in step 4.4, or accept
  that a full LiveKit revert also requires re-provisioning LiveKit credentials
  from the LiveKit account/console).

- **Non-negotiable across all stages:** never re-enable a P2P mesh fallback as
  an implicit rollback for a failed group SFU join (proposal rule #2) — the
  only sanctioned rollback path is re-enabling `livekitConferenceEnabled`
  (pre-§4) or reverting the specific removal commit (post-§4), always through
  `scripts/flags.sh` / `scripts/git_safe_push.py`, never a direct KV write or
  unreviewed force-push.
