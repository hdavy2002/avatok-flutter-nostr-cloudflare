# BUILD PLAN — Paid-session waiting room (owner-authorised 2026-09-11, production)

Rules: `Specs/RULEBOOK-PAID-SESSIONS.md` (v2). Evidence: `Specs/AUDIT-2026-09-11-PAID-SESSION-WAITING-AND-BILLING.md`.
Coordinator: Claude (this session). Coders: Sonnet agents, one work package (WP) each.
Reviewers: Opus agents. Deploy: a Sonnet agent, after review.

## Ground rules for every agent (read fully)

1. Repo on the Mac: `/Users/davy/Documents/websites/avaTOK-2-Flutter` (branch `main`,
   `.avatok-target=prod`). Reach it with `mcp__remote-devices__device_bash`
   (mounted at `$HOME/mnt/avaTOK-2-Flutter`, use it for reading/editing with sed/python
   read-modify-write) and `mcp__remote-devices__Desktop_Commander__start_process`
   (runs on the Mac host — use it for `git`, `npm`, `npx tsc`, `gh`). Load both with
   ToolSearch `select:mcp__remote-devices__device_bash,mcp__remote-devices__Desktop_Commander__start_process,mcp__remote-devices__Desktop_Commander__read_process_output`.
2. Read `CLAUDE.md` sections: Git protocol, "Four ways flags and deploys will lie",
   Tooling (no local Flutter — read your Dart diff carefully; CI is the compile net),
   Design-system guard (no raw colours, Phosphor icons), Observability (PostHog on
   every new screen/path), and the PAID-SESSION RULEBOOK section.
3. **Touch only the files your WP owns.** If you need a change in another WP's file,
   write the exact snippet in your final report instead; the coordinator applies it.
4. Commit ONLY via `python3 scripts/git_safe_commit.py "[WP-ID] message" <explicit paths>`
   run through Desktop_Commander on the host. Never `git add/commit/push` directly.
   Never push. Never deploy. Never run `gh workflow run`. Never touch `wrangler`.
5. No D1 schema change unless unavoidable; if unavoidable, add a migration file under
   `worker/migrations/` (CREATE in its own file; ALTERs separate) and say so loudly in
   your report. Do not apply it.
6. Worker/web: run `npx tsc --noEmit` (worker/, web/) and the relevant vitest files
   before committing. App: no analyzer exists — self-review the diff; check every
   symbol you call exists (grep), keep `PhosphorIcons.*`, `AD.*` tokens, `scopedKey`.
7. Telemetry: every new screen/path emits events with `email` + stable ids
   (`Analytics.capture` / `commercialEvent` / web `capture`). Add them to
   `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` (append a WP section; append-only).
8. Final report (≤ 40 lines): files changed, commit sha(s), what you verified, what
   you could not verify, snippets for other WPs, open risks.

## Contracts shared by all WPs (do not deviate)

- **Flag** `sessionCreatorCheckInMin` (number, default 20) declared in `config.ts`
  `PlatformConfig` + `DEFAULTS` + `numericKeys`. `commercialConsultJoinLateMin` (2)
  stays the end grace. `liveHostGraceMin` (number, default 10) same treatment.
- **Prejoin response** (`GET /api/commercial/consult/:bookingId/prejoin`) gains:
  `room_ws` (wss URL `…/api/consult/<bookingId>/room?token=<room_token>`),
  `room_token`, `starts_at`, `ends_at`, `check_in_by` (= starts_at + flag·60000),
  `counterparty: { name, avatar_url }`, `role: 'creator'|'buyer'`.
- **Waiting-room socket** = existing `StreamSessionDO` WS. Messages the client relies
  on: `welcome {starts_at, ends_at, host_live}`, `presence {uid, role:'host'|'attendee', joined:boolean}`,
  `session_ended`. New (WP2): `roster {host:boolean, attendee:boolean}` sent on welcome
  and on every presence change, and `chat {from, text, at}` relayed (≤ 500 chars).
- **Auto-join rule (clients):** call the existing `/join` when `roster.host && roster.attendee`
  (both present). On leaving the GetStream room, return to the waiting room and keep
  the socket. Meter = `welcome.starts_at/ends_at`, never local join time.
