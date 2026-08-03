// [CALL-REL-R4 2026-08-03] Regression guards for the call-reliability round-4
// remediation. Each test here exists because production telemetry proved the
// corresponding failure, not because the code looked wrong.
//
// These are deliberately SOURCE-CONTRACT tests in the style of
// native_decline_contract.test.ts. The behaviours they protect span a Cloudflare
// Durable Object, a Flutter client and a Kotlin activity, so there is no single
// runtime in which they could be exercised end-to-end here — but every one of
// them is a cross-file invariant that a well-meaning single-file edit can break
// silently. That is exactly the class of bug that produced round 4.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** Pull `<name> = <digits with optional _ separators>` out of a source file. */
function numericConstant(source: string, pattern: RegExp): number {
  const m = source.match(pattern);
  if (!m) throw new Error(`constant not found for ${pattern}`);
  return Number(m[1].replace(/_/g, ""));
}

// ─────────────────────────────────────────────────────────────────────────────
// R4-2 — the receptionist reconnect deadline race
//
// Three prod sessions (avatok-04a1fa01, avatok-25b3e99e, avatok-f0220ffb)
// closed 1006 and finalized `caller_reconnect_timeout` at exactly +8 s, because
// the server's grace and the client's total retry budget were BOTH 8 s. These
// calls had already reached Ava, so no amount of decline-race fixing prevents
// them. The margin is the fix, and the margin is what this locks.
// ─────────────────────────────────────────────────────────────────────────────
describe("R4-2: receptionist reconnect deadlines cannot race", () => {
  it("server grace is strictly greater than the client's total retry budget", () => {
    const server = read("worker/src/do/reception_room.ts");
    const client = read("app/lib/core/receptionist_call.dart");

    const serverGraceMs = numericConstant(
      server,
      /RECONNECT_GRACE_MS\s*=\s*([\d_]+)/,
    );
    const clientBudgetMs = numericConstant(
      client,
      /maxBudgetMs\s*=\s*([\d_]+)/,
    );

    // Strictly greater, not >=. At equality the client's final legal attempt and
    // the server's finalize fire in the same instant and network jitter picks
    // the winner — which is precisely what production did.
    expect(serverGraceMs).toBeGreaterThan(clientBudgetMs);

    // And by a real margin: the last attempt still needs a round trip to land.
    // 3 s is the floor; today's values are 15 s vs 8 s.
    expect(serverGraceMs - clientBudgetMs).toBeGreaterThanOrEqual(3_000);
  });

  it("raising the client budget alone cannot silently consume the margin", () => {
    // Documents the trap for whoever tunes this next: the margin only exists
    // while ONE side is larger. Bumping both by the same amount reintroduces the
    // exact bug. The assertion above is what enforces it; this test names it.
    const client = read("app/lib/core/receptionist_call.dart");
    const clientBudgetMs = numericConstant(client, /maxBudgetMs\s*=\s*([\d_]+)/);
    expect(clientBudgetMs).toBeLessThanOrEqual(12_000);
  });

  it("emits the grace window it actually used, so a timeout is diagnosable", () => {
    const server = read("worker/src/do/reception_room.ts");
    // Without grace_ms on the event, a `caller_reconnect_timeout` in PostHog is
    // indistinguishable from a caller who genuinely never came back.
    expect(server).toContain("grace_ms: graceMs");
    expect(server).toContain("token_remain_ms: remain");
    expect(server).toContain("ava_recept_reconnect_grace_expired");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4-4 — silent alarm-scheduling failure
//
// The single CallRoom alarm owns ring expiry AND away-peer reconnect expiry.
// Cloudflare's at-least-once alarm guarantee only starts once an alarm has been
// SUCCESSFULLY SCHEDULED, so swallowing setAlarm() opts the call out of platform
// retry entirely — a ring that never times out, with no signal anywhere.
// ─────────────────────────────────────────────────────────────────────────────
describe("R4-4: critical alarm scheduling is retryable and observable", () => {
  it("does not swallow setAlarm failures for ring or reconnect deadlines", () => {
    const room = read("worker/src/do/call_room.ts");
    // The old shape. If this ever comes back, the guarantee is gone again.
    expect(room).not.toContain(
      "try { await this.state.storage.setAlarm(Math.min(...candidates)); } catch { /* best-effort */ }",
    );
    expect(room).toContain("const critical = away != null || this.ringDeadline != null");
    expect(room).toContain("if (critical) throw err");
  });

  it("retries once inline before giving up", () => {
    const room = read("worker/src/do/call_room.ts");
    expect(room).toContain("recovered_on_retry");
  });

  it("reports every scheduling failure to telemetry", () => {
    const room = read("worker/src/do/call_room.ts");
    expect(room).toContain("private reportAlarmScheduling");
    expect(room).toContain("kind: `call_alarm_${kind}`");
    expect(room).toContain("set_alarm_failed");
    // Telemetry must never itself break signaling.
    expect(room).toMatch(/reportAlarmScheduling[\s\S]{0,900}best-effort/);
  });

  it("keeps legacy billing best-effort so a refund tick cannot fail a dial", () => {
    const room = read("worker/src/do/call_room.ts");
    // `critical` is deliberately NOT `candidates.length > 0` — a billing-only
    // alarm must not be able to fail call setup.
    expect(room).not.toContain("const critical = candidates.length");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4-3 — cold-start CallRoom token
//
// Not causing failures today (`callRoomAuthEnforced` is false in prod), but it
// is the blocker on ever turning enforcement on: a killed-app accept could reach
// the socket with no credential.
// ─────────────────────────────────────────────────────────────────────────────
describe("R4-3: the CallRoom join token survives process death", () => {
  it("the ring path AWAITS durable persistence", () => {
    const push = read("app/lib/push/push_service.dart");
    const session = read("app/lib/core/calls/call_session.dart");
    expect(session).toContain("Future<void> rememberCallRoomTokenDurable");
    expect(session).toContain("await _persistRoomToken(callId, token)");
    // The FCM background isolate can be torn down the moment its handler
    // returns; an unawaited write here races process death.
    expect(push).toContain("await rememberCallRoomTokenDurable(ringCallId, incomingRoomToken)");
  });

  it("carries the token through CallKit and the Android cold-start payload", () => {
    const push = read("app/lib/push/push_service.dart");
    const main = read(
      "app/android/app/src/main/kotlin/ai/avatok/avatok_call/MainActivity.kt",
    );
    expect(push).toContain("'roomToken': d['roomToken'] ?? ''");
    expect(main).toContain('"roomToken" to (extra["roomToken"] ?: "")');
  });

  it("recovers the token on every accept route", () => {
    const push = read("app/lib/push/push_service.dart");
    // _openCall is the single funnel for CallKit accepts, branded-screen accepts
    // and lock-screen taps.
    expect(push).toContain("call_room_token_recovered");
    expect(push).toContain("roomTokenFor(room).isEmpty");
  });

  it("first non-empty value wins, so recovery cannot clobber a good token", () => {
    const session = read("app/lib/core/calls/call_session.dart");
    expect(session).toContain("bool _depositRoomToken");
    expect(session).toContain("if (_kRoomTokens.containsKey(callId)) return false");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4-B — foreground ring detection
//
// Prod `avatok-cb1618e6` rang with `os_ring_suppressed=false lifecycle=paused`
// on an app the owner had open: Android reports `paused` while it launches
// CallKit's own full-screen-intent activity, so the strict `== 'resumed'` test
// failed and BOTH ring surfaces were registered.
// ─────────────────────────────────────────────────────────────────────────────
describe("R4-B: one ring surface, even while the FSI activity is launching", () => {
  it("declares the kill switch in BOTH the interface and DEFAULTS", () => {
    const config = read("worker/src/routes/config.ts");
    const remote = read("app/lib/core/remote_config.dart");
    // The fake-flag rule: a key the client reads but config.ts does not declare
    // can never be flipped, because putConfig rejects unknown keys.
    expect(config).toMatch(/foregroundRingDetectionV2:\s*boolean;/);
    expect(config).toMatch(/foregroundRingDetectionV2:\s*(true|false),/);
    expect(remote).toContain("_b('foregroundRingDetectionV2', true)");
  });

  it("suppression and the branded push use the SAME foreground reading", () => {
    const push = read("app/lib/push/push_service.dart");
    // If these ever disagree — suppress the OS ring but skip the branded screen
    // — the call rings on no surface at all. That is worse than the bug.
    expect(push).toContain("final appFrontReason = _resolveAppFrontReason(lifecycle)");
    expect(push).toContain("final brandedWillShowInApp = appIsInFront &&");
    expect(push).toContain("if (appIsInFront) {");
    expect(push).not.toContain("if (lifecycle == 'resumed') {\n      // Use the same reservation gate");
  });

  it("requires a live navigator before ever claiming the app is in front", () => {
    const push = read("app/lib/push/push_service.dart");
    expect(push).toMatch(
      /_resolveAppFrontReason[\s\S]{0,600}navigatorKey\.currentState == null\) return null;/,
    );
  });

  it("arms a fallback so a wrong guess is a late ring, never a silent one", () => {
    const push = read("app/lib/push/push_service.dart");
    expect(push).toContain("_verifyForegroundRingOrFallback");
    expect(push).toContain("call_os_ring_fallback_registered");
    // Must not re-post an incoming-call notification for a call the user already
    // accepted — that would recreate the very symptom being fixed.
    expect(push).toMatch(
      /_verifyForegroundRingOrFallback[\s\S]{0,1400}_wasProgrammaticCallkitEnd\(callId\)/,
    );
  });

  it("only relaxes within a short grace of an actual resume", () => {
    const push = read("app/lib/push/push_service.dart");
    const graceMs = numericConstant(push, /_kAppFrontGraceMs\s*=\s*([\d_]+)/);
    // Sized for the FSI-activity launch, not for a user who left the app.
    expect(graceMs).toBeGreaterThan(0);
    expect(graceMs).toBeLessThanOrEqual(3_000);

    const fallbackMs = numericConstant(push, /_kOsRingFallbackDelayMs\s*=\s*([\d_]+)/);
    // A fallback ring has to still be a ring.
    expect(fallbackMs).toBeLessThanOrEqual(2_000);
  });

  it("tracks the last resume from init, not from ring time", () => {
    const push = read("app/lib/push/push_service.dart");
    // An observer only sees transitions after it registers, so arming it lazily
    // at ring time would always report "never resumed" and never relax.
    expect(push).toContain("_AppFrontTracker.I.ensureRegistered()");
    expect(push).toContain("void didChangeAppLifecycleState(AppLifecycleState state)");
  });
});
