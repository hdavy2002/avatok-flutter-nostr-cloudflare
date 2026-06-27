import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/ice_cache.dart';
import '../avatok/call_screen.dart';
import '../avatok/contacts.dart';
import 'ava_phone_contacts.dart';
import 'ava_sms_inbox.dart';
import 'phone_theme.dart';

/// AvaPhone — a PSTN-style phone experience that is, under the hood, pure
/// AvaTOK→AvaTOK in-network calling/messaging (NO real PSTN). You dial an
/// AvaTOK number directly (no need to save a contact first); reaching a stranger
/// who doesn't answer drops you to their AvaVoice receptionist to leave a
/// voicemail. Three surfaces, mirroring a phone dialer:
///   • Calls     — favourites (most-dialed) + recent calls + the dialpad.
///   • Messages  — SMS-style inbox (distinct from the Messenger).
///   • Contacts  — AvaTOK-number contacts ONLY (never the phone's address book).
class AvaPhoneScreen extends StatefulWidget {
  const AvaPhoneScreen({super.key});
  @override
  State<AvaPhoneScreen> createState() => _AvaPhoneScreenState();
}

class _AvaPhoneScreenState extends State<AvaPhoneScreen> {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaphone', 'home');
  }

  void _openDialpad() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const _DialpadSheet(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: PhoneTheme.bg,
      body: SafeArea(
        bottom: false,
        child: IndexedStack(index: _tab, children: const [
          _CallsTab(),
          AvaSmsInbox(),
          AvaPhoneContacts(),
        ]),
      ),
      floatingActionButton: _tab == 0
          ? FloatingActionButton(
              backgroundColor: PhoneTheme.teal,
              foregroundColor: _kInk,
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(18),
                side: const BorderSide(color: PhoneTheme.border, width: 2),
              ),
              onPressed: _openDialpad,
              child: PhosphorIcon(PhosphorIcons.gridFour(PhosphorIconsStyle.bold), size: 26),
            )
          : null,
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          color: PhoneTheme.surface,
          border: Border(top: BorderSide(color: PhoneTheme.border, width: 1.5)),
        ),
        child: NavigationBarTheme(
          data: NavigationBarThemeData(
            backgroundColor: PhoneTheme.surface,
            indicatorColor: PhoneTheme.accent.withValues(alpha: 0.22),
            labelTextStyle: WidgetStatePropertyAll(PhoneTheme.tag(size: 10.5, color: PhoneTheme.textSoft)),
          ),
          child: NavigationBar(
            height: 64,
            selectedIndex: _tab,
            onDestinationSelected: (i) => setState(() => _tab = i),
            backgroundColor: PhoneTheme.surface,
            surfaceTintColor: Colors.transparent,
            destinations: [
              NavigationDestination(
                  icon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), color: PhoneTheme.textSoft),
                  selectedIcon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.fill), color: PhoneTheme.accent),
                  label: 'Calls'),
              NavigationDestination(
                  icon: PhosphorIcon(PhosphorIcons.chatText(PhosphorIconsStyle.bold), color: PhoneTheme.textSoft),
                  selectedIcon: PhosphorIcon(PhosphorIcons.chatText(PhosphorIconsStyle.fill), color: PhoneTheme.accent),
                  label: 'Messages'),
              NavigationDestination(
                  icon: PhosphorIcon(PhosphorIcons.addressBook(PhosphorIconsStyle.bold), color: PhoneTheme.textSoft),
                  selectedIcon: PhosphorIcon(PhosphorIcons.addressBook(PhosphorIconsStyle.fill), color: PhoneTheme.accent),
                  label: 'Contacts'),
            ],
          ),
        ),
      ),
    );
  }
}

/// Convenience: ink colour for FAB foreground (kept readable on the teal accent).
const Color _kInk = Color(0xFF0E1116);

// ─────────────────────────────── Calls tab ────────────────────────────────

class _CallsTab extends StatefulWidget {
  const _CallsTab();
  @override
  State<_CallsTab> createState() => _CallsTabState();
}

class _CallsTabState extends State<_CallsTab> {
  final _store = CallLogStore();
  List<CallEntry> _calls = [];
  Map<String, Contact> _byNpub = {};
  bool _loaded = false;
  StreamSubscription<void>? _sub;

