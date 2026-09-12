# RULEBOOK — Paid sessions (1:1 consultations + live events)

**Status: owner rules, stated 2026-09-11. READ BEFORE touching anything under
`worker/src/routes/commercial_*`, `worker/src/commercial_settlement.ts`,
`app/lib/features/commercial_getstream/`, `app/lib/features/booking/`,
`web/src/islands/consult-gs/`, `web/src/islands/live-gs/`, or any call entry point.**

This file is the single place where the customer-side and creator-side rules for
paid sessions live. Code implements these rules; it does not invent them. When a
rule here and the code disagree, the code is wrong until the owner changes this
file. Add a dated line to the *Changes* section at the bottom for every edit.

Legend: **[RULE]** = owner decision. **[TODAY]** = what the shipped code does as of
2026-09-11 (build 10645 / worker HEAD 47d04c28), kept so nobody assumes a rule is
already implemented. **[OPEN]** = needs the owner's answer before it is built.

---

## 0. Vocabulary

- **Slot** — the booked window `[starts_at, ends_at]` on the listing/booking. For a
  1-hour consult the slot is 60 minutes. The slot is the billing unit.
- **Lobby** — the screen both parties sit on during the slot *without* any
  audio/video flowing. Shows the meter, the other party's presence, chat, and a
  Call button. (To be built — see §3.)
- **Call** — the GetStream media session. It starts only when one party rings and
  the other answers. GetStream bills avaTOK per participant-minute, so a call that
  is open with one person waiting in it is pure cost.
- **Meter** — the countdown both parties see: time until the slot starts, then time
  left in the slot.
- **Available** — a party counts as available for a minute of the slot if they were
  in the Lobby (server heartbeat) or in the Call during that minute.

---

## 1. Money basics (unchanged)

- **[RULE]** The customer pays the full listing price at checkout; the tokens sit in
  escrow until settlement. Nothing is deducted per minute from either wallet while
  a session runs. The creator is never charged for a session.
- **[RULE]** GetStream minutes are avaTOK's cost, never the user's. That is exactly
  why nobody may open media before both parties are actually present (§3).
- **[TODAY]** Prepaid + escrow + settle-on-end is implemented
  (`commercial_checkout.ts`, `commercial_settlement.ts`). Settlement is all-or-
  nothing: creator paid in full, or 100% refund. **No pro-rata exists yet.**

---

## 2. 1:1 consultation — who pays for what (owner decision 2026-09-11, v2)

**The slot is reserved and prepaid. The meter runs from `starts_at` to `ends_at`
whether or not anybody is present.** There are only two money outcomes:

| # | Situation | Customer pays | Creator receives |
|---|---|---|---|
| C1 | Creator **checked in within 20 min** of `starts_at` (`sessionCreatorCheckInMin`, default 20) | **Full price** — whenever the customer joins, or even if he never joins. Late is his loss; the time was reserved for him. | Full share (80/20 split; ₹25+20% fee rule when wired) |
| C2 | Creator **did not check in within 20 min** | **Nothing — 100% refund.** The session is *abandoned*. | Nothing, and a strike (existing R1 behaviour) |
| C3 | Creator cancels beforehand | 100% refund | Nothing + strike (existing) |
| C4 | Platform failure (avaTOK/GetStream down ≥ N min) | 100% refund, no fee (existing R7) | Nothing |

- **[RULE] "Checked in"** = the creator's device is connected to the session's
  waiting-room socket (StreamSessionDO presence) **or** inside the GetStream call.
  Evidence is `session_attendance` (DO) plus `commercial_participant_intervals`
  (GetStream webhooks). The phone never decides.
- **[RULE] Both late** → both see how much of the slot has already passed and use
  whatever is left. Nothing changes in the money.
- **[RULE] Creator's own GetStream minutes while waiting are covered by the
  price.** He may enter the call at the designated time and wait there. (See §3
  for the cheaper default.)
- **[RULE] No pro-rata.** The owner withdrew the earlier "creator late → customer
  pays only delivered minutes" idea on 2026-09-11; it is NOT to be built. A creator
  who checks in late but inside 20 min is C1.

**[TODAY]** The commercial lane pays full only if the two parties overlapped in
GetStream ≥ 60 s, refunds if the creator's GetStream time < 60 s, and calls
everything else "buyer no-show". No 20-minute check-in rule, no DO evidence. The
legacy Phase-7 engine (`worker/src/rules.ts`, `money_engine.ts`) already encodes
R1 (creator no-show 20 min → refund + strike) but its R2 pays the creator only
pro-rata for the wait — that param must become "full" to match C1.

---

## 3. 1:1 consultation — the waiting-room model (replaces the ring/answer lobby)

