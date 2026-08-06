/// [CALLREC-CORE-1] Thin, typed wrapper over the Android call-recorder plugin.
///
/// Native side: `app/android/app/src/main/kotlin/ai/avatok/callrecord/CallRecorderPlugin.kt`.
/// Channels: `avatok/call_record` (methods) + `avatok/call_record/events`.
///
/// THIS FILE ADDS NO POLICY. It converts platform maps into Dart records, and
/// nothing else — every decision (flags, storage floor, DB writes, telemetry)
/// lives in `call_recording_store.dart`. Keeping the boundary here is what lets
/// the store be read without also reading channel plumbing.
///
/// TWO THINGS THE NATIVE CONTRACT DOES THAT LOOK ODD AND ARE DELIBERATE:
///  1. **`start` failures come back as `result.success({ok:false, error:…})`,
///     not as a `PlatformException`.** So a `try/catch` alone will NEVER see a
///     failed arm — you must read `ok`. The spec calls this out for
///     `near_adapter_unavailable:<token>` / `subscribe_failed:…`, which mean the
///     mic-side tap could not bind: a recording that would be one-sided or
///     silent. Those must surface as a hard failure, never as a silent success.
///  2. **The recorder can finish ITSELF.** The degradation ladder (spec §3.2)
///     ends a recording when it is losing more audio than it keeps; native emits
///     `{type:"degraded", path, durationMs, bytes}` and caches the result so a
///     later `stop` still returns it. Anything watching `phase` must handle a
///     recording that ended without anyone calling [stop].
library;

import 'package:flutter/services.dart';

/// Result of `start`. [path] is where the FINAL `.m4a` will land — it does not
/// exist yet at this point (the live file is ADTS, remuxed at close).
class CallRecorderStartResult {
  final bool ok;
  final String? path;
  final String? error;
  const CallRecorderStartResult({required this.ok, this.path, this.error});

  /// The mic-side tap could not bind. Distinguished because it is the one
  /// failure that could otherwise be mistaken for "recording, but quiet".
  bool get isNearTapFailure =>
      (error ?? '').startsWith('near_adapter_unavailable') ||
      (error ?? '').startsWith('subscribe_failed');
}

/// Result of `stop` (and of a self-finalize replayed through `stop`).
class CallRecorderStopResult {
  final bool ok;
  final String? path;
  final int durationMs;
  final int bytes;
  final String? error;
  const CallRecorderStopResult({
    required this.ok,
    this.path,
    this.durationMs = 0,
    this.bytes = 0,
    this.error,
  });
}

/// Snapshot of `state`.
class CallRecorderState {
  final bool recording;
  final String? callId;
  final int durationMs;
  final int bytes;
  const CallRecorderState({
    required this.recording,
    this.callId,
    this.durationMs = 0,
    this.bytes = 0,
  });
}

/// One orphaned working file that was remuxed back into a playable recording on
/// launch (spec §3.3 — with no segmentation this is the ONLY crash protection).
class CallRecorderOrphan {
  final String callId;
  final String path;
  final int durationMs;
  final int bytes;
  const CallRecorderOrphan({
    required this.callId,
    required this.path,
    required this.durationMs,
    required this.bytes,
  });
}

/// A raw event off `avatok/call_record/events`, kept as a map plus a decoded
/// `type` so the store can switch on the known ones and still log the rest —
/// a new native event type must never crash an old client.
class CallRecorderEvent {
  /// `state` | `error` | `drift` | `rateChange` | `degraded` | `probe`
  final String type;
  final Map<String, dynamic> data;
  const CallRecorderEvent(this.type, this.data);

  String? get callId => _str(data['callId']);
  int get durationMs => _int(data['durationMs']);
  int get bytes => _int(data['bytes']);
  bool get recording => data['recording'] == true;
  String? get path => _str(data['path']);
  String? get code => _str(data['code']);
  String? get reason => _str(data['reason']);

  @override
  String toString() => 'CallRecorderEvent($type, $data)';
}

/// The channel wrapper. Static, because there is exactly one recorder per
/// process (the native plugin holds a single session and rejects a second
/// `start` with `busy_other_call`).
class CallRecorderNative {
  CallRecorderNative._();

  static const MethodChannel _method = MethodChannel('avatok/call_record');
  static const EventChannel _events = EventChannel('avatok/call_record/events');

  static Stream<CallRecorderEvent>? _stream;

  /// Broadcast stream of native events. Created lazily and cached, so multiple
  /// listeners share ONE platform subscription — re-listening to the raw
  /// EventChannel would re-`onListen` on the native side and replace the sink.
  static Stream<CallRecorderEvent> events() {
    return _stream ??= _events
        .receiveBroadcastStream()
        .map((e) {
          final m = _map(e);
          return CallRecorderEvent(_str(m['type']) ?? 'unknown', m);
        })
        .asBroadcastStream();
  }

