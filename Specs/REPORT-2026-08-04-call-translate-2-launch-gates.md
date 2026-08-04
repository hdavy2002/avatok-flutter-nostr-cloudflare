# REPORT — CALL-TRANSLATE-2 launch gates (Phase D)

Date: 2026-08-04 · Status: implementation complete, **not deployed, not pushed, flags dark**
Plan: `Specs/PLAN-CALL-TRANSLATION-2-HARDENING-HANDOVER.md`
Method: implemented by parallel agents (worker / native / Dart), then audited adversarially
twice — once against the plan, once against the fixes.

Nothing was deployed, pushed, built in CI, or flag-flipped. All commits are local on `main`.

---

## 1. What was built

| Layer | File | Commits |
|---|---|---|
| Worker | `worker/src/routes/call_translation.ts` (+ `config.ts`, `index.ts`) | `0f48c570` `8d58cca2` `f1f58c41` `08aa0686` `e93a9f4e` `403bbee1` |
| Native | `app/android/.../calltranslation/CallTranslationAudioPlugin.java` | `5a400cd5` `3af9fd72` `85d7c566` |
| Dart | `app/lib/features/translation/*` | `5ae0940d` `f885429c` `03aee76a` `f543c0a1` `e00ad1e2` `9fa41811` `464ddaa6` |
| Migration | `worker/migrations/2026-08-04-call-translation-device-nonce.sql` | **UNAPPLIED** |

**Phase A** — transcription removed from both setup sites; billing reconciliation (idempotent
activate/renew, deterministic per-session-per-minute op ids); `resume_failed` handled;
native dead-air guard (`setFallbackToOriginal`, 2 s, hysteresis, `stall_degraded`); network
work moved off the audio callback onto a bounded queue + sender thread with drop counting.

**Phase B** — state machine `idle → starting → warming → active → stalled → recovering →
stopping → failed` with a 3-strike circuit breaker; Android lifecycle matrix riding the existing
`AvaVoiceAudioPlugin` route handling; per-account device nonce binding; `TranslationEngine`
deprecated for call contexts; `insufficient_tokens` rename with dual-key acceptance.

**Phase C** — mid-call language switch. **True make-before-break**: the native pending-socket
path was made language-aware (`switchLanguage`), so the old session keeps translating until the
new one reaches `setupComplete`. Latest-only queue, sheet debounce, per-account last-used
language warm-up / pre-mint (also the P1 fast start), `switch_gap_ms` telemetry.

---

## 2. Gate verdicts

| # | Gate | Verdict |
|---|---|---|
| 1 | Invariant proven on every failure path | **PASS** (after D-1/D-3/D-4/D-5 fixes + the NEW-1 watchdog) |
| 2 | No duplicate billing under race/restart/renewal | **PASS** — re-derived independently, twice |
| 3 | No audio-derived content in logs or PostHog | **PASS** |
| 4 | Circuit breaker, no unbounded loops | **PASS** |
| 5 | Typecheck / analyze / native compile | **PASS** — zero new errors |
| 6 | Flag sanity (no fake flags) | **PASS** — verified against live prod |
| 7 | Wire contract consistency across 3 layers | **PASS** — no drift; one item unprovable without a live session |
| 8 | Deploy / migration readiness | **BLOCKED ON OWNER** — see §4 |
| 9 | Gemini preview quota + concurrency at launch load | **BLOCKED ON OWNER** |
| 10 | Google data handling (retention, region, training) | **BLOCKED ON OWNER** |

### Evidence

- `npx tsc --noEmit` (worker/): **58 errors — exactly the pre-existing baseline** (52
  `src/workflows/deletion.ts`, 5 `src/routes/api.ts`, 1 `src/lib/dynw/host.ts`). **Zero** in
  `call_translation.ts`, `config.ts`, `index.ts`. The baseline is unrelated to this work but
  **must be cleared before any worker deploy** — the repo rule is that tsc passes first, and a
  green wrangler build proves nothing (esbuild strips types without checking them).
- `flutter analyze`: **0 errors**, 534 infos/warnings — byte-identical to the baseline.
- Java: `:app:compileDebugJavaWithJavac` with Temurin 17 → **BUILD SUCCESSFUL** (re-run with
  `--rerun-tasks` to defeat an UP-TO-DATE false pass).
- Prod flags, read cache-busted from `/api/config` (never from `DEFAULTS`):
  `translationEnabled=false`, `callTranslationEnabled=false`. Dark.

---

## 3. Defects found and fixed

The first audit found six blockers. All were fixed and re-verified against the code.

