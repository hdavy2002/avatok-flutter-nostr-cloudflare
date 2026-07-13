import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ava_ai_client.dart';
import '../../core/brain_consent.dart';
import '../../core/db.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avachat/discuss_seed.dart';
import '../avachat/thread_context.dart';
import '../identity/ladder_api.dart';
import 'companion_session_store.dart';
import 'companion_thread.dart';
import 'persona.dart';

/// CompanionHome (Phase 6 — Companion / Blank Ava Chat).
///
/// The AvaChat landing screen. It now shows the user's LIST OF PAST SESSIONS
/// (saved locally in per-account SQLite + backed up to D1) instead of the old
/// persona picker. From here the user can resume any chat, and on each card:
/// star, rename, archive, delete (via the 3-dot menu OR a long-press menu), and
/// drag-reorder the list. "New chat" opens the persona picker (Just chat /
/// Brainstorm / Language practice / Roleplay) as a sheet, then a fresh thread.
///
/// AGE-GATE: the Roleplay persona is limited to VERIFIED ADULTS (Trust Ladder
/// **L2+**). llama-guard still moderates every turn server-side regardless.
const int kRoleplayMinLadderLevel = 2;

class CompanionHome extends StatefulWidget {
  const CompanionHome({super.key});
  @override
  State<CompanionHome> createState() => _CompanionHomeState();
}

class _CompanionHomeState extends State<CompanionHome> {
  int _level = 1; // pessimistic default until the ladder resolves
  bool _levelLoaded = false;