This is how the retired Phase-7 AvaConsult room worked and it is what the owner
wants back, with GetStream as the media:

- **[RULE] Waiting room, not a media room.** Opening the appointment (after
  preflight) connects the device to the session's Durable Object socket
  (`StreamSessionDO`, instance `consult:<bookingId>`, route
  `GET /api/consult/:id/room`). The customer sees the **creator's profile image**,
  "Waiting for <creator>…", his **own local camera preview**, and the **meter**
  (countdown to start, then time left). **No GetStream participant is created**,
  so waiting costs nothing.
- **[RULE] Auto-connect on presence.** When the DO reports the *other* party
  present (`presence {role, joined:true}`), the client calls the existing
  commercial `/join` and enters the GetStream room. Default: **both** wait in the
  DO room and both auto-join when both are present (cheapest, and it avoids the
  provider `session_ended` trap). The owner also allows the creator to enter the
  call directly at `starts_at` and wait there; that is a client option, not a rule.
- **[RULE] The creator waits in the DO room by default** — §6 question 5, decided by
  the coordinator on 2026-09-11 (`Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md`,
  "Decision taken by the coordinator"). Media opens only when both parties are
  present. Entering the GetStream call at `starts_at` and waiting there remains
  available to the creator (his minutes are covered by the price, §2), but it is a
  client option he chooses, never the default and never something code does for him.
- **[RULE] The meter starts at `starts_at`** on every screen, from the DO's
  `welcome {starts_at, ends_at}` — never from "when I joined".
- **[RULE] The DO's alarms are the clock authority**: `starts_at + 20 min` →
  creator check-in test (C1/C2); `ends_at + 2 min` → settle. The minute cron is
  the safety net. A leave, a crash or a provider webhook never ends the slot.
- **[RULE]** Chat in the waiting room reuses the same socket (the DO already
  carries messages/reactions) or the per-session Stream Chat channel; either is
  fine, pick one.
- **[RULE] The customer's browser session carries a side chat with file
  uploads.** Alongside his own preview and the "Waiting for <creator>…" / live
  video state, the customer's browser shows a chat panel next to the video that
  accepts file attachments (see §7). This is the same session chat, not a
  separate feature — it dies with the session and never becomes standing
  buyer↔creator messaging (`web-has-no-messaging` still stands).

**[TODAY]** The commercial lane never arms the DO (`op: "schedule"` is called only
by the legacy `/api/consult/:id/join` and legacy `listings/:id/join`). The legacy
waiting-room UI still exists in `app/lib/features/consult/consult_room_screen.dart`
(`_waitingRoom`, countdown, 5-min warning, auto-end at end+2) and
`web/src/islands/consult/{ConsultRoom,RoomSocket,Countdown}.tsx`; only its media
(P2P/SFU over Cloudflare) is dead.

---

## 4. Live events — who pays for what

| # | Situation | Ticket holder | Creator |
|---|---|---|---|
| L1 | Creator starts on time, viewer watches | Full ticket | Full share |
| L2 | **Viewer joins late** or never | **Full ticket** — no refund | Full share |
| L3 | Creator starts late | Full ticket **[OPEN]** — or pro-rata like C3? | — |
| L4 | **Creator drops mid-stream** and returns within **10 minutes** | The outage minutes are **not charged**: they are refunded pro-rata to everyone who was waiting | Share of delivered minutes |
| L5 | Creator drops and does **not** return within 10 minutes | Event ends. Viewers are refunded the **unconsumed** part pro-rata (what they watched is charged) | Share of delivered minutes |
| L6 | Creator never goes live | 100% refund | Nothing |

- **[RULE]** The stream starts when the creator presses Start live. Viewers may
  join whenever they like inside the window; the event does not wait for them.
- **[RULE]** On a creator disconnect the event goes to **"Reconnecting"**, viewers
  keep their seat, a 10-minute grace timer is shown to everyone, and the creator
  gets a push + an in-app banner to rejoin. Rejoin uses the same call id; no new
  event is created.
- **[TODAY]** No grace period and no pro-rata. A host drop is not special-cased
  anywhere; if the last participant leaves the call, `session_ended` ends the event
  for good and the listing is marked completed.

---

## 5. What must NOT be done

- Never start GetStream media because someone *opened a screen*. Media starts on
  **answer**.
- Never let a provider event (`call.session_ended`, `call.ended`) decide the
  billing outcome of a slot. Provider events close *intervals*; the **schedule**
  closes *sessions*.
- Never compute money on the phone or in the browser. The client shows the server's
  numbers.
- Never re-enable Messenger calling (`messengerCallingEnabled`). The paid lane does
  not ring anybody; it auto-connects on waiting-room presence (§3).
