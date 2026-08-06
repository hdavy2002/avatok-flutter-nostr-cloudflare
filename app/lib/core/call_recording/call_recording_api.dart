/// [CALLREC-CORE-1] Client for the four call-recording Worker routes.
///
/// Server: `worker/src/routes/callrec.ts`, wired in `worker/src/index.ts:809+`.
/// Every route is `requireUser`-authed and gated on `callRecordingEnabled`, so
/// all four answer **403** while the flag is off — that is expected, not a bug,
/// and is reported here as [CallRecFinalizeOutcome.disabled] rather than as an
/// exception.
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

  /// 413 `recording_too_large` — past `MAX_AUDIO_BYTES` (64 MB decoded). The
  /// resumable lane that would fix this is a known 501 (spec §5.1).
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

class CallRecordingApi {
  CallRecordingApi._();

  static const String _base = '$kApiBase/callrec';

  /// Upload the finished audio and create the Inbox card.
  ///
  /// v1 transport is a single-shot base64 JSON POST, matching the server. The
  /// resumable lane (`upload_id`) answers 501 today, so we do not attempt it —
  /// a client that sent `upload_id` would get a 501 and lose the recording for
  /// no benefit. The generous timeout is deliberate: a 30 MB body on a weak
  /// mobile uplink genuinely takes minutes, and giving up early turns a slow
  /// upload into a failed one.
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

    CallRecFinalizeStatus status;
    if (res.statusCode == 413) {
      status = code == 'recording_too_large'
          ? CallRecFinalizeStatus.tooLarge
          : CallRecFinalizeStatus.storageFull;
    } else if (res.statusCode == 403) {
      status = CallRecFinalizeStatus.disabled;
    } else if (res.statusCode == 400 || res.statusCode == 501) {
      status = CallRecFinalizeStatus.rejected;
    } else {
      status = CallRecFinalizeStatus.retryable;
    }
    AvaLog.I.log('callrec',
        'finalize $callId -> ${res.statusCode} ${code.isEmpty ? '' : code}');
    return CallRecFinalizeOutcome(
      status: status,
      errorCode: code.isEmpty ? null : code,
      message: _s(body['message']),
      httpStatus: res.statusCode,
    );
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
