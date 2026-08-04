# HANDOVER — Call Handover-Survival & Voice Clarity (CALL-SURVIVE program)

**Date:** 2026-08-04 · **From:** audit/implementation session (Fable) · **Status:** P0+P1 shipped to `main` + staging worker; client build + prod promotion pending; follow-up batch specced below.

**Read first:** `Specs/CALL-QUALITY-AUDIT-2026-08-04.md` (the full audit, evidence, and decision log). Graphiti episodes under `group_id="proj_avaflutterapp"`: search "CALL-SURVIVE". This file is the execution handover.

---

## 1. Why this exists (60 seconds)

Prod incident 2026-08-04: tester s.rgoavilla@gmail.com ("tiger showoff"), on mobile data while moving, called hdavy2002@gmail.com. His WiFi↔cell handovers killed the audio; the recovery system (ICE recovery → relay migration) timed out twice and **the app ended live calls itself** (`call_ended reason=relay_migration_timeout`) after ~50s of dead air. Separately, unbounded jitter buffering (200–745 ms) made him sound "distant/underwater". Calls examined: `avatok-e23e3117`, `avatok-999a650b`, `avatok-10d4696b`, both sides build 10503.

**Program goal:** a call survives lifts, trains, WiFi↔cell handovers — audio resumes in seconds, the app never hangs up on two humans who are still holding.

## 2. What is ALREADY DONE (do not redo)

| Commit | Scope |
|---|---|
| `47784328` `[CALL-SURVIVE-1]` | Retry ladder (2/4/8/16/30s, max `callRecoveryMaxAttempts`) replaces every recovery-failure call-kill; one-migration cap removed for failures (burns only on success, client `_migrationAttempted` + DO); interface-change abort+re-gather (`_abortInFlightRecoveryForNetChange`); stall detection 10s→5s; deadlines remote-config (12s recovery / 8s migration); DO elects only live-WS recovery offerer; jitter buffer bounded (`audioJitterBufferMaxPackets:50` + `fastAccelerate` on all 3 PC sites — verified real flutter_webrtc 0.12.12 keys); Opus unified 56k via `core/audio_tuning.dart` (40k copy deleted); mic constraints de-duped; telemetry: `est_mos` (concealment-aware E-model), `call_quality_poor`/`recovered`, `call_network_handover`, `call_recovery_retry_scheduled`/`aborted`/`exhausted` |
| `3bb6829c` `[CALL-SURVIVE-2]` | WS give-up is media-aware: at the 30s deadline, probe inbound RTP bytes over 2s (`_probeInboundAudioAlive`); media alive → `call_ws_down_media_alive` + re-arm + keep retrying; `reconnect_failed` now requires signaling AND media dead. 2s debounce + `checkConnectivity()` re-confirm on interface-change recovery; flaps that net out cause no action |

**Deployed:** staging worker version `0435fd9a` carries the DO + config changes. Flags `callRecoveryDeadlineSec`/`callMigrationDeadlineSec`/`callRecoveryMaxAttempts` proven settable via `scripts/flags.sh` on staging (defaults 12/8/5 serving; no overrides left in KV).
**NOT deployed:** prod worker (old DO behavior still live). **No client build** carries any of this yet — phones behave exactly as in the incident until one ships.

### Key files (client)
- `app/lib/core/calls/call_session.dart` — everything: retry ladder (`_scheduleSurvivalRetry`, `_survivalRetries`, `_kSurvivalBackoffSec`), net listener + debounce (`_classifyNet`, `_netDebounceTimer`, `_lastNetClass`), abort (`_abortInFlightRecoveryForNetChange`), media-aware give-up (`_onReconnectGiveUpDeadline`, `_probeInboundAudioAlive`), watchdog trigger (`_mediaStaleCount == 1`), PC config knobs in `_newPC` + both migration PC sites, `_tuneOpusSdp` → delegates to shared tuner.
- `app/lib/core/audio_tuning.dart` — the ONLY Opus tuner (56k, FEC on, DTX off) + `avaMicConstraints()`.
- `app/lib/core/call_telemetry.dart` — `_estimateMos` fed `max(loss, concealment)`; `_qualityPoorActive` hysteresis (poor <3.0, recovered >3.4); `est_mos` on `call_media_health`.
- `app/lib/core/remote_config.dart` — the 3 numeric getters.