  @override
  void initState() {
    super.initState();
    _load();
    _sub = CallLogStore.changes.listen((_) => _load());
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final calls = await _store.load();
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    setState(() {
      _calls = calls;
      _byNpub = {for (final c in contacts) c.npub: c};
      _loaded = true;
    });
  }

  String? _avatarFor(String seed) {
    final c = _byNpub[seed];
    return (c != null && c.avatarUrl.isNotEmpty) ? c.avatarUrl : null;
  }

  /// Most-dialed people (by call frequency), most frequent first — the round
  /// avatar row at the top of the reference dialer.
  List<CallEntry> get _favorites {
    final count = <String, int>{};
    final newest = <String, CallEntry>{};
    for (final c in _calls) {
      if (c.seed.isEmpty) continue;
      count[c.seed] = (count[c.seed] ?? 0) + 1;
      final cur = newest[c.seed];
      if (cur == null || c.ts > cur.ts) newest[c.seed] = c;
    }
    final seeds = count.keys.toList()
      ..sort((a, b) => (count[b] ?? 0).compareTo(count[a] ?? 0));
    return seeds.take(8).map((s) => newest[s]!).toList();
  }

  void _call(CallEntry c) {
    IceCache.prefetch();
    Analytics.capture('avaphone_call_back', {'dir': c.dir.name, 'video': c.video});
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(
        room: 'avatok-${c.seed}', title: c.name.isNotEmpty ? c.name : c.seed,
        seed: c.seed, video: false, outgoing: true, avatarUrl: _avatarFor(c.seed) ?? ''),
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    final favs = _favorites;
    return Column(
      children: [
        _SearchHeader(onDialpad: () {
          showModalBottomSheet<void>(
            context: context, isScrollControlled: true,
            backgroundColor: Colors.transparent, builder: (_) => const _DialpadSheet());
        }),
        const _NetworkBanner(),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator(color: PhoneTheme.accent))
              : (_calls.isEmpty
                  ? _empty()
                  : ListView(
                      padding: const EdgeInsets.only(bottom: 96),
                      children: [
                        if (favs.isNotEmpty) _favRow(favs),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                          child: Text('RECENT', style: PhoneTheme.tag(size: 11, color: PhoneTheme.textMute)),
                        ),
                        for (final c in _calls) _CallRow(
                          entry: c,
                          avatarUrl: _avatarFor(c.seed),
                          isAvatok: _byNpub.containsKey(c.seed),
                          onTap: () => _call(c),
                        ),
                      ],
                    )),
        ),
      ],
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), size: 46, color: PhoneTheme.textMute),
            const SizedBox(height: 14),
            Text('No calls yet', style: PhoneTheme.title(size: 17)),
            const SizedBox(height: 6),
            Text('Tap the keypad to dial an AvaTOK number — no need to save a contact first.',
                textAlign: TextAlign.center, style: PhoneTheme.sub(size: 13)),
          ]),
        ),
      );

  Widget _favRow(List<CallEntry> favs) => SizedBox(
        height: 108,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
          itemCount: favs.length,
          separatorBuilder: (_, __) => const SizedBox(width: 14),
          itemBuilder: (_, i) {
            final c = favs[i];
            return GestureDetector(
              onTap: () => _call(c),
              child: SizedBox(
                width: 64,
                child: Column(children: [
                  Stack(children: [
                    PhoneTheme.ring(Avatar(
                        seed: c.seed, name: c.name, size: 58,
                        avatarUrl: _avatarFor(c.seed))),
                    Positioned(
                      right: 0, bottom: 0,
                      child: Container(
                        width: 20, height: 20,
                        decoration: BoxDecoration(
                          color: PhoneTheme.accent, shape: BoxShape.circle,
                          border: Border.all(color: PhoneTheme.bg, width: 2)),
                        child: const Icon(Icons.call, size: 11, color: _kInk),
                      ),
                    ),
                  ]),
                  const SizedBox(height: 6),
                  Text(c.name.isNotEmpty ? c.name.split(' ').first : 'Unknown',
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: PhoneTheme.sub(size: 11.5, color: PhoneTheme.text)),
                ]),
              ),
            );
          },
        ),
      );
}

// ─────────────────────────── shared header / banner ───────────────────────

