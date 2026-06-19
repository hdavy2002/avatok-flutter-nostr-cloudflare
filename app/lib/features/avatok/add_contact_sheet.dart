import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/device_contacts.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'contacts.dart';

/// Bottom sheet to add a contact — WhatsApp-style, phone-number only.
///
/// The list paints INSTANTLY from the per-account SQLite cache
/// ([DeviceContactsCache]); we never re-read the OS address book on the UI path.
/// A background [DeviceContactsService.refresh] runs on open to fold in any new
/// numbers and resolve which contacts are already on AvaTOK — the cache stream
/// repaints the list live as those land. People already on AvaTOK show an "On
/// AvaTOK" badge and add instantly (no network round-trip); everyone else gets a
/// one-tap invite. (The old "Search by handle" tab was removed.)
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
  final _phoneCtrl = TextEditingController();
  StreamSubscription<List<DeviceContact>>? _sub;

  List<DeviceContact> _all = const [];
  bool _loaded = false;
  bool _permDenied = false;
  bool _refreshing = false;
  String _query = '';
  bool _busy = false;
  final _openedAt = DateTime.now();

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'add_contact');
    _boot();
  }

  Future<void> _boot() async {
    // 1) Paint instantly from cache (zero OS calls).
    final cached = await DeviceContactsService.cached();
    if (mounted) setState(() { _all = cached; _loaded = true; });
    // 2) Watch the cache so background sync repaints the list live.
    _sub = DeviceContactsService.watch().listen((rows) {
      if (mounted) setState(() { _all = rows; _loaded = true; });
    });
    // 3) Permission state for the empty/denied panel.
    final granted = await DeviceContactsService.hasPermission();
    if (mounted && !granted) setState(() => _permDenied = true);
    // 4) Kick the background refresh + AvaTOK match.
    if (mounted) setState(() => _refreshing = true);
    await DeviceContactsService.refresh(force: true);
    if (mounted) {
      setState(() { _refreshing = false; _permDenied = false; });
      Analytics.capture('add_contact_loaded', {
        'cached_count': cached.length,
        'count': _all.length,
        'open_ms': DateTime.now().difference(_openedAt).inMilliseconds,
      });
    }
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _sub?.cancel();
    super.dispose();
  }

  List<DeviceContact> get _filtered {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) {
      // No query: surface on-AvaTOK people first (already sorted that way by the
      // DB), cap the list so the sheet stays light.
      return _all.take(60).toList();
    }
    final qDigits = q.replaceAll(RegExp(r'[^\d]'), '');
    return _all.where((d) {
      if (d.displayName.toLowerCase().contains(q)) return true;
      if (qDigits.isNotEmpty &&
          d.phoneNorm.replaceAll(RegExp(r'[^\d]'), '').contains(qDigits)) return true;
      return false;
    }).take(80).toList();
  }

  Future<void> _onTap(DeviceContact d) async {
    if (_busy) return;
    if (d.onAvatok) {
      // Already on AvaTOK → we hold their public profile, so add with NO network.
      Analytics.capture('add_contact_pick', {'on_avatok': true});
      Navigator.pop(
        context,
        Contact(
          npub: d.uid,
          name: d.displayName,
          handle: d.handle,
          avatarUrl: d.avatarUrl,
          phone: d.rawPhone,
        ),
      );
    } else {
      // Not on AvaTOK yet → WhatsApp-style invite via the native share sheet.
      Analytics.capture('add_contact_invite', const {'on_avatok': false});
      setState(() => _busy = true);
      try {
        await DeviceContactsService.invite(d);
      } catch (_) {/* user dismissed share sheet */}
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('${d.displayName} isn\'t on AvaTOK yet — invite sent')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final bottom = mq.viewInsets.bottom + mq.padding.bottom + 16;
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
                decoration: BoxDecoration(
                    color: Zine.inkMute, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            Row(children: [
              Text('Add contact', style: ZineText.cardTitle(size: 22)),
              const Spacer(),
              if (_refreshing)
                const SizedBox(
                    width: 16, height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2)),
            ]),
            const SizedBox(height: 4),
            Text('People from your phone who are on AvaTOK appear first.',
                style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 14),
            _body(),
          ],
        ),
      ),
    );
  }

  Widget _body() {
    if (_permDenied && _all.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Contacts access is off', style: ZineText.value(size: 14.5)),
          const SizedBox(height: 6),
          Text(
            'Allow AvaTOK to read your contacts so you can add people by phone '
            'number and see who\'s already here.',
            style: ZineText.sub(size: 12.5),
          ),
          const SizedBox(height: 12),
          ZineButton(
              label: 'Allow access',
              onPressed: () { setState(() { _permDenied = false; _refreshing = true; }); _boot(); }),
        ]),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZineField(
        controller: _phoneCtrl,
        hint: 'Search name or phone number',
        leadIcon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
        onChanged: (v) => setState(() => _query = v),
      ),
      const SizedBox(height: 10),
      ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 360),
        child: !_loaded
            ? const Padding(
                padding: EdgeInsets.symmetric(vertical: 28),
                child: Center(child: SizedBox(
                    width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))))
            : _list(),
      ),
    ]);
  }

  Widget _list() {
    final items = _filtered;
    if (items.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Center(child: Text(
            _query.trim().isEmpty
                ? (_refreshing ? 'Loading your contacts…' : 'No contacts found on your phone')
                : 'No matches',
            style: ZineText.sub(size: 13))),
      );
    }
    return ListView.builder(
      shrinkWrap: true,
      itemCount: items.length,
      itemBuilder: (_, i) {
        final d = items[i];
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Container(
            decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: 2)),
            child: Avatar(
                seed: d.onAvatok ? d.uid : d.phoneNorm,
                name: d.displayName,
                size: 40,
                avatarUrl: d.avatarUrl.isEmpty ? null : d.avatarUrl),
          ),
          title: Text(d.displayName, style: ZineText.value(size: 14.5)),
          subtitle: Text(d.subtitle, style: ZineText.sub(size: 12.5)),
          trailing: d.onAvatok ? _onAvatokBadge() : _inviteTrailing(),
          onTap: _busy ? null : () => _onTap(d),
        );
      },
    );
  }

  // Mint "On AvaTOK" pill — money/success accent (the person can be messaged now).
  Widget _onAvatokBadge() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(
          color: Zine.mint,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 1.5),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 11, color: Zine.ink),
          const SizedBox(width: 4),
          Text('On AvaTOK', style: ZineText.tag(size: 10)),
        ]),
      );

  Widget _inviteTrailing() => _busy
      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
      : PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), color: Zine.inkMute, size: 22);
}
