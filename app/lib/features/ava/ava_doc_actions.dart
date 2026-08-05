import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ai_media_jobs.dart'; // [AVA-DOC-ARTIFACT-1] durable summarize/translate jobs
import '../../core/api_auth.dart';
import '../../core/api_backoff.dart';
import '../../core/ava_log.dart';
import '../../core/composer_ai.dart';
import '../../core/config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

/// AvaDocActions (Ava Copilot Phase A — plan §7; migrated to durable jobs by
/// [AVA-DOC-ARTIFACT-1], Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md
/// Part VI §38/§45).
///
/// Context-menu handlers for the Ava items on a doc/PDF/image message:
///   • Summarize ✨ → creates a durable `doc_summarize` AiMediaJob (produces a
///     `.summary.md`/`.txt` artifact — never just inline text now).
///   • Translate ✨ → language picker, then a durable `doc_translate` AiMediaJob
///     (produces a translated file artifact).
///
/// "Auto-translate file" is RETIRED (kept as [translateFile] below, unused by
/// [menuItems], per §49 "remove only after the new path is verified") —
/// Translate itself always produces a file now, so the separate action no
/// longer adds anything.
///
/// The caller (chat_thread.dart) supplies [onOutcome], which it wires to its
/// shared `_handleJobOutcome` — the ONE place that renders the pending job
/// card AND the 402 `AI_INSUFFICIENT_TOKENS` "you're out of tokens" message
/// (CLAUDE.md: a 402 must never render as a generic failure).
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
    required void Function(AiMediaJobCreateOutcome outcome) onOutcome,
  }) {
    if (!show || conv == null || conv.isEmpty || mediaRef == null || mediaRef.isEmpty) {
      return const <Widget>[];
    }
    Widget item(IconData icon, String label, Future<void> Function() run) => ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: Msg.s5),
          leading: Icon(icon, color: AD.textPrimary),
          // The trailing "✨" was emoji in user-facing copy — now a Phosphor
          // sparkle beside the label.
          title: Row(mainAxisSize: MainAxisSize.min, children: [
            Flexible(
              child: Text(label,
                  overflow: TextOverflow.ellipsis,
                  style: ADText.rowName(c: AD.textPrimary)),
            ),
            const SizedBox(width: Msg.s1),
            PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                size: 13, color: Msg.accent),
          ]),
          subtitle: Text('Only you will see this',
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12)),
          onTap: () {
            Navigator.pop(sheetContext);
            // ignore: unawaited_futures
            run();
          },
        );
    return <Widget>[
      item(PhosphorIcons.sparkle(PhosphorIconsStyle.regular), 'Summarize',
          () => summarize(threadContext, conv: conv, mediaRef: mediaRef, name: name, onOutcome: onOutcome)),
      item(PhosphorIcons.translate(PhosphorIconsStyle.regular), 'Translate',
          () => translate(threadContext, conv: conv, mediaRef: mediaRef, name: name, onOutcome: onOutcome)),
    ];
  }

  /// [AVA-DOC-ARTIFACT-1] Summarize the document: creates a durable
  /// `doc_summarize` AiMediaJob. [onOutcome] renders the pending card (success)
  /// or the honest 402/failure copy — this method never shows its own dialog
  /// any more (the artifact IS the result now, not an inline text blob).
  static Future<void> summarize(BuildContext context,
      {required String conv, required String mediaRef, String? name,
      required void Function(AiMediaJobCreateOutcome) onOutcome}) async {
    Analytics.capture('ava_doc_action_tap', {'action': 'summarize', 'conv': conv});
    final outcome = await AiMediaJobRepository.I.create(
      convId: conv,
      kind: AiMediaJobKind.docSummarize,
      sourceMediaId: mediaRef,
      label: 'Preparing summary…',
    );
    onOutcome(outcome);
  }

  /// [AVA-DOC-ARTIFACT-1] Translate the document: pick a language, then create
  /// a durable `doc_translate` AiMediaJob (produces a translated file, never
  /// just inline text). [onOutcome] renders the pending card / 402 / failure.
  static Future<void> translate(BuildContext context,
      {required String conv, required String mediaRef, String? name,
      required void Function(AiMediaJobCreateOutcome) onOutcome}) async {
    final lang = await _pickLanguage(context);
    if (lang == null || !context.mounted) return;
    Analytics.capture('ava_doc_action_tap',
        {'action': 'translate', 'conv': conv, 'lang': lang.code});
    final outcome = await AiMediaJobRepository.I.create(
      convId: conv,
      kind: AiMediaJobKind.docTranslate,
      sourceMediaId: mediaRef,
      targetLanguage: lang.code,
      label: 'Translating to ${lang.label}…',
    );
    onOutcome(outcome);
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
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s2),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.regular),
                  size: 20, color: AD.textPrimary),
              const SizedBox(width: Msg.s2),
              Text('Translate into…',
                  style: ADText.threadName().copyWith(fontSize: 18)),
            ]),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final l in ComposerAi.languages)
                  ListTile(
                    title: Text(l.label,
                        style: ADText.rowName(c: AD.textPrimary)
                            .copyWith(fontSize: 16)),
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
        backgroundColor: AD.popover,
        title: Text(title, style: ADText.threadName().copyWith(fontSize: 17)),
        content: SingleChildScrollView(
          child: Text(text, style: ADText.bubbleBody(c: AD.textPrimary)),
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

  // AVA-CHATTOGGLE-503: this READ used to fire on EVERY chat open (chat_thread's
  // _initAvaChatState), and while the copilot master switch is OFF the worker
  // answered every one with a 503 kill-switch gate — a steady prod error-storm
  // (PostHog 2026-07-17: 157×/week across 4 users, ~5.6/user/day). The worker
  // GET is now graceful (200 {on:true, disabled:true}), but old server builds and
  // genuine transient 5xx still exist, so the client hard-backs-off too:
  //   • generic 503  → ApiBackoffState (30s→1m→5m→30m), the shared pattern.
  //   • kill-switch  → 503/{disabled:true} means the feature is DARK and will not
  //     change without an app upgrade or a flag flip, so we go session-sticky:
  //     stop fetching entirely (defaults to ON) until the app is relaunched.
  // Suppressed attempts emit `chat_toggle_backoff` (email auto-attached).
  static final ApiBackoffState _backoff = ApiBackoffState('/api/ava/chat-toggle');
  static bool _sessionDisabled = false; // kill-switch seen this run → stop asking

  /// Fetch the current state for [conv]. Defaults to ON (D29: on by default)
  /// when the server can't be reached, the row doesn't exist yet, or the call is
  /// suppressed by backoff.
  static Future<bool> fetch(String conv) async {
    // Kill-switch already observed this session → never re-hit the worker.
    if (_sessionDisabled) {
      Analytics.capture('chat_toggle_backoff',
          {'conv': conv, 'reason': 'session_disabled'});
      return true;
    }
    // Exponential backoff window from a prior transient 503 still open → skip.
    if (_backoff.isBackingOff) {
      Analytics.capture('chat_toggle_backoff', {
        'conv': conv,
        'reason': 'backoff',
        'retry_in_s': _backoff.timeUntilNextRetry.inSeconds,
      });
      return true;
    }
    try {
      final res = await ApiAuth.getSigned('$_url?conv=${Uri.encodeComponent(conv)}');
      _backoff.shouldRetry(res.statusCode); // arm/reset backoff from the status
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body);
        // {disabled:true} → copilot master switch is off; stop asking this run.
        if (j is Map && j['disabled'] == true) _sessionDisabled = true;
        if (j is Map && j['on'] is bool) return j['on'] as bool;
      } else if (res.statusCode == 503 && _isCopilotDisabled(res.body)) {
        _sessionDisabled = true; // dark feature (kill switch) — quiet for the run.
      }
    } catch (e) {
      AvaLog.I.log('ava', 'chat-toggle fetch failed: $e');
    }
    return true;
  }

  /// Flip the switch. Returns true on success (callers keep their optimistic
  /// state); false means revert (e.g. 403 — a non-admin in a group, D29).
  /// Only fires on an actual user toggle, so it is never a storm source.
  static Future<bool> set(String conv, bool on) async {
    try {
      final res = await ApiAuth.postJson(_url, {'conv': conv, 'on': on});
      Analytics.capture('ava_chat_toggle_set',
          {'conv': conv, 'on': on, 'status': res.statusCode});
      // A user tapping the toggle while the feature is dark reveals the kill
      // switch — quiet subsequent fetches too instead of re-probing on reopen.
      if (res.statusCode == 503 && _isCopilotDisabled(res.body)) {
        _sessionDisabled = true;
      }
      return res.statusCode == 200;
    } catch (e) {
      AvaLog.I.log('ava', 'chat-toggle set failed: $e');
      return false;
    }
  }

  static bool _isCopilotDisabled(String body) {
    try {
      final j = jsonDecode(body);
      return j is Map && j['flag'] == 'avaCopilotEnabled';
    } catch (_) {
      return false;
    }
  }
}

class _DocRes {
  final int status;
  final String body;
  const _DocRes(this.status, this.body);
}
