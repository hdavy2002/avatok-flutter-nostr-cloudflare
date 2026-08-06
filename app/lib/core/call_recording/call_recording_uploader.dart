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

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/widgets.dart';
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
  /// short-circuits, and the server dedups on content hash + `client_id`.
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

    final key = row.blobKey ?? '';
    Uint8List? audio;
    if (key.isNotEmpty) audio = await MediaService.cachedBlob(key);
    if (audio == null || audio.isEmpty) {
      // The blob is gone and the server never got a copy — the recording is
      // lost. Say so loudly; this is the one outcome the whole feature exists
      // to prevent.
      AvaLog.I.log('callrec', 'upload $callId: local audio missing (blob=$key)');
      await Analytics.capture('callrec_upload', {
        'ok': false,
        'call_id': callId,
        'issue': 'missing_audio',
        'source': source,
      });
      return CallRecUploadResult(
          callId: callId, ok: false, issueCode: 'missing_audio');
    }

    final res = await CallRecordingApi.finalize(
      callId: callId,
      audio: audio,
      direction: row.direction.isEmpty ? 'outgoing' : row.direction,
      startedAt: row.startedAt,
      durationS: row.durationS,
      peerUid: row.peerUid,
      peerName: row.peerName,
      peerAvatar: row.peerAvatar,
    );
    final elapsed = DateTime.now().millisecondsSinceEpoch - started;

    if (res.ok) {
      await Db.I.markCallRecordingUploaded(
        callId,
        mediaId: res.mediaId ?? '',
        uploadedAt: DateTime.now().millisecondsSinceEpoch,
        convKey: res.conv,
      );
      await Analytics.capture('callrec_upload', {
        'ok': true,
        'call_id': callId,
        'ms': elapsed,
        'bytes': audio.length,
        'dedup': res.dedup,
        'source': source,
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
        'bytes': audio.length,
        'source': source,
      });
    }
    await Analytics.capture('callrec_upload', {
      'ok': false,
      'call_id': callId,
      'ms': elapsed,
      'bytes': audio.length,
      'issue': issue,
      'http': res.httpStatus,
      'source': source,
    });
    return CallRecUploadResult(
      callId: callId,
      ok: false,
      issueCode: issue,
      message: res.message,
      elapsedMs: elapsed,
    );
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
