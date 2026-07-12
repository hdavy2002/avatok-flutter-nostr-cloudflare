import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../avadial_channel.dart';
import '../device_contacts.dart';
import 'sms_thread_screen.dart';

/// New SMS message → recipient chooser (AVA-SMS / AVA-SMS-4). Replaces the old
/// bare "type a number" sheet: a searchable LIVE device-contact picker PLUS manual
/// number entry, so a user can text a saved contact — not only reply in an existing
/// thread. Picking a recipient opens [SmsThreadScreen] ready to send via smsSend.
///
/// Device-data boundary (plan §4.7): contacts are read LIVE via [DeviceContacts]
/// (in-memory, per-account) and never persisted. When the contacts permission is
/// denied the picker degrades to a clear "allow contacts" state while STILL
/// allowing a message to be sent to a manually-typed number.
class SmsComposeScreen extends StatefulWidget {
  const SmsComposeScreen({super.key});

  @override
  State<SmsComposeScreen> createState() => _SmsComposeScreenState();
}

class _SmsComposeScreenState extends State<SmsComposeScreen> {
  final _search = TextEditingController();
  List<DeviceContact> _contacts = const [];
  bool _loading = true;
  bool _permissionDenied = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _permissionDenied = false;
    });
    final granted = await DeviceContacts.I.ensurePermission();
    if (!granted) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _permissionDenied = true;
        _contacts = const [];
      });
      return;
    }
    final list = await DeviceContacts.I.load();
    if (!mounted) return;
    setState(() {
      _contacts = list;
      _loading = false;
    });
  }

  /// The typed query with everything but digits (and a leading +) stripped — used
  /// to detect "this looks like a number I can text directly".
  String get _dialQuery {
    final raw = _search.text.trim();
    final cleaned = raw.replaceAll(RegExp(r'[^0-9+]'), '');
    return cleaned;
  }

  bool get _looksLikeNumber => _dialQuery.replaceAll('+', '').length >= 3;

  List<DeviceContact> get _filtered {
    final q = _search.text.trim().toLowerCase();
    if (q.isEmpty) return _contacts;
    final qDigits = _dialQuery.replaceAll('+', '');
    return _contacts.where((c) {
      final nameHit = (c.name ?? '').toLowerCase().contains(q);
      final numHit = qDigits.isNotEmpty &&
          c.number.replaceAll(RegExp(r'[^0-9]'), '').contains(qDigits);
      return nameHit || numHit;
    }).toList();
  }

  void _openThread(String address) {
    final n = address.trim();
    if (n.isEmpty) return;
    Analytics.capture('avadial_sms_compose_pick', {
      // Hashed (never the raw number) — same scheme as the rest of AvaDial.
      'number_hash': AvaDialChannel.hashE164(n),
      'from_contact': DeviceContacts.I.lookup(n) != null,
    });
    Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
      builder: (_) => SmsThreadScreen(address: n),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      resizeToAvoidBottomInset: true,
      appBar: const ZineAppBar(title: 'New message', markWord: 'message', showBack: true),
      body: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
            child: ZineField(
              controller: _search,
              hint: 'Search name or type a number',
              leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
              keyboardType: TextInputType.text,
              autofocus: true,
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) {
                if (_looksLikeNumber) _openThread(_search.text.trim());
              },
            ),
          ),
          Expanded(child: _body()),
        ]),
      ),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Zine.ink));
    }
    final filtered = _filtered;
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 24),
      children: [
        // Manual-number row (always available, even with contacts denied).
        if (_looksLikeNumber) _manualNumberRow(),
        if (_permissionDenied) _permissionCard(),
        if (!_permissionDenied && filtered.isEmpty && !_looksLikeNumber)
          _emptyContacts(),
        for (final c in filtered) _contactRow(c),
      ],
    );
  }

  Widget _manualNumberRow() {
    final number = _search.text.trim();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ZineCard(
        onTap: () => _openThread(number),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        child: Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.bold),
              color: Zine.lime),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Send to this number', style: ZineText.sub(size: 11.5)),
              const SizedBox(height: 2),
              Text(number,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ZineText.cardTitle(size: 15.5)),
            ]),
          ),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
              size: 16, color: Zine.inkMute),
        ]),
      ),
    );
  }

  Widget _contactRow(DeviceContact c) {
    final trimmedName = c.name?.trim() ?? '';
    final initial =
        trimmedName.isNotEmpty ? trimmedName.substring(0, 1).toUpperCase() : '#';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ZineCard(
        onTap: () => _openThread(c.number),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        child: Row(children: [
          Container(
            width: 38,
            height: 38,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Zine.blue,
              shape: BoxShape.circle,
              border: Zine.border,
            ),
            child: Text(initial, style: ZineText.cardTitle(size: 16)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(c.name ?? c.number,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ZineText.cardTitle(size: 15.5)),
              if (c.name != null) ...[
                const SizedBox(height: 2),
                Text(c.number,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 12.5)),
              ],
            ]),
          ),
          PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
              size: 18, color: Zine.inkSoft),
        ]),
      ),
    );
  }

  Widget _permissionCard() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 8),
      child: Column(children: [
        ZineIconBadge(
            icon: PhosphorIcons.addressBook(PhosphorIconsStyle.bold),
            color: Zine.blue,
            size: 52),
        const SizedBox(height: 14),
        Text('Contacts are off', textAlign: TextAlign.center, style: ZineText.cardTitle(size: 17)),
        const SizedBox(height: 8),
        Text(
          'Allow contacts so you can pick someone by name. You can still text any '
          'number by typing it above.',
          textAlign: TextAlign.center,
          style: ZineText.sub(size: 13.5),
        ),
        const SizedBox(height: 16),
        ZineButton(
          label: 'Allow contacts',
          variant: ZineButtonVariant.blue,
          fontSize: 15,
          onPressed: () async {
            await openAppSettings();
          },
          icon: PhosphorIcons.gearSix(PhosphorIconsStyle.bold),
          trailingIcon: false,
        ),
        const SizedBox(height: 10),
        TextButton(
          onPressed: _load,
          child: Text('Try again', style: ZineText.link(size: 14)),
        ),
      ]),
    );
  }

  Widget _emptyContacts() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 8),
      child: Column(children: [
        ZineIconBadge(
            icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
            color: Zine.blue,
            size: 52),
        const SizedBox(height: 14),
        Text(
          _search.text.trim().isEmpty ? 'No contacts found' : 'No matches',
          textAlign: TextAlign.center,
          style: ZineText.cardTitle(size: 17),
        ),
        const SizedBox(height: 8),
        Text('Type a phone number above to start a new text.',
            textAlign: TextAlign.center, style: ZineText.sub(size: 13.5)),
      ]),
    );
  }
}
