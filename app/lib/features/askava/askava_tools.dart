import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/call_log_store.dart';
import '../../core/config.dart';
import '../../core/db.dart';
import '../../core/remote_config.dart';
import '../avadial/device_call_log.dart';
import '../avadial/device_contacts.dart';

/// A contact surfaced by a tool — carries just enough to render a Call/Message
/// action chip. NOTHING here is persisted or ingested (plan §4.6 HARD BOUNDARY):
/// tool results only ever ride the visible thread + the current model turn.
class AskAvaContact {
  final String name;
  final String number; // PSTN number OR AvaTOK handle
  final bool inNetwork; // true = AvaTOK contact (Message), false = device/PSTN (Call)
  const AskAvaContact({required this.name, required this.number, this.inNetwork = false});
}

/// The outcome of one LOCAL tool run: a compact, human-readable summary sent back
/// into the model context (minimal matching rows ONLY — never the whole book), and
/// any contacts to render as action chips in the thread.
class AskAvaToolResult {
  final String summaryForModel;
  final List<AskAvaContact> contacts;
  const AskAvaToolResult(this.summaryForModel, {this.contacts = const []});
}

/// The LOCAL tool layer for Ask Ava (plan §4.6). Every "data" tool runs entirely
/// on-device (device book / call log / chats via SQLite) EXCEPT `spam_lookup`,
/// which is the one central call (the §4.4 edge-cached D1 endpoint). Only the
/// user's query + the few matching rows ever transit to the model; nothing is
/// stored server-side, and NONE of this is fed to RagService/AvaBrain ingestion.
class AskAvaTools {
  AskAvaTools._();

  /// The tool names the orchestrator recognises as DATA tools (return rows to the
  /// model). Action tools (dial/block/report_spam) are handled by the UI as
  /// confirmation chips and never execute here.
  static const dataTools = {'search_contacts', 'search_call_log', 'search_chats', 'spam_lookup'};
  static const actionTools = {'dial', 'block', 'report_spam'};

  static const _maxRows = 8;

  /// Run a data tool. Unknown/unsupported tools return an honest note so the model
  /// can recover instead of hanging.
  static Future<AskAvaToolResult> runData(String tool, Map<String, dynamic> args) async {
    switch (tool) {
      case 'search_contacts':
        return _searchContacts((args['q'] ?? '').toString());
      case 'search_call_log':
        return _searchCallLog((args['q'] ?? '').toString());
      case 'search_chats':
        return _searchChats((args['q'] ?? '').toString());
      case 'spam_lookup':
        return _spamLookup((args['number'] ?? '').toString());
      default:
        return const AskAvaToolResult('TOOL_RESULT: unknown tool.');
    }
  }

  // ── search_contacts ───────────────────────────────────────────────────────
  static Future<AskAvaToolResult> _searchContacts(String q) async {
    final needle = q.trim().toLowerCase();
    final out = <AskAvaContact>[];
    try {
      if (RemoteConfig.avaDialer) {
        // Live device book (plan §4.6: reuse avadial reads when the dialer is on).
        final list = await DeviceContacts.I.load();
        for (final c in list) {
          final name = c.name ?? '';
          if (needle.isEmpty ||
              name.toLowerCase().contains(needle) ||
              c.number.toLowerCase().contains(needle)) {
            out.add(AskAvaContact(name: name.isEmpty ? c.number : name, number: c.number));
            if (out.length >= _maxRows) break;
          }
        }
      } else {
        // Fallback: in-network AvaTOK contacts (SQLite) + call-log names.
        final rows = await Db.I.contactsOnce();
        for (final r in rows) {
          final name = r.name.isEmpty ? r.handle : r.name;
          if (needle.isEmpty ||
              name.toLowerCase().contains(needle) ||
              r.handle.toLowerCase().contains(needle)) {
            out.add(AskAvaContact(name: name, number: r.handle, inNetwork: true));
            if (out.length >= _maxRows) break;
          }
        }
      }
    } catch (_) {/* degrade to whatever we gathered */}

    if (out.isEmpty) {
      return AskAvaToolResult('TOOL_RESULT search_contacts: no contacts matched "$q".');
    }
    final lines = out.map((c) => '- ${c.name}: ${c.number}').join('\n');
    return AskAvaToolResult('TOOL_RESULT search_contacts (${out.length}):\n$lines', contacts: out);
  }

