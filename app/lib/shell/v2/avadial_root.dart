import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../features/avadial/avadial_channel.dart';
import '../../features/avadial/avadial_refresh.dart';
import '../../features/avadial/avadial_theme.dart';
import '../../features/avadial/block_list.dart';
import '../../features/avadial/contact_overrides.dart';
import '../../features/avadial/contact_row_menu.dart';
import '../../features/avadial/device_call_log.dart';
import '../../features/avadial/device_contacts.dart';
import '../../features/avadial/dialpad_search_tab.dart';
import '../../features/avatok/contact_profile_screen.dart';
import '../../features/avatok/contacts.dart';
import '../../features/avatok/invite_screen.dart';
import '../../features/avatok/place_1to1_call.dart';
import '../shell_v2.dart';
import 'shell_chrome.dart';

// [AVADIAL-AVATOK-ONLY-1] 2026-07-16 pivot (owner decision): AvaDial drops the
// carrier/PSTN Messages tab (SMS) and the just-added Inbox tab (moved to the
// main shell footer by another lane) — see the tab strip below. The Contacts
// and Dialpad tabs are rebuilt on the AvaTOK directory only; see
// features/avadial/dialpad_search_tab.dart and _ContactsTab below.

/// AvaDial ("Calls") root — the PSTN phone world (plan §4). 2026-07-12 redesign:
/// the five sub-sections (Contacts · Messages · Dialpad · Block · Logs) are now a
/// row of COLOR-CODED tabs BELOW the app bar (see [_CallsTabStrip]) instead of a
/// bottom nav bar — the bottom of the screen is reserved for the shell-wide
/// [AppSwitcherBar] (AvaTOK · Calls · Marketplace · Ava), which stays in the same
/// place across every app.
///
/// When the `avaDialer` remote flag is OFF (default) the Contacts/Logs/
/// Block tabs render the Phase-1 placeholder empty states and NO telecom role is
/// ever requested. When the flag is ON, they render the live device phone book,
/// device call log and account-scoped block list, backed by the native telecom
/// layer (Specs/SPIKE-2026-07-12-avadial-telecom.md). Messages stays a placeholder
/// until the SMS role lands (Phase 3).
class AvaDialRoot extends StatefulWidget {
  const AvaDialRoot({super.key});

  @override
  State<AvaDialRoot> createState() => _AvaDialRootState();
}

class _AvaDialRootState extends State<AvaDialRoot> {
  int _tab = 0;

  // Each sub-section gets its OWN color (owner request — "give each tab header a
  // different color, so users can recognise it"), reusing the same accents the
  // empty states already used for these tabs so the palette stays consistent.
  // Tab order (owner pivot 2026-07-16): Contacts · Dialpad · Block list ·
  // Call logs. The IndexedStack bodies below MUST stay in this same order
  // (index maps positionally).
  //
  // [AVADIAL-AVATOK-ONLY-1] Messages (SMS) and Inbox (voicemail, moved to the
  // main shell footer by another lane) are REMOVED here, not just hidden —
  // AvaDial is avatok-to-avatok only now, so there is no carrier SMS surface
  // left on this screen. The `avaSms`/`pstnVoicemail`-gated bodies and the
  // SmsUnreadStore badge are gone with them; the underlying sms/ and inbox/
  // feature folders are untouched for whoever still owns those surfaces.
  static const _items = [
    _CallsTabItem(Icons.person_outline, Icons.person, 'Contacts', AD.iconSearch),
    _CallsTabItem(Icons.dialpad_outlined, Icons.dialpad, 'Dialpad', AD.primaryBadge),
    _CallsTabItem(Icons.block_outlined, Icons.block, 'Block list', AD.danger),
    _CallsTabItem(Icons.history_outlined, Icons.history, 'Call logs', AD.online),
  ];

  @override
  void initState() {
    super.initState();
    // Wire the native → Dart event bridge only when the feature is live, so the
    // channel handler is never installed on a dark build.
    if (RemoteConfig.avaDialer) {
      AvaDialChannel.I.ensureWired();
      // [AVADIAL-NATIVE-RING-1] Ringing UI is now the dedicated NATIVE
      // IncomingCallActivity launched by AvaInCallService — independent of the
      // app, over any app / the lock screen, self-closing when the call dies.
      // The old in-app PstnCallScreen push on 'ringing' is gone (it opened the
      // whole app and raced the landing page + setup sheet — owner bug
      // 2026-07-14). Dart only handles the ANSWERED hand-off (shell_v2
      // _openIncoming → InCallScreen).
      //
      // [AVADIAL-SETUP-3] The setup sheet no longer auto-pops here either —
      // it lives in Account & Settings → Settings → "Default phone & messages"
      // (owner request 2026-07-14, pic 1).
    }
  }