class _SearchHeader extends StatelessWidget {
  final VoidCallback onDialpad;
  const _SearchHeader({required this.onDialpad});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
      child: Row(children: [
        Expanded(
          child: Container(
            height: 46,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: BoxDecoration(
              color: PhoneTheme.surface,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: PhoneTheme.border, width: 1.5),
            ),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), size: 18, color: PhoneTheme.textSoft),
              const SizedBox(width: 10),
              Text('Search AvaTOK numbers & names', style: PhoneTheme.sub(size: 13)),
            ]),
          ),
        ),
        const SizedBox(width: 10),
        GestureDetector(
          onTap: onDialpad,
          child: Container(
            width: 46, height: 46,
            decoration: BoxDecoration(
              color: PhoneTheme.teal,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: PhoneTheme.border, width: 1.5),
            ),
            child: PhosphorIcon(PhosphorIcons.gridFour(PhosphorIconsStyle.bold), size: 22, color: _kInk),
          ),
        ),
      ]),
    );
  }
}

/// Privacy/UX banner: everyone here lives on the AvaTOK network, NOT the phone's
/// own contact list — exactly the clarification the owner asked to surface.
class _NetworkBanner extends StatelessWidget {
  const _NetworkBanner();
  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 2, 14, 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: PhoneTheme.teal.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: PhoneTheme.teal.withValues(alpha: 0.35), width: 1),
      ),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), size: 15, color: PhoneTheme.teal),
        const SizedBox(width: 8),
        Expanded(
          child: Text('Everything here is on the AvaTOK network — not your phone contacts.',
              style: PhoneTheme.sub(size: 11.5, color: PhoneTheme.textSoft)),
        ),
      ]),
    );
  }
}

// ───────────────────────────────── call row ───────────────────────────────

class _CallRow extends StatelessWidget {
  final CallEntry entry;
  final String? avatarUrl;
  final bool isAvatok;
  final VoidCallback onTap;
  const _CallRow({required this.entry, required this.onTap, this.avatarUrl, this.isAvatok = false});

  ({IconData icon, Color color, String label}) get _dir => switch (entry.dir) {
        CallDir.incoming => (icon: Icons.call_received, color: PhoneTheme.callGreen, label: 'Incoming'),
        CallDir.outgoing => (icon: Icons.call_made, color: PhoneTheme.teal, label: 'Outgoing'),
        CallDir.missed => (icon: Icons.call_missed, color: PhoneTheme.danger, label: 'Missed'),
      };

  @override
  Widget build(BuildContext context) {
    final d = _dir;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        child: Row(children: [
          PhoneTheme.ring(Avatar(seed: entry.seed, name: entry.name, size: 46, avatarUrl: avatarUrl)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(entry.name.isNotEmpty ? entry.name : entry.seed,
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: PhoneTheme.value(
                      size: 15, color: entry.dir == CallDir.missed ? PhoneTheme.danger : PhoneTheme.text)),
              const SizedBox(height: 3),
              Row(children: [
                Icon(d.icon, size: 13, color: d.color),
                const SizedBox(width: 5),
                Text(entry.timeLabel, style: PhoneTheme.sub(size: 12)),
                if (entry.video) ...[
                  const SizedBox(width: 6),
                  PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), size: 12, color: PhoneTheme.textMute),
                ],
              ]),
            ]),
          ),
          IconButton(
            onPressed: onTap,
            icon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 20, color: PhoneTheme.accent),
          ),
        ]),
      ),
    );
  }
}

// ──────────────────────────────── dialpad ─────────────────────────────────

class _DialpadSheet extends StatefulWidget {
  const _DialpadSheet();
  @override
  State<_DialpadSheet> createState() => _DialpadSheetState();
}

class _DialpadSheetState extends State<_DialpadSheet> {
  String _digits = '';
  bool _dialing = false;
  String? _status;

  static const _keys = <(String, String)>[
    ('1', '⌷'), ('2', 'ABC'), ('3', 'DEF'),
    ('4', 'GHI'), ('5', 'JKL'), ('6', 'MNO'),
    ('7', 'PQRS'), ('8', 'TUV'), ('9', 'WXYZ'),
    ('*', ''), ('0', '+'), ('#', ''),
  ];

  void _press(String k) {
    HapticFeedback.lightImpact();
    setState(() { _digits += k; _status = null; });
  }

  void _press0Long() {
    HapticFeedback.mediumImpact();
    setState(() { _digits += '+'; _status = null; });
  }

  void _backspace() {
    if (_digits.isEmpty) return;
    HapticFeedback.selectionClick();
    setState(() => _digits = _digits.substring(0, _digits.length - 1));
  }

