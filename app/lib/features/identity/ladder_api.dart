import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';

/// Trust Ladder client (PROPOSAL-PROGRESSIVE-IDENTITY.md).
/// L0 visitor → L1 member → L2 verified human → L3 KYC (payouts).
class LadderState {
  final int level;
  final Map<String, String> proofs; // proof → status
  const LadderState({required this.level, required this.proofs});
}

class LadderApi {
  static const _storage = FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), );
  static const _cacheKey = 'identity_level_v1'; // per-account scoped

  /// GET /api/identity/level — server truth; caches per account for instant paint.
  static Future<LadderState?> level() async {
    try {
      final r = await ApiAuth.getSigned(kIdentityLevelUrl);
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final proofs = <String, String>{};
      (j['proofs'] as Map?)?.forEach((k, v) {
        proofs[k.toString()] = ((v as Map?)?['status'] ?? '').toString();
      });
      final s = LadderState(level: (j['level'] as num?)?.toInt() ?? 1, proofs: proofs);
      await _storage.write(key: scopedKey(_cacheKey), value: '${s.level}');
      return s;
    } catch (_) {
      return null;
    }
  }

  static Future<int> cachedLevel() async =>
      int.tryParse(await readScoped(_storage, _cacheKey) ?? '') ?? 1;

  // ── Workers AI liveness (L2) ───────────────────────────────────────────────

  /// POST /api/id/liveness/start → session + the random challenge.
  static Future<({String sessionId, List<String> actions, String phrase})?> livenessStart() async {
    try {
      final r = await ApiAuth.postJson(kLivenessStartUrl, const {});
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final ch = (j['challenge'] as Map?) ?? const {};
      return (
        sessionId: (j['session_id'] ?? '').toString(),
        actions: ((ch['actions'] as List?) ?? const []).map((e) => e.toString()).toList(),
        phrase: (ch['phrase'] ?? '').toString(),
      );
    } catch (_) {
      return null;
    }
  }

  /// POST /api/id/liveness/upload?session=&part= — raw bytes (Clerk-authed).
  static Future<bool> livenessUpload(String sessionId, String part, Uint8List bytes) async {
    try {
      final r = await ApiAuth.postBytes(
        '$kLivenessUploadUrl?session=$sessionId&part=$part', bytes,
        extraHeaders: {'Content-Type': 'application/octet-stream'},
        timeout: const Duration(seconds: 90),
      );
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// POST /api/id/liveness/verify — returns (verified, failure message).
  static Future<({bool verified, String? message, int? attemptsRemaining})> livenessVerify(
      String sessionId) async {
    try {
      final r = await ApiAuth.postJson(kLivenessVerifyUrl, {'session_id': sessionId});
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.statusCode == 200 && j['verified'] == true) {
        return (verified: true, message: null, attemptsRemaining: null);
      }
      final checks = (j['checks'] as Map?) ?? const {};
      final failed = checks.entries.where((e) => e.value == false).map((e) => e.key).join(', ');
      return (
        verified: false,
        message: j['message']?.toString() ??
            (failed.isEmpty ? 'Verification failed — please try again.' : 'We could not confirm: $failed'),
        attemptsRemaining: (j['attempts_remaining'] as num?)?.toInt(),
      );
    } catch (_) {
      return (verified: false, message: 'Network error — try again', attemptsRemaining: null);
    }
  }
}
