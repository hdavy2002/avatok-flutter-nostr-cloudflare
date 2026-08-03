// [CALL-NATIVE-DECLINE-1] Locks the complete killed-app notification path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("killed-app native decline contract", () => {
  it("carries a distinct short-lived capability from call admission to FCM", () => {
    const api = read("worker/src/routes/api.ts");
    const types = read("consumers/src/types.ts");
    const fcm = read("consumers/src/fcm.ts");
    expect(api).toContain("const nativeActionToken = crypto.randomUUID()");
    expect(api).toContain("nativeActionToken, tokenExpiresAt: expiresAt");
    expect(types).toContain("nativeActionToken?: string");
    expect(fcm).toContain("{ nativeActionToken: msg.nativeActionToken }");
  });

  it("routes the capability through the DO-owned FSM, never a client status", () => {
    const router = read("worker/src/index.ts");
    const room = read("worker/src/do/call_room.ts");
    expect(router).toContain("/api/call/native-decline");
    expect(room).toContain('if (type === "native-decline")');
    expect(room).toContain('this.runCommand(callId, "decline_call"');
    expect(room).toContain("authenticatedUid: session.callee_uid");
  });

  it("fails Android builds unless the killed-process bridge is patched", () => {
    const workflow = read(".github/workflows/android.yml");
    const patcher = read("scripts/patch_callkit_native_decline.py");
    const bridge = read("app/android/app/src/main/kotlin/ai/avatok/avatok_call/NativeCallDeclineBridge.kt");
    expect(workflow).toContain("patch_callkit_native_decline.py app");
    expect(patcher).toContain("refusing to build without revalidating the native bridge");
    expect(patcher).toContain("CALL-NATIVE-DECLINE-2");
    expect(patcher).toContain("if (!suppressSyntheticDecline)");
    expect(patcher).toContain("CALL-NATIVE-PROGRAMMATIC-END-1");
    expect(patcher).toContain('getMethod("markProgrammaticEnd"');
    // [CALL-REL-R4-NATIVE] The programmatic-end marker MUST be applied to
    // FlutterCallkitIncomingPlugin.kt, not the broadcast receiver: endCall /
    // endAllCalls are MethodChannel handlers, and by the time the receiver sees
    // ACTION_CALL_DECLINE the "human or us" distinction is already gone. The
    // first version of this patch targeted the receiver, so the anchor matched
    // zero times and the build died on the guard (run 30814336459).
    expect(patcher).toContain('plugin_source = root / "FlutterCallkitIncomingPlugin.kt"');
    expect(patcher).toContain("plugin_text.count(PROGRAMMATIC_END_ANCHOR)");
    // That file imports neither Log nor defines TAG, unlike the receiver.
    expect(patcher).toContain('android.util.Log.e("AvaTOK"');
    expect(patcher).not.toContain("Log.e(TAG, \"Native programmatic-end guard unavailable\"");
    expect(bridge).toContain("enqueueUniqueWork");
    expect(bridge).toContain("fun markProgrammaticEnd");
    expect(bridge).toContain("wasProgrammaticEnd(context, callId)");
    expect(bridge).toContain("fun shouldSuppressProgrammaticDecline");
    expect(bridge).toContain("api-staging.avatok.ai");
  });

  it("never broadcasts a native decline after the callee leg is accepted", () => {
    const state = read("worker/src/lib/call_state.ts");
    const api = read("worker/src/routes/api.ts");
    expect(state).toContain('s.session_state === "connected" || s.callee_leg_state === "accepted" ||');
    expect(state).toContain("CALLEE_TERMINAL.has(s.callee_leg_state)");
    expect(api).toContain('"call_native_decline_ignored"');
    expect(api).toContain('"call_already_advanced"');
  });

  it("passes the capability into the native CallKit bundle", () => {
    const push = read("app/lib/push/push_service.dart");
    expect(push).toContain("'nativeActionToken': d['nativeActionToken']");
    expect(push).toContain("'nativeDeclineUrl': kNativeCallDeclineUrl");
  });

  it("locks Android incoming calls to one branded notification and one ringtone", () => {
    const patcher = read("scripts/patch_callkit_native_decline.py");
    const activity = read("app/android/app/src/main/kotlin/ai/avatok/avatok_call/MainActivity.kt");
    const params = read("app/lib/core/calls/callkit_params.dart");
    const push = read("app/lib/push/push_service.dart");
    expect(patcher).toContain('action = \\"avatok.incoming_call_tap\\"');
    expect(activity).toContain('incomingTapChannelName = "avatok/incoming_call_tap"');
    expect(params).toContain("ringtonePath: 'ringtone_default'");
    expect(push).not.toContain("_showBrandedIncomingFsi(d)");
    // One declaration + the foreground branch that deliberately suppresses
    // CallKit. A third occurrence would reintroduce two simultaneous players.
    expect(push.match(/_startRingtoneFallback\(/g)).toHaveLength(2);
    expect(readFileSync(resolve(root, "app/android/app/src/main/res/raw/ringtone_default.mp3")))
      .toEqual(readFileSync(resolve(root, "app/assets/audio/catalog/classic.mp3")));
  });
});
