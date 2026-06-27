import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/device_contacts.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'add_by_link_sheet.dart';
import 'contacts.dart';

/// New-chat sheet — a RESOLVE box, not a phone-book browser.
///
/// PRIVACY (owner decision 2026-06-27): you find people ONLY by their exact,
/// owner-controlled keys — an email or an AvaTOK number — never by browsing /
/// searching the device address book by private number. (Resolving a private
/// phone → account is disabled server-side, so a phone number simply returns
/// nothing.) Your already-saved AvaTOK contacts appear as quick-picks. Inviting
/// friends is a SEPARATE, explicit action that opens the OS share sheet: the
/// phone book never leaves the device and nobody is annotated "on AvaTOK".
Future<Contact?> showAddContactSheet(BuildContext context) {
  return showModalBottomSheet<Contact>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: Zine.ink, width: Zine.bw),
        borderRadius: BorderRadius.vertical(top: Radius.circular(26))),
    builder: (_) => const _AddContactSheet(),
  );
}

class _AddContactSheet extends StatefulWidget {
  const _AddContactSheet();
  @override
  State<_AddContactSheet> createState() => _AddContactSheetState();
}

class _AddContactSheetState extends State<_AddContactSheet> {
  final _ctrl = TextEditingController();
  Timer? _debounce;

  List<Contact> _saved = const [];
  String _query = '';
  bool _resolving = false;     // looking the query up against the directory
  Contact? _resolvedHit;       // an AvaTOK account found by email / AvaTOK number
  bool _resolvedMiss = false;  // searched but nothing matched
  bool _inviting = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'new_chat');
    ContactsStore().load().then((cs) { if (mounted) setState(() => _saved = cs); });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  void _onQuery(String v) {
    setState(() {
      _query = v;
      if (v.trim().isEmpty) { _resolvedHit = null; _resolving = false; _resolvedMiss = false; }
    });
    _debounce?.cancel();
    final q = v.trim();
    if (q.isEmpty) return;
    _debounce = Timer(const Duration(milliseconds: 450), () => _maybeResolve(q));
  }

  /// Resolve ONLY emails and AvaTOK numbers. A bare name isn't a lookup key here
  /// (use global search for that), and a private phone resolves to nothing by
  /// design — so we don't even probe for it.
  Future<void> _maybeResolve(String q) async {
    final isEmail = Directory.isCompleteEmail(q);
    final isNumber = RegExp(r'^[+\d][\d\s()-]{3,}$').hasMatch(q);
    if (!isEmail && !isNumber) {
      if (mounted) setState(() { _resolvedHit = null; _resolving = false; _resolvedMiss = false; });
      return;
    }
    if (mounted) setState(() { _resolving = true; _resolvedHit = null; _resolvedMiss = false; });
    Analytics.capture('new_chat_resolve', {'kind': isEmail ? 'email' : 'avatok_number'});
    Contact? hit;
    try { hit = await Directory.resolve(q); } catch (_) { hit = null; }
    if (!mounted || _query.trim() != q) return; // a newer query superseded this
    setState(() {
      _resolving = false;
      _resolvedHit = (hit != null && hit.npub.isNotEmpty) ? hit : null;
      _resolvedMiss = _resolvedHit == null;
    });
  }

  List<Contact> get _filteredSaved {
    final q = _query.trim().toLowerCase();
    final list = q.isEmpty
        ? _saved
        : _saved.where((c) =>
            c.name.toLowerCase().contains(q) ||
            c.number.toLowerCase().contains(q) ||
            c.email.toLowerCase().contains(q)).toList();
    return list.take(40).toList();
  }

  Future<void> _invite() async {
    if (_inviting) return;
    setState(() => _inviting = true);
    Analytics.capture('new_chat_invite_friends', const {});
    String? handle;
    try { handle = (await ProfileStore().load()).handle; } catch (_) {}
    try { await DeviceContactsService.shareGenericInvite(myHandle: handle); } catch (_) {}
    if (mounted) setState(() => _inviting = false);
  }

  Future<void> _addByLink() async {
    final c = await showAddByLinkSheet(context);
    if (c != null && mounted) Navigator.pop(context, c);
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final bottom = mq.viewInsets.bottom + mq.padding.bottom + 16;
    final saved = _filteredSaved;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(color: Zine.inkMute, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            Row(children: [
              Text('New chat', style: ZineText.cardTitle(size: 22)),
              const Spacer(),
              GestureDetector(
                onTap: _addByLink,
                child: PhosphorIcon(PhosphorIcons.qrCode(PhosphorIconsStyle.bold), size: 24, color: Zine.ink),
              ),
            ]),
            const SizedBox(height: 4),
            Text('Find someone by their email or AvaTOK number.', style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 14),
            ZineField(
              controller: _ctrl,
              hint: 'Email or AvaTOK number',
              leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
              onChanged: _onQuery,
            ),
            const SizedBox(height: 10),
            if (_resolving)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 10),
                  Text('Looking up on AvaTOK…'),
                ]),
              ),
            if (_resolvedHit != null) _resolvedTile(_resolvedHit!),
            if (_resolvedMiss && !_resolving)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text(
                    'No AvaTOK account for that. You can only find people by their '
                    'email or AvaTOK number — invite them below instead.',
                    style: ZineText.sub(size: 12.5, color: Zine.inkSoft)),
              ),
            // Saved AvaTOK contacts as quick-picks (never the phone book).
            if (saved.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text('YOUR AVATOK CONTACTS', style: ZineText.tag(size: 11, color: Zine.inkMute)),
              const SizedBox(height: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 300),
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: saved.length,
                  itemBuilder: (_, i) => _savedTile(saved[i]),
                ),
              ),
            ],
            const SizedBox(height: 14),
            // Invite is a separate, explicit, DEVICE-LOCAL action (OS share sheet).
            ZineButton(
              label: _inviting ? 'Opening…' : 'Invite friends to AvaTok',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              fontSize: 15,
              loading: _inviting,
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _inviting ? null : _invite,
            ),
          ],
        ),
      ),
    );
  }

  Widget _resolvedTile(Contact c) => Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: Zine.mint.withValues(alpha: 0.25),
          borderRadius: BorderRadius.circular(Zine.r),
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: ListTile(
          leading: Container(
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
            child: Avatar(seed: c.npub, name: c.name, size: 40, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
          ),
          title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: ZineText.value(size: 14.5)),
          subtitle: Text('On AvaTOK — tap to add & message', style: ZineText.sub(size: 12.5)),
          trailing: PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), color: Zine.ink, size: 22),
          onTap: () => Navigator.pop(context, c),
        ),
      );

  Widget _savedTile(Contact c) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Container(
          decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
          child: Avatar(seed: c.npub, name: c.name, size: 40, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
        ),
        title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: ZineText.value(size: 14.5)),
        subtitle: Text(c.subtitle, style: ZineText.sub(size: 12.5)),
        trailing: PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), color: Zine.blueInk, size: 20),
        onTap: () => Navigator.pop(context, c),
      );
}
