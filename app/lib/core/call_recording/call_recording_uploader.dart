/// [CALLREC-CORE-1] Deferred, retryable upload of finished call recordings.
///
/// Spec §5.1: *"Upload happens after the call ends, from the local file,
/// deferred and retryable under `workmanager`."* Nothing here runs during a
/// call — the live conversation always wins (§3.2), and a recording that takes
/// three attempts over an hour to reach the server is a complete non-event as
/// long as the local file survives.
///
/// **THE LOCAL FILE IS NEVER DELETED BY AN UPLOAD.** It is the user's own copy.
/// A successful upload only stamps `mediaId`/`uploadedAt` on the row; a 413
/// `storage_full` leaves everything exactly as it was and records WHY, so a card
/// can say "not backed up — AvaStorage is full" instead of looking broken.
///
/// ── ⚠️ [CALLREC-UPLOAD-1] NEVER READ A WHOLE RECORDING INTO MEMORY ───────────
/// Recordings are unbounded — there is no duration cap — so "read the file, then
/// base64 it" is two full copies of an arbitrarily large file on a phone that
/// may have 2 GB of RAM and is already running a call stack. Anything over
/// [kInlineUploadThresholdBytes] therefore goes through the chunked lane and is
/// read **5 MiB at a time off a `RandomAccessFile`**, hashed by streaming, and
/// PUT part by part. The only bytes ever resident are one part.
///
/// **Progress survives process death.** After every accepted part the upload id
/// and the etags so far are written to [DiskCache] (per-account scoped — a
/// parent and a child on one phone must never resume each other's upload). A
/// killed app, a dropped connection or a rebooted phone resumes at the next
/// part instead of restarting a 40 MB upload from zero. The state is keyed to
/// the file's content hash, so an edited/re-recorded file can never resume onto
/// a stale session.
///
/// ── ⚠️ ONE WORKMANAGER DISPATCHER PER PROCESS ────────────────────────────────
/// `Workmanager().initialize(cb)` stores ONE callback handle. Whichever
/// `initialize` runs last wins for EVERY task in the app, and a dispatcher that
/// doesn't recognise a task name just returns true — i.e. the task silently
/// never runs. This app already has one dispatcher
/// (`features/avadial/contacts_daily_backup.dart`), so [callRecordingDispatcher]
/// below handles BOTH task names: if ours registers last, the contacts backup
/// still runs. If theirs registers last, our background retry is dropped — which
/// is survivable, because [uploadPending] is also driven from app start and from
/// the store's own post-call attempt, and NOT survivable silently: we log it.
/// The real fix is a single app-wide dispatcher; see the handover note.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' show DartPluginRegistrant;

import 'package:crypto/crypto.dart';
import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';
import 'package:workmanager/workmanager.dart';

import '../../auth/clerk_client.dart';
import '../../features/avadial/contacts_daily_backup.dart'
    show kContactsDailyBackupTask, runDailyContactsBackup;
import '../../features/avatok/media.dart';
import '../../identity/identity.dart';
import '../analytics.dart';
import '../api_auth.dart';
import '../ava_log.dart';
import '../db.dart';
import '../disk_cache.dart';
import '../remote_config.dart';
import 'call_recording_api.dart';

/// Task name reported back to `Workmanager.executeTask`.
const String kCallRecUploadTask = 'ai.avatok.callrec.upload';

/// Unique work name. Versioned so a future scheduling change supersedes the old
/// registration instead of coexisting with it (same convention as the contacts
/// backup work).
const String kCallRecUploadWork = 'avatok-callrec-upload-v1';

/// Device-global key holding the ACTIVE Clerk account id. MUST match `_kAcct` in
/// `main.dart` and `_kAcctGlobal` in `contacts_daily_backup.dart` — it is the
/// same value, and it is what lets a headless isolate scope itself to the right
/// account on a shared phone instead of uploading under the guest scope.
const String _kAcctGlobal = 'clerk_account_id';

/// Headless entry point. MUST be top-level and MUST carry
/// `@pragma('vm:entry-point')`, or the AOT tree-shaker drops it and the task
/// silently never runs in a release APK.
@pragma('vm:entry-point')
void callRecordingDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      // Deliberate cross-feature delegation — see the dispatcher note above.
      // Handling the other feature's task here is what stops OUR initialize()
      // from breaking THEIR daily backup.
      if (task == kContactsDailyBackupTask) return await runDailyContactsBackup();
      if (task != kCallRecUploadTask) return true;
      if (!await _bootstrapIsolate()) return true;
      await RemoteConfig.refresh();
      await CallRecordingUploader.uploadPending(source: 'workmanager');
      return true;
    } catch (e, st) {
      // Never let the OS penalise/retry-storm us over an upload, but never
      // swallow it either (CLAUDE.md: no silent catch).
      AvaLog.I.log('callrec', 'upload task threw: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'workmanager_task'});
      return true;
    }
  });
}

