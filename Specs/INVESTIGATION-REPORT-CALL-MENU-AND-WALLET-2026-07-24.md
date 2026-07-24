# Investigation Report — Call Outcome Menu & Wallet History
**Date:** 2026-07-24
**Author:** Senior engineering review (verified against source at HEAD)
**Incident window:** 2026-07-24 07:57–08:03 UTC
**Caller:** hdavy2002@gmail.com — build **0.1.18 / 10461.0** (this is the *pre-ship* build; today's CALL-REL / CF-CALL fixes and the wallet schema fix are NOT on this device)
**Callee:** Sat — s.rgoavilla@gmail.com

---

## Executive summary

The owner reported four things going wrong during a short burst of five calls: (1) live-looking
call controls painting *under* the outcome menu, (2) a hard "**Already on a call — force-close**"
lock that never clears, (3) a wrong card that flashes for ~1 second on retry instead of the
persistent menu, and (4) an empty wallet transaction history despite a real coin balance.

**Root-cause verdict:**

- Bugs **A**, **B**, and **C** are **pre-existing gaps in the call-outcome-menu work** (the
  `[CALL-OUTCOME-MENU-1]` / `[AVACALL-MENU-1]` / `[DIALPAD-BIZ-CALLS]` features). **None of them
  were caused by today's CALL-REL or CF-CALL changes.** Evidence: the leaking code paths
  (`_showOutcomeMenu`, `CallOutcomeMenu.onCallAgain`, the hardcoded `business: true`) all predate
  this session, the device is running the **pre-ship** build 10461.0 that does not contain today's
  work, and the telemetry signatures are UI/session-lifecycle events, not media/transport events.
- Bug **D** (wallet) is a **silent data-pipeline gap**: the UI and read endpoints are fully built
  and the *balance* renders from a live WalletDO path, but the *history* reads a D1 table that is
  populated only by a **fire-and-forget queue** whose failures are swallowed. A previously-fixed
  schema bug on that exact path (`counterparty_npub` → `counterparty_uid`) already proved this
  pipeline can starve for weeks without any surfaced error.

**Bonus finding (not a bug):** all five calls hit `push_no_device reason:zero_tokens` on Sat's
side — Sat's phone had **no registered FCM token and was never rung at all**. The app's
"appears off or unreachable" message was **correct**. Sat needs to reopen/reinstall AvaTOK to
re-register for push. This also independently validates the `CALL-REL-9` ring-audibility work
(the caller's side behaved as designed given an unreachable callee).

---

## Timeline — the five calls (07:57–08:03 UTC)

| # | call_id | Type | What happened | Key telemetry |
|---|---------|------|---------------|---------------|
| 1 | `avatok-29f5efbb` | initial | rang, no answer → outcome menu shown; session **never torn down** | **no `call_ended` all day**; `call_connect_watchdog_skipped(outcome_menu)` |
| 2 | `avatok-095efba7` | initial | same pattern — menu shown, session leaked | **no `call_ended` all day**; watchdog skipped |
| 3 | `ce4d7dbd…` | retry (Call again) | ended `timeout-ringing` ~12s after mount, **before** `call_menu_shown` → 1s wrong card | `business:true` no-answer branch |
| 4 | `3fe8b0de…` | retry (Call again) | same — legacy `NoAnswerCard`, auto-popped after 1400ms | `call_dial_suppressed(already_in_call)` |
| — | (×5 total) | — | every dial suppressed once the guard filled | `call_dial_suppressed(already_in_call)` ×5 |
| — | — | — | overlapping teardown of two sessions | one `$exception` "No active stream to cancel" (double EventChannel teardown) |
| — | all 5 | callee side | Sat never rung | `push_no_device reason:zero_tokens` ×5 |

---

## Bug A — Dead call controls paint under the outcome menu

**Symptom.** When the outcome menu appears (no answer / declined / busy), the bottom call-control
row (mute, speaker, camera, hang-up) is still drawn beneath/around it, looking like a live call
even though the call leg is already gone.

**Root cause.** This is *by design* in the session, but the *view* never got the matching gate.

- `call_session.dart:3915` `_showOutcomeMenu(scenario)` deliberately **keeps the session alive**
  (`_ended` stays `false`; it sets `_setPhase('outcome-menu')`) after tearing down only the dialing
  leg (`bye`, stop tracks, close `_pc`). The comment is explicit: *"The menu is the caller's
  follow-up surface; Talk to Ava re-uses the session."* So the session must survive.
- `call_screen.dart:917-971` renders the control-row `Positioned` as a **direct, unconditional
  child of the Stack**. Compare the NetHud immediately below it at `:908`, which *is* gated
  (`if (connected && !s.isReceptDuo)`). The control row has no such guard, so it paints in every
  phase — including `outcome-menu` and `busy`.

**Why it happens every time.** There is no conditional on the control row at all; it is structural,
so it reproduces 100% of the time the menu shows.

**Permanent fix.** Gate the control row on live phases only — e.g. wrap the `Positioned` at
`:918` in `if (!s.showOutcomeMenu && !s.showBusyCard && phase != 'no-answer' && phase != 'agent-handoff')`
(or the cleaner inverse: render it only while `connected || phase == 'ringing'/'connecting'`).

**On the owner's suggestion ("disconnect the call then show the screen"):** honest evaluation —
a *full* disconnect would break "Talk to Ava," which is explicitly built to **re-use the same
session** (`menuTalkToAva` → `_handoffToAva`). The correct fix is therefore **UI gating (this bug)
+ guaranteed teardown on every menu exit (Bug B)** — the controls disappear, but the session is
kept only for the one action that needs it, and is always reaped when the menu closes.

**Verification.** With the gate in place, entering `outcome-menu`/`busy`/`no-answer` shows the
card with **no** control row; "Talk to Ava" still connects (session survives); every other menu
exit fully tears down (see Bug B). Confirm no `ui_content_flash` / stray controls in a replay.

---

## Bug B — "Already on a call — force-close" forever (the session leak) — **THE BIG ONE**

**Symptom.** After a couple of "Call again" taps, every subsequent call is blocked with
"**Already on a call — force-close**", and it never recovers without killing the app.

**Root cause.** `CallOutcomeMenu.onCallAgain` (`call_screen.dart:1061`) pops the screen and calls
`place1to1Call(...)` **without ever calling `menuDismiss()` or hangup()**:

```dart
onCallAgain: () {
  Analytics.capture('call_menu_option_selected', {...});
  final nav = Navigator.of(context);
  ...
  _popIfMounted();
  place1to1Call(nav.context, uid: uidSeed, ...);   // no menuDismiss / no teardown
},
```

Because the session was intentionally kept alive by `_showOutcomeMenu` (Bug A), and the *only*
paths that call `_teardown()` are `_endWith(...)` (reached via `menuDismiss` at `call_session.dart:3959`
or the 180s `_menuTimeout`), skipping `menuDismiss` means the abandoned session **never reaches
`_teardown`**. The global call-guard state it owns — `gLiveCallScreens` / `gInCall` /
`gActiveCallId` — is therefore **never cleared**. Every "Call again" tap **leaks one guard slot**.
Once the guard is occupied, `place1to1Call`'s dial-time check emits
`call_dial_suppressed(already_in_call)` and refuses — permanently.

**Telemetry proof.**
- `avatok-29f5efbb` and `avatok-095efba7` **never emitted `call_ended` all day** → their sessions
  were never torn down.
- `call_connect_watchdog_skipped(outcome_menu)` confirms the connect watchdog **deliberately
  skips** menu-state sessions (so the watchdog will not reap them either).
- `call_dial_suppressed(already_in_call)` fired **5×** — the guard filling up, one leaked slot at
  a time.
- One `$exception` "**No active stream to cancel**" — a double EventChannel teardown when two
  leaked sessions' ends overlapped, corroborating multiple live-but-abandoned sessions.

**Why it happens every time.** It is deterministic: one leaked guard slot per "Call again", and
nothing ever clears it (watchdog skips, no `call_ended`, timeout is 180s and the user retries
well inside that). After N taps the guard is saturated and stays that way.

**Permanent fix (two parts — belt and braces).**
1. **Every exit from `outcome-menu` must run `menuDismiss → _teardown`** — including `onCallAgain`
   (and the mirror `PaidBusyCard.onTryAgain` at `call_screen.dart:827` and the `NoAnswerCard`
   retry at `:848`, which have the same shape). Concretely: call `s.menuDismiss(reason: 'call-again')`
   **before** `place1to1Call(...)` so the old session tears down and frees its guard slot.
2. **Dial-time zombie reaping.** In `place1to1Call`'s guard check, if the currently-registered
   session is in `phase == 'outcome-menu'` (or `agent-handoff`/`no-answer`), **reap it and proceed**
   instead of suppressing the new call. This makes the system self-healing even if a future exit
   path forgets to dismiss.

**Verification.** After the fix: each "Call again" emits `call_ended` for the old `call_id` before
the new dial; `call_dial_suppressed(already_in_call)` no longer appears across repeated retries;
`gInCall`/`gActiveCallId` return to empty between calls (add a one-line debug assert or a
`call_guard_state` event). Manually: tap "Call again" 10× in a row — the 10th must dial, not lock.

---

## Bug C — Wrong card flashes for ~1 second on retry

**Symptom.** On retry, instead of the persistent unified outcome menu, a card flashes for roughly
one second and disappears.

**Root cause.** `place1to1Call` **hardcodes `business: true`** on the `CallScreen` it constructs —
in both the optimistic-mount path (`place_1to1_call.dart:95`) and the awaited path (`:239`). The
*original* chat-thread call defaults to `business: false`. So a retry launched through
`place1to1Call` always enters the **business flow**, which on no-answer takes the legacy
`NoAnswerCard` branch (`call_screen.dart:841`, gated on `RemoteConfig.businessCallUx && outgoing &&
phase == 'no-answer'`) and `_endWith(...)` auto-pops it after ~1400ms — producing the 1-second
flash instead of the persistent `[CALL-OUTCOME-MENU-1]` surface.

**Telemetry proof.** Retry calls `ce4d7dbd` and `3fe8b0de` ended `timeout-ringing` ~12s after
mount, i.e. they reached the business no-answer branch and terminated **before** `call_menu_shown`
was ever emitted — the unified menu was never given a chance to show.

**Why it happens every time.** `business: true` is a literal constant on the retry launcher, not a
propagated value, so **every** retry of a non-business (chat-thread) call is misrouted into the
business UX. Deterministic.

**Permanent fix.** Propagate the **originating call's business context** through `place1to1Call`
(add a `bool business` parameter, default `false`, and pass `widget` / call metadata's actual
value from each call site — the outcome menu's `onCallAgain`, `PaidBusyCard.onTryAgain`,
`NoAnswerCard.onCallAgain`, and the dialer sites which legitimately pass `true`). A retry of a
chat-thread call then stays `business: false` and shows the same unified menu the first call did.

**Verification.** Retry a chat-thread no-answer call → `call_menu_shown` fires and the unified menu
**persists** (no 1400ms auto-pop, no `NoAnswerCard`). Retry a dialpad call → still gets the
business no-answer card (unchanged). No `timeout-ringing` termination before `call_menu_shown` on
the chat-thread path.

---

## Bug D — Wallet history empty despite a real balance

**Symptom.** The wallet shows a coin balance, but the transaction history below it is empty — "no
log below my recent transaction."

**What is actually built (verified).** The wallet is **not** missing UI or endpoints:
- `wallet_screen.dart` renders money-in/out, daily spend, the donut, and the history list.
- `worker/src/routes/wallet_statement.ts` implements `GET /api/wallet/summary` and
  `GET /api/wallet/statement` (read-only, per-user scoped) and both are registered.
- The **balance** renders because it comes from a **separate live WalletDO** path (WebSocket
  `type:"balance"` snapshot, `worker/src/do/wallet.ts:491+`) — independent of history.

**Root cause.** The **history** reads the D1 `wallet_transactions` table, which is populated
**only** by a **fire-and-forget queue** whose failures are swallowed:

- `worker/src/do/wallet.ts:488`:
  ```ts
  try { await this.env.Q_WALLET.send({ uid, id, ts: Date.now(), ...tx, ...(ledger ? {ledger} : {}) }); }
  catch { /* best-effort */ }
  ```
  The comment above it even says *"never blocks the user."* If the enqueue (or the downstream
  consumer) fails, the user's balance still updates (DO-authoritative) but **no audit row lands**,
  and **nothing surfaces the failure**.
- The consumer `consumers/src/wallet.ts` writes the D1 rows. Its own header documents a prior
  incident that proves this pipeline can starve silently: the per-user insert used
  `counterparty_npub` while the live schema column is `counterparty_uid`, so **every** per-user
  audit insert threw and *"the statement feed silently starved (prod had 2 rows total, none since
  2026-06-20) while wallet_ledger kept filling."* That specific bug is fixed in source, but it
  demonstrates the exact failure mode the owner is seeing, and the fix may not have reached these
  accounts (or a backfill was never run).

So the owner has **never seen history** most likely because either (a) the consumer/queue path
never landed rows for these accounts (schema/deploy lag or a swallowed enqueue), or (b) the balance
came from **seed / admin / welcome-bonus DO-only credits that bypass the ledger** entirely. The
client already anticipates exactly this: `wallet_screen.dart:348-364` emits
**`wallet_balance_without_ledger`** when there's a positive *paid* balance but an empty, unfiltered
ledger — the precise signature of this symptom, tagged with email + phone for support pulls.

**Why it happens every time (for affected accounts).** A swallowed enqueue or a consumer insert
error produces **no user-visible error and no retry** — the row simply never exists, so the history
is empty on every open until the row is backfilled.

**Permanent fix (shape).**
1. **Verify Q_WALLET consumer health** for these accounts in prod (queue backlog / DLQ, consumer
   error rate) and **backfill** the missing `wallet_transactions` rows from `wallet_ledger` /
   WalletDO state.
2. **Make ledger writes durable, not swallowed** — replace the bare `try/catch {}` at
   `wallet.ts:488` with an enqueue that surfaces failures to `hooks.trackException` and relies on
   the queue's native retry/DLQ (the message id is already the op_id, so writes are idempotent on
   replay — retries are safe).