  @override
  void dispose() {
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // The Calls app is dark end-to-end (owner request 2026-07-12) — see
      // avadial_theme.dart, which mirrors AvaPhone's existing dark palette.
      backgroundColor: AvaDialTheme.bg,
      drawer: const ShellSidebar(current: RootId.avaDial),
      appBar: _bar(context),
      // No bottomNavigationBar here anymore (2026-07-12): the persistent shell-wide
      // AppSwitcherBar owns the bottom of the screen now. Calls' own sub-sections
      // moved to a colored tab STRIP below the app bar instead (see body below).
      body: SafeArea(
        top: false,
        child: Column(children: [
          _CallsTabStrip(
            items: _items,
            selectedIndex: _tab,
            onSelected: (i) => setState(() => _tab = i),
          ),
          Expanded(
            // Rebuild when a config fetch lands so flipping `avaDialer` in KV
            // surfaces the live tabs without an app restart.
            child: ValueListenableBuilder<int>(
              valueListenable: RemoteConfig.revision,
              builder: (context, _, __) {
                final on = RemoteConfig.avaDialer;
                if (on) AvaDialChannel.I.ensureWired();
                // Bodies MUST match the _items tab order:
                // Contacts · Dialpad · Block list · Call logs.
                return IndexedStack(index: _tab, children: [
              // Contacts — AvaTOK-network contacts only (owner pivot
              // 2026-07-16); see _ContactsTab. Not gated on `avaDialer` (the
              // old default-phone-app telecom flag) since it no longer reads
              // the device phone book or telecom role at all.
              const _ContactsTab(),
              // Dialpad — the Calls app's OWN avatok-to-avatok dialer: live
              // AvaTOK-directory search above a real keypad. No PSTN dial-out
              // path exists here anymore (owner pivot 2026-07-16).
              const DialpadSearchTab(),
              on
                  ? const _BlockTab()
                  : const ShellEmptyState(
                      icon: Icons.block_outlined,
                      title: 'Block list',
                      subtitle: 'Blocked numbers and one-tap spam reports — coming with AvaDial.',
                      color: AD.danger,
                    ),
              on
                  ? const _LogsTab()
                  : const ShellEmptyState(
                      icon: Icons.history_outlined,
                      title: 'Call logs',
                      subtitle:
                          'Your device call history with friend/spam labels — coming with AvaDial.',
                      color: AD.online,
                    ),
                ]);
              },
            ),
          ),
        ]),
      ),
    );
  }

  PreferredSizeWidget _bar(BuildContext context) => AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        leading: Builder(
          builder: (ctx) => IconButton(
            icon: PhosphorIcon(PhosphorIcons.list(PhosphorIconsStyle.bold), color: AvaDialTheme.text),
            onPressed: () => Scaffold.of(ctx).openDrawer(),
          ),
        ),
        title: Text('AvaDialer', style: ADText.appTitle(c: AvaDialTheme.text)),
      );
}

/// One Calls sub-section: icon/label pair plus its OWN recognisable color.
class _CallsTabItem {
  final IconData icon;
  final IconData selectedIcon;
  final String label;
  final Color color;
  const _CallsTabItem(this.icon, this.selectedIcon, this.label, this.color);
}

/// The Calls app's own colored tab strip (2026-07-12 redesign), rendered BELOW
/// the app bar instead of as a bottom nav bar — the bottom of the screen belongs
/// to the shell-wide [AppSwitcherBar] now. Each tab is filled with its own accent
/// color when active ("give each tab header a different color, so users can
/// recognise it" — owner spec) and scrolls horizontally on narrow phones.
class _CallsTabStrip extends StatelessWidget {
  final List<_CallsTabItem> items;
  final int selectedIndex;
  final ValueChanged<int> onSelected;
  const _CallsTabStrip({
    required this.items,
    required this.selectedIndex,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AvaDialTheme.surface,
        border: Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              _tab(items[i], i == selectedIndex, () => onSelected(i)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _tab(_CallsTabItem item, bool selected, VoidCallback onTap) {
    // White text/icons on the bright accent fill (dark v2's accent-fill +
    // white-label convention, see AdChip's active state); light text on the
    // dark, unselected surface.
    final fg = selected ? Colors.white : AvaDialTheme.text;
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? item.color : AvaDialTheme.surface2,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: AvaDialTheme.border, width: 1),
          boxShadow: const [],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(selected ? item.selectedIcon : item.icon, size: 17, color: fg),
          const SizedBox(width: 6),
          Text(item.label, style: ADText.tabLabel(c: fg)),
        ]),
      ),
    );
  }
}

/// Onboarding hook (plan §4.2): "Make Ava your phone app" → ROLE_DIALER request.
/// Shown at the top of the device tabs until AvaDial holds the dialer role. Only
/// ever built when the `avaDialer` flag is on.
class _RoleBanner extends StatefulWidget {
  const _RoleBanner();

  @override
  State<_RoleBanner> createState() => _RoleBannerState();
}

class _RoleBannerState extends State<_RoleBanner> {
  bool _held = true; // assume held → banner hidden until we learn otherwise
  bool _busy = false;
  StreamSubscription<AvaRoleResult>? _sub;

  @override
  void initState() {
    super.initState();
    _refresh();
    // The verdict arrives asynchronously after the system prompt.
    _sub = AvaDialChannel.I.roleResults.listen((r) {
      if (!mounted) return;
      if (r.role.contains('DIALER')) {
        Analytics.capture(
            r.granted ? 'avadial_role_granted' : 'avadial_role_denied', {'role': 'dialer'});
        _refresh();
      }
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final held = await AvaDialChannel.I.isDialerRoleHeld();
    if (mounted) setState(() => _held = held);
  }

  Future<void> _request() async {
    if (_busy) return;
    setState(() => _busy = true);
    final immediate = await AvaDialChannel.I.requestDialerRole();
    if (immediate == true) {
      Analytics.capture('avadial_role_granted', {'role': 'dialer', 'via': 'already_held'});
      await _refresh();
    }
    // Otherwise the verdict comes via roleResults; capture there.
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_held) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
      child: AdCard(
        color: AD.card,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), color: AD.iconShield),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Make Ava your phone app', style: ADText.threadName(c: AvaDialTheme.text)),
              const SizedBox(height: 2),
              Text('Screen spam, see your call log and block numbers.',
                  style: ADText.preview(c: AvaDialTheme.textSoft)),
            ]),
          ),
          const SizedBox(width: 10),
          AdButton(
            label: 'Enable',
            variant: AdButtonVariant.teal,
            fontSize: 14,
            trailingIcon: false,
            loading: _busy,
            onPressed: _request,
          ),
        ]),
      ),
    );
  }
}

