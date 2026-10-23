import 'repos/config_repo.dart';

/// [HF-CALL-MODES-E2] The four public flags from `GET /api/config` that gate every call-modes / queue / chunk-billing /
/// booking-lengths screen. All false until the server says true (or when the config could not be read), so with the flags
/// off the app behaves exactly as before. Services.boot() fills these from the saved and the fresh config; tests set them.
abstract final class CallFlags {
  /// `hfCallModesEnabled`: three-way Online / Bookings only / Offline and the fan's callState buttons.
  static bool modes = false;

  /// `hfCallQueueEnabled`: join the queue, the queue screen and the influencer's "N waiting".
  static bool queue = false;

  /// `hfCallChunkBillingEnabled`: fundedUntil / short / capAt aware in-call banner, max 5 hours.
  static bool chunkBilling = false;

  /// `hfBookingLengthsEnabled`: booking length picker (15 min to 5 h) and the 15-minute hold copy.
  static bool bookingLengths = false;

  static void apply(AppConfig c) {
    modes = c.callModesEnabled;
    queue = c.callQueueEnabled;
    chunkBilling = c.callChunkBillingEnabled;
    bookingLengths = c.bookingLengthsEnabled;
  }

  /// Tests: back to the all-off state.
  static void reset() {
    modes = false;
    queue = false;
    chunkBilling = false;
    bookingLengths = false;
  }
}

/// The lengths a booking can have when [CallFlags.bookingLengths] is on (minutes).
const List<int> kBookingLengths = [15, 30, 60, 120, 180, 240, 300];

/// "15 min", "30 min", "1 h", "2 h" ... "5 h" (also "1 h 30 min" for an odd length).
String lengthLabel(int minutes) {
  if (minutes < 60) return '$minutes min';
  final h = minutes ~/ 60;
  final m = minutes % 60;
  return m == 0 ? '$h h' : '$h h $m min';
}

/// What an old booking row or slots answer without a length means: 15 minutes when lengths are on, else the old 10.
int defaultBookingMinutes() => CallFlags.bookingLengths ? 15 : 10;

/// [HF-CALL-MODES-E2] Set when the caller taps TOP UP from inside a call (chunk billing on): the payment result screen then
/// offers "BACK TO YOUR CALL" instead of "BACK TO WALLET". Cleared when the call ends.
abstract final class CallReturn {
  static String? callId;
}
