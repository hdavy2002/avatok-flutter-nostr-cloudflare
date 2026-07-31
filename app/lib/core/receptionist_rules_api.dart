import 'dart:async';
import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// [DYNW-RULES-UI-1] Owner API for plain-English receptionist call rules.
///
/// The user writes rules in their own words ("If my brother Ramesh calls,
/// tell him I'll call back at 6pm"); the server moderates, compiles and
/// activates them, and Ava's turn logic runs the compiled result. The app
/// never sees or edits compiled code — it only ever sends/receives the raw
/// text the owner typed.
///
///   GET    /api/receptionist/rules  → {active, rules_text?, code_id?} | 403 (flag off)
///   PUT    /api/receptionist/rules  {rules_text} → {ok:true, code_id} | 400 {error}
///   DELETE /api/receptionist/rules  → {ok:true}
const String _rulesUrl = 'https://$kSignalingHost/api/receptionist/rules';

/// Result of a GET. [available] is false when the feature flag is off
/// (server 403) or the request failed — the screen shows a "coming soon"
/// placeholder in that case rather than an empty editor.
class ReceptionistRulesStatus {
  final bool available;
  final bool active;
  final String rulesText;
  final String codeId;
  const ReceptionistRulesStatus({
    required this.available,
    required this.active,
    this.rulesText = '',
    this.codeId = '',
  });
  static const ReceptionistRulesStatus unavailable =
      ReceptionistRulesStatus(available: false, active: false);
}

/// Result of a PUT save.
class ReceptionistRulesSaveResult {
  final bool ok;
  final String codeId;
  final String? error;
  const ReceptionistRulesSaveResult({required this.ok, this.codeId = '', this.error});
}

class ReceptionistRulesApi {
  /// Owner: read current rules (and whether they're active). Server-side only —
  /// this screen has no local persistence of the rules text itself.
  static Future<ReceptionistRulesStatus> getRules() async {
    try {
      final r = await ApiAuth.getSigned(_rulesUrl);
      if (r.statusCode == 403) return ReceptionistRulesStatus.unavailable;
      if (r.statusCode != 200) return ReceptionistRulesStatus.unavailable;
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      return ReceptionistRulesStatus(
        available: true,
        active: j['active'] == true,
        rulesText: (j['rules_text'] ?? '').toString(),
        codeId: (j['code_id'] ?? '').toString(),
      );
    } catch (_) {
      return ReceptionistRulesStatus.unavailable;
    }
  }

  /// Owner: save + activate a plain-English rules script. The server compiles
  /// and moderates it; a 400 carries a human-readable `error`.
  static Future<ReceptionistRulesSaveResult> saveRules(String rulesText) async {
    try {
      final r = await ApiAuth.putJson(_rulesUrl, {'rules_text': rulesText});
      Map<String, dynamic> j = const {};
      try {
        j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      } catch (_) {/* non-JSON body — fall through to a generic message */}
      if (r.statusCode == 200 && j['ok'] == true) {
        return ReceptionistRulesSaveResult(ok: true, codeId: (j['code_id'] ?? '').toString());
      }
      if (r.statusCode == 403) {
        return const ReceptionistRulesSaveResult(
            ok: false, error: 'Call rules aren’t available yet.');
      }
      final serverError = (j['error'] ?? '').toString();
      return ReceptionistRulesSaveResult(
        ok: false,
        error: serverError.isNotEmpty ? serverError : 'Couldn’t save — try again.',
      );
    } catch (_) {
      return const ReceptionistRulesSaveResult(
          ok: false, error: 'Couldn’t save — check your connection.');
    }
  }

  /// Owner: turn rules off (server disables/deactivates them).
  static Future<bool> clearRules() async {
    try {
      final r = await ApiAuth.deleteSigned(_rulesUrl);
      if (r.statusCode != 200) return false;
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      return j['ok'] == true;
    } catch (_) {
      return false;
    }
  }
}