// ── Contacts tab ─────────────────────────────────────────────────────────────
// [AVADIAL-AVATOK-ONLY-1] 2026-07-16 pivot: this used to be the DEVICE phone
// book (Truecaller-style: DeviceContacts + ContactOverrides + colour groups +
// a device-contacts backup card). AvaDial no longer reads the device address
// book anywhere in this tab. It now shows the same AvaTOK contact book AvaTOK
// chat/AvaPhone already use — [ContactsStore] (features/avatok/contacts.dart)
// — filtered to entries that carry an AvaTOK number, i.e. real network members
// (mirrors features/avaphone/ava_phone_contacts.dart's `_avatok` getter). New
// contacts are added by resolving an AvaTOK number or email through the same
// public directory lookup ([Directory.resolve]/[Directory.search]) the rest of
// the app uses — never by importing the phone's contacts.
class _ContactsTab extends StatefulWidget {
  const _ContactsTab();

  @override
  State<_ContactsTab> createState() => _ContactsTabState();
}

class _ContactsTabState extends State<_ContactsTab> {
  final _store = ContactsStore();
  List<Contact> _all = const [];
  bool _loaded = false;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final cs = await _store.load();
    if (!mounted) return;
    setState(() { _all = cs; _loaded = true; });
  }

  /// AvaTOK-network contacts only (a number means a resolved account) —
  /// matches AvaPhoneContacts' rule so the two contact books stay conceptually
  /// identical. Search matches name, number OR email (the saved-list filter is
  /// a plain local substring match; DISCOVERING a new person, below in
  /// [_AddAvaTokContactDialog], goes through the number/email-only directory
  /// lookup per the owner spec).
  List<Contact> get _filtered {
    final members = _all.where((c) => c.number.isNotEmpty).toList();
    final q = _query.trim().toLowerCase();
    final list = q.isEmpty
        ? members
        : members.where((c) =>
            c.name.toLowerCase().contains(q) ||
            c.number.toLowerCase().contains(q) ||
            c.email.toLowerCase().contains(q)).toList();
    list.sort((a, b) => (a.name.isNotEmpty ? a.name : a.number)
        .toLowerCase()
        .compareTo((b.name.isNotEmpty ? b.name : b.number).toLowerCase()));
    return list;
  }

  Future<void> _addContact() async {
    final saved = await showDialog<Contact>(
      context: context,
      builder: (_) => const _AddAvaTokContactDialog(),
    );
    if (saved == null) return;
    final list = await _store.add(saved);
    if (!mounted) return;
    setState(() => _all = list);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Saved ${saved.name.isNotEmpty ? saved.name : saved.number}')));
    Analytics.capture('avadial_contact_added', const {});
  }

  /// Tap → the shared AvaTOK profile popup (QR + email + number + name) — the
  /// SAME [ContactProfileScreen] chat/AvaPhone use, reused verbatim per the
  /// lane brief rather than building a second profile surface.
  void _openProfile(Contact c) {
    Navigator.push(context, MaterialPageRoute<void>(
        builder: (_) => ContactProfileScreen(name: c.name, uid: c.uid)));
  }

  Future<void> _call(Contact c) async {
    Analytics.capture('avadial_contact_call', const {});
    await place1to1Call(context, uid: c.uid, name: c.name.isNotEmpty ? c.name : c.number,
        avatarUrl: c.avatarUrl, dialer: true);
  }

  Future<void> _deleteContact(Contact c) async {
    final list = await _store.remove(c.uid);
    if (mounted) setState(() => _all = list);
  }

  /// Long-press menu (owner spec): "Call on AvaTOK" for a saved member. A
  /// non-member ("Invite") row never reaches this list — [ContactsStore] only
  /// ever stores a resolved uid, so an unresolved number is handled inline at
  /// add-time by [_AddAvaTokContactDialog]'s own "Not on AvaTOK → Invite" state
  /// instead of being persisted as a fake contact.
  void _openMenu(Contact c) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AvaDialTheme.surface2,
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: AvaDialTheme.border, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 10),
        ListTile(
          leading: Container(
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
            child: Avatar(seed: c.uid, name: c.name, size: 44,
                avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
          ),
          title: Text(c.name.isNotEmpty ? c.name : c.number, style: ADText.rowName(c: AvaDialTheme.text)),
          subtitle: Text(c.number, style: ADText.preview(c: AvaDialTheme.textSoft)),
        ),
        const Divider(color: AvaDialTheme.border, height: 1),
        ListTile(
          leading: const Icon(Icons.call, color: AD.incomingCall),
          title: Text('Call on AvaTOK', style: ADText.rowName(c: AvaDialTheme.text)),
          onTap: () { Navigator.pop(ctx); _call(c); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.user(PhosphorIconsStyle.bold), color: AD.iconSearch),
          title: Text('View profile', style: ADText.rowName(c: AvaDialTheme.text)),
          onTap: () { Navigator.pop(ctx); _openProfile(c); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: AD.danger),
          title: Text('Delete contact', style: ADText.rowName(c: AD.danger)),
          onTap: () { Navigator.pop(ctx); _deleteContact(c); },
        ),
        const SizedBox(height: 8),
      ])),
    );
  }

  Future<void> _invite() async {
    Analytics.capture('avadial_invite_friends', const {});
    await Navigator.of(context, rootNavigator: true).push(
        MaterialPageRoute<void>(builder: (_) => const InviteScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final list = _filtered;
    return Stack(children: [
      Column(children: [
        // Explicit clarification banner (mirrors AvaPhoneContacts, owner spec):
        // these are AvaTOK-network identities, never the phone's address book.
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
          child: AdCard(
            color: AvaDialTheme.surface2,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), size: 16, color: AD.online),
              const SizedBox(width: 8),
              Expanded(child: Text(
                  'AvaTOK contacts only — not your phone’s address book.',
                  style: ADText.preview(c: AvaDialTheme.textSoft))),
              IconButton(
                onPressed: _invite,
                tooltip: 'Invite friends',
                icon: PhosphorIcon(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.bold),
                    size: 18, color: AD.iconSearch),
              ),
            ]),
          ),
        ),
        // Search bar — number/email/name over the SAVED list (owner spec §4:
        // discovering someone NEW is number/email only, via the directory
        // lookup in _AddAvaTokContactDialog below).
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: BoxDecoration(
              color: AvaDialTheme.searchFill,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: AvaDialTheme.border, width: 1),
            ),
            child: Row(children: [
              const Icon(Icons.search, color: AvaDialTheme.searchHint, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  onChanged: (v) => setState(() => _query = v),
                  cursorColor: AvaDialTheme.searchText,
                  style: const TextStyle(color: AvaDialTheme.searchText, fontSize: 14.5),
                  decoration: const InputDecoration(
                    hintText: 'Search by AvaTOK number, email or name',
                    hintStyle: TextStyle(color: AvaDialTheme.searchHint, fontSize: 14.5),
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(vertical: 12),
                  ),
                ),
              ),
            ]),
          ),
        ),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent))
              : (list.isEmpty ? _empty() : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 96),
                  itemCount: list.length,
                  itemBuilder: (context, i) => _row(list[i]),
                )),
        ),
      ]),
      Positioned(
        right: 18,
        bottom: 18,
        child: FloatingActionButton(
          heroTag: 'avadial_add_contact',
          backgroundColor: AD.iconSearch,
          foregroundColor: Colors.white,
          onPressed: _addContact,
          child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), color: Colors.white),
        ),
      ),
    ]);
  }

  Widget _row(Contact c) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: GestureDetector(
          onTap: () => _openProfile(c),
          onLongPress: () => _openMenu(c),
          // [AVADIAL-AVATOK-ONLY-1] Tinted card (owner spec: "tinted/colored to
          // show they're on the AvaTOK network") — a translucent green wash over
          // the normal dark card, distinct from every other AvaDial list row.
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: AD.online.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(AD.rListCard),
              border: Border.all(color: AD.online.withValues(alpha: 0.35), width: 1),
            ),
            child: Row(children: [
              Container(
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
                child: Avatar(seed: c.uid, name: c.name, size: 44,
                    avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(c.name.isNotEmpty ? c.name : c.number,
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ADText.threadName(c: AvaDialTheme.text)),
                  const SizedBox(height: 3),
                  Row(children: [
                    PhosphorIcon(PhosphorIcons.hash(PhosphorIconsStyle.bold), size: 12, color: AD.online),
                    const SizedBox(width: 3),
                    Text(c.number, style: ADText.preview(c: AD.online)),
                  ]),
                ]),
              ),
              IconButton(
                onPressed: () => _call(c),
                icon: const Icon(Icons.call, color: AD.incomingCall),
              ),
              IconButton(
                icon: const Icon(Icons.more_vert, color: AvaDialTheme.textSoft),
                onPressed: () => _openMenu(c),
              ),
            ]),
          ),
        ),
      );

  Widget _empty() => ListView(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        children: [
          const SizedBox(height: 72),
          ZineIconBadge(icon: PhosphorIcons.addressBook(PhosphorIconsStyle.bold), color: AD.iconSearch, size: 56),
          const SizedBox(height: 16),
          Text(_query.isEmpty ? 'No AvaTOK contacts yet' : 'No matches',
              textAlign: TextAlign.center,
              style: ADText.threadName(c: AvaDialTheme.text).copyWith(fontSize: 18)),
          const SizedBox(height: 8),
          Text('Add someone by their AvaTOK number or email, or invite a friend.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AvaDialTheme.textSoft).copyWith(fontSize: 14)),
          const SizedBox(height: 20),
          Center(
            child: AdButton(
              label: 'Add contact',
              variant: AdButtonVariant.teal,
              trailingIcon: false,
              onPressed: _addContact,
            ),
          ),
        ],
      );
}

