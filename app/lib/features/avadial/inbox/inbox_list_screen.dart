import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../shell/v2/shell_chrome.dart';
import '../avadial_theme.dart';
import '../device_contacts.dart';
import 'inbox_api.dart';
import 'inbox_thread_screen.dart';

/// AvaDial Inbox — the Ava Receptionist / voicemail thread list (Specs/PLAN-
/// 2026-07-16-ava-receptionist-guardian-FINAL.md, Owner-locked scope item 2,
/// Phase 3 AVA-RCPT-8). One row per caller number: contact-matched display
/// name (falls back to a formatted number, or "Hidden number" for an
/// anonymous-caller thread), last-message time, and an unread dot. Entry
/// point wired in shell/v2/avadial_root.dart, gated on
/// RemoteConfig.pstnVoicemail — this screen itself has no flag check because
/// the tab that pushes it already does.
class InboxListScreen extends StatefulWidget {
  /// True (the default) when this screen is hosted as a TAB BODY inside
  /// another Scaffold — e.g. AvaDial root's own IndexedStack (exactly like
  /// `_LogsTab`/`_BlockTab`) — so it renders no Scaffold/AppBar of its own.
  /// Pass `false` when this screen IS the top-level surface — the main-shell
  /// footer's own "Inbox" slot (shell/v2/app_switcher_bar.dart) pushes it as a
  /// full-screen route with no parent AvaDial Scaffold around it, so it needs
  /// to own its own Scaffold + AppBar in that case.
  final bool embedded;
  const InboxListScreen({super.key, this.embedded = true});

  @override
  State<InboxListScreen> createState() => _InboxListScreenState();
}

class _InboxListScreenState extends State<InboxListScreen> {
  late Future<List<InboxThread>> _future;

