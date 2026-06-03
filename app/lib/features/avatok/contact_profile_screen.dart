import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pointycastle/export.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/theme.dart';
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
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink, title: const Text('Contact info')),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Center(child: Avatar(seed: widget.npub, name: widget.name, size: 96)),
        const SizedBox(height: 14),
        Center(child: Text(widget.name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800))),
        if ((widget.handle ?? '').isNotEmpty)
          Center(child: Text('@${widget.handle}', style: const TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w600))),
        const SizedBox(height: 20),
        _box('AvaTOK ID (npub)', child: Row(children: [
          Expanded(child: SelectableText(widget.npub, style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5))),
          IconButton(icon: const Icon(Icons.copy, size: 18), onPressed: () {
            Clipboard.setData(ClipboardData(text: widget.npub));
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
          }),
        ])),
        const SizedBox(height: 16),
        _box('Safety number — verify this matches on both phones', child: Column(children: [
          Center(child: QrImageView(data: widget.npub, size: 150, backgroundColor: Colors.white)),
          const SizedBox(height: 10),
          SelectableText(_safetyNumber,
              textAlign: TextAlign.center,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 14, letterSpacing: 1)),
        ])),
        const SizedBox(height: 16),
        const Text('SHARED GROUPS', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        if (_shared.isEmpty)
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('No groups in common', style: TextStyle(color: AvaColors.sub)))
        else
          for (final g in _shared)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Avatar(seed: 'group-${g.id}', name: g.name, size: 40),
              title: Text(g.name, style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text('${g.members.length} members', style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
            ),
      ]),
    );
  }

  Widget _box(String label, {required Widget child}) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.brand)),
          const SizedBox(height: 6),
          child,
        ]),
      );
}
