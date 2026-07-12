import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/ava_log.dart';
import '../../../core/config.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../avadial_channel.dart';
import '../device_contacts.dart';
import 'sms_compose_screen.dart';
import 'sms_spam_store.dart';
import 'sms_thread_screen.dart';

/// One SMS conversation row (LIVE from the OS provider).
class _Thread {
  final String address;
  final String snippet;
  final int date;
  final bool unread;
  const _Thread({
    required this.address,
    required this.snippet,
    required this.date,
    required this.unread,
  });
}

/// The AvaDial Messages tab body when `avaSms` is on AND ROLE_SMS is held: the SMS
/// conversation list with an AI Inbox/Spam segmented filter (AVA-SMS).
///
/// Bucket resolution (plan): a user label in [SmsSpamStore] wins (spam → Spam,
/// not-spam → Inbox); otherwise, when the spam shield is on, a best-effort community
/// lookup classifies the number (score ≥ warn → Spam). Threads default to Inbox.
/// Moving a thread to Spam writes a local scoped label AND (spamShield-gated) reports
/// it to the community pool.
class SmsThreadsScreen extends StatefulWidget {
  const SmsThreadsScreen({super.key});

  @override
  State<SmsThreadsScreen> createState() => _SmsThreadsScreenState();
}

enum _Filter { inbox, spam }

class _SmsThreadsScreenState extends State<SmsThreadsScreen> {
  _Filter _filter = _Filter.inbox;
  List<_Thread> _threads = const [];
  bool _loading = true;

  // Resolved verdicts per normalised number (user label OR community lookup).
  final Map<String, bool> _isSpam = {}; // normKey → spam?
  StreamSubscription<AvaSmsMessage>? _inSub;

  @override
  void initState() {
    super.initState();
    _load();
    _inSub = AvaDialChannel.I.smsIncoming.listen((_) => _load());
  }

  @override
  void dispose() {
    _inSub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final raw = await AvaDialChannel.I.smsQueryThreads();
    final list = <_Thread>[];
    for (final r in raw) {
      final addr = (r['address'] as String?)?.trim();
      if (addr == null || addr.isEmpty) continue;
      list.add(_Thread(
        address: addr,
        snippet: (r['snippet'] as String?) ?? '',
        date: (r['date'] as num?)?.toInt() ?? 0,
        unread: r['read'] == false,
      ));
    }
    if (!mounted) return;
    setState(() {
      _threads = list;
      _loading = false;
    });
    _resolveVerdicts(list);
  }

  /// Fill [_isSpam] from user labels first, then best-effort community lookups.
  Future<void> _resolveVerdicts(List<_Thread> list) async {
    for (final t in list) {
      final key = DeviceContacts.normKey(t.address);
      final v = await SmsSpamStore.I.verdictFor(t.address);
      if (v == SmsVerdict.spam) {
        _isSpam[key] = true;
      } else if (v == SmsVerdict.ham) {
        _isSpam[key] = false;
      } else if (RemoteConfig.spamShield && !_isSpam.containsKey(key)) {
        // Best-effort, bounded — never blocks the UI; result folds in on return.
        final spam = await _communityLookup(t.address);
        if (spam != null) _isSpam[key] = spam;
      }
    }
    if (mounted) setState(() {});
  }

