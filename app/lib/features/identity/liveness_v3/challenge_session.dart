import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../../core/api_auth.dart';
import '../../../core/config.dart';
import 'active_checks.dart';
import 'frame_capture.dart';
import 'voice_packs.dart';

/// Liveness V3 — SESSION + CHALLENGE client (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-
/// DRAFT.md §1/§4). POST /api/liveness/v3/session (policy-driven entrypoint —
/// plan §4-A.1) returns a per-session nonce, a RANDOMIZED challenge sequence, the
/// overlay parameters (shape/position/size — plan §4-A.7), the frame offsets to
/// sample, and a presigned R2 upload target (plan §3, upload never through the
/// Worker body). The verdict later arrives via the SAME V2 result/push path.
class LivenessV3Api {
  LivenessV3Api._();

  /// Start a V3 session. [requester] is the caller context (onboarding /
  /// marketplace_publish / guardian_require_verification / periodic_recheck —
  /// plan §0-A). [policyId] selects required stages/limits (plan §4-A.1).
  /// Returns null on any failure (e.g. 503 flag_off) so the flow shows the honest
  /// "unavailable" state instead of a dead screen.
  static Future<LivenessV3Session?> startSession({
    required String requester,
    required String policyId,
    String lang = 'en',
  }) async {
    try {
      final r = await ApiAuth.postJson(kLivenessV3SessionUrl, {
        'requester': requester,
        'policy_id': policyId,
        'lang': lang,
      });
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return LivenessV3Session.fromJson(j);
    } catch (_) {
      return null;
    }
  }

  /// Background upload of the captured clip to the R2 target from the session
  /// (plan §3 — ≤15 MB). The server returns exactly one of two PUT shapes:
  ///   • presigned_put → PUT the raw bytes DIRECTLY to R2 (no auth header — an
  ///     Authorization header would break the SigV4-signed presigned URL).
  ///   • worker_proxy  → PUT the raw bytes to the Worker (Clerk/NIP-98 SIGNED),
  ///     which stores them in R2 (dev/staging path when R2 S3 creds are unset).
  /// Returns true on 2xx. Best-effort; the caller proceeds immediately (verdict
  /// arrives async).
  static Future<bool> uploadClip(LivenessV3Upload upload, Uint8List bytes) async {
    if (!upload.isValid) return false;
    try {
      if (upload.needsAuth) {
        // Worker-proxied fallback — must be signed (route runs requireUser).
        final res = await ApiAuth.putBytes(
          upload.url, bytes,
          extraHeaders: {'Content-Type': 'application/octet-stream'},
          timeout: const Duration(seconds: 120),
        );
        return res.statusCode >= 200 && res.statusCode < 300;
      }
      // Presigned R2 PUT — plain, unauthenticated (the URL carries the signature).
      final res = await http
          .put(Uri.parse(upload.url),
              headers: {'Content-Type': upload.contentType}, body: bytes)
          .timeout(const Duration(seconds: 120));
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// POST /api/liveness/v3/verify {session_id, object_key?} → 202 {status:pending},
  /// then poll /result. Maps the V3 verdict shape ({verdict, reason_codes,
  /// attempts_remaining, level}) into the outcome record the screen consumes.
  /// [objectKey] is echoed from the session upload contract so the pipeline finds
  /// the exact R2 object. [captureMeta] carries the V3 active-checks evidence
  /// (sensor/luma timelines, flash/vibrate fire times, integrity, camera) — kept
  /// ≤32 KB by [CaptureMeta.toJsonCapped]. Absent → body unchanged.
  ///
  /// [frames] is the INTERIM client-frame path (plan §0-C "Interim frame path"):
  /// still JPEGs captured at the session capture_offsets, base64-encoded into
  /// `frames: [{t_offset_ms, jpeg_b64}]`. The server uses them as its frame set
  /// (skipping the not-yet-bound MEDIA_EXTRACT decoder) and stamps the verdict
  /// frame_source:"client". The whole body is kept <1MB by the ≤6 × ≤200KB caps
  /// enforced at capture time (frame_capture.dart) and again on the server.
  static Future<LivenessV3Outcome> verify(
    String sessionId, {
    String? objectKey,
    CaptureMeta? captureMeta,
    List<CapturedFrame> frames = const [],
  }) async {
    try {
      final body = <String, dynamic>{'session_id': sessionId};
      if (objectKey != null && objectKey.isNotEmpty) body['object_key'] = objectKey;
      if (captureMeta != null) body['capture_meta'] = captureMeta.toJsonCapped();
      if (frames.isNotEmpty) {
        body['frames'] = [
          for (final f in frames)
            {'t_offset_ms': f.tOffsetMs, 'jpeg_b64': base64Encode(f.jpeg)},
        ];
      }
      final r = await ApiAuth.postJson(kLivenessV3VerifyUrl, body);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['status'] == 'done' || j.containsKey('verdict')) {
        return LivenessV3Outcome.fromResult(j);
      }
      if (r.statusCode == 202 || j['status'] == 'pending') {
        for (var i = 0; i < 45; i++) {
          await Future<void>.delayed(const Duration(seconds: 2));
          final res = await result(sessionId);
          if (!res.pending && !res.noResult) return res;
        }
        return const LivenessV3Outcome.pending();
      }
      return LivenessV3Outcome.fromResult(j);
    } catch (_) {
      // POST failed (offline) — the background job may still have run.
      final res = await result(sessionId);
      if (!res.pending && !res.noResult) return res;
      return const LivenessV3Outcome.pending();
    }
  }

  /// GET /api/liveness/v3/result?session= — returns pending / done outcome without
  /// swallowing the pending state (used both by the poll loop and resume-on-reopen).
  static Future<LivenessV3Outcome> result(String sessionId) async {
    try {
      final r = await ApiAuth.getSigned('$kLivenessV3ResultUrl?session=$sessionId');
      if (r.statusCode != 200) return const LivenessV3Outcome.noResult();
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['status'] == 'pending') return const LivenessV3Outcome.pending();
      return LivenessV3Outcome.fromResult(j);
    } catch (_) {
      return const LivenessV3Outcome.pending();
    }
  }
}

