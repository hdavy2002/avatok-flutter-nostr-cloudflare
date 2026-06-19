import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_contacts/flutter_contacts.dart' as fc;
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'contacts.dart';

/// Bottom sheet to add a contact — WhatsApp-style.
/// Primary: "Search phone number" reads your DEVICE contacts; type a name and the
/// matching name + number pops up to add. Secondary: "Search by handle" uses the
/// public directory. Email lookup is retired (Specs/PROPOSAL-AI-RECEPTIONIST.md).
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

class _DevPhone {
  final String name;
  final String phone;
  const _DevPhone(this.name, this.phone);
}

class _AddContactSheet extends StatefulWidget {
  const _AddContactSheet();
  @override
  State<_AddContactSheet> createState() => _AddContactSheetState();
}

class _AddContactSheetState extends State<_AddContactSheet> {
  bool _byPhone = true; // false = search by handle (directory)
  final _phoneCtrl = TextEditingController();
  final _searchCtrl = TextEditingController();
  bool _busy = false;
  String? _error;

  // device-contacts state
  List<_DevPhone> _device = [];
  bool _deviceLoaded = false;
  bool _permDenied = false;
  String _phoneQuery = '';

  // handle-search state
  List<Contact> _results = [];
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _loadDevice();
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _searchCtrl.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  // --- device contacts -------------------------------------------------------
  Future<void> _loadDevice() async {
    try {
      final ok = await fc.FlutterContacts.requestPermission(readonly: true);
      if (!ok) {
        if (mounted) setState(() { _permDenied = true; _deviceLoaded = true; });
        return;
      }
      final list = await fc.FlutterContacts.getContacts(withProperties: true);
      final out = <_DevPhone>[];
      for (final c in list) {
        for (final p in c.phones) {
          final num = p.number.trim();
          if (num.isEmpty) continue;
          out.add(_DevPhone(c.displayName, num));
        }
      }
      out.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      if (mounted) setState(() { _device = out; _deviceLoaded = true; });
    } catch (_) {
      if (mounted) setState(() { _permDenied = true; _deviceLoaded = true; });
    }
  }

  static String _normPhone(String raw) {
    var t = raw.replaceAll(RegExp(r'[^\d+]'), '');
    if (t.isEmpty) return t;
    if (!t.startsWith('+')) t = '+$t';
    return t;
  }

  List<_DevPhone> get _filtered {
    final q = _phoneQuery.trim().toLowerCase();
    if (q.isEmpty) return _device.take(30).toList();
    final qDigits = q.replaceAll(RegExp(r'[^\d]'), '');
    return _device.where((d) {
      if (d.name.toLowerCase().contains(q)) return true;
      if (qDigits.isNotEmpty && d.phone.replaceAll(RegExp(r'[^\d]'), '').contains(qDigits)) return true;
      return false;
    }).take(40).toList();
  }

  Future<void> _addPhone(_DevPhone d) async {
    setState(() { _busy = true; _error = null; });
    final phone = _normPhone(d.phone);
    final c = await Directory.resolve(phone);
    if (!mounted) return;
    setState(() => _busy = false);
    if (c != null && c.npub.isNotEmpty) {
      Navigator.pop(context, Contact(
        npub: c.npub,
        name: c.name.isNotEmpty ? c.name : d.name,
        handle: c.handle, email: c.email, avatarUrl: c.avatarUrl, phone: phone,
      ));
    } else {
      // Not on AvaTOK yet → offer an invite (WhatsApp-style "invite to app").
      _inviteSnack(d.name);
    }
  }

  void _inviteSnack(String name) {
    Clipboard.setData(const ClipboardData(text: kInviteBase));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('$name isn’t on AvaTOK yet — invite link copied')));
  }

  // --- handle search ---------------------------------------------------------
  void _onSearchChanged(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      final r = await Directory.search(v);
      if (mounted) setState(() => _results = r);
    });
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
            Text('Add contact', style: ZineText.cardTitle(size: 22)),
            const SizedBox(height: 14),
            _tabs(),
            const SizedBox(height: 14),
            if (_byPhone) _phoneBody() else _searchBody(),
          ],
        ),
      ),
    );
  }

  Widget _tabs() => Row(children: [
        Expanded(child: ZineChip(
            label: 'Search phone number',
            active: _byPhone,
            onTap: () => setState(() => _byPhone = true))),
        const SizedBox(width: 9),
        Expanded(child: ZineChip(
            label: 'Search by handle',
            active: !_byPhone,
            onTap: () => setState(() => _byPhone = false))),
      ]);

  Widget _phoneBody() {
    if (_permDenied) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Contacts access is off',
              style: ZineText.value(size: 14.5)),
          const SizedBox(height: 6),
          Text(
            'Allow AvaTOK to read your contacts to add people by phone number, '
            'or use “Search by handle”.',
            style: ZineText.sub(size: 12.5),
          ),
          const SizedBox(height: 12),
          ZineButton(label: 'Try again', onPressed: () { setState(() => _permDenied = false); _loadDevice(); }),
        ]),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZineField(
        controller: _phoneCtrl,
        hint: 'Search phone number',
        leadIcon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
        onChanged: (v) => setState(() => _phoneQuery = v),
      ),
      const SizedBox(height: 10),
      ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 320),
        child: !_deviceLoaded
            ? const Padding(
                padding: EdgeInsets.symmetric(vertical: 28),
                child: Center(child: SizedBox(
                    width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))))
            : _buildPhoneList(),
      ),
    ]);
  }

  Widget _buildPhoneList() {
    final items = _filtered;
    if (items.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Center(child: Text(
            _phoneQuery.trim().isEmpty ? 'Type a name from your contacts' : 'No matches',
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
            child: Avatar(seed: d.phone, name: d.name, size: 40),
          ),
          title: Text(d.name.isEmpty ? d.phone : d.name, style: ZineText.value(size: 14.5)),
          subtitle: Text(d.phone, style: ZineText.sub(size: 12.5)),
          trailing: _busy
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.fill), color: Zine.blueInk),
          onTap: _busy ? null : () => _addPhone(d),
        );
      },
    );
  }

  Widget _searchBody() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ZineField(
            controller: _searchCtrl,
            hint: 'e.g. @handle_name',
            leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            onChanged: _onSearchChanged,
          ),
          const SizedBox(height: 10),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 280),
            child: _results.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Center(
                      child: Text(
                          _searchCtrl.text.trim().length < 2
                              ? 'e.g. @handle_name'
                              : 'No matches yet',
                          style: ZineText.sub(size: 13)),
                    ),
                  )
                : ListView.builder(
                    shrinkWrap: true,
                    itemCount: _results.length,
                    itemBuilder: (_, i) {
                      final c = _results[i];
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: Zine.ink, width: 2),
                          ),
                          child: Avatar(seed: c.seed, name: c.name, size: 40,
                              avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
                        ),
                        title: Text(c.name, style: ZineText.value(size: 14.5)),
                        subtitle: c.subtitle.isNotEmpty
                            ? Text(c.subtitle, style: ZineText.sub(size: 12.5))
                            : null,
                        trailing: PhosphorIcon(
                            PhosphorIcons.plusCircle(PhosphorIconsStyle.fill),
                            color: Zine.blueInk),
                        onTap: () => Navigator.pop(context, c),
                      );
                    },
                  ),
          ),
        ],
      );
}