/// "Save contact" — resolves a typed AvaTOK number or email against the public
/// directory ([Directory.resolve]) exactly like the dialpad and AvaPhoneContacts
/// do. On no hit, offers "Invite" instead of silently failing (owner spec).
class _AddAvaTokContactDialog extends StatefulWidget {
  const _AddAvaTokContactDialog();

  @override
  State<_AddAvaTokContactDialog> createState() => _AddAvaTokContactDialogState();
}

class _AddAvaTokContactDialogState extends State<_AddAvaTokContactDialog> {
  final _ctrl = TextEditingController();
  bool _resolving = false;
  String? _error;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _resolve() async {
    final q = _ctrl.text.trim();
    final digits = q.replaceAll(RegExp(r'[^\d]'), '');
    final looksEmail = q.contains('@');
    if (digits.length < 4 && !looksEmail) {
      setState(() => _error = 'Enter an AvaTOK number or email');
      return;
    }
    setState(() { _resolving = true; _error = null; });
    Analytics.capture('avadial_contact_resolve', {'len': q.length});
    Contact? hit;
    try { hit = await Directory.resolve(q); } catch (_) { hit = null; }
    if (!mounted) return;
    if (hit == null || hit.uid.isEmpty) {
      setState(() { _resolving = false; _error = 'not_on_avatok'; });
      return;
    }
    final saved = hit.number.isNotEmpty
        ? hit
        : Contact(uid: hit.uid, name: hit.name, email: hit.email, avatarUrl: hit.avatarUrl, number: q);
    Navigator.pop(context, saved);
  }