/// The V3 verdict, mapped to the shape [LivenessV3Screen] already renders. The
/// server verdict is PASS / FAIL / REVIEW plus machine-readable `reason_codes`;
/// this collapses REVIEW into "not verified yet" (retryable) and turns the reason
/// codes into human-readable fail lines.
class LivenessV3Outcome {
  const LivenessV3Outcome({
    required this.pending,
    required this.noResult,
    required this.verified,
    required this.failedMessages,
    required this.attemptsRemaining,
  });

  const LivenessV3Outcome.pending()
      : pending = true,
        noResult = false,
        verified = false,
        failedMessages = const [],
        attemptsRemaining = null;

  const LivenessV3Outcome.noResult()
      : pending = false,
        noResult = true,
        verified = false,
        failedMessages = const [],
        attemptsRemaining = null;

  final bool pending;
  final bool noResult;
  final bool verified;
  final List<String> failedMessages;
  final int? attemptsRemaining;

  /// Human copy for the machine-readable reason codes (plan §4-A.3). Unknown codes
  /// fall through to a generic retry line so a new server code never dead-ends.
  static const Map<String, String> _reasonCopy = {
    'FACE_NOT_FOUND': "I couldn't see your face clearly — try again in good light.",
    'LOW_BRIGHTNESS': 'It was too dark — move somewhere brighter and retry.',
    'MULTIPLE_PEOPLE': 'Make sure only you are in the frame.',
    'FACE_TOO_SMALL': 'Hold the phone a little closer next time.',
    'BLUR': 'The video was blurry — hold steady and try again.',
    'PHONE_SCREEN': "That looked like a screen, not a live face.",
    'REPLAY_ATTACK': "That clip was already used — please record a fresh one.",
    'SEQUENCE_MISMATCH': "The on-screen steps weren't followed — try again.",
    'MOTION_IMPLAUSIBLE': 'The movement didn\'t look natural — try again.',
    'EXTRACTION_FAILED': "We couldn't process that clip — please try again.",
  };

