import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../features/avadial/avadial_channel.dart';
import '../../features/avadial/avadial_refresh.dart';
import '../../features/avadial/avadial_theme.dart';
import '../../features/avadial/block_list.dart';
import '../../features/avadial/device_contacts.dart';
import '../../features/avadial/dialpad_search_tab.dart';
import '../../features/avatok/contact_actions.dart';
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

// [AVADIAL-AVATOK-ONLY-2] 2026-07-16 (owner spec, pic1): the "Make Ava your
// phone app" / ROLE_DIALER promo card that used to sit above the Logs tab is
// REMOVED entirely, not just hidden — Call logs is AvaTOK-to-AvaTOK only now,
// so there is no device-dialer-role framing left on this screen. The onboarding
// path for the OS default-phone role still lives in Settings → "Default phone &
// messages" (default_dialer_section.dart), which is untouched — the owner's
// instruction was scoped to the AvaDialer screen, and that Settings card has no
// reference to this banner/class.

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
  // [AVADIAL-AVATOK-ONLY-2] Which AvaTOK numbers are on the block list, so the
  // Contacts row menu can offer Block/Unblock and reflect the live state — the
  // SAME [BlockList] the Block tab reads, keyed by the contact's AvaTOK number.
  Set<String> _blockedNumbers = const {};
  bool _loaded = false;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
    // A block/unblock from the Block tab (or this tab, on another row) should
    // flip this row's menu label immediately — same cross-tab notifier the
    // Block tab already listens to.
    avaDialRev.addListener(_onRev);
  }

  @override
  void dispose() {
    avaDialRev.removeListener(_onRev);
    super.dispose();
  }

  void _onRev() {
    if (mounted) _loadBlocked();
  }

  Future<void> _load() async {
    final cs = await _store.load();
    if (!mounted) return;
    setState(() { _all = cs; _loaded = true; });
    Analytics.capture('avadial_contacts_tab_loaded', {'count': cs.length});
    unawaited(_loadBlocked());
  }

  Future<void> _loadBlocked() async {
    final entries = await BlockList.I.load();
    if (!mounted) return;
    setState(() => _blockedNumbers = entries.map((e) => e.number).toSet());
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

  /// [AVADIAL-AVATOK-ONLY-2] "Save contact" — exports a vCard and hands it to
  /// the OS share sheet (Contacts app / Files / anywhere), reusing the SAME
  /// vCard builder + share flow every other contact surface uses
  /// ([ContactActions.share]) rather than a second implementation.
  Future<void> _saveContact(Contact c) async {
    Analytics.capture('avadial_contact_save_vcard', const {});
    await ContactActions.share(context, c);
  }

  /// "Share contact" (owner spec, pic5): share to AvaTOK contacts — forward the
  /// contact card into an AvaTOK chat/group. Reuses [ContactActions.forward]
  /// (the SAME forward-to-chat plumbing the chat list / AvaPhone contacts use)
  /// rather than building a second contact-forward path.
  Future<void> _shareToAvaTok(Contact c) async {
    Analytics.capture('avadial_contact_share_to_avatok', const {});
    await ContactActions.forward(context, c);
  }

  /// Rename / edit the saved display name for an AvaTOK contact. Writes through
  /// [ContactsStore.add], which upserts by uid (same store the row list reads).
  Future<void> _rename(Contact c) async {
    final ctrl = TextEditingController(text: c.name);
    final newName = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rDialog),
        ),
        title: Text('Rename contact', style: ADText.threadName(c: AvaDialTheme.text)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: TextStyle(color: AvaDialTheme.text),
          decoration: InputDecoration(
            hintText: 'Name',
            hintStyle: TextStyle(color: AvaDialTheme.textSoft),
            enabledBorder: const UnderlineInputBorder(borderSide: BorderSide(color: AvaDialTheme.border)),
            focusedBorder: const UnderlineInputBorder(borderSide: BorderSide(color: AvaDialTheme.accent)),
          ),
          onSubmitted: (v) => Navigator.pop(ctx, v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: ADText.rowName(c: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            child: Text('Save', style: ADText.rowName(c: AvaDialTheme.accent)),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (newName == null || newName.trim() == c.name) return;
    final list = await _store.add(c.copyWith(name: newName.trim()));
    if (!mounted) return;
    setState(() => _all = list);
    Analytics.capture('avadial_contact_renamed', const {});
  }

  /// Block/unblock this contact's AvaTOK number — the SAME account-scoped
  /// [BlockList] the Block tab reads (which also drives the OS-level
  /// write-through when AvaTOK holds the dialer role), so blocking here shows
  /// up there immediately via [avaDialRev].
  Future<void> _toggleBlock(Contact c) async {
    if (c.number.isEmpty) return;
    final blocked = _blockedNumbers.contains(c.number);
    if (blocked) {
      await BlockList.I.unblock(c.number);
    } else {
      await BlockList.I.block(c.number, label: c.name.isNotEmpty ? c.name : null);
    }
    Analytics.capture('avadial_contact_block_toggled', {'blocked': !blocked});
    await _loadBlocked();
  }

  /// Full row menu (owner spec, pic5): Call on AvaTOK · View profile · Share
  /// contact (to AvaTOK chat) · Save contact (vCard) · Rename · Block · Delete.
  /// A non-member ("Invite") row never reaches this list — [ContactsStore] only
  /// ever stores a resolved uid, so an unresolved number is handled inline at
  /// add-time by [_AddAvaTokContactDialog]'s own "Not on AvaTOK → Invite" state
  /// instead of being persisted as a fake contact.
  void _openMenu(Contact c) {
    final isBlocked = c.number.isNotEmpty && _blockedNumbers.contains(c.number);
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AvaDialTheme.surface2,
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: AvaDialTheme.border, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.85),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
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
          leading: PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), color: AD.iconVideo),
          title: Text('Share contact', style: ADText.rowName(c: AvaDialTheme.text)),
          subtitle: Text('Send to an AvaTOK chat', style: ADText.preview(c: AvaDialTheme.textSoft)),
          onTap: () { Navigator.pop(ctx); _shareToAvaTok(c); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.floppyDisk(PhosphorIconsStyle.bold), color: AD.iconVideo),
          title: Text('Save contact', style: ADText.rowName(c: AvaDialTheme.text)),
          subtitle: Text('vCard — Contacts, email & more', style: ADText.preview(c: AvaDialTheme.textSoft)),
          onTap: () { Navigator.pop(ctx); _saveContact(c); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), color: AD.iconVideo),
          title: Text('Rename', style: ADText.rowName(c: AvaDialTheme.text)),
          onTap: () { Navigator.pop(ctx); _rename(c); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: AD.danger),
          title: Text(isBlocked ? 'Unblock' : 'Block', style: ADText.rowName(c: AD.danger)),
          onTap: () { Navigator.pop(ctx); _toggleBlock(c); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: AD.danger),
          title: Text('Delete contact', style: ADText.rowName(c: AD.danger)),
          onTap: () { Navigator.pop(ctx); _deleteContact(c); },
        ),
        const SizedBox(height: 8),
          ]),
        ),
      )),
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

