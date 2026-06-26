import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_number.dart';
import 'contacts.dart';

/// Add a contact from a scanned/clicked QR share link (Specs/AVATOK-NUMBER §10A).
///
/// The QR encodes `https://avatok.ai/add?t=<token>` (or `avatok://add?t=`). This
/// resolves the token to the sharer's contact card and shows a confirmation. A
/// paid sharer's card shows their AvaTOK number; a free sharer's shows their real
/// number. On confirm we return a Contact the caller saves + can message.
///
/// [token] is optional — when a deep-link supplies it we skip the paste step. The
/// app's link dispatcher can call this directly: `addContactFromShareToken(ctx, t)`.
Future<Contact?> showAddByLinkSheet(BuildContext context, {String? token}) {
  return showModalBottomSheet<Contact>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: Zine.ink, width: Zine.bw),
        borderRadius: BorderRadius.vertical(top: Radius.circular(26))),
    builder: (_) => _AddByLinkSheet(initialToken: token),
  );
}

/// Convenience for a deep-link handler: resolve + confirm in one call.
Future<Contact?> addContactFromShareToken(BuildContext context, String token) {
  return showAddByLinkSheet(context, token: token);
}

class _AddByLinkSheet extends StatefulWidget {
  final String? initialToken;
  const _AddByLinkSheet({this.initialToken});
  @override
  State<_AddByLinkSheet> createState() => _AddByLinkSheetState();
}

class _AddByLinkSheetState extends State<_AddByLinkSheet> {
  final _linkCtrl = TextEditingController();
  bool _resolving = false;
  AddCard? _card;
  String? _error;

  @override
  void initState() {
    super.initState();
    final t = (widget.initialToken ?? '').trim();
    if (t.isNotEmpty) {
      _linkCtrl.text = t;
      WidgetsBinding.instance.addPostFrameCallback((_) => _resolve());
    }
  }

  @override
  void dispose() {
    _linkCtrl.dispose();
    super.dispose();
  }

  Future<void> _resolve() async {
    final token = AvaNumber.tokenFromLink(_linkCtrl.text);
    if (token.isEmpty) {
      setState(() => _error = 'Paste a valid AvaTOK add link or code.');
      return;
    }
    setState(() { _resolving = true; _error = null; _card = null; });
    final card = await AvaNumber.addResolve(token);
    if (!mounted) return;
    setState(() {
      _resolving = false;
      _card = card;
      _error = card == null ? 'This code is no longer valid.' : null;
    });
  }

  void _add() {
    final c = _card;
    if (c == null) return;
    final name = c.name.isNotEmpty ? c.name : [c.firstName, c.lastName].where((s) => s.isNotEmpty).join(' ').trim();
    final contact = Contact(
      npub: c.uid,
      name: name.isNotEmpty ? name : (c.email.isNotEmpty ? c.email : c.number),
      email: c.email,
      avatarUrl: c.avatarUrl,
      // Paid sharer → AvaTOK number; free sharer → their real phone.
      number: c.sharesRealNumber ? '' : c.number,
      phone: c.sharesRealNumber ? c.number : '',
    );
    Analytics.capture('contact_added_via_qr', {'plan': c.plan});
    Navigator.pop(context, contact);
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final bottom = mq.viewInsets.bottom + mq.padding.bottom + 16;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 12),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Center(child: Container(
            width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16),
            decoration: BoxDecoration(color: Zine.inkMute, borderRadius: BorderRadius.circular(100)))),
          Text('Add by QR link', style: ZineText.cardTitle(size: 22)),
          const SizedBox(height: 4),
          Text('Paste an AvaTOK add link, or scan a code that opens it.', style: ZineText.sub(size: 12.5)),
          const SizedBox(height: 14),
          if (_card == null) ...[
            ZineField(
              controller: _linkCtrl,
              hint: 'avatok.ai/add?t=…',
              leadIcon: PhosphorIcons.link(PhosphorIconsStyle.bold),
              error: _error != null,
              onSubmitted: (_) => _resolve(),
              trailing: TextButton(
                onPressed: () async {
                  final data = await Clipboard.getData('text/plain');
                  if (data?.text != null) { _linkCtrl.text = data!.text!; setState(() {}); }
                },
                child: Text('Paste', style: ZineText.button(size: 13, color: Zine.blue)),
              ),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: ZineText.sub(size: 12, color: Zine.coral))),
            const SizedBox(height: 14),
            ZineButton(
              label: _resolving ? 'Looking up…' : 'Continue',
              fullWidth: true, fontSize: 16, loading: _resolving,
              onPressed: _resolving ? null : _resolve,
            ),
          ] else
            _confirmCard(_card!),
        ]),
      ),
    );
  }

  Widget _confirmCard(AddCard c) {
    final name = c.name.isNotEmpty ? c.name : [c.firstName, c.lastName].where((s) => s.isNotEmpty).join(' ').trim();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
              child: Avatar(seed: c.uid, name: name, size: 46, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
            ),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name.isNotEmpty ? name : 'AvaTOK member', style: ZineText.cardTitle(size: 17)),
              Text(c.sharesRealNumber ? 'Shared a private number' : 'AvaTOK member', style: ZineText.sub(size: 12)),
            ])),
          ]),
          const SizedBox(height: 14),
          _row(c.sharesRealNumber ? PhosphorIcons.phone(PhosphorIconsStyle.bold) : PhosphorIcons.hash(PhosphorIconsStyle.bold),
              'Number', c.number.isEmpty ? '—' : c.number),
          if (c.email.isNotEmpty) _row(PhosphorIcons.envelope(PhosphorIconsStyle.bold), 'Email', c.email),
          if (c.sharesRealNumber) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
              decoration: BoxDecoration(color: Zine.coral.withOpacity(0.16), borderRadius: BorderRadius.circular(10), border: Border.all(color: Zine.ink, width: 1.5)),
              child: Text('No AvaTOK number yet — this contact shares a real phone number.', style: ZineText.sub(size: 11.5)),
            ),
          ],
        ]),
      ),
      const SizedBox(height: 14),
      Row(children: [
        Expanded(child: ZineButton(label: 'Cancel', variant: ZineButtonVariant.ghost, fullWidth: true, fontSize: 15,
            onPressed: () => Navigator.pop(context))),
        const SizedBox(width: 10),
        Expanded(child: ZineButton(label: 'Add contact', fullWidth: true, fontSize: 15,
            icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold), trailingIcon: false, onPressed: _add)),
      ]),
    ]);
  }

  Widget _row(IconData icon, String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(children: [
          PhosphorIcon(icon, size: 16, color: Zine.inkSoft),
          const SizedBox(width: 8),
          Text(label, style: ZineText.sub(size: 13)),
          const Spacer(),
          Flexible(child: Text(value, style: ZineText.value(size: 13.5), textAlign: TextAlign.right, overflow: TextOverflow.ellipsis)),
        ]),
      );
}
