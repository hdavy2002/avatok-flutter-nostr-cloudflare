/// [CALLREC-CORE-1] The call-recording data layer's PUBLIC shapes.
///
/// Spec: `Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md` (rev 11, final).
///
/// Deliberately dependency-free (no drift, no http, no Flutter): the UI, the
/// store and the background upload isolate all speak these types, so keeping
/// them plain makes them safe to construct in a headless WorkManager isolate.
/// The drift row → [CallRecording] mapping lives in `call_recording_store.dart`
/// so nothing outside the store ever imports generated code.
library;

/// One finished recording. `callId` is the AvaTOK call id and is the primary
/// key everywhere — locally (drift PK), on the wire (`call_id`) and in the
/// Inbox row (`client_id = callrec:<callId>`), so the same recording is
/// addressable from any layer without a second identifier.
class CallRecording {
  /// The call this was recorded from. Matches `CALL_ID_RE` on the Worker
  /// (`[A-Za-z0-9_:.-]{1,64}`); anything else is rejected server-side.
  final String callId;

  /// `callrec_<ownerUid>__<peerKey>` — mirrors `convFor()` in
  /// `worker/src/routes/callrec.ts` so the local row and the Inbox thread agree.
  /// Empty until the finalize response tells us the server's value.
  final String convKey;

  final String peerUid;
  final String peerName;
  final String peerAvatar;

  /// `incoming` | `outgoing`. The Worker 400s on anything else.
  final String direction;

  /// Epoch MILLISECONDS (the Worker's `started_at` is ms — see `Date.now()`
  /// fallback in `callRecFinalize`). Note this differs from `Messages.createdAt`
  /// in the same DB, which is epoch seconds.
  final int startedAt;

  /// Wall-clock length of the captured audio, in seconds.
  final int durationS;

  /// Size of the finished `.m4a` on disk.
  final int bytes;

  /// User-supplied. NEVER generated — there is no AI in this feature (spec §0).
  final String title;
  final String description;

  /// Key into the per-account [MediaService] blob cache holding the audio.
  /// Null only if the local copy was evicted/deleted; the server copy (when
  /// [uploadedAt] is set) can still be re-fetched via a fresh presign.
  final String? blobKey;

  /// `user_media` id returned by `POST /api/callrec/finalize`. Null ⇒ not yet
  /// uploaded (the local file is still the user's only copy).
  final String? mediaId;

  /// Epoch ms of a successful upload, or null.
  final int? uploadedAt;

  const CallRecording({
    required this.callId,
    this.convKey = '',
    this.peerUid = '',
    this.peerName = '',
    this.peerAvatar = '',
    this.direction = '',
    this.startedAt = 0,
    this.durationS = 0,
    this.bytes = 0,
    this.title = '',
    this.description = '',
    this.blobKey,
    this.mediaId,
    this.uploadedAt,
  });

  /// True once the server holds a copy. The LOCAL file is never deleted on
  /// upload — it is the user's own copy (spec §5.1) — so this is purely
  /// "is it backed up", not "is it still on this phone".
  bool get isUploaded => uploadedAt != null && (mediaId ?? '').isNotEmpty;

  /// What the card shows when the user hasn't typed a title.
  String get displayTitle {
    if (title.trim().isNotEmpty) return title.trim();
    final who = peerName.trim();
    return who.isEmpty ? 'Call recording' : 'Call with $who';
  }

  DateTime get startedAtLocal =>
      DateTime.fromMillisecondsSinceEpoch(startedAt <= 0 ? 0 : startedAt);

  Duration get duration => Duration(seconds: durationS);

  CallRecording copyWith({
    String? convKey,
    String? peerUid,
    String? peerName,
    String? peerAvatar,
    String? direction,
    int? startedAt,
    int? durationS,
    int? bytes,
    String? title,
    String? description,
    String? blobKey,
    String? mediaId,
    int? uploadedAt,
  }) =>
      CallRecording(
        callId: callId,
        convKey: convKey ?? this.convKey,
        peerUid: peerUid ?? this.peerUid,
        peerName: peerName ?? this.peerName,
        peerAvatar: peerAvatar ?? this.peerAvatar,
        direction: direction ?? this.direction,
        startedAt: startedAt ?? this.startedAt,
        durationS: durationS ?? this.durationS,
        bytes: bytes ?? this.bytes,
        title: title ?? this.title,
        description: description ?? this.description,
        blobKey: blobKey ?? this.blobKey,
        mediaId: mediaId ?? this.mediaId,
        uploadedAt: uploadedAt ?? this.uploadedAt,
      );

  @override
  String toString() =>
      'CallRecording($callId, ${durationS}s, $bytes B, uploaded=$isUploaded)';
}

/// Where the ACTIVE session is. This describes the recorder, not any one stored
/// recording — a finished recording that is still waiting to upload leaves the
/// phase at [idle] and reports itself through
/// `CallRecordingStore.uploadIssues` / [CallRecording.isUploaded] instead.
enum CallRecordingPhase {
  /// Not recording. The resting state, and where every terminal transition ends.
  idle,

  /// Native capture is running; [CallRecordingStore.progress] ticks ~1/s.
  recording,

  /// `stop` was issued: the encoder is draining and the ADTS stream is being
  /// remuxed into a real `.m4a`. Seconds on a long call — never instant.
  finalizing,

  /// The post-call upload attempt is in flight (best-effort; failure here is
  /// NOT data loss — the local file is kept and retried).
  uploading,

  /// The last operation failed. Transient: the store returns to [idle] once the
  /// UI has had a frame to render it.
  failed,
}

/// Live capture counters, straight off the native `state`/`drift` event cadence
/// (~1 s while recording). Both come from the encoder, so `bytes` is the real
/// on-disk size and not an estimate.
class CallRecordingProgress {
  final int durationMs;
  final int bytes;
  const CallRecordingProgress({required this.durationMs, required this.bytes});

  Duration get duration => Duration(milliseconds: durationMs);

  @override
  String toString() => 'CallRecordingProgress(${durationMs}ms, $bytes B)';
}

/// Why a recording is still sitting un-uploaded. Surfaced per-callId through
/// `CallRecordingStore.uploadIssues` so a card can say something truthful
/// instead of silently looking "not backed up".
class CallRecordingUploadIssue {
  /// `storage_full` | `disabled` | `too_large` | `network` | `server`
  final String code;
  final String message;
  final int at; // epoch ms

  const CallRecordingUploadIssue({
    required this.code,
    required this.message,
    required this.at,
  });

  /// The one case that is NOT worth retrying on a timer: the user has to free
  /// space or top up before anything changes.
  bool get needsUserAction => code == 'storage_full' || code == 'too_large';

  @override
  String toString() => 'CallRecordingUploadIssue($code)';
}
