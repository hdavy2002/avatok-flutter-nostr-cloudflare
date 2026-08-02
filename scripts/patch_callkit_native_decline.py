#!/usr/bin/env python3
"""Lock the killed-app Decline bridge into flutter_callkit_incoming 2.5.8.

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
    source = package_root(app_dir) / "android/src/main/kotlin/com/hiennv/flutter_callkit_incoming/CallkitIncomingBroadcastReceiver.kt"
    text = source.read_text()
    if MARKER in text:
        print(f"{PACKAGE} killed-app decline bridge already locked")
        return
    if text.count(ANCHOR) != 1:
        raise SystemExit("flutter_callkit_incoming decline handler changed; refusing to build without revalidating the native bridge")
    source.write_text(text.replace(ANCHOR, REPLACEMENT))
    print(f"locked killed-app decline bridge into {source}")


if __name__ == "__main__":
    main()