  @override
  Widget build(BuildContext context) {
    final notOnAvaTok = _error == 'not_on_avatok';
    return AlertDialog(
      backgroundColor: AvaDialTheme.surface2,
      shape: RoundedRectangleBorder(
        side: const BorderSide(color: AvaDialTheme.border, width: 1),
        borderRadius: BorderRadius.circular(AD.rDialog),
      ),
      title: Text('Add AvaTOK contact', style: ADText.threadName(c: AvaDialTheme.text)),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Save someone by their AvaTOK number or email.',
            style: ADText.preview(c: AvaDialTheme.textSoft)),
        const SizedBox(height: 12),
        TextField(
          controller: _ctrl,
          autofocus: true,
          style: TextStyle(color: AvaDialTheme.text),
          decoration: InputDecoration(
            hintText: 'AvaTOK number or email',
            hintStyle: TextStyle(color: AvaDialTheme.textSoft),
            enabledBorder: const UnderlineInputBorder(
                borderSide: BorderSide(color: AvaDialTheme.border)),
            focusedBorder: const UnderlineInputBorder(
                borderSide: BorderSide(color: AvaDialTheme.accent)),
          ),
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) => _resolve(),
        ),
        if (_error != null && !notOnAvaTok)
          Padding(padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: ADText.preview(c: AD.danger))),
        if (notOnAvaTok)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text('Not on AvaTOK yet — invite them instead?',
                style: ADText.preview(c: AD.danger)),
          ),
      ]),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text('Cancel', style: ADText.rowName(c: AvaDialTheme.textSoft)),
        ),
        if (notOnAvaTok)
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              Navigator.of(context, rootNavigator: true).push(
                  MaterialPageRoute<void>(builder: (_) => const InviteScreen()));
            },
            child: Text('Invite', style: ADText.rowName(c: AD.online)),
          )
        else
          TextButton(
            onPressed: (_ctrl.text.trim().isEmpty || _resolving) ? null : _resolve,
            child: _resolving
                ? const SizedBox(width: 16, height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AvaDialTheme.accent))
                : Text('Find & save', style: ADText.rowName(c: AvaDialTheme.accent)),
          ),
      ],
    );
  }
}

// ── Logs tab ─────────────────────────────────────────────────────────────────
// ── Shared search ────────────────────────────────────────────────────────────
/// [AVADIAL-SEARCH-1] Instant-search field for the Calls tabs. Filtering runs on
/// every keystroke via [onChanged] — no submit, no debounce: these lists are
/// already in memory, so filtering is a cheap synchronous pass.
///
/// The Contacts tab keeps its own inline copy of this bar (it predates this
/// widget and sits inside a bespoke layout with the group circles) — do not
/// refactor it into this one without re-testing the group filter.
class _AvaDialSearchBar extends StatefulWidget {
  const _AvaDialSearchBar({required this.hint, required this.onChanged});

  final String hint;
  final ValueChanged<String> onChanged;

  @override
  State<_AvaDialSearchBar> createState() => _AvaDialSearchBarState();
}

class _AvaDialSearchBarState extends State<_AvaDialSearchBar> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _emit(String v) {
    // setState only drives the clear "×" showing/hiding; the parent owns the query.
    setState(() {});
    widget.onChanged(v);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          // [AVADIAL-SEARCH-2] White pill, black text (owner spec).
          color: AvaDialTheme.searchFill,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: AvaDialTheme.border, width: 1),
        ),
        child: Row(children: [
          const Icon(Icons.search, color: AvaDialTheme.searchHint, size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: _controller,
              onChanged: _emit,
              textInputAction: TextInputAction.search,
              // The app-wide cursor/selection colours are tuned for the dark
              // surface and vanish on white — pin them to the input's own ink.
              cursorColor: AvaDialTheme.searchText,
              style: const TextStyle(color: AvaDialTheme.searchText, fontSize: 14.5),
              decoration: InputDecoration(
                hintText: widget.hint,
                hintStyle: const TextStyle(color: AvaDialTheme.searchHint, fontSize: 14.5),
                border: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 12),
              ),
            ),
          ),
          if (_controller.text.isNotEmpty)
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                _controller.clear();
                _emit('');
              },
              child: const Padding(
                padding: EdgeInsets.only(left: 6),
                child: Icon(Icons.close, color: AvaDialTheme.searchHint, size: 18),
              ),
            ),
        ]),
      ),
    );
  }
}

/// [AVADIAL-SEARCH-1] Shared match test for the Calls search bars: case-insensitive
/// substring on any of [texts], OR a number match through [DeviceContacts.normKey]
/// — the same normalisation the rest of the Calls app keys on, so a query of
/// '2079460958' still finds a row stored as '+44 (20) 7946-0958'. (Stripping spaces
/// alone leaves brackets/dashes behind and silently misses.) An empty query matches
/// everything, so callers can pass it through unguarded.
bool _avaDialMatches(String query, {String? number, List<String?> texts = const []}) {
  final q = query.trim();
  if (q.isEmpty) return true;
  final qLower = q.toLowerCase();
  for (final t in texts) {
    if (t != null && t.toLowerCase().contains(qLower)) return true;
  }
  if (number != null && RegExp(r'\d').hasMatch(q)) {
    final qKey = DeviceContacts.normKey(q);
    if (qKey.isNotEmpty && DeviceContacts.normKey(number).contains(qKey)) return true;
  }
  return false;
}

class _LogsTab extends StatefulWidget {
  const _LogsTab();

  @override
  State<_LogsTab> createState() => _LogsTabState();
}

