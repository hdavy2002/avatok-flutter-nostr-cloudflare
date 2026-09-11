# Audit — paid-session waiting, media start and billing (2026-09-11)

Scope: production, read-only code audit at worker HEAD `47d04c28` / app build 10645
(shipped 2026-09-11). Rules the owner stated during this audit are in
**`Specs/RULEBOOK-PAID-SESSIONS.md`** — this file is the evidence and the plan.
Screenshots: `Specs/audit-2026-09-11-shots/` is NOT populated (Chrome captures could
not be written to the Mac); the visual map artifact holds them.

## Answers

- **Creator entry.** App: Marketplace → Customer Appointments
  (`app/lib/features/booking/creator_schedule_screen.dart`) → "Join appointment",
  enabled only inside the window (`commercialConsultJoinEarlyMin=10`,
  `commercialConsultJoinLateMin=2` in prod KV). Live: My Live Events → Start live
  (`commercialLiveBackstageEarlyMin=30`, `commercialLiveStartGraceMin=15`).
  Web: `/dashboard/consult` → `/session/:bookingId`; `/dashboard/live` →
  `/live/:listingId/host`.
- **Preflight** exists on app + web since `[SESSION-PREFLIGHT-1]` (camera preview,
  mic meter, speaker tone, network probe) and is in build 10645.
- **After preflight the client joins the GetStream call immediately** and shows
  `WAITING / Waiting for the other participant…` (`commercial_consult_screens.dart:296-299`).
- **No wallet deducts per minute.** Full price is escrowed at checkout; settlement
  is all-or-nothing after the session ends (`worker/src/commercial_settlement.ts`).
  GetStream participant-minutes are avaTOK's cost from the moment anyone joins.
- **Owner's pro-rata rules are not implemented.** `connected_ms` is stored on the
  receipt but does not change the amount.

## Critical defect — provider `session_ended` ends the booking

`recordCommercialStreamEvent` (`worker/src/routes/commercial_stream_sessions.ts`
~L1816-1830 and ~L1974-2000) treats `session_ended` / `call.ended` / `live_stopped`
as terminal for BOTH call types: it sets `commercial_sessions.state='ended'`, closes
all intervals and inserts settlement jobs. GetStream emits `call.session_ended` when
the last participant leaves. Consequences:

1. Creator joins at T-10, waits, backs out → session ended. Customer's later join is
   refused (`session_terminal`, 410). Settlement: creator time ≥ 60 s, no overlap →
   `buyer_no_show` → creator paid in full.
2. Customer joins early alone, leaves → session ended. Creator refused. Settlement:
   creator time < 60 s → `creator_no_show` → 100 % refund.
3. Live: host in backstage alone, drops → event completed, listing marked completed.

Fix (`[SESSION-CLOCK-0]`): provider events only close intervals. A session ends from
the schedule (`ends_at` + late grace, cron) or an explicit end route. Verify the
GetStream call is not *ended* (only session-ended) so a rejoin succeeds.

## Other defects

- Web `/session/:id` with an unknown id while signed in: stuck on "Checking your
  booking…" with the guest email form dimmed underneath (`ConsultRoomGS.bootstrap`
  awaiting `freshAppJwt()`); should show "booking not found".
- Web `/live/:id/host` asks for camera+mic before verifying the listing exists and
  the viewer owns it.
- In-room banner "N min remaining" counts to `ends_at` while WAITING (before start).
- Extension button shown although `commercialConsultExtensionEnabled=false`.
- ₹25 + 20 % fee (`session_pricing.ts`) still not wired into settlement (known).

## What exists / reuse / build

| Piece | Status | Where |
|---|---|---|
| Creator + customer schedule lists (app, web) | have | `creator_schedule_screen.dart`, `commercial_customer_screens.dart`, `/dashboard/*` |
| Preflight (cam/mic/speaker/network) | have | `commercial_device_check.dart`, `commercial_speaker_test.dart`, `consult-gs/PreJoin.tsx`, `live-gs/LiveGsHost.tsx` |
| Consult room, live backstage/broadcast/viewer | have | `commercial_consult_screens.dart`, `commercial_live_screens.dart`, `consult-gs/CallStage`, `live-gs/*` |
| Escrow, receipts, refunds, no-show sweeps | have | `commercial_checkout.ts`, `commercial_settlement.ts`, `commercial_lifecycle.ts` |
| Ring / cancel / ringback / CallKit incoming screen / glare | reuse | `stream_video_calls.ts` (`streamCallPlace`, `streamCallCancel`), `ringback_player.dart`, `push_service.dart`, `incoming_business_call_screen.dart` |
| Presence heartbeat | reuse | `routes/presence.ts` (`presenceBeat`) — add a session-scoped beat |
| Chat per session | reuse | GetStream Chat channel provisioned in `/join` (`commercialChatChannel`) |
| **Session Lobby** (meter, presence, chat, Call) | build | new `commercial_lobby_screen.dart`, `consult-gs/Lobby.tsx` |
| Slot clock + lobby intervals + ring-for-booking | build | new DO/cron + `…/clock`, `…/lobby/beat`, `…/ring` |
| Pro-rata settlement | build | `commercial_settlement.ts` |
| Live reconnect grace (10 min) + outage refunds | build | `commercial_stream_sessions.ts`, live screens |

## Plan

