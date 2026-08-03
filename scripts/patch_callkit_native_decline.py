#!/usr/bin/env python3
"""Lock AvaTOK's native call contracts into flutter_callkit_incoming 2.5.8.

The upstream receiver targets its PendingIntent explicitly, so an additional app
receiver cannot intercept it. We therefore add one reflection-only call into the
resolved package source. Exact anchors and version checks make plugin upgrades
fail closed until this safety contract is deliberately revalidated.
"""

from __future__ import annotations

import json
import pathlib
import sys
from urllib.parse import unquote, urlparse

PACKAGE = "flutter_callkit_incoming"
VERSION = "2.5.8"
LEGACY_MARKER = "CALL-NATIVE-DECLINE-1"
MARKER = "CALL-NATIVE-DECLINE-2"
PROGRAMMATIC_MARKER = "CALL-NATIVE-PROGRAMMATIC-END-1"
UI_MARKER = "CALL-NOTIF-OWNER-1"
ANCHOR = """                    callkitNotificationManager?.clearIncomingNotification(data, false)
                    sendEventFlutter(CallkitConstants.ACTION_CALL_DECLINE, data)"""
LEGACY_REPLACEMENT = """                    callkitNotificationManager?.clearIncomingNotification(data, false)
                    // [CALL-NATIVE-DECLINE-1] Dart's EventChannel has no sink when the
                    // app is killed. Persist the signed decline natively before the
                    // plugin attempts its best-effort Flutter event.
                    try {
                        val bridge = Class.forName(\"ai.avatok.avatok_call.NativeCallDeclineBridge\")
                        bridge.getMethod(\"enqueue\", Context::class.java, Bundle::class.java)
                            .invoke(null, context, data)
                    } catch (error: Throwable) {
                        Log.e(TAG, \"Native decline bridge unavailable\", error)
                    }
                    sendEventFlutter(CallkitConstants.ACTION_CALL_DECLINE, data)"""
REPLACEMENT = """                    callkitNotificationManager?.clearIncomingNotification(data, false)
                    // [CALL-NATIVE-DECLINE-2] endCall() on an unaccepted ring
                    // manufactures ACTION_CALL_DECLINE. Ask AvaTOK's durable
                    // native guard before either relaying it or exposing it to
                    // any Dart isolate as apparent user intent.
                    var suppressSyntheticDecline = false
                    try {
                        val bridge = Class.forName("ai.avatok.avatok_call.NativeCallDeclineBridge")
                        suppressSyntheticDecline = bridge.getMethod(
                            "shouldSuppressProgrammaticDecline", Context::class.java, Bundle::class.java
                        ).invoke(null, context, data) == true
                        if (!suppressSyntheticDecline) {
                            bridge.getMethod("enqueue", Context::class.java, Bundle::class.java)
                                .invoke(null, context, data)
                        }
                    } catch (error: Throwable) {
                        Log.e(TAG, "Native decline bridge unavailable", error)
                    }
                    if (!suppressSyntheticDecline) {
                        sendEventFlutter(CallkitConstants.ACTION_CALL_DECLINE, data)
                    }"""
PROGRAMMATIC_END_ANCHOR = """                    if (currentCall != null && context != null) {
                        if(currentCall.isAccepted) {"""
PROGRAMMATIC_END_REPLACEMENT = """                    if (currentCall != null && context != null) {
                        // [CALL-NATIVE-PROGRAMMATIC-END-1] endCall() maps an
                        // unaccepted call to ACTION_CALL_DECLINE. Stamp that
                        // manufactured action before broadcasting so AvaTOK's
                        // killed-process decline worker cannot treat it as a tap.
                        try {
                            val bridge = Class.forName("ai.avatok.avatok_call.NativeCallDeclineBridge")
                            bridge.getMethod("markProgrammaticEnd", Context::class.java, String::class.java)
                                .invoke(null, context, currentCall.id)
                        } catch (error: Throwable) {
                            Log.e(TAG, "Native programmatic-end guard unavailable", error)
                        }
                        if(currentCall.isAccepted) {"""
PROGRAMMATIC_END_ALL_ANCHOR = """                    calls.forEach {
                        if (it.isAccepted) {"""