// [AVADIAL-AVATOK-ONLY-2] 2026-07-16: this tab used to read the native DEVICE
// call log (Truecaller-style, via [DeviceCallLog]/[AvaDialChannel.readCallLog])
// with the "Make Ava your phone app" role banner above it. Per owner spec, Call
// logs is now AvaTOK-to-AvaTOK only: it reads [CallLogStore] — the SAME
// server-backed, multi-device-synced log AvaPhone's `_CallsTab` already uses
// (app/lib/features/avaphone/ava_phone_screen.dart) — and the whole
// device-phone-app framing (banner + copy) is gone, not just hidden.
//
// The native `AvaDialChannel.readCallLog()` / `AvaDialPlugin.kt` / manifest
// permissions are UNTOUCHED — this tab simply stops calling them. See the
// AVADIAL-AVATOK-ONLY-2 report for a READ_CALL_LOG justification note now that
// this was its only caller in the Calls app.
class _LogsTab extends StatefulWidget {
  const _LogsTab();

  @override
  State<_LogsTab> createState() => _LogsTabState();
}

class _LogsTabState extends State<_LogsTab> {
  final _store = CallLogStore();
  List<CallEntry> _calls = const [];
  Map<String, Contact> _byUid = const {};
  bool _loaded = false;
  String _query = '';
  StreamSubscription<void>? _sub;

