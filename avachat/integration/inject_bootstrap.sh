#!/usr/bin/env bash
# Makes 0xchat-app-main build + run against AvaChat, WITHOUT committing changes
# into the 0xchat submodule. CI and local builds run this after checkout.
# Idempotent. Uses python3 (portable; BSD sed/perl mangle multi-line inserts).
#
# Edits applied to external/0xchat-app-main:
#   1. lib/main.dart  — import avachat; `await AvaChatBootstrap.init();` at start
#      of main(); `await AvaChatIdentity.instance.ensureLoggedIn();` right after
#      `await AppInitializer.shared.initialize();` (DB must be ready first).
#   2. pubspec.yaml   — `avachat` path dep; pin image_gallery_saver_plus 4.0.1.
#   3. android/app/build.gradle — abiFilters 'arm64-v8a'; new applicationId.
#   4. android/app/google-services.json — package_name -> new app id (keeps the
#      google-services plugin happy; real FCM is a later seam).
set -euo pipefail

APP="${1:-external/0xchat-app-main}"
APP_ID="${AVACHAT_APP_ID:-ai.avatok.avachat}"

python3 - "$APP" "$APP_ID" <<'PY'
import sys, os
app, app_id = sys.argv[1], sys.argv[2]
def read(p): return open(p, encoding="utf-8").read()
def write(p, s): open(p, "w", encoding="utf-8").write(s)

# 1: main.dart
main = os.path.join(app, "lib/main.dart")
s = read(main)
if "package:avachat/avachat.dart" not in s:
    s = s.replace("import 'dart:async';",
                  "import 'dart:async';\nimport 'package:avachat/avachat.dart';", 1)
if "AvaChatBootstrap.init" not in s:
    s = s.replace("void main() async {",
                  "void main() async {\n  await AvaChatBootstrap.init();", 1)
if "ensureLoggedIn" not in s and "await AppInitializer.shared.initialize();" in s:
    s = s.replace("await AppInitializer.shared.initialize();",
                  "await AppInitializer.shared.initialize();\n    await AvaChatIdentity.instance.ensureLoggedIn();", 1)
write(main, s)

# 2: pubspec.yaml
pub = os.path.join(app, "pubspec.yaml")
cur = read(pub)
out, has_dep, has_ovr = [], "avachat" in cur, "image_gallery_saver_plus: 4.0.1" in cur
for ln in cur.split("\n"):
    out.append(ln)
    if ln.rstrip() == "dependencies:" and not has_dep:
        out += ["  avachat:", "    path: ../../avachat"]; has_dep = True
    elif ln.rstrip() == "dependency_overrides:" and not has_ovr:
        out += ["  image_gallery_saver_plus: 4.0.1"]; has_ovr = True
write(pub, "\n".join(out))

# 3: build.gradle — abiFilters + applicationId
g = os.path.join(app, "android/app/build.gradle")
gs = read(g)
if "abiFilters 'arm64-v8a'" not in gs:
    gs = gs.replace("    multiDexEnabled true\n",
        "    multiDexEnabled true\n    ndk {\n      abiFilters 'arm64-v8a'\n    }\n", 1)
gs = gs.replace('applicationId "com.oxchat.nostr"', 'applicationId "%s"' % app_id)
write(g, gs)

# 4: google-services.json — package_name must contain a client matching app id
gj = os.path.join(app, "android/app/google-services.json")
if os.path.exists(gj):
    js = read(gj).replace("com.oxchat.nostr", app_id)
    write(gj, js)
print("inject: done (app_id=%s)" % app_id)
PY
