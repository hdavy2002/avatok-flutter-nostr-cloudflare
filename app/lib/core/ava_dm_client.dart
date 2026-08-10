// ava_dm_client.dart — [AVA-TOGGLE-DM-1 / WS-17] client for the per-thread
// 1:1 Ava mode (Specs/WAVE-D-PLAN-2026-08-10.md Phase 2). Talks to the server
// routes in worker/src/routes/messaging.ts:
//   GET /api/conversations/ava/dm-state?conv=ID
//     → {conv, enabled, mode, effective_mode, is_default, default_on, ...}
//   PUT /api/conversations/ava/dm-state {conv, mode}
//     → {conv, enabled, mode, effective_mode, ...}   (403 feature_disabled while dark)
//
// Deliberately mirrors ava_group_client.dart's contract: a tiny standalone
// file, every call feature-detects failure/404/flag-off and degrades to a
// null/false result instead of throwing. While `avaDmToggleEnabled` is false
// in prod the GET returns `{enabled:false}` — the UI hides the section, so no
// client flag getter is needed and no fake flag can exist (the server is the
// single reader of the config key).
//
// PRIVACY SHAPE (matches the server's): the GET never returns the peer's own
// row — only my stored `mode` and the `effective_mode` that governs the
// thread. "Your peer switched Ava off" is a disclosure about the peer's
// settings and is deliberately unavailable; render `effective_mode` without
// attributing it.
import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// My row + the thread's governing mode for one 1:1 conversation.
class AvaDmState {
  final String conv;

  /// False while the platform flag is dark (or the route is absent) — the UI
  /// must render NOTHING in that case, not an "off" toggle.
  final bool enabled;

  /// MY stored preference: 'off' | 'assistant' | 'companion'.
  final String mode;

  /// The mode actually governing the thread (min of both participants' rows —
  /// the server computes it; either side's 'off' wins).
  final String effectiveMode;

  /// True when I have no explicit row and [mode] is the platform default.
  final bool isDefault;
  final int updatedAt;

  const AvaDmState({
    required this.conv,
    required this.enabled,
    required this.mode,
    required this.effectiveMode,
    required this.isDefault,
    required this.updatedAt,
  });

  factory AvaDmState.fromJson(Map<String, dynamic> j) => AvaDmState(
        conv: (j['conv'] ?? '').toString(),
        enabled: j['enabled'] == true,
        mode: (j['mode'] ?? 'off').toString(),
        effectiveMode: (j['effective_mode'] ?? 'off').toString(),
        isDefault: j['is_default'] == true,
        updatedAt: (j['updated_at'] as num?)?.toInt() ?? 0,
      );
}

class AvaDmApi {
  AvaDmApi._();

  static String get _url => '$kApiBase/conversations/ava/dm-state';

  /// GET my state for [conv]. Null on any failure (network/404/not a member) —
  /// callers hide the section; they must never render a toggle they cannot
  /// trust. `enabled:false` (flag dark) comes back as a REAL object so the UI
  /// can distinguish "feature off" from "request failed".
  static Future<AvaDmState?> getState(String conv) async {
    if (conv.isEmpty) return null;
    try {
      final res = await ApiAuth.getSigned('$_url?conv=${Uri.encodeQueryComponent(conv)}',
          timeout: const Duration(seconds: 12));
      if (res.statusCode != 200) return null;
      return AvaDmState.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  /// PUT my mode for [conv]. Self-only server-side (my row, never the
  /// peer's). Returns the refreshed state, or null on failure — including the
  /// 403 the server sends while `avaDmToggleEnabled` is dark.
  ///
  /// On an EFFECTIVE mode change the SERVER posts the peer-visible disclosure
  /// notice into the thread as Ava; the client does not (and must not) post
  /// anything itself.
  static Future<AvaDmState?> setMode(String conv, String mode) async {
    if (conv.isEmpty) return null;
    try {
      final res = await ApiAuth.putJson(_url, {'conv': conv, 'mode': mode},
          timeout: const Duration(seconds: 15));
      if (res.statusCode != 200) return null;
      return AvaDmState.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }
}