  List<CompanionSession> _sessions = const [];
  bool _loading = true;
  bool _showArchived = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'avachat_home');
    _loadLevel();
    _loadSessions(initial: true);
  }

  Future<void> _loadLevel() async {
    final cached = await LadderApi.cachedLevel();
    if (mounted) setState(() => _level = cached);
    final fresh = await LadderApi.level();
    if (!mounted) return;
    setState(() {
      if (fresh != null) _level = fresh.level;
      _levelLoaded = true;
    });
  }

  bool get _isVerifiedAdult => _level >= kRoleplayMinLadderLevel;

  Future<void> _loadSessions({bool initial = false}) async {
    // Paint instantly from the local SQLite copy, then merge the cloud list in.
    final local = await CompanionSessionStore.I.list(archived: _showArchived);
    if (mounted) setState(() {
      _sessions = local;
      _loading = false;
    });
    if (initial) {
      await CompanionSessionStore.I.syncFromCloud();
      final merged = await CompanionSessionStore.I.list(archived: _showArchived);
      if (mounted) setState(() => _sessions = merged);
    }
    Analytics.capture('avachat_sessions_listed',
        {'count': _sessions.length, 'archived': _showArchived});
  }

  // ── new chat ────────────────────────────────────────────────────────────────

  Future<void> _newChat() async {
    Analytics.capture('avachat_new_chat_tapped', const {});
    final persona = await _pickPersona();
    if (persona == null || !mounted) return;
    await AvaPersonaStore.save(persona);
    Analytics.capture('avachat_session_started', {'persona': persona.id});
    await Navigator.push(context,
        MaterialPageRoute(builder: (_) => CompanionThreadScreen(persona: persona)));
    await _loadSessions(); // refresh after the thread closes (it may have saved)
  }

  /// "Discuss a chat" — pick one of the user's Messenger conversations (from the
  /// local chat-list projection) and open ChatAVA pointed at it. The transcript
  /// is read from the per-account SQLite store and assembled on-device.
  Future<void> _discussAChat() async {
    Analytics.capture('discuss_with_ava_picker_opened', const {});
    List<ChatRow> rows;
    try { rows = await Db.I.chatsOnce(); } catch (_) { rows = const []; }
    final items = <({String convKey, String name, bool group})>[];
    for (final r in rows) {
      if (r.json.isEmpty) continue;
      try {
        final m = jsonDecode(r.json) as Map<String, dynamic>;
        final k = (m['k'] ?? r.convKey).toString();
        final name = (m['n'] ?? '').toString();
        if (k.isEmpty || name.isEmpty) continue;
        items.add((convKey: k, name: name, group: m['g'] == true));
      } catch (_) {/* skip malformed row */}
    }
    if (!mounted) return;
    if (items.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No conversations yet to discuss.')));
      return;
    }
    final picked = await showModalBottomSheet<({String convKey, String name, bool group})>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 12),
          Text('Discuss a chat with Ava', style: ADText.threadName(c: AD.textPrimary)),
          const SizedBox(height: 4),
          Text('Your messages stay on this device.', style: ADText.preview()),
          const SizedBox(height: 8),
          Flexible(
            child: ListView(shrinkWrap: true, children: [
              for (final it in items)
                ListTile(
                  leading: PhosphorIcon(
                      it.group
                          ? PhosphorIcons.usersThree(PhosphorIconsStyle.bold)
                          : PhosphorIcons.user(PhosphorIconsStyle.bold),
                      color: AD.textSecondary),
                  title: Text(it.name, style: ADText.rowName()),
                  onTap: () => Navigator.pop(ctx, it),
                ),
            ]),
          ),
          const SizedBox(height: 8),
        ]),
      ),
    );
    if (picked == null || !mounted) return;
    await _openDiscussion(picked.convKey, picked.name, picked.group);
  }

  /// Build the transcript for [convKey] on-device and open the discussion thread.
  Future<void> _openDiscussion(String convKey, String name, bool isGroup) async {
    final allowed = await BrainConsent.isOn(isGroup ? 'group_chats' : 'avatok_dms');
    if (!mounted) return;
    if (!allowed) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Turn on AvaBrain for your messages in Settings to discuss '
            'a chat. Your messages stay on this device.'),
      ));
      return;
    }
    List<MessageRow> msgRows;
    try { msgRows = await Db.I.messagesFor(convKey); } catch (_) { msgRows = const []; }
    final turns = turnsFromEnvelopes(
        [for (final m in msgRows) (mine: m.mine, payload: m.payload)]);
    if (!mounted) return;
    if (turns.length > ThreadContext.kRawTailTurns * 4) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        duration: Duration(seconds: 2), content: Text('Reading your chat for Ava…')));
    }
    final transcript = await ThreadContext.buildSmart(
      peerLabel: name,
      turns: turns,
      isGroup: isGroup,
      summarize: (chunk) async {
        final ans = await AvaAiClient.I.ask(
          message: 'Summarise these chat messages in 2-3 sentences. Preserve who '
              'said what and any decisions, plans, questions, or feelings:\n\n$chunk',
        );
        return ans.answer;
      },
    );
    if (!mounted) return;
    if (transcript.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Not enough messages there for Ava to weigh in.')));
      return;
    }
    Analytics.capture('discuss_with_ava_opened', {
      'surface': 'picker',
      'is_group': isGroup,
      'turns': turns.length,
      'chars': transcript.length,
      'summarized': transcript.contains('(summarised)'),
    });
    await Navigator.push(context, MaterialPageRoute(
      builder: (_) => CompanionThreadScreen(
        persona: discussPersona(name, isGroup: isGroup),
        discussContext: transcript,
        initialTitle: 'Chat with $name',
      ),
    ));
  }

  Future<void> _openSession(CompanionSession s) async {
    Analytics.capture('avachat_session_opened',
        {'persona': s.persona, 'starred': s.starred});
    final msgs = await CompanionSessionStore.I.messages(s.id);
    if (!mounted) return;
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CompanionThreadScreen(
          persona: AvaPersonas.byId(s.persona),
          sessionId: s.id,
          initialMessages: msgs,
          initialTitle: s.title,
        ),
      ),
    );
    await _loadSessions();
  }

  /// Persona picker as a bottom sheet (returns the chosen persona, or null).
  Future<AvaPersona?> _pickPersona() {
    return showModalBottomSheet<AvaPersona>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderHairline, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 38),
              const SizedBox(width: 10),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('New chat with Ava', style: ADText.threadName(c: AD.textPrimary)),
                Text('Pick how you want to talk', style: ADText.preview()),
              ])),
            ]),
            const SizedBox(height: 14),
            for (final p in AvaPersonas.all) ...[
              _PersonaTile(
                persona: p,
                locked: p.adultOnly && !_isVerifiedAdult,
                loading: p.adultOnly && !_levelLoaded,
                onTap: () {
                  if (p.adultOnly && !_isVerifiedAdult) {
                    Navigator.pop(ctx);
                    _showAdultGate();
                    return;
                  }
                  Navigator.pop(ctx, p);
                },
              ),
              const SizedBox(height: 10),
            ],
            const SizedBox(height: 4),
            Text(
              'Talking to Ava is free. Replies are AI-generated and moderated. '
              'Turn on Ava’s voice in Settings → Ava voice (premium).',
              style: ADText.preview(),
            ),
          ]),
        ),
      ),
    );
  }

  void _showAdultGate() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderHairline, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 38),
              const SizedBox(width: 12),
              Expanded(child: Text('Adults only', style: ADText.threadName(c: AD.textPrimary))),
            ]),
            const SizedBox(height: 12),
            Text(
              'Roleplay is limited to verified adults. Verify your identity in '
              'AvaIdentity (a quick liveness check) to unlock it. Everything stays '
              'safe and moderated either way.',
              style: ADText.preview(),
            ),
            const SizedBox(height: 18),
            AdButton(
              label: 'Verify in AvaIdentity',
              variant: AdButtonVariant.teal,
              fullWidth: true,
              fontSize: 15,
              icon: PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
              onPressed: () {
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                    content: Text('Open AvaIdentity from the menu to verify (Level 2).')));
              },
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text('Not now', style: ADText.preview(c: AD.textSecondary)),
            ),
          ]),
        ),
      ),
    );
  }

  // ── per-session actions ──────────────────────────────────────────────────────

  Future<void> _showSessionMenu(CompanionSession s) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderHairline, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(s.title.isEmpty ? 'Chat' : s.title,
                  style: ADText.threadName(c: AD.textPrimary), maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ),
          _menuRow(ctx, 'star', s.starred ? PhosphorIcons.starHalf(PhosphorIconsStyle.bold) : PhosphorIcons.star(PhosphorIconsStyle.bold),
              s.starred ? 'Remove star' : 'Add star'),
          _menuRow(ctx, 'rename', PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Rename'),
          _menuRow(ctx, 'archive', PhosphorIcons.archive(PhosphorIconsStyle.bold),
              s.archived ? 'Unarchive' : 'Archive'),
          _menuRow(ctx, 'delete', PhosphorIcons.trash(PhosphorIconsStyle.bold), 'Delete', danger: true),
          const SizedBox(height: 10),
        ]),
      ),
    );
    if (action == null) return;
    switch (action) {
      case 'star':
        await CompanionSessionStore.I.setStar(s.id, !s.starred);
        Analytics.capture('avachat_session_starred', {'starred': !s.starred});
        break;
      case 'rename':
        await _renameSession(s);
        break;
      case 'archive':
        await CompanionSessionStore.I.setArchived(s.id, !s.archived);
        Analytics.capture('avachat_session_archived', {'archived': !s.archived});
        break;
      case 'delete':
        await _deleteSession(s);
        break;
    }
    await _loadSessions();
  }

  Widget _menuRow(BuildContext ctx, String value, IconData icon, String label, {bool danger = false}) {
    return ListTile(
      leading: PhosphorIcon(icon, size: 20, color: danger ? AD.danger : AD.textSecondary),
      title: Text(label, style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
      onTap: () => Navigator.pop(ctx, value),
    );
  }

  Future<void> _renameSession(CompanionSession s) async {
    final ctrl = TextEditingController(text: s.title);
    final newTitle = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Rename chat', style: ADText.threadName(c: AD.textPrimary)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 80,
          style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w700,
              fontSize: 15, color: AD.textPrimary),
          decoration: InputDecoration(
            hintText: 'Chat name',
            hintStyle: ADText.preview(c: AD.textTertiary),
          ),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: ADText.preview(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: Text('Save', style: ADText.preview(c: AD.iconSearch))),
        ],
      ),
    );
    if (newTitle != null && newTitle.isNotEmpty) {
      await CompanionSessionStore.I.rename(s.id, newTitle);
      Analytics.capture('avachat_session_renamed', const {});
    }
  }

  Future<void> _deleteSession(CompanionSession s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Delete chat?', style: ADText.threadName(c: AD.textPrimary)),
        content: Text('This removes the conversation from this device and the cloud backup. This can’t be undone.',
            style: ADText.preview()),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text('Cancel', style: ADText.preview(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text('Delete', style: ADText.preview(c: AD.danger))),
        ],
      ),
    );
    if (ok == true) {
      await CompanionSessionStore.I.delete(s.id);
      Analytics.capture('avachat_session_deleted', const {});
    }
  }

  Future<void> _onReorder(int oldIndex, int newIndex) async {
    setState(() {
      final list = List<CompanionSession>.from(_sessions);
      if (newIndex > oldIndex) newIndex -= 1;
      final moved = list.removeAt(oldIndex);
      list.insert(newIndex, moved);
      _sessions = list;
    });
    await CompanionSessionStore.I.reorder(_sessions.map((s) => s.id).toList());
    Analytics.capture('avachat_sessions_reordered', {'count': _sessions.length});
  }

  // ── build ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      floatingActionButton: _showArchived
          ? null
          : FloatingActionButton.extended(
              onPressed: _newChat,
              backgroundColor: AD.primaryBadge,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(100)),
              icon: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), color: Colors.white),
              label: Text('New chat', style: ADText.rowName(c: Colors.white)),
            ),
      body: SafeArea(
        child: Column(children: [
          _header(),
          Expanded(child: _loading ? _loadingState() : (_sessions.isEmpty ? _emptyState() : _sessionList())),
        ]),
      ),
    );
  }

  Widget _header() {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: Row(children: [
        const AdBackButton(),
        const SizedBox(width: 4),
        ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 40),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Chat with Ava', style: ADText.threadName(c: AD.textPrimary)),
            Text(_showArchived ? 'Archived chats' : 'Your conversations', style: ADText.preview()),
          ]),
        ),
        if (!_showArchived)
          IconButton(
            tooltip: 'Discuss a chat',
            icon: PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
                color: AD.textSecondary, size: 22),
            onPressed: _discussAChat,
          ),
        IconButton(
          tooltip: _showArchived ? 'Back to chats' : 'Archived',
          icon: PhosphorIcon(
              _showArchived ? PhosphorIcons.chatsCircle(PhosphorIconsStyle.bold) : PhosphorIcons.archive(PhosphorIconsStyle.bold),
              color: AD.textSecondary, size: 22),
          onPressed: () {
            setState(() {
              _showArchived = !_showArchived;
              _loading = true;
            });
            _loadSessions();
          },
        ),
      ]),
    );
  }

  Widget _loadingState() => const Center(
      child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch)));

  Widget _emptyState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineIconBadge(
              icon: PhosphorIcons.chatTeardropDots(PhosphorIconsStyle.fill),
              color: AD.iconVideo, size: 54),
          const SizedBox(height: 14),
          Text(_showArchived ? 'No archived chats' : 'No chats yet',
              style: ADText.threadName(c: AD.textPrimary), textAlign: TextAlign.center),
          const SizedBox(height: 6),
          Text(
            _showArchived
                ? 'Chats you archive will show up here.'
                : 'Start a conversation with Ava — vent, brainstorm, practise a language, or more. Your chats save automatically.',
            style: ADText.preview(), textAlign: TextAlign.center,
          ),
          if (!_showArchived) ...[
            const SizedBox(height: 18),
            AdButton(
              label: 'Start a chat',
              variant: AdButtonVariant.primary,
              fontSize: 15,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              onPressed: _newChat,
            ),
          ],
        ]),
      ),
    );
  }

  Widget _sessionList() {
    return ReorderableListView.builder(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 96),
      itemCount: _sessions.length,
      buildDefaultDragHandles: false, // long-press opens the menu; drag uses the handle
      onReorder: _showArchived ? (_, __) {} : _onReorder,
      itemBuilder: (context, i) {
        final s = _sessions[i];
        return Padding(
          key: ValueKey(s.id),
          padding: const EdgeInsets.only(bottom: 10),
          child: _SessionCard(
            session: s,
            index: i,
            reorderable: !_showArchived,
            onTap: () => _openSession(s),
            onLongPress: () => _showSessionMenu(s),
            onMenu: () => _showSessionMenu(s),
            onStar: () async {
              await CompanionSessionStore.I.setStar(s.id, !s.starred);
              Analytics.capture('avachat_session_starred', {'starred': !s.starred});
              await _loadSessions();
            },
          ),
        );
      },
    );
  }
}

