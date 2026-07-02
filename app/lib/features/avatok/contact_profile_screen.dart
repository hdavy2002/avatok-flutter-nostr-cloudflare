import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'package:qr_flutter/qr_flutter.dart';

import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../profile/qr_share.dart';
import 'contacts.dart';

/// Contact details: name, AvaTOK number, and shared groups.
///
/// Handles are retired and the old Nostr "safety number" (out-of-band E2E
/// verification) is removed — messaging is server-readable under the
/// Cloudflare-native architecture, so that fingerprint no longer has meaning.
/// The network identity shown is the contact's AvaTOK number.
class ContactProfileScreen extends StatefulWidget {
  final String name;
  final String uid; // contact routing id (Clerk uid)
  final String? handle; // DEPRECATED; ignored
  final Identity? me;
  const ContactProfileScreen({super.key, required this.name, required this.uid, this.handle, this.me});
  @override
  State<ContactProfileScreen> createState() => _ContactProfileScreenState();
}

class _ContactProfileScreenState extends State<ContactProfileScreen> {
  List<Group> _shared = [];
  String _number = '';
  String _email = '';
  late String _name = widget.name;

  /// A name that is really just the raw routing id (e.g. "user_3FcSU…tojL") is
  /// no name at all — show a friendly label resolved from the saved contact or
  /// the directory instead of a wall of base-62. Empty / equal-to-id also count.
  static bool _looksLikeRawId(String name, String uid) {
    final n = name.trim();
    if (n.isEmpty) return true;
    if (n == uid) return true;
    if (n.startsWith('user_')) return true;
    // Shortened form the UI renders, e.g. "user_3FcSU…tojL".
    if (n.contains('…') && n.startsWith('user')) return true;
    return false;
  }

  @override
  void initState() {
    super.initState();
    final peerHex = widget.uid;
    if (peerHex.isNotEmpty) {
      GroupStore().load().then((groups) {
        if (mounted) setState(() => _shared = groups.where((g) => g.members.contains(peerHex)).toList());
      });
    }
    // If we were handed a raw id instead of a real name, recover one. Prefer the
    // user's OWN saved contact name (e.g. "JDee"), then the directory profile.
    if (_looksLikeRawId(widget.name, widget.uid)) {
      _recoverName();
    }
    // Resolve the contact's AvaTOK number for display (best-effort).
    // Seed number + email from the saved contact immediately (directory resolve
    // refines them). The saved contact usually already has the AvaTOK number, so
    // we show it right away instead of a raw "user_…" id.
    ContactsStore().load().then((cs) {
      final m = cs.where((c) => c.uid == widget.uid).toList();
      if (mounted && m.isNotEmpty) {
        setState(() {
          if (m.first.number.isNotEmpty) _number = m.first.number;
          if (m.first.email.isNotEmpty) _email = m.first.email;
        });
      }
    });
    Directory.resolve(widget.uid).then((c) {
      if (!mounted || c == null) return;
      setState(() {
        if (c.number.isNotEmpty) _number = c.number;
        if (c.email.isNotEmpty) _email = c.email;
        // Directory name is a fallback when no saved contact matched.
        if (_looksLikeRawId(_name, widget.uid) &&
            c.name.isNotEmpty && !_looksLikeRawId(c.name, widget.uid)) {
          _name = c.name;
        }
      });
    });
  }

  Future<void> _recoverName() async {
    try {
      final contacts = await ContactsStore().load();
      final match = contacts.where((c) => c.uid == widget.uid).toList();
      if (match.isNotEmpty && !_looksLikeRawId(match.first.name, widget.uid)) {
        if (mounted) setState(() => _name = match.first.name);
      }
    } catch (_) {/* best-effort — directory resolve still runs as a fallback */}
  }

  /// The big title: a real name when we have one, otherwise the AvaTOK number,
  /// and only as a last resort a neutral "AvaTOK user" — never a raw user_… id.
  String get _displayName {
    if (!_looksLikeRawId(_name, widget.uid)) return _name;
    if (_number.isNotEmpty) return _number;
    return 'AvaTOK user';
  }

  /// Deep link others can scan/click to add THIS contact by their AvaTOK number.
  /// Forward-compatible `?n=` form (the web landing + server add-by-number resolve
  /// it; non-installers are sent to the Play Store).
  String get _addLink {
    final digits = _number.replaceAll(RegExp(r'[^0-9+]'), '');
    return 'https://avatok.ai/add?n=${Uri.encodeQueryComponent(digits)}';
  }


  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Contact info', markWord: 'Contact'),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Center(
          child: Container(
            decoration: BoxDecoration(shape: BoxShape.circle, border: Zine.border, boxShadow: Zine.shadowSm),
            child: Avatar(seed: widget.uid, name: _displayName, size: 96),
          ),
        ),
        const SizedBox(height: 14),
        Center(child: Text(_displayName, style: ZineText.cardTitle(size: 23))),
        const SizedBox(height: 20),
        if (_number.isNotEmpty)
          _box('AvaTOK number', PhosphorIcons.hash(PhosphorIconsStyle.bold), Zine.blue,
              child: Row(children: [
            Expanded(child: SelectableText(_number, style: ZineText.value(size: 15))),
            IconButton(
                icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _number));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                }),
          ]))
        else
          // No shared AvaTOK number — show a friendly note, never the raw user_… id.
          _box('AvaTOK number', PhosphorIcons.hash(PhosphorIconsStyle.bold), Zine.blue,
              child: Text('This contact hasn’t shared an AvaTOK number yet.',
                  style: ZineText.sub(size: 13))),
        if (_email.isNotEmpty) ...[
          const SizedBox(height: 12),
          _box('Email', PhosphorIcons.envelope(PhosphorIconsStyle.bold), Zine.lilac,
              child: Row(children: [
            Expanded(child: SelectableText(_email, style: ZineText.value(size: 15))),
            IconButton(
                icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _email));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                }),
          ])),
        ],
        if (_number.isNotEmpty) ...[
          const SizedBox(height: 16),
          _box('Add $_displayName on AvaTOK', PhosphorIcons.qrCode(PhosphorIconsStyle.bold), Zine.mint,
              child: Column(children: [
            Center(child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: Zine.card, borderRadius: BorderRadius.circular(14), border: Zine.border),
              child: QrImageView(data: _addLink, size: 150, backgroundColor: Zine.card),
            )),
            const SizedBox(height: 12),
            ZineButton(
              label: 'Share contact', icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), trailingIcon: false,
              fullWidth: true, fontSize: 15,
              onPressed: () async {
                try {
                  await QrShare.share(link: _addLink, name: _displayName, number: _number);
                } catch (_) {
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text("Couldn't prepare the QR image — try again.")));
                }
              }),
          ])),
        ],
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