class _LogsTabState extends State<_LogsTab> {
  late Future<(List<DeviceCall>, Map<String, ContactOverride>, Set<String>, Set<String>)> _future;
  String _query = '';
  // [AVADIAL-LOG-LIVE-1] Live call-end subscriptions — see initState.
  StreamSubscription<String>? _endedSub;
  StreamSubscription<AvaCallEvent>? _stateSub;
  // Coalesces the refresh: one hangup can raise BOTH 'disconnected' and
  // 'onCallRemoved' (and 'disconnected' can repeat), which would otherwise stack
  // several overlapping re-read passes for a single call.
  bool _refreshingAfterCall = false;

  @override
  void initState() {
    super.initState();
    _future = _loadAll();
    avaDialRev.addListener(_onRev);
    // [AVADIAL-LOG-LIVE-1] (owner report 2026-07-15, pic2 "call log does not
    // update automatically, I have to pull to refresh")
    //
    // Nothing told this tab a call had happened. It lives inside an IndexedStack,
    // so it is built ONCE and stays alive forever; `_future` was resolved in
    // initState and then never re-run except by the user's pull-to-refresh. Hang
    // up, walk back to Logs, and you were looking at a snapshot from whenever the
    // tab first mounted.
    //
    // `onCallRemoved` fires the moment a PSTN call leaves the connection list, and
    // `onCallState` -> 'disconnected' covers the paths that never produce a removal
    // (rejected/failed dials). Either one means "the OS call log just gained a row".
    _endedSub = AvaDialChannel.I.removedCalls.listen((_) => _refreshAfterCall('removed'));
    _stateSub = AvaDialChannel.I.calls.listen((e) {
      if (e.state == 'disconnected') _refreshAfterCall('disconnected');
    });
  }

  @override
  void dispose() {
    _endedSub?.cancel();
    _stateSub?.cancel();
    avaDialRev.removeListener(_onRev);
    super.dispose();
  }

  void _onRev() {
    if (mounted) setState(() => _future = _loadAll());
  }

  /// [AVADIAL-LOG-LIVE-1] Re-read the OS call log once a call finishes.
  ///
  /// MUST be `force: true`: [DeviceCallLog] holds an in-memory cache and a plain
  /// `load()` returns it verbatim, so a non-forced reload would rebuild the list
  /// from the very snapshot we're trying to replace and change nothing on screen.
  ///
  /// The delay is not superstition. Android's CallLog provider is written by the
  /// telephony stack ASYNCHRONOUSLY, shortly AFTER the call is torn down — query it
  /// the instant `onCallRemoved` lands and the new row frequently isn't there yet,
  /// which would leave the tab looking exactly as broken as before. We re-read
  /// twice: once quickly for the common case, once ~1.2s later as the backstop.
  /// Both are cheap content-resolver reads, and both are no-ops if nothing changed.
  Future<void> _refreshAfterCall(String reason) async {
    if (!mounted || _refreshingAfterCall) return;
    _refreshingAfterCall = true;
    try {
      for (final wait in const [Duration(milliseconds: 350), Duration(milliseconds: 1200)]) {
        await Future<void>.delayed(wait);
        if (!mounted) return;
        setState(() => _future = _loadAll(force: true));
      }
      Analytics.capture('avadial_calllog_auto_refresh', {'reason': reason});
    } finally {
      _refreshingAfterCall = false;
    }
  }

  Future<(List<DeviceCall>, Map<String, ContactOverride>, Set<String>, Set<String>)> _loadAll({bool force = false}) async {
    final all = await DeviceCallLog.I.load(force: force);
    final hidden = await HiddenCallLog.I.load();
    // Drop rows the user deleted from AvaTOK's view (never touches the OS log).
    final logs = all.where((e) => !hidden.contains(HiddenCallLog.keyFor(e.number, e.date))).toList();
    final overrides = {for (final o in await ContactOverrides.I.load()) DeviceContacts.normKey(o.number): o};
    final blocked = {for (final b in await BlockList.I.load()) DeviceContacts.normKey(b.number)};
    return (logs, overrides, blocked, hidden);
  }

  Future<void> _reload() async {
    setState(() => _future = _loadAll(force: true));
  }