  Future<void> _dial() async {
    final q = _digits.trim();
    if (q.replaceAll(RegExp(r'[^\d]'), '').length < 4) {
      setState(() => _status = 'Enter a full AvaTOK number');
      return;
    }
    setState(() { _dialing = true; _status = null; });
    Analytics.capture('avaphone_dial', {'len': q.length});
    Contact? hit;
    try { hit = await Directory.resolve(q); } catch (_) { hit = null; }
    if (!mounted) return;
    if (hit == null || hit.npub.isEmpty) {
      Analytics.capture('avaphone_dial_unreachable', {'len': q.length});
      setState(() { _dialing = false; _status = 'No AvaTOK account on that number'; });
      return;
    }
    Analytics.capture('avaphone_dial_connect', const {});
    IceCache.prefetch();
    final c = hit; // non-null local for the closure below
    Navigator.pop(context); // close the dialpad
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(
        room: 'avatok-${c.npub}',
        title: c.name.isNotEmpty ? c.name : (c.number.isNotEmpty ? c.number : q),
        seed: c.npub, video: false, outgoing: true, avatarUrl: c.avatarUrl),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).padding.bottom;
    return Container(
      decoration: const BoxDecoration(
        color: PhoneTheme.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
        border: Border(
          top: BorderSide(color: PhoneTheme.border, width: 1.5),
          left: BorderSide(color: PhoneTheme.border, width: 1.5),
          right: BorderSide(color: PhoneTheme.border, width: 1.5),
        ),
      ),
      padding: EdgeInsets.fromLTRB(20, 12, 20, 16 + bottom),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16),
          decoration: BoxDecoration(color: PhoneTheme.border, borderRadius: BorderRadius.circular(100)),
        ),
        // Entered number.
        SizedBox(
          height: 52,
          child: Center(
            child: Text(_digits.isEmpty ? 'AvaTOK number' : _digits,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: PhoneTheme.title(size: 30,
                    color: _digits.isEmpty ? PhoneTheme.textMute : PhoneTheme.text)),
          ),
        ),
        if (_status != null)
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 4),
            child: Text(_status!, style: PhoneTheme.sub(size: 12.5, color: PhoneTheme.danger)),
          ),
        const SizedBox(height: 8),
        // Keypad grid.
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: 3,
          mainAxisSpacing: 10,
          crossAxisSpacing: 18,
          childAspectRatio: 1.35,
          children: [
            for (final k in _keys)
              _Key(
                digit: k.$1,
                sub: k.$2,
                onTap: () => _press(k.$1),
                onLongPress: k.$1 == '0' ? _press0Long : null,
              ),
          ],
        ),
        const SizedBox(height: 14),
        // Call + backspace row.
        Row(children: [
          const SizedBox(width: 64),
          const Spacer(),
          GestureDetector(
            onTap: _dialing ? null : _dial,
            child: Container(
              width: 66, height: 66,
              decoration: BoxDecoration(
                color: _dialing ? PhoneTheme.callGreen.withValues(alpha: 0.5) : PhoneTheme.callGreen,
                shape: BoxShape.circle,
                border: Border.all(color: PhoneTheme.border, width: 2),
              ),
              child: _dialing
                  ? const Padding(padding: EdgeInsets.all(20),
                      child: CircularProgressIndicator(strokeWidth: 2.6, color: _kInk))
                  : const Icon(Icons.call, size: 30, color: _kInk),
            ),
          ),
          const Spacer(),
          SizedBox(
            width: 64,
            child: _digits.isEmpty
                ? null
                : IconButton(
                    onPressed: _backspace,
                    icon: PhosphorIcon(PhosphorIcons.backspace(PhosphorIconsStyle.bold),
                        size: 26, color: PhoneTheme.textSoft),
                  ),
          ),
        ]),
      ]),
    );
  }
}

class _Key extends StatelessWidget {
  final String digit;
  final String sub;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  const _Key({required this.digit, required this.sub, required this.onTap, this.onLongPress});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      behavior: HitTestBehavior.opaque,
      child: Container(
        decoration: BoxDecoration(
          color: PhoneTheme.surface2,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: PhoneTheme.border, width: 1.2),
        ),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Text(digit, style: PhoneTheme.title(size: 26)),
          if (sub.isNotEmpty)
            Text(sub, style: PhoneTheme.tag(size: 9, color: PhoneTheme.textMute)),
        ]),
      ),
    );
  }
}