/// Re-create, inside the headless isolate, the slice of app state an upload
/// needs: the account scope (so [Db.I] opens the RIGHT per-account file) and a
/// Clerk bearer (so [ApiAuth] can sign). Mirrors `_bootstrapIsolate` in
/// `contacts_daily_backup.dart` — duplicated rather than shared because that one
/// is private to its own library and this must not depend on it loading first.
///
/// Returns false when nobody is signed in: a guest has no server copy to make.
Future<bool> _bootstrapIsolate() async {
  try {
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();
    final acct = await DiskCache.readGlobal(_kAcctGlobal);
    if (acct == null || acct.isEmpty) return false;
    // Without this the job reads the 'guest' scope — a different SQLite file and
    // a different media dir, i.e. it would find nothing and, worse, could write
    // one account's recording under another's scope on a shared phone.
    AccountScope.id = acct;
    final clerk = ClerkClient();
    ApiAuth.clerkBearer = clerk.sessionToken;
    return true;
  } catch (e) {
    AvaLog.I.log('callrec', 'upload bootstrap failed: $e');
    return false;
  }
}

/// The result of trying to upload one recording, for the caller's telemetry and
/// for the per-card "why isn't this backed up" state.
class CallRecUploadResult {
  final String callId;
  final bool ok;

  /// Null on success. `storage_full` | `too_large` | `disabled` | `network` |
  /// `server` | `missing_audio`.
  final String? issueCode;
  final String? message;
  final int elapsedMs;

  const CallRecUploadResult({
    required this.callId,
    required this.ok,
    this.issueCode,
    this.message,
    this.elapsedMs = 0,
  });
}

class CallRecordingUploader {
  CallRecordingUploader._();

  /// Guards against two drains racing (app start + a call ending together),
  /// which would double-POST the same recording. Harmless server-side (dedup on
  /// content + `client_id`) but it would double the bytes on a mobile plan.
  static bool _draining = false;