  @override
  void initState() {
    super.initState();
    _load();
    // [CallLogStore] already notifies on every local mutation AND remote sync
    // (multi-device), so this tab repaints live without any device-call-log
    // polling/refresh dance.
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
      _byUid = {for (final c in contacts) c.uid: c};
      _loaded = true;
    });
    Analytics.capture('avadial_calllog_tab_loaded', {'count': calls.length});
  }

  Future<void> _reload() => _load();

  String? _avatarFor(String seed) {
    final c = _byUid[seed];
    return (c != null && c.avatarUrl.isNotEmpty) ? c.avatarUrl : null;
  }

  Contact _contactOf(CallEntry c) =>
      _byUid[c.seed] ?? Contact(uid: c.seed, name: c.name, avatarUrl: _avatarFor(c.seed) ?? '');

  Future<void> _call(CallEntry c) async {
    Analytics.capture('avadial_calllog_call_back', {'dir': c.dir.name, 'video': c.video});
    await place1to1Call(context, uid: c.seed, name: c.name.isNotEmpty ? c.name : c.seed,
        avatarUrl: _avatarFor(c.seed) ?? '', dialer: true);
  }

  /// "Clear history" — this is the account's OWN AvaTOK call log (server-backed),
  /// not a device log, so there is nothing to "hide"; clearing wipes it for real
  /// (and syncs the clear to every device on the account, same as [CallLogStore.clear]).
  Future<void> _clearHistory() async {
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
          'This clears your AvaTOK call history on every device signed into this account.',
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
    await _store.clear();
    Analytics.capture('avadial_call_history_cleared', {'count': _calls.length});
  }

  /// [AVADIAL-LOG-EXPORT-1] Write the visible call log to a .txt and hand it to
  /// the OS share sheet (Files, Gmail, WhatsApp, Drive — the user's choice).
  Future<void> _exportLogs(List<CallEntry> logs) async {
    try {
      final b = StringBuffer()
        ..writeln('AvaTOK call log')
        ..writeln('Exported ${_stamp(DateTime.now())}')
        ..writeln('${logs.length} call${logs.length == 1 ? '' : 's'}')
        ..writeln();
      for (final e in logs) {
        final name = _byUid[e.seed]?.name ?? e.name;
        final who = name.trim().isEmpty ? e.seed : name;
        b.writeln('${_stamp(DateTime.fromMillisecondsSinceEpoch(e.ts * 1000))} · ${e.dir.name} · $who');
      }
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/avatok_call_log.txt');
      await f.writeAsString(b.toString(), flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: 'text/plain')],
          subject: 'AvaTOK call log');
      Analytics.capture('avadial_calllog_exported', {'count': logs.length});
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Couldn't export the call log.")),
      );
      Analytics.capture('avadial_calllog_export_failed', {'error': e.toString()});
    }
  }

  static String _stamp(DateTime d) {
    String p(int v) => v.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
  }

  IconData _iconFor(CallDir d) => switch (d) {
        CallDir.outgoing => Icons.call_made,
        CallDir.missed => Icons.call_missed,
        CallDir.incoming => Icons.call_received,
      };

  Color _colorFor(CallDir d) => switch (d) {
        CallDir.missed => AD.danger,
        CallDir.outgoing => AD.online,
        CallDir.incoming => AD.iconSearch,
      };

  /// Per-row options (tap or long-press): Call on AvaTOK · View profile · Share
  /// contact · Delete this log entry.
  void _openMenu(CallEntry c) {
    final contact = _contactOf(c);
    final displayName = contact.name.isNotEmpty ? contact.name : c.name;
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
            child: Avatar(seed: c.seed, name: displayName, size: 44,
                avatarUrl: _avatarFor(c.seed)),
          ),
          title: Text(displayName.isNotEmpty ? displayName : c.seed, style: ADText.rowName(c: AvaDialTheme.text)),
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
          onTap: () {
            Navigator.pop(ctx);
            Navigator.push(context, MaterialPageRoute<void>(
                builder: (_) => ContactProfileScreen(name: displayName, uid: c.seed)));
          },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), color: AD.iconVideo),
          title: Text('Share contact', style: ADText.rowName(c: AvaDialTheme.text)),
          onTap: () { Navigator.pop(ctx); ContactActions.forward(context, contact); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: AD.danger),
          title: Text('Delete this log entry', style: ADText.rowName(c: AD.danger)),
          onTap: () async {
            Navigator.pop(ctx);
            if (c.id.isNotEmpty) await _store.removeById(c.id);
            Analytics.capture('avadial_call_deleted', const {});
          },
        ),
        const SizedBox(height: 8),
      ])),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      // [AVADIAL-SEARCH-1] Instant name filter over the AvaTOK call log.
      _AvaDialSearchBar(
        hint: 'Search calls by name',
        onChanged: (v) {
          if (_query.trim().isEmpty && v.trim().isNotEmpty) {
            Analytics.capture('avadial_search_started', const {'tab': 'call_logs'});
          }
          setState(() => _query = v);
        },
      ),
      Expanded(
        child: !_loaded
            ? const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent))
            : (_calls.isEmpty
                ? _PermState(
                    icon: Icons.history_outlined,
                    title: 'No call history',
                    subtitle: 'Calls you make and receive on AvaTOK will show up here.',
                    color: AD.online,
                    onRetry: _reload,
                  )
                : _buildList())
      ),
    ]);
  }

  Widget _buildList() {
    // [AVADIAL-SEARCH-1] Match on the SAME display name the row renders
    // (saved contact first, then the call-log's own recorded name).
    final visible = _calls.where((e) {
      final displayName = _byUid[e.seed]?.name ?? e.name;
      return _avaDialMatches(_query, texts: [displayName, e.seed]);
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
            return Padding(
              padding: const EdgeInsets.fromLTRB(2, 4, 2, 6),
              child: Row(children: [
                Text('${visible.length} call${visible.length == 1 ? '' : 's'}',
                    style: ADText.statCaption(c: AvaDialTheme.textMute)),
                const Spacer(),
                // [AVADIAL-LOG-EXPORT-1] Export as .txt via the OS share sheet.
                TextButton.icon(
                  onPressed: () => _exportLogs(visible),
                  icon: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
                      color: AvaDialTheme.accent, size: 17),
                  label: Text('Export', style: ADText.rowName(c: AvaDialTheme.accent)),
                ),
                TextButton.icon(
                  onPressed: _clearHistory,
                  icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold),
                      color: AD.danger, size: 17),
                  label: Text('Clear history', style: ADText.rowName(c: AD.danger)),
                ),
              ]),
            );
          }
          final e = visible[idx - 1];
          final displayName = _byUid[e.seed]?.name ?? e.name;
          void openMenu() => _openMenu(e);
          return Dismissible(
            key: ValueKey(e.id.isNotEmpty ? e.id : '${e.seed}_${e.ts}'),
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
              if (e.id.isNotEmpty) await _store.removeById(e.id);
              Analytics.capture('avadial_call_deleted', const {});
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: GestureDetector(
                onTap: openMenu,
                onLongPress: openMenu,
                child: AdCard(
                  color: AvaDialTheme.surface2,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    ZineIconBadge(icon: _iconFor(e.dir), color: _colorFor(e.dir)),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(displayName.isNotEmpty ? displayName : e.seed,
                            style: ADText.threadName(c: AvaDialTheme.text)),
                        Text(_subtitle(e), style: ADText.preview(c: AvaDialTheme.textSoft)),
                      ]),
                    ),
                    IconButton(
                      icon: const Icon(Icons.call, color: AD.incomingCall),
                      onPressed: () => _call(e),
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
  }

  String _subtitle(CallEntry e) => '${e.dir.name} · ${e.timeLabel}';
}