  factory LivenessV3Outcome.fromResult(Map<String, dynamic> j) {
    final verdict = (j['verdict'] ?? '').toString().toUpperCase();
    final codes = ((j['reason_codes'] as List?) ?? const [])
        .map((e) => e.toString().toUpperCase())
        .toList();
    final attempts = (j['attempts_remaining'] as num?)?.toInt();
    if (verdict == 'PASS') {
      return LivenessV3Outcome(
        pending: false,
        noResult: false,
        verified: true,
        failedMessages: const [],
        attemptsRemaining: attempts,
      );
    }
    // FAIL or REVIEW (or an unrecognised/absent verdict) → not verified yet.
    final msgs = <String>[];
    for (final c in codes) {
      final m = _reasonCopy[c];
      if (m != null && !msgs.contains(m)) msgs.add(m);
    }
    if (msgs.isEmpty) {
      msgs.add(verdict == 'REVIEW'
          ? "We're still reviewing this — please try again shortly."
          : 'Verification failed — please try again.');
    }
    return LivenessV3Outcome(
      pending: false,
      noResult: false,
      verified: false,
      failedMessages: msgs,
      attemptsRemaining: attempts,
    );
  }
}

/// A single randomized challenge to execute in order (plan §0-B.1). `kind` is the
/// action; the coaching engine + flow interpret it (blink → eye-open probability,
/// turnLeft/turnRight → yaw, lookUp → pitch).
enum ChallengeKind { blink, turnLeft, turnRight, lookUp, lookDown, smile, closer, holdStill }

class LivenessChallenge {
  const LivenessChallenge(this.kind);
  final ChallengeKind kind;

  /// Parse a server challenge token. The server emits (worker/src/routes/
  /// liveness_v3.ts CHALLENGE_ACTIONS): BLINK, TURN_LEFT, TURN_RIGHT, LOOK_UP,
  /// COME_CLOSER, HOLD_STILL. We normalize by stripping separators so both the
  /// server tokens and looser aliases resolve.
  static ChallengeKind _parse(String s) {
    switch (s.toLowerCase().replaceAll(RegExp(r'[_\s-]'), '')) {
      case 'blink':
        return ChallengeKind.blink;
      case 'turnleft':
      case 'left':
        return ChallengeKind.turnLeft;
      case 'turnright':
      case 'right':
        return ChallengeKind.turnRight;
      case 'lookup':
      case 'up':
        return ChallengeKind.lookUp;
      case 'lookdown':
      case 'down':
        return ChallengeKind.lookDown;
      case 'smile':
        return ChallengeKind.smile;
      case 'comecloser': // server token COME_CLOSER
      case 'closer':
      case 'approach':
        return ChallengeKind.closer;
      case 'holdstill': // server token HOLD_STILL
      case 'hold':
        return ChallengeKind.holdStill;
      default:
        return ChallengeKind.blink;
    }
  }

  factory LivenessChallenge.fromString(String s) => LivenessChallenge(_parse(s));

  /// The Ava voice line that introduces this challenge.
  LivenessInstruction get instruction => switch (kind) {
        ChallengeKind.blink => LivenessInstruction.good,
        ChallengeKind.turnLeft => LivenessInstruction.faceLeft,
        ChallengeKind.turnRight => LivenessInstruction.faceRight,
        ChallengeKind.lookUp => LivenessInstruction.lookUp,
        ChallengeKind.lookDown => LivenessInstruction.lookDown,
        ChallengeKind.smile => LivenessInstruction.good,
        ChallengeKind.closer => LivenessInstruction.moveCloser,
        ChallengeKind.holdStill => LivenessInstruction.holdStill,
      };
}

