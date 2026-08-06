/// [CALLREC-CORE-1] Client for the call-recording Worker routes.
///
/// Server: `worker/src/routes/callrec.ts`, wired in `worker/src/index.ts:809+`.
/// Every route is `requireUser`-authed and gated on `callRecordingEnabled`, so
/// they all answer **403** while the flag is off — that is expected, not a bug,
/// and is reported here as [CallRecFinalizeStatus.disabled] rather than as an
/// exception.
///
/// ── [CALLREC-UPLOAD-1] TWO UPLOAD LANES ─────────────────────────────────────
/// * **≤ [kInlineUploadThresholdBytes] (4 MiB)** → [finalize]: one base64 JSON
///   POST. ~22 minutes of the spec's mono AAC, which is most calls.
/// * **larger** → [beginUpload] / [uploadPart] / [completeUpload]: R2 multipart,
///   5 MiB at a time. A 3-hour call is ~33 MB — ~44 MB once base64'd — and a
///   single request that size fails often on mobile and is uncomfortably close
///   to a Worker isolate's 128 MB ceiling.
///
/// The chunked lane is **resumable**: `upload_id` + the etags of the parts that
/// already landed are all that is needed to carry on, and the server holds no
/// session state at all (ownership rides on the `u/<uid>/private/<sha256>` key).
/// [CallRecordingUploader] is what persists that progress across process death.
///
/// TWO RULES THAT ARE NOT NEGOTIABLE:
///  1. **Never cache or persist a presigned playback URL.** `presignDigitalReadUrl`
///     mints a short-lived credential per access; storing one gives you a stale
///     link AND a leaked signature in the DB. [playbackUrl] is called fresh each
///     time and its result is used immediately.
///  2. **`POST` — not `PATCH` — for `/meta`.** The route accepts both
///     (`index.ts:814`), and POST is what survives every proxy in between.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../analytics.dart';
import '../api_auth.dart';
import '../ava_log.dart';
import '../config.dart';

/// Why a finalize did not produce a server copy. `ok` is the only success.
enum CallRecFinalizeStatus {
  ok,

  /// 413 `quota_exceeded` / code `storage_full`. The user's AvaStorage pool is
  /// full and their wallet is empty, so uploads are refused. **Nothing is
  /// deleted, here or on the server** (spec §6) — the local file stays, the row
  /// stays un-uploaded, and the UI says why.
  storageFull,

  /// 413 `recording_too_large`. On the inline lane this means "past
  /// `MAX_INLINE_BYTES` — use the chunked lane", which the uploader picks by
  /// size before ever sending, so it should not be reachable in practice. From
  /// `/upload/begin` it means the recording is past the server's 1 GiB ceiling,
  /// which is a recorder bug rather than a long call.
  tooLarge,

  /// 403 — `callRecordingEnabled` is off server-side. Retry later; the local
  /// copy is unaffected.
  disabled,

  /// 401/403 auth, 5xx, timeouts, socket errors. Retryable.
  retryable,

  /// 400 — we sent something the server refuses (bad call_id, empty audio).
  /// Retrying identical bytes cannot help.
  rejected,
}

/// Outcome of `POST /api/callrec/finalize`.
class CallRecFinalizeOutcome {
  final CallRecFinalizeStatus status;
  final String? mediaId;
  final String? conv;
  final String? clientId;

  /// A freshly presigned URL the server hands back as a convenience. Use it
  /// immediately or drop it — NEVER store it (see the library doc).
  final String? playbackUrl;

  /// True when the server already held these exact bytes (content-addressed
  /// dedup in `registerArtifactMedia`). Still a success.
  final bool dedup;

  final String? errorCode;
  final String? message;
  final int httpStatus;

  const CallRecFinalizeOutcome({
    required this.status,
    this.mediaId,
    this.conv,
    this.clientId,
    this.playbackUrl,
    this.dedup = false,
    this.errorCode,
    this.message,
    this.httpStatus = 0,
  });

  bool get ok => status == CallRecFinalizeStatus.ok;

  /// Worth trying again on a timer. `storageFull`/`tooLarge`/`rejected` need the
  /// user (or a code change) to do something first, so a retry loop on those is
  /// just battery burn.
  bool get retryable =>
      status == CallRecFinalizeStatus.retryable ||
      status == CallRecFinalizeStatus.disabled;

