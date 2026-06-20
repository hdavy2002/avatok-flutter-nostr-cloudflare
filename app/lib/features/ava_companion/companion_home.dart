import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
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
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lilac, size: 38),
              const SizedBox(width: 10),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('New chat with Ava', style: ZineText.cardTitle(size: 17)),
                Text('Pick how you want to talk', style: ZineText.sub(size: 12)),
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
              style: ZineText.sub(size: 12),
            ),
          ]),
        ),
      ),
    );
  }

  void _showAdultGate() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: Zine.lilac, size: 38),
              const SizedBox(width: 12),
              Expanded(child: Text('Adults only', style: ZineText.cardTitle(size: 18))),
            ]),
            const SizedBox(height: 12),
            Text(
              'Roleplay is limited to verified adults. Verify your identity in '
              'AvaIdentity (a quick liveness check) to unlock it. Everything stays '
              'safe and moderated either way.',
              style: ZineText.sub(size: 13.5),
            ),
            const SizedBox(height: 18),
            ZineButton(
              label: 'Verify in AvaIdentity',
              variant: ZineButtonVariant.blue,
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
              child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft)),
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(s.title.isEmpty ? 'Chat' : s.title,
                  style: ZineText.cardTitle(size: 15), maxLines: 1, overflow: TextOverflow.ellipsis),
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
      leading: PhosphorIcon(icon, size: 20, color: danger ? Zine.coral : Zine.ink),
      title: Text(label, style: ZineText.value(size: 14.5, weight: FontWeight.w600)
          .copyWith(color: danger ? Zine.coral : Zine.ink)),
      onTap: () => Navigator.pop(ctx, value),
    );
  }

  Future<void> _renameSession(CompanionSession s) async {
    final ctrl = TextEditingController(text: s.title);
    final newTitle = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.paper,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
            borderRadius: BorderRadius.circular(18)),
        title: Text('Rename chat', style: ZineText.cardTitle(size: 16)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 80,
          style: ZineText.input(size: 15),
          decoration: const InputDecoration(hintText: 'Chat name'),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          TextButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: Text('Save', style: ZineText.link(size: 14))),
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
        backgroundColor: Zine.paper,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
            borderRadius: BorderRadius.circular(18)),
        title: Text('Delete chat?', style: ZineText.cardTitle(size: 16)),
        content: Text('This removes the conversation from this device and the cloud backup. This can’t be undone.',
            style: ZineText.sub(size: 13.5)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text('Cancel', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text('Delete', style: ZineText.link(size: 14, color: Zine.coral))),
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
      backgroundColor: Zine.paper,
      floatingActionButton: _showArchived
          ? null
          : FloatingActionButton.extended(
              onPressed: _newChat,
              backgroundColor: Zine.lime,
              foregroundColor: Zine.ink,
              shape: RoundedRectangleBorder(
                  side: const BorderSide(color: Zine.ink, width: Zine.bw),
                  borderRadius: BorderRadius.circular(100)),
              icon: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), color: Zine.ink),
              label: Text('New chat', style: ZineText.value(size: 14.5, weight: FontWeight.w700)),
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
        color: Zine.paper2,
        border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: Row(children: [
        const ZineBackButton(),
        const SizedBox(width: 4),
        ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lilac, size: 40),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Chat with Ava', style: ZineText.cardTitle(size: 18)),
            Text(_showArchived ? 'Archived chats' : 'Your conversations', style: ZineText.sub(size: 12)),
          ]),
        ),
        IconButton(
          tooltip: _showArchived ? 'Back to chats' : 'Archived',
          icon: PhosphorIcon(
              _showArchived ? PhosphorIcons.chatsCircle(PhosphorIconsStyle.bold) : PhosphorIcons.archive(PhosphorIconsStyle.bold),
              color: Zine.ink, size: 22),
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
      child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk)));

  Widget _emptyState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineIconBadge(
              icon: PhosphorIcons.chatTeardropDots(PhosphorIconsStyle.fill),
              color: Zine.lilac, size: 54),
          const SizedBox(height: 14),
          Text(_showArchived ? 'No archived chats' : 'No chats yet',
              style: ZineText.cardTitle(size: 17), textAlign: TextAlign.center),
          const SizedBox(height: 6),
          Text(
            _showArchived
                ? 'Chats you archive will show up here.'
                : 'Start a conversation with Ava — vent, brainstorm, practise a language, or more. Your chats save automatically.',
            style: ZineText.sub(size: 13.5), textAlign: TextAlign.center,
          ),
          if (!_showArchived) ...[
            const SizedBox(height: 18),
            ZineButton(
              label: 'Start a chat',
              variant: ZineButtonVariant.lime,
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
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.fromLTRB(12, 12, 6, 12),
        child: Row(children: [
        Container(
          width: 44, height: 44, alignment: Alignment.center,
          decoration: BoxDecoration(
            color: Zine.lilac,
            borderRadius: BorderRadius.circular(Zine.rBadge),
            border: Zine.border,
          ),
          child: Text(p.glyph, style: const TextStyle(fontSize: 20)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              if (session.starred) ...[
                PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill), size: 14, color: Zine.blueInk),
                const SizedBox(width: 4),
              ],
              Flexible(child: Text(title, style: ZineText.value(size: 15), maxLines: 1, overflow: TextOverflow.ellipsis)),
            ]),
            const SizedBox(height: 3),
            Text(
              session.preview.isEmpty ? '${p.name} · tap to continue' : session.preview,
              style: ZineText.sub(size: 12.5), maxLines: 1, overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 3),
            Text('${p.name} · ${_ago(session.updatedAt)}', style: ZineText.tag(size: 10, color: Zine.inkSoft)),
          ]),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: session.starred ? 'Unstar' : 'Star',
          icon: PhosphorIcon(
              session.starred ? PhosphorIcons.star(PhosphorIconsStyle.fill) : PhosphorIcons.star(PhosphorIconsStyle.bold),
              size: 18, color: session.starred ? Zine.blueInk : Zine.inkMute),
          onPressed: onStar,
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: 'More',
          icon: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
          onPressed: onMenu,
        ),
        if (reorderable)
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(left: 2, right: 4),
              child: PhosphorIcon(PhosphorIcons.dotsSixVertical(PhosphorIconsStyle.bold), size: 20, color: Zine.inkMute),
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
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      onTap: onTap,
      child: Row(children: [
        Container(
          width: 46, height: 46, alignment: Alignment.center,
          decoration: BoxDecoration(
            color: Zine.lilac,
            borderRadius: BorderRadius.circular(Zine.rBadge),
            border: Zine.border,
          ),
          child: Text(persona.glyph, style: const TextStyle(fontSize: 22)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(persona.name, style: ZineText.value(size: 15.5))),
              if (persona.adultOnly) ...[
                const SizedBox(width: 8),
                _AdultChip(locked: locked),
              ],
            ]),
            const SizedBox(height: 2),
            Text(persona.tagline, style: ZineText.sub(size: 12.5)),
          ]),
        ),
        const SizedBox(width: 6),
        if (loading)
          const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))
        else
          PhosphorIcon(
              locked ? PhosphorIcons.lock(PhosphorIconsStyle.bold) : PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
              size: 18, color: locked ? Zine.inkMute : Zine.ink),
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
          color: locked ? Zine.paper2 : Zine.mint,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 2),
          boxShadow: Zine.shadowXs,
        ),
        child: Text('18+', style: ZineText.tag(size: 9.5, color: Zine.ink)),
      );
}
