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
- **[RULE] The meter starts at `starts_at`** on every screen, from the DO's
  `welcome {starts_at, ends_at}` — never from "when I joined".
- **[RULE] The DO's alarms are the clock authority**: `starts_at + 20 min` →
  creator check-in test (C1/C2); `ends_at + 2 min` → settle. The minute cron is
  the safety net. A leave, a crash or a provider webhook never ends the slot.
- **[RULE]** Chat in the waiting room reuses the same socket (the DO already
  carries messages/reactions) or the per-session Stream Chat channel; either is
  fine, pick one.

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

---

## 6. Open questions for the owner

1. ~~Minute rounding~~ — withdrawn, no pro-rata.
2. L3: creator starts a live event late — full ticket, or pro-rata like a consult?
3. Late grace after `ends_at` for consults today is 2 min (`commercialConsultJoinLateMin`).
   Keep? The meter must show the same number.
4. ~~Both in lobby, nobody rang~~ — withdrawn; C1 applies (creator checked in → full charge).
5. Should the creator wait in the DO room (free) by default, or enter the GetStream
   call at `starts_at` and wait there (his minutes covered)? Suggested: DO room.

## Changes

- 2026-09-11 — created from the owner's rules stated in the session-pipeline audit.
- 2026-09-11 (v2) — owner replaced the pro-rata/ring-answer model with the prepaid waiting-room model: full price once the creator checks in within 20 min, full refund otherwise; media auto-connects on DO presence. §2 and §3 rewritten; §6 questions 1 and 4 withdrawn.
