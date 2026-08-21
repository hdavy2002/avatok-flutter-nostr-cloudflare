// [STREAM-PERM-1] Mic/camera preflight + honest classification of a
// `getUserMedia` failure. ONE place, shared by the legacy Cloudflare lane
// (`core/calls/call_session.dart`) and the Stream lane (`streamlane/`).
//
// WHY THIS EXISTS. On 2026-08-21 build 10612 failed 100% of calls with
//
//     Unable to getUserMedia: getUserMedia(): unknown factoryId null
//
// — a WebRTC ENGINE fault (the `stream_webrtc_flutter` fork resolves a native
// `PeerConnectionFactory` by `factoryId`, and the legacy lane never creates
// one). `RECORD_AUDIO` was `granted=true` on both test devices the whole time.
// But `call_session.dart` classified *every* non-timeout `getUserMedia` throw as
// `media_denied` and told the user "Microphone permission is needed to make a
// call". Three rounds of the incident were spent chasing OS permissions and
// emulator audio that were never the problem. See
// `Specs/AUDIT-2026-08-21-build-10612-getusermedia-factoryid.md` §4.
//
// RULES:
//  1. ONLY a real denial mentions permissions. If the OS says the permission is
//     granted, the copy must not send the user to Settings.
//  2. THE OS IS THE AUTHORITY on denial, not the exception string. We ask
//     `permission_handler` for the actual state and let it override the text.
//  3. NEVER BLOCK A CALL ON THE PREFLIGHT ITSELF. On any platform or plugin
//     failure the preflight returns [MediaPermissionOutcome.unknown] and the
//     caller proceeds — a broken checker must not become a broken dialer.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart';

import '../analytics.dart';

// ─────────────────────────────────────────────────────────────────────────────
//  PREFLIGHT
// ─────────────────────────────────────────────────────────────────────────────

/// What the OS says about mic (+ camera) right now.
enum MediaPermissionOutcome {
  /// Everything the call needs is granted. Proceed.
  granted,

  /// The user said no this time. Asking again is allowed.
  denied,

  /// The user said "don't ask again", or the OS/an admin blocks it. The only
  /// way back is the app-settings page — see [CallMediaPermissions.openSettings].
  permanentlyDenied,

  /// The check could not be performed (unsupported platform, plugin error).
  /// NOT a denial — the caller must proceed as if granted.
  unknown,
}

/// Result of [CallMediaPermissions.ensure] / [CallMediaPermissions.inspect].
class MediaPermissionResult {
  final MediaPermissionOutcome outcome;

  /// True when the OS reports the permission as granted. `null` = unknown.
  final bool? micGranted;
  final bool? cameraGranted;

  /// `'microphone'`, `'camera'` or `''` — which one is standing in the way.
  final String blockedBy;

  const MediaPermissionResult({
    required this.outcome,
    this.micGranted,
    this.cameraGranted,
    this.blockedBy = '',
  });

  /// True when the call may proceed. [MediaPermissionOutcome.unknown] counts as
  /// "proceed" on purpose (rule 3).
  bool get canProceed =>
      outcome == MediaPermissionOutcome.granted ||
      outcome == MediaPermissionOutcome.unknown;

  /// True only when a Settings trip is the actual remedy.
  bool get needsSettings => outcome == MediaPermissionOutcome.permanentlyDenied;

  /// Stable analytics token.
  String get code {
    switch (outcome) {
      case MediaPermissionOutcome.granted:
        return 'granted';
      case MediaPermissionOutcome.denied:
        return 'denied';
      case MediaPermissionOutcome.permanentlyDenied:
        return 'permanently_denied';
      case MediaPermissionOutcome.unknown:
        return 'unknown';
    }
  }

  /// The sentence to show, or '' when there is nothing to say.
  String get message {
    if (canProceed) return '';
    final what = blockedBy == 'camera'
        ? 'camera access'
        : (cameraGranted == false && micGranted == false)
            ? 'microphone and camera access'
            : 'microphone access';
    return needsSettings
        ? 'AvaTOK needs $what to make this call. Turn it on in Settings.'
        : 'AvaTOK needs $what to make this call.';
  }
}

