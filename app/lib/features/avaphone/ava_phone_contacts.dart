import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/ice_cache.dart';
import '../../core/device_contacts.dart';
import '../avatok/add_by_link_sheet.dart';
import '../avatok/place_1to1_call.dart';
import '../avatok/chat_thread.dart';
import '../avatok/contact_actions.dart';
import '../avatok/contact_profile_screen.dart';
import '../avatok/contacts.dart';
import '../avatok/data.dart';
import 'phone_theme.dart';

/// AvaPhone › Contacts — AvaTOK NUMBER contacts ONLY.
///
/// Critically, this list is NOT the phone's address book. It shows only people
/// saved by their AvaTOK number, each clearly marked as an AvaTOK number, so the
/// user is never confused with their real phone contacts. New contacts are added
/// by typing an AvaTOK number (resolved on the network) or by scanning/pasting a
/// shared QR link — never by importing the device address book.
class AvaPhoneContacts extends StatefulWidget {
  const AvaPhoneContacts({super.key});
  @override
  State<AvaPhoneContacts> createState() => _AvaPhoneContactsState();
}

class _AvaPhoneContactsState extends State<AvaPhoneContacts> {
  final _store = ContactsStore();
  final _flags = ChatFlagsStore();
  List<Contact> _all = [];
  Set<String> _blocked = {};
  bool _loaded = false;
  String _q = '';

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaphone', 'contacts');
    _load();
  }

  Future<void> _load() async {
    final cs = await _store.load();
    final flags = await _flags.load();
    if (!mounted) return;
    setState(() { _all = cs; _blocked = flags['blocked'] ?? {}; _loaded = true; });
  }

  String _key(Contact c) => '1:${c.uid}';
  bool _isBlocked(Contact c) => _blocked.contains(_key(c));

  Future<void> _toggleBlock(Contact c) async {
    final wasBlocked = _isBlocked(c);
    await _flags.toggle('blocked', _key(c));
    final flags = await _flags.load();
    if (mounted) setState(() => _blocked = flags['blocked'] ?? {});
    Analytics.capture('avaphone_contact_block', {'blocked': !wasBlocked});
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(wasBlocked ? 'Unblocked ${c.name.isNotEmpty ? c.name : c.number}'
                                   : 'Blocked ${c.name.isNotEmpty ? c.name : c.number}')));
    }
  }

  void _viewContact(Contact c) {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => ContactProfileScreen(name: c.name, uid: c.uid)));
  }

  /// AvaTOK-number contacts only — phone-only entries never appear here.
  List<Contact> get _avatok {
    final list = _all.where((c) => c.number.isNotEmpty).toList();
    final q = _q.trim().toLowerCase();
    final filtered = q.isEmpty
        ? list
        : list.where((c) => c.name.toLowerCase().contains(q) || c.number.toLowerCase().contains(q)).toList();
    filtered.sort((a, b) => (a.name.isNotEmpty ? a.name : a.number)
        .toLowerCase()
        .compareTo((b.name.isNotEmpty ? b.name : b.number).toLowerCase()));
    return filtered;
  }

  Future<void> _add() async {
    final c = await showModalBottomSheet<Contact>(
      context: context, isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _AddAvatokSheet(onScanQr: () async {
        Navigator.pop(context); // close this sheet first
        final scanned = await showAddByLinkSheet(context);
        if (scanned != null && mounted) await _save(scanned);
      }),
    );
    if (c != null && mounted) await _save(c);
  }

  Future<void> _save(Contact c) async {
    final list = await _store.add(c);
    if (!mounted) return;
    setState(() => _all = list);
    Analytics.capture('avaphone_contact_added', const {});
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Saved ${c.name.isNotEmpty ? c.name : c.number}')));
  }

  void _actions(Contact c) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: PhoneTheme.surface,
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: PhoneTheme.border, width: 1.5),
        borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 10),
        ListTile(
          leading: PhoneTheme.ring(Avatar(seed: c.uid, name: c.name, size: 44,
              avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl)),
          title: Text(c.name.isNotEmpty ? c.name : c.number, style: PhoneTheme.value(size: 15.5)),
          subtitle: Text(c.number, style: PhoneTheme.sub(size: 12.5)),
        ),
        const Divider(color: PhoneTheme.border, height: 1),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.user(PhosphorIconsStyle.bold), color: PhoneTheme.lilac),
          title: Text('View contact', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _viewContact(c); }),
        ListTile(
          leading: const Icon(Icons.call, color: PhoneTheme.callGreen),
          title: Text('Dial', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _call(c); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.chatText(PhosphorIconsStyle.bold), color: PhoneTheme.teal),
          title: Text('Message', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _message(c); }),
        // [FIX-CONTACT-1] Copy / Share vCard / Forward as a card — shared actions.
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), color: PhoneTheme.lilac),
          title: Text('Copy contact', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); ContactActions.copy(context, c); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), color: PhoneTheme.accent),
          title: Text('Share contact', style: PhoneTheme.value(size: 15)),
          subtitle: Text('vCard — WhatsApp, email & more', style: PhoneTheme.sub(size: 11.5)),
          onTap: () { Navigator.pop(ctx); ContactActions.share(context, c); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), color: PhoneTheme.teal),
          title: Text('Forward contact', style: PhoneTheme.value(size: 15)),
          subtitle: Text('Send as a card to a chat or group', style: PhoneTheme.sub(size: 11.5)),
          onTap: () { Navigator.pop(ctx); ContactActions.forward(context, c); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: PhoneTheme.danger),
          title: Text(_isBlocked(c) ? 'Unblock contact' : 'Block contact', style: PhoneTheme.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _toggleBlock(c); }),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: PhoneTheme.danger),
          title: Text('Delete contact', style: PhoneTheme.value(size: 15, color: PhoneTheme.danger)),
          onTap: () async { Navigator.pop(ctx); final l = await _store.remove(c.uid); if (mounted) setState(() => _all = l); }),
        const SizedBox(height: 8),
      ])),
    );
  }

  void _call(Contact c) {
    IceCache.prefetch();
    Analytics.capture('avaphone_contact_call', const {});
    // [AVA-IDGATE-1] Route through /api/call (gate + real ring) instead of opening
    // CallScreen directly.
    place1to1Call(context, uid: c.uid, name: c.name.isNotEmpty ? c.name : c.number,
        avatarUrl: c.avatarUrl);
  }

  void _message(Contact c) {
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(
      chat: Chat(name: c.name.isNotEmpty ? c.name : c.number, seed: c.uid,
          avatarUrl: c.avatarUrl, last: '', time: ''))));
  }

  /// Invite friends: pull the phone address book ONLY to share an invite via
  /// WhatsApp/email (the OS share sheet). Nothing is imported into AvaTOK
  /// contacts and no numbers are uploaded.
  Future<void> _invite() async {
    Analytics.capture('avaphone_invite_friends', const {});
    try { await DeviceContactsService.shareGenericInvite(); } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final list = _avatok;
    return Scaffold(
      backgroundColor: PhoneTheme.bg,
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: PhoneTheme.accent,
        foregroundColor: const Color(0xFF0E1116),
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: PhoneTheme.border, width: 2)),
        onPressed: _add,
        icon: PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 18),
        label: Text('Add', style: PhoneTheme.tag(size: 11.5, color: const Color(0xFF0E1116))),
      ),
      body: SafeArea(
        bottom: false,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
            child: Row(children: [
              Text('Contacts', style: PhoneTheme.title(size: 24)),
              const Spacer(),
              IconButton(
                onPressed: _invite,
                tooltip: 'Invite friends',
                icon: PhosphorIcon(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.bold),
                    size: 20, color: PhoneTheme.accent)),
              const SizedBox(width: 2),
              PhoneTheme.chip('On AvaTOK', color: PhoneTheme.teal,
                  icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill)),
            ]),
          ),
          // Explicit clarification banner (owner request): these are AvaTOK-network
          // identities, not the phone's address book.
          Container(
            margin: const EdgeInsets.fromLTRB(14, 0, 14, 8),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: PhoneTheme.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: PhoneTheme.border, width: 1.2),
            ),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.fill), size: 15, color: PhoneTheme.teal),
              const SizedBox(width: 8),
              Expanded(child: Text(
                'All contacts here are on the AvaTOK network — not from your phone’s contact list.',
                style: PhoneTheme.sub(size: 11.5))),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
            child: Container(
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                color: PhoneTheme.surface,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: PhoneTheme.border, width: 1.5)),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), size: 17, color: PhoneTheme.textSoft),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    style: PhoneTheme.value(size: 14),
                    cursorColor: PhoneTheme.accent,
                    decoration: InputDecoration(
                      isCollapsed: true, border: InputBorder.none,
                      hintText: 'Search AvaTOK contacts',
                      hintStyle: PhoneTheme.sub(size: 13, color: PhoneTheme.textMute)),
                    onChanged: (v) => setState(() => _q = v),
                  ),
                ),
              ]),
            ),
          ),
          Expanded(
            child: !_loaded
                ? const Center(child: CircularProgressIndicator(color: PhoneTheme.accent))
                : (list.isEmpty ? _empty() : ListView.builder(
                    padding: const EdgeInsets.only(bottom: 96),
                    itemCount: list.length,
                    itemBuilder: (_, i) => _row(list[i]),
                  )),
          ),
        ]),
      ),
    );
  }

  Widget _row(Contact c) => InkWell(
        onTap: () => _actions(c),
        onLongPress: () => _actions(c), // long-press → view/dial/share/block/delete
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
          child: Row(children: [
            PhoneTheme.ring(Avatar(seed: c.uid, name: c.name, size: 46,
                avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(c.name.isNotEmpty ? c.name : c.number,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: PhoneTheme.value(size: 15)),
                const SizedBox(height: 4),
                Row(children: [
                  PhoneTheme.chip(c.number, color: PhoneTheme.teal,
                      icon: PhosphorIcons.hash(PhosphorIconsStyle.bold)),
                ]),
              ]),
            ),
            IconButton(
              onPressed: () => _call(c),
              icon: const Icon(Icons.call, size: 20, color: PhoneTheme.callGreen)),
          ]),
        ),
      );

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.addressBook(PhosphorIconsStyle.bold), size: 46, color: PhoneTheme.textMute),
            const SizedBox(height: 14),
            Text(_q.isEmpty ? 'No AvaTOK contacts yet' : 'No matches', style: PhoneTheme.title(size: 17)),
            const SizedBox(height: 6),
            Text('Add someone by their AvaTOK number or scan their QR code.',
                textAlign: TextAlign.center, style: PhoneTheme.sub(size: 13)),
          ]),
        ),
      );
}