### Key files (worker)
- `worker/src/do/call_room.ts` — `handleRecoveryRequest` (offerer must be in live `ids`), `relay-migrate-offer` (last-writer-wins attemptId, `migrationUsed` gate deleted but still written for storage compat).
- `worker/src/routes/config.ts` — interface + DEFAULTS + `numericKeys` for the 3 tunables.

### Design invariants — do not regress
1. **Terminal call end = explicit hangup, OR (signaling dead AND media dead), OR DO dead-peer/away expiry.** Nothing else ends a connected call. No new `_endWith` on any recovery path.
2. `_migrationAttempted` is set ONLY by a completed successful migration (then `_relayForced=true`; further recovery = ICE restart on the relay PC). Never set it on failure.
3. Every remote-config key: interface + DEFAULTS (+ `numericKeys` if numeric) in the SAME change, then prove with `flags.sh set` (fake-flag rule, CLAUDE.md).
4. `Connectivity()` is a hint that *starts* recovery; only observed playout health *completes* it.
5. Recovery machinery stays gated behind `callIceRecoveryV2` / `callRelayMigrationV1` (both ON in prod KV).

---

## 3. IMMEDIATE NEXT STEPS (owner-gated — do these in order)

### Step A — Staging client build (owner must ask; never trigger unprompted)
`main` holds the commits; staging builds must come from the `staging` branch (android.yml guard). Sync first — **the tree is shared; do not switch branches with others' uncommitted work present.** Safe path: `git fetch && git push origin main:staging` only if staging is an ancestor (fast-forward); otherwise merge main→staging deliberately. Then, ONLY on the owner's request:
```bash
gh workflow run android.yml --ref staging -f environment=staging -f artifact=apk -f play_track=none
```

### Step B — Vehicle test (the tiger scenario)
Two phones on the staging build, one driving/walking between WiFi and cell. Pass criteria: audio resumes < ~5s per handover; call NEVER ends by itself; PostHog shows `call_network_handover` → `call_recovery_*` → `call_recovery_completed` chains and **zero** `relay_migration_timeout` call-ends. Emulator pre-check: `scripts/dev-emulator.sh`, toggle airplane/wifi in the emulator, watch `scripts/dev-emulator.sh log`.

### Step C — Prod worker deploy (pair with the client rollout, not before B passes)
```bash
cd worker && npx tsc --noEmit            # MUST be green (esbuild won't check types)
git status worker/                       # MUST be empty (wrangler bundles the TREE)
ALLOW_PROD=1 scripts/cf.sh worker deploy # after setting .avatok-target or with owner's explicit prod say-so
```
Verify: cache-busted `https://api.avatok.ai/api/config?cb=$RANDOM` shows `callRecoveryDeadlineSec:12` etc. Remember 60s edge cache + ~60s colo propagation — probe repeatedly before concluding anything.

### Step D — Ship to internal track
Only on the owner's explicit "ship it" (that phrase = build main → prod → both artifacts → internal track → approve the gate yourself per CLAUDE.md; check for an already-queued run with identical `app/` first).

### Measure (7 days post-rollout, PostHog by `$app_build`)
`relay_migration_timeout` ends → ~0 · handover recovery p50 <5s (call_recovery_started→completed) · `jitter_buffer_ms_interval` p95 <200 · `est_mos` >3.5 at <15% loss · `call_recovery_exhausted` and `call_ws_down_media_alive` counts (should be rare; investigate if hot).

---

## 4. FOLLOW-UP BATCH (next week — each behind its own flag, own issue id)

