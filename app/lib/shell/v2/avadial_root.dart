import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../features/avadial/ava_contact_book.dart';
import '../../features/avadial/avadial_channel.dart';
import '../../features/avadial/avadial_refresh.dart';
import '../../features/avadial/avadial_theme.dart';
import '../../features/avadial/block_list.dart';
import '../../features/avadial/contact_edit_screen.dart';
import '../../features/avadial/contact_groups.dart';
import '../../features/avadial/contacts_backup_screen.dart';
import '../../features/avadial/contact_overrides.dart';
import '../../features/avadial/contact_row_menu.dart';
import '../../features/avadial/device_call_log.dart';
import '../../features/avadial/device_contacts.dart';
import '../../features/avadial/dialpad_search_tab.dart';
import '../../features/avadial/outgoing_call_screen.dart';
import '../../features/avadial/sms/sms_threads_screen.dart';
import '../../features/avadial/sms/sms_unread_store.dart';
import '../../features/avadial/sms_role_help.dart';
import '../shell_v2.dart';
import 'shell_chrome.dart';

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
  // Tab order (owner request 2026-07-14): Contacts · Messages · Dialpad ·
  // Block list · Call logs. The IndexedStack bodies below MUST stay in this same
  // order (index maps positionally).
  static const _items = [
    _CallsTabItem(Icons.person_outline, Icons.person, 'Contacts', AD.iconSearch),
    // [AVA-SMS-BADGE-1] Messages carries the unread-SMS count in ORANGE.
    _CallsTabItem(Icons.sms_outlined, Icons.sms, 'Messages', AD.iconVideo,
        unreadBadge: true),
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
                // Contacts · Messages · Dialpad · Block list · Call logs.
                return IndexedStack(index: _tab, children: [
              on
                  ? const _ContactsTab()
                  : const ShellEmptyState(
                      icon: Icons.person_outline,
                      title: 'Contacts',
                      subtitle: 'Your phone book, spam-labelled — coming with AvaDial.',
                      color: AD.iconSearch,
                    ),
              // Messages tab — gated INDEPENDENTLY on `avaSms` (the SMS role is
              // separate from the dialer role). While the flag is off it keeps the
              // Phase-1 placeholder; when on it shows the role banner until ROLE_SMS
              // is held, then the live SMS threads + AI Inbox/Spam filter.
              RemoteConfig.avaSms
                  ? const _MessagesTab()
                  : const ShellEmptyState(
                      icon: Icons.sms_outlined,
                      title: 'Messages',
                      subtitle: 'Carrier SMS lands here once Ava is your SMS app — coming with AvaDial.',
                      color: AD.iconVideo,
                    ),
              // Dialpad — the Calls app's OWN PSTN dialer: live contact search
              // above a real keypad (2026-07-12 redesign; previously reused the
              // in-network AvaPhone dialer, which had its own nested chrome).
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

  /// [AVA-SMS-BADGE-1] True on the Messages tab: renders the live unread-SMS
  /// count (orange) from [SmsUnreadStore] next to the label.
  final bool unreadBadge;
  const _CallsTabItem(this.icon, this.selectedIcon, this.label, this.color,
      {this.unreadBadge = false});
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
          // [AVA-SMS-BADGE-1] Live unread count in ORANGE on the Messages tab —
          // "he knows message has new message". Walks down as threads are read.
          if (item.unreadBadge)
            ValueListenableBuilder<int>(
              valueListenable: SmsUnreadStore.I.total,
              builder: (_, n, __) => n <= 0
                  ? const SizedBox.shrink()
                  : Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(
                          color: selected
                              ? Colors.white
                              : AD.primaryBadge.withValues(alpha: 0.16),
                          borderRadius: BorderRadius.circular(9),
                        ),
                        child: Text(
                          n > 99 ? '99+' : '$n',
                          style: const TextStyle(
                            color: AD.primaryBadge, // orange
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                            height: 1.2,
                          ),
                        ),
                      ),
                    ),
            ),
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
class _ContactsTab extends StatefulWidget {
  const _ContactsTab();

  @override
  State<_ContactsTab> createState() => _ContactsTabState();
}

class _ContactsTabState extends State<_ContactsTab> {
  late Future<(List<DeviceContact>, Map<String, ContactOverride>, Set<String>, List<ContactGroup>)> _future;

  // [AVADIAL-CONTACTS-UX-1] Live search over the Contacts list (owner spec
  // 2026-07-14) — instant, no debounce/submit.
  String _query = '';
  // Selected colour-group circle filter; null = show every contact.
  String? _selectedGroupId;

  @override
  void initState() {
    super.initState();
    _future = _loadAll();
    // Reload when any Calls store mutates (block/edit/add from another tab), so
    // newly added/edited contacts appear without an app restart.
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

  Future<(List<DeviceContact>, Map<String, ContactOverride>, Set<String>, List<ContactGroup>)> _loadAll({bool force = false}) async {
    final contacts = List<DeviceContact>.of(await DeviceContacts.I.load(force: force));
    final overrides = {for (final o in await ContactOverrides.I.load()) DeviceContacts.normKey(o.number): o};
    final blocked = {for (final b in await BlockList.I.load()) DeviceContacts.normKey(b.number)};
    final groups = await ContactGroups.I.load();
    // Inject AvaTOK-only contacts the user created here (no device row) so they
    // show up in the Contacts tab (owner spec, pic 1 — add contact).
    final present = {for (final c in contacts) DeviceContacts.normKey(c.number)};
    for (final o in await ContactOverrides.I.localContacts()) {
      final key = DeviceContacts.normKey(o.number);
      if (present.contains(key)) continue;
      contacts.add(DeviceContact(name: o.displayName, number: o.number));
      present.add(key);
    }
    // Keep the local AvaTOK contact book (used for backup) in sync with what the
    // user sees. Best-effort — never blocks the list from rendering.
    await AvaContactBook.I.capture(contacts, overrides);
    // Auto-backup: if the user turned backup ON, push changes in the background
    // (debounced + change-detected inside). Every add/edit/delete funnels through
    // here via the avaDialRev listener, so edits are backed up without a tap.
    unawaited(AvaContactBook.I.autoSyncIfNeeded());
    return (contacts, overrides, blocked, groups);
  }

  Future<void> _openBackup() async {
    await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(builder: (_) => const ContactsBackupScreen()));
    _reload();
  }

  Future<void> _reload() async {
    // [AVADIAL-GROUPS-1] Every caller reaches here AFTER an await (block, group
    // create/delete, backup/add-contact routes), so the tab may already be gone.
    // Guard once here rather than at each call site.
    if (!mounted) return;
    setState(() => _future = _loadAll(force: true));
  }

  Future<void> _addContact() async {
    await Navigator.of(context).push<bool>(
        MaterialPageRoute<bool>(builder: (_) => const ContactEditScreen(create: true)));
    _reload();
  }

  void _selectGroup(String id) {
    setState(() => _selectedGroupId = _selectedGroupId == id ? null : id);
  }

  Future<void> _createGroup() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (_) => const _CreateGroupDialog(),
    );
    if (created == true) _reload();
  }

  Future<void> _deleteGroup(ContactGroup group) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rDialog),
        ),
        title: Text('Delete "${group.name}"?', style: ADText.threadName(c: AvaDialTheme.text)),
        content: Text(
          'Contacts filed under this group become ungrouped. This can\'t be undone.',
          style: ADText.preview(c: AvaDialTheme.textSoft).copyWith(fontSize: 13.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ADText.rowName(c: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Delete', style: ADText.rowName(c: AD.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await ContactGroups.I.delete(group.id);
    if (_selectedGroupId == group.id && mounted) {
      setState(() => _selectedGroupId = null);
    }
    _reload();
  }

  /// [AVADIAL-CONTACTS-UX-1] Row tap now opens a centred Dial/Block popup
  /// instead of the old contact-detail screen (detail moved into the 3-dot menu).
  Future<void> _openDialOrBlock(String number, String displayName) async {
    await showDialog<void>(
      context: context,
      barrierDismissible: true,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rDialog),
        ),
        title: Text(displayName, style: ADText.threadName(c: AvaDialTheme.text)),
        content: Text(number, style: ADText.preview(c: AvaDialTheme.textSoft)),
        actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        actions: [
          Row(children: [
            Expanded(
              child: _DialogActionButton(
                label: 'Dial',
                icon: Icons.phone,
                color: AD.incomingCall,
                onPressed: () async {
                  Navigator.pop(dialogCtx);
                  final placed = await AvaDialChannel.I.placeCall(number);
                  if (placed && context.mounted) {
                    Navigator.push(context, MaterialPageRoute<void>(
                        builder: (_) => OutgoingCallScreen(number: number)));
                  }
                },
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _DialogActionButton(
                label: 'Block',
                icon: Icons.block,
                color: AD.danger,
                onPressed: () async {
                  Navigator.pop(dialogCtx);
                  await BlockList.I.block(number, label: displayName);
                  _reload();
                },
              ),
            ),
          ]),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      Column(children: [
      const _RoleBanner(),
      // Search bar — instant, case-insensitive name/number filter.
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            // [AVADIAL-SEARCH-2] White pill, black text (owner spec) — matches
            // the shared _AvaDialSearchBar used by Call logs + Block list.
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
                  hintText: 'Search name or number',
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
      GestureDetector(
        onTap: _openBackup,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
          child: AdCard(
            // [AVADIAL-CONTACTS-UX-1] Light-green fill (owner spec) — text/icon
            // colours flip to dark ink below so the card stays readable.
            color: const Color(0xFFB8EFC9),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(children: [
              ZineIconBadge(
                  icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold),
                  color: const Color(0xFF1B7F4D)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Contacts backup',
                      style: ADText.rowName(c: const Color(0xFF12301F))),
                  Text('Back up to AvaTOK — no Gmail needed',
                      style: ADText.preview(c: const Color(0xFF2F5D45))),
                ]),
              ),
              const Icon(Icons.chevron_right, color: Color(0xFF2F5D45)),
            ]),
          ),
        ),
      ),
      Expanded(
        child: FutureBuilder<(List<DeviceContact>, Map<String, ContactOverride>, Set<String>, List<ContactGroup>)>(
          future: _future,
          builder: (context, snap) {
            // [AVADIAL-GROUPS-1] Spinner ONLY on the very first load. A _reload()
            // (assign/delete a group, block a contact) swaps in a new future —
            // FutureBuilder keeps the old `data` and just flips connectionState to
            // waiting, so gating on hasData keeps the group circles + list on screen
            // instead of flickering the whole area to a spinner on every mutation.
            if (!snap.hasData) {
              return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
            }
            final (all, overrides, blocked, groups) = snap.data ??
                (const <DeviceContact>[], const <String, ContactOverride>{}, const <String>{}, const <ContactGroup>[]);
            final groupsById = {for (final g in groups) g.id: g};
            // Hide numbers the user "removed"/"deleted" (AVA-side override only —
            // the device contact itself is never touched, see contact_overrides.dart).
            final baseContacts = all.where((c) => overrides[DeviceContacts.normKey(c.number)]?.hidden != true).toList();

            Widget listArea;
            if (baseContacts.isEmpty) {
              listArea = _PermState(
                icon: Icons.person_outline,
                title: 'No contacts yet',
                subtitle: 'Grant contacts access to see your phone book here.',
                color: AD.iconSearch,
                onRetry: _reload,
              );
            } else {
              var contacts = baseContacts;
              if (_selectedGroupId != null) {
                contacts = contacts
                    .where((c) => overrides[DeviceContacts.normKey(c.number)]?.groupId == _selectedGroupId)
                    .toList();
              }
              final query = _query.trim();
              if (query.isNotEmpty) {
                final qLower = query.toLowerCase();
                // [AVADIAL-GROUPS-1] Match numbers through the SAME normalisation the
                // rest of the Calls app keys on, so a query of '2079460958' still finds
                // a contact stored as '+44 (20) 7946-0958' (stripping spaces alone
                // leaves brackets/dashes behind and silently misses).
                final qKey = DeviceContacts.normKey(query);
                final qHasDigits = RegExp(r'\d').hasMatch(query);
                contacts = contacts.where((c) {
                  final key = DeviceContacts.normKey(c.number);
                  final displayName = overrides[key]?.displayName ?? c.name ?? '';
                  final nameMatch = displayName.toLowerCase().contains(qLower);
                  final numberMatch =
                      qHasDigits && qKey.isNotEmpty && key.contains(qKey);
                  return nameMatch || numberMatch;
                }).toList();
              }
              if (contacts.isEmpty) {
                listArea = Center(
                  child: Text('No matches', style: ADText.preview(c: AvaDialTheme.textSoft)),
                );
              } else {
                listArea = RefreshIndicator(
                  onRefresh: _reload,
                  child: ListView.builder(
                    padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
                    itemCount: contacts.length,
                    itemBuilder: (context, i) {
                      final c = contacts[i];
                      final key = DeviceContacts.normKey(c.number);
                      final displayName = overrides[key]?.displayName ?? c.name;
                      final isBlocked = blocked.contains(key);
                      final groupId = overrides[key]?.groupId;
                      final group = groupId != null ? groupsById[groupId] : null;
                      final rowColor = group?.colorValue ?? AvaDialTheme.surface2;
                      // [AVADIAL-GROUPS-2] Owner feedback: text on a coloured row is
                      // WHITE (not dark ink), so a row reads the same whichever colour
                      // the user picks.
                      final titleColor = group != null ? Colors.white : AvaDialTheme.text;
                      final subColor =
                          group != null ? Colors.white.withValues(alpha: 0.9) : AvaDialTheme.textSoft;
                      final iconColor = group != null ? Colors.white : AvaDialTheme.textSoft;
                      void openMenu() => showAvaDialRowMenu(
                            context,
                            number: c.number,
                            name: displayName,
                            alreadyBlocked: isBlocked,
                            onChanged: _reload,
                          );
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: GestureDetector(
                          onTap: () => _openDialOrBlock(c.number, displayName ?? c.number),
                          onLongPress: openMenu,
                          child: AdCard(
                            color: rowColor,
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                            child: Row(children: [
                              // [AVADIAL-GROUPS-2] The badge must never be the group
                              // colour (it would vanish into the card) NOR a dark fill:
                              // ZineIconBadge hard-codes a DARK ink glyph for every
                              // colour except coral, so a dark badge = dark-on-dark mush
                              // (owner: "the icon goes dark / looks distorted"). WHITE
                              // keeps the glyph crisp and reads cleanly against every
                              // group colour the user can pick.
                              ZineIconBadge(
                                  icon: PhosphorIcons.user(PhosphorIconsStyle.bold),
                                  color: group != null ? Colors.white : AD.iconSearch),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Text(displayName ?? c.number,
                                      style: ADText.threadName(c: titleColor)),
                                  if (displayName != null)
                                    Text(c.number, style: ADText.preview(c: subColor)),
                                ]),
                              ),
                              IconButton(
                                icon: Icon(Icons.more_vert, color: iconColor),
                                onPressed: openMenu,
                              ),
                            ]),
                          ),
                        ),
                      );
                    },
                  ),
                );
              }
            }

            return Column(children: [
              // Colour-group circles — filed directly below the backup card.
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
                child: _GroupsCard(
                  groups: groups,
                  selectedGroupId: _selectedGroupId,
                  onSelect: _selectGroup,
                  onDeleteGroup: _deleteGroup,
                  onCreateGroup: _createGroup,
                ),
              ),
              Expanded(child: listArea),
            ]);
          },
        ),
      ),
      ]),
      // Floating "+" to add a new contact (owner spec, pic 1). Sits above the list,
      // clear of the shell-wide AppSwitcherBar at the very bottom.
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
}