// ─────────────────── add an AvaTOK contact (number or QR) ──────────────────

class _AddAvatokSheet extends StatefulWidget {
  final VoidCallback onScanQr;
  const _AddAvatokSheet({required this.onScanQr});
  @override
  State<_AddAvatokSheet> createState() => _AddAvatokSheetState();
}

class _AddAvatokSheetState extends State<_AddAvatokSheet> {
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
    if (q.replaceAll(RegExp(r'[^\d]'), '').length < 4) {
      setState(() => _error = 'Enter a full AvaTOK number');
      return;
    }
    setState(() { _resolving = true; _error = null; });
    Analytics.capture('avaphone_contact_resolve', {'len': q.length});
    Contact? hit;
    try { hit = await Directory.resolve(q); } catch (_) { hit = null; }
    if (!mounted) return;
    if (hit == null || hit.uid.isEmpty) {
      setState(() { _resolving = false; _error = 'No AvaTOK account on that number'; });
      return;
    }
    // Ensure the saved contact carries the dialed AvaTOK number for display.
    final saved = hit.number.isNotEmpty
        ? hit
        : Contact(uid: hit.uid, name: hit.name, email: hit.email, avatarUrl: hit.avatarUrl, number: q);
    Navigator.pop(context, saved);
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).padding.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Container(
        decoration: const BoxDecoration(
          color: PhoneTheme.surface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
          border: Border(top: BorderSide(color: PhoneTheme.border, width: 1.5)),
        ),
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 18),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Center(child: Container(width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(color: PhoneTheme.border, borderRadius: BorderRadius.circular(100)))),
          Text('Add AvaTOK contact', style: PhoneTheme.title(size: 20)),
          const SizedBox(height: 4),
          Text('Save someone by their AvaTOK number.', style: PhoneTheme.sub(size: 12.5)),
          const SizedBox(height: 14),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.phone,
            style: PhoneTheme.value(size: 16),
            cursorColor: PhoneTheme.accent,
            decoration: InputDecoration(
              hintText: 'AvaTOK number, e.g. +233 24 555 0148',
              hintStyle: PhoneTheme.sub(size: 13.5, color: PhoneTheme.textMute),
              filled: true, fillColor: PhoneTheme.surface2,
              prefixIcon: PhosphorIcon(PhosphorIcons.hash(PhosphorIconsStyle.bold), size: 18, color: PhoneTheme.teal),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: PhoneTheme.border, width: 1.5)),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: PhoneTheme.accent, width: 1.8)),
            ),
            onSubmitted: (_) => _resolve(),
          ),
          if (_error != null)
            Padding(padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: PhoneTheme.sub(size: 12.5, color: PhoneTheme.danger))),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              style: ElevatedButton.styleFrom(
                backgroundColor: PhoneTheme.accent, foregroundColor: const Color(0xFF0E1116),
                elevation: 0, padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                  side: const BorderSide(color: PhoneTheme.border, width: 2)),
              ),
              onPressed: _resolving ? null : _resolve,
              icon: _resolving
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2.4, color: Color(0xFF0E1116)))
                  : PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 18),
              label: Text(_resolving ? 'Finding…' : 'Find & save', style: PhoneTheme.value(size: 15, color: const Color(0xFF0E1116))),
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: PhoneTheme.text,
                padding: const EdgeInsets.symmetric(vertical: 14),
                side: const BorderSide(color: PhoneTheme.border, width: 1.5),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
              onPressed: widget.onScanQr,
              icon: PhosphorIcon(PhosphorIcons.qrCode(PhosphorIconsStyle.bold), size: 18, color: PhoneTheme.text),
              label: Text('Scan / paste QR code', style: PhoneTheme.value(size: 14.5)),
            ),
          ),
        ]),
      ),
    );
  }
}
