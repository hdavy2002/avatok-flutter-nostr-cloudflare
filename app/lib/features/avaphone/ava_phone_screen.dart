import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/calls/call_room_id.dart'; // [CALL-ROOM-ID-1]
import '../../core/ice_cache.dart';
import '../../core/paid_call_api.dart';
import '../../core/remote_config.dart';
import '../../core/team_api.dart';
import '../avatok/paid_call_prompt.dart';
import '../avatok/place_1to1_call.dart';
import '../team/team_ivr_screen.dart';
import '../avadial/avadial_channel.dart';
import '../avadial/outgoing_call_screen.dart';
import '../avatok/contact_actions.dart';
import '../avatok/contact_profile_screen.dart';
import '../avatok/contacts.dart';
import 'ava_phone_contacts.dart';
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
  /// [DIALPAD-BIZ-CALLS] When non-empty, the dialpad sheet opens automatically
  /// on first frame, pre-filled with this AvaTOK number (NOT auto-dialed — the
  /// user still presses call). Set by [openDialpadWithNumber] so a tapped
  /// AvaTOK number elsewhere in the app (e.g. a contact profile) drops straight
  /// into the dialer. See dialpad_prefill.dart.
  final String initialDialNumber;
  const AvaPhoneScreen({super.key, this.initialDialNumber = ''});
  @override
  State<AvaPhoneScreen> createState() => _AvaPhoneScreenState();
}

class _AvaPhoneScreenState extends State<AvaPhoneScreen> {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaphone', 'home');
    if (widget.initialDialNumber.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _openDialpad(initialNumber: widget.initialDialNumber);
      });
    }
  }

  void _openDialpad({String initialNumber = ''}) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _DialpadSheet(initialNumber: initialNumber),
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
          AvaPhoneContacts(),
        ]),
      ),
      // Dialpad now lives INLINE in the footer, between Home and Calls (owner
      // request 2026-06-29) — the centered floating button is gone. Home and
      // Dialpad act as buttons (pop / open sheet); Calls & Contacts are the only
      // real tabs.
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
            // Footer order: Home(0) · Dialpad(1) · Calls(2) · Contacts(3). Home
            // and Dialpad act as buttons (not tabs); Calls/Contacts are the only
            // real tabs, so the selected index is offset by 2.
            selectedIndex: _tab + 2,
            onDestinationSelected: (i) {
              if (i == 0) { Navigator.of(context).maybePop(); return; } // Home → Messenger
              if (i == 1) { _openDialpad(); return; }                  // Dialpad → sheet
              setState(() => _tab = i - 2); // 2 → Calls (0), 3 → Contacts (1)
            },
            backgroundColor: PhoneTheme.surface,
            surfaceTintColor: Colors.transparent,
            destinations: [
              NavigationDestination(
                  icon: PhosphorIcon(PhosphorIcons.house(PhosphorIconsStyle.bold), color: PhoneTheme.textSoft),
                  selectedIcon: PhosphorIcon(PhosphorIcons.house(PhosphorIconsStyle.fill), color: PhoneTheme.accent),
                  label: 'Home'),
              const NavigationDestination(
                  icon: _DialpadNavIcon(),
                  label: 'Dialpad'),
              NavigationDestination(
                  icon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), color: PhoneTheme.textSoft),
                  selectedIcon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.fill), color: PhoneTheme.accent),
                  label: 'Calls'),
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
const Color _kInk = Colors.white;

