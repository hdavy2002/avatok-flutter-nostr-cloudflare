/// CALL-FSI-1: shared lock-screen incoming-call notification params.
///
/// The FCM incoming-call handler (`push/push_service.dart`, owned by another
/// work-stream) builds its `CallKitParams` with an inline `AndroidParams` that
/// does NOT explicitly request the full-screen / show-on-locked-screen behaviour.
/// On Android 14+ (API 34) the OS revokes `USE_FULL_SCREEN_INTENT` unless the
/// user grants it (see `NativeVoiceAudio.canUseFullScreenIntent`), and even when
/// granted the callkit notification must ask for the full-screen locked-screen
/// UI + a high-importance channel or the ring is silent/screenless.
///
/// This helper centralises the correct `AndroidParams` so both the FCM handler
/// and any future call-UI entry point stay aligned. `push_service.dart` should
/// swap its inline `android: const AndroidParams(...)` for a single call:
///
///     android: incomingCallAndroidParams,
///
/// (a one-line change to be made by the push_service owner — see the CALL-FSI-1
/// note in the fix plan).
library;

import 'package:flutter_callkit_incoming/entities/entities.dart';

/// Lock-screen-tuned `AndroidParams` for an incoming P2P/receptionist call.
///
/// - `isShowFullLockedScreen: true`  → the callkit activity is shown over the
///   lock screen (paired with a full-screen-intent notification) so the call UI
///   wakes the screen even when locked.
/// - `isImportant: true`             → posts on a high-importance (heads-up /
///   full-screen-intent-eligible) channel so Android surfaces it as a call.
/// - the visual fields mirror the values push_service already used, so swapping
///   in this helper changes ONLY the lock-screen/importance behaviour.
const AndroidParams incomingCallAndroidParams = AndroidParams(
  isCustomNotification: true,
  isShowLogo: false,
  isShowFullLockedScreen: true,
  isImportant: true,
  ringtonePath: 'system_ringtone_default',
  backgroundColor: '#11A37F',
  actionColor: '#4CAF50',
  incomingCallNotificationChannelName: 'Incoming calls',
);
