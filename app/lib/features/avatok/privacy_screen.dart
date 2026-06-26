import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_number.dart';

/// Settings → Privacy & discoverability (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §10 #5).
///
/// Controls which network keys can find the user. The AvaTOK number is always
/// discoverable (that's its purpose); the real phone is private by default; email
/// is on by default. Handles are retired, so they never appear here.
class PrivacyScreen extends StatefulWidget {
  const PrivacyScreen({super.key});
  @override
  State<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends State<PrivacyScreen> {
  Discoverability? _p;
  MyNumber? _me;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await AvaNumber.getPrivacy();
    final me = await AvaNumber.me();
    if (!mounted) return;
    setState(() { _p = p; _me = me; });
  }

  Future<void> _save({bool? phone, bool? email, String? who}) async {
    final cur = _p!;
    setState(() {
      _p = Discoverability(
        phoneDiscoverable: phone ?? cur.phoneDiscoverable,
        emailDiscoverable: email ?? cur.emailDiscoverable,
        whoCanAdd: who ?? cur.whoCanAdd,
      );
      _saving = true;
    });
    await AvaNumber.setPrivacy(phoneDiscoverable: phone, emailDiscoverable: email, whoCanAdd: who);
    if (mounted) setState(() => _saving = false);
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Privacy & discoverability', markWord: 'Privacy'),
      body: p == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(20), children: [
              Text('HOW PEOPLE CAN FIND YOU', style: ZineText.kicker()),
              const SizedBox(height: 10),
              // AvaTOK number — always on, locked.
              ZineCard(
                child: Row(children: [
                  ZineIconBadge(icon: PhosphorIcons.hash(PhosphorIconsStyle.bold), color: Zine.blue, size: 28),
                  const SizedBox(width: 10),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(_me?.hasNumber == true ? 'Your AvaTOK number' : 'AvaTOK number', style: ZineText.value(size: 15)),
                    Text(_me?.hasNumber == true ? (_me!.display ?? '') : 'Always discoverable', style: ZineText.sub(size: 12)),
                  ])),
                  PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
                ]),
              ),
              const SizedBox(height: 10),
              _toggleRow(PhosphorIcons.phone(PhosphorIconsStyle.bold), 'Find me by my real phone number',
                  'Off keeps your real number private', p.phoneDiscoverable, (v) => _save(phone: v)),
              const SizedBox(height: 10),
              _toggleRow(PhosphorIcons.envelope(PhosphorIconsStyle.bold), 'Find me by my email',
                  'People who know your email can add you', p.emailDiscoverable, (v) => _save(email: v)),
              const SizedBox(height: 22),
              Text('WHO CAN ADD ME', style: ZineText.kicker()),
              const SizedBox(height: 10),
              _whoOption('everyone', 'Everyone', 'Anyone who searches your number, phone, or email'),
              _whoOption('number_only', 'Only with my AvaTOK number', 'People must know your exact number'),
              _whoOption('nobody', 'Nobody', 'You won’t appear in search or QR adds'),
              if (_saving) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))),
            ]),
    );
  }

  Widget _toggleRow(IconData icon, String title, String sub, bool value, ValueChanged<bool> onChanged) => ZineCard(
        child: Row(children: [
          ZineIconBadge(icon: icon, color: Zine.mint, size: 28),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14.5)),
            Text(sub, style: ZineText.sub(size: 12)),
          ])),
          ZineToggle(value: value, onChanged: _saving ? null : onChanged),
        ]),
      );

  Widget _whoOption(String key, String title, String sub) {
    final selected = _p!.whoCanAdd == key;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ZineCard(
        onTap: _saving ? null : () => _save(who: key),
        child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14.5)),
            Text(sub, style: ZineText.sub(size: 12)),
          ])),
          PhosphorIcon(
            selected ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill) : PhosphorIcons.circle(PhosphorIconsStyle.bold),
            size: 22, color: selected ? Zine.blue : Zine.inkMute,
          ),
        ]),
      ),
    );
  }
}
