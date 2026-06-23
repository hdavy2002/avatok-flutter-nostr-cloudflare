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
  bool _resolving = false; // looking up a typed email/phone against the AvaTOK directory
  Contact? _resolvedHit;   // an AvaTOK account found by resolving that query
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
    setState(() { _query = v; if (v.trim().isEmpty) { _resolvedHit = null; _resolving = false; } });
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
      // Also look the query up against the AvaTOK directory so someone who is on
      // AvaTOK but NOT in your phonebook is still findable + messageable by their
      // email or phone number.
      _maybeResolve(q);
    });
  }

  /// Resolve an email/phone query against the directory. Surfaces an "On AvaTOK"
  /// tile when it maps to a real account (tapping adds them + opens a chat that
  /// actually delivers). No-ops for plain name searches.
  Future<void> _maybeResolve(String q) async {
    final isEmail = Directory.isCompleteEmail(q);
    final isPhone = RegExp(r'^[+\d][\d\s()-]{4,}$').hasMatch(q);
    if (!isEmail && !isPhone) {
      if (mounted && (_resolvedHit != null || _resolving)) setState(() { _resolvedHit = null; _resolving = false; });
      return;
    }
    if (mounted) setState(() { _resolving = true; _resolvedHit = null; });
    Contact? hit;
    try { hit = await Directory.resolve(q); } catch (_) { hit = null; }
    if (!mounted || _query.trim() != q) return; // stale — a newer query superseded it
    // Don't surface yourself, or someone already shown as an on-AvaTOK match.
    setState(() { _resolving = false; _resolvedHit = hit; });
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
        hint: 'Name, phone number, or email',
        leadIcon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
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
      final q = _query.trim();
      // A phone-like query that ISN'T an AvaTOK account (not resolving / no hit)
      // → offer to create + sync a new device contact (name, phone+country,
      // email, notes). If they ARE on AvaTOK, the resolved tile above handles it.
      if (q.isNotEmpty && _resolvedHit == null && !_resolving &&
          RegExp(r'^[\d+\s()-]{5,}$').hasMatch(q)) {
        return SingleChildScrollView(
          padding: const EdgeInsets.only(top: 4, bottom: 8),
          child: _NewContactForm(initialPhone: q),
        );
      }
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Center(child: Text(
            q.isEmpty
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

  // A directory hit: someone on AvaTOK found by their email/phone (even if not in
  // your phonebook). Tapping returns them so a real, deliverable chat opens.
  Widget _resolvedTile(Contact c) => Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: Zine.mint.withOpacity(0.25),
          borderRadius: BorderRadius.circular(Zine.r),
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: ListTile(
          leading: Container(
            decoration: BoxDecoration(
                shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
            child: Avatar(
                seed: c.npub, name: c.name, size: 40,
                avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
          ),
          title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: ZineText.value(size: 14.5)),
          subtitle: Text('On AvaTOK — tap to add & message', style: ZineText.sub(size: 12.5)),
          trailing: PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), color: Zine.ink, size: 22),
          onTap: () => Navigator.pop(context, c),
        ),
      );
}

// ─── Create-a-new-contact form (shown when a searched number isn't on AvaTOK) ──

class _Country {
  final String flag;
  final String name;
  final String dial; // includes leading '+'
  const _Country(this.flag, this.name, this.dial);
}