  /// The short code the store stores against the callId so a card can explain
  /// itself. Null on success.
  String? get issueCode {
    switch (status) {
      case CallRecFinalizeStatus.ok:
        return null;
      case CallRecFinalizeStatus.storageFull:
        return 'storage_full';
      case CallRecFinalizeStatus.tooLarge:
        return 'too_large';
      case CallRecFinalizeStatus.disabled:
        return 'disabled';
      case CallRecFinalizeStatus.rejected:
        return 'server';
      case CallRecFinalizeStatus.retryable:
        return 'network';
    }
  }
}

/// Where an `/upload/begin` left us. `dedup` means the server already holds
/// these exact bytes and there is nothing to send — go straight to
/// [CallRecordingApi.completeUpload] with a null `uploadId`.
class CallRecUploadSession {
  final CallRecFinalizeStatus status;
  final String key;
  final String? uploadId;
  final bool dedup;

  /// Bytes per part, chosen by the SERVER (R2 requires every part but the last
  /// to be identically sized, minimum 5 MiB). Never hard-code it client-side.
  final int partSize;

  final String? errorCode;
  final String? message;
  final int httpStatus;

  const CallRecUploadSession({
    required this.status,
    this.key = '',
    this.uploadId,
    this.dedup = false,
    this.partSize = 5 * 1024 * 1024,
    this.errorCode,
    this.message,
    this.httpStatus = 0,
  });

  bool get ok => status == CallRecFinalizeStatus.ok;

  /// Nothing left to upload — the bytes are already up there.
  bool get skipUpload => ok && (dedup || (uploadId ?? '').isEmpty);
}

/// One part's outcome. [expired] means the multipart upload is gone server-side
/// (409) and the whole thing must restart at `/upload/begin` — retrying THIS
/// part can never succeed.
class CallRecPartResult {
  final bool ok;
  final String? etag;
  final bool expired;
  final int httpStatus;
  final String? errorCode;

  const CallRecPartResult({
    required this.ok,
    this.etag,
    this.expired = false,
    this.httpStatus = 0,
    this.errorCode,
  });
}

/// The size at which the client stops base64-ing a whole file into one request
/// and switches to the chunked lane. Deliberately HALF the server's inline
/// ceiling (`MAX_INLINE_BYTES`, 8 MiB) so a rounding disagreement between the
/// two never turns into a 413.
const int kInlineUploadThresholdBytes = 4 * 1024 * 1024;

class CallRecordingApi {
  CallRecordingApi._();

  static const String _base = '$kApiBase/callrec';