- Never revive the Phase-7 P2P/SFU media (`CallRoom` DO, Cloudflare Realtime) —
  only its waiting room, DO clock and attendance evidence come back. Media is
  GetStream, always.
- Never run two settlement engines on one order. `commercial_settlement.ts` owns
  commercial orders; the legacy `money_engine.ts` may *decide* only if it delegates
  the money movement to the commercial executor.
- Never add a Cloudflare media fallback. Fail closed (pivot spec §1).
- **Never build or resurface a browser hosting / green-room / backstage for
  creators** — `/live/:id/host` and `LiveGsHost.tsx` are retired (kept on disk,
  unmounted). No "host from your browser", no creator-side `getUserMedia` on the
  website. All transmission is from the app (§7). A creator-facing button on the
  web may only deep-link into the app.

---

## 6. Open questions for the owner

1. ~~Minute rounding~~ — withdrawn, no pro-rata.
2. L3: creator starts a live event late — full ticket, or pro-rata like a consult?
3. Late grace after `ends_at` for consults today is 2 min (`commercialConsultJoinLateMin`).
   Keep? The meter must show the same number.
4. ~~Both in lobby, nobody rang~~ — withdrawn; C1 applies (creator checked in → full charge).
5. ~~Creator waits in the DO room, or in the GetStream call?~~ — withdrawn
   2026-09-11: decided by the coordinator (DO room by default), now a [RULE] in §3.

---

## 7. Where transmission happens (owner decision 2026-09-12)

**ALL transmission is from the app.** This is the rule the other sections assume.

- **[RULE] Creators transmit only from the avaTOK app** — both lanes. A live event
  is started from the app; a 1:1 consultation is joined and run from the app. There
  is no browser path for a creator to publish audio or video, and none may be built.
- **[RULE] The browser is customer-only.** A customer in a browser may: see and hear
  the creator, be seen and heard himself, chat, and upload a file into that chat.
  Nothing else. The web client never requests a camera or microphone on behalf of a
  creator.
- **[RULE] A customer needs a verified email and a payment — nothing more.** He
  clicks the link in his confirmation email, a browser opens on phone, iPad or
  desktop, he is asked for camera/mic permission, sees his own preview on one side
  and either "Waiting for <creator> to join…" or the creator's video and voice once
  the creator is live, with a chat panel beside it that accepts file uploads.
  **He never logs into a dashboard and never needs an avaTOK account.**
- **[RULE] Paying is not onboarding.** Email-verified + paid does **not** make
  someone an onboarded avaTOK user. Onboarding — terms, permissions, the AvaTOK
  number, the full profile — happens **only in the app**
  (see project memory `web-signs-up-app-onboards`).
- **[RULE] In-session chat is not web messaging.** The chat panel inside a paid
  session (and its file upload) is part of the session the customer paid for. It is
  *not* the buyer→creator messenger that `web-has-no-messaging` forbids: that note
  bans a general "ask the host" message box on public listing pages, which still
  stands. Session chat lives only inside a live/booked session, dies with it, and
  rides the session's own `StreamSessionDO` socket (§3).
- **[TODAY → removed 2026-09-12, `[APP-ONLY-TX-1]`]** The browser used to carry a
  full creator console at `/live/:id/host` (`web/src/islands/live-gs/LiveGsHost.tsx`:
  camera permission, "Creator green room", "Enter private backstage", Start live),
  the dashboard said "Host your paid broadcasts from the browser", and
  `ConsultRoomGS` put a creator straight into the waiting room and the call. All of
  that is retired: those surfaces now show "Start this event/session from the avaTOK
  app" with a deep link. `LiveGsHost.tsx` stays on disk, unmounted, as reference
  only.

## Changes

- 2026-09-11 — created from the owner's rules stated in the session-pipeline audit.
- 2026-09-11 (v2) — owner replaced the pro-rata/ring-answer model with the prepaid waiting-room model: full price once the creator checks in within 20 min, full refund otherwise; media auto-connects on DO presence. §2 and §3 rewritten; §6 questions 1 and 4 withdrawn.
- 2026-09-11 (v3) — §6 question 5 answered by the coordinator and recorded in §3 as a [RULE]: the creator waits in the DO room by default and media opens only when both parties are present; waiting inside the call stays a creator-side option. Question 5 struck from §6.
- 2026-09-12 (v4) — owner decision "ALL transmission is from the app" recorded as a new §7: creators transmit only from the app (live + 1:1); the browser is customer-only (view, listen, talk, chat, upload); a customer needs only a verified email + payment, never an account or a dashboard; onboarding is app-only. §5 gains a matching prohibition on browser hosting/green-room/backstage surfaces. Shipped as `[APP-ONLY-TX-1]`.