  /// Community score lookup (spamShield-gated). Returns spam?/null (unknown). Mirrors
  /// the AskAva spam_lookup tool: 403 = shield off, degrade to null.
  Future<bool?> _communityLookup(String number) async {
    final digits = number.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.isEmpty) return null;
    try {
      final res = await ApiAuth.getSigned(
        '$kApiBase/spam/lookup/${Uri.encodeComponent(digits)}',
        timeout: const Duration(seconds: 6),
      );
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final label = (j['label'] ?? 'none').toString();
      // Server labels a hot number; treat any non-'none'/'unknown' label as spam.
      return label != 'none' && label != 'unknown';
    } catch (e) {
      AvaLog.I.log('avadial', 'sms community lookup failed: $e');
      return null;
    }
  }

  bool _threadIsSpam(_Thread t) => _isSpam[DeviceContacts.normKey(t.address)] ?? false;

  Future<void> _moveToSpam(_Thread t) async {
    await SmsSpamStore.I.markSpam(t.address);
    setState(() => _isSpam[DeviceContacts.normKey(t.address)] = true);
    Analytics.capture('avadial_sms_marked_spam', {'number_hash': AvaDialChannel.hashE164(t.address)});
    // Optional community report — only when the shield is on.
    if (RemoteConfig.spamShield) unawaited(_reportCommunity(t.address, 'spam'));
  }

  Future<void> _moveToInbox(_Thread t) async {
    await SmsSpamStore.I.markHam(t.address);
    setState(() => _isSpam[DeviceContacts.normKey(t.address)] = false);
    Analytics.capture('avadial_sms_marked_ham', {'number_hash': AvaDialChannel.hashE164(t.address)});
    if (RemoteConfig.spamShield) unawaited(_reportCommunity(t.address, 'not_spam'));
  }

  Future<void> _reportCommunity(String number, String verdict) async {
    try {
      await ApiAuth.postJson('$kApiBase/spam/report', {'number': number, 'verdict': verdict});
    } catch (e) {
      AvaLog.I.log('avadial', 'sms community report failed: $e');
    }
  }

  void _openThread(_Thread t) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => SmsThreadScreen(address: t.address),
    ));
  }

  void _compose() {
    // AVA-SMS-4: full new-message screen — searchable device-contact picker plus
    // manual number entry (was a bare number-only sheet). Opens SmsThreadScreen
    // for the chosen recipient, ready to send.
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => const SmsComposeScreen(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final visible = _threads.where((t) =>
        _filter == _Filter.spam ? _threadIsSpam(t) : !_threadIsSpam(t)).toList();
    return Stack(children: [
      Column(children: [
        _segmented(),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: Zine.ink))
              : visible.isEmpty
                  ? ShellEmptyStateFallback(filter: _filter)
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        padding: const EdgeInsets.fromLTRB(14, 8, 14, 88),
                        itemCount: visible.length,
                        itemBuilder: (context, i) => _row(visible[i]),
                      ),
                    ),
        ),
      ]),
      Positioned(
        right: 18,
        bottom: 18,
        child: ZinePressable(
          onTap: _compose,
          color: Zine.lime,
          radius: BorderRadius.circular(100),
          boxShadow: Zine.shadow,
          padding: const EdgeInsets.all(16),
          child: Icon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), size: 24, color: Zine.ink),
        ),
      ),
    ]);
  }

  Widget _segmented() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
      child: Row(children: [
        Expanded(child: _segTab('Inbox', _Filter.inbox, PhosphorIcons.tray(PhosphorIconsStyle.bold))),
        const SizedBox(width: 8),
        Expanded(child: _segTab('Spam', _Filter.spam, PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold))),
      ]),
    );
  }

  Widget _segTab(String label, _Filter f, IconData icon) {
    final active = _filter == f;
    return ZinePressable(
      onTap: () => setState(() => _filter = f),
      color: active ? (f == _Filter.spam ? Zine.coral : Zine.lime) : Zine.card,
      radius: BorderRadius.circular(100),
      padding: const EdgeInsets.symmetric(vertical: 11),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        Icon(icon, size: 17, color: active && f == _Filter.spam ? Colors.white : Zine.ink),
        const SizedBox(width: 7),
        Text(label,
            style: ZineText.button(
                size: 15, color: active && f == _Filter.spam ? Colors.white : Zine.ink)),
      ]),
    );
  }

  Widget _row(_Thread t) {
    final name = DeviceContacts.I.lookup(t.address)?.name;
    final spam = _threadIsSpam(t);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ZineCard(
        onTap: () => _openThread(t),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        child: Row(children: [
          ZineIconBadge(
            icon: spam
                ? PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold)
                : PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
            color: spam ? Zine.coral : Zine.blue,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name ?? t.address,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.cardTitle(size: 15.5)),
              const SizedBox(height: 2),
              Text(t.snippet,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
            ]),
          ),
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, color: Zine.inkSoft),
            onSelected: (v) => v == 'spam' ? _moveToSpam(t) : _moveToInbox(t),
            itemBuilder: (_) => [
              if (!spam) const PopupMenuItem(value: 'spam', child: Text('Move to Spam')),
              if (spam) const PopupMenuItem(value: 'inbox', child: Text('Not spam')),
            ],
          ),
        ]),
      ),
    );
  }
}

/// Empty-state for the inbox/spam list (kept local so it needs no extra file).
class ShellEmptyStateFallback extends StatelessWidget {
  final _Filter filter;
  const ShellEmptyStateFallback({super.key, required this.filter});

  @override
  Widget build(BuildContext context) {
    final spam = filter == _Filter.spam;
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 24),
      children: [
        const SizedBox(height: 80),
        ZineIconBadge(
          icon: spam
              ? PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold)
              : PhosphorIcons.tray(PhosphorIconsStyle.bold),
          color: spam ? Zine.coral : Zine.blue,
          size: 56,
        ),
        const SizedBox(height: 16),
        Text(spam ? 'No spam' : 'No messages',
            textAlign: TextAlign.center, style: ZineText.cardTitle(size: 18)),
        const SizedBox(height: 8),
        Text(
          spam
              ? 'Filtered spam texts will collect here.'
              : 'Your carrier text conversations show up here.',
          textAlign: TextAlign.center,
          style: ZineText.sub(size: 14),
        ),
      ],
    );
  }
}
