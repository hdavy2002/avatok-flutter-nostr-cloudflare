import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/ava_ai_client.dart';
import '../../core/brain_consent.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avadial/block_list.dart';
import 'askava_tools.dart';

/// Ask Ava — the universal assistant (plan §4.6). A ChatAVA-style chat surface that
/// makes the whole app AI-powered: "call the plumber from last Tuesday", "who
/// called me most this month?", "is this number spam?".
///
/// TOOL-CALLING PATH (documented): the shared [AvaAiClient] talks to the AvaTok
/// Worker's Gemini proxy, which is a plain text-in/text-out turn API — it has NO
/// native function-calling surface exposed to the client. So Ask Ava uses the
/// PLAN §4.6 documented FALLBACK: a system preamble instructs the model to answer
/// with a single-line JSON tool call `{"tool":"...","args":{...}}` when it needs
/// data. We parse that client-side, run the LOCAL tool ([AskAvaTools]), feed the
/// minimal result back as the next turn, and cap the loop at 3 hops.
///
/// HARD PRIVACY BOUNDARY (plan §4.6): only the user's query + the few matching
/// rows a tool returns ever enter the model context; tool results are NEVER passed
/// to RagService/AvaBrain ingestion and are not persisted beyond the visible
/// thread. Actions (dial/block/report_spam) NEVER auto-run — they render a
/// confirmation chip the user must tap.
class AskAvaScreen extends StatefulWidget {
  /// Which app opened the assistant ('root' | 'avadial' | 'avatalk' | 'services'),
  /// used to prime the preamble with that context (plan §4.6).
  final String contextHint;
  const AskAvaScreen({super.key, this.contextHint = 'root'});

  @override
  State<AskAvaScreen> createState() => _AskAvaScreenState();
}

enum _Role { user, assistant, action }

class _Turn {
  final _Role role;
  final String text;
  final List<AskAvaContact> contacts; // assistant → Call/Message chips
  final String? actionTool; // 'dial' | 'block' | 'report_spam'
  final String? actionArg; // the number
  _Turn(this.role, this.text, {this.contacts = const [], this.actionTool, this.actionArg});

  Map<String, dynamic> toJson() => {'r': role.name, 't': text};
  static _Turn? fromJson(Map<String, dynamic> j) {
    final r = _Role.values.where((e) => e.name == j['r']);
    if (r.isEmpty) return null;
    // Only user/assistant turns persist (actions/chips are ephemeral).
    if (r.first == _Role.action) return null;
    return _Turn(r.first, (j['t'] ?? '').toString());
  }
}