| ID | Sev | What it was | Fixed in |
|---|---|---|---|
| D-1 | HIGH | `fallbackActive` was one un-owned boolean — a route change or focus blip made Dart re-mute the original **while translation was still dead**. Manufactured dead air, repeatable. | `9fa41811` — owner model: native exclusively owns the dead-air fallback, Dart owns named reasons and may lower only its own; `stats.fallbackActive` is ground truth |
| D-4 | HIGH | A timed-out switch left the plugin's pending socket wedged, which blocked every later switch **and silently disabled provider resume for the rest of the call**. | `85d7c566` + `9fa41811` — native `cancelSwitch`, called on every abandon path |
| B-2 | HIGH | `/start` rate limit of 10/h predated the warm-up; ~5 language-sheet opens per hour locked the payer out. | `403bbee1` — split buckets, 60/h real + 120/h warm-up, both KV-tunable |
| D-5 | MED-HIGH | `onClosed` lacked `onFailure`'s pending-vs-live discrimination, so a provider refusing a switch token with a close frame killed a working translation. | `85d7c566` |
| D-6 | MED-HIGH | A crash left the row `active`; the 409 handed back a `session_id` that Dart discarded, making translation unstartable for the rest of the call. | `9fa41811` — release-then-retry once, guarded against looping |
| D-3 | MED | Non-volatile track cache + stale lookup could leave the call **permanently silent** after teardown during a route change. | `85d7c566` |
| D-2 | MED | Language switches counted as stalls → false "quality is unstable" warning, and poisoned the p95 telemetry the launch gate reads. | `85d7c566` — dead-air-only stall stats, separate `fallbackCount` |
| D-7 | MED | `prepare`'s uncancelled 15 s timer killed a *second* prepare — exactly the warm-up→start shape. | `85d7c566` — generation-scoped |
| D-8 | LOW-MED | `dispose()` wrote to disposed notifiers → spurious `$exception` on every teardown. | `9fa41811` |
| L-1 | LOW | `protocol_error` carried `e.getMessage()` from a JSON parse of a frame containing **base64 audio**. | `85d7c566` — fixed category strings only |
| L-6 | LOW | The resume loop was bounded by an hourly rate limit, not the circuit breaker. | `9fa41811` — `kMaxResumesPerCall = 6` |
| L-2…L-5 | LOW | `billed_tokens` gaps, a dead repair branch, no `call_ref` join key. | `403bbee1` + `9fa41811` |
| **NEW-1** | MED | Found by the *second* audit: a switch reaching `setupComplete` then producing no audio held the fallback forever — user hears the original, pill says "translating", **and billing continues at 5 Tokens/min indefinitely**. | `464ddaa6` — 5 s ceiling on the `switching` reason + a 20 s dead-translation watchdog that stops cleanly and cancels the meter |

### Known residuals (accepted, not blockers)

- **NEW-2 (LOW)** — after audio-focus loss the native guard re-mutes ~1 s later even though the
  OS is still ducking. Pre-existing; a timer that lowered it would manufacture the dead air D-1
  fixed.
- **NEW-3 (LOW)** — the stuck-`activating` repair relaxes the source-lease staleness test.
  Billing is provably safe (op id replay is a true no-op); ownership, nonce, lease identity,
  `source_ready` and live-participant checks all still gate it.
- **Billing edge** — a stall beginning near a minute boundary can incur **one** final 5-token
  charge before the stop lands. Bounded at one.
- **Unprovable without a live session** — the worker's `liveConnectConstraints` pin
  `sessionResumption: {}` while the resume path sends `{handle:…}`. Whether Google treats the
  constraints as exact-match or as pinned settings determines whether resume works at all. Only
  a live `setupComplete` *and* a live resume settle it.

### Owner decision recorded (2026-08-04)

**Translation is PAID-ONLY.** `chargeMinute` deliberately omits `allow_free` and the gate reads
the paid `.balance`, so the 100-token welcome grant is not spendable here. This is the documented
exception to the general "no premium gating / 100 free tokens" rule. Both sites carry comments
saying so, to stop a future agent "fixing" it. The 402 now returns `paid_only`, `balance` and
`spendable`, and the copy says *"your remaining N Tokens are free/bonus Tokens, which it cannot
use"* rather than a visibly wrong "you have no tokens".

---

## 4. Ordered ship checklist — OWNER ACTIONS

Production is running a **stale, partial** version of this feature: `/start` and `/token` answer
401 (live) but `/language` 404s (absent), and `translation_call_sessions` **has never been
created in prod D1**. It is inert only because the flags are false. **Flipping a flag before the
migrations land 500s every session.**

1. **Push.** The unpushed stack has an unrelated `[CHAT-MENTIONS-1] a76a8905` interleaved
   between the CALL-TRANSLATE commits, so `git_safe_push.py` will correctly refuse until that
   agent pushes their own work first.
2. **Clear the 58-error tsc baseline** in `deletion.ts` / `api.ts` / `host.ts`. Unrelated to this
   feature, but it blocks the deploy rule.
3. **Apply migrations to staging, in this exact order** — the second is an `ALTER TABLE` and
   fails if the first hasn't run:
   `2026-08-03-call-translation.sql` → `2026-08-04-call-translation-device-nonce.sql`
