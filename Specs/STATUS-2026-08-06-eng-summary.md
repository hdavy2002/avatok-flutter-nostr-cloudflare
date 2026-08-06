# Engineering status — 6 Aug 2026

Production worker deployed (version `44c353a1-08fc-4312-b37e-7b260e6b1338`).
Verified with three cache-busted probes. No build triggered.

---

## ⚠️ One thing needs your decision first

**`callSfuV1` is set to `true` in production KV.** I shipped it `false` on purpose;
something set an override. It is **inert today** — no app build contains any SFU
code, so nothing calls those routes — but it means that the moment an SFU build
reaches testers, the new call transport is live for **100% of users on day one**,
with no ramp and no two-device test. That is precisely what the flag exists to
prevent.

Recommendation: set it back to `false` until a staging two-device call (including a
WiFi→mobile switch mid-call) passes. One command, no build:

```
ALLOW_PROD=1 scripts/flags.sh set callSfuV1=false
```

I did not flip it back myself because it is another agent's deliberate write.

---

## ✅ Live in production right now — no app update needed

* **Live translation accepts free/bonus tokens.** The paid-only gate is gone;
  `callTranslationAllowFreeTokens` defaults on. Every tester can now use Translate.
* **Call recovery deadlines restored** — ICE recovery 12s → **30s**, relay migration
  8s → **20s**. Recovery had a measured **0% success rate** because success needed
  two healthy samples from a 5-second timer inside an 8-second window. This does not
  fix the design, but it moves it off zero.
* **1:1 SFU server routes are live and authenticating** — `/api/callsfu/:room/`
  `join` · `publish` · `peer` · `pull` · `renegotiate` · `close`. All return 401
  unauthenticated. No client uses them yet.
* **Receptionist envelope now carries `had_conversation` and `turns`**, so the app
  can tell a real voicemail from a caller who hung up.

## 📦 Merged to main, waiting on an app build

| Fix | What it does |
|---|---|
| `[CALL-UPDATE-GUARD-1]` | Update prompt no longer fires during a live, dialling or ringing call |
| `[CALL-ACCEPT-LIVENESS-1]` | Accepting no longer kills a live call before checking the new one is alive; branded ring surface now honours busy |
| `[RECEPT-EMPTY-CARD-1]` | Card stops claiming "Left a message" when there is no message |
| `[CALL-TRANSLATE-SLOT-1]` | Translate icon renders from call start instead of popping in ~2.4s later |

## 🔎 What we actually learned (the two that changed the plan)

1. **The "ghost call" was an in-app update.** Tiger's four redials were him, by
   hand. The update prompt fired while his call was ringing; he tapped Update one
   second before it connected; Play killed the app mid-call. Every downstream
   symptom — the redials, the busy signals, the accept that killed a working call —
   started there.
2. **Call recovery never worked for a stopwatch reason, not a network one.** All 11
   ICE restarts failed at 12,001–12,017ms. TURN is fine and has been fine —
   `/api/ice` returns eight working Cloudflare relay addresses. My earlier "there is
   no relay to fall back to" diagnosis was wrong.

## ⏳ Pending

**SFU client (other agent).** Server side is done. The client seam in
`call_session.dart` is not started — design decisions and an ordered work list are
in `Specs/HANDOVER-2026-08-06-CALL-SFU-1-client-seam.md`. Three things in there
matter most: the transport must not create its own peer connection; both phones
must agree on the transport or you get a split where both say "connected" and
neither can hear; and the health-sampler baseline reset is a prerequisite, not
optional.

**Not started, needs a build:**
* The health-sampler baseline reset + faster sampling during recovery
  (`[CALL-PROOF-1]`). Deferred by you; the SFU inherits the bug.
* Migration-PC pending-candidate buffer, and PostHog visibility when the ICE
  credential fetch falls back to STUN-only.

**No migrations were required** for anything deployed today — the changes are
Durable Object storage and JSON envelope fields, no schema change.

## 🧪 What to test on your phone right now

1. **Translation** — start a call, tap Translate. Should open the language sheet,
   not the "paid only" dialog.
2. **The deadline flip** — call, talk a minute, switch WiFi → mobile data mid-call.
   Tell me either way and I will pull the telemetry; I am looking for
   `call_recovery_completed`, which appeared **once** in the whole of the 5 Aug
   session and never for an actual recovery.

Test 2 is still the most valuable information available. It tells us whether the
relay was working all along and only the stopwatch was wrong — which also
de-risks the SFU, because if TURN-relayed media works on your devices, so will
Cloudflare's SFU.