/// One session row — auto-titled card with a star toggle, a drag handle, and a
/// 3-dot menu. Long-pressing the card body opens the same menu.
class _SessionCard extends StatelessWidget {
  final CompanionSession session;
  final int index;
  final bool reorderable;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  final VoidCallback onMenu;
  final VoidCallback onStar;
  const _SessionCard({
    required this.session,
    required this.index,
    required this.reorderable,
    required this.onTap,
    required this.onLongPress,
    required this.onMenu,
    required this.onStar,
  });

  @override
  Widget build(BuildContext context) {
    final p = AvaPersonas.byId(session.persona);
    final title = session.title.trim().isEmpty ? 'New chat' : session.title.trim();
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      behavior: HitTestBehavior.opaque,
      child: AdCard(
        radius: AD.rListCard,
        padding: const EdgeInsets.fromLTRB(12, 12, 6, 12),
        child: Row(children: [
        Container(
          width: 44, height: 44, alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AD.iconVideo,
            borderRadius: BorderRadius.circular(AD.rBadge),
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Text(p.glyph, style: const TextStyle(fontSize: 20)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              if (session.starred) ...[
                PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill), size: 14, color: AD.iconSearch),
                const SizedBox(width: 4),
              ],
              Flexible(child: Text(title, style: ADText.rowName(), maxLines: 1, overflow: TextOverflow.ellipsis)),
            ]),
            const SizedBox(height: 3),
            Text(
              session.preview.isEmpty ? '${p.name} · tap to continue' : session.preview,
              style: ADText.preview(), maxLines: 1, overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 3),
            Text('${p.name} · ${_ago(session.updatedAt)}', style: ADText.statCaption(c: AD.textTertiary)),
          ]),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: session.starred ? 'Unstar' : 'Star',
          icon: PhosphorIcon(
              session.starred ? PhosphorIcons.star(PhosphorIconsStyle.fill) : PhosphorIcons.star(PhosphorIconsStyle.bold),
              size: 18, color: session.starred ? AD.iconSearch : AD.textTertiary),
          onPressed: onStar,
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: 'More',
          icon: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 20, color: AD.textSecondary),
          onPressed: onMenu,
        ),
        if (reorderable)
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(left: 2, right: 4),
              child: PhosphorIcon(PhosphorIcons.dotsSixVertical(PhosphorIconsStyle.bold), size: 20, color: AD.textTertiary),
            ),
          ),
        ]),
      ),
    );
  }

  static String _ago(int ms) {
    if (ms <= 0) return 'just now';
    final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes}m ago';
    if (d.inHours < 24) return '${d.inHours}h ago';
    if (d.inDays < 7) return '${d.inDays}d ago';
    final weeks = (d.inDays / 7).floor();
    if (weeks < 5) return '${weeks}w ago';
    final months = (d.inDays / 30).floor();
    return months < 12 ? '${months}mo ago' : '${(d.inDays / 365).floor()}y ago';
  }
}

