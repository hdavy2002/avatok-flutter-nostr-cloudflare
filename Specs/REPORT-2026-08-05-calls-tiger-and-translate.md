# Report — your calls with Tiger Showoff, 5 Aug 2026

**Who I looked at.** You (`hdavy2002@gmail.com`, motorola edge 70 fusion) and Tiger
Showoff, who in PostHog is **`s.rgoavilla@gmail.com`** (moto g45 5G). Both of you were
on **app build 10513** — same build, so nothing here is one of you being out of date.

**Window.** Six calls between 21:49 and 22:12 your time (16:19–16:42 UTC).

**Short version.** Five separate problems, all real, all visible in the data. Two are
fixed and pushed. Three are not fixed yet, and the biggest one — audio dying when you
switch WiFi to mobile data — **was never actually fixed on your phone.** The fix for it
exists, but it only ever went to the staging server. No app build has ever carried it.
So "you said you had solved all these issues" is fair: I said it, and it wasn't true on
your device.

---

## 1. WiFi → mobile data kills the audio — NOT FIXED

**What you saw.** Call stays "connected", nobody can hear anybody.

**What the data shows.** Call `avatok-7ed0f03c`. At 22:02:54 your phone switched network
(`call_network_handover`). Immediately after:

| Time | Audio state | Audio bytes | Last packet heard |
|---|---|---|---|
| 22:02:54 | degraded | 27,789 | 1.5 s ago |
| 22:02:59 | **no audio at all** | 0 | 6.5 s ago |
| 22:03:05 | **no audio at all** | 0 | 13.0 s ago |
| 22:03:24 | **no audio at all** | 0 | 31.5 s ago |
| 22:03:44 | **no audio at all** | 0 | **52.1 s ago** |

Fifty-two seconds of a live call with zero sound. The app tried to rescue it three times
(`call_recovery_started` → `call_recovery_failed`, twice for `network_changed`, once for
`transport_disconnected`) and failed every time. By 22:03:24 it had lost track of the
network route entirely — the connection details it reports go from real values to
`unknown`.

**Why it fails.** Every one of your calls today ran on a *direct* phone-to-phone path
(`media_path: direct`, both ends `srflx`). There is no relay in the middle. That is
cheap and fast, and it is exactly why the call cannot survive a network change: when
your phone's address changes, the direct path is simply gone, and there is nothing to
fall back to while a new one is negotiated.

**Why my earlier "fixed" was wrong.** The fix (`CALL-SURVIVE-1`) is deployed to the
**staging** server only. It is not on production and — more importantly — no app build
has ever included it. The phone-side half of that fix has never left the repo.

**What it needs.** A real fix plus an app build. Not a server flag flip.

---

## 2. Sound coming and going — NOT FIXED (same root, milder)

Before the handover, the same call was already unstable. Packet loss hit **15%** twice,
call quality dropped to "poor" at 21:53:32 and only recovered thirty seconds later, and
the audio quality score fell to **2.73 out of 5**. Two earlier calls (21:50:23 and
21:50:53) also lost their transport and failed recovery.

This is the same direct-path fragility as #1, just not fatal. Same fix.

---

## 3. Ghost call — the second incoming call from Tiger — NOT FIXED

**What you saw.** Mid-call with Tiger, another call from Tiger came in and you had to
cancel it.

**What actually happened.** In 40 seconds, **four** separate incoming calls arrived from
him:

- 21:49:54 `avatok-fdc9e6b0` — you answered, audio stalled, you hung up at 21:50:31
- 21:50:36 `avatok-1d349726` — you answered, this one also stalled
- 21:51:02 `avatok-b9b829a2` — auto-rejected as busy
- 21:51:14 `avatok-7e634735` — auto-rejected as busy, then you tapped Accept anyway

That last one is the ugly part. At 21:51:28 you accepted `7e634735`; the app killed the
call you were already on to make room (`owner-accepted-other-call`) — and then found
`7e634735` was **already dead**: `call_accepted_dead`, `remote-cancelled-preaccept`,
`call_late_accept_blocked`. You ended up with no call at all, having just been dropped
from a working one.

