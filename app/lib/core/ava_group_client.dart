// ava_group_client.dart — [AVABRAIN-COMPANION-UI-1] client for the Group
// Companion draft-card surface (Specs/AVABRAIN-PRODUCT-BIBLE-2026-07-24.md
// §6.2/§6.3). Talks to the [AVABRAIN-COMPANION-2] server routes
// (worker/src/routes/ava_group.ts):
//   GET  /api/ava/group/mode?conv=ID       → {conv, mode, updated_by, updated_at}
//   POST /api/ava/group/mode               → {conv, mode}
//   GET  /api/ava/group/drafts/<conv>       → {drafts:[...]}
//   POST /api/ava/group/draft/<id>/approve  → posts the real message (server-side)
//   POST /api/ava/group/draft/<id>/reject   → terminal
//
// Deliberately a NEW small file (NOT ava_ai_client.dart) — chat_thread.dart's
// draft-card UI and group_info_screen.dart's mode toggle are the only callers.
// Every call feature-detects a 404/network failure and degrades to an
// empty/failed result rather than throwing, since the surface may not be live
// in every environment yet (mirrors BrainMemoryApi's contract in
// ava_ai_client.dart).
import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// One pending Companion draft card (bible §6.2/§6.3 — approve/reject only,
/// never auto-posted).
class AvaGroupDraft {
  final String decisionId;
  final String capability;
  final String templateId;
  final String draftText;
  final String scope; // 'private' | 'public'
  final String? targetUid;
  final int createdAt; // epoch ms
  final bool canDecide;

  const AvaGroupDraft({
    required this.decisionId,
    required this.capability,
    required this.templateId,
    required this.draftText,
    required this.scope,
    required this.targetUid,
    required this.createdAt,
    required this.canDecide,
  });

  factory AvaGroupDraft.fromJson(Map<String, dynamic> j) => AvaGroupDraft(
        decisionId: (j['decision_id'] ?? '').toString(),
        capability: (j['capability'] ?? '').toString(),
        templateId: (j['template_id'] ?? '').toString(),
        draftText: (j['draft_text'] ?? '').toString(),
        scope: (j['scope'] ?? 'private').toString(),
        targetUid: (j['target_uid'] as String?),
        createdAt: (j['created_at'] as num?)?.toInt() ?? 0,
        canDecide: j['can_decide'] == true,
      );
}

/// Effective per-group Companion mode ('off' | 'assistant' | 'companion').
class AvaGroupMode {
  final String conv;
  final String mode;
  final String? updatedBy;
  final int updatedAt;
  const AvaGroupMode({required this.conv, required this.mode, this.updatedBy, this.updatedAt = 0});

  factory AvaGroupMode.fromJson(Map<String, dynamic> j) => AvaGroupMode(
        conv: (j['conv'] ?? '').toString(),
        mode: (j['mode'] ?? 'off').toString(),
        updatedBy: j['updated_by'] as String?,
        updatedAt: (j['updated_at'] as num?)?.toInt() ?? 0,
      );
}

class AvaGroupApi {
  AvaGroupApi._();

  static String get _base => '$kApiBase/ava/group';

  /// GET /api/ava/group/drafts/<conv> — pending drafts visible to me (private
  /// scoped to me, public to any member). Returns an empty list on any
  /// failure/404 (route not shipped / feature off) — the UI shows nothing.
  static Future<List<AvaGroupDraft>> listDrafts(String conv) async {
    if (conv.isEmpty) return const [];
    try {
      final res = await ApiAuth.getSigned('$_base/drafts/${Uri.encodeComponent(conv)}',
          timeout: const Duration(seconds: 12));
      if (res.statusCode != 200) return const []; // incl. 404 = not shipped yet
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final drafts = ((j['drafts'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => AvaGroupDraft.fromJson(e.cast<String, dynamic>()))
          .toList(growable: false);
      return drafts;
    } catch (_) {
      return const [];
    }
  }

  /// POST /api/ava/group/draft/<id>/approve — fires the existing post path
  /// server-side; the real message arrives via normal sync, not from here.
  static Future<bool> approveDraft(String decisionId) async {
    try {
      final res = await ApiAuth.postJson('$_base/draft/${Uri.encodeComponent(decisionId)}/approve', const {},
          timeout: const Duration(seconds: 15));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// POST /api/ava/group/draft/<id>/reject — terminal, never posts.
  static Future<bool> rejectDraft(String decisionId) async {
    try {
      final res = await ApiAuth.postJson('$_base/draft/${Uri.encodeComponent(decisionId)}/reject', const {},
          timeout: const Duration(seconds: 15));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// GET /api/ava/group/mode?conv=ID — current mode (any member may read).
  static Future<AvaGroupMode?> getMode(String conv) async {
    if (conv.isEmpty) return null;
    try {
      final res = await ApiAuth.getSigned('$_base/mode?conv=${Uri.encodeQueryComponent(conv)}',
          timeout: const Duration(seconds: 12));
      if (res.statusCode != 200) return null;
      return AvaGroupMode.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  /// POST /api/ava/group/mode {conv, mode} — owner/admin only server-side.
  static Future<bool> setMode(String conv, String mode) async {
    try {
      final res = await ApiAuth.postJson('$_base/mode', {'conv': conv, 'mode': mode},
          timeout: const Duration(seconds: 15));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