/// The overlay shape the user must fit their face into, randomized per session so
/// a universal replay recording can't match it (plan §4-A.7). The existing V2
/// oval widget is PARAMETRIZED with these values rather than replaced.
///
/// SERVER CONTRACT (worker/src/routes/liveness_v3.ts):
///   {shape: 'circle'|'rounded_square'|'oval',
///    position: 'center'|'top_left'|'top_right'|'bottom_center',
///    offset_x, offset_y: small jitter fractions (-0.08..0.08),
///    size_factor: 0.85..1.15 scale on the base oval}
/// The server does NOT send explicit center_x/center_y/width/height — the client
/// derives center from `position` + `offset_*` and size from `size_factor`.
class LivenessOverlay {
  const LivenessOverlay({
    this.shape = 'oval',
    this.centerX = 0.5,
    this.centerY = 0.5,
    this.widthFrac = 0.5,
    this.heightFrac = 0.42,
  });

  /// 'oval' | 'circle' | 'rounded_square' — the current widget draws an
  /// oval/rounded rect (circle ≈ oval with equal-ish axes; rounded_square draws
  /// the rounded-rect variant).
  final String shape;

  /// Center as a fraction of the camera-card size (0..1).
  final double centerX;
  final double centerY;

  /// Size as a fraction of the card width/height.
  final double widthFrac;
  final double heightFrac;

  /// Base center for a named position (server `position` token).
  static (double, double) _centerFor(String position) => switch (position) {
        'top_left' => (0.34, 0.36),
        'top_right' => (0.66, 0.36),
        'bottom_center' => (0.5, 0.62),
        _ => (0.5, 0.5), // 'center'
      };

  factory LivenessOverlay.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const LivenessOverlay();
    double d(String k, double dflt) {
      final v = j[k];
      return v is num ? v.toDouble() : dflt;
    }

    final position = (j['position'] ?? 'center').toString();
    final (baseCx, baseCy) = _centerFor(position);
    final offX = d('offset_x', 0);
    final offY = d('offset_y', 0);
    final sizeFactor = d('size_factor', 1.0);
    // Clamp so a jittered overlay never leaves the card.
    double clamp01(double v) => v < 0.12 ? 0.12 : (v > 0.88 ? 0.88 : v);
    return LivenessOverlay(
      shape: (j['shape'] ?? 'oval').toString(),
      centerX: clamp01(baseCx + offX),
      centerY: clamp01(baseCy + offY),
      widthFrac: (0.5 * sizeFactor).clamp(0.3, 0.7),
      heightFrac: (0.42 * sizeFactor).clamp(0.28, 0.6),
    );
  }
}

/// R2 upload target from the session (plan §3).
///
/// SERVER CONTRACT (worker/src/routes/liveness_v3.ts buildUploadContract):
///   • R2 creds present → {mode:'presigned_put', url:<absolute presigned PUT>,
///     method:'PUT', object_key, max_bytes}. The client PUTs the raw clip bytes
///     directly to R2 (never through the Worker).
///   • R2 creds absent (dev/staging) → {mode:'worker_proxy',
///     path:'/api/liveness/v3/upload?session=<sid>', method:'PUT', object_key,
///     max_bytes}. The client PUTs the raw bytes to the Worker, which stores them.
///
/// The server NEVER returns an S3 POST-with-fields form, so [uploadClip] only has
/// to handle the two PUT shapes. `object_key` is echoed back on verify so the
/// pipeline can locate the exact object.
class LivenessV3Upload {
  const LivenessV3Upload({
    required this.mode,
    required this.url,
    this.method = 'PUT',
    this.objectKey = '',
    this.contentType = 'video/mp4',
    this.maxBytes = 15 * 1024 * 1024,
  });

  /// 'presigned_put' (direct-to-R2) | 'worker_proxy' (through the Worker) | ''.
  final String mode;

  /// The absolute URL to PUT to (presigned R2 URL, or the Worker upload URL built
  /// from the relative `path`).
  final String url;
  final String method; // always 'PUT' from the server
  final String objectKey;
  final String contentType;
  final int maxBytes;

