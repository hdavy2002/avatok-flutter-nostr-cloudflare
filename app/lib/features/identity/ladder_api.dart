import 'dart:async';
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

  /// The full structured verify outcome the V2 result UX needs. `checks` is the
  /// list of `{id, pass, user_message}` from the server (LIVE-V2 P3); the fail
  /// screen renders EVERY failing `user_message` as its own line. `pending` means
  /// the async verify hasn't finished yet (used by verify-pending resilience —
  /// LIVE-V2 P4). `noResult` = no stored outcome at all (e.g. session expired).
  static ({
    bool pending,
    bool noResult,
    bool verified,
    List<String> failedMessages,
    int? attemptsRemaining,
  }) _outcome(Map<String, dynamic>? j) {
    if (j == null) {
      return (
        pending: false,
        noResult: true,
        verified: false,
        failedMessages: const [],
        attemptsRemaining: null,
      );
    }
    if (j['status'] == 'pending') {
      return (
        pending: true,
        noResult: false,
        verified: false,
        failedMessages: const [],
        attemptsRemaining: null,
      );
    }
    final verified = j['verified'] == true;
    final msgs = <String>[];
    if (!verified) {
      final list = j['checks'] as List?;
      if (list != null) {
        for (final c in list) {
          if (c is Map && c['pass'] == false) {
            final m = c['user_message']?.toString();
            if (m != null && m.isNotEmpty && !msgs.contains(m)) msgs.add(m);
          }
        }
      }
      if (msgs.isEmpty) {
        final legacy = j['message']?.toString();
        msgs.add(legacy?.isNotEmpty == true
            ? legacy!
            : 'Verification failed — please try again.');
      }
    }
    return (
      pending: false,
      noResult: false,
      verified: verified,
      failedMessages: msgs,
      attemptsRemaining: (j['attempts_remaining'] as num?)?.toInt(),
    );
  }

  /// GET /api/id/liveness/result?session= and decode into the rich outcome above
  /// WITHOUT swallowing the pending state (unlike [livenessResult], which returns
  /// null while pending so a poll loop keeps going). Used by verify-pending
  /// resilience: on entry-point reopen we ask "is this session done yet?".
  static Future<({
    bool pending,
    bool noResult,
    bool verified,
    List<String> failedMessages,
    int? attemptsRemaining,
  })> livenessResultOutcome(String sessionId) async {
    try {
      final r = await ApiAuth.getSigned('$kLivenessResultUrl?session=$sessionId');
      if (r.statusCode != 200) return _outcome(null);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return _outcome(j);
    } catch (_) {
      return _outcome(null);
    }
  }

  /// GET /api/id/liveness/result?session= — poll target for the async verify
  /// (LIVE-V2 P0). Returns null while `{status:"pending"}` (or on a transient
  /// error) so the caller keeps polling; a decoded map once `status:"done"`.
  static Future<Map<String, dynamic>?> livenessResult(String sessionId) async {
    try {
      final r = await ApiAuth.getSigned('$kLivenessResultUrl?session=$sessionId');
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['status'] != 'done') return null; // still pending
      return j;
    } catch (_) {
      return null; // transient — let the poll loop retry
    }
  }

  /// Maps a done result map → the record shape the UI already consumes. Pulls the
  /// human-readable reason from the FIRST failing structured check (falls back to
  /// the legacy `checks` map / `message`).
  static ({bool verified, String? message, int? attemptsRemaining}) _fromResult(
      Map<String, dynamic> j) {
    if (j['verified'] == true) {
      return (verified: true, message: null, attemptsRemaining: null);
    }
    // Structured checks[] (LIVE-V2 P0): first failing user_message is the reason.
    String? msg;
    final list = j['checks'] as List?;
    if (list != null) {
      for (final c in list) {
        if (c is Map && c['pass'] == false) {
          final m = c['user_message']?.toString();
          if (m != null && m.isNotEmpty) { msg = m; break; }
        }
      }
    }
    // Legacy map fallback so mixed server/client versions still explain the fail.
    if (msg == null) {
      final map = (j['checks_map'] as Map?) ?? (j['checks'] is Map ? j['checks'] as Map : const {});
      final failed = map.entries.where((e) => e.value == false).map((e) => e.key).join(', ');
      msg = j['message']?.toString() ??
          (failed.isEmpty ? 'Verification failed — please try again.' : 'We could not confirm: $failed');
    }
    return (
      verified: false,
      message: msg,
      attemptsRemaining: (j['attempts_remaining'] as num?)?.toInt(),
    );
  }

  /// POST /api/id/liveness/verify then poll — returns the RICH outcome (every
  /// failed check message) for the V2 result UX (LIVE-V2 P4). Same async contract
  /// as [livenessVerify] (202 → poll every 2s, 90s cap) but surfaces the full
  /// `checks[]` instead of collapsing to one message. On poll timeout returns
  /// `pending:true` so the caller can persist the session and resume on reopen.
  static Future<({
    bool pending,
    bool noResult,
    bool verified,
    List<String> failedMessages,
    int? attemptsRemaining,
  })> livenessVerifyRich(String sessionId) async {
    try {
      final r = await ApiAuth.postJson(kLivenessVerifyUrl, {'session_id': sessionId});
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['status'] == 'done' || j.containsKey('verified')) {
        return _outcome(j);
      }
      if (r.statusCode == 202 || j['status'] == 'pending') {
        for (var i = 0; i < 45; i++) {
          await Future<void>.delayed(const Duration(seconds: 2));
          final res = await livenessResultOutcome(sessionId);
          if (!res.pending && !res.noResult) return res;
        }
        // Timed out waiting — still pending server-side. Caller persists + resumes.
        return _outcome(<String, dynamic>{'status': 'pending'});
      }
      return _outcome(j);
    } catch (_) {
      // POST failed (offline) — the background job may still have run.
      final res = await livenessResultOutcome(sessionId);
      if (!res.noResult && !res.pending) return res;
      return _outcome(<String, dynamic>{'status': 'pending'});
    }
  }

  /// POST /api/id/liveness/verify then poll /result — returns (verified, message).
  ///
  /// LIVE-V2 P0: verify now returns 202 immediately (no synchronous LLaVA/Whisper,
  /// which used to time out client-side and surface a false "Network error"). We
  /// poll /result every 2s for up to 90s. The record shape is unchanged so the V1
  /// UI keeps compiling; on poll timeout we say "Still checking…", NOT a network error.
  static Future<({bool verified, String? message, int? attemptsRemaining})> livenessVerify(
      String sessionId) async {
    try {
      final r = await ApiAuth.postJson(kLivenessVerifyUrl, {'session_id': sessionId});
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      // If verify already returned a done outcome (e.g. missing frames, or an
      // idempotent re-verify), use it directly — no need to poll.
      if (j['status'] == 'done' || j.containsKey('verified')) {
        return _fromResult(j);
      }
      // Otherwise it's pending (202) — poll /result up to 90s (45 × 2s).
      if (r.statusCode == 202 || j['status'] == 'pending') {
        for (var i = 0; i < 45; i++) {
          await Future<void>.delayed(const Duration(seconds: 2));
          final res = await livenessResult(sessionId);
          if (res != null) return _fromResult(res);
        }
        return (
          verified: false,
          message: 'Still checking — please wait a minute and reopen this screen.',
          attemptsRemaining: null,
        );
      }
      // Unexpected non-202 error body (e.g. 410 session expired) — surface it.
      return _fromResult(j);
    } catch (_) {
      // The POST itself failed (offline / DNS). Fall back to polling once in case
      // the background job still ran, else report the honest pending message.
      final res = await livenessResult(sessionId);
      if (res != null) return _fromResult(res);
      return (
        verified: false,
        message: 'Still checking — please wait a minute and reopen this screen.',
        attemptsRemaining: null,
      );
    }
  }
}