3. **Alert on `wallet_balance_without_ledger`** so this is caught proactively instead of by owner
   report.

**Verification.** After backfill + durable-write: `GET /api/wallet/statement` returns rows for the
affected uids; `wallet_balance_without_ledger` stops firing for accounts that have real spend/earn;
Q_WALLET DLQ is empty; a fresh spend produces a statement row within seconds.

---

## Prioritized fix list (each is a small, focused change)

| ID | Bug | Change | Size |
|----|-----|--------|------|
| **[CALL-MENU-FIX-1]** | **B** | On every outcome-menu exit (`onCallAgain`, `PaidBusyCard.onTryAgain`, `NoAnswerCard.onCallAgain`) call `menuDismiss` → `_teardown` **before** re-dialing; add dial-time zombie reaping for `phase == 'outcome-menu'`. **Highest priority — this is the hard lock.** | Small |
| **[CALL-MENU-FIX-2]** | **A** | Gate the control-row `Positioned` (`call_screen.dart:917`) on live phases only. | Small |
| **[CALL-MENU-FIX-3]** | **C** | Add a `business` param to `place1to1Call` and propagate the originating call's value instead of hardcoding `true`. | Small |
| **[WALLET-LEDGER-FIX-1]** | **D** | Make Q_WALLET enqueue durable (surface + retry/DLQ, no swallow); verify consumer health; backfill missing rows; alert on `wallet_balance_without_ledger`. | Small–Medium (needs one prod probe) |