/// A big colored pill action for the Dial/Block popup — [AdButton]'s fixed
/// variants don't cover the exact accent colors this popup needs
/// (AD.incomingCall / AD.danger), so this is a small local variant.
class _DialogActionButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback onPressed;
  const _DialogActionButton({
    required this.label,
    required this.icon,
    required this.color,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onPressed,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 13),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(100),
        ),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(icon, size: 18, color: Colors.white),
          const SizedBox(width: 8),
          Text(label,
              style: const TextStyle(
                  color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15)),
        ]),
      ),
    );
  }
}

/// [AVADIAL-CONTACTS-UX-1] Horizontally-scrollable row of colour-group
/// "circles" below the backup card — tap to filter the Contacts list, long-press
/// a custom circle to delete it, tap "New" to create one.
class _GroupsCard extends StatelessWidget {
  final List<ContactGroup> groups;
  final String? selectedGroupId;
  final ValueChanged<String> onSelect;
  final ValueChanged<ContactGroup> onDeleteGroup;
  final VoidCallback onCreateGroup;
  const _GroupsCard({
    required this.groups,
    required this.selectedGroupId,
    required this.onSelect,
    required this.onDeleteGroup,
    required this.onCreateGroup,
  });

  @override
  Widget build(BuildContext context) {
    return AdCard(
      color: AvaDialTheme.surface2,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          for (final g in groups) ...[
            _GroupCircle(
              group: g,
              selected: selectedGroupId == g.id,
              onTap: () => onSelect(g.id),
              onLongPress: g.isBuiltIn ? null : () => onDeleteGroup(g),
            ),
            const SizedBox(width: 14),
          ],
          _AddGroupCircle(onTap: onCreateGroup),
        ]),
      ),
    );
  }
}