  // [INBOX-SEARCH-1] Client-side filter over the already-loaded threads —
  // matches caller display name, PSTN number, and transcript text. Instant
  // (no debounce), same idiom as AdSearchDock's other call sites.
  final _searchCtrl = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    // Best-effort warm of the contact-name index so the FIRST paint already
    // resolves known callers instead of flashing raw numbers then relabeling.
    DeviceContacts.I.load();
    _future = InboxApi.threads();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    final f = InboxApi.threads();
    setState(() => _future = f);
    await f;
  }

  /// Filters [threads] by caller display name, PSTN number, or any card's
  /// transcript text (case-insensitive substring match).
  List<InboxThread> _filtered(List<InboxThread> threads) {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return threads;
    return threads.where((t) {
      final label = _labelFor(t);
      if (label.title.toLowerCase().contains(q)) return true;
      if (label.subtitleNumber != null && label.subtitleNumber!.toLowerCase().contains(q)) {
        return true;
      }
      final phone = t.telPhone;
      if (phone != null && phone.toLowerCase().contains(q)) return true;
      for (final c in t.cards) {
        if ((c.transcript ?? '').toLowerCase().contains(q)) return true;
        if ((c.summaryText ?? '').toLowerCase().contains(q)) return true;
        if ((c.callerPhone ?? '').toLowerCase().contains(q)) return true;
        if ((c.callerName ?? '').toLowerCase().contains(q)) return true;
      }
      return false;
    }).toList();
  }

  void _open(InboxThread t) {
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => InboxThreadScreen(thread: t)))
        .then((_) => _reload()); // pick up the read-state flip on return
  }

  // NOTE: when `embedded` (the default), this widget renders as ONE tab body
  // inside AvaDialRoot's own Scaffold/AppBar/tab-strip (shell/v2/avadial_root
  // .dart's IndexedStack) — exactly like `_LogsTab`/`_BlockTab` — so it has NO
  // Scaffold or AppBar of its own there (that would double the toolbar); the
  // tab strip already labels that section "Inbox". When NOT embedded (the
  // main-shell footer's own Inbox slot — shell/v2/app_switcher_bar.dart), this
  // screen is the top-level route and owns its own Scaffold + AppBar below.
  @override
  Widget build(BuildContext context) {
    final content = Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
        child: AdSearchDock(
          controller: _searchCtrl,
          hint: 'Search calls, numbers, transcripts',
          onChanged: (v) => setState(() => _query = v),
        ),
      ),
      Expanded(child: _list(context)),
    ]);
    if (!widget.embedded) {
      return Scaffold(
        backgroundColor: AvaDialTheme.bg,
        appBar: AppBar(
          backgroundColor: AvaDialTheme.surface,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          foregroundColor: AvaDialTheme.text,
          title: Text('Inbox', style: ADText.threadName(c: AvaDialTheme.text)),
          shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        ),
        body: SafeArea(child: content),
      );
    }
    return content;
  }

  Widget _list(BuildContext context) {
    return FutureBuilder<List<InboxThread>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
        }
        if (snap.hasError) return _errorState();
        final allThreads = snap.data ?? const <InboxThread>[];
        final threads = _filtered(allThreads);
        if (allThreads.isEmpty) {
          return RefreshIndicator(
            onRefresh: _reload,
            child: ListView(children: const [
              SizedBox(height: 100),
              ShellEmptyState(
                icon: Icons.voicemail_outlined,
                title: 'No messages yet',
                subtitle: 'Missed calls Ava answers for you will show up here.',
                color: AD.iconShield,
              ),
            ]),
          );
        }
        if (threads.isEmpty) {
          return RefreshIndicator(
            onRefresh: _reload,
            child: ListView(children: const [
              SizedBox(height: 100),
              ShellEmptyState(
                icon: Icons.search_off,
                title: 'No matches',
                subtitle: 'No calls match your search.',
                color: AD.iconSearch,
              ),
            ]),
          );
        }
        return RefreshIndicator(
          onRefresh: _reload,
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
            itemCount: threads.length,
            itemBuilder: (context, i) => Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: _row(threads[i]),
            ),
          ),
        );
      },
    );
  }

  Widget _errorState() => RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: const [
          SizedBox(height: 100),
          ShellEmptyState(
            icon: Icons.error_outline,
            title: 'Couldn’t load your Inbox',
            subtitle: 'Pull down to try again.',
            color: AD.danger,
          ),
        ]),
      );

  /// "Missed call from <name/number>" row content.
  ({String title, String? subtitleNumber}) _labelFor(InboxThread t) {
    if (t.isAnonymous) return (title: 'Hidden number', subtitleNumber: null);
    final phone = t.telPhone;
    if (phone != null) {
      final contact = DeviceContacts.I.lookup(phone);
      final name = contact?.name;
      if (name != null && name.trim().isNotEmpty) {
        return (title: name, subtitleNumber: _formatTel(phone));
      }
      return (title: _formatTel(phone), subtitleNumber: null);
    }
    // Business-call voicemail: `callerKey` is an AvaTOK uid, not a phone — the
    // card's own caller_name (server-composed) is the best label we have.
    final name = t.latest.callerName;
    return (title: (name != null && name.isNotEmpty) ? name : 'Unknown caller', subtitleNumber: null);
  }

  String _formatTel(String e164) => e164; // kept simple; the number is already E.164

  Widget _row(InboxThread t) {
    final label = _labelFor(t);
    final preview = t.latest.summaryText ??
        (t.latest.transcript != null && t.latest.transcript!.length > 60
            ? '${t.latest.transcript!.substring(0, 60)}…'
            : t.latest.transcript) ??
        'Left a message';
    return GestureDetector(
      onTap: () => _open(t),
      child: AdCard(
        color: AvaDialTheme.surface2,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(children: [
          ZineIconBadge(
            icon: PhosphorIcons.phoneIncoming(PhosphorIconsStyle.fill),
            color: AD.iconShield,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Missed call from ${label.title}',
                  style: ADText.threadName(c: AvaDialTheme.text),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 2),
              Text(preview,
                  style: ADText.preview(c: AvaDialTheme.textSoft),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ]),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(_relativeTime(t.latest.createdAtMs), style: ADText.statCaption(c: AvaDialTheme.textMute)),
            const SizedBox(height: 6),
            if (t.unread)
              Container(
                width: 9, height: 9,
                decoration: const BoxDecoration(color: AD.unreadAccent, shape: BoxShape.circle),
              ),
          ]),
        ]),
      ),
    );
  }

  String _relativeTime(int ms) {
    if (ms <= 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m';
    if (diff.inHours < 24) return '${diff.inHours}h';
    if (diff.inDays < 7) return '${diff.inDays}d';
    return '${dt.month}/${dt.day}/${dt.year % 100}';
  }
}
