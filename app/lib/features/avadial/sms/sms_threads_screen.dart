import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/ava_log.dart';
import '../../../core/config.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../avadial_channel.dart';
import '../device_contacts.dart';
import 'sms_compose_screen.dart';
import 'sms_spam_store.dart';
import 'sms_thread_screen.dart';
import 'sms_unread_store.dart';

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

  // [AVADIAL-SEARCH-1] Instant free-text search, applied on top of the Inbox/Spam
  // bucket (the two compose, they don't replace each other).
  final _searchController = TextEditingController();
  String _query = '';

  // Resolved verdicts per normalised number (user label OR community lookup).
  final Map<String, bool> _isSpam = {}; // normKey → spam?
  StreamSubscription<AvaSmsMessage>? _inSub;

  @override
  void initState() {
    super.initState();
    _load();
    _inSub = AvaDialChannel.I.smsIncoming.listen((_) => _load());
    // [AVA-SMS-BADGE-1] Repaint the per-thread orange counts whenever the
    // unread store re-reads the provider (inbound SMS / thread opened / resume).
    SmsUnreadStore.I.start();
    SmsUnreadStore.I.revision.addListener(_onUnreadChanged);
  }

  void _onUnreadChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    SmsUnreadStore.I.revision.removeListener(_onUnreadChanged);
    _inSub?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final startedAt = DateTime.now();
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
    // [AVADIAL-SMS-TELEMETRY-1] The "I'm still not getting any messages" event.
    // This is the READ side of the SMS feature — the provider query behind the
    // Messages tab — and it had no telemetry at all, so an empty inbox was
    // indistinguishable from a healthy one with no texts.
    //
    // `threads == 0` alone means nothing; paired with `role_held` it is decisive:
    //   role_held=false, threads=0  → expected, we can't read the provider yet
    //   role_held=true,  threads=0  → BROKEN, we own the inbox and it's empty
    // The second combination is the fleet-wide version of the owner's report, and
    // it's a PostHog query rather than a bug report. Counts and timings only — no
    // addresses, no snippets.
    // Flush any SMS/OTP telemetry native buffered while the engine was down.
    // ensureWired() drains once at cold start; this catches everything that
    // arrived with the app merely backgrounded — which for SMS is most of it.
    unawaited(AvaDialChannel.I.drainNativeTelemetry());
    unawaited(() async {
      final roleHeld = await AvaDialChannel.I.isSmsRoleHeld();
      Analytics.capture('avadial_sms_threads_loaded', <String, Object>{
        'threads': list.length,
        'unread_threads': list.where((t) => t.unread).length,
        'role_held': roleHeld,
        'elapsed_ms': DateTime.now().difference(startedAt).inMilliseconds,
      });
    }());
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
    Navigator.of(context)
        .push(MaterialPageRoute<void>(
          builder: (_) => SmsThreadScreen(address: t.address),
        ))
        .then((_) => _load()); // re-read snippets/read-flags on return
    // [AVA-SMS-BADGE-1] Opening the thread = reading it. Mark its messages
    // read in the OS provider so the red AvaDialer count, the orange Messages
    // tab count and this row's badge all walk down together.
    unawaited(SmsUnreadStore.I.markThreadRead(t.address));
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
    final visible = _threads
        .where((t) => _filter == _Filter.spam ? _threadIsSpam(t) : !_threadIsSpam(t))
        .where(_matchesQuery)
        .toList();
    return Stack(children: [
      Column(children: [
        _segmented(),
        _searchBar(),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: AD.textPrimary))
              : visible.isEmpty
                  ? (_query.trim().isEmpty
                      ? ShellEmptyStateFallback(filter: _filter)
                      : Center(
                          child: Text('No matches',
                              style: ADText.preview(c: AD.textSecondary)),
                        ))
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
          color: AD.primaryBadge,
          radius: BorderRadius.circular(100),
          borderColor: AD.borderControl,
          borderWidth: 1,
          boxShadow: const [],
          padding: const EdgeInsets.all(16),
          child: Icon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), size: 24, color: Colors.white),
        ),
      ),
    ]);
  }

  /// [AVADIAL-SEARCH-1] Does this thread match the current query? Case-insensitive
  /// on the contact name (the same name [_row] renders) and the message snippet,
  /// plus a number match through [DeviceContacts.normKey] — the normalisation the
  /// rest of the Calls app keys on, so '2079460958' still finds a thread stored as
  /// '+44 (20) 7946-0958'. Empty query matches everything.
  bool _matchesQuery(_Thread t) {
    final q = _query.trim();
    if (q.isEmpty) return true;
    final qLower = q.toLowerCase();
    final name = DeviceContacts.I.lookup(t.address)?.name ?? '';
    if (name.toLowerCase().contains(qLower)) return true;
    if (t.snippet.toLowerCase().contains(qLower)) return true;
    if (t.address.toLowerCase().contains(qLower)) return true;
    if (RegExp(r'\d').hasMatch(q)) {
      final qKey = DeviceContacts.normKey(q);
      if (qKey.isNotEmpty && DeviceContacts.normKey(t.address).contains(qKey)) return true;
    }
    return false;
  }

  /// Instant search over the conversation list — filters on every keystroke, no
  /// submit and no debounce (threads are already in memory).
  Widget _searchBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 2),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(children: [
          Icon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
              size: 18, color: AD.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: _searchController,
              onChanged: (v) {
                // Fire once per search session (empty → typing), not per keystroke.
                if (_query.trim().isEmpty && v.trim().isNotEmpty) {
                  Analytics.capture('avadial_search_started', const {'tab': 'messages'});
                }
                setState(() => _query = v);
              },
              textInputAction: TextInputAction.search,
              style: const TextStyle(color: AD.textPrimary, fontSize: 14.5),
              decoration: const InputDecoration(
                hintText: 'Search messages, names or numbers',
                hintStyle: TextStyle(color: AD.textSecondary, fontSize: 14.5),
                border: InputBorder.none,
                isDense: true,
                contentPadding: EdgeInsets.symmetric(vertical: 12),
              ),
            ),
          ),
          if (_query.isNotEmpty)
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                _searchController.clear();
                setState(() => _query = '');
              },
              child: const Padding(
                padding: EdgeInsets.only(left: 6),
                child: Icon(Icons.close, size: 18, color: AD.textSecondary),
              ),
            ),
        ]),
      ),
    );
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
    final fill = active ? (f == _Filter.spam ? AD.danger : AD.primaryBadge) : AD.card;
    final fg = active ? Colors.white : AD.textPrimary;
    return ZinePressable(
      onTap: () => setState(() => _filter = f),
      color: fill,
      radius: BorderRadius.circular(100),
      borderColor: AD.borderControl,
      borderWidth: 1,
      boxShadow: const [],
      padding: const EdgeInsets.symmetric(vertical: 11),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        Icon(icon, size: 17, color: fg),
        const SizedBox(width: 7),
        Text(label, style: ZineText.button(size: 15, color: fg)),
      ]),
    );
  }

  Widget _row(_Thread t) {
    final name = DeviceContacts.I.lookup(t.address)?.name;
    final spam = _threadIsSpam(t);
    // [AVA-SMS-BADGE-1] Live unread count for THIS conversation (orange badge;
    // unread threads also get a brighter snippet). Falls back to the provider's
    // read-flag when the store hasn't resolved yet.
    final unread = SmsUnreadStore.I.countFor(t.address);
    final isUnread = unread > 0 || t.unread;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: AdCard(
        onTap: () => _openThread(t),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        child: Row(children: [
          ZineIconBadge(
            icon: spam
                ? PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold)
                : PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
            color: spam ? AD.danger : AD.iconSearch,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name ?? t.address,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ZineText.cardTitle(size: 15.5, color: AD.textPrimary)),
              const SizedBox(height: 2),
              Text(t.snippet,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ZineText.sub(
                      size: 12.5,
                      color: isUnread ? AD.textPrimary : AD.textSecondary)),
            ]),
          ),
          if (unread > 0)
            Padding(
              padding: const EdgeInsets.only(left: 8),
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: AD.primaryBadge, // orange — owner spec 2026-07-14
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Text(
                  unread > 99 ? '99+' : '$unread',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    height: 1.2,
                  ),
                ),
              ),
            ),
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, color: AD.textSecondary),
            color: AD.menu,
            onSelected: (v) => v == 'spam' ? _moveToSpam(t) : _moveToInbox(t),
            itemBuilder: (_) => [
              if (!spam)
                PopupMenuItem(
                    value: 'spam',
                    child: Text('Move to Spam', style: TextStyle(color: AD.textPrimary))),
              if (spam)
                PopupMenuItem(
                    value: 'inbox',
                    child: Text('Not spam', style: TextStyle(color: AD.textPrimary))),
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
          color: spam ? AD.danger : AD.iconSearch,
          size: 56,
        ),
        const SizedBox(height: 16),
        Text(spam ? 'No spam' : 'No messages',
            textAlign: TextAlign.center,
            style: ZineText.cardTitle(size: 18, color: AD.textPrimary)),
        const SizedBox(height: 8),
        Text(
          spam
              ? 'Filtered spam texts will collect here.'
              : 'Your carrier text conversations show up here.',
          textAlign: TextAlign.center,
          style: ZineText.sub(size: 14, color: AD.textSecondary),
        ),
      ],
    );
  }
}
