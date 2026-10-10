import 'push_gateway.dart';

/// How long after "Not now" (or a refused Android prompt) the sheet may come back.
const Duration kOptInReask = Duration(days: 14);

/// What the person last did with our opt-in sheet. The Android prompt never shows without it.
enum OptInAnswer {
  /// Tapped "Not now".
  later,

  /// Tapped "Allow", then said no to the Android prompt.
  denied,

  /// Tapped "Allow" and the Android prompt said yes.
  allowed;

  static OptInAnswer? parse(String? v) {
    for (final a in OptInAnswer.values) {
      if (a.name == v) return a;
    }
    return null;
  }
}

class OptInRecord {
  const OptInRecord({required this.answer, required this.at});

  final OptInAnswer answer;
  final DateTime at;

  String encode() => '${answer.name}|${at.toUtc().toIso8601String()}';

  static OptInRecord? decode(String? raw) {
    if (raw == null) return null;
    final i = raw.indexOf('|');
    if (i <= 0) return null;
    final answer = OptInAnswer.parse(raw.substring(0, i));
    final at = DateTime.tryParse(raw.substring(i + 1));
    if (answer == null || at == null) return null;
    return OptInRecord(answer: answer, at: at);
  }
}

/// Show the "Know when your favourite host comes online" sheet now? (spec 2.16)
///
/// Pure, so the timing is unit-tested without a phone.
///  * Never when Firebase is not running, or the `hfPushEnabled` flag is off (the token is still
///    registered quietly in that case, by the service, when permission is already granted).
///  * Never when notifications are already allowed.
///  * Once after the first sign-in, then again only after [kOptInReask] since "Not now" or a refusal.
///  * Never again after the person allowed it and later switched it off in the system settings: that is
///    their choice, and the Me screen has the toggle.
bool shouldShowOptIn({
  required bool gatewayAvailable,
  required bool flagOn,
  required PushPermission permission,
  required OptInRecord? record,
  required DateTime now,
}) {
  if (!gatewayAvailable || !flagOn) return false;
  if (permission == PushPermission.granted) return false;
  if (record == null) return true;
  if (record.answer == OptInAnswer.allowed) return false;
  return now.difference(record.at) >= kOptInReask;
}