/// Mic/camera preflight. Call this BEFORE anything touches `getUserMedia` or
/// joins a Stream call, so a denial is explained by name instead of surfacing
/// later as an unexplained media failure.
class CallMediaPermissions {
  CallMediaPermissions._();

  /// Only Android and iOS have a runtime mic/camera permission model that
  /// `permission_handler` speaks. Anywhere else the preflight is a no-op that
  /// reports [MediaPermissionOutcome.unknown].
  static bool get _supported =>
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;

  /// Read the current state WITHOUT prompting. Cheap enough to call from an
  /// error path to find out whether a `getUserMedia` throw was really a denial.
  static Future<MediaPermissionResult> inspect({required bool video}) async {
    if (!_supported) {
      return const MediaPermissionResult(
          outcome: MediaPermissionOutcome.unknown);
    }
    try {
      final mic = await Permission.microphone.status;
      final cam =
          video ? await Permission.camera.status : PermissionStatus.granted;
      return _resolve(mic: mic, cam: cam, video: video);
    } catch (_) {
      return const MediaPermissionResult(
          outcome: MediaPermissionOutcome.unknown);
    }
  }

  /// Check, and REQUEST anything that is merely `denied` (never granted, or
  /// refused once). A permanently-denied permission is reported as such rather
  /// than re-requested — the OS would silently return the same answer.
  ///
  /// [surface] is a free-form tag for telemetry (`'legacy_lane'`,
  /// `'stream_lane'`, …); [callId] joins the event to the rest of the call.
  static Future<MediaPermissionResult> ensure({
    required bool video,
    String surface = '',
    String callId = '',
  }) async {
    if (!_supported) {
      return const MediaPermissionResult(
          outcome: MediaPermissionOutcome.unknown);
    }
    MediaPermissionResult result;
    try {
      var mic = await Permission.microphone.status;
      var cam =
          video ? await Permission.camera.status : PermissionStatus.granted;

      final wanted = <Permission>[
        if (mic.isDenied) Permission.microphone,
        if (video && cam.isDenied) Permission.camera,
      ];
      if (wanted.isNotEmpty) {
        final granted = await wanted.request();
        mic = granted[Permission.microphone] ?? mic;
        if (video) cam = granted[Permission.camera] ?? cam;
      }
      result = _resolve(mic: mic, cam: cam, video: video);
    } catch (_) {
      result = const MediaPermissionResult(
          outcome: MediaPermissionOutcome.unknown);
    }

    // Success value to assert (ship-gate rule 3): on a call that connected,
    // `call_media_preflight` carries `outcome='granted'`. An `outcome='denied'`
    // or `'permanently_denied'` here is the ONLY shape in which a permission
    // problem may be reported to a user.
    try {
      Analytics.capture('call_media_preflight', {
        'call_id': callId,
        'surface': surface,
        'video': video,
        'outcome': result.code,
        'blocked_by': result.blockedBy,
        'mic_granted': result.micGranted ?? false,
        'camera_granted': result.cameraGranted ?? false,
      });
    } catch (_) {/* telemetry must never break a call */}
    return result;
  }

  /// Open the OS app-settings page. The only remedy for a permanently-denied
  /// permission. Returns false when the platform could not open it.
  static Future<bool> openSettings() async {
    try {
      return await openAppSettings();
    } catch (_) {
      return false;
    }
  }

