import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
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
  const InboxListScreen({super.key});

  @override
  State<InboxListScreen> createState() => _InboxListScreenState();
}

class _InboxListScreenState extends State<InboxListScreen> {
  late Future<List<InboxThread>> _future;

  @override
  void initState() {
    super.initState();
    // Best-effort warm of the contact-name index so the FIRST paint already
    // resolves known callers instead of flashing raw numbers then relabeling.
    DeviceContacts.I.load();
    _future = InboxApi.threads();
  }

  Future<void> _reload() async {
    final f = InboxApi.threads();
    setState(() => _future = f);
    await f;
  }

  void _open(InboxThread t) {
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => InboxThreadScreen(thread: t)))
        .then((_) => _reload()); // pick up the read-state flip on return
  }

  // NOTE: this widget renders as ONE tab body inside AvaDialRoot's own
  // Scaffold/AppBar/tab-strip (shell/v2/avadial_root.dart's IndexedStack) —
  // exactly like `_LogsTab`/`_BlockTab` — so it deliberately has NO Scaffold
  // or AppBar of its own (that would double the toolbar). The tab strip
  // already labels this section "Inbox".
  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<InboxThread>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
        }
        if (snap.hasError) return _errorState();
        final threads = snap.data ?? const <InboxThread>[];
        if (threads.isEmpty) {
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
