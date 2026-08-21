import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/ava_ai_client.dart';
import '../../core/ava_log.dart';
import '../../core/brain_consent.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/rajasthani_motifs.dart';
import '../../core/ui/zine_widgets.dart';
import '../ava_companion/companion_session_store.dart';
import '../avadial/block_list.dart';
import 'askava_tools.dart';

/// [UI-BRAIN-2026] Persona tag AvaBrain sessions are stored under in the shared
/// [CompanionSessionStore]. AvaBrain (tool-calling) and AvaChat (persona
/// companion) share ONE per-account local store + D1 backup, but each surface
/// lists only its own sessions so a transcript always reopens in the engine
/// that produced it.
const String kAskAvaPersonaId = 'askava';

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
/// to any AvaBrain ingestion lane and are not persisted beyond the visible
/// thread. Actions (dial/block/report_spam) NEVER auto-run — they render a
/// confirmation chip the user must tap.
/// [UI-BRAIN-2026] AvaBrain LANDING — the session list, not a chat.
///
/// The owner's complaint was that opening AvaBrain dropped straight into a
/// thread with no way back to earlier conversations. This screen is the list:
/// every past AvaBrain session with rename / archive / delete, plus "New chat".
/// Tapping a row opens [AskAvaThreadScreen] on its historic transcript.
///
/// Storage is NOT new. It reuses [CompanionSessionStore] — the existing
/// per-account SQLite table (`ava_chat_sessions` inside `avatok_<scope>.sqlite`,
/// so scoping is automatic) with best-effort D1 backup — tagged with the
/// [kAskAvaPersonaId] persona so AvaBrain and AvaChat keep separate lists.
class AskAvaScreen extends StatefulWidget {
  /// Which app opened the assistant ('root' | 'avadial' | 'avatalk' | 'services'),
  /// used to prime the preamble with that context (plan §4.6).
  final String contextHint;
  const AskAvaScreen({super.key, this.contextHint = 'root'});

  @override
  State<AskAvaScreen> createState() => _AskAvaHomeState();
}

class _AskAvaHomeState extends State<AskAvaScreen> {
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// Legacy single-thread key (pre-[UI-BRAIN-2026]). Migrated once into a real
  /// session so the owner does not lose the conversation he already had.
  static const _legacyThreadKey = 'askava_thread_v1';

