import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:pointycastle/digests/sha256.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';

/// Contact details: @handle, npub, shared groups, and a safety number + QR for
/// out-of-band identity verification (compare the same number on both phones).
class ContactProfileScreen extends StatefulWidget {
  final String name;
  final String npub; // contact npub (bech32)
  final String? handle;
  final Identity? me;
  const ContactProfileScreen({super.key, required this.name, required this.npub, this.handle, this.me});
  @override
  State<ContactProfileScreen> createState() => _ContactProfileScreenState();
}

class _ContactProfileScreenState extends State<ContactProfileScreen> {
  List<Group> _shared = [];

  @override
  void initState() {
    super.initState();
    final peerHex = NostrKeys.npubToHex(widget.npub);
    if (peerHex != null) {
      GroupStore().load().then((groups) {
        if (mounted) setState(() => _shared = groups.where((g) => g.members.contains(peerHex)).toList());
      });
    }
  }

  String get _safetyNumber {
    final peerHex = NostrKeys.npubToHex(widget.npub);
    final myHex = widget.me?.pubHex;
    if (peerHex == null || myHex == null) return '—';
    final s = ([myHex, peerHex]..sort()).join();
    final d = SHA256Digest().process(Uint8List.fromList(utf8.encode(s)));
    final groups = <String>[];
    for (var i = 0; i < 12; i += 2) {
      groups.add(((d[i] << 8) | d[i + 1]).toString().padLeft(5, '0'));
    }
    return groups.join(' ');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Contact info', markWord: 'Contact'),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Center(
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Zine.border,
              boxShadow: Zine.shadowSm,
            ),
            child: Avatar(seed: widget.npub, name: widget.name, size: 96),
          ),
        ),
        const SizedBox(height: 14),
        Center(child: Text(widget.name, style: ZineText.cardTitle(size: 23))),
        if ((widget.handle ?? '').isNotEmpty) ...[
          const SizedBox(height: 4),
          Center(child: Text('@${widget.handle}', style: ZineText.link(size: 13))),
        ],
        const SizedBox(height: 20),
        _box('AvaTOK ID (npub)', PhosphorIcons.fingerprint(PhosphorIconsStyle.bold), Zine.blue,
            child: Row(children: [
          Expanded(child: SelectableText(widget.npub, style: ZineText.tag(size: 11, color: Zine.inkSoft))),
          IconButton(
              icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
              onPressed: () {
            Clipboard.setData(ClipboardData(text: widget.npub));
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
          }),
        ])),
        const SizedBox(height: 16),
        _box('Safety number — match on both phones', PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), Zine.lime,
            child: Column(children: [
          Center(
            child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(14),
                border: Zine.border,
              ),
              child: QrImageView(data: widget.npub, size: 150, backgroundColor: Zine.card),
            ),
          ),
          const SizedBox(height: 10),
          SelectableText(_safetyNumber,
              textAlign: TextAlign.center,
              style: ZineText.tag(size: 13)),
        ])),
        const SizedBox(height: 18),
        Text('SHARED GROUPS', style: ZineText.kicker()),
        const SizedBox(height: 6),
        if (_shared.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text('No groups in common', style: ZineText.sub()))
        else
          for (final g in _shared)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: Zine.ink, width: 2),
                ),
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