0. `[SESSION-CLOCK-0]` hotfix (above) + web `/session` hang + host authorization order.
1. `[SESSION-CLOCK-1]` clock authority (`GET …/clock`), `[SESSION-LOBBY-1]` lobby
   beats → `commercial_lobby_intervals`, `[SESSION-RING-1]` ring-for-booking reusing
   `streamCallPlace` with a `commercial_ring` push type; declare flags
   `sessionLobbyEnabled`, `liveHostGraceMin=10` in `config.ts` DEFAULTS.
2. `[SESSION-LOBBY-APP-1]` / `[SESSION-LOBBY-WEB-1]` Lobby screens, paid incoming
   call variant, remove in-room waiting state, lobby-entry push.
3. `[SETTLE-PRORATA-1]` `delivered_ms` = creator (lobby ∪ call) ∩ slot; charged =
   gross × delivered/slot; refund remainder; wire `sessionFeeFor`; receipts show
   slot / delivered / charged / refunded.
4. `[LIVE-GRACE-1]` host-left → `reconnecting` + 10-min alarm + push; outage
   intervals; L4/L5 maths.
5. Two-phone acceptance matrix with pre-written receipt expectations; ship it;
   confirm `latestAppBuild`; count persons on the build.

Open owner questions: rulebook §6.

---

## Addendum (same day) — the waiting-room model is already 70 % built

The owner recalled a waiting room (creator avatar + "waiting…" + own preview, no
GetStream minutes, auto-connect when the other party came online). It exists: the
retired **Phase-7 AvaConsult lane**. Everything except its media is deployed today.

| Piece | Where | State |
|---|---|---|
| Session clock + waiting-room socket | `worker/src/do/stream_session.ts` (`StreamSessionDO`, instance `consult:<bookingId>`): hibernatable WS, `welcome {starts_at, ends_at}`, `presence {role, joined}`, attendance → D1 `session_attendance` | deployed, bound (`STREAM_SESSION_DO`) |
| Alarms | `op: "schedule"` arms `starts_at + wait_min (20)` → `money_noshow` and `ends_at + 2 min` → `money_end`, both → `Q_MONEY` | deployed; **not armed by commercial checkout** |
| Room auth route | `GET /api/consult/:id/room?token=` (`routes/consult.ts:consultRoom`, `signSessionToken`) | routed in `index.ts:1704` |
| Rules engine | `worker/src/rules.ts` (pure, tested in `test/refund_rules.test.ts`): R1 creator no-show 20 min → 100 % refund + strike; R2 buyer no-show → creator paid **pro-rata for the wait** (must become 100 %); R3 completed → 80/20; R4–R7 | deployed; params in D1 `refund_rules` |
| Executor | `worker/src/money_engine.ts` via `Q_MONEY` — legacy WalletDO `refund`/`release` primitives, **not** the commercial escrow accounts | deployed; wrong ledger for commercial orders |
| App waiting room UI | `app/lib/features/consult/consult_room_screen.dart` (`_waitingRoom`, "Waiting for the host to join…", host sees "12:43 left of 20:00 wait", countdown, 5-min warning, auto-end at end + 2) | present; media (P2P `CallRoom` DO / SFU) dead since build 10612 |
| Web waiting room UI | `web/src/islands/consult/{ConsultRoom,RoomSocket,Countdown,PreJoin}.tsx` at legacy `/consult/:booking` | present; same dead media |
| Commercial bookings row | `commercial_checkout.ts:1097` inserts `bookings` (`kind='consult_1to1'`, `status='confirmed'`) + calendar events, so the DO/legacy join can find them | present |

### Recommended build (replaces the ring/answer lobby plan above)

0. **Hotfix `[SESSION-CLOCK-0]`** unchanged: provider `session_ended` closes
   intervals only. Fix web `/session` hang and host green-room auth order.
1. **`[WAITROOM-1]` (worker)** — `commercialConsultPrejoin` also returns
   `room_ws` + `room_token` (reuse `signSessionToken`) for `consult:<bookingId>`,
   and calls `sessionOp(schedule)` with `wait_min` from a new declared flag
   `sessionCreatorCheckInMin=20`. `consultRoom` accepts commercial booking ids
   (`[A-Za-z0-9-]{1,96}`).
2. **`[WAITROOM-APP-1]` / `[WAITROOM-WEB-1]`** — a `CommercialWaitingRoom` screen
   lifted from the legacy waiting state: creator/customer avatar, "Waiting for X…",
   local preview (already produced by preflight), meter from `welcome`, chat. On
   `presence` of the other role → existing commercial `/join` → existing GetStream
   room. Leaving the room returns to the waiting room; the slot keeps running.
   Retire the in-room "Waiting for the other participant…" state.
3. **`[SETTLE-CHECKIN-1]`** — `commercial_settlement.ts` decides on **creator
   check-in** (`session_attendance` host row with `joined_at ≤ starts_at + 20 min`,
   or a GetStream host interval in that window): checked in → settle full; not →
   `creator_no_show` refund + strike. Remove the two-party-overlap requirement. Wire
   the DO's `money_noshow`/`money_end` alarms to enqueue the commercial settlement
   job for commercial orders (or have `money_engine` delegate) — one executor per
   order, never both. Set legacy `R2` params to full pay so the two engines agree.
4. **`[LIVE-GRACE-1]`** unchanged (10-min reconnect grace). Note the DO already
   tracks `host_live` and R7 (≥5 min downtime → full refund) exists; align the
   numbers with the rulebook §4.
5. Two-phone acceptance: on time / customer 25 min late / creator 15 min late /
   creator 25 min late / customer never / creator leaves and returns / both late.