// A compact, dependency-free list of common dial codes. (Extend freely.)
const List<_Country> _kCountries = [
  _Country('🇺🇸', 'United States', '+1'),
  _Country('🇮🇳', 'India', '+91'),
  _Country('🇬🇧', 'United Kingdom', '+44'),
  _Country('🇨🇦', 'Canada', '+1'),
  _Country('🇦🇺', 'Australia', '+61'),
  _Country('🇦🇪', 'UAE', '+971'),
  _Country('🇸🇬', 'Singapore', '+65'),
  _Country('🇩🇪', 'Germany', '+49'),
  _Country('🇫🇷', 'France', '+33'),
  _Country('🇪🇸', 'Spain', '+34'),
  _Country('🇮🇹', 'Italy', '+39'),
  _Country('🇳🇱', 'Netherlands', '+31'),
  _Country('🇧🇷', 'Brazil', '+55'),
  _Country('🇲🇽', 'Mexico', '+52'),
  _Country('🇿🇦', 'South Africa', '+27'),
  _Country('🇳🇬', 'Nigeria', '+234'),
  _Country('🇰🇪', 'Kenya', '+254'),
  _Country('🇵🇰', 'Pakistan', '+92'),
  _Country('🇧🇩', 'Bangladesh', '+880'),
  _Country('🇵🇭', 'Philippines', '+63'),
  _Country('🇮🇩', 'Indonesia', '+62'),
  _Country('🇯🇵', 'Japan', '+81'),
  _Country('🇨🇳', 'China', '+86'),
  _Country('🇸🇦', 'Saudi Arabia', '+966'),
  _Country('🇹🇷', 'Turkey', '+90'),
  _Country('🇷🇺', 'Russia', '+7'),
  _Country('🇰🇷', 'South Korea', '+82'),
  _Country('🇲🇾', 'Malaysia', '+60'),
  _Country('🇪🇬', 'Egypt', '+20'),
  _Country('🇳🇿', 'New Zealand', '+64'),
];

class _NewContactForm extends StatefulWidget {
  final String initialPhone;
  const _NewContactForm({required this.initialPhone});
  @override
  State<_NewContactForm> createState() => _NewContactFormState();
}

class _NewContactFormState extends State<_NewContactForm> {
  final _first = TextEditingController();
  final _last = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  final _notes = TextEditingController();
  _Country _country = _kCountries.first;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _phone.text = widget.initialPhone.replaceAll(RegExp(r'[^\d]'), '');
  }

  @override
  void dispose() {
    _first.dispose(); _last.dispose(); _phone.dispose(); _email.dispose(); _notes.dispose();
    super.dispose();
  }

  Future<void> _pickCountry() async {
    final picked = await showModalBottomSheet<_Country>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final c in _kCountries)
              ListTile(
                leading: Text(c.flag, style: const TextStyle(fontSize: 22)),
                title: Text(c.name, style: ZineText.value(size: 14.5)),
                trailing: Text(c.dial, style: ZineText.sub(size: 13)),
                onTap: () => Navigator.pop(context, c),
              ),
          ],
        ),
      ),
    );
    if (picked != null && mounted) setState(() => _country = picked);
  }

  Future<void> _save() async {
    final first = _first.text.trim();
    final digits = _phone.text.replaceAll(RegExp(r'[^\d]'), '');
    if (first.isEmpty || digits.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('A first name and phone number are required')));
      return;
    }
    setState(() => _saving = true);
    final e164 = '${_country.dial}$digits';
    final ok = await DeviceContactsService.createDeviceContact(
      firstName: first, lastName: _last.text, phoneE164: e164,
      email: _email.text, notes: _notes.text,
    );
    if (!mounted) return;
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(ok ? 'Saved to your phone contacts' : 'Couldn’t save — check contacts permission')));
    if (ok) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Add as a new contact', style: ZineText.value(size: 15)),
      const SizedBox(height: 3),
      Text('Not on AvaTOK yet — save them to your phone.', style: ZineText.sub(size: 12)),
      const SizedBox(height: 12),
      Row(children: [
        Expanded(child: ZineField(controller: _first, hint: 'First name')),
        const SizedBox(width: 8),
        Expanded(child: ZineField(controller: _last, hint: 'Last name')),
      ]),
      const SizedBox(height: 8),
      Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
        GestureDetector(
          onTap: _pickCountry,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(Zine.rField),
              border: Border.all(color: Zine.ink, width: 2),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text(_country.flag, style: const TextStyle(fontSize: 18)),
              const SizedBox(width: 6),
              Text(_country.dial, style: ZineText.value(size: 14)),
              const SizedBox(width: 2),
              PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 12, color: Zine.ink),
            ]),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(child: ZineField(controller: _phone, hint: 'Phone number')),
      ]),
      const SizedBox(height: 8),
      ZineField(controller: _email, hint: 'Email (optional)'),
      const SizedBox(height: 8),
      ZineField(controller: _notes, hint: 'Notes (optional)'),
      const SizedBox(height: 14),
      ZineButton(
        label: _saving ? 'Saving…' : 'Save & sync',
        fullWidth: true,
        fontSize: 16,
        loading: _saving,
        icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
        trailingIcon: false,
        onPressed: _saving ? null : _save,
      ),
    ]);
  }
}