class _GroupCircle extends StatelessWidget {
  final ContactGroup group;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  const _GroupCircle({
    required this.group,
    required this.selected,
    required this.onTap,
    this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    final initial = group.name.trim().isNotEmpty ? group.name.trim().characters.first.toUpperCase() : '?';
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      child: SizedBox(
        width: 54,
        child: Column(children: [
          Container(
            width: 46,
            height: 46,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: group.colorValue,
              shape: BoxShape.circle,
              border: selected ? Border.all(color: AvaDialTheme.text, width: 2) : null,
            ),
            child: Text(initial,
                style: const TextStyle(
                    color: Colors.white, fontWeight: FontWeight.w800, fontSize: 17)),
          ),
          const SizedBox(height: 4),
          Text(
            group.shortName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: ADText.statCaption(c: AvaDialTheme.textSoft),
          ),
        ]),
      ),
    );
  }
}

class _AddGroupCircle extends StatelessWidget {
  final VoidCallback onTap;
  const _AddGroupCircle({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: SizedBox(
        width: 54,
        child: Column(children: [
          Container(
            width: 46,
            height: 46,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.transparent,
              shape: BoxShape.circle,
              border: Border.all(color: AvaDialTheme.textMute, width: 1.5),
            ),
            child: const Icon(Icons.add, color: AvaDialTheme.textMute, size: 22),
          ),
          const SizedBox(height: 4),
          Text('New', style: ADText.statCaption(c: AvaDialTheme.textSoft)),
        ]),
      ),
    );
  }
}