---

## What the owner should do now

1. **The pending build:** if approving/shipping the currently pending build, know that **these four
   fixes are NOT in it** — the incident device was on the pre-ship build 10461.0, and the fixes
   above have not been written yet. Approving the pending build ships today's CALL-REL / CF-CALL
   reliability work (which is unrelated to these four bugs), not these fixes. The four fixes above
   need to be implemented, then included in a subsequent build.
2. **Sat's device:** ask Sat to **fully reopen or reinstall AvaTOK** so it re-registers an FCM push
   token. Right now Sat has **zero push tokens** and cannot be rung at all — "appears off or
   unreachable" was correct, not a call bug.
3. **Wallet:** the fix needs **one production probe** — check Q_WALLET consumer/DLQ health and the
   `wallet_transactions` rows for the affected accounts (`hdavy2002@gmail.com` and any other
   testers seeing empty history) before deciding between "backfill" vs "the credits were DO-only
   and never had a ledger row." Do not change prod wallet data without that read first.

---

## Verification note on the two investigator reports

Every cited `file:line` was spot-checked against source at HEAD and **held**:

- `call_session.dart:3915` `_showOutcomeMenu` — confirmed: keeps session alive (`_ended` stays
  false), sets `phase='outcome-menu'`, tears down only the dial leg. ✔