  /// Arm the recorder. [outputDir] must already be per-account scoped by the
  /// caller — native writes work files, sidecar metadata and the finished
  /// `.m4a` there, and orphan recovery sweeps exactly that directory.
  static Future<CallRecorderStartResult> start({
    required String callId,
    required String outputDir,
    bool stereo = false,
  }) async {
    try {
      final r = _map(await _method.invokeMethod<dynamic>('start', {
        'callId': callId,
        'outputDir': outputDir,
        'stereo': stereo,
      }));
      return CallRecorderStartResult(
        ok: r['ok'] == true,
        path: _str(r['path']),
        error: _str(r['error']),
      );
    } on MissingPluginException {
      // Not Android, or a build without the plugin registered. Not an error
      // worth an exception report — the caller renders "unavailable".
      return const CallRecorderStartResult(ok: false, error: 'unavailable');
    } on PlatformException catch (e) {
      return CallRecorderStartResult(ok: false, error: 'platform:${e.code}');
    }
  }

  /// Stop and finalize. Slow by design (the remux runs off the platform thread
  /// natively, but a long recording still takes seconds), hence no timeout here
  /// — cutting it short would abandon a finished file.
  static Future<CallRecorderStopResult> stop() async {
    try {
      final r = _map(await _method.invokeMethod<dynamic>('stop'));
      return CallRecorderStopResult(
        ok: r['ok'] == true,
        path: _str(r['path']),
        durationMs: _int(r['durationMs']),
        bytes: _int(r['bytes']),
        error: _str(r['error']),
      );
    } on MissingPluginException {
      return const CallRecorderStopResult(ok: false, error: 'unavailable');
    } on PlatformException catch (e) {
      return CallRecorderStopResult(ok: false, error: 'platform:${e.code}');
    }
  }

  /// Abandon the current session and delete its working file. Never throws.
  static Future<void> cancel() async {
    try {
      await _method.invokeMethod<dynamic>('cancel');
    } on MissingPluginException {
      /* nothing to cancel */
    } on PlatformException {
      /* best-effort */
    }
  }

  static Future<CallRecorderState> state() async {
    try {
      final r = _map(await _method.invokeMethod<dynamic>('state'));
      return CallRecorderState(
        recording: r['recording'] == true,
        callId: _str(r['callId']),
        durationMs: _int(r['durationMs']),
        bytes: _int(r['bytes']),
      );
    } on MissingPluginException {
      return const CallRecorderState(recording: false);
    } on PlatformException {
      return const CallRecorderState(recording: false);
    }
  }

  /// Remux any working file left behind by a crash/force-kill. Safe to call on
  /// every launch and safe to call while a recording is active (native excludes
  /// the live session).
  static Future<List<CallRecorderOrphan>> recoverOrphans(String outputDir) async {
    try {
      final r = _map(await _method
          .invokeMethod<dynamic>('recoverOrphans', {'outputDir': outputDir}));
      final list = r['recovered'];
      if (list is! List) return const <CallRecorderOrphan>[];
      final out = <CallRecorderOrphan>[];
      for (final e in list) {
        final m = _map(e);
        final path = _str(m['path']);
        if (path == null) continue;
        out.add(CallRecorderOrphan(
          callId: _str(m['callId']) ?? '',
          path: path,
          durationMs: _int(m['durationMs']),
          bytes: _int(m['bytes']),
        ));
      }
      return out;
    } on MissingPluginException {
      return const <CallRecorderOrphan>[];
    } on PlatformException {
      return const <CallRecorderOrphan>[];
    }
  }

  /// Free bytes on the volume holding [outputDir].
  ///
  /// IMPLEMENTED by `CallRecorderPlugin.onMethodCall` since `[CALLREC-NATIVE-2]`.
  ///
  /// The null-return paths below are NOT dead code: an app running against an
  /// older native build (or a platform that has no plugin at all) still answers
  /// [MissingPluginException], and a `StatFs` failure on an odd volume comes
  /// back as [PlatformException]. Null means "could not measure", and the caller
  /// fails OPEN on it — native `start` enforces its own hard
  /// `STORAGE_FLOOR_BYTES` regardless, so a missing pre-check degrades to "you
  /// find out one tap later", never to a full disk.
  static Future<int?> freeBytes(String outputDir) async {
    try {
      final v = await _method
          .invokeMethod<dynamic>('freeBytes', {'outputDir': outputDir});
      return v is num ? v.toInt() : null;
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }
}

Map<String, dynamic> _map(Object? o) {
  if (o is Map) {
    return {for (final e in o.entries) e.key.toString(): e.value};
  }
  return <String, dynamic>{};
}

String? _str(Object? v) {
  if (v == null) return null;
  final s = v.toString();
  return s.isEmpty ? null : s;
}

int _int(Object? v) => v is num ? v.toInt() : (int.tryParse('${v ?? ''}') ?? 0);