Ordered by value/effort. All client-side unless noted. Full rationale in the audit doc ("Current proposal" + "Reviewed and REJECTED" — read the rejected list before proposing anything from it: TURN region selection (anycast — nothing to build), `goog*` GCC knobs (removed from libwebrtc — silent no-ops), 50/50 A/B (flags are global; measure by `$app_build`), RSSI-based adaptation (not exposed; BWE covers it), MOS/PESQ audio analysis (est_mos suffices), iOS CallKit (Android-only today).

1. **`[CALL-QOS-1]` Bandwidth-estimation bitrate step-down.** Read `availableOutgoingBitrate` from candidate-pair stats in the existing 5s sampler (`call_telemetry.dart` already collects `_availOutKbps`). When estimate < currentBitrate×1.5 OR sustained loss: step sender maxBitrate DOWN 56→40→32k via `RTCRtpSender.setParameters`; step up only when loss clears AND RTT/jitter stable. **Direction matters: never raise bitrate into loss — cellular loss is congestion.** Thresholds as numeric remote-config keys (declare properly). Flag: `callQosAdaptV1`.
2. **`[CALL-CELLX2-1]` Cellular↔cellular preset.** Each side signals its net class (piggyback on existing signaling, e.g. in the join/welcome or a tiny `net-class` frame via the DO's generic relay). When BOTH cell: that device's own PC relay-only (`iceTransportPolicy:'relay'`), 40k cap, higher initial jitter target. Reuses existing levers; it's a preset, not machinery. Flag: `callCellPresetV1`.
3. **`[CALL-QUI-1]` Quality indicator UI.** Green/yellow/red dot on the call screen from `est_mos` (already computed every 5s; expose via the existing net-HUD `_publishNetStats` ValueNotifier path); red → one-line "Poor network — try WiFi" hint; extend the `reconnecting` phase label with "Network changing…" when the last `call_network_handover` was <5s ago. The wallet lesson applies: **run it on the emulator in release-ish conditions before calling it done** (memory: stretch-Row killed a screen only in release).
4. **`[CALL-RED-1]` Audio RED experiment (P3).** Verify RFC-2198 RED for Opus is negotiable on both builds first (SDP `a=rtpmap red`); only then enable during loss bursts on the relay path. If SDP munging gets hairy, drop it — FEC already covers most of this.
5. **Video degradation under loss** — reduce res/fps then pause video, keep audio (extends `_preferResolutionOnVideo`). Audio always wins.
6. **Extended test matrix** (with #3's UI to observe): captive-portal WiFi, VPN on/off, BT headset connect/disconnect, Doze/battery-saver, airplane toggles, 3G/4G/5G, flaps every few seconds, BOTH peers switching simultaneously.

## 5. Project traps that will bite you (hard-won; respect them)
- **Git:** commit via `python3 scripts/git_safe_commit.py "msg" <explicit paths>`; push via `scripts/git_safe_push.py <ISSUE-ID>`. Never bare `git add/commit/push`. One issue per commit. Host filesystem via Desktop Commander, not sandbox mounts. Never trigger builds unasked.
- **Worker:** never bare `wrangler` (top-level toml = PROD). `scripts/cf.sh` + `.avatok-target`. Commit worker source BEFORE deploying. `tsc --noEmit` before every deploy. Sandbox npm breaks host workerd (memory: toolchain gotchas) — run worker toolchain on the HOST.
- **Flags:** never state an effective value from `DEFAULTS` — read prod KV / cache-busted `/api/config`. New keys: interface+DEFAULTS+numericKeys same change + `flags.sh` proof.
- **Telemetry:** always resolve `$app_build` before diagnosing a report (memory: stale-build wrong investigation). Ask whose email before pulling PostHog; two-sided bugs need both emails (`s.rgoavilla@gmail.com` is tiger).
- **Emulator:** JDK 17 (not the JBR), `python3 tool/postcreate.py` after android/ changes, `dart run build_runner build`, `local.properties`/`google-services.json` are gitignored.
- **Unawaited worker telemetry on error paths gets dropped** (memory) — `ctx.waitUntil` or await before early returns.
- **Graphiti:** every read/write with `group_id="proj_avaflutterapp"`, no exceptions. Update it when you finish anything.

## 6. Open questions parked with the owner
- Hard time-cap on eternal "reconnecting" vs current stay-alive-forever-while-media-or-signaling-lives (current behavior chosen deliberately; revisit if `call_recovery_exhausted` shows zombie calls).
- When to promote the DO changes to prod (Step C is paired with the client rollout by design — the protocol is backward-compatible either way, but pairing keeps behavior symmetric).
