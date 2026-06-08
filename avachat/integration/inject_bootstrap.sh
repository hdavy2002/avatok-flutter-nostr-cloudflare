#!/usr/bin/env bash
# Makes 0xchat-app-main build against AvaChat, WITHOUT committing changes into the
# 0xchat submodule. CI and local builds run this after checkout. Idempotent.
# Uses python3 (portable; macOS BSD sed/perl mangle multi-line inserts).
#
# Applies four edits to external/0xchat-app-main:
#   1. lib/main.dart        — import avachat + `await AvaChatBootstrap.init();`
#   2. pubspec.yaml         — add `avachat` path dependency
#   3. pubspec.yaml         — pin image_gallery_saver_plus 4.0.1 (5.0.0 needs Dart 3.10;
#                             Flutter 3.29.3 ships Dart 3.7.2)
#   4. android/app/build.gradle — abiFilters 'arm64-v8a' (single-ABI APK)
set -euo pipefail

APP="${1:-external/0xchat-app-main}"

python3 - "$APP" <<'PY'
import sys, io, os
app = sys.argv[1]
def read(p): return open(p, encoding="utf-8").read()
def write(p, s): open(p, "w", encoding="utf-8").write(s)

# 1 + 2: main.dart
main = os.path.join(app, "lib/main.dart")
s = read(main)
if "package:avachat/avachat.dart" not in s:
    s = s.replace("import 'dart:async';",
                  "import 'dart:async';\nimport 'package:avachat/avachat.dart';", 1)
if "AvaChatBootstrap.init" not in s:
    s = s.replace("void main() async {",
                  "void main() async {\n  await AvaChatBootstrap.init();", 1)
write(main, s)

# pubspec.yaml: avachat dep + image override
pub = os.path.join(app, "pubspec.yaml")
lines = read(pub).split("\n")
out, has_dep, has_ovr = [], "avachat" in read(pub), "image_gallery_saver_plus: 4.0.1" in read(pub)
for ln in lines:
    out.append(ln)
    if ln.rstrip() == "dependencies:" and not has_dep:
        out += ["  avachat:", "    path: ../../avachat"]; has_dep = True
    elif ln.rstrip() == "dependency_overrides:" and not has_ovr:
        out += ["  image_gallery_saver_plus: 4.0.1"]; has_ovr = True
write(pub, "\n".join(out))

# 4: build.gradle abiFilters
g = os.path.join(app, "android/app/build.gradle")
gs = read(g)
if "abiFilters 'arm64-v8a'" not in gs:
    gs = gs.replace("    multiDexEnabled true\n",
        "    multiDexEnabled true\n    ndk {\n      abiFilters 'arm64-v8a'\n    }\n", 1)
    write(g, gs)
print("inject: done")
PY