- `call_screen.dart:917-971` control row — confirmed: unconditional Stack child; NetHud at `:908`
  is gated, control row is not. ✔
- `call_screen.dart:1061` `onCallAgain` — confirmed: `_popIfMounted()` then `place1to1Call(...)`
  with **no** `menuDismiss`/hangup. ✔
- `place_1to1_call.dart:95` and `:239` — confirmed: `business: true` hardcoded in both the
  optimistic-mount and awaited paths. ✔
- `no_answer_card.dart` — confirmed: business-flow presentation card, flag-gated by
  `RemoteConfig.businessCallUx` at the call site. ✔
- `wallet_screen.dart:348` — confirmed: `wallet_balance_without_ledger` diagnostic (fires at
  `:359`) keyed to positive *paid* balance + empty unfiltered ledger. ✔
- `worker/src/do/wallet.ts:488` — confirmed: fire-and-forget `Q_WALLET.send` inside a bare
  `try/catch { /* best-effort */ }`. ✔

**Correction / addition made during verification:** the consumer file
`consumers/src/wallet.ts:51-58` documents a *prior* silent-starvation incident on this exact path
(`counterparty_npub` → `counterparty_uid`; "prod had 2 rows total, none since 2026-06-20"). The
investigators did not cite this; it materially strengthens Bug D's root cause (proves the pipeline
starves silently) and is incorporated above.