  // ── search_call_log ───────────────────────────────────────────────────────
  static Future<AskAvaToolResult> _searchCallLog(String q) async {
    final needle = q.trim().toLowerCase();
    final lines = <String>[];
    final contacts = <AskAvaContact>[];
    try {
      if (RemoteConfig.avaDialer) {
        final calls = await DeviceCallLog.I.load(limit: 300);
        for (final c in calls) {
          final name = c.cachedName ?? '';
          if (needle.isEmpty ||
              name.toLowerCase().contains(needle) ||
              c.number.toLowerCase().contains(needle)) {
            lines.add('- ${name.isEmpty ? c.number : name} · ${c.type.name} · ${c.date.toLocal()}');
            contacts.add(AskAvaContact(name: name.isEmpty ? c.number : name, number: c.number));
            if (lines.length >= _maxRows) break;
          }
        }
      } else {
        final calls = await CallLogStore().load();
        for (final c in calls) {
          if (needle.isEmpty || c.name.toLowerCase().contains(needle)) {
            lines.add('- ${c.name.isEmpty ? 'Unknown' : c.name} · ${c.dir.name} · ${c.timeLabel}');
            if (lines.length >= _maxRows) break;
          }
        }
      }
    } catch (_) {/* degrade */}

    if (lines.isEmpty) {
      return AskAvaToolResult('TOOL_RESULT search_call_log: no calls matched "$q".');
    }
    return AskAvaToolResult('TOOL_RESULT search_call_log (${lines.length}):\n${lines.join('\n')}',
        contacts: contacts);
  }

  // ── search_chats ──────────────────────────────────────────────────────────
  static Future<AskAvaToolResult> _searchChats(String q) async {
    final lines = <String>[];
    try {
      final rows = await Db.I.searchMessages(q, limit: 40);
      for (final m in rows) {
        final text = _extractText(m.payload);
        if (text.isEmpty) continue;
        final snippet = text.length > 120 ? '${text.substring(0, 120)}…' : text;
        lines.add('- ${m.mine ? 'me' : 'them'}: $snippet');
        if (lines.length >= _maxRows) break;
      }
    } catch (_) {/* degrade */}

    if (lines.isEmpty) {
      return AskAvaToolResult('TOOL_RESULT search_chats: no messages matched "$q".');
    }
    return AskAvaToolResult('TOOL_RESULT search_chats (${lines.length}):\n${lines.join('\n')}');
  }

  /// Pull human text out of a stored message envelope (best-effort across the
  /// common shapes: {text}/{t}/{body}/{caption}).
  static String _extractText(String payload) {
    try {
      final m = jsonDecode(payload);
      if (m is Map) {
        for (final k in ['text', 't', 'body', 'caption', 'msg']) {
          final v = m[k];
          if (v is String && v.trim().isNotEmpty) return v.trim();
        }
      }
    } catch (_) {/* not JSON */}
    return '';
  }

  // ── spam_lookup (the ONE central tool) ────────────────────────────────────
  static Future<AskAvaToolResult> _spamLookup(String number) async {
    final digits = number.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.isEmpty) {
      return const AskAvaToolResult('TOOL_RESULT spam_lookup: no number provided.');
    }
    try {
      final url = '$kApiBase/spam/lookup/${Uri.encodeComponent(digits)}';
      final res = await ApiAuth.getSigned(url, timeout: const Duration(seconds: 8));
      if (res.statusCode == 403) {
        // spamShield off → degrade gracefully (plan §4.6).
        return const AskAvaToolResult(
            'TOOL_RESULT spam_lookup: the spam shield is not enabled, so no community score is available.');
      }
      if (res.statusCode != 200) {
        return AskAvaToolResult('TOOL_RESULT spam_lookup: unavailable (${res.statusCode}).');
      }
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final label = (j['label'] ?? 'none').toString();
      final score = (j['score'] as num?)?.toInt() ?? 0;
      final reports = (j['reports'] as num?)?.toInt() ?? 0;
      return AskAvaToolResult(
          'TOOL_RESULT spam_lookup $digits: label=$label score=$score reports=$reports');
    } catch (_) {
      return const AskAvaToolResult('TOOL_RESULT spam_lookup: lookup failed (offline?).');
    }
  }
}