4. **Confirm `git status --porcelain worker/` is empty** immediately before deploying. Wrangler
   bundles the working tree, not HEAD — that is how the stale prod deploy happened.
5. `scripts/cf.sh worker deploy` with `.avatok-target=staging`. Never bare wrangler.
6. **Trigger a CI build** (owner only). The native plugin compiles locally but has never been
   through CI, and nothing is testable until it is on a device.
7. **Flip staging flags one at a time**, verifying each cache-busted and allowing ~60 s for colo
   propagation: `translationEnabled=true`, then `callTranslationEnabled=true`.
8. **Run the 16-case device script** (§5). Every case must pass.
9. **Obtain the two external confirmations** — Gemini preview quota/concurrency at expected
   launch load, and Google's data handling for the paid tier (retention of streamed audio,
   regional processing for EU voice, training exclusion). The second gates the Play data-safety
   declaration as much as it gates launch.
10. **Prod, only on explicit instruction**: merge `staging`→`main`, apply both migrations to prod
    D1 in the same order, deploy with `ALLOW_PROD=1` from a clean tree, internal-track build,
    then flip prod flags one at a time while watching stall-rate and first-audio telemetry.

---

## 5. Device test script — two physical Androids, staging

Both phones on a build containing the native changes, different accounts. **Note both emails** —
telemetry is pulled by email and this is a two-sided feature. Phone A needs **≥50 Tokens of
topped-up (paid) balance**; welcome-grant tokens will not work, by design.

**The one thing every test really checks: whatever goes wrong, you can still hear each other and
the call does not drop.**

| # | Test | Steps | PASS looks like |
|---|---|---|---|
| 1 | es→hi, A pays, audio | A calls B. B speaks Spanish. A taps Translate → Hindi. | Within ~5 s A hears Hindi. Pill shows "5/min · 5 Tokens · 0:0x", timer counting. |
| 2 | Other direction | B calls A, B taps Translate → Spanish, A speaks English. | B hears Spanish. B billed, A not. |
| 3 | Callee pays | A calls B; **B** taps Translate. | Works, and **B** is billed. B's Tokens drop, A's don't. |
| 4 | Both at once | A and B both start Translate, different languages. | Both pills active and stay active. Both billed separately. Neither kills the other. |
| 5 | Video | Repeat test 1 with camera on. | Same result; video never freezes or stutters. |
| 6 | Mid-call switch | With translation running, tap the **language chip** left of Stop, pick another language. | "Switching to X…" then the new language. You may hear the real person for a moment — that is correct. Tokens number does **not** jump. |
| 7 | Switch twice quickly | Do test 6 twice inside a minute. | Both work, and **no** "Translation quality is unstable" warning (that was defect D-2; report it if it appears). |
| 8 | Switch 3× fast | Pick three different languages as fast as you can. | You end on the **last** one. Not three in a row. |
| 9 | 3G stall + recover | While B talks continuously, set A to 2G/3G only (or walk into a lift). | Within ~2 s A hears **B's real voice**, pill says "Translator catching up…". Restore network → translation resumes on its own. **You must never hear silence.** |
| 10 | Route change during a stall | Repeat 9; while "catching up" shows, plug/unplug wired headphones or connect Bluetooth. | You keep hearing the real voice until translation returns. (This was defect D-1 — going silent again ~1.5 s after the headphone change is the bug.) |
| 11 | Dead switch | Hard to force deliberately — watch for it: a switch that completes but produces no audio. | Within ~30 s translation stops by itself with "Translation stopped, your call is still connected", and **billing stops**. It must never keep charging silently. |
| 12 | Funds run out | Start A on exactly **10 Tokens** paid, run 3 minutes. | Translation stops, dialog appears, **you can still hear each other in the original language**. Call does not drop. |
| 13 | Kill and relaunch | Force-stop AvaTOK on A mid-session, reopen, return to the call. | You can start translation again. (Defect D-6 was that you couldn't.) The call must still be alive and audible either way. |
| 14 | Incoming phone call | Ring A's normal number mid-translation. | Translation stops cleanly; after dismissing, the AvaTOK call is still there and audible. |
| 15 | Screen off | Lock A's screen 60 s mid-translation. | Keeps working, keeps billing, nothing resets. |
| 16 | Stop / hang up | Tap Stop translation; then on another call, have B hang up mid-translation. | Stop → immediately hear the real voice, billing stops, pill returns to "Translate". Hang up → normal screen, no error dialog, no stuck pill, no further charges. |

Afterwards, an agent must check A's Token ledger: **one charge per started minute, no minute
charged twice.** That is the billing gate's real proof.

---

## 6. Out of scope (unchanged)

Conferences (the PCM-source interface is preserved for the future SFU case) · captions /
transcripts UI · any price or tier change (5 Tokens per started minute is final) · peer-consent
UI (owner: none) · iOS.
