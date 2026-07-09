import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/composer_ai.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';

/// AvaDocActions (Ava Copilot Phase A — plan §7).
///
/// Context-menu handlers for the Ava items on a doc/PDF/image message:
///   • Summarize ✨          → POST /api/ava/doc/summarize
///   • Translate ✨          → POST /api/ava/doc/translate (inline result dialog,
///                             language picker first)
///   • Auto-translate file ✨ → POST /api/ava/doc/translate-file (fresh PDF is
///                             delivered later in the PRIVATE Ava lane)
///
/// Every item is labelled with ✨ and the subtitle "only you will see this" —
/// results land in the caller's private Ava lane only (D2/D19). Failure
/// handling is deliberately quiet: 403 {reason:"ava_off_chat"} (per-chat Ava
/// toggle is off, D29) and 503 {flag} (kill switch) show a one-line snackbar,
/// never a dialog.
class AvaDocActions {
  AvaDocActions._();

  // Route paths (worker Phase A; kApiBase already ends in /api).
  static String get _summarizeUrl => '$kApiBase/ava/doc/summarize';
  static String get _translateUrl => '$kApiBase/ava/doc/translate';
  static String get _translateFileUrl => '$kApiBase/ava/doc/translate-file';

  /// The Ava items for the message long-press sheet, in plan-§7 order
  /// (Summarize · Translate · Auto-translate file — callers place them before
  /// Download/Forward). Returns an empty list when Ava may not act here
  /// ([show] false — e.g. "Ava in this chat" is off, D29 — or no [conv]).
  ///
  /// [sheetContext] is the bottom sheet (popped before running the action);
  /// [threadContext] is the thread screen (hosts dialogs/snackbars after).
  static List<Widget> menuItems({
    required BuildContext sheetContext,
    required BuildContext threadContext,
    required String? conv,
    required String? mediaRef,
    required String? name,
    required bool show,
  }) {
    if (!show || conv == null || conv.isEmpty || mediaRef == null || mediaRef.isEmpty) {
      return const <Widget>[];
    }
    Widget item(IconData icon, String label, Future<void> Function() run) => ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 20),
          leading: Icon(icon, color: Zine.ink),
          title: Text('$label ✨', style: ZineText.value(size: 15, color: Zine.ink)),
          subtitle: Text('only you will see this',
              style: ZineText.sub(size: 12, color: Zine.inkMute)),
          onTap: () {
            Navigator.pop(sheetContext);
            // ignore: unawaited_futures
            run();
          },
        );
    return <Widget>[
      item(PhosphorIcons.sparkle(PhosphorIconsStyle.bold), 'Summarize',
          () => summarize(threadContext, conv: conv, mediaRef: mediaRef, name: name)),
      item(PhosphorIcons.translate(PhosphorIconsStyle.bold), 'Translate',
          () => translate(threadContext, conv: conv, mediaRef: mediaRef, name: name)),
      item(PhosphorIcons.filePdf(PhosphorIconsStyle.bold), 'Auto-translate file',
          () => translateFile(threadContext, conv: conv, mediaRef: mediaRef, name: name)),
    ];
  }

  /// Summarize the document. The answer arrives asynchronously as a private
  /// Ava-lane bubble in this thread; when the server answers inline (cache hit)
  /// we show it straight away in a dialog too.
  static Future<void> summarize(BuildContext context,
      {required String conv, required String mediaRef, String? name}) async {
    Analytics.capture('ava_doc_action_tap', {'action': 'summarize', 'conv': conv});
    _toast(context, 'Ava is reading the document — her summary will appear here, only for you.');
    final res = await _post(_summarizeUrl, {
      'conv': conv,
      'media_ref': mediaRef,
      if (name != null && name.isNotEmpty) 'name': name,
    });
    if (!context.mounted) return;
    if (!_handleFailure(context, res, 'summarize')) return;
    final text = _textOf(res.body);
    if (text.isNotEmpty) _resultDialog(context, 'Summary — Ava ✨', text);
  }

  /// Translate the document INLINE: pick a language, then show Ava's
  /// translation in a dialog (the private-lane bubble carries it too).
  static Future<void> translate(BuildContext context,
      {required String conv, required String mediaRef, String? name}) async {
    final lang = await _pickLanguage(context);
    if (lang == null || !context.mounted) return;
    Analytics.capture('ava_doc_action_tap',
        {'action': 'translate', 'conv': conv, 'lang': lang.code});
    _toast(context, 'Ava is translating into ${lang.label} — only you will see it.');
    final res = await _post(_translateUrl, {
      'conv': conv,
      'media_ref': mediaRef,
      'lang': lang.code,
      if (name != null && name.isNotEmpty) 'name': name,
    });
    if (!context.mounted) return;
    if (!_handleFailure(context, res, 'translate')) return;
    final text = _textOf(res.body);
    if (text.isNotEmpty) {
      _resultDialog(context, 'Translation (${lang.label}) — Ava ✨', text);
    }
  }

  /// Auto-translate the WHOLE file: pick a language, then ask the worker to
  /// generate a fresh translated PDF. Delivery is async — the file lands as a
  /// private Ava-lane message ("formatting simplified" notice included there).
  static Future<void> translateFile(BuildContext context,
      {required String conv, required String mediaRef, String? name}) async {
    final lang = await _pickLanguage(context);
    if (lang == null || !context.mounted) return;
    Analytics.capture('ava_doc_action_tap',
        {'action': 'translate_file', 'conv': conv, 'lang': lang.code});
    final res = await _post(_translateFileUrl, {
      'conv': conv,
      'media_ref': mediaRef,
      'lang': lang.code,
      if (name != null && name.isNotEmpty) 'name': name,
    });
    if (!context.mounted) return;
    if (!_handleFailure(context, res, 'translate_file')) return;
    _toast(context,
        'Ava is preparing the translated file — it will arrive in this chat, only for you.');
  }

  // ---- shared plumbing ------------------------------------------------------

  static Future<_DocRes> _post(String url, Map<String, dynamic> body) async {
    try {
      final res = await ApiAuth.postJson(url, body,
          timeout: const Duration(seconds: 45)); // doc extraction can be slow
      return _DocRes(res.statusCode, res.body);
    } catch (e) {
      AvaLog.I.log('ava', 'doc action failed $url: $e');
      return const _DocRes(0, '');
    }
  }

  /// Returns true when the call succeeded; otherwise shows the QUIET failure
  /// snackbar (403 ava_off_chat / 503 flag / network) and returns false.
  static bool _handleFailure(BuildContext context, _DocRes res, String action) {
    if (res.status == 200 || res.status == 202) return true;
    String msg = "Ava couldn't do that right now — try again in a moment.";
    if (res.status == 403 && _fieldOf(res.body, 'reason') == 'ava_off_chat') {
      msg = 'Ava is turned off for this chat.';
    } else if (res.status == 503) {
      msg = 'This Ava feature is switched off right now.';
    }
    Analytics.capture('ava_doc_action_failed',
        {'action': action, 'status': res.status});
    _toast(context, msg);
    return false;
  }

  static String _textOf(String body) => _fieldOf(body, 'text');

  static String _fieldOf(String body, String key) {
    try {
      final j = jsonDecode(body);
      if (j is Map) return (j[key] ?? '').toString().trim();
    } catch (_) {/* non-JSON (edge error page etc.) */}
    return '';
  }

  static void _toast(BuildContext context, String msg) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), duration: const Duration(seconds: 3)));
  }

  /// The shared language picker (same list the composer AI uses).
  static Future<ComposerLang?> _pickLanguage(BuildContext context) {
    return showModalBottomSheet<ComposerLang>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                  size: 20, color: Zine.ink),
              const SizedBox(width: 10),
              Text('Translate into…', style: ZineText.cardTitle(size: 18)),
            ]),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final l in ComposerAi.languages)
                  ListTile(
                    title: Text(l.label, style: ZineText.value(size: 16)),
                    onTap: () => Navigator.pop(ctx, l),
                  ),
              ],
            ),
          ),
        ]),
      ),
    );
  }

  /// Inline result dialog (summary / translation) with a Copy affordance.
  static void _resultDialog(BuildContext context, String title, String text) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.paper,
        title: Text(title, style: ZineText.cardTitle(size: 17)),
        content: SingleChildScrollView(
          child: Text(text, style: ZineText.value(size: 14.5, color: Zine.ink)),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Close')),
        ],
      ),
    );
  }
}