/// The dialpad footer destination keeps its distinctive teal rounded-square
/// badge so it still reads as the dialer entry point now that it lives inline
/// between Home and Calls (instead of as a centered floating button).
class _DialpadNavIcon extends StatelessWidget {
  const _DialpadNavIcon();
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 34,
      height: 28,
      decoration: BoxDecoration(
        color: PhoneTheme.teal,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: PhoneTheme.border, width: 1.5),
      ),
      alignment: Alignment.center,
      child: PhosphorIcon(PhosphorIcons.gridFour(PhosphorIconsStyle.bold), size: 18, color: _kInk),
    );
  }
}

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
      _byNpub = {for (final c in contacts) c.uid: c};
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
    // [AVA-IDGATE-1] Route through /api/call (gate + real ring) instead of opening
    // CallScreen directly. c.seed IS the peer uid (CallEntry.seed == uid).
    place1to1Call(context, uid: c.seed, name: c.name.isNotEmpty ? c.name : c.seed,
        avatarUrl: _avatarFor(c.seed) ?? '', dialer: true).then((_) => _load());
  }

  /// All log entries for a person (newest first) — drives the "called N times" count.
  List<CallEntry> _historyFor(String seed) =>
      (_calls.where((e) => e.seed == seed).toList()..sort((a, b) => b.ts.compareTo(a.ts)));

  /// Per-row options (tap or long-press) — NO accidental dialling.
  void _options(CallEntry c) {
    final history = _historyFor(c.seed);
    final isContact = _byNpub.containsKey(c.seed);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: PhoneTheme.surface,
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: PhoneTheme.border, width: 1.5),
        borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 10),
        ListTile(
          leading: PhoneTheme.ring(Avatar(seed: c.seed, name: c.name, size: 44, avatarUrl: _avatarFor(c.seed))),
          title: Text(c.name.isNotEmpty ? c.name : c.seed, style: PhoneTheme.value(size: 15.5)),
          subtitle: Text('Called ${history.length} time${history.length == 1 ? '' : 's'}', style: PhoneTheme.sub(size: 12.5)),
        ),
        const Divider(color: PhoneTheme.border, height: 1),
        ListTile(
          leading: const Icon(Icons.call, color: PhoneTheme.callGreen),
          title: Text('Call', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _call(c); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.bold), color: PhoneTheme.teal),
          title: Text('Call history (${history.length})', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _showHistory(c, history); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.user(PhosphorIconsStyle.bold), color: PhoneTheme.lilac),
          title: Text(isContact ? 'View contact' : 'Add to contacts', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _viewContact(c); }),
        // [FIX-CONTACT-1] Copy / Share vCard / Forward — shared contact actions.
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), color: PhoneTheme.lilac),
          title: Text('Copy contact', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); ContactActions.copy(context, _contactOf(c)); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), color: PhoneTheme.accent),
          title: Text('Share contact', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); ContactActions.share(context, _contactOf(c)); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), color: PhoneTheme.teal),
          title: Text('Forward contact', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); ContactActions.forward(context, _contactOf(c)); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: PhoneTheme.danger),
          title: Text('Delete this log', style: PhoneTheme.value(size: 15, color: PhoneTheme.danger)),
          onTap: () async {
            Navigator.pop(ctx);
            if (c.id.isNotEmpty) await _store.removeById(c.id);
            Analytics.capture('avaphone_calllog_delete', const {});
            _load();
          }),
        const SizedBox(height: 8),
      ])),
    );
  }

  void _showHistory(CallEntry c, List<CallEntry> history) {
    ({IconData icon, Color color}) dir(CallDir d) => switch (d) {
          CallDir.incoming => (icon: Icons.call_received, color: PhoneTheme.callGreen),
          CallDir.outgoing => (icon: Icons.call_made, color: PhoneTheme.teal),
          CallDir.missed => (icon: Icons.call_missed, color: PhoneTheme.danger),
        };
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: PhoneTheme.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: PhoneTheme.border, width: 1.5),
        borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => SafeArea(child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${c.name.isNotEmpty ? c.name : c.seed} — ${history.length} call${history.length == 1 ? '' : 's'}',
              style: PhoneTheme.title(size: 17)),
          const SizedBox(height: 10),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 360),
            child: ListView(shrinkWrap: true, children: [
              for (final e in history)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(children: [
                    Icon(dir(e.dir).icon, size: 16, color: dir(e.dir).color),
                    const SizedBox(width: 10),
                    Text(e.dir.name[0].toUpperCase() + e.dir.name.substring(1), style: PhoneTheme.value(size: 14)),
                    const Spacer(),
                    Text(e.timeLabel, style: PhoneTheme.sub(size: 12.5)),
                  ]),
                ),
            ]),
          ),
        ]),
      )),
    );
  }

  void _viewContact(CallEntry c) {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => ContactProfileScreen(name: c.name, uid: c.seed)));
  }

  /// [FIX-CONTACT-1] Resolve the saved [Contact] behind a call-log/favourite row
  /// for the Copy / Share / Forward actions, or synthesize a minimal one when the
  /// caller isn't saved (CallEntry.seed == uid).
  Contact _contactOf(CallEntry c) =>
      _byNpub[c.seed] ??
      Contact(uid: c.seed, name: c.name, avatarUrl: _avatarFor(c.seed) ?? '');

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
        // (kept as the plain, unfilled dialpad — pre-fill only applies via
        // AvaPhoneScreen.initialDialNumber / openDialpadWithNumber)
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
                          onTap: () => _options(c),   // tap → options (no accidental dial)
                          onCall: () => _call(c),     // green phone icon → dial
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
  final VoidCallback onTap;  // row tap / long-press → options sheet
  final VoidCallback onCall; // green phone icon → dial
  const _CallRow({required this.entry, required this.onTap, required this.onCall, this.avatarUrl, this.isAvatok = false});

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
      onLongPress: onTap,
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
            onPressed: onCall,
            icon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 20, color: PhoneTheme.accent),
          ),
        ]),
      ),
    );
  }
}

