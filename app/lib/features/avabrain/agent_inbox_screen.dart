import 'package:flutter/material.dart';

import '../../core/platform_api.dart';
import '../../core/theme.dart';

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

  // Per-app accent (color-coded per §20).
  static const _appColors = <String, Color>{
    'avadate': Color(0xFFFF6FA5), 'avamatri': Color(0xFFB06AF0),
    'avalinked': Color(0xFF4F8DFD), 'avaolx': Color(0xFFFFA24D),
    'avachat': AvaColors.brand, 'avalive': AvaColors.coral, 'avatube': AvaColors.danger,
  };

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final items = await PlatformApi.inbox();
      if (mounted) setState(() { _items = items; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = '$e'; _loading = false; });
    }
  }

  Future<void> _act(Map<String, dynamic> item, String action) async {
    try {
      await PlatformApi.inboxAction(item['id'] as String, action);
      await _load();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Done: $action')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Agent Inbox'), actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh))]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(color: AvaColors.danger)))
              : _items.isEmpty
                  ? const _Empty()
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: _items.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (_, i) => _InboxCard(
                          item: _items[i],
                          accent: _appColors[_items[i]['app_name']] ?? AvaColors.brand,
                          onAction: _act,
                        ),
                      ),
                    ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty();
  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.smart_toy_outlined, size: 56, color: AvaColors.sub),
            SizedBox(height: 12),
            Text('Your agent is on it.', style: TextStyle(fontWeight: FontWeight.w600)),
            SizedBox(height: 4),
            Text('Matches and suggestions will appear here.', style: TextStyle(color: AvaColors.sub)),
          ]),
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

    return Container(
      decoration: BoxDecoration(
        color: AvaColors.bg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AvaColors.line),
        boxShadow: const [BoxShadow(color: Color(0x0A000000), blurRadius: 8, offset: Offset(0, 2))],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          height: 4,
          decoration: BoxDecoration(color: accent, borderRadius: const BorderRadius.vertical(top: Radius.circular(14))),
        ),
        Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              _Pill(text: (item['app_name'] ?? '').toString(), color: accent),
              const Spacer(),
              if (autoApproved) _Pill(text: canUndo ? 'auto · undoable' : 'auto', color: AvaColors.sub),
              if (status == 'approved') const _Pill(text: 'approved', color: AvaColors.success),
              if (status == 'dismissed') const _Pill(text: 'dismissed', color: AvaColors.sub),
            ]),
            const SizedBox(height: 8),
            Text((item['title'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            if ((item['summary'] ?? '').toString().isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(item['summary'].toString(), style: const TextStyle(color: AvaColors.sub)),
            ],
            const SizedBox(height: 12),
            Row(children: [
              if (item['conversation_id'] != null)
                _ListenButton(conversationId: item['conversation_id'] as String),
              const Spacer(),
              if (canUndo)
                TextButton(onPressed: () => onAction(item, 'undo'), child: const Text('Undo'))
              else if (status == 'pending') ...[
                TextButton(onPressed: () => onAction(item, 'dismiss'), child: const Text('Dismiss', style: TextStyle(color: AvaColors.sub))),
                const SizedBox(width: 6),
                FilledButton(
                  onPressed: () => onAction(item, 'approve'),
                  style: FilledButton.styleFrom(backgroundColor: accent),
                  child: Text(_label(action)),
                ),
              ],
            ]),
          ]),
        ),
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
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(8)),
        child: Text(text, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
      );
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
  Widget build(BuildContext context) => TextButton.icon(
        onPressed: _busy ? null : _listen,
        icon: _busy
            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
            : const Icon(Icons.play_circle_outline, size: 20),
        label: const Text('Listen'),
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
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Couldn\'t synthesize: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
