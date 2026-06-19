import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// RingtoneApi — ringback selection over the bundled catalog.
/// Spec: Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md.
/// The catalog itself is app-bundled (see ringtone_catalog.dart); the server
/// only stores which catalog id the account picked as its ringback.
const String _base = 'https://$kSignalingHost/api/ringtone';

class RingtoneApi {
  /// The account's currently-selected ringtone id ('' if none chosen).
  static Future<String> selected() async {
    try {
      final r = await ApiAuth.getSigned('$_base/selected');
      if (r.statusCode != 200) return '';
      return (jsonDecode(r.body)['selected'] ?? '').toString();
    } catch (_) {
      return '';
    }
  }

  /// Set [id] (a catalog id) as the account's ringback. Returns true on success.
  static Future<bool> select(String id) async {
    try {
      final r = await ApiAuth.postJson('$_base/select', {'id': id});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