  factory LivenessV3Upload.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const LivenessV3Upload(mode: '', url: '');
    final mode = (j['mode'] ?? '').toString();
    // presigned_put carries an absolute `url`; worker_proxy carries a relative
    // `path` we hang off the API host.
    String url = (j['url'] ?? '').toString();
    if (url.isEmpty) {
      final path = (j['path'] ?? '').toString();
      if (path.isNotEmpty) {
        // kApiBase already includes '/api'; the server path is '/api/...'.
        final origin = kApiBase.replaceFirst('/api', '');
        url = path.startsWith('/') ? '$origin$path' : '$origin/$path';
      }
    }
    return LivenessV3Upload(
      mode: mode,
      url: url,
      method: (j['method'] ?? 'PUT').toString().toUpperCase(),
      objectKey: (j['object_key'] ?? '').toString(),
      contentType: (j['content_type'] ?? 'video/mp4').toString(),
      maxBytes: (j['max_bytes'] as num?)?.toInt() ?? 15 * 1024 * 1024,
    );
  }

  /// worker_proxy needs the Clerk-signed Authorization header (requireUser on the
  /// Worker); a presigned R2 PUT must NOT carry it (breaks the SigV4 signature).
  bool get needsAuth => mode == 'worker_proxy';

  bool get isValid => url.isNotEmpty;
}

/// The full V3 session returned by the server.
class LivenessV3Session {
  const LivenessV3Session({
    required this.sessionId,
    required this.nonce,
    required this.challenges,
    required this.overlay,
    required this.captureOffsets,
    required this.upload,
    this.activeChecks = const ActiveChecks.none(),
    this.lang = 'en',
    this.maxClipBytes = 15 * 1024 * 1024,
    this.maxClipSeconds = 20,
  });

  final String sessionId;
  final String nonce;
  final List<LivenessChallenge> challenges;
  final LivenessOverlay overlay;

  /// Server-scheduled active anti-avatar checks (screen flashes, haptic buzz,
  /// randomized gaps). Absent → [ActiveChecks.none] and the flow runs unchanged.
  final ActiveChecks activeChecks;

  /// Randomized capture-frame offsets as FRACTIONS of the clip (0..1) the server
  /// samples (server field `capture_offsets`). The client records continuously and
  /// the server extracts these; the client only carries them for telemetry/debug.
  final List<double> captureOffsets;
  final LivenessV3Upload upload;
  final String lang;

  /// Max clip size in bytes (server `max_video_bytes`).
  final int maxClipBytes;

  /// Client-side recording cap in seconds. The server does NOT send a clip-length
  /// cap (its `ttl_seconds` is the SESSION lifetime, not the clip length), so this
  /// stays a client default unless a future server adds `max_clip_seconds`.
  final int maxClipSeconds;

  factory LivenessV3Session.fromJson(Map<String, dynamic> j) {
    final ch = <LivenessChallenge>[];
    for (final c in (j['challenges'] as List? ?? const [])) {
      ch.add(LivenessChallenge.fromString(c.toString()));
    }
    // Fallback: a minimal randomized default so the flow still runs if the server
    // omitted the sequence (never dead-ends).
    if (ch.isEmpty) {
      ch.addAll(const [
        LivenessChallenge(ChallengeKind.blink),
        LivenessChallenge(ChallengeKind.turnLeft),
        LivenessChallenge(ChallengeKind.turnRight),
        LivenessChallenge(ChallengeKind.closer),
      ]);
    }
    final offsets = <double>[];
    for (final o in (j['capture_offsets'] as List? ?? const [])) {
      if (o is num) offsets.add(o.toDouble());
    }
    return LivenessV3Session(
      sessionId: (j['session_id'] ?? '').toString(),
      nonce: (j['nonce'] ?? '').toString(),
      challenges: ch,
      overlay: LivenessOverlay.fromJson(j['overlay'] as Map<String, dynamic>?),
      captureOffsets: offsets,
      upload: LivenessV3Upload.fromJson(j['upload'] as Map<String, dynamic>?),
      activeChecks: ActiveChecks.fromJson(j['active_checks'] as Map<String, dynamic>?),
      lang: (j['lang'] ?? 'en').toString(),
      maxClipBytes: (j['max_video_bytes'] as num?)?.toInt() ?? 15 * 1024 * 1024,
      maxClipSeconds: (j['max_clip_seconds'] as num?)?.toInt() ?? 20,
    );
  }

  bool get isValid => sessionId.isNotEmpty;
}