class _AskAvaScreenState extends State<AskAvaScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _turns = <_Turn>[];
  bool _busy = false;

  static const _maxHops = 3;
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _threadKey = 'askava_thread_v1';

  @override
  void initState() {
    super.initState();
    _loadThread();
    Analytics.capture('askava_opened', {'source': widget.contextHint});
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadThread() async {
    try {
      final raw = await readScoped(_ss, _threadKey);
      if (raw == null || raw.isEmpty) return;
      final list = jsonDecode(raw);
      if (list is List) {
        final restored = <_Turn>[];
        for (final e in list) {
          if (e is Map) {
            final t = _Turn.fromJson(e.map((k, v) => MapEntry('$k', v)));
            if (t != null) restored.add(t);
          }
        }
        if (mounted) setState(() { _turns..clear()..addAll(restored); });
        _jumpToEnd();
      }
    } catch (_) {/* first run / corrupt → empty thread */}
  }

  Future<void> _saveThread() async {
    try {
      final keep = _turns.where((t) => t.role != _Role.action).map((t) => t.toJson()).toList();
      await _ss.write(key: scopedKey(_threadKey), value: jsonEncode(keep));
    } catch (_) {/* best-effort */}
  }

  void _jumpToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
      }
    });
  }

  // ── Orchestration ─────────────────────────────────────────────────────────
  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;
    _input.clear();
    setState(() {
      _turns.add(_Turn(_Role.user, text));
      _busy = true;
    });
    _jumpToEnd();
    unawaited(_saveThread());

    // AvaBrain guardrail (plan §4.6 / rulebook rule 3): tools run only with consent.
    final toolsAllowed = await BrainConsent.isOn('askava');

    // Working history for THIS exchange: prior user/assistant turns as model roles.
    final history = <Map<String, String>>[
      for (final t in _turns.take(_turns.length - 1))
        if (t.role == _Role.user)
          {'role': 'user', 'text': t.text}
        else if (t.role == _Role.assistant)
          {'role': 'model', 'text': t.text},
    ];

    var pending = text; // the message to send this hop
    String? finalText;
    List<AskAvaContact> finalContacts = const [];

    try {
      for (var hop = 0; hop < _maxHops; hop++) {
        final ans = await AvaAiClient.I.ask(
          message: pending,
          context: _preamble(toolsAllowed),
          history: history,
          source: 'askava',
        );
        final reply = ans.answer.trim();

        final call = _parseToolCall(reply);
        if (call == null) {
          finalText = reply.isEmpty ? 'Sorry, I could not find an answer.' : reply;
          break;
        }

        final tool = call.$1;
        final args = call.$2;

        // Action tool → confirmation chip; assistant never executes it.
        if (AskAvaTools.actionTools.contains(tool)) {
          final number = (args['number'] ?? args['q'] ?? '').toString();
          setState(() => _turns.add(_Turn(_Role.action, _actionPrompt(tool, number),
              actionTool: tool, actionArg: number)));
          finalText = null;
          break;
        }

        // Data tool → run locally (if allowed), feed the result back.
        if (AskAvaTools.dataTools.contains(tool)) {
          if (!toolsAllowed) {
            finalText =
                'I can chat, but searching your contacts, calls and chats is turned off. '
                'Turn "Ask Ava" back on under Settings → AvaBrain to let me look things up.';
            break;
          }
          final res = await AskAvaTools.runData(tool, args);
          finalContacts = res.contacts;
          history.add({'role': 'model', 'text': reply});
          history.add({'role': 'user', 'text': res.summaryForModel});
          pending = res.summaryForModel;
          continue;
        }

        // Unknown tool name → just surface the raw reply.
        finalText = reply;
        break;
      }
    } catch (_) {
      finalText = 'Ava could not be reached. Please try again.';
    }

    if (finalText != null) {
      final ft = finalText;
      setState(() => _turns.add(_Turn(_Role.assistant, ft, contacts: finalContacts)));
    }
    setState(() => _busy = false);
    _jumpToEnd();
    unawaited(_saveThread());
  }

  /// The system preamble: describes the tools, the JSON protocol, and the privacy
  /// boundary. Primed by [contextHint] so opening from AvaDial favours dialer tools.
  String _preamble(bool toolsAllowed) {
    final focus = switch (widget.contextHint) {
      'avadial' => 'The user opened you from AvaDial (the phone app), so favour dialer tools.',
      'avatalk' => 'The user opened you from AvaTalk (the messenger), so favour chat search.',
      'services' => 'The user opened you from Services (marketplace/wallet).',
      _ => 'The user opened you from the Home dashboard.',
    };
    if (!toolsAllowed) {
      return 'You are Ask Ava, a helpful assistant inside the AvaTOK app. $focus '
          'Device search tools are currently DISABLED by the user, so answer conversationally '
          'and do not emit tool calls.';
    }
    return '''
You are Ask Ava, a helpful assistant inside the AvaTOK app. $focus
When you need the user's data, reply with ONE line of JSON and nothing else:
{"tool":"NAME","args":{...}}
Available tools:
- search_contacts {"q":"text"} — find a contact by name/number.
- search_call_log {"q":"text"} — find recent calls by name/number.
- search_chats {"q":"text"} — find something in the user's messages.
- spam_lookup {"number":"+1..."} — check a phone number against the community spam pool.
- dial {"number":"+1..."} — offer to call a number (the user confirms).
- block {"number":"+1..."} — offer to block a number (the user confirms).
- report_spam {"number":"+1..."} — offer to report a number as spam (the user confirms).
After a tool result comes back, either call another tool or give a short, friendly final answer.
Never invent contacts or numbers; only use what the tools return. Keep answers concise.''';
  }

  /// Extract the FIRST `{"tool":...}` object from a model reply, tolerating code
  /// fences / surrounding prose. Returns (tool, args) or null.
  (String, Map<String, dynamic>)? _parseToolCall(String reply) {
    final start = reply.indexOf('{');
    if (start < 0) return null;
    // Scan for a balanced object from the first brace.
    var depth = 0;
    for (var i = start; i < reply.length; i++) {
      final ch = reply[i];
      if (ch == '{') depth++;
      if (ch == '}') {
        depth--;
        if (depth == 0) {
          final chunk = reply.substring(start, i + 1);
          try {
            final j = jsonDecode(chunk);
            if (j is Map && j['tool'] is String) {
              final args = (j['args'] is Map)
                  ? (j['args'] as Map).map((k, v) => MapEntry('$k', v))
                  : <String, dynamic>{};
              return (j['tool'] as String, args);
            }
          } catch (_) {/* not a tool call */}
          return null;
        }
      }
    }
    return null;
  }

  String _actionPrompt(String tool, String number) => switch (tool) {
        'dial' => 'Call $number?',
        'block' => 'Block $number?',
        'report_spam' => 'Report $number as spam?',
        _ => number,
      };

  // ── Confirmed actions (user tapped the chip) ───────────────────────────────
  Future<void> _confirmAction(String tool, String number) async {
    Analytics.capture('askava_action_confirmed', {'tool': tool});
    switch (tool) {
      case 'dial':
        try {
          await launchUrl(Uri(scheme: 'tel', path: number));
        } catch (_) {
          _notice('Could not open the dialer.');
        }
        break;
      case 'block':
        await BlockList.I.block(number);
        _notice('Blocked $number.');
        break;
      case 'report_spam':
        await BlockList.I.reportSpam(number);
        _notice('Reported $number as spam.');
        break;
    }
  }

  void _notice(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg), behavior: SnackBarBehavior.floating));
  }

  Future<void> _clearThread() async {
    setState(() => _turns.clear());
    try {
      await _ss.delete(key: scopedKey(_threadKey));
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper2,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lime, size: 30),
          const SizedBox(width: 10),
          Text('Ask Ava', style: ZineText.appbar()),
        ]),
        actions: [
          if (_turns.isNotEmpty)
            IconButton(
              tooltip: 'Clear',
              icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: Zine.inkSoft, size: 20),
              onPressed: _clearThread,
            ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(children: [
          Expanded(
            child: _turns.isEmpty
                ? _emptyState()
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
                    itemCount: _turns.length + (_busy ? 1 : 0),
                    itemBuilder: (_, i) {
                      if (i >= _turns.length) return _typing();
                      return _bubble(_turns[i]);
                    },
                  ),
          ),
          _composer(),
        ]),
      ),
    );
  }

  Widget _emptyState() => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 36),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lime, size: 54),
            const SizedBox(height: 14),
            Text('Ask me anything', textAlign: TextAlign.center, style: ZineText.cardTitle(size: 18)),
            const SizedBox(height: 8),
            Text(
              '"Call the plumber from last Tuesday", "who called me most this month?", '
              '"is +1 555 0100 spam?"',
              textAlign: TextAlign.center,
              style: ZineText.sub(size: 13.5),
            ),
          ]),
        ),
      );

  Widget _bubble(_Turn t) {
    if (t.role == _Role.action) return _actionChip(t);
    final mine = t.role == _Role.user;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: mine ? Zine.lime : Zine.card,
          borderRadius: BorderRadius.circular(Zine.rSm),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(t.text, style: ZineText.value(size: 14.5, weight: FontWeight.w500)),
          if (t.contacts.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final c in t.contacts.take(4)) ..._contactChips(c),
            ]),
          ],
        ]),
      ),
    );
  }

  List<Widget> _contactChips(AskAvaContact c) {
    if (c.inNetwork) {
      // AvaTOK contact → Message chip (deep-link is a future refinement).
      return [_chip('Message ${_short(c.name)}', PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), Zine.mint,
          () => _notice('Open AvaTalk to message ${c.name}.'))];
    }
    return [
      _chip('Call ${_short(c.name)}', PhosphorIcons.phone(PhosphorIconsStyle.bold), Zine.blue,
          () => _confirmAction('dial', c.number)),
    ];
  }

  String _short(String s) => s.length > 14 ? '${s.substring(0, 14)}…' : s;

  Widget _actionChip(_Turn t) {
    final color = switch (t.actionTool) {
      'dial' => Zine.blue,
      'block' => Zine.coral,
      'report_spam' => Zine.coral,
      _ => Zine.lime,
    };
    final label = switch (t.actionTool) {
      'dial' => 'Call ▸',
      'block' => 'Block ▸',
      'report_spam' => 'Report ▸',
      _ => 'Confirm ▸',
    };
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(Zine.rSm),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(t.text, style: ZineText.value(size: 14.5)),
          const SizedBox(width: 12),
          _chip(label, null, color, () {
            if (t.actionTool != null && t.actionArg != null) {
              _confirmAction(t.actionTool!, t.actionArg!);
            }
          }),
        ]),
      ),
    );
  }

  Widget _chip(String label, IconData? icon, Color color, VoidCallback onTap) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[PhosphorIcon(icon, size: 14, color: Zine.ink), const SizedBox(width: 6)],
          Text(label, style: ZineText.tag(size: 12.5, color: Zine.ink)),
        ]),
      ),
    );
  }

  Widget _typing() => Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 5),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: Zine.card,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Border.all(color: Zine.ink, width: Zine.bw),
          ),
          child: Text('Ava is thinking…', style: ZineText.sub(size: 13.5)),
        ),
      );

  Widget _composer() {
    return Container(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        color: Zine.paper2,
      ),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
      child: Row(children: [
        Expanded(
          child: Container(
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Border.all(color: Zine.ink, width: Zine.bw),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: TextField(
              controller: _input,
              minLines: 1,
              maxLines: 4,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _send(),
              style: ZineText.value(size: 15),
              decoration: const InputDecoration(
                border: InputBorder.none,
                hintText: 'Ask Ava…',
                isDense: true,
                contentPadding: EdgeInsets.symmetric(vertical: 12),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        GestureDetector(
          onTap: _busy ? null : _send,
          child: Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: _busy ? Zine.inkMute : Zine.lime,
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Border.all(color: Zine.ink, width: Zine.bw),
              boxShadow: Zine.shadowXs,
            ),
            child: PhosphorIcon(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                color: Zine.ink, size: 20),
          ),
        ),
      ]),
    );
  }
}
