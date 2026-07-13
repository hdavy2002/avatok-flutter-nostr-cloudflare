import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'package:qr_flutter/qr_flutter.dart';

import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../identity/identity.dart';
import '../profile/qr_share.dart';
import 'contacts.dart';
import 'dialpad_prefill.dart';

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
      backgroundColor: AD.bg,
      body: SafeArea(
        bottom: false,
        child: Column(children: [
          _header(context),
          Expanded(
            child: ListView(padding: const EdgeInsets.all(20), children: [
        Center(
          child: Container(
            decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: AD.borderAvatar, width: 2)),
            child: Avatar(seed: widget.uid, name: _displayName, size: 96),
          ),
        ),
        const SizedBox(height: 14),
        Center(child: Text(_displayName, style: ADText.appTitle())),
        const SizedBox(height: 20),
        if (_number.isNotEmpty)
          _box('AvaTOK number', PhosphorIcons.hash(PhosphorIconsStyle.bold), AD.iconSearch,
              child: Row(children: [
            Expanded(
              // [DIALPAD-BIZ-CALLS] Tapping the number drops it into the dialpad,
              // ready to dial (not auto-dialed) — connects the friend channel
              // (this profile, met by email) to the business channel (their
              // AvaTOK number). Flag-gated; plain SelectableText when off.
              child: RemoteConfig.businessCallUx
                  ? GestureDetector(
                      onTap: () => openDialpadWithNumber(context, _number),
                      child: Text(_number,
                          style: ADText.rowName(c: AD.iconSearch)
                              .copyWith(decoration: TextDecoration.underline)),
                    )
                  : SelectableText(_number, style: ADText.rowName()),
            ),
            IconButton(
                icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: AD.textPrimary),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _number));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                }),
          ]))
        else
          // No shared AvaTOK number — show a friendly note, never the raw user_… id.
          _box('AvaTOK number', PhosphorIcons.hash(PhosphorIconsStyle.bold), AD.iconSearch,
              child: Text('This contact hasn’t shared an AvaTOK number yet.',
                  style: ADText.preview(c: AD.textSecondary))),
        if (_email.isNotEmpty) ...[
          const SizedBox(height: 12),
          _box('Email', PhosphorIcons.envelope(PhosphorIconsStyle.bold), AD.iconVideo,
              child: Row(children: [
            Expanded(child: SelectableText(_email, style: ADText.rowName())),
            IconButton(
                icon: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), size: 18, color: AD.textPrimary),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _email));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                }),
          ])),
        ],
        if (_number.isNotEmpty) ...[
          const SizedBox(height: 16),
          _box('Add $_displayName on AvaTOK', PhosphorIcons.qrCode(PhosphorIconsStyle.bold), AD.online,
              child: Column(children: [
            // QR keeps a WHITE tile so the code stays scannable on the dark card.
            Center(child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                  color: AD.inputField,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: AD.borderControl, width: 1)),
              child: QrImageView(data: _addLink, size: 150, backgroundColor: AD.inputField),
            )),
            const SizedBox(height: 12),
            _primaryButton(
              label: 'Share contact',
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
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
        Text('SHARED GROUPS', style: ADText.sectionLabel()),
        const SizedBox(height: 6),
        if (_shared.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text('No groups in common', style: ADText.preview(c: AD.textSecondary)))
        else
          for (final g in _shared)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Container(
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
                child: Avatar(seed: 'group-${g.id}', name: g.name, size: 40),
              ),
              title: Text(g.name, style: ADText.rowName()),
              subtitle: Text('${g.members.length} members', style: ADText.preview(c: AD.textSecondary)),
            ),
            ]),
          ),
        ]),
      ),
    );
  }

  /// Inline dark v2 header (replaces the light ZineAppBar): header/footer fill,
  /// hairline bottom border, circular back button + kicker/title stack.
  Widget _header(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: Row(children: [
          GestureDetector(
            onTap: () => Navigator.of(context).maybePop(),
            child: Container(
              width: 38, height: 38,
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(AD.rIconButton)),
              child: const Icon(Icons.arrow_back_rounded, size: 22, color: AD.textPrimary),
            ),
          ),
          const SizedBox(width: 6),
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('CONTACT', style: ADText.sectionLabel()),
            const SizedBox(height: 1),
            Text('Contact info', style: ADText.appTitle()),
          ]),
        ]),
      );

  /// Inline dark v2 primary (full-width) button — replaces ZineButton.
  Widget _primaryButton({required String label, required IconData icon, required VoidCallback onPressed}) =>
      GestureDetector(
        onTap: onPressed,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 13),
          decoration: BoxDecoration(
            color: AD.primaryBadge,
            borderRadius: BorderRadius.circular(100),
          ),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(icon, size: 17, color: AD.textPrimary),
            const SizedBox(width: 10),
            Text(label, style: ADText.rowName()),
          ]),
        ),
      );

  Widget _box(String label, IconData icon, Color accent, {required Widget child}) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderCard, width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            // Inline AD icon badge (accent-tinted fill + colored glyph).
            Container(
              width: 28, height: 28,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(AD.rChip),
              ),
              child: Icon(icon, size: 15, color: accent),
            ),
            const SizedBox(width: 9),
            Expanded(child: Text(label.toUpperCase(), style: ADText.sectionLabel())),
          ]),
          const SizedBox(height: 10),
          child,
        ]),
      );
}
