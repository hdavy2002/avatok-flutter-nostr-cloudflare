import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/ui/avatok_dark.dart';
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
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: AD.borderControl, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
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
      uid: c.uid,
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
            decoration: BoxDecoration(color: AD.textFaint, borderRadius: BorderRadius.circular(100)))),
          Text('Add by QR link', style: ADText.appTitle()),
          const SizedBox(height: 4),
          Text('Paste an AvaTOK add link, or scan a code that opens it.', style: ADText.preview()),
          const SizedBox(height: 14),
          if (_card == null) ...[
            // White dark-v2 link field with a Paste action.
            Container(
              decoration: BoxDecoration(
                color: AD.inputField,
                borderRadius: BorderRadius.circular(AD.rInput),
                border: _error != null ? Border.all(color: AD.danger, width: 1.5) : null,
              ),
              padding: const EdgeInsets.only(left: 14, right: 4),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.link(PhosphorIconsStyle.bold),
                    size: 18, color: AD.placeholderOnWhite),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: _linkCtrl,
                    cursorColor: AD.primaryBadge,
                    style: ADText.rowName(c: AD.textOnInput),
                    onSubmitted: (_) => _resolve(),
                    decoration: InputDecoration(
                      isDense: true,
                      border: InputBorder.none,
                      hintText: 'avatok.ai/add?t=…',
                      hintStyle: ADText.rowName(c: AD.placeholderOnWhite),
                      contentPadding: const EdgeInsets.symmetric(vertical: 15),
                    ),
                  ),
                ),
                TextButton(
                  onPressed: () async {
                    final data = await Clipboard.getData('text/plain');
                    if (data?.text != null) { _linkCtrl.text = data!.text!; setState(() {}); }
                  },
                  child: Text('Paste', style: ADText.rowName(c: AD.iconClipOnWhite)),
                ),
              ]),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: ADText.preview(c: AD.danger))),
            const SizedBox(height: 14),
            _PrimaryButton(
              label: _resolving ? 'Looking up…' : 'Continue',
              loading: _resolving,
              onTap: _resolving ? null : _resolve,
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
      Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
              child: Avatar(seed: c.uid, name: name, size: 46, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
            ),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name.isNotEmpty ? name : 'AvaTOK member', style: ADText.threadName()),
              Text(c.sharesRealNumber ? 'Shared a private number' : 'AvaTOK member', style: ADText.preview()),
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
              decoration: BoxDecoration(color: AD.danger.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(10), border: Border.all(color: AD.borderControl, width: 1)),
              child: Text('No AvaTOK number yet — this contact shares a real phone number.', style: ADText.preview()),
            ),
          ],
        ]),
      ),
      const SizedBox(height: 14),
      Row(children: [
        Expanded(child: _GhostButton(label: 'Cancel', onTap: () => Navigator.pop(context))),
        const SizedBox(width: 10),
        Expanded(child: _PrimaryButton(
            label: 'Add contact',
            icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
            onTap: _add)),
      ]),
    ]);
  }

  Widget _row(IconData icon, String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(children: [
          PhosphorIcon(icon, size: 16, color: AD.textSecondary),
          const SizedBox(width: 8),
          Text(label, style: ADText.preview()),
          const Spacer(),
          Flexible(child: Text(value, style: ADText.rowName(), textAlign: TextAlign.right, overflow: TextOverflow.ellipsis)),
        ]),
      );
}

/// Primary dark-v2 pill button (orange fill, white bold label).
class _PrimaryButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool loading;
  final VoidCallback? onTap;
  const _PrimaryButton({required this.label, this.icon, this.loading = false, this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? 0.5 : 1,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 15),
          decoration: BoxDecoration(
            color: AD.primaryBadge,
            borderRadius: BorderRadius.circular(100),
          ),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            if (loading)
              const SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
            else if (icon != null) ...[
              PhosphorIcon(icon, size: 18, color: Colors.white),
              const SizedBox(width: 8),
            ],
            Text(label, style: ADText.rowName(c: Colors.white)),
          ]),
        ),
      ),
    );
  }
}

/// Ghost dark-v2 pill button (card fill, hairline border, primary text).
class _GhostButton extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;
  const _GhostButton({required this.label, this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 15),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Text(label, style: ADText.rowName()),
      ),
    );
  }
}
