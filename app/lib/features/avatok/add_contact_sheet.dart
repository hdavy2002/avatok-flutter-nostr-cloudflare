import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
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
  Timer? _searchTimer;

  List<DeviceContact> _all = const [];
  bool _loaded = false;
  bool _permDenied = false;
  bool _softAsk = false; // show our own rationale before the OS prompt
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
    // 3) Check permission WITHOUT prompting (permission_handler), so the first
    //    time we can show our own friendly rationale instead of springing the OS
    //    dialog. The hard prompt only fires when the user taps "Allow".
    final status = await Permission.contacts.status;
    if (!status.isGranted) {
      Analytics.capture('contacts_soft_ask_shown', const {'source': 'sheet_open'});
      if (mounted) setState(() => _softAsk = true);
      return; // wait for the user — no OS prompt yet
    }
    // 4) Already granted → sync + match in the background.
    await _syncNow(cached.length);
  }

  /// Background refresh + AvaTOK match, with the load telemetry. Assumes contacts
  /// permission is granted (DeviceContactsService.refresh re-checks anyway).
  Future<void> _syncNow(int cachedCount) async {
    if (mounted) setState(() => _refreshing = true);
    await DeviceContactsService.refresh(force: true, source: 'sheet_open');
    if (!mounted) return;
    setState(() { _refreshing = false; _permDenied = false; _softAsk = false; });
    final onAvatok = _all.where((d) => d.onAvatok).length;
    Analytics.capture('add_contact_loaded', {
      'cached_count': cachedCount,
      'count': _all.length,
      'on_avatok_count': onAvatok,
      'open_ms': DateTime.now().difference(_openedAt).inMilliseconds,
    });
    if (_all.isEmpty) {
      Analytics.capture('add_contact_empty', {'reason': _permDenied ? 'perm_denied' : 'no_contacts'});
    }
  }

  /// User accepted the rationale → fire the OS prompt, then sync (or show the
  /// denied panel if they declined the system dialog).
  Future<void> _allowContacts() async {
    Analytics.capture('contacts_soft_ask_accepted', const {'source': 'sheet'});
    setState(() { _softAsk = false; _refreshing = true; });
    final res = await Permission.contacts.request();
    if (!res.isGranted) {
      if (mounted) setState(() { _permDenied = true; _refreshing = false; });
      Analytics.capture('contacts_permission', {'granted': false, 'source': 'sheet_soft_ask'});
      return;
    }
    Analytics.capture('contacts_permission', {'granted': true, 'source': 'sheet_soft_ask'});
    await _syncNow((await DeviceContactsService.cached()).length);
  }

  /// Debounced search-usage telemetry — how people search + how often a search
  /// returns nothing (helps spot normalization/match gaps).
  void _onQuery(String v) {
    setState(() => _query = v);
    _searchTimer?.cancel();
    final q = v.trim();
    if (q.isEmpty) return;
    _searchTimer = Timer(const Duration(milliseconds: 500), () {
      final results = _filtered.length;
      Analytics.capture('add_contact_search', {
        'query_len': q.length,
        'is_numeric': RegExp(r'^[\d+\s()-]+$').hasMatch(q),
        'result_count': results,
        'has_results': results > 0,
      });
      if (results == 0) {
        Analytics.capture('add_contact_empty', {'reason': 'no_matches', 'query_len': q.length});
      }
    });
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _sub?.cancel();
    _searchTimer?.cancel();
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
      var ok = true;
      try {
        await DeviceContactsService.invite(d);
      } catch (e) {
        ok = false;
        Analytics.error(domain: 'contacts', code: 'invite_failed',
            screen: 'add_contact', action: 'invite', message: e.toString());
      }
      Analytics.capture('add_contact_invite_result', {'ok': ok});
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
    // First-run: our own gentle ask BEFORE the OS dialog.
    if (_softAsk && _all.isEmpty) {
      return _permissionPanel(
        title: 'Find people you know',
        body: 'AvaTOK can check your contacts to show which friends are already '
            'here and let you add them by phone number. Your contacts stay on your '
            'device and sync privately — we never post them publicly.',
        cta: 'Allow contacts',
        onTap: _allowContacts,
      );
    }
    // They saw the OS dialog and declined — point them to re-enable.
    if (_permDenied && _all.isEmpty) {
      return _permissionPanel(
        title: 'Contacts access is off',
        body: 'Allow AvaTOK to read your contacts so you can add people by phone '
            'number and see who\'s already here.',
        cta: 'Allow access',
        onTap: _allowContacts,
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZineField(
        controller: _phoneCtrl,
        hint: 'Search name or phone number',
        leadIcon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
        onChanged: _onQuery,
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

  Widget _permissionPanel({
    required String title,
    required String body,
    required String cta,
    required VoidCallback onTap,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold), color: Zine.lilac, size: 34),
          const SizedBox(width: 10),
          Expanded(child: Text(title, style: ZineText.value(size: 15))),
        ]),
        const SizedBox(height: 10),
        Text(body, style: ZineText.sub(size: 12.5)),
        const SizedBox(height: 14),
        ZineButton(
          label: _refreshing ? 'Loading…' : cta,
          fullWidth: true,
          fontSize: 16,
          loading: _refreshing,
          icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
          trailingIcon: false,
          onPressed: _refreshing ? null : onTap,
        ),
        const SizedBox(height: 8),
        Center(child: ZineLink('Not now', onTap: () => Navigator.pop(context))),
      ]),
    );
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