  static MediaPermissionResult _resolve({
    required PermissionStatus mic,
    required PermissionStatus cam,
    required bool video,
  }) {
    final micOk = mic.isGranted || mic.isLimited;
    final camOk = !video || cam.isGranted || cam.isLimited;
    if (micOk && camOk) {
      return MediaPermissionResult(
        outcome: MediaPermissionOutcome.granted,
        micGranted: true,
        cameraGranted: video ? true : null,
      );
    }
    final blocker = !micOk ? mic : cam;
    // `restricted` (parental controls / MDM) behaves like permanently denied:
    // requesting again cannot change it, and Settings is the only route.
    final permanent = blocker.isPermanentlyDenied || blocker.isRestricted;
    return MediaPermissionResult(
      outcome: permanent
          ? MediaPermissionOutcome.permanentlyDenied
          : MediaPermissionOutcome.denied,
      micGranted: micOk,
      cameraGranted: video ? camOk : null,
      blockedBy: !micOk ? 'microphone' : 'camera',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FAILURE CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/// The four genuinely different ways acquiring local media fails. They are four
/// different messages because they have four different remedies.
enum MediaFailureKind {
  /// The acquisition never returned. (Android 12+ background mic open.)
  timeout,

  /// The user or the OS actually refused. THE ONLY ONE THAT MENTIONS PERMISSIONS.
  permissionDenied,

  /// The WebRTC engine/plugin could not service the request at all —
  /// `unknown factoryId`, a missing plugin, a dead registrar. Nothing the user
  /// did, and nothing the user can fix in Settings.
  engineFault,

  /// There is no usable capture device, or it is busy / failing in the HAL.
  deviceFault,

  /// Unrecognised. Say something honest and vague rather than guess.
  unknown,
}

/// A classified media failure: the [kind], the analytics [code] and the
/// sentence a person reads.
class CallMediaFailure {
  final MediaFailureKind kind;

  /// True only for [MediaFailureKind.permissionDenied] AND when a Settings trip
  /// is the actual remedy. Drives whether the UI offers an "Open settings"
  /// action — never offer one for an engine fault.
  final bool canOpenSettings;

  final bool video;

  const CallMediaFailure({
    required this.kind,
    required this.video,
    this.canOpenSettings = false,
  });

  /// The `Analytics.error` code and the `_endWith` reason stem.
  ///
  /// NOTE ON CONTINUITY: before [STREAM-PERM-1] every non-timeout failure was
  /// `media_denied`. It now means an ACTUAL denial, so existing PostHog series
  /// on `media_denied` change meaning at this build — an engine fault that used
  /// to land there now lands on `media_engine_failed`.
  String get code {
    switch (kind) {
      case MediaFailureKind.timeout:
        return 'media_timeout';
      case MediaFailureKind.permissionDenied:
        return 'media_denied';
      case MediaFailureKind.engineFault:
        return 'media_engine_failed';
      case MediaFailureKind.deviceFault:
        return 'media_device_failed';
      case MediaFailureKind.unknown:
        return 'media_failed_unknown';
    }
  }

  /// The terminal `reason` for `CallSession._endWith` / `call_ended.reason`.
  /// Each has copy in `core/ui/call_failure_copy.dart`.
  String get endReason {
    switch (kind) {
      case MediaFailureKind.timeout:
        return 'media-timeout';
      case MediaFailureKind.permissionDenied:
        return 'media-denied';
      case MediaFailureKind.engineFault:
        return 'media-engine-failed';
      case MediaFailureKind.deviceFault:
        return 'media-device-failed';
      case MediaFailureKind.unknown:
        return 'media-failed';
    }
  }

  /// The sentence. Only [MediaFailureKind.permissionDenied] blames permissions.
  String get message {
    final devices = video ? 'microphone or camera' : 'microphone';
    switch (kind) {
      case MediaFailureKind.timeout:
        return video
            ? "Your microphone and camera didn't respond in time. Try the call again."
            : "Your microphone didn't respond in time. Try the call again.";
      case MediaFailureKind.permissionDenied:
        return video
            ? 'AvaTOK needs microphone and camera access to make this call.'
            : 'AvaTOK needs microphone access to make this call.';
      case MediaFailureKind.engineFault:
        // Deliberately says "not your settings". The old copy sent an incident
        // three rounds deep into OS permissions that were granted all along.
        return "AvaTOK couldn't start the call audio — this is a fault in the "
            'app, not your permissions. Restart AvaTOK and try again.';
      case MediaFailureKind.deviceFault:
        return 'Your $devices is unavailable — another app may be using it. '
            'Close it and try again.';
      case MediaFailureKind.unknown:
        return "AvaTOK couldn't start the call audio. Please try again.";
    }
  }
}

/// Engine/plugin faults: the request never reached a working capture pipeline.
const List<String> _kEngineMarkers = <String>[
  'factoryid', // `getUserMedia(): unknown factoryId null` — the 10612 regression
  'peerconnectionfactory',
  'missingpluginexception',
  'no implementation found',
  'plugin',
  'registrar',
  'unimplemented',
  'nosuchmethod',
  'not initialized',
  'null check operator',
];

/// A real refusal. Android/WebRTC surface these as `NotAllowedError` /
/// `SecurityError` / a message naming the permission.
const List<String> _kPermissionMarkers = <String>[
  'notallowederror',
  'securityerror',
  'permission',
  'denied',
  'not allowed',
];

/// Hardware / HAL / capture-device faults.
const List<String> _kDeviceMarkers = <String>[
  'notfounderror',
  'devicesnotfounderror',
  'notreadableerror',
  'trackstarterror',
  'overconstrained',
  'no device',
  'no such device',
  'audiorecord',
  'audiorecordjni',
  'i/o error',
  'in use',
  'busy',
  'failed to open',
  'open failed',
  'hardware',
];

/// Classify a `getUserMedia` (or Stream `join`) media failure.
///
/// [micGranted] / [cameraGranted] come from [CallMediaPermissions.inspect] and
/// are AUTHORITATIVE: when the OS says the permission is not granted, this is a
/// denial no matter what the exception text says. `null` = unknown, in which
/// case only the text is consulted. Pass them whenever the check is cheap —
/// "do not assume" is the whole point of this function.
CallMediaFailure classifyMediaFailure(
  Object? error, {
  required bool video,
  bool? micGranted,
  bool? cameraGranted,
  bool permissionPermanentlyDenied = false,
}) {
  if (error is TimeoutException) {
    return CallMediaFailure(kind: MediaFailureKind.timeout, video: video);
  }

  // Rule 2 — the OS outranks the string.
  if (micGranted == false || (video && cameraGranted == false)) {
    return CallMediaFailure(
      kind: MediaFailureKind.permissionDenied,
      video: video,
      canOpenSettings: permissionPermanentlyDenied,
    );
  }

  final text = (error?.toString() ?? '').toLowerCase();
  bool has(List<String> markers) => markers.any(text.contains);

  // Engine first: `unknown factoryId null` carries no permission or device
  // words, but a future engine message might, and an engine fault must never be
  // reported as a denial again.
  if (has(_kEngineMarkers)) {
    return CallMediaFailure(kind: MediaFailureKind.engineFault, video: video);
  }
  if (has(_kPermissionMarkers)) {
    // The text says permission but the OS did not contradict it. Offer Settings
    // only when we positively know it is permanently denied.
    return CallMediaFailure(
      kind: MediaFailureKind.permissionDenied,
      video: video,
      canOpenSettings: permissionPermanentlyDenied,
    );
  }
  if (has(_kDeviceMarkers)) {
    return CallMediaFailure(kind: MediaFailureKind.deviceFault, video: video);
  }
  return CallMediaFailure(kind: MediaFailureKind.unknown, video: video);
}

/// One-call convenience for an error path: reads the live permission state
/// (cheap, no prompt) and classifies against it. This is what
/// `CallSession` uses in its `getUserMedia` catch.
Future<CallMediaFailure> classifyMediaFailureWithPermissions(
  Object? error, {
  required bool video,
}) async {
  if (error is TimeoutException) {
    return CallMediaFailure(kind: MediaFailureKind.timeout, video: video);
  }
  final perms = await CallMediaPermissions.inspect(video: video);
  return classifyMediaFailure(
    error,
    video: video,
    micGranted: perms.micGranted,
    cameraGranted: perms.cameraGranted,
    permissionPermanentlyDenied: perms.needsSettings,
  );
}