  List<CompanionSession> _sessions = const [];
  bool _loading = true;
  bool _showArchived = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'avabrain_sessions');
    Analytics.capture('askava_opened', {'source': widget.contextHint});
    _boot();
  }

  Future<void> _boot() async {
    final t0 = DateTime.now();
    await _migrateLegacyThread();
    await _load(initial: true);
    Analytics.uiInteraction('avabrain_sessions_list',
        DateTime.now().difference(t0).inMilliseconds,
        extra: {'count': _sessions.length});
  }

  /// One-time move of the old flat `askava_thread_v1` blob into a session row.
  /// Best-effort: a failure here must never block the list from rendering.
  Future<void> _migrateLegacyThread() async {
    try {
      final raw = await readScoped(_ss, _legacyThreadKey);
      if (raw == null || raw.trim().isEmpty) return;
      final list = jsonDecode(raw);
      if (list is! List || list.isEmpty) {
        await _ss.delete(key: scopedKey(_legacyThreadKey));
        return;
      }
      final msgs = <Map<String, String>>[];
      for (final e in list) {
        if (e is! Map) continue;
        final role = (e['r'] ?? '').toString();
        final text = (e['t'] ?? '').toString();
        if (text.isEmpty) continue;
        // Legacy roles were user/assistant; the shared store speaks user/ava.
        msgs.add({'role': role == 'user' ? 'user' : 'ava', 'text': text});
      }
      if (msgs.isNotEmpty) {
        await CompanionSessionStore.I.upsert(
          sessionId: 'askava_legacy_v1',
          persona: kAskAvaPersonaId,
          title: 'Earlier AvaBrain chat',
          messages: msgs,
        );
        Analytics.capture('avabrain_legacy_thread_migrated', {'turns': msgs.length});
      }
      await _ss.delete(key: scopedKey(_legacyThreadKey));
    } catch (e, st) {
      AvaLog.I.log('askava', 'legacy thread migration failed: $e');
      Analytics.captureException(e, st,
          screen: 'avabrain_sessions', handled: true,
          extra: const {'stage': 'legacy_migration'});
    }
  }

  Future<void> _load({bool initial = false}) async {
    try {
      final local = await CompanionSessionStore.I.list(archived: _showArchived);
      if (mounted) {
        setState(() {
          _sessions = _mine(local);
          _loading = false;
        });
      }
      if (initial) {
        await CompanionSessionStore.I.syncFromCloud();
        final merged = await CompanionSessionStore.I.list(archived: _showArchived);
        if (mounted) setState(() => _sessions = _mine(merged));
      }
    } catch (e, st) {
      if (mounted) setState(() => _loading = false);
      AvaLog.I.log('askava', 'session list failed: $e');
      Analytics.captureException(e, st,
          screen: 'avabrain_sessions', handled: true,
          extra: const {'stage': 'list'});
    }
  }

  List<CompanionSession> _mine(List<CompanionSession> all) =>
      all.where((s) => s.persona == kAskAvaPersonaId).toList(growable: false);

  Future<void> _openSession(CompanionSession s) async {
    final t0 = DateTime.now();
    List<Map<String, String>> msgs = const [];
    try {
      msgs = await CompanionSessionStore.I.messages(s.id);
    } catch (e, st) {
      AvaLog.I.log('askava', 'transcript load failed: $e');
      Analytics.captureException(e, st,
          screen: 'avabrain_sessions', handled: true,
          extra: const {'stage': 'open_session'});
    }
    if (!mounted) return;
    Analytics.uiInteraction('avabrain_session_opened',
        DateTime.now().difference(t0).inMilliseconds,
        extra: {'turns': msgs.length});
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => AskAvaThreadScreen(
          contextHint: widget.contextHint,
          sessionId: s.id,
          initialTitle: s.title,
          initialMessages: msgs,
        ),
      ),
    );
    await _load();
  }

  Future<void> _newChat() async {
    Analytics.capture('avabrain_new_session_tapped', const {});
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => AskAvaThreadScreen(contextHint: widget.contextHint),
      ),
    );
    await _load();
  }

  // ── per-session actions ────────────────────────────────────────────────────

  Future<void> _sessionMenu(CompanionSession s) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderHairline, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s2, Msg.s5, Msg.s2),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(s.title.isEmpty ? 'AvaBrain chat' : s.title,
                  style: ADText.threadName(),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ),
          _menuRow(ctx, 'rename', PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Rename'),
          _menuRow(ctx, 'archive', PhosphorIcons.archive(PhosphorIconsStyle.bold),
              s.archived ? 'Unarchive' : 'Archive'),
          _menuRow(ctx, 'delete', PhosphorIcons.trash(PhosphorIconsStyle.bold), 'Delete',
              danger: true),
          const SizedBox(height: Msg.s2),
        ]),
      ),
    );
    if (action == null || !mounted) return;
    try {
      switch (action) {
        case 'rename':
          await _rename(s);
          break;
        case 'archive':
          await CompanionSessionStore.I.setArchived(s.id, !s.archived);
          Analytics.capture('avabrain_session_archived', {'archived': !s.archived});
          break;
        case 'delete':
          await _delete(s);
          break;
      }
    } catch (e, st) {
      AvaLog.I.log('askava', 'session action "$action" failed: $e');
      Analytics.captureException(e, st,
          screen: 'avabrain_sessions', handled: true, extra: {'action': action});
    }
    await _load();
  }

  Widget _menuRow(BuildContext ctx, String value, IconData icon, String label,
      {bool danger = false}) {
    return ListTile(
      leading: PhosphorIcon(icon, size: 20, color: danger ? AD.danger : AD.textSecondary),
      title: Text(label, style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
      onTap: () => Navigator.pop(ctx, value),
    );
  }

  Future<void> _rename(CompanionSession s) async {
    final ctrl = TextEditingController(text: s.title);
    final newTitle = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Rename chat', style: ADText.threadName()),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 80,
          cursorColor: AD.iconSearch,
          style: TextStyle(
              fontFamily: ADText.family, fontWeight: FontWeight.w700,
              fontSize: 15, color: AD.textOnInput),
          decoration: InputDecoration(
            hintText: 'Chat name',
            hintStyle: ADText.preview(c: AD.textTertiary),
          ),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text('Cancel', style: ADText.preview(c: AD.textSecondary))),
          TextButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: Text('Save', style: ADText.preview(c: AD.iconSearch))),
        ],
      ),
    );
    if (newTitle != null && newTitle.isNotEmpty) {
      await CompanionSessionStore.I.rename(s.id, newTitle);
      Analytics.capture('avabrain_session_renamed', const {});
    }
  }

  Future<void> _delete(CompanionSession s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Delete chat?', style: ADText.threadName()),
        content: Text(
            'This removes the conversation from this device and the cloud '
            'backup. This can’t be undone.',
            style: ADText.preview()),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text('Cancel', style: ADText.preview(c: AD.textSecondary))),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text('Delete', style: ADText.preview(c: AD.danger))),
        ],
      ),
    );
    if (ok == true) {
      await CompanionSessionStore.I.delete(s.id);
      Analytics.capture('avabrain_session_deleted', const {});
    }
  }

  // ── build ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    const band = AD.bandRani;
    final onBand = AD.onBand(band);
    return Scaffold(
      backgroundColor: AD.bg,
      floatingActionButton: _showArchived
          ? null
          : FloatingActionButton.extended(
              onPressed: _newChat,
              backgroundColor: AD.primaryBadge,
              foregroundColor: AD.sendActiveInk,
              shape: RoundedRectangleBorder(borderRadius: Msg.brPill),
              icon: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold),
                  color: AD.sendActiveInk),
              label: Text('New chat', style: ADText.rowName(c: AD.sendActiveInk)),
            ),
      body: SafeArea(
        child: Column(children: [
          // Header band + decorative seam overlay (same Stack pattern as
          // CompanionHome) so the seam never becomes a layout sibling that
          // leaves a blank strip.
          Stack(clipBehavior: Clip.none, children: [
            Column(mainAxisSize: MainAxisSize.min, children: [
              _header(band, onBand),
              const SizedBox(height: 15),
            ]),
            const Positioned(left: 0, right: 0, bottom: 0, child: FlowerChainSeam()),
          ]),
          Expanded(
            child: _loading
                ? const Center(
                    child: SizedBox(
                        width: 22, height: 22,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: AD.iconSearch)))
                : (_sessions.isEmpty ? _emptyState() : _list()),
          ),
        ]),
      ),
    );
  }

  Widget _header(Color band, Color onBand) {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
      decoration: BoxDecoration(
        color: band,
        border: const Border(bottom: BorderSide(color: AD.borderHairline, width: 3)),
      ),
      child: Row(children: [
        AdBackButton(color: onBand),
        const SizedBox(width: 4),
        ZineIconBadge(
            icon: PhosphorIcons.brain(PhosphorIconsStyle.fill),
            color: AD.iconVideo, size: 38),
        const SizedBox(width: Msg.s2),
        // Short, responsive title: Expanded + ellipsis so the trailing controls
        // can never be pushed off-screen on a narrow phone.
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('AvaBrain',
                style: ADText.appTitle(c: onBand),
                maxLines: 1, overflow: TextOverflow.ellipsis, softWrap: false),
            Text(_showArchived ? 'Archived' : 'Your AvaTOK assistant',
                style: ADText.preview(c: onBand),
                maxLines: 1, overflow: TextOverflow.ellipsis, softWrap: false),
          ]),
        ),
        IconButton(
          tooltip: _showArchived ? 'Back to chats' : 'Archived',
          icon: PhosphorIcon(
              _showArchived
                  ? PhosphorIcons.chatsCircle(PhosphorIconsStyle.bold)
                  : PhosphorIcons.archive(PhosphorIconsStyle.bold),
              color: onBand, size: 22),
          onPressed: () {
            setState(() {
              _showArchived = !_showArchived;
              _loading = true;
            });
            _load();
          },
        ),
      ]),
    );
  }

  Widget _emptyState() => Center(
        child: Padding(
          padding: const EdgeInsets.all(Msg.s6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineIconBadge(
                icon: PhosphorIcons.brain(PhosphorIconsStyle.fill),
                color: AD.iconVideo, size: 54),
            const SizedBox(height: Msg.s3),
            Text(_showArchived ? 'No archived chats' : 'Ask me anything',
                style: ADText.threadName(), textAlign: TextAlign.center),
            const SizedBox(height: Msg.s1),
            Text(
              _showArchived
                  ? 'Chats you archive will show up here.'
                  : '"Call the plumber from last Tuesday", "who called me most '
                      'this month?", "is +1 555 0100 spam?"',
              style: ADText.preview(), textAlign: TextAlign.center,
            ),
            if (!_showArchived) ...[
              const SizedBox(height: Msg.s4),
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

  Widget _list() => ListView.builder(
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, 96),
        itemCount: _sessions.length,
        itemBuilder: (context, i) {
          final s = _sessions[i];
          return Padding(
            key: ValueKey(s.id),
            padding: const EdgeInsets.only(bottom: Msg.s3),
            child: _AskAvaSessionCard(
              session: s,
              onTap: () => _openSession(s),
              onMenu: () => _sessionMenu(s),
            ),
          );
        },
      );
}

/// One AvaBrain session row — title, preview, age, and a 3-dot menu
/// (rename / archive / delete). Long-press opens the same menu.
class _AskAvaSessionCard extends StatelessWidget {
  final CompanionSession session;
  final VoidCallback onTap;
  final VoidCallback onMenu;
  const _AskAvaSessionCard({
    required this.session,
    required this.onTap,
    required this.onMenu,
  });

  @override
  Widget build(BuildContext context) {
    final title = session.title.trim().isEmpty ? 'New chat' : session.title.trim();
    return GestureDetector(
      onTap: onTap,
      onLongPress: onMenu,
      behavior: HitTestBehavior.opaque,
      child: AdCard(
        radius: AD.rListCard,
        padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s3, Msg.s2, Msg.s3),
        child: Row(children: [
          Container(
            width: 44, height: 44, alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AD.haldi,
              borderRadius: BorderRadius.circular(AD.rBadge),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: PhosphorIcon(PhosphorIcons.brain(PhosphorIconsStyle.fill),
                size: 22, color: AD.onBand(AD.haldi)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.rowName(),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
              const SizedBox(height: Msg.s1),
              Text(
                session.preview.isEmpty ? 'Tap to continue' : session.preview,
                style: ADText.preview(), maxLines: 1, overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: Msg.s1),
              Text(_ago(session.updatedAt),
                  style: ADText.statCaption(c: AD.textTertiary)),
            ]),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: 'More',
            icon: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold),
                size: 20, color: AD.textSecondary),
            onPressed: onMenu,
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

/// The AvaBrain CHAT — one session's transcript plus the tool-calling loop.
/// Reached from [AskAvaScreen]; never the app's landing surface.
class AskAvaThreadScreen extends StatefulWidget {
  /// Which app opened the assistant ('root' | 'avadial' | 'avatalk' | 'services'),
  /// used to prime the preamble with that context (plan §4.6).
  final String contextHint;

  /// Existing session to resume; null starts a fresh one.
  final String? sessionId;
  final String? initialTitle;

  /// Transcript to seed when resuming — `[{role:'user'|'ava', text}]`.
  final List<Map<String, String>>? initialMessages;

  const AskAvaThreadScreen({
    super.key,
    this.contextHint = 'root',
    this.sessionId,
    this.initialTitle,
    this.initialMessages,
  });

  @override
  State<AskAvaThreadScreen> createState() => _AskAvaScreenState();
}

enum _Role { user, assistant, action }

class _Turn {
  final _Role role;
  String text;
  List<AskAvaContact> contacts; // assistant → Call/Message chips
  final String? actionTool; // 'dial' | 'block' | 'report_spam'
  final String? actionArg; // the number
  _Turn(this.role, this.text, {this.contacts = const [], this.actionTool, this.actionArg});
}

class _AskAvaScreenState extends State<AskAvaThreadScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _turns = <_Turn>[];
  bool _busy = false;
  bool _streamStarted = false;

  static const _maxHops = 3;

  /// [UI-BRAIN-2026] This thread's row in the shared per-account session store.
  /// A resumed session keeps its id; a new one gets a fresh id.
  late final String _sessionId =
      widget.sessionId ?? 'askava_${DateTime.now().millisecondsSinceEpoch}';

  /// Auto-named title — seeds from a resumed (possibly renamed) title,
  /// otherwise derived from the first user message.
  String _title = '';

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'avabrain_thread');
    _title = (widget.initialTitle ?? '').trim();
    final seed = widget.initialMessages ?? const [];
    for (final m in seed) {
      final text = (m['text'] ?? '').toString();
      if (text.isEmpty) continue;
      final role = (m['role'] ?? '').toString();
      _turns.add(_Turn(role == 'user' ? _Role.user : _Role.assistant, text));
    }
    if (_turns.isNotEmpty) {
      Analytics.capture('avabrain_session_resumed', {'turns': _turns.length});
      _jumpToEnd();
    }
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// Persist the transcript through [CompanionSessionStore] (per-account SQLite
  /// + best-effort D1 backup). Action chips are ephemeral and never saved.
  Future<void> _saveThread() async {
    final msgs = <Map<String, String>>[
      for (final t in _turns)
        if (t.role != _Role.action)
          {'role': t.role == _Role.user ? 'user' : 'ava', 'text': t.text},
    ];
    if (msgs.isEmpty) return;
    if (_title.isEmpty) {
      final firstUser = msgs.firstWhere((m) => m['role'] == 'user',
          orElse: () => const <String, String>{});
      final t = (firstUser['text'] ?? '').trim();
      if (t.isNotEmpty) _title = t.length > 48 ? '${t.substring(0, 48)}…' : t;
    }
    try {
      await CompanionSessionStore.I.upsert(
        sessionId: _sessionId,
        persona: kAskAvaPersonaId,
        title: _title,
        messages: msgs,
      );
    } catch (e, st) {
      AvaLog.I.log('askava', 'session save failed: $e');
      Analytics.captureException(e, st,
          screen: 'avabrain_thread', handled: true,
          extra: const {'stage': 'save'});
    }
  }

  void _jumpToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: Msg.base, curve: Curves.easeOutCubic);
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
        final replyBuffer = StringBuffer();
        _Turn? streamedTurn;
        var prefixDecided = false;
        var hideAsPossibleToolCall = false;
        await for (final delta in AvaAiClient.I.askStream(
          message: pending,
          context: _preamble(toolsAllowed),
          history: history,
          source: 'askava',
        )) {
          replyBuffer.write(delta);
          final partial = replyBuffer.toString();
          if (!prefixDecided && partial.trim().isNotEmpty) {
            prefixDecided = true;
            // Tool calls are an internal client/server protocol. Hold JSON
            // responses until complete so they never flash in the chat bubble.
            hideAsPossibleToolCall = partial.trimLeft().startsWith('{');
          }
          if (!hideAsPossibleToolCall && partial.isNotEmpty && mounted) {
            setState(() {
              if (streamedTurn == null) {
                streamedTurn = _Turn(_Role.assistant, partial);
                _turns.add(streamedTurn!);
                _streamStarted = true;
              } else {
                streamedTurn!.text = partial;
              }
            });
            _jumpToEnd();
          }
        }
        final reply = replyBuffer.toString().trim();

        final call = _parseToolCall(reply);
        if (call == null) {
          if (streamedTurn != null) {
            setState(() {
              streamedTurn!.text =
                  reply.isEmpty ? 'Sorry, I could not find an answer.' : reply;
              streamedTurn!.contacts = finalContacts;
            });
            finalText = null; // the live bubble is already in the thread
          } else {
            finalText = reply.isEmpty ? 'Sorry, I could not find an answer.' : reply;
          }
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
          // Record the model's tool-call turn; the tool result rides the NEXT
          // message (ask() appends it as the newest user turn) — don't double-add.
          history.add({'role': 'model', 'text': reply});
          pending = res.summaryForModel;
          continue;
        }

        // Unknown tool name → just surface the raw reply.
        finalText = reply;
        break;
      }
    } catch (_) {
      finalText = _streamStarted
          ? null
          : 'Ava could not be reached. Please try again.';
    }

    if (finalText != null) {
      final ft = finalText;
      setState(() => _turns.add(_Turn(_Role.assistant, ft, contacts: finalContacts)));
    }
    setState(() {
      _busy = false;
      _streamStarted = false;
    });
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

  /// Empty this conversation. The session row itself is kept (delete it from the
  /// AvaBrain list) so the user can keep typing in the same thread.
  Future<void> _clearThread() async {
    setState(() => _turns.clear());
    Analytics.capture('avabrain_thread_cleared', const {});
    try {
      await CompanionSessionStore.I.upsert(
        sessionId: _sessionId,
        persona: kAskAvaPersonaId,
        title: _title,
        messages: const [],
      );
    } catch (e, st) {
      AvaLog.I.log('askava', 'thread clear failed: $e');
      Analytics.captureException(e, st,
          screen: 'avabrain_thread', handled: true,
          extra: const {'stage': 'clear'});
    }
  }

  /// [UI-BRAIN-2026] Ava's accent badge. Was a raw green literal; now the haldi
  /// token with its documented on-band ink so it reads on paper AND on a band.
  Widget _sparkleBadge(double size) => Container(
        width: size, height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AD.haldi,
          borderRadius: BorderRadius.circular(size * 0.28),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
            size: size * 0.55, color: AD.onBand(AD.haldi)),
      );

  @override
  Widget build(BuildContext context) {
    // [UI-BRAIN-2026] The header band is DARK (rani), so every foreground on it
    // goes through AD.onBand — the previous ink-on-indigo title and icons were
    // very nearly invisible.
    const band = AD.bandRani;
    final onBand = AD.onBand(band);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: band,
        surfaceTintColor: Colors.transparent,
        foregroundColor: onBand,
        iconTheme: IconThemeData(color: onBand),
        elevation: 0,
        titleSpacing: 0,
        shape: const Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        title: Row(children: [
          _sparkleBadge(30),
          const SizedBox(width: Msg.s2),
          // Short, responsive title: ellipsizes before the trailing control
          // can be pushed off a narrow screen.
          Expanded(
            child: Text(_title.isEmpty ? 'AvaBrain' : _title,
                style: ADText.appTitle(c: onBand),
                maxLines: 1, overflow: TextOverflow.ellipsis, softWrap: false),
          ),
        ]),
        actions: [
          if (_turns.isNotEmpty)
            IconButton(
              tooltip: 'Clear',
              icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold),
                  color: onBand, size: 20),
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
                    itemCount: _turns.length + (_busy && !_streamStarted ? 1 : 0),
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
            _sparkleBadge(54),
            const SizedBox(height: Msg.s3),
            Text('Ask me anything', textAlign: TextAlign.center, style: ADText.threadName().copyWith(fontSize: 18)),
            const SizedBox(height: 8),
            Text(
              '"Call the plumber from last Tuesday", "who called me most this month?", '
              '"is +1 555 0100 spam?"',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary),
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
        margin: const EdgeInsets.symmetric(vertical: Msg.s2),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
        decoration: BoxDecoration(
          color: mine ? AD.bubbleOutBg : AD.card,
          borderRadius: mine ? AD.bubbleOutRadius : AD.bubbleInRadius,
          border: mine ? null : Border.all(color: AD.borderControl, width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(t.text, style: ADText.bubbleBody(c: mine ? AD.bubbleOutInk : AD.textPrimary)),
          if (t.contacts.isNotEmpty) ...[
            const SizedBox(height: Msg.s2),
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
      return [_chip('Message ${_short(c.name)}', PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.online,
          () => _notice('Open AvaTalk to message ${c.name}.'))];
    }
    return [
      _chip('Call ${_short(c.name)}', PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch,
          () => _confirmAction('dial', c.number)),
    ];
  }

  String _short(String s) => s.length > 14 ? '${s.substring(0, 14)}…' : s;

  Widget _actionChip(_Turn t) {
    final color = switch (t.actionTool) {
      'dial' => AD.iconSearch,
      'block' => AD.danger,
      'report_spam' => AD.danger,
      _ => AD.online,
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
        margin: const EdgeInsets.symmetric(vertical: Msg.s2),
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(t.text, style: ADText.rowName()),
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
        padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
        decoration: BoxDecoration(
          color: color,
          borderRadius: Msg.brPill,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[PhosphorIcon(icon, size: 14, color: Colors.white), const SizedBox(width: Msg.s1)],
          Text(label, style: ADText.statCaption(c: Colors.white)),
        ]),
      ),
    );
  }

  Widget _typing() => Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: Msg.s2),
          padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: AD.bubbleInRadius,
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Text('Ava is thinking…', style: ADText.preview(c: AD.textSecondary)),
        ),
      );

  Widget _composer() {
    // [UI-BRAIN-2026] The composer sits ABOVE the footer band on WARM PAPER, not
    // on the indigo footer. Its own icons are ink tokens, so they stay visible;
    // ink controls on the old indigo fill were effectively invisible.
    return Container(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AD.borderHairline, width: 2)),
        color: AD.card,
      ),
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s3),
      child: Row(children: [
        Expanded(
          // Input box stays WHITE (owner request 2026-07-13, pic 3).
          child: Container(
            decoration: BoxDecoration(
              color: AD.inputField,
              borderRadius: BorderRadius.circular(AD.rInput),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
            child: TextField(
              controller: _input,
              minLines: 1,
              maxLines: 4,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _send(),
              cursorColor: AD.iconSearch,
              style: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                  fontSize: 15, color: AD.textOnInput),
              decoration: const InputDecoration(
                border: InputBorder.none,
                hintText: 'Ask Ava…',
                hintStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                    fontSize: 15, color: AD.placeholderOnWhite),
                isDense: true,
                contentPadding: EdgeInsets.symmetric(vertical: 12),
              ),
            ),
          ),
        ),
        const SizedBox(width: Msg.s2),
        GestureDetector(
          onTap: _busy ? null : _send,
          child: Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: _busy ? AD.cardHover : AD.sendActiveBg,
              borderRadius: BorderRadius.circular(AD.rInput),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: PhosphorIcon(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                color: _busy ? AD.textTertiary : AD.sendActiveInk, size: 20),
          ),
        ),
      ]),
    );
  }
}