  /// Attempt every un-uploaded recording, oldest first.
  ///
  /// Stops early on the first non-retryable network failure so a phone with no
  /// signal doesn't burn through ten multi-megabyte POSTs to learn the same
  /// thing ten times. Per-recording user-action failures (`storage_full`,
  /// `too_large`) do NOT stop the drain — a later, smaller recording might still
  /// fit.
  static Future<List<CallRecUploadResult>> uploadPending(
      {String source = 'app'}) async {
    if (_draining) return const <CallRecUploadResult>[];
    _draining = true;
    final out = <CallRecUploadResult>[];
    try {
      final rows = await Db.I.pendingCallRecordingUploads();
      for (final row in rows) {
        final r = await uploadOne(row.callId, source: source);
        out.add(r);
        if (!r.ok && r.issueCode == 'network') break;
      }
    } catch (e, st) {
      AvaLog.I.log('callrec', 'upload drain failed: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'upload_drain'});
    } finally {
      _draining = false;
    }
    return out;
  }

  /// Upload ONE recording. Safe to call repeatedly: an already-uploaded row
  /// short-circuits, the server dedups on content hash + `client_id`, and a
  /// half-finished chunked upload resumes rather than restarting.
  ///
  /// Picks its lane by FILE SIZE — see [kInlineUploadThresholdBytes]. Everything
  /// past it is streamed; nothing here ever holds a whole recording.
  static Future<CallRecUploadResult> uploadOne(String callId,
      {String source = 'app'}) async {
    final started = DateTime.now().millisecondsSinceEpoch;
    final row = await Db.I.callRecordingById(callId);
    if (row == null) {
      return CallRecUploadResult(
          callId: callId, ok: false, issueCode: 'missing_audio');
    }
    if (row.uploadedAt != null && (row.mediaId ?? '').isNotEmpty) {
      return CallRecUploadResult(callId: callId, ok: true);
    }

    final blobKey = row.blobKey ?? '';
    final file = blobKey.isEmpty ? null : await _blobFile(blobKey);
    final size = file == null ? 0 : await _fileLength(file);
    if (size <= 0) {
      // The blob is gone and the server never got a copy — the recording is
      // lost. Say so loudly; this is the one outcome the whole feature exists
      // to prevent.
      AvaLog.I.log('callrec', 'upload $callId: local audio missing (blob=$blobKey)');
      await _clearResume(callId);
      await Analytics.capture('callrec_upload', {
        'ok': false,
        'call_id': callId,
        'issue': 'missing_audio',
        'source': source,
      });
      return CallRecUploadResult(
          callId: callId, ok: false, issueCode: 'missing_audio');
    }

    _Attempt attempt;
    try {
      attempt = size <= kInlineUploadThresholdBytes
          ? await _uploadInline(row, blobKey)
          : await _uploadChunked(row, file!, size);
    } catch (e, st) {
      // Anything unexpected (a disk read error mid-stream, a bad state file)
      // is a RETRYABLE failure, never a lost recording: the local file is
      // untouched and the row stays un-uploaded.
      AvaLog.I.log('callrec', 'upload $callId threw: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'upload_one', 'call_id': callId});
      attempt = _Attempt(
        outcome: const CallRecFinalizeOutcome(status: CallRecFinalizeStatus.retryable),
        transport: size <= kInlineUploadThresholdBytes ? 'inline' : 'chunked',
      );
    }
    final res = attempt.outcome;
    final elapsed = DateTime.now().millisecondsSinceEpoch - started;

    if (res.ok) {
      await Db.I.markCallRecordingUploaded(
        callId,
        mediaId: res.mediaId ?? '',
        uploadedAt: DateTime.now().millisecondsSinceEpoch,
        convKey: res.conv,
      );
      await _clearResume(callId);
      await Analytics.capture('callrec_upload', {
        'ok': true,
        'call_id': callId,
        'ms': elapsed,
        'bytes': size,
        'dedup': res.dedup,
        'source': source,
        'transport': attempt.transport,
        'retries': attempt.retries,
        'parts': attempt.parts,
        'resumed_from': attempt.resumedFrom,
        if (row.peerUid.isNotEmpty) 'peer_uid': row.peerUid,
      });
      return CallRecUploadResult(callId: callId, ok: true, elapsedMs: elapsed);
    }

    final issue = res.issueCode ?? 'server';
    if (issue == 'storage_full') {
      // Its own event, per the spec's telemetry list — this is a billing/quota
      // signal, not a network error, and conflating the two hides a real
      // product problem behind flaky-network noise.
      await Analytics.capture('callrec_quota_blocked', {
        'call_id': callId,
        'bytes': size,
        'source': source,
        'transport': attempt.transport,
      });
    }
    await Analytics.capture('callrec_upload', {
      'ok': false,
      'call_id': callId,
      'ms': elapsed,
      'bytes': size,
      'issue': issue,
      'http': res.httpStatus,
      'source': source,
      'transport': attempt.transport,
      'retries': attempt.retries,
      'parts': attempt.parts,
    });
    return CallRecUploadResult(
      callId: callId,
      ok: false,
      issueCode: issue,
      message: res.message,
      elapsedMs: elapsed,
    );
  }

  // ── lane 1: small recordings, one base64 POST ──────────────────────────────

  static Future<_Attempt> _uploadInline(CallRecordingRow row, String blobKey) async {
    // Small by definition (≤ 4 MiB), so the documented [MediaService] accessor
    // is fine here — this is the one path where holding the whole file is safe.
    final audio = await MediaService.cachedBlob(blobKey);
    if (audio == null || audio.isEmpty) {
      return const _Attempt(
        outcome: CallRecFinalizeOutcome(status: CallRecFinalizeStatus.retryable),
        transport: 'inline',
      );
    }
    return _Attempt(
      transport: 'inline',
      outcome: await CallRecordingApi.finalize(
        callId: row.callId,
        audio: audio,
        direction: row.direction.isEmpty ? 'outgoing' : row.direction,
        startedAt: row.startedAt,
        durationS: row.durationS,
        peerUid: row.peerUid,
        peerName: row.peerName,
        peerAvatar: row.peerAvatar,
      ),
    );
  }

  // ── lane 2: long recordings, resumable R2 multipart ────────────────────────

  /// Attempts per part before giving up on this drain. Deliberately small: a
  /// phone that has lost signal should hand back to WorkManager (minutes later,
  /// on a network constraint) rather than sit in a loop burning battery.
  static const int _partAttempts = 3;

  static Future<_Attempt> _uploadChunked(
    CallRecordingRow row,
    File file,
    int size, {
    bool allowRestart = true,
  }) async {
    final callId = row.callId;

    // Hash by STREAMING — `sha256.convert(await file.readAsBytes())` would
    // undo the entire point of this lane.
    final sha = await _sha256OfFile(file);
    if (sha == null) {
      return const _Attempt(
        outcome: CallRecFinalizeOutcome(status: CallRecFinalizeStatus.retryable),
        transport: 'chunked',
      );
    }

    // Resume only onto state that provably describes THIS file.
    var state = await _readResume(callId);
    if (state != null && (state.sha256 != sha || state.bytes != size)) {
      AvaLog.I.log('callrec', 'resume state stale for $callId — restarting');
      unawaited(CallRecordingApi.abortUpload(key: state.key, uploadId: state.uploadId));
      await _clearResume(callId);
      state = null;
    }

    var retries = 0;
    final resumedFrom = state?.parts.length ?? 0;

    if (state == null) {
      final begin = await CallRecordingApi.beginUpload(
        callId: callId, sha256Hex: sha, bytes: size,
      );
      if (!begin.ok) {
        return _Attempt(outcome: _outcomeFrom(begin), transport: 'chunked');
      }
      if (begin.skipUpload) {
        // The server already holds these bytes — complete with no parts.
        return _Attempt(
          transport: 'chunked',
          parts: 0,
          outcome: await _complete(row, begin.key, null, const []),
        );
      }
      state = _ResumeState(
        sha256: sha,
        bytes: size,
        key: begin.key,
        uploadId: begin.uploadId!,
        partSize: begin.partSize,
        parts: const <_UploadedPart>[],
      );
      await _writeResume(callId, state);
    }

    // Non-nullable from here on — every branch above either returned or set it.
    var st = state;
    final partSize = st.partSize;
    final partCount = (size + partSize - 1) ~/ partSize;
    final done = <int, String>{for (final p in st.parts) p.number: p.etag};

    final raf = await file.open();
    try {
      for (var n = 1; n <= partCount; n++) {
        if (done.containsKey(n)) continue; // already up there — never resend
        final offset = (n - 1) * partSize;
        await raf.setPosition(offset);
        final chunk = await raf.read(math.min(partSize, size - offset));
        if (chunk.isEmpty) break;

        CallRecPartResult part = const CallRecPartResult(ok: false);
        for (var attempt = 0; attempt < _partAttempts; attempt++) {
          if (attempt > 0) {
            retries++;
            await Future<void>.delayed(Duration(seconds: 2 << (attempt - 1)));
          }
          part = await CallRecordingApi.uploadPart(
            key: st.key,
            uploadId: st.uploadId,
            partNumber: n,
            // `read` already hands back a Uint8List; copying it would put TWO
            // parts in memory for no reason.
            bytes: chunk,
          );
          if (part.ok || part.expired) break;
        }

        if (part.expired) {
          // The multipart session is gone. Start over from /begin ONCE — the
          // parts already sent are unreachable, so there is nothing to salvage.
          await _clearResume(callId);
          if (!allowRestart) {
            return _Attempt(
              transport: 'chunked',
              retries: retries,
              outcome: const CallRecFinalizeOutcome(
                  status: CallRecFinalizeStatus.retryable, errorCode: 'upload_expired'),
            );
          }
          AvaLog.I.log('callrec', 'upload $callId expired at part $n — restarting once');
          await raf.close();
          final again = await _uploadChunked(row, file, size, allowRestart: false);
          return _Attempt(
            outcome: again.outcome,
            transport: 'chunked',
            retries: retries + again.retries,
            parts: again.parts,
            resumedFrom: resumedFrom,
          );
        }
        if (!part.ok) {
          // Out of attempts. Everything accepted so far is persisted, so the
          // next drain picks up exactly here.
          return _Attempt(
            transport: 'chunked',
            retries: retries,
            parts: done.length,
            resumedFrom: resumedFrom,
            outcome: CallRecFinalizeOutcome(
              status: _statusForPart(part),
              errorCode: part.errorCode,
              httpStatus: part.httpStatus,
            ),
          );
        }

        done[n] = part.etag!;
        st = st.withParts(
            [for (final e in done.entries) _UploadedPart(e.key, e.value)]);
        // Persist AFTER each accepted part — this line is what makes the upload
        // resumable across a process kill.
        await _writeResume(callId, st);
      }
    } finally {
      try {
        await raf.close();
      } catch (_) {/* already closed on the restart path */}
    }

    final parts = [
      for (final n in done.keys.toList()..sort())
        (partNumber: n, etag: done[n]!),
    ];
    final outcome = await _complete(row, st.key, st.uploadId, parts);
    if (!outcome.ok && !outcome.retryable) {
      // A rejection that a retry cannot fix — don't leave parts sitting in R2.
      await CallRecordingApi.abortUpload(key: st.key, uploadId: st.uploadId);
      await _clearResume(callId);
    }
    return _Attempt(
      outcome: outcome,
      transport: 'chunked',
      retries: retries,
      parts: parts.length,
      resumedFrom: resumedFrom,
    );
  }

  static Future<CallRecFinalizeOutcome> _complete(
    CallRecordingRow row,
    String key,
    String? uploadId,
    List<({int partNumber, String etag})> parts,
  ) =>
      CallRecordingApi.completeUpload(
        callId: row.callId,
        key: key,
        uploadId: uploadId,
        parts: parts,
        direction: row.direction.isEmpty ? 'outgoing' : row.direction,
        startedAt: row.startedAt,
        durationS: row.durationS,
        peerUid: row.peerUid,
        peerName: row.peerName,
        peerAvatar: row.peerAvatar,
      );

  static CallRecFinalizeOutcome _outcomeFrom(CallRecUploadSession s) =>
      CallRecFinalizeOutcome(
        status: s.status,
        errorCode: s.errorCode,
        message: s.message,
        httpStatus: s.httpStatus,
      );

  static CallRecFinalizeStatus _statusForPart(CallRecPartResult p) {
    if (p.httpStatus == 403) return CallRecFinalizeStatus.disabled;
    if (p.httpStatus == 413) return CallRecFinalizeStatus.tooLarge;
    if (p.httpStatus == 400) return CallRecFinalizeStatus.rejected;
    return CallRecFinalizeStatus.retryable;
  }

  // ── resumable-upload state (per account, on disk) ──────────────────────────

  /// [DiskCache] writes under `<appSupport>/cache/<AccountScope.id>/…`, so this
  /// is per-account scoped for free (rulebook §1) — one account can never resume
  /// another's upload on a shared phone.
  static String _resumeKey(String callId) => 'callrec_upload_$callId';

  static Future<_ResumeState?> _readResume(String callId) async {
    final raw = await DiskCache.read(_resumeKey(callId));
    if (raw == null || raw.isEmpty) return null;
    try {
      final m = jsonDecode(raw);
      return m is Map<String, dynamic> ? _ResumeState.fromJson(m) : null;
    } catch (e) {
      // A corrupt state file must cost a restart, not a lost recording.
      AvaLog.I.log('callrec', 'resume state unreadable for $callId: $e');
      return null;
    }
  }

  static Future<void> _writeResume(String callId, _ResumeState s) =>
      DiskCache.write(_resumeKey(callId), jsonEncode(s.toJson()));

  static Future<void> _clearResume(String callId) =>
      DiskCache.delete(_resumeKey(callId));

  // ── file helpers ───────────────────────────────────────────────────────────

  /// The [MediaService] blob as a [File]. MediaService exposes a byte reader but
  /// no path accessor, and its layout (`<appSupport>/media/<AccountScope.id>/
  /// <sanitised key>`) is a documented convention (rulebook §2) — the same one
  /// `call_recording_store.dart`'s `_deleteBlobFile` already reproduces, rather
  /// than adding a method to a file another agent owns.
  static Future<File> _blobFile(String blobKey) async {
    final base = await getApplicationSupportDirectory();
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty)
        ? 'default'
        : AccountScope.id!;
    final name = blobKey.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    return File('${base.path}/media/$scope/$name');
  }

  static Future<int> _fileLength(File f) async {
    try {
      return await f.exists() ? await f.length() : 0;
    } catch (_) {
      return 0;
    }
  }

  /// Streaming SHA-256. Reads the file in `openRead()`-sized pieces and feeds a
  /// chunked converter, so peak memory is one buffer regardless of file size.
  static Future<String?> _sha256OfFile(File f) async {
    try {
      final sink = _DigestSink();
      final input = sha256.startChunkedConversion(sink);
      await for (final chunk in f.openRead()) {
        input.add(chunk);
      }
      input.close();
      final d = sink.value;
      return d == null ? null : d.toString();
    } catch (e, st) {
      AvaLog.I.log('callrec', 'hashing failed: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'upload_hash'});
      return null;
    }
  }

  /// Ask the OS to retry the drain later. Best-effort and idempotent —
  /// `ExistingWorkPolicy.keep` means an already-queued job is left alone rather
  /// than rescheduled on every call.
  ///
  /// Android only: iOS BGTaskScheduler needs Info.plist identifiers and its own
  /// registration, and there is no `app/ios/` directory in this repo (spec §3.6).
  static Future<void> scheduleRetry() async {
    if (!Platform.isAndroid) return;
    try {
      await Workmanager().initialize(callRecordingDispatcher);
      await Workmanager().registerOneOffTask(
        kCallRecUploadWork,
        kCallRecUploadTask,
        initialDelay: const Duration(minutes: 5),
        existingWorkPolicy: ExistingWorkPolicy.keep,
        constraints: Constraints(
          // No point waking with no network — WorkManager just waits instead.
          networkType: NetworkType.connected,
          requiresBatteryNotLow: true,
        ),
        backoffPolicy: BackoffPolicy.exponential,
        backoffPolicyDelay: const Duration(minutes: 10),
        tag: 'callrec-upload',
      );
    } catch (e) {
      // A scheduling failure must never break a call teardown or app start; the
      // foreground drain still covers the common case.
      AvaLog.I.log('callrec', 'upload retry schedule failed: $e');
    }
  }
}

/// What one attempt did, so the telemetry can distinguish "uploaded 40 MB in one
/// go" from "resumed at part 7 after three retries".
class _Attempt {
  final CallRecFinalizeOutcome outcome;
  final String transport; // 'inline' | 'chunked'
  final int retries;
  final int parts;
  final int resumedFrom;
  const _Attempt({
    required this.outcome,
    required this.transport,
    this.retries = 0,
    this.parts = 0,
    this.resumedFrom = 0,
  });
}

class _UploadedPart {
  final int number;
  final String etag;
  const _UploadedPart(this.number, this.etag);
}

/// The resumable-upload bookmark. Persisted after every accepted part.
///
/// [sha256] and [bytes] are the GUARD: state is only reused when it provably
/// describes the file on disk right now, so a re-recorded call can never resume
/// onto the previous recording's session and produce a spliced object.
class _ResumeState {
  final String sha256;
  final int bytes;
  final String key;
  final String uploadId;
  final int partSize;
  final List<_UploadedPart> parts;

  const _ResumeState({
    required this.sha256,
    required this.bytes,
    required this.key,
    required this.uploadId,
    required this.partSize,
    required this.parts,
  });

  _ResumeState withParts(List<_UploadedPart> next) => _ResumeState(
        sha256: sha256,
        bytes: bytes,
        key: key,
        uploadId: uploadId,
        partSize: partSize,
        parts: next,
      );

  Map<String, dynamic> toJson() => {
        'v': 1,
        'sha256': sha256,
        'bytes': bytes,
        'key': key,
        'upload_id': uploadId,
        'part_size': partSize,
        'parts': [
          for (final p in parts) {'n': p.number, 'etag': p.etag},
        ],
      };

  static _ResumeState? fromJson(Map<String, dynamic> m) {
    final key = '${m['key'] ?? ''}';
    final uploadId = '${m['upload_id'] ?? ''}';
    final partSize = (m['part_size'] as num?)?.toInt() ?? 0;
    if (key.isEmpty || uploadId.isEmpty || partSize <= 0) return null;
    return _ResumeState(
      sha256: '${m['sha256'] ?? ''}',
      bytes: (m['bytes'] as num?)?.toInt() ?? 0,
      key: key,
      uploadId: uploadId,
      partSize: partSize,
      parts: [
        for (final p in (m['parts'] as List? ?? const []))
          if (p is Map &&
              (p['n'] as num?) != null &&
              '${p['etag'] ?? ''}'.isNotEmpty)
            _UploadedPart((p['n'] as num).toInt(), '${p['etag']}'),
      ],
    );
  }
}

/// `sha256.startChunkedConversion` wants a `Sink<Digest>`; this is the smallest
/// possible one. (`AccumulatorSink` lives in `package:convert`, which is not a
/// declared dependency of this app — and adding one for four lines would be
/// silly.)
class _DigestSink implements Sink<Digest> {
  Digest? value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}