// ──────────────────────────────── dialpad ─────────────────────────────────

class _DialpadSheet extends StatefulWidget {
  /// [DIALPAD-BIZ-CALLS] Pre-fills the display with this number (digits are
  /// editable, nothing is auto-dialed). Empty = today's blank dialpad.
  final String initialNumber;
  const _DialpadSheet({this.initialNumber = ''});
  @override
  State<_DialpadSheet> createState() => _DialpadSheetState();
}

class _DialpadSheetState extends State<_DialpadSheet> with WidgetsBindingObserver {
  late String _digits = widget.initialNumber;
  bool _dialing = false;
  String? _status;
  // Whether the OS clipboard currently holds number-like text — drives the small
  // paste icon beside the number display. Refreshed on init + app resume.
  bool _clipboardHasNumber = false;

  static const _keys = <(String, String)>[
    ('1', '⌷'), ('2', 'ABC'), ('3', 'DEF'),
    ('4', 'GHI'), ('5', 'JKL'), ('6', 'MNO'),
    ('7', 'PQRS'), ('8', 'TUV'), ('9', 'WXYZ'),
    ('*', ''), ('0', '+'), ('#', ''),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refreshClipboardHint();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refreshClipboardHint();
  }

  /// Sanitize an arbitrary pasted string into an AvaTOK-dialable number.
  /// Strips spaces/dashes/dots/parentheses, keeps a single leading `+` and
  /// digits only, and converts a leading `00` international prefix to `+`.
  /// Returns null when fewer than 4 digits remain (i.e. not a phone number).
  static String? _sanitizeNumber(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return null;
    final hasPlus = s.startsWith('+') || s.startsWith('00');
    // Keep digits only for the body.
    var digits = s.replaceAll(RegExp(r'[^\d]'), '');
    // Leading 00 → international `+` prefix.
    if (s.startsWith('00') && digits.startsWith('00')) {
      digits = digits.substring(2);
    }
    if (digits.length < 4) return null;
    return hasPlus ? '+$digits' : digits;
  }

