import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// RingtoneApi — AI Ringback Tones library (generate / list / set-default /
/// delete). Spec: Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md.
/// The server holds up to 5 per account and serves the default to callers.
const String _base = 'https://$kSignalingHost/api/ringtone';

/// One saved ringtone (metadata; audio lives in R2, played from [url]).
class Ringtone {
  final String id;
  final String name;
  final String url;
  final int seconds;
  final bool isDefault;
  final int createdAt;
  const Ringtone({
    required this.id,
    required this.name,
    required this.url,
    required this.seconds,
    required this.isDefault,
    required this.createdAt,
  });
  factory Ringtone.fromJson(Map<String, dynamic> j) => Ringtone(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        url: (j['url'] ?? '').toString(),
        seconds: (j['seconds'] as num?)?.toInt() ?? 0,
        isDefault: j['isDefault'] == true,
        createdAt: (j['createdAt'] as num?)?.toInt() ?? 0,
      );
}

/// Result of a generate call: the new list plus the remaining daily quota, or a
/// reason when it didn't happen (rate-limited / disabled / failed).
class RingtoneGenResult {
  final List<Ringtone> ringtones;
  final int remaining;
  final String? error; // null = success
  const RingtoneGenResult(this.ringtones, this.remaining, this.error);
}

class RingtoneApi {
  static List<Ringtone> _parseList(String body) {
    final j = jsonDecode(body);
    final raw = (j is Map && j['ringtones'] is List) ? j['ringtones'] as List : const [];
    return raw.map((e) => Ringtone.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  /// The account's saved ringtones (newest first). [] on any failure.
  static Future<List<Ringtone>> list() async {
    try {
      final r = await ApiAuth.getSigned('$_base/list');
      if (r.statusCode != 200) return const [];
      return _parseList(r.body);
    } catch (_) {
      return const [];
    }
  }

  /// Generate a new ringtone (MiniMax Music 2.6, server-side). Returns the new
  /// list + remaining quota, or an error reason for the UI to surface.
  static Future<RingtoneGenResult> generate(String prompt,
      {String? name, bool instrumental = true}) async {
    try {
      final r = await ApiAuth.postJson('$_base/generate', {
        'prompt': prompt,
        if (name != null && name.isNotEmpty) 'name': name,
        'instrumental': instrumental,
      }, timeout: const Duration(seconds: 90));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body) as Map<String, dynamic>;
        final list = _parseList(r.body);
        return RingtoneGenResult(list, (j['remaining'] as num?)?.toInt() ?? 0, null);
      }
      if (r.statusCode == 429) return const RingtoneGenResult([], 0, 'daily-limit');
      if (r.statusCode == 503) return const RingtoneGenResult([], 0, 'disabled');
      return const RingtoneGenResult([], 0, 'failed');
    } catch (_) {
      return const RingtoneGenResult([], 0, 'failed');
    }
  }

  /// Make [id] the account's default (the tune callers hear). Returns the list.
  static Future<List<Ringtone>> setDefault(String id) async {
    try {
      final r = await ApiAuth.postJson('$_base/$id/default', const {});
      if (r.statusCode != 200) return const [];
      return _parseList(r.body);
    } catch (_) {
      return const [];
    }
  }

  /// Delete [id] (also removes the R2 object server-side). Returns the new list.
  static Future<List<Ringtone>> delete(String id) async {
    try {
      final r = await ApiAuth.deleteSigned('$_base/$id');
      if (r.statusCode != 200) return const [];
      return _parseList(r.body);
    } catch (_) {
      return const [];
    }
  }
}