- **Check-in evidence:** DO writes `session_attendance` rows (already does). Settlement
  treats the creator as checked in if a `session_attendance` row with
  `role='host' AND joined_at <= starts_at + check_in_ms` exists OR a
  `commercial_participant_intervals` host interval starts in that window.
- **Consult session end:** ONLY the cron (`ends_at + commercialConsultJoinLateMin`)
  or `POST …/consult/:id/end` marks `commercial_sessions.state='ended'` and inserts
  settlement jobs. Provider `session_ended` only closes open intervals.
- **Live reconnect (server → clients):** `GET /api/commercial/live/:id/state` may return
  `state:'reconnecting'`, `reconnect_deadline_ms`. Push type `commercial_reconnect`
  (host) with `{listing_id}`; viewers poll state every 5 s as today.
- **Receipt meta** gains `rule: 'creator_checked_in'|'creator_no_show'`, `checked_in_at`.

## Work packages — wave 1 (parallel)

| WP | Owner files | Deliverable |
|---|---|---|
| **WP1 [SESSION-CLOCK-0]** worker | `worker/src/routes/commercial_stream_sessions.ts` (whole file), cron wiring in `worker/src/index.ts` scheduled handler (add one call only) + a new `worker/src/lib/commercial_session_clock.ts` | (a) `recordCommercialStreamEvent`: for `avatok_consult_1to1`, `session_ended`/`call.ended` close intervals only; do NOT set ended / insert jobs. (b) new `endDueConsultSessions(env)` in the lib: sessions `kind='consult_1to1'`, state not ended/cancelled, `scheduled_at + duration + late grace <= now` → `state='ended'`, close intervals, insert settlement jobs (same SQL as today's terminal branch), `consumeCommercialEntitlementsOnSessionEnd`. Register in the 5-min cron. (c) `commercialConsultPrejoin`: return the new fields by calling `buildWaitingRoomGrant()` from WP2's lib (import from `../lib/commercial_waiting_room` — WP2 creates it; until then stub the import shape given below). (d) `authorizeProviderJoin`: allow rejoin — if the GetStream call reports ended, recreate it (`createProviderCall` on 404/ended). Tests: `worker/test/commercial_session_clock.test.ts`. |
| **WP2 [WAITROOM-1]** worker | new `worker/src/lib/commercial_waiting_room.ts`, `worker/src/do/stream_session.ts`, `worker/src/routes/consult.ts`, `worker/src/routes/config.ts` (flags only), `worker/src/index.ts` (regex for `/api/consult/…/room` to accept `[A-Za-z0-9-]{1,96}` — one line) | `buildWaitingRoomGrant(env, {bookingId, uid, role, name, startsAt, endsAt, creatorId})` → `{room_ws, room_token, check_in_by}`: signs `signSessionToken` (role `host`/`attendee`), calls DO `schedule` with `wait_min` from `sessionCreatorCheckInMin`. DO: add `roster` + `chat` messages, make `schedule` idempotent for re-arm, make the `money_noshow`/`money_end` alarms a NO-OP for commercial bookings (bookings.kind='consult_1to1' — read via a `commercial` flag in the schedule op) so only the commercial settlement moves money. Tests for the DO message shapes. |
| **WP3 [SETTLE-CHECKIN-1]** worker | `worker/src/commercial_settlement.ts`, `worker/src/money_engine.ts` (delegation guard only), `worker/src/rules.ts` (R2 param default → full pay), `worker/test/*settlement*` | Replace the two-party-overlap decision with the check-in decision (contract above). Checked in → settle full (existing release path). Not → `creator_no_show` refund + strike (reuse existing refund path; strike via existing `account_strikes` insert pattern from money_engine). `loadOverdueNoShowAuthorities` uses `starts_at + check_in_ms`. Receipt meta gains `rule`, `checked_in_at`. `money_engine`: if the booking is commercial (`bookings.kind='consult_1to1'`), return noop. Wire `sessionFeeFor` (`lib/session_pricing.ts`) into the release split ONLY if it is a pure function of gross+duration; otherwise report and skip. |
| **WP4 [WAITROOM-WEB-1]** web | `web/src/islands/consult-gs/**`, new `web/src/islands/consult-gs/WaitingRoom.tsx`, `web/src/lib/commercial*.ts` (API client), `web/src/pages/session/[booking].astro` | Phase machine: loading → prejoin (exists) → **waiting** (new: counterparty avatar+name, "Waiting for X…", own preview, meter from starts_at/ends_at, chat, creator line "You're checked in ✓"/"Check in by 12:20", Leave) → joining → live (CallStage) → back to waiting on leave → ended/receipt at ends_at. Socket via a copy of `islands/consult/RoomSocket.ts` adapted to the new URL. Fix the bootstrap hang: `freshAppJwt()` must resolve or reject within 10 s; unknown booking → "Booking not found". No-show message when `check_in_by` passes without the host. PostHog: `waitroom_enter`, `waitroom_autojoin`, `waitroom_noshow_shown`. |
| **WP5 [LIVE-GRACE-WEB-1]** web | `web/src/islands/live-gs/**`, `web/src/pages/live/**` | Host page: authorise (`/prepare-host` or state) BEFORE requesting devices; "Rejoin your live" path when state is `reconnecting`. Viewer: overlay "Creator reconnecting · mm:ss" from `reconnect_deadline_ms`; keep the seat; show refund line if state becomes ended with `outcome:'host_no_return'`. PostHog events. |
| **WP6 [WAITROOM-APP-1]** app | new `app/lib/features/commercial_getstream/commercial_waiting_room_screen.dart`, `app/lib/features/commercial_getstream/commercial_consult_screens.dart`, new `app/lib/core/commercial_waiting_room_api.dart` (WS + prejoin fields) | Lift the waiting state from `features/consult/consult_room_screen.dart` (NO P2P/SFU code): avatar, "Waiting for X…", own preview (reuse preflight preview widget), meter, chat, creator check-in line, Leave. Prejoin → waiting room → auto `/join` when roster both → existing `CommercialConsultationRoomScreen`; Leave → back to waiting room (keep socket); at ends_at → completion. Remove the in-room "Waiting for the other participant…" state. `scopedKey` for any prefs. Analytics events as WP4. Design guard clean. |
| **WP7 [LIVE-GRACE-APP-1]** app | `app/lib/features/commercial_getstream/commercial_live_screens.dart`, `commercial_live_gateway.dart`, `app/lib/push/push_service.dart` (commercial branch only) | Host: on SDK disconnect show "Reconnecting…" banner with deadline; handle push `commercial_reconnect` → open Backstage on same listing; "Rejoin" button. Viewer: overlay "Creator reconnecting · mm:ss"; on `host_no_return` show refund line. Cap backstage at the window (timer). Analytics. |

## Wave 2 (after wave 1 review)

| WP | Owner files | Deliverable |
|---|---|---|
| **WP8 [LIVE-GRACE-1]** worker | `commercial_stream_sessions.ts` (live branches), `do/stream_session.ts` (alarm kind `live_grace`), new `worker/src/lib/live_grace.ts`, settlement live branch | Host `participant_left` while live → `state='reconnecting'`, `reconnect_deadline_ms = now + liveHostGraceMin`, DO alarm, push `commercial_reconnect`. Host rejoin → back to `live`, outage interval recorded. Alarm → end with `outcome:'host_no_return'`; per-ticket refund of unconsumed minutes (gross × (slot − watched_eligible)/slot; outage minutes excluded). |
| **WP9 [SESSION-QA-1]** | `tool/ship_manifest.json`, `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md`, tests | Manifest entries for every WP id with success assertions; catalog sections; run `python3 tool/check_ship_readiness.py --check all` and `tool/check_design_guard.py --check all`; fix what they flag inside your own files or report. |
| **WP10 [DEPLOY]** | none | After reviewers sign off: `cd worker && npx tsc --noEmit && npx vitest run`; commit check (nothing uncommitted in worker/ web/); `ALLOW_PROD=1 scripts/cf.sh worker deploy` (say plainly it is production); apply any migration with `scripts/cf.sh worker d1 execute DB_META --remote --file=…` only after the coordinator confirms; `flags.sh get` then ONE `ALLOW_PROD=1 scripts/flags.sh set sessionCreatorCheckInMin=20 liveHostGraceMin=10` and confirm after 60 s cache-busted; `gh workflow run web-deploy.yml --ref main`; verify the live URLs render; report. App build is NOT part of this — the owner says "ship it" separately. |

## Decision taken by the coordinator (rulebook §6 q5)
Creator waits in the DO room by default; media opens only when both are present.

---

## Addendum 2026-09-12 — app-only transmission (owner decision, rulebook §7)

Owner decision: **all transmission is from the app.** Creators start live events
and 1:1s only in the Flutter app; the browser is customer-only (view, listen,
talk, chat, upload). This does not change wave-1/wave-2 WPs above; it adds a
concurrent set of work packages that retire the browser creator path and build
the customer-side chat/attachment surface. Rulebook: `Specs/RULEBOOK-PAID-SESSIONS.md`
§7. CLAUDE.md PAID-SESSION RULEBOOK section, rule 4.

Shared message contract (worker DO ↔ web ↔ app, all lanes):

```
{ type: 'chat', from, uid, text, at, attachment?: { url, name, size, mime } }
```

- `attachment` is optional; when present it is ≤ 1 KB of JSON (url/name/size/mime
  only — never the file bytes) riding the same DO/Stream Chat socket as plain chat.
- File cap: 25 MB per upload. Accepted `mime`: images (`image/*`), `application/pdf`,
  and common doc types (`application/msword`,
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, plain
  text). Anything else is rejected client-side and server-side.
- The file itself is never inlined on the socket — it is uploaded out-of-band (R2
  via the worker) and only the resulting `attachment` descriptor is relayed as a
  chat message.

Work packages (concurrent, wave "APP-ONLY-TX"):

| WP | Owner files | Deliverable |
|---|---|---|
| **S2 [APP-ONLY-TX-WEB-HOST-1]** web | `web/src/islands/live-gs/LiveGsHost.tsx` (unmount, do not delete), `web/src/pages/live/[id]/host.astro`, `web/src/islands/dashboard/*`, `web/src/islands/consult-gs/ConsultRoomGS.tsx` | Retire every browser creator-hosting surface: host page and dashboard copy now say "Start this event/session from the avaTOK app" with a deep link (`web/src/components/StartInApp.tsx`); no `getUserMedia` reachable from a creator's browser session. `LiveGsHost.tsx` stays on disk, unmounted, as reference only. Telemetry: `web_creator_redirected_to_app {listing_id\|booking_id, role}`. |
| **S3 [APP-ONLY-TX-WORKER-RELAY-1]** worker | `worker/src/do/stream_session.ts`, new attachment upload route (R2-backed) | DO relays `chat` messages including the optional `attachment` descriptor to all connected sockets; a new authenticated route accepts a guest (email-verified, paid, no account) upload up to 25 MB, stores it in R2, returns `{url, name, size, mime}` for the client to attach to its next chat message. Enforces the mime allowlist and size cap server-side regardless of what the client sent. |
| **S4 [APP-ONLY-TX-WEB-CHAT-1]** web | `web/src/islands/consult-gs/SessionChat.tsx`, `web/src/lib/sessionUpload.ts`, `web/src/islands/consult-gs/{CallStage,WaitingRoom,RoomSocket}.tsx`, `web/src/islands/live-gs/{GsChat,LiveStage,LiveGsViewer}.tsx` | Customer-side chat panel beside the video/waiting state; drag-drop or picker upload flowing through S3's route, rendered as a chat bubble with a file/image preview once the `attachment` descriptor comes back over the socket. Telemetry: `session_chat_attachment_sent {booking_id\|listing_id, role, mime, bytes}`. |
| **S5 [APP-ONLY-TX-APP-CHAT-1]** app | `app/lib/features/commercial_getstream/**`, chat widget under `consult`/`live` screens | Renders the same `attachment` descriptor (image thumbnail, file chip with name/size for others) inside the existing in-app chat, and can send its own attachments through S3's upload route so a creator can share files back. No behavioural change to who may transmit media — this is chat/file only. |

All four WPs commit under the ground rules already in force above (own-files-only,
`scripts/git_safe_commit.py`, no push). Telemetry entries land in
`Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` under `## APP-ONLY-TX`.