class _PersonaTile extends StatelessWidget {
  final AvaPersona persona;
  final bool locked;
  final bool loading;
  final VoidCallback onTap;
  const _PersonaTile({
    required this.persona,
    required this.locked,
    required this.loading,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return AdCard(
      radius: AD.rListCard,
      padding: const EdgeInsets.all(14),
      onTap: onTap,
      child: Row(children: [
        Container(
          width: 46, height: 46, alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AD.iconVideo,
            borderRadius: BorderRadius.circular(AD.rBadge),
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Text(persona.glyph, style: const TextStyle(fontSize: 22)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(persona.name, style: ADText.rowName())),
              if (persona.adultOnly) ...[
                const SizedBox(width: 8),
                _AdultChip(locked: locked),
              ],
            ]),
            const SizedBox(height: 2),
            Text(persona.tagline, style: ADText.preview()),
          ]),
        ),
        const SizedBox(width: 6),
        if (loading)
          const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch))
        else
          PhosphorIcon(
              locked ? PhosphorIcons.lock(PhosphorIconsStyle.bold) : PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
              size: 18, color: locked ? AD.textTertiary : AD.textSecondary),
      ]),
    );
  }
}

class _AdultChip extends StatelessWidget {
  final bool locked;
  const _AdultChip({required this.locked});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(
          color: locked ? AD.card : AD.online,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Text('18+', style: ADText.statCaption(c: locked ? AD.textSecondary : Colors.white)),
      );
}
