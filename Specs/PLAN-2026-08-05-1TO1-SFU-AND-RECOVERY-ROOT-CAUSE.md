# Plan — move 1:1 audio calls to the Cloudflare SFU
### …and the root cause of why call recovery has never once worked

**Date:** 2026-08-05 · **Owner decisions taken:** SFU for 1:1 **audio AND video**, P2P kept as a silent
fallback + kill switch, "End-to-end encrypted" relabelled to "Encrypted".

> **REVISED 2026-08-06.** The owner extended the scope from audio-first to a full
> migration: video goes through the SFU too. `callSfuAudioOnly` therefore ships
> **false**, and the free tier maths below shifts — video is ~18x the bandwidth, so the
> 1,000 GB covers roughly **1,100 video call-hours/month** rather than 20,000 audio
> hours. At current tester volume that is still free; at scale it is ~₹4.30/hour. The
> flag is kept so video can be pushed back onto P2P from KV without a build if the bill
> ever surprises us.

---

## Part 1 — I was wrong twice. Here is what is actually broken.

Yesterday I told you the calls fail because there is no relay to fall back to. That was
wrong. Checking production directly:

- `GET /api/ice` returns **`relay_available: true`** with eight working Cloudflare TURN
  addresses and live credentials.
- Both recovery switches are **already ON** in production
  (`callIceRecoveryV2`, `callRelayMigrationV1`).
- The app **did** try to move your calls onto the relay — **twelve times last night.**

All twelve failed. So did all eleven ICE restarts. And here is the number that gives it
away:

> Every single ICE restart failed at **12,001 – 12,017 milliseconds.**

That is not a network failing. Networks fail at random times. That is a **stopwatch going
off.** The deadline is 12 seconds, and the app hit it exactly, eleven times out of eleven.

### The actual bug

To declare a recovery successful, the app requires **two consecutive healthy audio
samples**. Those samples come from a timer that ticks **once every 5 seconds**.

- Two samples, 5 seconds apart, is **10 seconds minimum**.
- The first sample after switching connections is **guaranteed to read as "no audio"** —
  the app compares byte counters between the old and new connection without resetting
  them, so the new connection's small counter minus the old connection's large counter
  comes out negative, which the code reads as silence. That burns a tick.
- So the earliest possible success is **~15 seconds**. Both peers have to reach it
  independently, so realistically longer.

The deadlines are **8 seconds** (relay migration) and **12 seconds** (ICE restart).

**The success condition cannot be met inside the time allowed. Not sometimes — ever.**
The connection may have been coming up perfectly and then being torn down by a timer for
failing to prove itself fast enough.

### Where it came from

The deadlines used to be **20 and 30 seconds** — long enough that this marginally worked.
`CALL-SURVIVE-1` on 2026-08-04 moved them to remote config and set them to 8 and 12,
without touching the 5-second sampler or the two-sample rule. The code comments in
`call_session.dart` still describe the old 20-second deadline. That change is what turned
an occasionally-working mechanism into one with a 0% success rate — and it is **live in
production right now**, on the build you and Tiger are using.

### The immediate consequence: you can improve this today with no app build

`callRecoveryDeadlineSec` and `callMigrationDeadlineSec` are remote-config numbers. Setting
them back to 30 and 20 restores the window in which the success check can actually pass.
No build, no Play Store, effective within a minute, and reversible with one command.

That does not *fix* the design — a 15-second recovery is still a bad experience — but it
takes the success rate from a measured **0%** to something greater than zero, today.

### Two more real bugs found along the way (both need a build)

1. **Migration ICE candidates are dropped.** The normal call path buffers network
   candidates that arrive before the connection is ready (`_pendingCandidates`). The
   migration path has **no such buffer** — `_onRelayMigrateCandidate` returns silently if
   the new connection isn't built yet. It typically isn't, because it's waiting on a
   network fetch that can take up to 5 seconds. So the relay connection can lose *all* of
   the other phone's candidates.
2. **A failed ICE-credential fetch is invisible.** `ice_cache.dart` falls back to a
   STUN-only list and logs it locally but sends **nothing to PostHog**. Combined with a
   relay-only connection, a STUN-only list can never work — and we would have no way of
   knowing it happened.

---

## Part 2 — Does this change the SFU decision?

**It removes the "we have no choice" argument. It does not remove the case for SFU.**

The architectural reason still stands and is the real one:

> With P2P, a network change breaks **both** ends at once, and two phones behind two
> different mobile networks have to re-find each other — coordinating over a signalling
> path that may itself be broken. With an SFU, only **your** leg breaks. The other
> person's audio never stops flowing to the server, and your phone reconnects to a fixed,
> publicly-routable address that did not change. There is no two-phone negotiation to get
> wrong, because there is no second phone in the conversation — only the server.

Every mechanism that failed last night — offerer election, glare handling, `attemptId`
matching, relay-migrate offer/answer/candidate/ready, both peers independently proving
health — **exists only because there are two phones to coordinate.** The SFU deletes that
entire category of bug rather than fixing it.

You also already run it: group calls go through Cloudflare Realtime SFU today
(`worker/src/routes/groupcall.ts`, `CF_RT_SFU_APP_ID`). This is not new infrastructure.

### Cost, confirmed against Cloudflare's published pricing

