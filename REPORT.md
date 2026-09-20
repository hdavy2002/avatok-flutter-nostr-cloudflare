# QUALITY-4K-1 compile-error fix

## Scope

Fixed the two Dart compile errors introduced by commit `70fcf181` [QUALITY-4K-1]
that were breaking the Android CI build on `main`. Touched exactly the two
files named in the task. No behaviour change beyond making the code compile —
the quality feature's logic is unmodified.

## Verification method (no local Flutter/Dart toolchain)

Per this repo's `CLAUDE.md`, the local Flutter/Dart toolchain was deliberately
removed on 2026-09-10 and is not to be reinstalled. `flutter analyze` /
`dart analyze` are both `command not found` on this machine:

```
$ which flutter dart
(nothing)
```

So verification here is by careful reading plus a mechanical paren/brace
balance check (`python3`, no deps) on the edited file, not a real analyzer
run. CI (`typecheck.yml` / `verify.yml` / `android.yml`) is the real compile
net and should be re-run to confirm.

## Fix 1 — `app/lib/core/calls/stream_video_quality_controller.dart:250`

**Bug:** in `_readStats`, the `policy.observe(VideoQualitySample(...))` call
was missing its two closing parens and terminating semicolon. The next line,
`unawaited(refresh());`, was syntactically swallowed as an unterminated
argument list, which is exactly what the parser reports as "Can't find `)` to
match `(`" and, because the parser then tries to recover and treats what
follows as a second positional argument to `observe(...)`, "Too many
positional arguments: 0 allowed, but 1 found" (`VideoQualityPolicy.observe`
takes exactly one `VideoQualitySample` argument).

**Fix:** added the missing `));` after the last named argument
(`videoPaused: serverPaused && !incomingPaused,`), closing `VideoQualitySample(`
and `policy.observe(` and terminating the statement. `unawaited(refresh());`
is now its own statement again, exactly as it reads immediately above the
diff in the surrounding methods (`_readState` already ends its state-change
handling with `unawaited(refresh());` as a separate statement) — this was
clearly the intended shape.

```diff
       videoPaused: serverPaused && !incomingPaused,
+    ));
     unawaited(refresh());
   }
```

Confirmed the file's overall paren/brace counts are now balanced (0/0) with a
plain-text scan; before the fix they were unbalanced by exactly the two
parens added.

## Fix 2 — `app/lib/features/commercial_getstream/commercial_live_gateway.dart`

**Bug:** `_StreamCommercialQualityController.value` (lines ~100-105) and
`.setMode` (lines ~116-121) both `switch` on `VideoQualityMode`, an enum
declared in `app/lib/core/calls/video_quality_policy.dart`. This file only
imported `../../core/calls/stream_video_quality_controller.dart`, which
itself imports `video_quality_policy.dart` but does not `export` it — Dart
imports are not transitive, so `VideoQualityMode` was an unresolved name in
this file. That single missing import explains all three reported symptoms
here:

- **102-104 "Not a constant expression":** the switch-expression case
  patterns (`VideoQualityMode.best => ...` etc.) are enum-constant patterns;
  with the enum type unresolved, the analyzer can't treat them as constant
  patterns.
- **118-120 "The getter 'VideoQualityMode' isn't defined for the type
  '_StreamCommercialQualityController'":** the analyzer's error-recovery path
  for an unresolved bare identifier used as a pattern read it as an implicit
  member access on the enclosing class.
- **101 "switch on VideoQualityMode is not exhaustive, missing
  VideoQualityMode.auto":** exhaustiveness checking couldn't recognize the
  `VideoQualityMode.auto => ...` arm as covering the real enum (which is
  unresolved), even though the source already lists `auto`, `best`, and
  `dataSaver` — all three of the enum's actual members
  (`video_quality_policy.dart:2-12`).

**Fix:** added the direct import:

```diff
 import '../../core/calls/stream_video_quality_controller.dart';
+import '../../core/calls/video_quality_policy.dart';
 import '../../core/config.dart';
```

With `VideoQualityMode` now resolved, both switches are exhaustive as
written (they already cover `auto`, `best`, `dataSaver`, the enum's only
three values — nothing else changed), and the case patterns become valid
constant patterns, resolving all four reported errors.

## What was NOT changed

- No other files were touched.
- No logic, control flow, or public API changed — only two syntactic
  omissions (parens/semicolon, and a missing import) were corrected.
- Did not push to `main` or any branch; work is committed locally on
  `saathum/14-dart-fix` only, via `scripts/git_safe_commit.py` per this
  repo's git protocol.