  /// Upload the finished audio and create the Inbox card — the SMALL-recording
  /// lane (a single base64 JSON POST). Anything over
  /// [kInlineUploadThresholdBytes] must go through [beginUpload] instead; the
  /// server 413s `recording_too_large` past 8 MiB decoded.
  ///
  /// The generous timeout is deliberate: several MB on a weak mobile uplink
  /// genuinely takes minutes, and giving up early turns a slow upload into a
  /// failed one.
  static Future<CallRecFinalizeOutcome> finalize({
    required String callId,
    required Uint8List audio,
    required String direction,
    required int startedAt,
    required int durationS,
    String peerUid = '',
    String peerName = '',
    String peerPhone = '',
    String peerAvatar = '',
    String mime = 'audio/mp4',
    Duration timeout = const Duration(minutes: 6),
  }) async {
    final http.Response res;
    try {
      res = await ApiAuth.postJson(
        '$_base/finalize',
        {
          'call_id': callId,
          'direction': direction,
          'started_at': startedAt,
          'duration_s': durationS,
          'mime': mime,
          'bytes': audio.length,
          'audio_b64': base64Encode(audio),
          if (peerUid.isNotEmpty) 'peer_uid': peerUid,
          if (peerName.isNotEmpty) 'peer_name': peerName,
          if (peerPhone.isNotEmpty) 'peer_phone': peerPhone,
          if (peerAvatar.isNotEmpty) 'peer_avatar': peerAvatar,
        },
        timeout: timeout,
      );
    } catch (e, st) {
      // A transport failure is NOT silent: the local file is still the user's
      // copy, but a persistent failure here means nobody is backed up.
      AvaLog.I.log('callrec', 'finalize transport failed for $callId: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'finalize', 'call_id': callId});
      return const CallRecFinalizeOutcome(status: CallRecFinalizeStatus.retryable);
    }

    final body = _json(res);
    final code = (body['code'] ?? body['error'] ?? '').toString();
    if (res.statusCode == 200 && body['ok'] == true) {
      return CallRecFinalizeOutcome(
        status: CallRecFinalizeStatus.ok,
        mediaId: _s(body['media_id']),
        conv: _s(body['conv']),
        clientId: _s(body['client_id']),
        playbackUrl: _s(body['playback_url']),
        dedup: body['dedup'] == true,
        httpStatus: res.statusCode,
      );
    }

    AvaLog.I.log('callrec',
        'finalize $callId -> ${res.statusCode} ${code.isEmpty ? '' : code}');
    return CallRecFinalizeOutcome(
      status: _statusFor(res.statusCode, code),
      errorCode: code.isEmpty ? null : code,
      message: _s(body['message']),
      httpStatus: res.statusCode,
    );
  }

  // ── [CALLREC-UPLOAD-1] the chunked lane ───────────────────────────────────

  /// Open a resumable upload. Sends the content hash and the total size so the
  /// server can answer the two questions that must NOT wait until 40 MB have
  /// been spent: *do you already have this?* (`dedup`) and *do you have room?*
  /// (413 `storage_full`).
  ///
  /// [sha256Hex] is used by the server for KEY SELECTION only — the object lands
  /// at `u/<uid>/private/<sha256>`, inside the caller's own prefix — never as an
  /// authorization claim.
  static Future<CallRecUploadSession> beginUpload({
    required String callId,
    required String sha256Hex,
    required int bytes,
    String mime = 'audio/mp4',
  }) async {
    final http.Response res;
    try {
      res = await ApiAuth.postJson(
        '$_base/upload/begin',
        {'call_id': callId, 'sha256': sha256Hex, 'bytes': bytes, 'mime': mime},
        timeout: const Duration(seconds: 30),
      );
    } catch (e, st) {
      AvaLog.I.log('callrec', 'upload begin transport failed for $callId: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'upload_begin', 'call_id': callId});
      return const CallRecUploadSession(status: CallRecFinalizeStatus.retryable);
    }

    final body = _json(res);
    final code = (body['code'] ?? body['error'] ?? '').toString();
    if (res.statusCode == 200 && body['ok'] == true) {
      return CallRecUploadSession(
        status: CallRecFinalizeStatus.ok,
        key: _s(body['key']) ?? '',
        uploadId: _s(body['upload_id']),
        dedup: body['dedup'] == true,
        partSize: _partSize(body['part_size']),
        httpStatus: res.statusCode,
      );
    }
    AvaLog.I.log('callrec', 'upload begin $callId -> ${res.statusCode} $code');
    return CallRecUploadSession(
      status: _statusFor(res.statusCode, code),
      errorCode: code.isEmpty ? null : code,
      message: _s(body['message']),
      httpStatus: res.statusCode,
    );
  }

  /// Send ONE part. [bytes] must be exactly `partSize` long except for the final
  /// part — that is an R2 rule, not ours, and violating it fails at `complete`
  /// rather than here.
  ///
  /// Peak memory is ~2 parts (10 MiB): `ApiAuth.putBytes` copies the buffer to
  /// hand `http` a `Uint8List`. Bounded and constant — it does NOT scale with
  /// the length of the recording, which is the property that matters.
  static Future<CallRecPartResult> uploadPart({
    required String key,
    required String uploadId,
    required int partNumber,
    required Uint8List bytes,
    Duration timeout = const Duration(minutes: 3),
  }) async {
    final url = '$_base/upload/part'
        '?key=${Uri.encodeQueryComponent(key)}'
        '&upload_id=${Uri.encodeQueryComponent(uploadId)}'
        '&part_number=$partNumber';
    final http.Response res;
    try {
      res = await ApiAuth.putBytes(url, bytes, timeout: timeout);
    } catch (e, st) {
      // Expected on a flaky uplink — the caller retries with backoff, and the
      // parts that already landed are not resent.
      AvaLog.I.log('callrec', 'part $partNumber transport failed: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'upload_part', 'part': partNumber});
      return const CallRecPartResult(ok: false);
    }
    final body = _json(res);
    final code = (body['code'] ?? body['error'] ?? '').toString();
    if (res.statusCode == 200 && body['ok'] == true) {
      final etag = _s(body['etag']);
      if (etag != null) {
        return CallRecPartResult(ok: true, etag: etag, httpStatus: res.statusCode);
      }
    }
    AvaLog.I.log('callrec', 'part $partNumber -> ${res.statusCode} $code');
    return CallRecPartResult(
      ok: false,
      // 409 = the multipart upload is gone (aborted, or R2 expired it). Restart
      // at beginUpload; retrying this part is guaranteed to fail forever.
      expired: res.statusCode == 409 || code == 'upload_expired',
      httpStatus: res.statusCode,
      errorCode: code.isEmpty ? null : code,
    );
  }

  /// Assemble the parts and create the Inbox card. Returns the SAME outcome type
  /// [finalize] does, because server-side it runs the same code.
  ///
  /// Pass a null/empty [uploadId] only for the `dedup` case from [beginUpload].
  static Future<CallRecFinalizeOutcome> completeUpload({
    required String callId,
    required String key,
    required String? uploadId,
    required List<({int partNumber, String etag})> parts,
    required String direction,
    required int startedAt,
    required int durationS,
    String peerUid = '',
    String peerName = '',
    String peerPhone = '',
    String peerAvatar = '',
    String mime = 'audio/mp4',
  }) async {
    final http.Response res;
    try {
      res = await ApiAuth.postJson(
        '$_base/upload/complete',
        {
          'call_id': callId,
          'key': key,
          if (uploadId != null && uploadId.isNotEmpty) 'upload_id': uploadId,
          'parts': [
            for (final p in parts) {'part_number': p.partNumber, 'etag': p.etag},
          ],
          'direction': direction,
          'started_at': startedAt,
          'duration_s': durationS,
          'mime': mime,
          if (peerUid.isNotEmpty) 'peer_uid': peerUid,
          if (peerName.isNotEmpty) 'peer_name': peerName,
          if (peerPhone.isNotEmpty) 'peer_phone': peerPhone,
          if (peerAvatar.isNotEmpty) 'peer_avatar': peerAvatar,
        },
        // R2 stitching a few hundred MB of parts is not instant.
        timeout: const Duration(minutes: 2),
      );
    } catch (e, st) {
      AvaLog.I.log('callrec', 'upload complete transport failed for $callId: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'upload_complete', 'call_id': callId});
      return const CallRecFinalizeOutcome(status: CallRecFinalizeStatus.retryable);
    }

    final body = _json(res);
    final code = (body['code'] ?? body['error'] ?? '').toString();
    if (res.statusCode == 200 && body['ok'] == true) {
      return CallRecFinalizeOutcome(
        status: CallRecFinalizeStatus.ok,
        mediaId: _s(body['media_id']),
        conv: _s(body['conv']),
        clientId: _s(body['client_id']),
        playbackUrl: _s(body['playback_url']),
        dedup: body['dedup'] == true,
        httpStatus: res.statusCode,
      );
    }
    AvaLog.I.log('callrec', 'upload complete $callId -> ${res.statusCode} $code');
    return CallRecFinalizeOutcome(
      status: _statusFor(res.statusCode, code),
      errorCode: code.isEmpty ? null : code,
      message: _s(body['message']),
      httpStatus: res.statusCode,
    );
  }

  /// Throw away a half-finished upload so its parts don't linger in R2.
  /// Best-effort by definition — if this fails the parts are orphaned, which
  /// costs nothing user-visible (they are never counted against the quota,
  /// which is computed from `user_media` rows).
  static Future<void> abortUpload({required String key, required String uploadId}) async {
    if (key.isEmpty || uploadId.isEmpty) return;
    try {
      await ApiAuth.postJson('$_base/upload/abort',
          {'key': key, 'upload_id': uploadId},
          timeout: const Duration(seconds: 15));
    } catch (e) {
      AvaLog.I.log('callrec', 'upload abort failed: $e');
    }
  }

  /// Patch the user-supplied title/description on the Inbox row. Pass only what
  /// changed — the server 400s when BOTH are omitted.
  static Future<bool> updateMeta(String callId,
      {String? title, String? description}) async {
    if (title == null && description == null) return false;
    try {
      final res = await ApiAuth.postJson('$_base/meta', {
        'call_id': callId,
        if (title != null) 'title': title,
        if (description != null) 'description': description,
      });
      if (res.statusCode == 200) return true;
      AvaLog.I.log('callrec', 'meta $callId -> ${res.statusCode}');
      return false;
    } catch (e, st) {
      AvaLog.I.log('callrec', 'meta failed for $callId: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'meta', 'call_id': callId});
      return false;
    }
  }

  /// Soft-hide the Inbox card and release the storage quota. Idempotent
  /// server-side; a 404 means it was never uploaded (or is already gone), which
  /// the caller should treat as success — the local delete still has to happen.
  static Future<bool> delete(String callId) async {
    try {
      final res = await ApiAuth.postJson('$_base/delete', {'call_id': callId});
      if (res.statusCode == 200 || res.statusCode == 404) return true;
      AvaLog.I.log('callrec', 'delete $callId -> ${res.statusCode}');
      return false;
    } catch (e, st) {
      AvaLog.I.log('callrec', 'delete failed for $callId: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'delete', 'call_id': callId});
      return false;
    }
  }

  /// A FRESH presigned read URL. Mint one per access; never persist the result.
  static Future<String?> playbackUrl(String callId) async {
    try {
      final res = await ApiAuth.getSigned(
          '$_base/playback?call_id=${Uri.encodeQueryComponent(callId)}',
          timeout: const Duration(seconds: 12));
      if (res.statusCode != 200) {
        AvaLog.I.log('callrec', 'playback $callId -> ${res.statusCode}');
        return null;
      }
      return _s(_json(res)['playback_url']);
    } catch (e, st) {
      AvaLog.I.log('callrec', 'playback failed for $callId: $e');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'playback', 'call_id': callId});
      return null;
    }
  }

  /// Download the audio from a freshly minted presigned URL. Plain `http.get` —
  /// the presign IS the credential, so signing it again with [ApiAuth] would be
  /// wrong (it is an R2 URL, not an AvaTOK API route).
  static Future<Uint8List?> download(String presignedUrl,
      {Duration timeout = const Duration(minutes: 3)}) async {
    try {
      final res = await http.get(Uri.parse(presignedUrl)).timeout(timeout);
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) return null;
      return Uint8List.fromList(res.bodyBytes);
    } catch (e, st) {
      // Scrubbed by Analytics before it leaves the device — a presigned URL's
      // signature must never land in PostHog (AVA-MEDIA-AUTHZ-1).
      AvaLog.I.log('callrec', 'recording download failed');
      await Analytics.captureException(e, st,
          screen: 'callrec', handled: true, extra: {'stage': 'download'});
      return null;
    }
  }
}

/// ONE HTTP-status → outcome mapping for every route in this file, so the inline
/// and chunked lanes can never classify the same server answer differently.
///
/// 409 is deliberately [CallRecFinalizeStatus.retryable]: the upload session is
/// dead but the RECORDING is fine, and the fix (start again at
/// `/upload/begin`) is exactly what a retry does.
CallRecFinalizeStatus _statusFor(int httpStatus, String code) {
  if (httpStatus == 413) {
    return code == 'recording_too_large' || code == 'part_too_large'
        ? CallRecFinalizeStatus.tooLarge
        : CallRecFinalizeStatus.storageFull;
  }
  if (httpStatus == 403) return CallRecFinalizeStatus.disabled;
  if (httpStatus == 400 || httpStatus == 501) return CallRecFinalizeStatus.rejected;
  return CallRecFinalizeStatus.retryable;
}

int _partSize(Object? v) {
  final n = v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
  // A nonsense value from a future/older server must not produce zero-length
  // parts (an infinite loop) or a part R2 will reject.
  return n >= 1024 * 1024 ? n : 5 * 1024 * 1024;
}

Map<String, dynamic> _json(http.Response res) {
  try {
    final v = jsonDecode(res.body);
    return v is Map<String, dynamic> ? v : <String, dynamic>{};
  } catch (_) {
    return <String, dynamic>{};
  }
}

String? _s(Object? v) {
  if (v == null) return null;
  final s = v.toString();
  return s.isEmpty ? null : s;
}
