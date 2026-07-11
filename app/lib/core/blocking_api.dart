import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// [DIALPAD-BIZ-CALLS] Account-level block for a business (dialpad) caller —
/// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §15.2:
/// blocking a caller blocks their calls to ALL of my numbers, plus voicemail,
/// the agent, and messaging. **Silent** — the blocked caller sees normal
/// ringing then the standard no-answer card; they are never told they're
/// blocked. Mirrors [MoneyApi]'s thin static-wrapper style (money_api.dart).
///
/// STUB (Phase A UI): posts to the endpoint the plan calls for; the server
/// route itself (`POST /api/block`, account-level blocklist + silent-block
/// semantics) is separate Worker work, not part of this Flutter work package.
/// A 404/non-2xx here is swallowed (best-effort) so the client-side UI action
/// (closing the incoming-call screen) never hangs on a route that doesn't
/// exist yet.
class BlockingApi {
  BlockingApi._();

  /// Block [uid] account-wide. Returns true on a 2xx server response.
  static Future<bool> blockAccount(String uid) async {
    if (uid.isEmpty) return false;
    try {
      final res = await ApiAuth.postJsonH(
        '$kApiBase/block',
        {'uid': uid},
        const <String, String>{},
      );
      if (res.statusCode >= 200 && res.statusCode < 300) return true;
      try {
        final j = jsonDecode(res.body);
        return j is Map && j['ok'] == true;
      } catch (_) {
        return false;
      }
    } catch (_) {
      return false;
    }
  }
}
