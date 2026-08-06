/// [CALLREC-CORE-1] The call-recording store — THE public API for the feature.
///
/// Spec: `Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md` (rev 11, final).
///
/// The UI talks to this and to nothing else: it owns the native session, the
/// drift rows, the on-disk audio blobs and the deferred upload. Everything it
/// exposes is either a `ValueNotifier` (bind a `ValueListenableBuilder`) or a
/// `Future` — there is no stream to forget to cancel and no init() to forget to
/// call.
///
/// ── FIVE INVARIANTS, in the order they bite ────────────────────────────────
///
/// 1. **The live conversation always wins** (§3.2). Nothing in this file runs on
///    an audio thread; native copies PCM into a ring buffer and returns, and the
///    worst thing a failure here can do is cost you a recording.
///
/// 2. **The local file is the user's copy and is never deleted by an upload.**
///    Upload success only stamps `mediaId`/`uploadedAt`. The only thing that
///    removes local audio is [delete].
///
/// 3. **A recording can end without anyone calling [stop].** Native's
///    degradation ladder finalizes on its own when it is dropping more audio
///    than it keeps, and emits `{type:"degraded", path, durationMs, bytes}`. The
///    event handler below turns that into a real, saved recording. Code that
///    assumes `phase == recording` until it calls stop is wrong.
///
/// 4. **`start` fails by returning `{ok:false}`, not by throwing.** In
///    particular `near_adapter_unavailable:<token>` / `subscribe_failed:…` mean
///    the microphone-side tap never bound — a recording that would contain only
///    the other person. That is surfaced as a hard failure, never as a quiet
///    success.
///
/// 5. **Per-account scoping is mandatory.** The drift DB file is already
///    per-account and [MediaService]'s blob dir is scoped by `AccountScope.id`;
///    the native working directory below is scoped the same way, so a parent and
///    a child on one phone can never see or recover each other's audio.
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:drift/drift.dart' show Value;
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../../features/avatok/media.dart';
import '../../identity/identity.dart';
import '../analytics.dart';
import '../ava_log.dart';
import '../db.dart';
import '../remote_config.dart';
import 'call_recording_api.dart';
import 'call_recording_model.dart';
import 'call_recording_native.dart';
import 'call_recording_uploader.dart';

class CallRecordingStore {
  CallRecordingStore._();

  static final CallRecordingStore I = CallRecordingStore._();

  // ── observable state ──────────────────────────────────────────────────────

  /// Where the ACTIVE session is. See [CallRecordingPhase] — a finished-but-not-
  /// uploaded recording leaves this at [CallRecordingPhase.idle].
  final ValueNotifier<CallRecordingPhase> phase =
      ValueNotifier<CallRecordingPhase>(CallRecordingPhase.idle);

  /// Live duration/bytes while recording (~1 s cadence from native). Null when
  /// nothing is being recorded.
  final ValueNotifier<CallRecordingProgress?> progress =
      ValueNotifier<CallRecordingProgress?>(null);

  /// The call currently being recorded, or null. The Record tile uses this to
  /// know whether the red state belongs to THIS call — the recorder is
  /// process-wide and rejects a second call with `busy_other_call`.
  final ValueNotifier<String?> activeCallId = ValueNotifier<String?>(null);

  /// Why a given recording is still un-uploaded, keyed by callId. Additive to
  /// the agreed API: without it a card that failed on 413 `storage_full` looks
  /// identical to one that simply hasn't been tried yet, which is the kind of
  /// silence that turns a quota problem into a support ticket.
  final ValueNotifier<Map<String, CallRecordingUploadIssue>> uploadIssues =
      ValueNotifier<Map<String, CallRecordingUploadIssue>>(
          const <String, CallRecordingUploadIssue>{});

  /// The last error string from a failed [start]/[stop], for the UI to render
  /// once. Cleared on the next successful [start].
  final ValueNotifier<String?> lastError = ValueNotifier<String?>(null);

  // ── internals ─────────────────────────────────────────────────────────────

  StreamSubscription<CallRecorderEvent>? _events;

  /// Peer/direction metadata for the session in flight. Native knows nothing
  /// about who is on the call, so this is held here and applied at finalize.
  _PendingSession? _pending;

  /// Guards start/stop against a double tap on the Record tile.
  bool _busy = false;

