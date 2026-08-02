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
MARKER = "CALL-NATIVE-DECLINE-1"
UI_MARKER = "CALL-NOTIF-OWNER-1"
ANCHOR = """                    callkitNotificationManager?.clearIncomingNotification(data, false)
                    sendEventFlutter(CallkitConstants.ACTION_CALL_DECLINE, data)"""
REPLACEMENT = """                    callkitNotificationManager?.clearIncomingNotification(data, false)
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
        if text.count(ANCHOR) != 1:
            raise SystemExit("flutter_callkit_incoming decline handler changed; refusing to build without revalidating the native bridge")
        source.write_text(text.replace(ANCHOR, REPLACEMENT))

    ui_source = root / "CallkitNotificationManager.kt"
    ui_text = ui_source.read_text()
    if UI_MARKER not in ui_text:
        if ui_text.count(UI_ANCHOR) != 1:
            raise SystemExit("flutter_callkit_incoming notification tap path changed; refusing to build without revalidating the branded UI bridge")
        ui_source.write_text(ui_text.replace(UI_ANCHOR, UI_REPLACEMENT))
    print(f"locked native decline + branded notification ownership into {root}")


if __name__ == "__main__":
    main()