/// Create-a-custom-group dialog — name + colour swatch picker. Mirrors the
/// AlertDialog styling used elsewhere in this file (see `_clearHistory`).
class _CreateGroupDialog extends StatefulWidget {
  const _CreateGroupDialog();

  @override
  State<_CreateGroupDialog> createState() => _CreateGroupDialogState();
}

class _CreateGroupDialogState extends State<_CreateGroupDialog> {
  static const _palette = [
    0xFF6FB6FF,
    0xFFFF7B7B,
    0xFFFFA23E,
    0xFFFF8FC8,
    0xFF7ED9A0,
    0xFFB98BFF,
    0xFF5ED3D3,
    0xFFFFD34E,
  ];

  final _nameCtrl = TextEditingController();
  int _color = _palette.first;
  bool _busy = false;

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty || _busy) return;
    setState(() => _busy = true);
    await ContactGroups.I.create(name, _color);
    if (mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AvaDialTheme.surface2,
      shape: RoundedRectangleBorder(
        side: const BorderSide(color: AvaDialTheme.border, width: 1),
        borderRadius: BorderRadius.circular(AD.rDialog),
      ),
      title: Text('New group', style: ADText.threadName(c: AvaDialTheme.text)),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(
          controller: _nameCtrl,
          autofocus: true,
          style: TextStyle(color: AvaDialTheme.text),
          decoration: InputDecoration(
            hintText: 'Group name',
            hintStyle: TextStyle(color: AvaDialTheme.textSoft),
            enabledBorder: const UnderlineInputBorder(
                borderSide: BorderSide(color: AvaDialTheme.border)),
            focusedBorder: const UnderlineInputBorder(
                borderSide: BorderSide(color: AvaDialTheme.accent)),
          ),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 16),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (final c in _palette) ...[
              GestureDetector(
                onTap: () => setState(() => _color = c),
                child: Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: Color(c),
                    shape: BoxShape.circle,
                    border: _color == c
                        ? Border.all(color: AvaDialTheme.text, width: 2)
                        : null,
                  ),
                ),
              ),
              const SizedBox(width: 10),
            ],
          ]),
        ),
      ]),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: Text('Cancel', style: ADText.rowName(c: AvaDialTheme.textSoft)),
        ),
        TextButton(
          onPressed: _nameCtrl.text.trim().isEmpty || _busy ? null : _create,
          child: Text('Create', style: ADText.rowName(c: AvaDialTheme.accent)),
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

// ── Messages tab (SMS) ───────────────────────────────────────────────────────
/// Fills the Messages tab when `avaSms` is on. Until AvaTOK holds ROLE_SMS it shows
/// the "Make AvaTOK your messages app" banner over an explainer; once the role is
/// held it renders the live SMS conversation list + AI Inbox/Spam filter
/// ([SmsThreadsScreen]). The SMS role is independent of the dialer role.
class _MessagesTab extends StatefulWidget {
  const _MessagesTab();

  @override
  State<_MessagesTab> createState() => _MessagesTabState();
}

class _MessagesTabState extends State<_MessagesTab> {
  bool _held = false;
  bool _resolved = false;
  StreamSubscription<AvaRoleResult>? _sub;

  @override
  void initState() {
    super.initState();
    AvaDialChannel.I.ensureWired();
    _refresh();
    _sub = AvaDialChannel.I.roleResults.listen((r) {
      if (!mounted) return;
      // Android role name for ROLE_SMS is `android.app.role.SMS`.
      if (r.role.contains('SMS')) {
        Analytics.capture(
            r.granted ? 'avadial_sms_role_granted' : 'avadial_sms_role_denied', const {});
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
    final held = await AvaDialChannel.I.isSmsRoleHeld();
    if (mounted) setState(() {
      _held = held;
      _resolved = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_resolved) {
      return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
    }
    if (_held) return const SmsThreadsScreen();
    return Column(children: [
      const _SmsRoleBanner(),
      const Expanded(
        child: ShellEmptyState(
          icon: Icons.sms_outlined,
          title: 'Make AvaTOK your messages app',
          subtitle:
              'Set AvaTOK as your default SMS app to read your texts here with AI spam filtering.',
          color: AD.iconVideo,
        ),
      ),
    ]);
  }
}

/// "Make AvaTOK your messages app" → ROLE_SMS request. Mirrors [_RoleBanner].
class _SmsRoleBanner extends StatefulWidget {
  const _SmsRoleBanner();

  @override
  State<_SmsRoleBanner> createState() => _SmsRoleBannerState();
}

class _SmsRoleBannerState extends State<_SmsRoleBanner> {
  bool _busy = false;
  // [AVA-SMS-FIX-1] When the verdict arrives < kSmsRoleInstantDenial after the
  // request, the OS AUTO-DENIED without ever showing the picker (Android 15+
  // hard-restricts SMS for sideloaded installs until "Allow restricted
  // settings"; repeated denials also trip don't-ask-again). Previously that
  // path did NOTHING visible — a dead Enable button (root cause of the
  // 2026-07-13 "enable messages does nothing", 17 instant denials in PostHog).
  DateTime? _requestedAt;
  StreamSubscription<AvaRoleResult>? _verdictSub;

  @override
  void initState() {
    super.initState();
    _verdictSub = AvaDialChannel.I.roleResults.listen(_onVerdict);
  }

  @override
  void dispose() {
    _verdictSub?.cancel();
    super.dispose();
  }

  void _onVerdict(AvaRoleResult r) {
    if (!r.role.contains('SMS')) return;
    final askedAt = _requestedAt;
    _requestedAt = null;
    if (r.granted || askedAt == null || !mounted) return;
    if (isInstantDenial(askedAt)) {
      Analytics.capture('avadial_sms_role_autodenied',
          {'elapsed_ms': DateTime.now().difference(askedAt).inMilliseconds});
      showSmsRoleRestrictedHelp(context);
    } else {
      // A real human denial in the picker — nudge, don't nag.
      Analytics.capture('avadial_sms_enable_fallback_settings', const {});
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: const Text('AvaTOK wasn’t set as your messages app.'),
        action: SnackBarAction(
          label: 'Open settings',
          onPressed: () => AvaDialChannel.I.openDefaultAppsSettings(),
        ),
      ));
    }
  }

  Future<void> _request() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('avadial_sms_enable_tapped', const {});
    // requestSmsRole returns: true = already held, null = system prompt launched
    // (verdict arrives on roleResults), false = the prompt could NOT be shown
    // (no activity / role unavailable on this OEM / plugin error).
    bool? immediate;
    _requestedAt = DateTime.now();
    try {
      immediate = await AvaDialChannel.I.requestSmsRole();
    } catch (_) {
      immediate = false;
    }
    if (immediate != null) _requestedAt = null; // resolved synchronously
    if (immediate == true) {
      Analytics.capture('avadial_sms_role_granted', {'via': 'already_held'});
    } else if (immediate == false) {
      // The direct role prompt didn't open — never leave the button dead. Send the
      // user to the OS "Default apps" screen where they can pick AvaTOK as the SMS
      // app manually, and tell them what to do.
      Analytics.capture('avadial_sms_enable_fallback_settings', const {});
      await AvaDialChannel.I.openDefaultAppsSettings();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Open "SMS app" and choose AvaTOK to enable messages.')));
      }
    }
    // immediate == null → the system prompt is showing; verdict via roleResults.
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
      child: AdCard(
        color: AD.card,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), color: AD.iconVideo),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Make AvaTOK your messages app', style: ADText.threadName(c: AvaDialTheme.text)),
              const SizedBox(height: 2),
              Text('Read texts here with AI spam filtering.', style: ADText.preview(c: AvaDialTheme.textSoft)),
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
