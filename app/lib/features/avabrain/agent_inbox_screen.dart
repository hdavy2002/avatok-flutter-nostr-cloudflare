import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/platform_api.dart';
import '../../core/theme.dart';
import '../../core/ui/zine_widgets.dart';

/// AvaBrain — 5th screen: the Agent Inbox (§20). The single surface for the
/// agentic layer: WhatsApp-style, color-coded per app. Shows agent-to-agent
/// matches + proposed actions; the user approves/dismisses, can undo an
/// auto-approved action within its 1-hour window, and can tap "Listen" to lazily
/// synthesize the conversation audio (Aura-2, cached server-side).
class AgentInboxScreen extends StatefulWidget {
  const AgentInboxScreen({super.key});
  @override
  State<AgentInboxScreen> createState() => _AgentInboxScreenState();
}

class _AgentInboxScreenState extends State<AgentInboxScreen> {
  List<Map<String, dynamic>> _items = const [];
  bool _loading = true;
  String? _error;

  // Per-app accent (color-coded per §20) — flat poster colors, ink-bordered pills.
  static const _appColors = <String, Color>{
    'avadate': Color(0xFFFF6FA5), 'avamatri': Zine.lilac,
    'avalinked': Zine.blue, 'avaolx': Color(0xFFFFA24D),
    'avachat': Zine.blue, 'avalive': Zine.coral, 'avatube': Zine.coral,
  };

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final items = await PlatformApi.inbox();
      if (mounted) setState(() { _items = items; _loading = false; });
    } catch (_) {
      if (mounted) setState(() { _error = 'Couldn\'t load your inbox. Pull to refresh.'; _loading = false; });
    }
  }

  Future<void> _act(Map<String, dynamic> item, String action) async {
    try {
      await PlatformApi.inboxAction(item['id'] as String, action);
      await _load();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Done: $action')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That didn\'t go through. Please try again.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ZineAppBar(
        title: 'Agent Inbox',
        markWord: 'Inbox',
        tag: 'AVABRAIN · AGENTIC LAYER',
        showBack: Navigator.of(context).canPop(),
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold),
            onTap: _load,
          ),
        ],
      ),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.lilac))
            : _error != null
                ? Center(child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: ZineErrorMsg(_error!)))
                : _items.isEmpty
                    ? const Center(child: _Empty())
                    : RefreshIndicator(
                        color: Zine.blueInk,
                        onRefresh: _load,
                        child: ListView.separated(
                          padding: const EdgeInsets.all(16),
                          itemCount: _items.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 14),
                          itemBuilder: (_, i) => _InboxCard(
                            item: _items[i],
                            accent: _appColors[_items[i]['app_name']] ?? Zine.lilac,
                            onAction: _act,
                          ),
                        ),
                      ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty();
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(32),
        child: ZineEmptyState(
          icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
          text: 'Your agent is on it.\nMatches and suggestions show up here.',
        ),
      );
}

class _InboxCard extends StatelessWidget {
  const _InboxCard({required this.item, required this.accent, required this.onAction});
  final Map<String, dynamic> item;
  final Color accent;
  final Future<void> Function(Map<String, dynamic>, String) onAction;

  @override
  Widget build(BuildContext context) {
    final status = (item['status'] ?? 'pending') as String;
    final autoApproved = status == 'auto_approved';
    final undoUntil = (item['undo_until'] as num?)?.toInt();
    final canUndo = autoApproved && undoUntil != null && DateTime.now().millisecondsSinceEpoch < undoUntil;
    final action = (item['proposed_action'] ?? 'review') as String;

    return ZineCard(
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          _Pill(text: (item['app_name'] ?? '').toString(), color: accent),
          const Spacer(),
          if (autoApproved) _Pill(text: canUndo ? 'auto · undoable' : 'auto', color: Zine.paper2),
          if (status == 'approved') _Pill(text: 'approved', color: Zine.mint),
          if (status == 'dismissed') _Pill(text: 'dismissed', color: Zine.paper2),
        ]),
        const SizedBox(height: 11),
        Text((item['title'] ?? '').toString(), style: ZineText.cardTitle(size: 17)),
        if ((item['summary'] ?? '').toString().isNotEmpty) ...[
          const SizedBox(height: 5),
          Text(item['summary'].toString(), style: ZineText.sub(size: 14.5)),
        ],
        const SizedBox(height: 14),
        Row(children: [
          if (item['conversation_id'] != null)
            _ListenButton(conversationId: item['conversation_id'] as String),
          const Spacer(),
          if (canUndo)
            ZineLink('Undo', onTap: () => onAction(item, 'undo'))
          else if (status == 'pending') ...[
            ZineLink('Dismiss', onTap: () => onAction(item, 'dismiss')),
            const SizedBox(width: 14),
            ZineButton(
              label: _label(action),
              variant: ZineButtonVariant.blue,
              fontSize: 15,
              trailingIcon: false,
              icon: PhosphorIcons.check(PhosphorIconsStyle.bold),
              onPressed: () => onAction(item, 'approve'),
            ),
          ],
        ]),
      ]),
    );
  }

  String _label(String a) => switch (a) {
        'connect' => 'Connect',
        'book' => 'Book',
        'buy' => 'Approve purchase',
        'reply' => 'Send reply',
        'post' => 'Post',
        _ => 'Approve',
      };
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.color});
  final String text; final Color color;
  @override
  Widget build(BuildContext context) {
    final fg = color == Zine.coral ? Colors.white : Zine.ink;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: Zine.ink, width: Zine.bw),
        boxShadow: Zine.shadowXs,
      ),
      child: Text(text.toUpperCase(), style: ZineText.tag(size: 10.5, color: fg)),
    );
  }
}

/// "Listen" — lazily synthesizes the conversation audio on tap (TTS is never
/// pre-generated; the server caches the render and reuses it for both parties).
class _ListenButton extends StatefulWidget {
  const _ListenButton({required this.conversationId});
  final String conversationId;
  @override
  State<_ListenButton> createState() => _ListenButtonState();
}

class _ListenButtonState extends State<_ListenButton> {
  bool _busy = false;
  @override
  Widget build(BuildContext context) => ZineButton(
        label: 'Listen',
        variant: ZineButtonVariant.ghost,
        fontSize: 14,
        trailingIcon: false,
        loading: _busy,
        icon: PhosphorIcons.play(PhosphorIconsStyle.fill),
        onPressed: _busy ? null : _listen,
      );

  Future<void> _listen() async {
    setState(() => _busy = true);
    try {
      final r = await PlatformApi.ttsListen(widget.conversationId);
      // r['audio_path'] → GET via PlatformApi.agentAudioUrl(...) with an audio player.
      // (Wire to just_audio / audioplayers with the NIP-98 header; omitted here.)
      if (mounted && r['ready'] == true) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Audio ready — tap to play in the player.')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Couldn\'t create the audio just now. Please try again.')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