$0.05/GB, charged **only** on Cloudflare→phone traffic, with a **1,000 GB free tier shared
between SFU and TURN**. Your measured audio is ~7 KB/s per stream.

| | Per call-hour | Free tier covers | Cost after free tier |
|---|---|---|---|
| 1:1 **audio** via SFU | ~50 MB | **~20,000 call-hours/month** | ~₹0.24/hour |
| 1:1 **video** via SFU | ~900 MB | ~1,100 call-hours/month | ~₹4.30/hour |

For scale: one minute of live translation costs the user ₹5. An hour of SFU audio costs
you about 25 paise. This is why video stays on P2P for now — it is the same money
argument running 18× faster.

---

## Part 3 — The plan

### Phase 0 — Today, no build, no code (PROD FLAG WRITE — needs your go-ahead)

```
ALLOW_PROD=1 scripts/flags.sh set callRecoveryDeadlineSec=30
ALLOW_PROD=1 scripts/flags.sh set callMigrationDeadlineSec=20
```

Then make two or three calls with Tiger, including one WiFi→mobile switch, and I measure
whether `call_recovery_completed` starts appearing at all. **This is the single most
valuable thing available right now** and it is one command, reversible.

*Risk:* longer deadlines mean longer dead air before the next attempt starts. Given the
current success rate is zero, you are already getting the dead air with none of the
recovery.

### Phase 1 — Fix the proof logic (needs a build) `[CALL-PROOF-1]`

This is prerequisite work for the SFU, not a detour: the **same health sampler** will judge
whether an SFU connection is alive.

- Reset the byte/packet baselines when the sampler switches to a new connection, so the
  first sample after a switch is honest instead of automatically "no audio".
- Sample every **1 second** while a recovery or migration is in flight, instead of every 5.
  Two healthy samples then costs 2 seconds, not 10–15.
- Add a pending-candidate buffer for the migration connection (mirror `_pendingCandidates`).
- Instrument the migration connection's ICE state — right now nothing reports on it until
  after a successful cutover that never happens.
- Emit a PostHog event when the ICE-credential fetch fails and we fall back to STUN-only.

**Pass criteria:** on a WiFi↔mobile switch, `call_network_handover` →
`call_recovery_completed` within 3 seconds, with audio bytes flowing, on both devices.

### Phase 2 — 1:1 audio on the SFU `[CALL-SFU-1]`

**Worker.** A new `worker/src/routes/call_sfu.ts` reusing the existing Cloudflare Realtime
app (`CF_RT_SFU_APP_ID`) and the same session/publish/pull proxy pattern already proven in
`groupcall.ts`. The `CallRoom` Durable Object keeps doing ring, accept, decline, busy and
presence exactly as it does now — **only the media path changes.** The 2-peer cap stays.

**Client.** Introduce a transport seam in `call_session.dart`:
- `P2PTransport` — today's code, unchanged, still the fallback.
- `SfuTransport` — modelled on `cloudflare_conference_controller.dart`, which already works.

Everything above the seam (ringing, CallKit, foreground service, audio routing, the
translate bridge, billing, telemetry) is untouched.

**Flags.**
- `callSfuV1` — master switch, ships **false**, ramped by you.
- `callSfuAudioOnly` — ships **false** (owner 2026-08-06: video on SFU too). Kept as the
  escape hatch that pushes video back onto P2P from KV if the bandwidth bill surprises us.

**Fallback.** If SFU session creation or connection fails within ~4 seconds, drop to the
P2P path and place the call as it works today. Emit `call_sfu_fallback` with a reason so a
bad Cloudflare day shows up as a chart, not as "calls are broken".

**Handover, the whole point.** On network change, the phone re-establishes *its own* leg to
the SFU. No offerer election, no glare, no peer coordination, no `attemptId`. If the other
phone is fine, it never even notices.

### Phase 3 — Honest labelling `[CALL-LABEL-1]`

The call screen reads "End-to-end encrypted". Once media passes through Cloudflare that is
no longer true, so:
- The label is driven by the **active transport**: "Encrypted" on SFU, and it can keep
  saying "End-to-end encrypted" on the P2P fallback because there it genuinely is.
- Privacy policy and Play Data Safety updated to match.

Media stays encrypted phone→Cloudflare→phone throughout (DTLS-SRTP). Nobody on the network
can listen. The change is that Cloudflare is now inside the trust boundary — which is
already true of your group calls.

### Phase 4 — Verify, then ramp

Staging first, two real devices, a scripted test: place a call, talk, switch WiFi→mobile
mid-call, switch back, hang up. Then production behind `callSfuV1`, ramped by you.

---

## Later — self-hosted LiveKit

Worth revisiting **only above roughly 20,000 call-hours a month**, which is where
Cloudflare's free tier ends. Below that, self-hosting costs you servers, bandwidth,
on-call and TURN infrastructure to replace something that is currently free. The transport
seam built in Phase 2 is what makes that swap cheap later — LiveKit would be a third
transport behind the same interface, not another rewrite.

---

## What needs your decision

1. **Phase 0 flag flip on production — yes or no.** One command, reversible, no build.
2. Whether Phase 1 ships as its own build or waits and rides along with Phase 2.
3. Still outstanding from this morning: the translation fix (free tokens) is committed and
   pushed but **not deployed** — it needs one production worker deploy to take effect.
