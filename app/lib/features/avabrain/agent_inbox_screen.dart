import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/platform_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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

  // Per-app accent (color-coded per §20). On the dark surface the accent is the
  // pill's LABEL colour, not its fill — so these are the pale `chipInk` tones of
  // the AD avatar families, which are built to sit on a near-black chip. The two
  // raw hexes that used to live here (a hot pink and an orange) had no AD
  // equivalent and were the only hard-coded colours left in this file.
  //
  // `final`, not `const`: `AD.familyByName` is a lookup, not a const expression.
  static final _appColors = <String, Color>{
    'avadate': AD.familyByName('rose').chipInk,
    'avamatri': AD.familyByName('lilac').chipInk,
    'avalinked': AD.familyByName('sky').chipInk,
    'avaolx': AD.familyByName('peach').chipInk,
    'avachat': AD.familyByName('sky').chipInk,
    'avalive': AD.familyByName('terra').chipInk,
    'avatube': AD.familyByName('terra').chipInk,
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
        tag: 'AvaBrain · agentic layer',
        showBack: Navigator.of(context).canPop(),
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular),
            onTap: _load,
          ),
        ],
      ),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
            : _error != null
                ? Center(child: Padding(
                    padding: const EdgeInsets.all(Msg.s5),
                    child: ZineErrorMsg(_error!)))
                : _items.isEmpty
                    ? const Center(child: _Empty())
                    : RefreshIndicator(
                        color: AD.primaryBadge,
                        backgroundColor: AD.card,
                        onRefresh: _load,
                        child: ListView.separated(
                          padding: const EdgeInsets.all(Msg.s4),
                          itemCount: _items.length,
                          separatorBuilder: (_, __) => const SizedBox(height: Msg.s4),
                          itemBuilder: (_, i) => _InboxCard(
                            item: _items[i],
                            accent: _appColors[_items[i]['app_name']] ?? AD.familyByName('lilac').chipInk,
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
        padding: const EdgeInsets.all(Msg.s6),
        child: ZineEmptyState(
          icon: PhosphorIcons.robot(PhosphorIconsStyle.regular),
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
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          _Pill(text: (item['app_name'] ?? '').toString(), color: accent),
          const Spacer(),
          if (autoApproved) _Pill(text: canUndo ? 'Auto · undoable' : 'Auto', color: AD.textSecondary),
          if (status == 'approved') _Pill(text: 'Approved', color: AD.online),
          if (status == 'dismissed') _Pill(text: 'Dismissed', color: AD.textTertiary),
        ]),
        const SizedBox(height: Msg.s3),
        Text((item['title'] ?? '').toString(), style: ADText.threadName().copyWith(fontSize: 17)),
        if ((item['summary'] ?? '').toString().isNotEmpty) ...[
          const SizedBox(height: Msg.s1),
          Text(item['summary'].toString(), style: ADText.preview()),
        ],
        const SizedBox(height: Msg.s4),
        Row(children: [
          if (item['conversation_id'] != null)
            _ListenButton(conversationId: item['conversation_id'] as String),
          const Spacer(),
          if (canUndo)
            ZineLink('Undo', onTap: () => onAction(item, 'undo'))
          else if (status == 'pending') ...[
            ZineLink('Dismiss', onTap: () => onAction(item, 'dismiss')),
            const SizedBox(width: Msg.s4),
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

/// Tag pill. [color] is the LABEL colour, not the fill.
///
/// The light version filled the pill with the accent and printed near-black ink
/// on top. Carrying that over literally would have put white on a saturated fill
/// at roughly 2.5:1 for the darker app accents; the fill is a neutral card
/// instead and the accent moved to the text, which is where it reads.
class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.color});
  final String text; final Color color;
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
      decoration: BoxDecoration(
        color: AD.card,
        // A tag IS one of the shapes a pill is reserved for.
        borderRadius: Msg.brPill,
        border: Border.all(color: AD.borderControl, width: 1),
        boxShadow: Msg.none,
      ),
      // Sentence case, not caps — the label arrives lowercase from the API
      // ('avadate'), so dropping the old .toUpperCase() outright would render it
      // lowercase rather than in sentence case.
      child: Text(
        text.isEmpty ? text : '${text[0].toUpperCase()}${text.substring(1)}',
        style: ADText.statCaption(c: color),
      ),
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