**Why.** Tiger's phone kept re-dialling because his side wasn't getting through (#1/#2),
each retry created a genuinely new call, and your phone showed each one as a fresh
incoming call. The app has duplicate protection (`call_duplicate_push_ignored` fired
twice) but it only catches identical retries of the *same* call, not new calls from the
same person seconds apart.

**What it needs.** Two things: stop the caller-side retry storm, and when a second call
arrives from the person you are *already on a call with*, don't ring — collapse it.

---

## 4. "He got a message that you're on another call" — WORKING AS BUILT

This one is not a bug in itself. `call_incoming_autobusy` fired at 21:51:03 and
21:51:18. You genuinely were on a call, so the busy signal was correct. It only *looked*
wrong because the calls it was rejecting were the phantom retries from #3. Fix #3 and
this stops happening.

---

## 5. Missed call with no Ava recording — NOT FIXED

**What you saw.** Screenshot 1, 22:12: "Tiger Ferns called / Ava took a message / **Left
a message**" — with no Play button.

**What happened, to the millisecond:**

- 22:12:09 — Ava triggered
- 22:12:10 — call started, Ava's transport closed almost at once
- 22:12:12.000 — Ava connected to the AI (Gemini)
- 22:12:12.170 — **connection lost, 170 ms later**
- 22:12:12.173 — session closed with **`turns: 0`** (nobody said anything)
- 22:12:12.712 — Tiger hung up
- 22:12:13 — the app posts "Left a message" into your thread anyway

The whole thing lasted 0.7 seconds. There was no conversation, so there is no recording,
and there was nothing to record. **The bug is the message.** Ava reported "Left a
message" for a session with zero turns and zero audio. That's why it looks broken — the
app told you a recording exists when it knows it doesn't.

Compare the 13:33 one in the same screenshot, which has a real 0:47 recording — that
session actually ran.

**What it needs.** Don't post "Left a message" when `turns == 0` and no recording was
stored. Say the caller hung up before Ava could take a message, or post nothing.

---

## 6. Translate icon appearing late — **FIXED** (commit `bc0a8806`)

**Measured.** On call `avatok-7ed0f03c` the call screen opened at 21:52:59.905 and the
Translate button only appeared at 21:53:02.267 — **2.36 seconds of an empty hole**
between "More" and "End".

**Cause.** The button wasn't slow to load. It wasn't being *created* until the call
connected. Only ~20 ms of those 2.36 s was actual loading; the rest was waiting to exist.

**Fix.** The Translate control is now built with the rest of the call controls, from the
moment the call screen opens. While the call is still ringing it shows dimmed and
inactive — same circle, same "Translate" label, same position — and becomes live the
instant the call connects. It also warms up its audio bridge during the ringing time, so
it's ready rather than starting from cold.

Needs an app build to reach your phone.

---

## 7. Translation refused because your tokens are "free" — **FIXED** (commit `3ef062f0`)

**What you saw.** Screenshot 2: "Live translation is paid only — your remaining 67
Tokens are free/bonus Tokens, which it cannot use."

**Confirmed in data.** 21:51:13 — `call_translation_start_failed`, reason
`insufficient_tokens`.

**Cause.** On 4 Aug the rule was set to "call translation spends PAID tokens only". Every
tester holds only the 100-token welcome grant and the daily free grant, so that rule
locked out every tester including you.

**Fix.** Free and bonus tokens now pay for live translation. It's controlled by a new
switch, `callTranslationAllowFreeTokens`, which ships **on** — so I can turn it back to
paid-only later without needing a new app build. Both halves that matter (the check
before starting, and the per-minute charge) read that one switch, so they can't drift
apart and produce the "starts, then fails and charges you" bug.

Four tests added covering it. Server type-check and design guard both pass.

**This one needs a production server deploy, not an app build** — it'll work on your
current phone the moment I deploy. You asked for the report first, so I haven't.

---

## Where things stand

| # | Problem | Status | To reach your phone |
|---|---|---|---|
| 1 | Audio dies on WiFi→data | **Not fixed** | Needs work + app build |
| 2 | Sound cutting in and out | **Not fixed** | Same fix as #1 |
| 3 | Ghost / duplicate incoming call | **Not fixed** | Needs work + app build |
| 4 | "On another call" message | Working correctly | Resolves with #3 |
| 5 | "Left a message" with no recording | **Not fixed** | Needs work + app build |
| 6 | Translate icon appears late | Fixed, pushed | App build |
| 7 | Translation blocked on free tokens | Fixed, pushed | **Prod server deploy only** |

**My recommendation:** let me deploy #7 now — it's server-only, it's low risk, and it
unblocks translation testing for you and every tester today. Then let me fix #1, #3 and
#5 and put all of it into a single app build, rather than shipping a build that only
carries the Translate icon.
