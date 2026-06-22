/// VoiceBreadcrumb — survives native crashes so we learn what killed the app.
///
/// The voice engine (sherpa-onnx / onnxruntime) runs NATIVE code. If it segfaults
/// (bad model, OOM, ABI), the whole process dies instantly — no Dart `catch`, and
/// PostHog never flushes the pending event. So in-process telemetry is blind to it.
///
/// The fix: write a tiny marker to disk RIGHT BEFORE each risky native call and
/// delete it the moment the call returns. If the app dies mid-call the marker is
/// orphaned; on the NEXT launch [checkAndReport] finds it and reports
/// `voice_crash_recovered {stage, detail, age_ms}` to PostHog — so we finally see
/// the exact native step that crashed. A normal Dart exception is NOT a crash, so
/// [run] clears the marker on a caught error too (only a hard crash leaves it).
library;

import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../analytics.dart';

class VoiceBreadcrumb {
  VoiceBreadcrumb._();

  static const _fileName = 'voice_breadcrumb.json';

  static Future<File> _file() async {
    final d = await getApplicationSupportDirectory();
    return File('${d.path}/ava_voice/$_fileName');
  }

  /// Drop a marker before a risky native call.
  static Future<void> enter(String stage, {String detail = ''}) async {
    try {
      final f = await _file();
      await f.parent.create(recursive: true);
      await f.writeAsString(
        jsonEncode({
          'stage': stage,
          'detail': detail,
          'ts': DateTime.now().millisecondsSinceEpoch,
        }),
        flush: true,
      );
    } catch (_) {/* telemetry must never break the feature */}
  }

  /// Remove the marker once the call returned (crash or not, this is safe).
  static Future<void> clear() async {
    try {
      final f = await _file();
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }

  /// Wrap a native call: marker in, run, marker out. Clears on success AND on a
  /// caught Dart error (those aren't crashes). Only a hard native crash — which
  /// kills the process before [clear] runs — leaves the marker for next boot.
  static Future<T> run<T>(String stage, Future<T> Function() body, {String detail = ''}) async {
    await enter(stage, detail: detail);
    try {
      final r = await body();
      await clear();
      return r;
    } catch (_) {
      await clear();
      rethrow;
    }
  }

  /// Synchronous variant for FFI calls that aren't async. The marker is written
  /// (awaited) first, then [body] runs; on return the marker is cleared.
  static Future<T> guardSync<T>(String stage, T Function() body, {String detail = ''}) async {
    await enter(stage, detail: detail);
    try {
      final r = body();
      await clear();
      return r;
    } catch (_) {
      await clear();
      rethrow;
    }
  }

  /// Call once at app start. If a previous run left a marker, the app crashed
  /// during that voice stage — report it, then clear. Never throws.
  static Future<void> checkAndReport() async {
    try {
      final f = await _file();
      if (!await f.exists()) return;
      Map<String, dynamic> j;
      try {
        j = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      } catch (_) {
        await f.delete();
        return;
      }
      final ts = (j['ts'] as num?)?.toInt() ?? 0;
      Analytics.capture('voice_crash_recovered', {
        'stage': (j['stage'] ?? '').toString(),
        'detail': (j['detail'] ?? '').toString(),
        'age_ms': ts > 0 ? DateTime.now().millisecondsSinceEpoch - ts : -1,
      });
      await f.delete();
    } catch (_) {}
  }
}