  /// "Delete history" — hides every currently-visible call from AvaTOK's view.
  Future<void> _clearHistory(List<DeviceCall> logs) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rDialog),
        ),
        title: Text('Clear call history?', style: ADText.threadName(c: AvaDialTheme.text)),
        content: Text(
          'This hides these calls from AvaTOK. Your phone\'s own call log is not '
          'touched.',
          style: ADText.preview(c: AvaDialTheme.textSoft).copyWith(fontSize: 13.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ADText.rowName(c: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Clear', style: ADText.rowName(c: AD.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await HiddenCallLog.I.hideAll(logs.map((e) => HiddenCallLog.keyFor(e.number, e.date)));
    Analytics.capture('avadial_call_history_cleared', {'count': logs.length});
    _reload();
  }

  /// [AVADIAL-LOG-EXPORT-1] Write the visible call log to a .txt and hand it to
  /// the OS share sheet (Files, Gmail, WhatsApp, Drive — the user's choice).
  ///
  /// Uses the SAME display name the row renders (override first, then the OS
  /// cached name), so the file reads like the screen it came from.
  Future<void> _exportLogs(
      List<DeviceCall> logs, Map<String, ContactOverride> overrides) async {
    try {
      final b = StringBuffer()
        ..writeln('AvaTOK call log')
        ..writeln('Exported ${_stamp(DateTime.now())}')
        ..writeln('${logs.length} call${logs.length == 1 ? '' : 's'}')
        ..writeln();
      for (final e in logs) {
        final name = overrides[DeviceContacts.normKey(e.number)]?.displayName ??
            e.cachedName;
        final who = (name == null || name.trim().isEmpty) ? e.number : '$name (${e.number})';
        final dur = e.duration.inSeconds > 0 ? ' · ${_dur(e.duration)}' : '';
        b.writeln('${_stamp(e.date)} · ${e.type.name}$dur · $who');
      }
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/avatok_call_log.txt');
      await f.writeAsString(b.toString(), flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: 'text/plain')],
          subject: 'AvaTOK call log');
      Analytics.capture('avadial_calllog_exported', {'count': logs.length});
    } catch (e) {
      if (!mounted) return;
      // Export is user-initiated, so a silent failure would just look broken.
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Couldn't export the call log.")),
      );
      Analytics.capture('avadial_calllog_export_failed', {'error': e.toString()});
    }
  }

  /// Local, unambiguous timestamp for the export file — deliberately not the
  /// relative "15/7 10:58" the list shows, which is useless in a saved document.
  static String _stamp(DateTime d) {
    String p(int v) => v.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
  }

  static String _dur(Duration d) {
    final m = d.inMinutes, s = d.inSeconds % 60;
    return m > 0 ? '${m}m ${s}s' : '${s}s';
  }

  IconData _iconFor(DeviceCallType t) => switch (t) {
        DeviceCallType.outgoing => Icons.call_made,
        DeviceCallType.missed => Icons.call_missed,
        DeviceCallType.rejected => Icons.call_end,
        DeviceCallType.blocked => Icons.block,
        _ => Icons.call_received,
      };

  Color _colorFor(DeviceCallType t) => switch (t) {
        DeviceCallType.missed || DeviceCallType.rejected || DeviceCallType.blocked => AD.danger,
        DeviceCallType.outgoing => AD.online,
        _ => AD.iconSearch,
      };

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      const _RoleBanner(),
      // [AVADIAL-SEARCH-1] Instant name/number filter over the call log.
      _AvaDialSearchBar(
        hint: 'Search calls by name or number',
        onChanged: (v) {
          // Fire once per search session (empty → typing), never per keystroke.
          if (_query.trim().isEmpty && v.trim().isNotEmpty) {
            Analytics.capture('avadial_search_started', const {'tab': 'call_logs'});
          }
          setState(() => _query = v);
        },
      ),
      Expanded(
        child: FutureBuilder<(List<DeviceCall>, Map<String, ContactOverride>, Set<String>, Set<String>)>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
            }
            final (logs, overrides, blocked, _) = snap.data ??
                (const <DeviceCall>[], const <String, ContactOverride>{}, const <String>{}, const <String>{});
            if (logs.isEmpty) {
              return _PermState(
                icon: Icons.history_outlined,
                title: 'No call history',
                subtitle:
                    'Make Ava your phone app to see and label your device call log.',
                color: AD.online,
                onRetry: _reload,
              );
            }
            // [AVADIAL-SEARCH-1] Match on the SAME display name the row renders
            // (override first, then the OS cached name) so what you see is what
            // you can search for, plus the number.
            final visible = logs.where((e) {
              final key = DeviceContacts.normKey(e.number);
              final displayName = overrides[key]?.displayName ?? e.cachedName;
              return _avaDialMatches(_query, number: e.number, texts: [displayName]);
            }).toList();
            if (visible.isEmpty) {
              return Center(
                child: Text('No matches', style: ADText.preview(c: AvaDialTheme.textSoft)),
              );
            }
            return RefreshIndicator(
              onRefresh: _reload,
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
                itemCount: visible.length + 1,
                itemBuilder: (context, idx) {
                  if (idx == 0) {
                    // Toolbar: count + "Clear history". Both follow the SEARCH
                    // results on purpose — "Clear history" is documented as hiding
                    // every currently-visible call, so with a query active it must
                    // not silently wipe rows the user can't see.
                    return Padding(
                      padding: const EdgeInsets.fromLTRB(2, 4, 2, 6),
                      child: Row(children: [
                        Text('${visible.length} call${visible.length == 1 ? '' : 's'}',
                            style: ADText.statCaption(c: AvaDialTheme.textMute)),
                        const Spacer(),
                        // [AVADIAL-LOG-EXPORT-1] (owner request 2026-07-15) Export
                        // the log as a plain .txt and hand it to the OS share sheet
                        // — the user picks Files / Gmail / WhatsApp / anything.
                        // Deliberately client-side: unlike the chat export there's
                        // no media and no size to speak of, so a backend queue and
                        // an email round-trip would be pure overhead.
                        //
                        // Exports `visible`, matching "Clear history" — with a
                        // search active, both act on exactly the rows on screen.
                        TextButton.icon(
                          onPressed: () => _exportLogs(visible, overrides),
                          icon: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
                              color: AvaDialTheme.accent, size: 17),
                          label: Text('Export',
                              style: ADText.rowName(c: AvaDialTheme.accent)),
                        ),
                        TextButton.icon(
                          onPressed: () => _clearHistory(visible),
                          icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold),
                              color: AD.danger, size: 17),
                          label: Text('Clear history',
                              style: ADText.rowName(c: AD.danger)),
                        ),
                      ]),
                    );
                  }
                  final e = visible[idx - 1];
                  final key = DeviceContacts.normKey(e.number);
                  final displayName = overrides[key]?.displayName ?? e.cachedName;
                  final isBlocked = blocked.contains(key);
                  void openMenu() => showAvaDialRowMenu(
                        context,
                        number: e.number,
                        name: displayName,
                        alreadyBlocked: isBlocked,
                        onChanged: _reload,
                      );
                  return Dismissible(
                    key: ValueKey(HiddenCallLog.keyFor(e.number, e.date)),
                    direction: DismissDirection.endToStart,
                    background: Container(
                      alignment: Alignment.centerRight,
                      padding: const EdgeInsets.only(right: 22),
                      margin: const EdgeInsets.symmetric(vertical: 4),
                      decoration: BoxDecoration(
                        color: AD.danger,
                        borderRadius: BorderRadius.circular(AD.rListCard),
                      ),
                      child: const Icon(Icons.delete_outline, color: Colors.white),
                    ),
                    onDismissed: (_) async {
                      await HiddenCallLog.I.hide(e.number, e.date);
                      Analytics.capture('avadial_call_deleted', const {});
                    },
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: GestureDetector(
                        onLongPress: openMenu,
                        child: AdCard(
                          color: AvaDialTheme.surface2,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                          child: Row(children: [
                            ZineIconBadge(icon: _iconFor(e.type), color: _colorFor(e.type)),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(displayName ?? e.number, style: ADText.threadName(c: AvaDialTheme.text)),
                                Text(_subtitle(e), style: ADText.preview(c: AvaDialTheme.textSoft)),
                              ]),
                            ),
                            IconButton(
                              icon: const Icon(Icons.more_vert, color: AvaDialTheme.textSoft),
                              onPressed: openMenu,
                            ),
                          ]),
                        ),
                      ),
                    ),
                  );
                },
              ),
            );
          },
        ),
      ),
    ]);
  }

  String _subtitle(DeviceCall e) {
    final d = e.date;
    final when = '${d.day}/${d.month} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return '${e.type.name} · $when';
  }
}