  /// Per-account native working directory. NOT the [MediaService] blob dir —
  /// native writes ADTS work files, a sidecar metadata file and the remuxed
  /// `.m4a` here, and its orphan sweep deletes what it finds; pointing it at the
  /// shared media cache would put that sweep next to every cached avatar and DM
  /// attachment on the device.
  Future<Directory> _workDir() async {
    final base = await getApplicationSupportDirectory();
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty)
        ? 'default'
        : AccountScope.id!;
    final d = Directory('${base.path}/callrec/$scope');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  /// Blob key for a recording's audio inside the per-account [MediaService]
  /// cache. Deterministic, so a re-import of the same call overwrites rather
  /// than accumulating.
  static String blobKeyFor(String callId) => 'callrec_$callId.m4a';

  // ── recording ─────────────────────────────────────────────────────────────

  /// Arm the recorder for [callId].
  ///
  /// Returns false — WITHOUT throwing — for every refusal: flag off, already
  /// recording, not enough free space, native tap unavailable. [lastError]
  /// carries the reason, so the caller can show one sentence rather than a
  /// generic failure.
  Future<bool> start({
    required String callId,
    required String peerUid,
    String? peerName,
    String? peerAvatar,
    required String direction,
  }) async {
    if (_busy) return false;
    if (callId.isEmpty) return false;

    // Server kill switch FIRST. Capturing audio the server will 403 is worse
    // than not capturing: it burns the user's disk and their expectation.
    if (!RemoteConfig.callRecordingEnabled) {
      lastError.value = 'disabled';
      return false;
    }
    if (phase.value == CallRecordingPhase.recording ||
        phase.value == CallRecordingPhase.finalizing) {
      lastError.value = 'already_recording';
      return false;
    }
    if (!await hasFreeSpace()) {
      lastError.value = 'insufficient_storage';
      await Analytics.capture('callrec_storage_stop', {
        'call_id': callId,
        'stage': 'arm',
        'min_free_mb': RemoteConfig.callRecordingMinFreeMb,
      });
      return false;
    }

    _busy = true;
    try {
      _listen();
      final dir = await _workDir();
      final res = await CallRecorderNative.start(
        callId: callId,
        outputDir: dir.path,
        // Mono by default (spec §3.3): half the bytes of the user's own storage
        // quota, and stereo existed only to enable per-channel transcription,
        // which was removed in rev 11. Phase 1 may flip this on speakerphone
        // evidence — the mixer is capable of both.
        stereo: false,
      );
      if (!res.ok) {
        final err = res.error ?? 'unknown';
        lastError.value = err;
        phase.value = CallRecordingPhase.failed;
        AvaLog.I.log('callrec', 'start failed for $callId: $err');
        // A tap that never bound is a correctness failure, not a user refusal —
        // it silently produces a one-sided recording if anyone lets it through.
        await Analytics.captureException(
          StateError('callrec_start_failed:$err'),
          StackTrace.current,
          screen: 'callrec',
          handled: true,
          extra: {
            'call_id': callId,
            'error': err,
            'near_tap_failure': res.isNearTapFailure,
          },
        );
        await Analytics.capture('callrec_started', {
          'ok': false,
          'call_id': callId,
          'error': err,
          'direction': direction,
          if (peerUid.isNotEmpty) 'peer_uid': peerUid,
        });
        phase.value = CallRecordingPhase.idle;
        return false;
      }

      _pending = _PendingSession(
        callId: callId,
        peerUid: peerUid,
        peerName: peerName ?? '',
        peerAvatar: peerAvatar ?? '',
        direction: direction == 'incoming' ? 'incoming' : 'outgoing',
        startedAt: DateTime.now().millisecondsSinceEpoch,
      );
      activeCallId.value = callId;
      progress.value = const CallRecordingProgress(durationMs: 0, bytes: 0);
      phase.value = CallRecordingPhase.recording;
      lastError.value = null;

      await Analytics.capture('callrec_started', {
        'ok': true,
        'call_id': callId,
        'direction': _pending!.direction,
        if (peerUid.isNotEmpty) 'peer_uid': peerUid,
      });
      return true;
    } catch (e, st) {
      lastError.value = 'exception';
      phase.value = CallRecordingPhase.idle;
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'start', 'call_id': callId});
      return false;
    } finally {
      _busy = false;
    }
  }

  /// Stop, finalize and persist. Returns the saved recording, or null if there
  /// was nothing to save (or finalization failed — in which case [lastError]
  /// says why and the working file has already been cleaned up by native).
  ///
  /// Slow: the remux of a long recording takes seconds. The UI should sit on
  /// [CallRecordingPhase.finalizing] rather than blocking the call teardown on
  /// this future.
  Future<CallRecording?> stop() async {
    if (_busy) return null;
    _busy = true;
    final session = _pending;
    try {
      phase.value = CallRecordingPhase.finalizing;
      final res = await CallRecorderNative.stop();
      if (!res.ok || (res.path ?? '').isEmpty) {
        final err = res.error ?? 'no_path';
        // `not_recording` is benign — a self-finalize (degradation ladder)
        // already saved and cleared this session.
        if (err != 'not_recording') {
          lastError.value = err;
          AvaLog.I.log('callrec', 'stop failed: $err');
          await Analytics.captureException(
            StateError('callrec_stop_failed:$err'),
            StackTrace.current,
            screen: 'callrec',
            handled: true,
            extra: {'call_id': session?.callId ?? '', 'error': err},
          );
        }
        _resetSession();
        return null;
      }
      final saved = await _persist(
        session: session,
        path: res.path!,
        durationMs: res.durationMs,
        reason: 'stop',
      );
      _resetSession();
      // Deferred upload — AFTER the session is reset, so the phase transition is
      // idle → uploading → idle rather than racing the teardown. Unawaited: the
      // call teardown must never wait on the network.
      unawaited(_drainUploads(source: 'stop'));
      return saved;
    } catch (e, st) {
      _resetSession();
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'stop'});
      return null;
    } finally {
      _busy = false;
    }
  }

  /// Abandon the current recording and delete its working file. Nothing is
  /// saved and nothing is uploaded.
  Future<void> cancel() async {
    try {
      await CallRecorderNative.cancel();
    } finally {
      _resetSession();
    }
  }

  // ── stored recordings ─────────────────────────────────────────────────────

  Future<List<CallRecording>> list() async {
    final rows = await Db.I.callRecordingsOnce();
    return [for (final r in rows) _fromRow(r)];
  }

  /// Reactive list — additive to the agreed API, and the one the recordings
  /// screen should bind to: a background upload completing has to repaint the
  /// "backed up" state, and polling [list] to notice would be silly.
  Stream<List<CallRecording>> watch() => Db.I
      .watchCallRecordings()
      .map((rows) => [for (final r in rows) _fromRow(r)]);

  Future<CallRecording?> byCallId(String callId) async {
    final r = await Db.I.callRecordingById(callId);
    return r == null ? null : _fromRow(r);
  }

  /// Save a user-supplied title/description. Writes LOCALLY FIRST so the edit
  /// survives a failed network call and repaints immediately; the server patch
  /// is best-effort and idempotent, so a later retry is safe.
  ///
  /// A recording that was never uploaded has no Inbox row to patch — the server
  /// answers 404 and the local value simply rides along with the eventual
  /// upload... except that `finalize` always writes an EMPTY title (the Worker
  /// hard-codes `title:""`), so the store re-pushes the meta after a successful
  /// upload. See [_pushMetaIfNeeded].
  Future<void> updateMeta(String callId,
      {String? title, String? description}) async {
    if (title == null && description == null) return;
    await Db.I.setCallRecordingMeta(callId,
        title: title, description: description);
    await Analytics.capture('callrec_title_edited', {
      'call_id': callId,
      'has_title': (title ?? '').trim().isNotEmpty,
      'has_description': (description ?? '').trim().isNotEmpty,
    });
    final row = await Db.I.callRecordingById(callId);
    if (row == null || row.uploadedAt == null) return; // nothing server-side yet
    await CallRecordingApi.updateMeta(callId,
        title: title, description: description);
  }

  /// Delete everywhere: the local blob, the local row, and (if uploaded) the
  /// server copy + its storage quota. The server call is attempted FIRST so a
  /// failure there doesn't leave an orphaned, quota-consuming R2 object with no
  /// local row to retry from.
  Future<void> delete(String callId) async {
    final row = await Db.I.callRecordingById(callId);
    var serverOk = true;
    if (row != null && row.uploadedAt != null) {
      serverOk = await CallRecordingApi.delete(callId);
    }
    try {
      final key = row?.blobKey ?? blobKeyFor(callId);
      // Overwrite with zero bytes then unlink: MediaService exposes a blob
      // writer but no deleter, and leaving the file would keep megabytes on a
      // device whose owner just asked us to remove them.
      await _deleteBlobFile(key);
    } catch (e, st) {
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'delete_blob', 'call_id': callId});
    }
    await Db.I.deleteCallRecording(callId);
    _clearIssue(callId);
    await Analytics.capture('callrec_deleted', {
      'call_id': callId,
      'server_ok': serverOk,
      'was_uploaded': row?.uploadedAt != null,
      'bytes': row?.bytes ?? 0,
    });
  }

  /// The audio, local-first.
  ///
  /// Order matters: the on-device blob is authoritative and free, so it is tried
  /// first. Only if it is gone do we mint a FRESH presigned URL and re-download
  /// — and the URL is used immediately and never stored (a persisted presign is
  /// a stale link plus a leaked credential).
  Future<Uint8List?> audioBytes(String callId) async {
    final row = await Db.I.callRecordingById(callId);
    if (row == null) return null;

    final key = row.blobKey ?? '';
    if (key.isNotEmpty) {
      final local = await MediaService.cachedBlob(key);
      if (local != null && local.isNotEmpty) {
        await Analytics.cacheEvent('call_recording', 'hit',
            bytes: local.length, accountScoped: true);
        return local;
      }
    }
    if (row.uploadedAt == null) {
      // No local copy and no server copy: nothing to play. Loud, because this
      // is the failure the whole feature exists to prevent.
      AvaLog.I.log('callrec', 'audio unavailable for $callId (no blob, not uploaded)');
      await Analytics.cacheEvent('call_recording', 'miss', accountScoped: true);
      return null;
    }

    final url = await CallRecordingApi.playbackUrl(callId);
    if (url == null) return null;
    final bytes = await CallRecordingApi.download(url);
    if (bytes == null || bytes.isEmpty) return null;
    final restoreKey = key.isEmpty ? blobKeyFor(callId) : key;
    await MediaService.writeBlob(restoreKey, bytes);
    if (key.isEmpty) {
      await Db.I.upsertCallRecording(
          _toCompanion(_fromRow(row).copyWith(blobKey: restoreKey)));
    }
    await Analytics.cacheEvent('call_recording', 'miss',
        bytes: bytes.length, accountScoped: true);
    return bytes;
  }

  /// Total on-disk bytes of all recordings for this account.
  Future<int> totalBytes() => Db.I.callRecordingTotalBytes();

  /// Is there room to record, per `callRecordingMinFreeMb`?
  ///
  /// FAILS OPEN. `CallRecorderPlugin` does implement `freeBytes`
  /// (`[CALLREC-NATIVE-2]`), but it answers null when the volume cannot be
  /// measured — and an app running against an older native build gets a
  /// [MissingPluginException], which surfaces as null too. Either way this
  /// returns true rather than guessing: native `start` still enforces its own
  /// hard floor and answers `insufficient_storage`, so the worst case is that
  /// the user finds out one tap later instead of before arming. Failing CLOSED
  /// here would disable recording outright on every device it cannot measure,
  /// which is far worse than a late error.
  Future<bool> hasFreeSpace() async {
    try {
      final dir = await _workDir();
      final free = await CallRecorderNative.freeBytes(dir.path);
      if (free == null) return true;
      final minBytes =
          (RemoteConfig.callRecordingMinFreeMb * 1024 * 1024).round();
      return free >= minBytes;
    } catch (_) {
      return true;
    }
  }

  /// Sweep the working directory for a file left behind by a crash or a
  /// force-kill and turn it into a real recording. Call ONCE on app start.
  ///
  /// With no segmentation this is the only crash protection there is (spec
  /// §3.3): native remuxes the truncated ADTS stream into a playable `.m4a` and
  /// reports the raw callId from its sidecar file. The peer is unknown at this
  /// point — the session that knew it died with the process — so the row is
  /// created with empty peer fields and the card falls back to "Call recording".
  ///
  /// Also drains any pending uploads, because a crash and a failed upload leave
  /// the same symptom: a local file the server has never seen.
  Future<void> recoverOrphans() async {
    try {
      final dir = await _workDir();
      final orphans = await CallRecorderNative.recoverOrphans(dir.path);
      for (final o in orphans) {
        final callId = o.callId.isEmpty
            ? 'recovered_${DateTime.now().millisecondsSinceEpoch}'
            : o.callId;
        if (await Db.I.callRecordingById(callId) != null) {
          // Already persisted (a stop that raced the crash). Drop the duplicate
          // file rather than creating a second row for the same call.
          await _deleteFile(o.path);
          continue;
        }
        final saved = await _persist(
          session: _PendingSession(
            callId: callId,
            peerUid: '',
            peerName: '',
            peerAvatar: '',
            direction: 'outgoing',
            // A recovered file has no session start time; the file's own mtime
            // is the closest honest answer, and it keeps the list sorted sanely.
            startedAt: await _mtimeMs(o.path),
          ),
          path: o.path,
          durationMs: o.durationMs,
          reason: 'recovered',
        );
        if (saved != null) {
          await Analytics.capture('callrec_recovered', {
            'call_id': callId,
            'duration_s': saved.durationS,
            'bytes': saved.bytes,
          });
        }
      }
    } catch (e, st) {
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'recover_orphans'});
    }
    // Best-effort drain of anything still un-uploaded, including what we just
    // recovered. Unawaited on purpose: app start must not block on the network.
    unawaited(_drainUploads(source: 'app_start'));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /// Move the finished `.m4a` into the per-account [MediaService] blob cache and
  /// write the drift row. Returns null if the file is missing or empty.
  Future<CallRecording?> _persist({
    required _PendingSession? session,
    required String path,
    required int durationMs,
    required String reason,
  }) async {
    final file = File(path);
    if (!await file.exists()) {
      AvaLog.I.log('callrec', 'finalize: no file at $path ($reason)');
      return null;
    }
    Uint8List bytes;
    try {
      bytes = await file.readAsBytes();
    } catch (e, st) {
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'read_final', 'reason': reason});
      return null;
    }
    if (bytes.isEmpty) {
      await _deleteFile(path);
      return null;
    }

    final callId = session?.callId ??
        'recovered_${DateTime.now().millisecondsSinceEpoch}';
    final blobKey = blobKeyFor(callId);
    await MediaService.writeBlob(blobKey, bytes);
    // The working copy is redundant now — the blob is the durable one, and
    // leaving both doubles the disk cost of every recording.
    await _deleteFile(path);

    final rec = CallRecording(
      callId: callId,
      peerUid: session?.peerUid ?? '',
      peerName: session?.peerName ?? '',
      peerAvatar: session?.peerAvatar ?? '',
      direction: session?.direction ?? 'outgoing',
      startedAt: session?.startedAt ?? DateTime.now().millisecondsSinceEpoch,
      durationS: (durationMs / 1000).round(),
      bytes: bytes.length,
      blobKey: blobKey,
    );
    await Db.I.upsertCallRecording(_toCompanion(rec));

    await Analytics.capture('callrec_finalized', {
      'call_id': callId,
      'duration_s': rec.durationS,
      'bytes': rec.bytes,
      'reason': reason,
      'direction': rec.direction,
      if (rec.peerUid.isNotEmpty) 'peer_uid': rec.peerUid,
    });
    // NOTE: the upload is NOT kicked off here. Callers drain AFTER resetting the
    // session, so `phase` moves idle → uploading → idle instead of two writers
    // racing over the same notifier during teardown.
    return rec;
  }

  /// Try the pending uploads now; hand anything still failing to WorkManager so
  /// it survives the app being backgrounded or killed.
  Future<void> _drainUploads({required String source}) async {
    phase.value = phase.value == CallRecordingPhase.idle
        ? CallRecordingPhase.uploading
        : phase.value;
    List<CallRecUploadResult> results;
    try {
      results = await CallRecordingUploader.uploadPending(source: source);
    } catch (e, st) {
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'drain', 'source': source});
      results = const <CallRecUploadResult>[];
    }
    if (phase.value == CallRecordingPhase.uploading) {
      phase.value = CallRecordingPhase.idle;
    }

    var retry = false;
    for (final r in results) {
      if (r.ok) {
        _clearIssue(r.callId);
        await _pushMetaIfNeeded(r.callId);
        continue;
      }
      _setIssue(r.callId, r.issueCode ?? 'server', r.message);
      // storage_full / too_large need the USER to act; retrying on a timer just
      // burns battery and data to be told the same thing.
      if (r.issueCode == 'network' ||
          r.issueCode == 'disabled' ||
          r.issueCode == 'server') {
        retry = true;
      }
    }
    if (retry) await CallRecordingUploader.scheduleRetry();
  }

  /// `finalize` always creates the Inbox row with an EMPTY title/description
  /// (the Worker hard-codes them — they are user-supplied only). If the user
  /// typed something while the recording was still queued, that text exists
  /// locally and nowhere else, so push it up once the row exists.
  Future<void> _pushMetaIfNeeded(String callId) async {
    final row = await Db.I.callRecordingById(callId);
    if (row == null) return;
    if (row.title.isEmpty && row.description.isEmpty) return;
    await CallRecordingApi.updateMeta(callId,
        title: row.title, description: row.description);
  }

  /// Subscribe to native events exactly once.
  void _listen() {
    if (_events != null) return;
    _events = CallRecorderNative.events().listen(
      _onEvent,
      onError: (Object e, StackTrace st) {
        AvaLog.I.log('callrec', 'event stream error: $e');
        unawaited(Analytics.captureException(e, st,
            screen: 'callrec', handled: true, extra: {'stage': 'event_stream'}));
      },
    );
  }

  Future<void> _onEvent(CallRecorderEvent ev) async {
    switch (ev.type) {
      case 'state':
        if (ev.recording) {
          progress.value = CallRecordingProgress(
              durationMs: ev.durationMs, bytes: ev.bytes);
        }
        break;

      case 'degraded':
        // INVARIANT 3: the recorder finished by itself. Persist what it managed
        // to capture — a partial recording the user can play beats an orphaned
        // file nobody knows about.
        final path = ev.path;
        AvaLog.I.log('callrec', 'self-finalized: ${ev.reason ?? 'degraded'}');
        await Analytics.capture('callrec_storage_stop', {
          'call_id': ev.callId ?? '',
          'reason': ev.reason ?? 'degraded',
          'duration_ms': ev.durationMs,
          'bytes': ev.bytes,
        });
        if (path != null && path.isNotEmpty) {
          await _persist(
            session: _pending,
            path: path,
            durationMs: ev.durationMs,
            reason: ev.reason ?? 'degraded',
          );
        }
        _resetSession();
        unawaited(_drainUploads(source: 'degraded'));
        break;

      case 'error':
        AvaLog.I.log('callrec', 'native error ${ev.code}: ${ev.data['detail']}');
        await Analytics.captureException(
          StateError('callrec_native:${ev.code ?? 'unknown'}'),
          StackTrace.current,
          screen: 'callrec',
          handled: true,
          extra: {
            'call_id': ev.callId ?? '',
            'code': ev.code ?? '',
            'detail': '${ev.data['detail'] ?? ''}',
          },
        );
        break;

      case 'drift':
        await Analytics.capture('callrec_drift_corrected', {
          'call_id': ev.callId ?? '',
          'leg_delta_ms': '${ev.data['legDeltaMs'] ?? 0}',
          'near_drift_ms': '${ev.data['nearDriftMs'] ?? 0}',
          'far_drift_ms': '${ev.data['farDriftMs'] ?? 0}',
        });
        break;

      case 'rateChange':
        // Bluetooth SCO and speaker/wired transitions change the capture rate
        // mid-call (spec §3.3). Native resamples; this is here so a pitch-shift
        // report can be correlated against a real route change.
        await Analytics.capture('callrec_rate_change', {
          'call_id': ev.callId ?? '',
          'leg': '${ev.data['leg'] ?? ''}',
          'from': '${ev.data['from'] ?? ''}',
          'to': '${ev.data['to'] ?? ''}',
        });
        break;

      case 'probe':
        AvaLog.I.log(
            'callrec',
            'adapter probe: source=${ev.data['adapterSource']} '
                'near=${ev.data['near']} far=${ev.data['far']}');
        break;

      default:
        // A native build newer than this client must never crash it.
        AvaLog.I.log('callrec', 'unhandled event ${ev.type}');
    }
  }

  void _resetSession() {
    _pending = null;
    activeCallId.value = null;
    progress.value = null;
    phase.value = CallRecordingPhase.idle;
  }

  void _setIssue(String callId, String code, String? message) {
    final next = Map<String, CallRecordingUploadIssue>.from(uploadIssues.value);
    next[callId] = CallRecordingUploadIssue(
      code: code,
      message: message ?? _defaultIssueMessage(code),
      at: DateTime.now().millisecondsSinceEpoch,
    );
    uploadIssues.value = next;
  }

  void _clearIssue(String callId) {
    if (!uploadIssues.value.containsKey(callId)) return;
    final next = Map<String, CallRecordingUploadIssue>.from(uploadIssues.value)
      ..remove(callId);
    uploadIssues.value = next;
  }

  static String _defaultIssueMessage(String code) {
    switch (code) {
      case 'storage_full':
        return 'Your AvaStorage is full. Free some space or top up your wallet '
            'to back this recording up. It is still saved on this phone.';
      case 'too_large':
        return 'This recording is too long to upload in one piece. It is still '
            'saved on this phone.';
      case 'disabled':
        return 'Recording backup is turned off right now. Saved on this phone.';
      case 'missing_audio':
        return 'The audio for this recording is no longer on this phone.';
      default:
        return 'Not backed up yet — we will keep trying. Saved on this phone.';
    }
  }

  // ── mapping ───────────────────────────────────────────────────────────────

  CallRecording _fromRow(CallRecordingRow r) => CallRecording(
        callId: r.callId,
        convKey: r.convKey,
        peerUid: r.peerUid,
        peerName: r.peerName,
        peerAvatar: r.peerAvatar,
        direction: r.direction,
        startedAt: r.startedAt,
        durationS: r.durationS,
        bytes: r.bytes,
        title: r.title,
        description: r.description,
        blobKey: r.blobKey,
        mediaId: r.mediaId,
        uploadedAt: r.uploadedAt,
      );

  CallRecordingsCompanion _toCompanion(CallRecording r) =>
      CallRecordingsCompanion.insert(
        callId: r.callId,
        convKey: Value(r.convKey),
        peerUid: Value(r.peerUid),
        peerName: Value(r.peerName),
        peerAvatar: Value(r.peerAvatar),
        direction: Value(r.direction),
        startedAt: Value(r.startedAt),
        durationS: Value(r.durationS),
        bytes: Value(r.bytes),
        title: Value(r.title),
        description: Value(r.description),
        blobKey: Value(r.blobKey),
        mediaId: Value(r.mediaId),
        uploadedAt: Value(r.uploadedAt),
      );

  // ── file helpers ──────────────────────────────────────────────────────────

  Future<void> _deleteFile(String path) async {
    try {
      final f = File(path);
      if (await f.exists()) await f.delete();
    } catch (_) {/* best-effort */}
  }

  /// Delete a [MediaService] blob. MediaService exposes a reader and a writer
  /// but no deleter, and its on-disk layout
  /// (`<appSupport>/media/<AccountScope.id>/<sanitised key>`) is a documented
  /// convention (rulebook §2), so it is reproduced here rather than adding a
  /// method to a file another agent owns.
  Future<void> _deleteBlobFile(String key) async {
    final base = await getApplicationSupportDirectory();
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty)
        ? 'default'
        : AccountScope.id!;
    final name = key.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    await _deleteFile('${base.path}/media/$scope/$name');
  }

  Future<int> _mtimeMs(String path) async {
    try {
      return (await File(path).lastModified()).millisecondsSinceEpoch;
    } catch (_) {
      return DateTime.now().millisecondsSinceEpoch;
    }
  }
}

/// Who and what the in-flight session is about. Native holds only a callId, so
/// the peer identity has to survive here until finalize.
class _PendingSession {
  final String callId;
  final String peerUid;
  final String peerName;
  final String peerAvatar;
  final String direction;
  final int startedAt;
  const _PendingSession({
    required this.callId,
    required this.peerUid,
    required this.peerName,
    required this.peerAvatar,
    required this.direction,
    required this.startedAt,
  });
}
