# Call Issues Report — Sat (Mumbai) ↔ hdavy2002@gmail.com

**Date:** 2026-07-04 · **Source:** PostHog (project 139917, EU) · **Window analyzed:** 2026-07-01 → 2026-07-03 (UTC)

## Who is who

| Person | Account(s) | Device | City | App version |
|---|---|---|---|---|
| Humphrey (caller) | hdavy2002@gmail.com | marvel | Dehradun | 0.1.17 |
| Sat / "Satish Mumbai" | **sf0273@gmail.com until 7/1 13:06, then s.rgoavilla@gmail.com** | fogos | Mumbai | 0.1.17 |
| Third tester | jdfilmdirector@gmail.com | lime | — | 0.1.18 |

Key identity finding: Sat's device (`fogos`, Mumbai) stopped emitting events as **sf0273@gmail.com** at 7/1 13:02, hit `signup_failed` at 13:06, and reappeared at 13:20 as **s.rgoavilla@gmail.com**. All subsequent call testing with Humphrey is under s.rgoavilla — sf0273 has been completely dark since 7/1 13:02.

## Headline: the root problem is Sat's device keeps getting logged out

`fogos` re-completed sign-up **6–7 times in 3 days** (last: 7/3 18:21 UTC ≈ 11:51pm IST — exactly matching the sign-in-screen video). Between sign-ups the device is fully offline: no push token, no hub connection, no call events. This matches the **flutter_secure_storage BAD_DECRYPT logout loop** already diagnosed on 2026-07-03 and fixed in commit `dce5f4f` (CI run 28676030496). **`fogos` is still on 0.1.17 — it does not have the fix** (jdfilmdirector's `lime` is on 0.1.18 and shows no such churn).

Consequence for calls: whenever Sat was logged out, Humphrey's outgoing calls could never connect.

## Call outcomes (hdavy2002 ↔ Sat's device)

Of 44 call_ids Humphrey touched in 3 days, only ~10 had a leg on Sat's account. The rest of his failed attempts (`call_started → call_cancel_sent → call_ended` with `error_occurred: never_connected`, 27 occurrences total) had **no peer leg at all** — the callee was unreachable.

| Time (UTC) | Outcome |
|---|---|
| 7/1 05:46–16:06 | 8 unanswered calls rolled to AI receptionist under sf0273 |
| 7/1 13:27–13:28 | 2 calls failed: `call_busy_received` immediately after accept + `never_connected` (`remote-ended-push`, `socket-lost`) |
| 7/1 13:30, 16:43 | 2 calls connected OK |
| 7/1 16:48 | connected but a spurious `call_busy_received` + local-hangup |
| 7/1 17:58–18:00 | 5 attempts → `call_no_device` ×5 + `/api/call` **404** ×5 — Sat had zero registered push tokens (logged out) |
| 7/2 all day | every attempt cancelled unanswered (Sat offline the entire day) |
| 7/3 18:21 | Sat re-signs up (the video moment) |
| 7/3 18:26–18:38 | 3 calls connected fine (good quality: MOS ~4.4, loss ≤0.2%, RTT 32–151ms) |
| 7/3 18:38:22 | `call_incoming_autobusy` 0.4s after push — Sat's app still held stale state from the call that ended seconds earlier → caller got busy |
| 7/3 18:39 | final attempt: push sent + ring_ack, never answered → `never_connected` |

## Failure modes identified

1. **BAD_DECRYPT logout loop on Sat's device (primary).** 0.1.17 without the `dce5f4f` self-heal. Every logout removes his push tokens → calls become `call_no_device` / `/api/call 404` / silent no-ring / receptionist pickup. **Fix: get 0.1.18 (or newer build containing dce5f4f) onto `fogos`.**
2. **Account confusion.** Sat's history is split across sf0273 → s.rgoavilla. If Humphrey's contact entry still points at the sf0273 account, those calls dial a dead account.
3. **Stale-busy race.** `call_incoming_autobusy` fired 0.4s after push on a fresh call because the previous call's state hadn't been cleaned up (also seen 7/3 11:42 with jdfilmdirector, and `call_busy_received` immediately after accept on 7/1 13:27/13:28 and 16:48). Back-to-back redials hit "busy" even though nobody is on a call. Worth a look at CallRoom/local call-state teardown timing.
4. **Duplicate push to caller.** `call_duplicate_push_ignored` fires on the **caller's own device** for his own outgoing call (4×) — harmless (ignored) but indicates the call push fan-out includes the caller.
5. **Background noise on hdavy2002's device (not call-blocking but loud):**
   - `SqliteException: no such column "npub"` from an `ALTER TABLE` migration — **204 exceptions in 3 days**; legacy Nostr-era migration still running and failing on every boot.
   - DNS flaps: `Failed host lookup: clerk.avatok.ai / api.avatok.ai` (~76 events) — device-side network, drives `hub_reconnect` churn.
   - `/api/team` 503 ×61, `/api/profile` 422 ×44 / 400 ×10 — server endpoints erroring repeatedly.
   - One WebRTC `setRemoteDescription` failure (7/1 16:36) coinciding with a `call_relay_fallback`.

## Quality when connected

Connected calls were healthy: avg MOS 4.35–4.39, jitter 3–10ms, packet loss ≤0.2%, RTT 32–151ms. **The problem is call setup/reachability, not media quality.**

## Session deep-dive: 2026-07-03 18:21–18:40 UTC (owner's reported bad session)

Minute-by-minute reconstruction confirming the owner's experience:

1. **18:22:41 & 18:23:47, again 18:31:00 & 18:32:16 — Sat→Davy, no ring.** All four of Sat's outgoing calls show `call_started` → 35s `timeout-ringing` → `never_connected`. **No `call_push_sent` event exists for any of them** — the server never fanned out a push to Davy's device. Davy's own outgoing calls always show `call_push_sent` within ~3s. Davy had re-signed-in at 16:49 and 18:21 (marvel also churns accounts); `push_token_pruned` fired 18:26:05, implying the server held a dead token for Davy and silently sent nothing. **BUG: push fan-out fails silently after callee re-login; no push_no_device emitted either.**
2. **18:26:03 — Davy→Sat connects (53s).** But a ghost leg answered `call_busy_received` + `call_cancel_sent` mid-setup (suppressed via `ava_recept_signal_suppressed`). Stale second leg on Sat's side.
3. **18:38:21/18:38:22 — call glare.** Sat dialed Davy (avatok-d9c1ae61) and Davy dialed Sat (avatok-49464aa3) 1s apart. Sat's device `call_incoming_autobusy`'d Davy's incoming because it was dialing out → Davy heard busy; Sat's own call to Davy again had no push (`remote-ended-push`). Followed by duplicate accepted/declined/missed event bursts. **BUG: no glare handling — crossing calls busy each other instead of merging.**
4. **18:39:01 — Davy→Sat, receptionist double-session.** Ava answered at 18:39:09. Davy's `call_cancel_sent` at 18:39:36 triggered a receptionist **re-attach**: a second `ava_recept_session_started` at 18:39:39 on the same call_id — Ava restarted her greeting/message-taking from the beginning (exactly what the owner experienced), producing 2 recordings, 2 posted messages, and **2 `ava_recept_cost` billing events** for one call. Davy hung up at 18:39:54. **BUG: cancel during receptionist session restarts the session instead of ending it; double-billed.**
5. **18:38:59 — `call_dial_suppressed` ×2**: anti-spam guard blocked Davy's immediate redials after the busy mess.

Note: the dce5f4f logout fix ships in a build neither device has (both on 0.1.17); items 1, 3, 4 above are separate newly identified bugs unrelated to that fix.

## Recommended actions (priority order)

1. Fix silent push fan-out failure: after callee re-login, server holds stale token and sends nothing (no `call_push_sent`, no `push_no_device`) — callee never rings. Prune-and-retry against the freshest token.
2. Fix receptionist re-attach on cancel: caller cancel mid-session restarts the Ava session from scratch (double greeting, double message, double `ava_recept_cost` billing).
3. Add call-glare handling: two users dialing each other simultaneously should connect, not autobusy each other.
4. Push the fixed APK (≥0.1.18 / commit dce5f4f) to BOTH devices — ends the logout loop, keeps push tokens alive.
2. Confirm which account Sat should use going forward (s.rgoavilla@gmail.com) and that Humphrey's contact points at it; consider merging/retiring sf0273.
3. Fix stale call-state → autobusy/busy-after-accept race on rapid redial.
4. Kill the failing legacy `npub` ALTER TABLE migration (guard or remove).
5. Investigate `/api/team` 503s and `/api/profile` 422/400s.
6. Exclude caller's own device from call push fan-out.