// ── Block tab ────────────────────────────────────────────────────────────────
// [AVADIAL-AVATOK-ONLY-2] 2026-07-16 (owner spec, pic6): "The block list is
// about avatok contacts only and not users phone book contacts." [BlockList]
// itself is a flat number → label store shared with other surfaces (and its
// numbers can be either an AvaTOK number or, historically, a device number), so
// this tab now cross-references every entry against [ContactsStore] and only
// shows the ones that match a saved AvaTOK contact's number — a bare
// device/phone-book number that was never an AvaTOK contact is dropped from
// this VIEW (the underlying block/OS write-through is untouched either way).
// The search bar is scoped to exactly that filtered list, never the device
// address book.
class _BlockTab extends StatefulWidget {
  const _BlockTab();

  @override
  State<_BlockTab> createState() => _BlockTabState();
}

class _BlockTabState extends State<_BlockTab> {
  late Future<(List<BlockEntry>, Map<String, Contact>)> _future;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _future = _loadAll();
    // Reload when a number is blocked/unblocked from another tab (Contacts, the
    // contact detail screen) so it appears here immediately (owner bug, pic 6).
    avaDialRev.addListener(_onRev);
  }

  @override
  void dispose() {
    avaDialRev.removeListener(_onRev);
    super.dispose();
  }

  void _onRev() {
    if (mounted) setState(() => _future = _loadAll());
  }

  Future<(List<BlockEntry>, Map<String, Contact>)> _loadAll() async {
    final blocked = await BlockList.I.load();
    final contacts = await ContactsStore().load();
    // AvaTOK contacts only — keyed by their AvaTOK number so a block entry can
    // be matched back to the contact that owns it.
    final byNumber = {for (final c in contacts) if (c.number.isNotEmpty) c.number: c};
    return (blocked, byNumber);
  }

  void _reload() => setState(() => _future = _loadAll());

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
      // Explicit clarification banner, mirroring the Contacts tab's own copy
      // (owner spec, pic6): this is the AvaTOK contact block list, never the
      // phone's address book.
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
        child: AdCard(
          color: AvaDialTheme.surface2,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), size: 16, color: AD.danger),
            const SizedBox(width: 8),
            Expanded(child: Text(
                'AvaTOK contacts only — not your phone’s address book.',
                style: ADText.preview(c: AvaDialTheme.textSoft))),
          ]),
        ),
      ),
      _AvaDialSearchBar(
        hint: 'Search blocked contacts',
        onChanged: (v) {
          if (_query.trim().isEmpty && v.trim().isNotEmpty) {
            Analytics.capture('avadial_search_started', const {'tab': 'block_list'});
          }
          setState(() => _query = v);
        },
      ),
      Expanded(
        child: FutureBuilder<(List<BlockEntry>, Map<String, Contact>)>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
        }
        final (allBlocked, byNumber) = snap.data ?? (const <BlockEntry>[], const <String, Contact>{});
        // AvaTOK-contacts-only scope (owner spec, pic6): a bare device/phone-book
        // number that never resolved to a saved AvaTOK contact never appears here.
        final all = allBlocked.where((e) => byNumber.containsKey(e.number)).toList();
        Analytics.capture('avadial_blocklist_scope', {
          'total_blocked': allBlocked.length,
          'avatok_scoped': all.length,
        });
        if (all.isEmpty) {
          return const ShellEmptyState(
            icon: Icons.block_outlined,
            title: 'Nothing blocked',
            subtitle: 'AvaTOK contacts you block or report as spam show up here.',
            color: AD.danger,
          );
        }
        // Search is scoped to exactly this AvaTOK-only list — never falls
        // through to the device address book or a global search.
        final entries = all
            .where((e) => _avaDialMatches(_query,
                texts: [e.label, byNumber[e.number]?.name, e.number]))
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
            final contact = byNumber[e.number];
            final label = (contact?.name.isNotEmpty ?? false) ? contact!.name : (e.label ?? e.number);
            void openMenu() => showModalBottomSheet<void>(
                  context: context,
                  backgroundColor: AvaDialTheme.surface2,
                  shape: const RoundedRectangleBorder(
                    side: BorderSide(color: AvaDialTheme.border, width: 1),
                    borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
                  ),
                  builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const SizedBox(height: 10),
                    ListTile(
                      title: Text(label, style: ADText.rowName(c: AvaDialTheme.text)),
                      subtitle: Text(e.number, style: ADText.preview(c: AvaDialTheme.textSoft)),
                    ),
                    const Divider(color: AvaDialTheme.border, height: 1),
                    if (contact != null)
                      ListTile(
                        leading: PhosphorIcon(PhosphorIcons.user(PhosphorIconsStyle.bold), color: AD.iconSearch),
                        title: Text('View profile', style: ADText.rowName(c: AvaDialTheme.text)),
                        onTap: () {
                          Navigator.pop(ctx);
                          Navigator.push(context, MaterialPageRoute<void>(
                              builder: (_) => ContactProfileScreen(name: contact.name, uid: contact.uid)));
                        },
                      ),
                    ListTile(
                      leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: AD.danger),
                      title: Text('Unblock', style: ADText.rowName(c: AD.danger)),
                      onTap: () { Navigator.pop(ctx); _unblock(e.number); },
                    ),
                    const SizedBox(height: 8),
                  ])),
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
                        Text(label, style: ADText.threadName(c: AvaDialTheme.text)),
                        Text(
                          e.reportedSpam ? 'Reported as spam · ${e.number}' : 'Blocked · ${e.number}',
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