// ── Block tab ────────────────────────────────────────────────────────────────
class _BlockTab extends StatefulWidget {
  const _BlockTab();

  @override
  State<_BlockTab> createState() => _BlockTabState();
}

class _BlockTabState extends State<_BlockTab> {
  late Future<List<BlockEntry>> _future;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _future = BlockList.I.load();
    // Reload when a number is blocked/unblocked from another tab (Contacts, Logs,
    // the contact detail screen) so it appears here immediately (owner bug, pic 6).
    avaDialRev.addListener(_onRev);
  }

  @override
  void dispose() {
    avaDialRev.removeListener(_onRev);
    super.dispose();
  }

  void _onRev() {
    if (mounted) setState(() => _future = BlockList.I.load());
  }

  void _reload() => setState(() => _future = BlockList.I.load());

  Future<void> _unblock(String number) async {
    await BlockList.I.unblock(number);
    _reload();
  }

  @override
  Widget build(BuildContext context) {
    // [AVADIAL-SEARCH-1] The bar lives OUTSIDE the FutureBuilder on purpose: an
    // unblock swaps in a new future and flips this to a spinner, which would
    // unmount an inner bar and silently drop the user's query mid-search.
    return Column(children: [
      _AvaDialSearchBar(
        hint: 'Search blocked numbers',
        onChanged: (v) {
          if (_query.trim().isEmpty && v.trim().isNotEmpty) {
            Analytics.capture('avadial_search_started', const {'tab': 'block_list'});
          }
          setState(() => _query = v);
        },
      ),
      Expanded(
        child: FutureBuilder<List<BlockEntry>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
        }
        final all = snap.data ?? const <BlockEntry>[];
        if (all.isEmpty) {
          return const ShellEmptyState(
            icon: Icons.block_outlined,
            title: 'Nothing blocked',
            subtitle: 'Numbers you block or report as spam show up here.',
            color: AD.danger,
          );
        }
        final entries = all
            .where((e) => _avaDialMatches(_query, number: e.number, texts: [e.label]))
            .toList();
        if (entries.isEmpty) {
          return Center(
            child: Text('No matches', style: ADText.preview(c: AvaDialTheme.textSoft)),
          );
        }
        return ListView.builder(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
          itemCount: entries.length,
          itemBuilder: (context, i) {
            final e = entries[i];
            void openMenu() => showAvaDialRowMenu(
                  context,
                  number: e.number,
                  name: e.label,
                  alreadyBlocked: true,
                  onChanged: _reload,
                );
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: GestureDetector(
                onLongPress: openMenu,
                child: AdCard(
                  color: AvaDialTheme.surface2,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    ZineIconBadge(
                        icon: e.reportedSpam
                            ? PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold)
                            : PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                        color: AD.danger),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(e.number, style: ADText.threadName(c: AvaDialTheme.text)),
                        Text(
                          e.reportedSpam ? 'Reported as spam${e.label != null ? ' · ${e.label}' : ''}' : 'Blocked',
                          style: ADText.preview(c: AvaDialTheme.textSoft),
                        ),
                      ]),
                    ),
                    AdButton(
                      label: 'Unblock',
                      variant: AdButtonVariant.ghost,
                      fontSize: 13,
                      trailingIcon: false,
                      onPressed: () => _unblock(e.number),
                    ),
                    IconButton(
                      icon: const Icon(Icons.more_vert, color: AvaDialTheme.textSoft),
                      onPressed: openMenu,
                    ),
                  ]),
                ),
              ),
            );
          },
        );
      },
        ),
      ),
    ]);
  }
}

/// Empty/permission-denied state with a retry (used by the Contacts + Logs tabs).
class _PermState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  final Future<void> Function() onRetry;
  const _PermState({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.color,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      // ListView so RefreshIndicator/scroll works even in the empty state.
      padding: const EdgeInsets.symmetric(horizontal: 24),
      children: [
        const SizedBox(height: 72),
        ZineIconBadge(icon: icon, color: color, size: 56),
        const SizedBox(height: 16),
        Text(title, textAlign: TextAlign.center, style: ADText.threadName(c: AvaDialTheme.text).copyWith(fontSize: 18)),
        const SizedBox(height: 8),
        Text(subtitle, textAlign: TextAlign.center, style: ADText.preview(c: AvaDialTheme.textSoft).copyWith(fontSize: 14)),
        const SizedBox(height: 20),
        Center(
          child: AdButton(
            label: 'Try again',
            variant: AdButtonVariant.ghost,
            trailingIcon: false,
            onPressed: onRetry,
          ),
        ),
      ],
    );
  }
}
