import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/device_contacts.dart';
import '../../core/profile_store.dart';
import '../../core/ui/avatok_dark.dart';
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
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: AD.borderControl, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
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
    // [SEARCH-PHONE-RESTORE 2026-07-12] Phone-number search restored alongside
    // email (owner request). A number-like query resolves an account again
    // regardless of the businessCallUx channel-split flag (email OR number both
    // resolve), matching the pre-split legacy behaviour.
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
      _resolvedHit = (hit != null && hit.uid.isNotEmpty) ? hit : null;
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
                decoration: BoxDecoration(color: AD.textFaint, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            Row(children: [
              Text('New chat', style: ADText.appTitle()),
              const Spacer(),
              GestureDetector(
                onTap: _addByLink,
                child: PhosphorIcon(PhosphorIcons.qrCode(PhosphorIconsStyle.bold), size: 24, color: AD.textPrimary),
              ),
            ]),
            const SizedBox(height: 4),
            Text(
                'Find someone by their email or AvaTOK number.',
                style: ADText.preview()),
            const SizedBox(height: 14),
            // White dark-v2 resolve field.
            Container(
              decoration: BoxDecoration(
                color: AD.inputField,
                borderRadius: BorderRadius.circular(AD.rInput),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                    size: 18, color: AD.placeholderOnWhite),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: _ctrl,
                    onChanged: _onQuery,
                    cursorColor: AD.primaryBadge,
                    style: ADText.rowName(c: AD.textOnInput),
                    decoration: InputDecoration(
                      isDense: true,
                      border: InputBorder.none,
                      hintText: 'Email or AvaTOK number',
                      hintStyle: ADText.rowName(c: AD.placeholderOnWhite),
                      contentPadding: const EdgeInsets.symmetric(vertical: 15),
                    ),
                  ),
                ),
              ]),
            ),
            const SizedBox(height: 10),
            if (_resolving)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch)),
                  const SizedBox(width: 10),
                  Text('Looking up on AvaTOK…', style: ADText.preview()),
                ]),
              ),
            if (_resolvedHit != null) _resolvedTile(_resolvedHit!),
            if (_resolvedMiss && !_resolving)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text(
                    'No AvaTOK account for that. You can only find people by their '
                    'email or AvaTOK number — invite them below instead.',
                    style: ADText.preview(c: AD.textSecondary)),
              ),
            // Saved AvaTOK contacts as quick-picks (never the phone book).
            if (saved.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text('YOUR AVATOK CONTACTS', style: ADText.sectionLabel()),
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
            GestureDetector(
              onTap: _inviting ? null : _invite,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 15),
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  if (_inviting)
                    const SizedBox(width: 18, height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AD.textSecondary))
                  else
                    PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
                        size: 18, color: AD.textPrimary),
                  const SizedBox(width: 10),
                  Text(_inviting ? 'Opening…' : 'Invite friends to AvaTok',
                      style: ADText.rowName()),
                ]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _resolvedTile(Contact c) => Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: AD.online.withValues(alpha: 0.16),
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: ListTile(
          leading: Container(
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
            child: Avatar(seed: c.uid, name: c.name, size: 40, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
          ),
          title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: ADText.rowName()),
          subtitle: Text('On AvaTOK — tap to add & message', style: ADText.preview()),
          trailing: PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), color: AD.online, size: 22),
          onTap: () => Navigator.pop(context, c),
        ),
      );

  Widget _savedTile(Contact c) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Container(
          decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
          child: Avatar(seed: c.uid, name: c.name, size: 40, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
        ),
        title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: ADText.rowName()),
        subtitle: Text(c.subtitle, style: ADText.preview()),
        trailing: PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), color: AD.iconSearch, size: 20),
        onTap: () => Navigator.pop(context, c),
      );
}