/// Client for the per-chat "Ava in this chat" switch (plan D29): GET/POST
/// /api/ava/chat-toggle {conv, on}. Per-account state lives in the user's own
/// InboxDO conv-state server-side; this class only reads/writes it.
class AvaChatToggle {
  AvaChatToggle._();

  static String get _url => '$kApiBase/ava/chat-toggle';

  /// Fetch the current state for [conv]. Defaults to ON (D29: on by default)
  /// when the server can't be reached or the row doesn't exist yet.
  static Future<bool> fetch(String conv) async {
    try {
      final res = await ApiAuth.getSigned('$_url?conv=${Uri.encodeComponent(conv)}');
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body);
        if (j is Map && j['on'] is bool) return j['on'] as bool;
      }
    } catch (e) {
      AvaLog.I.log('ava', 'chat-toggle fetch failed: $e');
    }
    return true;
  }

  /// Flip the switch. Returns true on success (callers keep their optimistic
  /// state); false means revert (e.g. 403 — a non-admin in a group, D29).
  static Future<bool> set(String conv, bool on) async {
    try {
      final res = await ApiAuth.postJson(_url, {'conv': conv, 'on': on});
      Analytics.capture('ava_chat_toggle_set',
          {'conv': conv, 'on': on, 'status': res.statusCode});
      return res.statusCode == 200;
    } catch (e) {
      AvaLog.I.log('ava', 'chat-toggle set failed: $e');
      return false;
    }
  }
}

class _DocRes {
  final int status;
  final String body;
  const _DocRes(this.status, this.body);
}
