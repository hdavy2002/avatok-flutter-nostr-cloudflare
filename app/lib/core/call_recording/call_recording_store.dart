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

  /// [CALLHOLD-1] True while the active recording is HELD — capture stopped, the
  /// encoder still open, the held period spliced out of the file.
  ///
  /// A separate notifier and deliberately NOT a new [CallRecordingPhase] value:
  /// `phase` is switched on in UI this change does not own, and adding an enum
  /// case would silently change the meaning of every existing `switch` over it
  /// (or break exhaustiveness in a file another agent is editing right now).
  /// A paused recording is still `phase == recording` — it is armed, the file is
  /// open, and stop still finalizes it. Anything drawing a live indicator must
  /// read BOTH, or a held call looks like it is still capturing.
  ///
  /// [progress] freezes while this is true (native keeps its 1 s cadence but
  /// `durationMs` stops advancing), which is the honest rendering: the counter
  /// tracks the FILE, not the call.
  final ValueNotifier<bool> paused = ValueNotifier<bool>(false);

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
        'rec_id': recIdFor(callId),
        'stage': 'arm',
        'reason': 'min_free_mb',
        'min_free_mb': RemoteConfig.callRecordingMinFreeMb,
        if (peerUid.isNotEmpty) 'peer_uid': peerUid,
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
          'rec_id': recIdFor(callId),
          'error': err,
          // [CALLREC-TELEM-1] The failure family, split out of the free-text
          // error so it is a breakdown dimension and not a string to LIKE
          // against. `near_tap` is the one that matters most: it means the
          // microphone-side callback could not be bound, i.e. the unproven half
          // of this feature did not work on this device.
          'failure': err.startsWith('near_adapter_unavailable')
              ? 'near_tap'
              : err.startsWith('far_adapter_unavailable')
                  ? 'far_tap'
                  : err.startsWith('subscribe_failed')
                      ? 'subscribe'
                      : err.startsWith('encoder_init_failed')
                          ? 'encoder'
                          : err,
          'near_tap_failure': res.isNearTapFailure,
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
      paused.value = false; // [CALLHOLD-1] never inherit a previous hold
      phase.value = CallRecordingPhase.recording;
      lastError.value = null;

      await Analytics.capture('callrec_started', {
        'ok': true,
        'call_id': callId,
        'rec_id': recIdFor(callId),
        'direction': _pending!.direction,
        if (peerUid.isNotEmpty) 'peer_uid': peerUid,
        // Mono vs stereo is a §3.3 decision that Phase 1 may flip on
        // speakerphone evidence; recording which one produced a given file is
        // what makes that measurement reviewable after the fact.
        'stereo': false,
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

  /// [CALLHOLD-1] Hold the recording because the CALL went on hold.
  ///
  /// Owner's rule: "if a person holds that call then recorder should hold too,
  /// till user is back into the call." The held stretch is spliced out natively,
  /// so the saved file contains the conversation and not the wait.
  ///
  /// [callId] is required and checked: the recorder is process-wide, and a stale
  /// [CallSession] from a previous call must never be able to pause the
  /// recording of the CURRENT one. Everything else is a silent no-op — a hold on
  /// a call nobody is recording has nothing to do.
  ///
  /// Never throws and never awaits anything slow, because it sits on the call's
  /// hold path: a recorder problem must not be able to stop a user holding a
  /// call. Deliberately does NOT take [_busy] — that guard serializes
  /// start/stop, and blocking a resume behind an in-flight finalize is exactly
  /// how a hold becomes unreleasable.
  Future<void> setHeld(String callId, bool held) async {
    if (callId.isEmpty) return;
    if (activeCallId.value != callId) return;
    if (phase.value != CallRecordingPhase.recording) return;
    if (paused.value == held) return;
    // Optimistic: the notifier moves FIRST so the UI can never sit showing
    // "recording" through a slow channel round-trip, and so a failed native
    // call cannot leave the indicator lying in the dangerous direction.
    paused.value = held;
    try {
      final res =
          held ? await CallRecorderNative.pause() : await CallRecorderNative.resume();
      if (!res.ok) {
        final err = res.error ?? 'unknown';
        // `not_recording` is benign: the degradation ladder finalized the
        // session while the call was held. Anything else means capture did NOT
        // follow the hold — on a pause that is a privacy-relevant miss (we kept
        // recording), so it is reported, not swallowed.
        if (err != 'not_recording') {
          AvaLog.I.log('callrec', 'hold ${held ? 'pause' : 'resume'} failed: $err');
          await Analytics.captureException(
            StateError('callrec_hold_failed:$err'),
            StackTrace.current,
            screen: 'callrec',
            handled: true,
            extra: {'call_id': callId, 'held': held, 'error': err},
          );
        }
        // Fall back to the truth: capture is still running, so say so.
        if (held) paused.value = false;
      }
      await Analytics.capture('callrec_hold', {
        'call_id': callId,
        'rec_id': recIdFor(callId),
        if (_pendingPeerUid.isNotEmpty) 'peer_uid': _pendingPeerUid,
        'held': held,
        'ok': res.ok,
        if (!res.ok) 'error': res.error ?? 'unknown',
        'duration_ms': progress.value?.durationMs ?? 0,
        // [CALLREC-TELEM-1] Running totals, so one row answers "how much of this
        // call was held" without summing the pairs.
        'pause_count': _lastPauseCount,
        'paused_total_ms': _lastPausedTotalMs,
      });
    } catch (e, st) {
      if (held) paused.value = false;
      await Analytics.captureException(e, st,
          screen: 'callrec',
          handled: true,
          extra: {'stage': 'hold', 'call_id': callId, 'held': held});
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
      'rec_id': recIdFor(callId),
      'source': 'local',
      'has_title': (title ?? '').trim().isNotEmpty,
      'has_description': (description ?? '').trim().isNotEmpty,
      'title_len': (title ?? '').trim().length,
      'description_len': (description ?? '').trim().length,
    });
    final row = await Db.I.callRecordingById(callId);
    if (row == null || row.uploadedAt == null) return; // nothing server-side yet
    await CallRecordingApi.updateMeta(callId,
        title: title, description: description);
  }

  /// [CALLREC-BG-1] Apply a title/description that was edited on ANOTHER of my
  /// devices and arrived over the Inbox socket as an `edit` frame (SyncHub
  /// `_ingestEdit` → `{t:'edit', target, body}`).
  ///
  /// LOCAL ONLY, deliberately: [updateMeta] also PATCHes the server, and calling
  /// it from a socket frame would echo the server's own broadcast straight back
  /// at it — an edit loop between two devices. Nothing here talks to the network.
  ///
  /// A no-op when this device has no local row for [callId] (the recording was
  /// made on the other phone) — the Inbox card renders from the server envelope
  /// in that case, so there is nothing to keep in step.
  Future<void> applyRemoteMeta(String callId,
      {String? title, String? description}) async {
    if (callId.isEmpty || (title == null && description == null)) return;
    final row = await Db.I.callRecordingById(callId);
    if (row == null) return;
    if (row.title == (title ?? row.title) &&
        row.description == (description ?? row.description)) {
      return; // already in step — don't churn the reactive watch()
    }
    await Db.I.setCallRecordingMeta(callId, title: title, description: description);
    await Analytics.capture('callrec_meta_synced', {
      'call_id': callId,
      'rec_id': recIdFor(callId),
      'has_title': (title ?? '').trim().isNotEmpty,
      'has_description': (description ?? '').trim().isNotEmpty,
    });
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
      'rec_id': recIdFor(callId),
      'surface': 'store',
      'server_ok': serverOk,
      'was_uploaded': row?.uploadedAt != null,
      'bytes': row?.bytes ?? 0,
      'duration_s': row?.durationS ?? 0,
      if ((row?.peerUid ?? '').isNotEmpty) 'peer_uid': row!.peerUid,
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

  /// [CALLREC-UX-1] The audio for [callId] from wherever it can be had — the ONE
  /// playback path shared by the Inbox card and the detail screen.
  ///
  /// [audioBytes] returns null the moment there is no LOCAL drift row, which is
  /// the normal state for a recording made on another of the user's devices. So
  /// this falls through to a FRESH presign in that case. The URL is used
  /// immediately and never stored (a persisted presign is a stale link plus a
  /// leaked credential). Both surfaces call this rather than each keeping its own
  /// copy of the local-then-server order, so they can never disagree about
  /// whether a recording is playable.
  /// [CALLREC-TELEM-1] Sets [lastAudioSource] on the way through, so the
  /// playback events on both surfaces can say WHERE the bytes came from. "Play
  /// was slow" means something completely different for a local blob (disk) and
  /// for a presign + download (network, and a possible sign the local copy has
  /// been evicted), and without this the two are indistinguishable in PostHog.
  Future<Uint8List?> audioBytesAnywhere(String callId) async {
    if (callId.isEmpty) return null;
    lastAudioSource = 'unknown';
    try {
      final local = await audioBytes(callId);
      if (local != null && local.isNotEmpty) {
        lastAudioSource = 'local';
        return local;
      }
    } catch (_) {/* fall through to the server copy */}
    try {
      final url = await CallRecordingApi.playbackUrl(callId);
      if (url == null || url.isEmpty) {
        lastAudioSource = 'unavailable';
        return null;
      }
      final bytes = await CallRecordingApi.download(url);
      if (bytes == null || bytes.isEmpty) {
        lastAudioSource = 'download_failed';
        return null;
      }
      lastAudioSource = 'remote';
      return bytes;
    } catch (_) {
      lastAudioSource = 'error';
      return null;
    }
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
          // [CALLREC-TELEM-1] With no segmentation, orphan recovery is the ONLY
          // crash protection there is (spec §3.3). A rising count here is a
          // crash-rate signal for the recorder, so it carries enough to size the
          // loss: `duration_s` is what SURVIVED, not what was recorded.
          await Analytics.capture('callrec_recovered', {
            'call_id': callId,
            'rec_id': recIdFor(callId),
            'duration_s': saved.durationS,
            'bytes': saved.bytes,
            // A recovered file has no session, so the peer is unknown and the
            // id may be a synthesised `recovered_<ms>`. Say which, rather than
            // leaving a reader to infer it from the id's shape.
            'had_meta': !callId.startsWith('recovered_'),
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

    // [CALLREC-TELEM-1] The artifact event: what file actually came out, and
    // from which path. `reason` is the one property that answers "did this come
    // from a normal stop, from the degradation ladder, or from orphan recovery
    // after a crash" — `stop` | `recovered` | `ring_overflow` | `encoder_failed`
    // | `low_storage` | `near_leg_stalled` | `far_leg_stalled` | `detached`.
    //
    // The per-leg summary rides along (see [_lastLegSummary]) so this single row
    // says whether the file holds two voices or one: `near_batches: 0` on a
    // finalized recording is a silent near tap, and it is visible here without
    // joining anything.
    await Analytics.capture('callrec_finalized', {
      'call_id': callId,
      'rec_id': recIdFor(callId),
      'duration_s': rec.durationS,
      'bytes': rec.bytes,
      'reason': reason,
      'direction': rec.direction,
      if (rec.peerUid.isNotEmpty) 'peer_uid': rec.peerUid,
      // Recorded vs wall clock. A user asking "why is my recording shorter than
      // my call" is answered by these two, not by a guess: the held period is
      // SPLICED OUT of the file by design ([CALLHOLD-1]).
      'paused_total_ms': _lastPausedTotalMs,
      'pause_count': _lastPauseCount,
      'bytes_per_s': rec.durationS > 0 ? (rec.bytes / rec.durationS).round() : 0,
      ..._lastLegSummary,
    });
    // Consumed — a later recording must never inherit this one's summary.
    _lastLegSummary = const <String, Object>{};
    _lastPausedTotalMs = 0;
    _lastPauseCount = 0;
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

  // ── [CALLREC-TELEM-1] telemetry helpers ───────────────────────────────────
  //
  // Someone will read these events INSTEAD OF a debugger. Three rules hold
  // across every `callrec_*` event in this file:
  //
  //  1. **`call_id` + `rec_id` on everything.** `rec_id` is `callrec:<callId>`,
  //     which is byte-identical to the Worker's `clientIdFor(callId)` and to the
  //     Inbox row's `client_id`. That is what makes one recording's whole
  //     lifecycle — arm → capture → finalize → upload → Inbox row → playback —
  //     a single funnel across client AND server events, instead of two
  //     timelines a reader has to join by hand.
  //  2. **Both parties, where the event has them.** `peer_uid` rides along so
  //     either side of a two-sided feature retrieves the interaction. The
  //     owner's own email/phone are stamped automatically by `Analytics._base`.
  //  3. **A native event that matters gets a NAMED event, not just an
  //     exception.** `$exception` is for crashes; a funnel cannot be built on
  //     it, and "how many recordings had a stalled leg" is a funnel question.

  /// The correlation id every event in a recording's lifecycle shares. Same
  /// string the Worker uses for the Inbox row's `client_id`, deliberately.
  static String recIdFor(String callId) => 'callrec:$callId';

  /// Peer of the session in flight, for events raised by native (which knows
  /// only a callId). Empty when there is no session or no peer.
  String get _pendingPeerUid => _pending?.peerUid ?? '';

  /// Correlation envelope for an event raised from a native session event.
  Map<String, Object> _corr(String? callId) {
    final id = callId ?? _pending?.callId ?? activeCallId.value ?? '';
    final peer = _pendingPeerUid;
    return <String, Object>{
      'call_id': id,
      if (id.isNotEmpty) 'rec_id': recIdFor(id),
      if (peer.isNotEmpty) 'peer_uid': peer,
    };
  }

  /// [CALLREC-TELEM-1] Wall-clock ms spliced out by holds, and how many holds,
  /// reported by native on its `state` events. Held here so `callrec_finalized`
  /// can answer "why is my recording shorter than my call" with the number
  /// rather than a guess — by the time `_persist` runs the session is being torn
  /// down and native has nothing left to ask.
  int _lastPausedTotalMs = 0;
  int _lastPauseCount = 0;

  /// [CALLREC-TELEM-1] The closing per-leg capture summary from native's final
  /// `state` event, forwarded onto `callrec_finalized`. This is what tells a
  /// reader whether the file that just landed holds two voices or one.
  Map<String, Object> _lastLegSummary = const <String, Object>{};

  /// [CALLREC-TELEM-1] Where the bytes for the LAST playback load came from —
  /// `local` (on-device blob) or `remote` (fresh presign + download) — so a
  /// "playback was slow" report can be answered without guessing. Diagnostic
  /// only; nothing branches on it.
  String lastAudioSource = 'unknown';

  Future<void> _onEvent(CallRecorderEvent ev) async {
    switch (ev.type) {
      case 'state':
        // [CALLREC-TELEM-1] Captured on EVERY state event, including the final
        // one, because the final one is the only place the leg summary exists
        // and it arrives on the same tick as the teardown.
        _lastPausedTotalMs = _intOf(ev.data['pausedTotalMs']);
        _lastPauseCount = _intOf(ev.data['pauseCount']);
        final legs = _legSummaryOf(ev.data);
        if (legs.isNotEmpty) _lastLegSummary = legs;
        if (ev.recording) {
          progress.value = CallRecordingProgress(
              durationMs: ev.durationMs, bytes: ev.bytes);
          // [CALLHOLD-1] Native is the authority on whether capture is actually
          // held; this reconciles the optimistic flip in [setHeld] (and covers a
          // pause/resume issued by anything other than this store). On an older
          // native build the key is absent and reads false — the pre-hold
          // behaviour exactly.
          if (paused.value != ev.paused) paused.value = ev.paused;
        }
        break;

      case 'degraded':
        // INVARIANT 3: the recorder finished by itself. Persist what it managed
        // to capture — a partial recording the user can play beats an orphaned
        // file nobody knows about.
        final path = ev.path;
        final reason = ev.reason ?? 'degraded';
        AvaLog.I.warn('callrec', 'self-finalized: $reason');
        // [CALLREC-TELEM-1] `callrec_degraded` is the EVERY-reason event and is
        // what the degradation ladder should be queried on. It used to be
        // reported as `callrec_storage_stop` regardless of reason, which meant
        // `encoder_failed`, `ring_overflow` and both `*_leg_stalled` reasons all
        // arrived under a name that says "the phone ran out of space" — a reader
        // filtering for a storage problem would have found four unrelated bugs,
        // and a reader looking for the ladder firing at all would not have
        // thought to look here.
        await Analytics.capture('callrec_degraded', {
          ..._corr(ev.callId),
          'reason': reason,
          'duration_ms': ev.durationMs,
          'bytes': ev.bytes,
          'free_mb': _intOf(ev.data['freeMb']),
          'dropped_ms': _intOf(ev.data['droppedMs']),
          'pause_count': _intOf(ev.data['pauseCount']),
          'paused_total_ms': _intOf(ev.data['pausedTotalMs']),
        });
        // Kept, but ONLY for the reason it names — spec §7 lists
        // `callrec_storage_stop {free_mb}` as the device-storage signal, and the
        // arm-time refusal in [start] emits it too, so the two ends of the same
        // problem stay on one event name.
        if (reason == 'low_storage') {
          await Analytics.capture('callrec_storage_stop', {
            ..._corr(ev.callId),
            'stage': 'mid_call',
            'reason': reason,
            'duration_ms': ev.durationMs,
            'bytes': ev.bytes,
            'free_mb': _intOf(ev.data['freeMb']),
          });
        }
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
        final code = ev.code ?? 'unknown';
        final detail = '${ev.data['detail'] ?? ''}';
        AvaLog.I.error('callrec', 'native error $code: $detail');
        // [CALLREC-TELEM-1] A named event FIRST, then the exception.
        //
        // These used to land only as `$exception`, which is the wrong shape for
        // the two questions actually being asked: "on what fraction of
        // recordings did a leg go silent" and "which leg, on which device". Both
        // are funnel/breakdown questions and neither can be asked of Error
        // Tracking. The exception is still raised — an Issue is how this gets
        // NOTICED — but the event is how it gets understood.
        switch (code) {
          case 'near_no_samples':
          case 'far_no_samples':
            // THE failure this feature's biggest risk describes: the adapter
            // resolved, `addCallback` succeeded, and the callback never fired.
            // `leg` is split out of the code so near and far are one breakdown
            // rather than two event names to remember.
            await Analytics.capture('callrec_leg_silent', {
              ..._corr(ev.callId),
              'leg': code.startsWith('near') ? 'near' : 'far',
              'adapter_source': '${ev.data['adapterSource'] ?? ''}',
              'detail': detail,
            });
            break;
          case 'leg_stalled':
            // Started, then stopped delivering. Both callbacks are clock-driven,
            // so this is never "nobody spoke" — see the native doc comment.
            await Analytics.capture('callrec_leg_stalled', {
              ..._corr(ev.callId),
              'leg': '${ev.data['leg'] ?? ''}',
              'gap_ms': _intOf(ev.data['gapMs']),
              'stall_events': _intOf(ev.data['stallEvents']),
              'adapter_source': '${ev.data['adapterSource'] ?? ''}',
            });
            break;
          default:
            await Analytics.capture('callrec_native_error', {
              ..._corr(ev.callId),
              'code': code,
              'detail': detail,
            });
        }
        await Analytics.captureException(
          StateError('callrec_native:$code'),
          StackTrace.current,
          screen: 'callrec',
          handled: true,
          extra: {
            ..._corr(ev.callId),
            'code': code,
            'detail': detail,
            'leg': '${ev.data['leg'] ?? ''}',
            'adapter_source': '${ev.data['adapterSource'] ?? ''}',
          },
        );
        break;

      case 'legResumed':
        // [CALLREC-TELEM-1] The other half of `callrec_leg_stalled`. Without it a
        // stall looks permanent in PostHog even when the leg came back 400 ms
        // later, and every Bluetooth SCO transition reads as a broken recording.
        await Analytics.capture('callrec_leg_resumed', {
          ..._corr(ev.callId),
          'leg': '${ev.data['leg'] ?? ''}',
          'stalled_ms': _intOf(ev.data['stalledMs']),
          'stall_events': _intOf(ev.data['stallEvents']),
        });
        break;

      case 'legFirstSample':
        // [CALLREC-TELEM-1] ⭐ THE PROOF THAT THE TAP ACTUALLY WORKS.
        //
        // `callrec_adapter_probe` says the field resolved and the subscribe
        // returned true. It does NOT say audio arrived — and for the near-end
        // microphone tap, which nothing in this app has ever used, those are
        // genuinely different outcomes. A session with `near=none` on the probe
        // and NO `leg=near` row here is a bound-but-dead callback: the one
        // failure that produces a plausible-looking file containing only the
        // other person.
        //
        // Carries the ADM's OWN reported rate/channels per leg, which is where a
        // pitch-shift or a one-sided-volume complaint has to be traced to.
        await Analytics.capture('callrec_leg_first_sample', {
          ..._corr(ev.callId),
          'leg': '${ev.data['leg'] ?? ''}',
          'first_sample_ms': _intOf(ev.data['firstSampleMs']),
          'input_rate': _intOf(ev.data['inputRate']),
          'input_channels': _intOf(ev.data['inputChannels']),
          'out_rate': _intOf(ev.data['outRate']),
          'rejected_batches': _intOf(ev.data['rejected']),
          'adapter_source': '${ev.data['adapterSource'] ?? ''}',
        });
        break;

      case 'drift':
        // [CALLREC-TELEM-1] One periodic HEALTH row per 5 s, rich enough that a
        // reader does not have to join five event types to judge a recording.
        //
        // `leg_delta_ms` is the number that matters — how far the two legs have
        // moved relative to EACH OTHER — and it is the Phase 1 gate (<40 ms over
        // 30 min). It was already emitted, but as a STRING, which silently made
        // it unusable for every numeric aggregation PostHog can do: no average,
        // no p95, no "show me sessions over 40 ms". Interpolated numbers land as
        // strings in PostHog and sort lexicographically, so "9" > "40". All the
        // numeric fields below are sent as real ints.
        await Analytics.capture('callrec_drift', {
          ..._corr(ev.callId),
          'leg_delta_ms': _intOf(ev.data['legDeltaMs']),
          'near_drift_ms': _intOf(ev.data['nearDriftMs']),
          'far_drift_ms': _intOf(ev.data['farDriftMs']),
          'near_corrected_ms': _intOf(ev.data['nearCorrectedMs']),
          'far_corrected_ms': _intOf(ev.data['farCorrectedMs']),
          'near_gap_ms': _intOf(ev.data['nearGapMs']),
          'far_gap_ms': _intOf(ev.data['farGapMs']),
          'near_stale_ms': _intOf(ev.data['nearStaleMs']),
          'far_stale_ms': _intOf(ev.data['farStaleMs']),
          'near_dropped_ms': _intOf(ev.data['nearDroppedMs']),
          'far_dropped_ms': _intOf(ev.data['farDroppedMs']),
          'near_stalls': _intOf(ev.data['nearStalls']),
          'far_stalls': _intOf(ev.data['farStalls']),
          'near_rate': _intOf(ev.data['nearRate']),
          'far_rate': _intOf(ev.data['farRate']),
          'near_channels': _intOf(ev.data['nearChannels']),
          'far_channels': _intOf(ev.data['farChannels']),
          'near_batches': _intOf(ev.data['nearBatches']),
          'far_batches': _intOf(ev.data['farBatches']),
          'near_rejected': _intOf(ev.data['nearRejected']),
          'far_rejected': _intOf(ev.data['farRejected']),
          'elapsed_ms': _intOf(ev.data['elapsedMs']),
          'paused_total_ms': _intOf(ev.data['pausedTotalMs']),
          'paused': ev.data['paused'] == true,
        });
        break;

      case 'rateChange':
        // Bluetooth SCO and speaker/wired transitions change the capture rate
        // mid-call (spec §3.3). Native resamples; this is here so a pitch-shift
        // report can be correlated against a real route change.
        await Analytics.capture('callrec_rate_change', {
          ..._corr(ev.callId),
          'leg': '${ev.data['leg'] ?? ''}',
          'from': _intOf(ev.data['from']),
          'to': _intOf(ev.data['to']),
          'channels': _intOf(ev.data['channels']),
        });
        break;

      case 'probe':
        // [CALLREC-TELEM-1] ⭐ QUERY THIS FIRST when anyone reports that
        // recording did not work.
        //
        // This was previously an info-level `AvaLog` line and NOTHING ELSE.
        // Only non-info AvaLog lines are forwarded to PostHog Logs, so the
        // single most diagnostic fact in the whole feature — whether the
        // never-before-used microphone tap bound, and on what hardware — existed
        // only in a local ring buffer on the tester's phone. It could not be
        // pulled, which for a feature diagnosed entirely from PostHog is the
        // same as not existing.
        final nearTok = '${ev.data['near'] ?? 'unknown'}';
        final farTok = '${ev.data['far'] ?? 'unknown'}';
        final source = '${ev.data['adapterSource'] ?? 'unknown'}';
        final bound = nearTok == 'none' && farTok == 'none';
        await Analytics.capture('callrec_adapter_probe', {
          ..._corr(ev.callId),
          // The headline booleans, so a reader does not have to know the token
          // vocabulary to answer "did it bind".
          'ok': bound,
          'near_ok': nearTok == 'none',
          'far_ok': farTok == 'none',
          // …and the exact tokens, so someone who does can tell
          // `adapter_field_null` (R8 stripped it / the field was renamed by a
          // flutter_webrtc bump) from `method_call_handler_null` (we probed
          // before the plugin was ready) from `webrtc_plugin_null` (no plugin at
          // all) from `exception:NoSuchFieldException`.
          'near': nearTok,
          'far': farTok,
          // `engine_bound` is correct; `shared_singleton` is the fallback that
          // produced the 2026-08-05 `adapter_field_null` bug; and
          // `engine_bound_singleton_mismatch` means a second plugin instance
          // owns the static — a working probe that is one engine restart away
          // from not working.
          'adapter_source': source,
          // Device context. A binding failure is about the OEM's WebRTC build,
          // the API level and the audio HAL — never about the user. This is what
          // turns "it didn't work on his phone" into "it doesn't work on this
          // SoC family".
          'manufacturer': '${ev.data['manufacturer'] ?? ''}',
          'model': '${ev.data['model'] ?? ''}',
          'device_name': '${ev.data['device'] ?? ''}',
          'api_level': _intOf(ev.data['apiLevel']),
          // §9's open question: if the near tap is PRE-APM, a device without a
          // hardware AEC records un-cancelled far-end leakage into the near leg
          // and mono summing comb-filters it. "The recording echoes but the call
          // was clean" should correlate with hw_aec=false, not with the mixer.
          'hw_aec': ev.data['hwAec'] == true,
          'out_rate': _intOf(ev.data['outRate']),
          'stereo': ev.data['stereo'] == true,
        });
        if (bound) {
          AvaLog.I.log('callrec', 'adapter probe ok (source=$source)');
        } else {
          // warn → forwarded to PostHog Logs, so the tokens are retrievable by
          // severity as well as by event.
          AvaLog.I.warn('callrec',
              'adapter probe FAILED: source=$source near=$nearTok far=$farTok');
        }
        break;

      default:
        // A native build newer than this client must never crash it.
        AvaLog.I.log('callrec', 'unhandled event ${ev.type}');
    }
  }

  /// Coerce a platform-channel value to an int. Native sends Long/Int/Boolean
  /// across the channel; anything unexpected reads as 0 rather than throwing
  /// inside a telemetry path.
  static int _intOf(Object? v) {
    if (v is num) return v.toInt();
    if (v is bool) return v ? 1 : 0;
    return int.tryParse('${v ?? ''}') ?? 0;
  }

  /// The per-leg closing summary native attaches to its FINAL `state` event.
  /// Empty on every mid-session state event, which is how the caller knows not
  /// to overwrite a good summary with nothing.
  static Map<String, Object> _legSummaryOf(Map<String, dynamic> d) {
    if (!d.containsKey('nearStarted') && !d.containsKey('farStarted')) {
      return const <String, Object>{};
    }
    return <String, Object>{
      'near_started': d['nearStarted'] == true,
      'far_started': d['farStarted'] == true,
      'near_batches': _intOf(d['nearBatches']),
      'far_batches': _intOf(d['farBatches']),
      'near_rate': _intOf(d['nearRate']),
      'far_rate': _intOf(d['farRate']),
      'near_channels': _intOf(d['nearChannels']),
      'far_channels': _intOf(d['farChannels']),
      'near_gap_ms': _intOf(d['nearGapMs']),
      'far_gap_ms': _intOf(d['farGapMs']),
      'near_dropped_ms': _intOf(d['nearDroppedMs']),
      'far_dropped_ms': _intOf(d['farDroppedMs']),
      'near_stalls': _intOf(d['nearStalls']),
      'far_stalls': _intOf(d['farStalls']),
      'near_rejected': _intOf(d['nearRejected']),
      'far_rejected': _intOf(d['farRejected']),
      'sample_rate': _intOf(d['sampleRate']),
      'channels': _intOf(d['channels']),
      'stereo': d['stereo'] == true,
    };
  }

  void _resetSession() {
    _pending = null;
    activeCallId.value = null;
    progress.value = null;
    // [CALLHOLD-1] A finished session is never "paused". Clearing it here is what
    // guarantees the next recording cannot inherit a stale hold — the same
    // "a hold that can never be released is worse than no hold at all" property
    // the call layer's focus-hold watchdog exists for.
    paused.value = false;
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
