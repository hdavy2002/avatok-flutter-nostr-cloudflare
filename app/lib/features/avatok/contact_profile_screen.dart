import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import 'contacts.dart';

/// Contact details: name, AvaTOK number, and shared groups.
///
/// Handles are retired and the old Nostr "safety number" (out-of-band E2E
/// verification) is removed — messaging is server-readable under the
/// Cloudflare-native architecture, so that fingerprint no longer has meaning.
/// The network identity shown is the contact's AvaTOK number.
class ContactProfileScreen extends StatefulWidget {
  final String name;
  final String npub; // contact routing id (Clerk uid)
  final String? handle; // DEPRECATED; ignored
  final Identity? me;
  const ContactProfileScreen({super.key, required this.name, required this.npub, this.handle, this.me});
  @override
  State<ContactProfileScreen> createState() => _ContactProfileScreenState();
}

class _ContactProfileScreenState extends State<ContactProfileScreen> {
  List<Group> _shared = [];
  String _number = '';

  @override
  void initState() {
    super.initState();
    final peerHex = NostrKeys.npubToHex(widget.npub);
    if (peerHex != null) {
      GroupStore().load().then((groups) {
        if (mounted) setState(() => _shared = groups.where((g) => g.members.contains(peerHex)).toList());
      });
    }
    // Resolve the contact's AvaTOK number for display (best-effort).
    Directory.resolve(widget.npub).then((c) {
      if (mounted && c != null && c.number.isNotEmpty) setState(() => _number = c.number);
    });
  }

  String get _identityLabel => _number.isNotEmpty ? _number : _short(widget.npub);
  static String _short(String id) => id.length > 16 ? '${id.substring(0, 10)}…${id.substring(id.length - 4)}' : id;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Contact info', markWord: 'Contact'),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Center(
          child: Container(
            decoration: BoxDecoration(shape: BoxShape.circle, border: Zine.border, boxShadow: Zine.shadowSm),
            child: Avatar(seed: widget.npub, name: widget.name, size: 96),
          ),
        ),
        const SizedBox(height: 14),
        Center(child: Text(widget.name, style: ZineText.cardTitle(size: 23))),
        const SizedBox(height: 20),
        _box(_number.isNotEmpty ? 'AvaTOK number' : 'Contact ID', PhosphorIcons.hash(PhosphorIconsStyle.bold), Zine.blue,
            child: Row(children: [
          Expanded(child: SelectableText(_identityLabel, style: ZineText.value(size: 15))),
          IconButton(
              icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
              onPressed: () {
                Clipboard.setData(ClipboardData(text: _identityLabel));
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
              }),
        ])),
        const SizedBox(height: 18),
        Text('SHARED GROUPS', style: ZineText.kicker()),
        const SizedBox(height: 6),
        if (_shared.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text('No groups in common', style: ZineText.sub()))
        else
          for (final g in _shared)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Container(
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
                child: Avatar(seed: 'group-${g.id}', name: g.name, size: 40),
              ),
              title: Text(g.name, style: ZineText.value(size: 15)),
              subtitle: Text('${g.members.length} members', style: ZineText.sub(size: 12)),
            ),
      ]),
    );
  }

  Widget _box(String label, IconData icon, Color accent, {required Widget child}) => ZineCard(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: icon, color: accent, size: 28),
            const SizedBox(width: 9),
            Expanded(child: Text(label.toUpperCase(), style: ZineText.kicker())),
          ]),
          const SizedBox(height: 10),
          child,
        ]),
      );
}