  /// Peek the clipboard and toggle the paste hint if it holds a number.
  Future<void> _refreshClipboardHint() async {
    String? txt;
    try {
      final data = await Clipboard.getData('text/plain');
      txt = data?.text;
    } catch (_) {
      txt = null;
    }
    final ok = txt != null && _sanitizeNumber(txt) != null;
    if (!mounted) return;
    if (ok != _clipboardHasNumber) setState(() => _clipboardHasNumber = ok);
  }

  /// Paste from the clipboard, sanitize, and load into the display. Rejects
  /// non-number content with a snackbar and leaves the display untouched.
  Future<void> _pasteFromClipboard() async {
    HapticFeedback.selectionClick();
    String? txt;
    try {
      final data = await Clipboard.getData('text/plain');
      txt = data?.text;
    } catch (_) {
      txt = null;
    }
    final num = txt == null ? null : _sanitizeNumber(txt);
    if (num == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Not a phone number')),
      );
      return;
    }
    Analytics.capture('dialpad_paste', {
      'digits_len': num.replaceAll(RegExp(r'[^\d]'), '').length,
      'had_plus': num.startsWith('+'),
    });
    setState(() { _digits = num; _status = null; });
  }

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
    // [DIALPAD-DISMISS-FIX] Grab the ROOT navigator's own BuildContext now, while
    // the sheet is still mounted. `context` here belongs to this bottom sheet's
    // element, which starts unmounting the instant we Navigator.pop it below —
    // any `await` after that pop (place1to1Call's network round-trip, in
    // particular) would then race context.mounted turning false and silently
    // no-op every `if (!context.mounted) return;` guard downstream, so the
    // sheet just vanished and no call screen / IVR / busy card ever opened.
    // Push follow-up routes through this persisted navContext instead of the
    // soon-to-be-disposed sheet context.
    final navContext = Navigator.of(context, rootNavigator: true).context;
    // Team auto-attendant: if the dialed number runs a team IVR, open the spoken
    // menu (Ava greets + caller punches a digit + warm transfer) instead of a
    // direct 1:1 call. Spec: Specs/TEAM-RECEPTIONIST-IVR-SPEC.md §1b.
    final qDigits = q.replaceAll(RegExp(r'[^\d]'), '');
    final ivr = await TeamApi.ivrMenu(qDigits);
    if (!mounted) return;
    if (ivr != null) {
      Analytics.capture('avaphone_dial_team_ivr', const {});
      setState(() => _dialing = false);
      Navigator.pop(context); // close the dialpad
      Navigator.push(navContext, MaterialPageRoute(builder: (_) => TeamIvrScreen(teamNumber: qDigits)));
      return;
    }
    Contact? hit;
    try { hit = await Directory.resolve(q); } catch (_) { hit = null; }
    if (!mounted) return;
    if (hit == null || hit.uid.isEmpty) {
      // Not an AvaTOK account. When AvaDial is the default dialer (flag on + role
      // held), place a CARRIER PSTN call via TelecomManager and open the outgoing
      // call screen instead of dead-ending. Otherwise keep the existing message
      // (the number simply isn't reachable in-network).
      if (RemoteConfig.avaDialer && await AvaDialChannel.I.isDialerRoleHeld()) {
        if (!mounted) return;
        Analytics.capture('avadial_pstn_dial', {'len': q.length});
        setState(() => _dialing = false);
        Navigator.pop(context); // close the dialpad
        final placed = await AvaDialChannel.I.placeCall(q);
        if (placed) {
          Navigator.push(navContext,
              MaterialPageRoute(builder: (_) => OutgoingCallScreen(number: q)));
        }
        // placed == false → CALL_PHONE was not yet granted; the plugin kicked off the
        // runtime prompt, so the next dial (post-grant) connects. No dead-end.
        return;
      }
      Analytics.capture('avaphone_dial_unreachable', {'len': q.length});
      setState(() { _dialing = false; _status = 'No AvaTOK account on that number'; });
      return;
    }
    // WP6 (Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §3B):
    // before ringing, check whether the callee published a paid-call offer on
    // this number. [PaidCallApi.offer] returns null for every ordinary/free
    // number, so this is a no-op until a callee actually turns paid calls on.
    String paidHoldId = '';
    int paidMinutes = 0;
    // [CALL-ROOM-ID-1 2026-07-14] Mint the call id ONCE, here, and hand the same
    // one to both the escrow prompt and place1to1Call. Previously both sides
    // independently derived `'avatok-${hit.uid}'`, which "agreed" only because
    // it was a stable function of the callee — the very bug that made the
    // callee's dedup cache drop every repeat call. They must still agree (the
    // escrow hold + billing ticker are keyed to the CallRoom id), so agreement
    // is now achieved by passing one value instead of by two identical guesses.
    final dialRoom = CallRoomId.newRoomId();
    if (RemoteConfig.paidCalls) {
      // Offer lookup by the RESOLVED uid (the server route also accepts raw
      // numbers, but the uid is unambiguous — hit.uid is already in hand).
      final offer = await PaidCallApi.offer(to: hit.uid);
      if (!mounted) return;
      if (offer != null) {
        final result = await showPaidCallPrompt(
          context,
          offer: offer,
          to: qDigits,
          calleeUid: offer.calleeUid.isNotEmpty ? offer.calleeUid : hit.uid,
          // Must match place1to1Call's room id — the escrow hold + billing
          // ticker are keyed to this exact CallRoom id. Guaranteed by passing
          // `roomOverride: dialRoom` below rather than re-deriving it.
          callId: dialRoom,
        );
        if (result == null) {
          // Caller backed out at the price/length prompt (§11 — hold never taken).
          setState(() { _dialing = false; });
          return;
        }
        paidHoldId = result.holdId;
        paidMinutes = result.minutes;
        if (!mounted) return;
      }
    }
    Analytics.capture('avaphone_dial_connect', const {});
    IceCache.prefetch();
    final c = hit; // non-null local for the closure below
    Navigator.pop(context); // close the dialpad
    // [AVA-IDGATE-1] Dialing a resolved number now goes through /api/call so the
    // liveness gate applies (first call to a stranger) and the callee is actually
    // rung. On 403 the global interceptor opens the consent flow and the dial aborts.
    // [DIALPAD-DISMISS-FIX] Use navContext (captured above, before the pop) —
    // NOT the sheet's own `context` — since place1to1Call awaits a network call
    // and pushes CallScreen/the busy card afterwards; by then the sheet's
    // context would already be unmounted and every push would silently no-op.
    await place1to1Call(navContext, uid: c.uid,
        name: c.name.isNotEmpty ? c.name : (c.number.isNotEmpty ? c.number : q),
        avatarUrl: c.avatarUrl, dialer: true,
        paidHoldId: paidHoldId, paidMinutes: paidMinutes,
        roomOverride: dialRoom); // [CALL-ROOM-ID-1] same id as the escrow hold
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
        // Entered number. Long-press pastes a sanitized number from the
        // clipboard; a small paste icon appears when the clipboard holds one.
        SizedBox(
          height: 52,
          child: Row(children: [
            const SizedBox(width: 40),
            Expanded(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onLongPress: _pasteFromClipboard,
                child: Center(
                  child: Text(_digits.isEmpty ? 'AvaTOK number' : _digits,
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: PhoneTheme.title(size: 30,
                          color: _digits.isEmpty ? PhoneTheme.textMute : PhoneTheme.text)),
                ),
              ),
            ),
            SizedBox(
              width: 40,
              child: _clipboardHasNumber
                  ? IconButton(
                      padding: EdgeInsets.zero,
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Paste number',
                      onPressed: _pasteFromClipboard,
                      icon: PhosphorIcon(PhosphorIcons.clipboard(PhosphorIconsStyle.bold),
                          size: 22, color: PhoneTheme.teal),
                    )
                  : null,
            ),
          ]),
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