PROGRAMMATIC_END_ALL_REPLACEMENT = """                    calls.forEach {
                        // [CALL-NATIVE-PROGRAMMATIC-END-1] endAllCalls() has the
                        // same unaccepted-call decline mapping as endCall().
                        try {
                            val bridge = Class.forName("ai.avatok.avatok_call.NativeCallDeclineBridge")
                            bridge.getMethod("markProgrammaticEnd", Context::class.java, String::class.java)
                                .invoke(null, context, it.id)
                        } catch (error: Throwable) {
                            Log.e(TAG, "Native programmatic-end guard unavailable", error)
                        }
                        if (it.isAccepted) {"""
UI_ANCHOR = """    private fun getActivityPendingIntent(id: Int, data: Bundle): PendingIntent {
        val intent = CallkitIncomingActivity.getIntent(context, data)
        return PendingIntent.getActivity(context, id, intent, getFlagPendingIntent())
    }"""
UI_REPLACEMENT = """    private fun getActivityPendingIntent(id: Int, data: Bundle): PendingIntent {
        // [CALL-NOTIF-OWNER-1] Both a body tap and Android's full-screen intent
        // enter AvaTOK's MainActivity. The app then renders the one branded UI;
        // the plugin's old green activity is never a competing surface.
        val intent = AppUtils.getAppIntent(context, action = \"avatok.incoming_call_tap\", data = data)
        return PendingIntent.getActivity(context, id, intent, getFlagPendingIntent())
    }"""


def package_root(app_dir: pathlib.Path) -> pathlib.Path:
    config = app_dir / ".dart_tool" / "package_config.json"
    if not config.exists():
        raise SystemExit(f"{config} missing; run flutter pub get first")
    payload = json.loads(config.read_text())
    entry = next((p for p in payload.get("packages", []) if p.get("name") == PACKAGE), None)
    if not entry:
        raise SystemExit(f"{PACKAGE} missing from {config}")
    uri = str(entry.get("rootUri", ""))
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise SystemExit(f"unexpected non-file {PACKAGE} root: {uri}")
    root = pathlib.Path(unquote(parsed.path))
    if root.name != f"{PACKAGE}-{VERSION}":
        raise SystemExit(f"refusing unreviewed {PACKAGE} source: {root.name}; expected {PACKAGE}-{VERSION}")
    return root


def main() -> None:
    app_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "app").resolve()
    root = package_root(app_dir) / "android/src/main/kotlin/com/hiennv/flutter_callkit_incoming"
    source = root / "CallkitIncomingBroadcastReceiver.kt"
    text = source.read_text()
    if MARKER not in text:
        if LEGACY_MARKER in text:
            if text.count(LEGACY_REPLACEMENT) != 1:
                raise SystemExit("legacy native decline hook changed; refusing to upgrade without revalidating the native bridge")
            source.write_text(text.replace(LEGACY_REPLACEMENT, REPLACEMENT))
        else:
            if text.count(ANCHOR) != 1:
                raise SystemExit("flutter_callkit_incoming decline handler changed; refusing to build without revalidating the native bridge")
            source.write_text(text.replace(ANCHOR, REPLACEMENT))

    text = source.read_text()
    if PROGRAMMATIC_MARKER not in text:
        if text.count(PROGRAMMATIC_END_ANCHOR) != 1:
            raise SystemExit("flutter_callkit_incoming endCall handler changed; refusing to build without revalidating the programmatic-end guard")
        if text.count(PROGRAMMATIC_END_ALL_ANCHOR) != 1:
            raise SystemExit("flutter_callkit_incoming endAllCalls handler changed; refusing to build without revalidating the programmatic-end guard")
        source.write_text(
            text.replace(PROGRAMMATIC_END_ANCHOR, PROGRAMMATIC_END_REPLACEMENT)
                .replace(PROGRAMMATIC_END_ALL_ANCHOR, PROGRAMMATIC_END_ALL_REPLACEMENT)
        )

    ui_source = root / "CallkitNotificationManager.kt"
    ui_text = ui_source.read_text()
    if UI_MARKER not in ui_text:
        if ui_text.count(UI_ANCHOR) != 1:
            raise SystemExit("flutter_callkit_incoming notification tap path changed; refusing to build without revalidating the branded UI bridge")
        ui_source.write_text(ui_text.replace(UI_ANCHOR, UI_REPLACEMENT))
    print(f"locked native decline, programmatic-end guard + branded notification ownership into {root}")


if __name__ == "__main__":
    main()
